import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, Message, ReceiveMessageCommand, SendMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '@/config/config';
import {
  InboxPayloadMismatchError, MalformedMessageError, PermanentInfrastructureError, TransientInfrastructureError,
} from '@/application/errors';
import { bindContext, runWithContext } from '@/application/execution-context';
import { Failpoints } from '@/application/failpoints';
import { AppLogger, Metrics } from '@/application/ports/observability';
import { transactionFieldsSchema, idempotencyKeySchema } from '@/application/schemas';
import { RecordFailedTransactionUseCase } from '@/application/use-cases/record-failed-transaction';
import { SubmitWagerTransactionCommand, SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import { DomainError, InvalidTransactionStateError, InvariantViolationError } from '@/domain/shared/errors';
import { canonicalHash } from '@/domain/shared/hash';
import { APP_CONFIG, SQS, SqsQueues } from './sqs';

export const CONSUMER_NAME = 'wager-transactions-consumer';

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(128),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().min(1),
  data: transactionFieldsSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type MessageDisposition = 'ack' | 'retry' | 'dlq';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Classification =
  | { kind: 'BAD_INPUT'; reason: string }              // erro permanente da mensagem (payload/conflito) → DLQ
  | { kind: 'PERMANENT_INFRA'; reason: string }        // bug/integridade → FAILED auditável + DLQ
  | { kind: 'TRANSIENT'; reason: string }              // retry com backoff até o limite → DLQ
  | { kind: 'UNKNOWN'; reason: string };               // tratado como transitório; no limite vira FAILED + DLQ

export function classify(error: unknown): Classification {
  if (error instanceof MalformedMessageError) return { kind: 'BAD_INPUT', reason: 'MALFORMED_MESSAGE' };
  if (error instanceof InboxPayloadMismatchError) return { kind: 'BAD_INPUT', reason: 'INBOX_PAYLOAD_MISMATCH' };
  if (error instanceof InvariantViolationError || error instanceof InvalidTransactionStateError) {
    return { kind: 'PERMANENT_INFRA', reason: 'INVARIANT_VIOLATION' };
  }
  if (error instanceof DomainError) return { kind: 'BAD_INPUT', reason: error.code }; // IDEMPOTENCY_CONFLICT, WALLET_NOT_FOUND, VALIDATION_ERROR...
  if (error instanceof PermanentInfrastructureError) return { kind: 'PERMANENT_INFRA', reason: error.reason };
  if (error instanceof TransientInfrastructureError) return { kind: 'TRANSIENT', reason: error.kind };
  return { kind: 'UNKNOWN', reason: 'UNEXPECTED_ERROR' };
}

/**
 * Consumidor da fila FIFO de transações.
 *  - reutiliza o MESMO caso de uso da entrada HTTP;
 *  - dedup por inbox persistente (consumerName, messageId), na mesma transação do efeito;
 *  - ACK (DeleteMessage) SOMENTE depois do commit;
 *  - erro de negócio ⇒ REJECTED persistido + ack; transitório ⇒ retry com backoff exponencial (ChangeMessageVisibility);
 *    permanente/limite de tentativas ⇒ DLQ (com atributos de diagnóstico);
 *  - mensagens do mesmo MessageGroupId são processadas em ordem; grupos distintos em paralelo;
 *  - SIGTERM: conclui as mensagens em andamento e devolve a visibilidade das que não começaram.
 */
@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private stopping = false;
  private loops: Promise<void>[] = [];
  private readonly abort = new AbortController();

  constructor(
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(SqsQueues) private readonly queues: SqsQueues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(RecordFailedTransactionUseCase) private readonly recordFailed: RecordFailedTransactionUseCase,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(Failpoints) private readonly failpoints: Failpoints,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.run.consumer) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loops = Array.from({ length: this.config.consumer.concurrency }, (_, i) => this.pollLoop(i));
    this.logger.info('sqs consumer started', { pollers: this.loops.length });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.running = false;
    this.abort.abort(); // interrompe long-polls pendentes; mensagens em processamento terminam normalmente
    await Promise.race([Promise.allSettled(this.loops), sleep(this.config.consumer.shutdownTimeoutMs)]);
    this.logger.info('sqs consumer stopped');
  }

  private async pollLoop(index: number): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        await this.queues.ensure();
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queues.transactionsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.consumer.waitTimeS,
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        failures = 0;
        if (out.Messages?.length) await this.handleBatch(out.Messages);
      } catch (error) {
        if (!this.running) return;
        failures += 1;
        this.logger.warn('sqs poll failed', { poller: index, error });
        await sleep(Math.min(30_000, 250 * 2 ** Math.min(failures, 7)));
      }
    }
  }

  /** Mesmo MessageGroupId ⇒ sequencial e em ordem; grupos distintos ⇒ em paralelo. */
  private async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const key = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
  }

  private async handleGroup(group: Message[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const message = group[i]!;
      const disposition = this.stopping ? 'retry' : await this.handleMessage(message);
      if (this.stopping && disposition === 'retry') {
        await this.release(group.slice(i)); // shutdown: devolve a visibilidade do que não começou
        return;
      }
      if (disposition !== 'ack' && disposition !== 'dlq') {
        await this.release(group.slice(i + 1)); // preserva a ordem do grupo: o resto espera o retry desta
        return;
      }
    }
  }

  /** Processa UMA mensagem e devolve o destino dela. Nunca lança. */
  async handleMessage(message: Message): Promise<MessageDisposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    return runWithContext({ messageId: message.MessageId ?? '', correlationId: message.MessageId ?? '' }, async () => {
      let envelope: z.infer<typeof envelopeSchema>;
      try {
        envelope = this.parse(message.Body);
      } catch (error) {
        return this.deadLetter(message, receiveCount, 'MALFORMED_MESSAGE', error);
      }
      const { idempotencyKey, ...fields } = envelope.data;
      const command: SubmitWagerTransactionCommand = { idempotencyKey, ...fields };
      bindContext({ messageId: envelope.messageId, correlationId: envelope.messageId, providerId: command.providerId, walletId: command.walletId });

      try {
        const result = await this.submit.execute(command, {
          source: 'sqs',
          correlationId: envelope.messageId,
          inbox: { consumerName: CONSUMER_NAME, messageId: envelope.messageId, payloadHash: canonicalHash(envelope) },
        });
        // Ponto de falha para o teste "worker morto depois do commit e antes do ack".
        this.failpoints.hit('consumer.after-commit');
        await this.ack(message);
        this.metrics.sqsMessage(result.idempotentReplay ? 'duplicate' : 'processed');
        return 'ack';
      } catch (error) {
        return this.onFailure(message, command, receiveCount, error);
      }
    });
  }

  private parse(body: string | undefined): z.infer<typeof envelopeSchema> {
    let raw: unknown;
    try {
      raw = JSON.parse(body ?? '');
    } catch {
      throw new MalformedMessageError('message body is not valid JSON');
    }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MalformedMessageError('message does not match the WagerTransactionRequested contract', parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`));
    }
    return parsed.data;
  }

  private async onFailure(message: Message, command: SubmitWagerTransactionCommand, receiveCount: number, error: unknown): Promise<MessageDisposition> {
    const c = classify(error);
    const exhausted = receiveCount >= this.config.consumer.maxAttempts;

    if (c.kind === 'BAD_INPUT') return this.deadLetter(message, receiveCount, c.reason, error);
    if (c.kind === 'PERMANENT_INFRA') return this.deadLetter(message, receiveCount, c.reason, error, command);
    if (!exhausted) return this.retryLater(message, receiveCount, c.reason, error);
    // limite de tentativas esgotado: transitório persistente ⇒ DLQ; desconhecido ⇒ FAILED auditável + DLQ
    return c.kind === 'UNKNOWN'
      ? this.deadLetter(message, receiveCount, 'UNEXPECTED_ERROR_RETRIES_EXHAUSTED', error, command)
      : this.deadLetter(message, receiveCount, 'RETRIES_EXHAUSTED', error);
  }

  private async retryLater(message: Message, receiveCount: number, reason: string, error: unknown): Promise<MessageDisposition> {
    const { backoffBaseS, backoffMaxS } = this.config.consumer;
    const delay = Math.min(backoffMaxS, Math.round(backoffBaseS * 2 ** (receiveCount - 1)));
    this.metrics.retry('sqs-consumer');
    this.metrics.sqsMessage('retry');
    this.logger.warn('sqs message will be retried', { reason, receiveCount, retryInSeconds: delay, error });
    await this.changeVisibility(message, delay);
    return 'retry';
  }

  private async deadLetter(message: Message, receiveCount: number, reason: string, error: unknown, recordAs?: SubmitWagerTransactionCommand): Promise<MessageDisposition> {
    try {
      if (recordAs) {
        // auditoria FAILED em melhor esforço: não pode impedir o envio à DLQ
        await this.recordFailed.execute(recordAs, 'sqs').catch((e) => this.logger.warn('could not record FAILED transaction', { error: e }));
      }
      await this.queues.ensure();
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.queues.dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
          MessageDeduplicationId: `dlq-${message.MessageId}`,
          MessageAttributes: {
            FailureReason: { DataType: 'String', StringValue: reason },
            FailureDetail: { DataType: 'String', StringValue: (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'n/a' },
            OriginalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
            ReceiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          },
        }),
      );
      await this.ack(message); // só remove da fila principal depois de a DLQ aceitar
      this.metrics.dlq(reason);
      this.metrics.sqsMessage('dlq');
      this.logger.error('sqs message sent to DLQ', { reason, receiveCount, error });
      return 'dlq';
    } catch (dlqError) {
      // não conseguiu mover para a DLQ: deixa a mensagem na fila (o redrive do broker é a rede de segurança)
      this.logger.error('failed to send message to DLQ; it stays on the queue', { reason, error: dlqError });
      return 'retry';
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queues.transactionsUrl, ReceiptHandle: message.ReceiptHandle! }));
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.transactionsUrl, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: seconds }));
    } catch (error) {
      this.logger.warn('could not change message visibility', { error });
    }
  }

  private async release(messages: Message[]): Promise<void> {
    for (const m of messages) {
      this.metrics.sqsMessage('released');
      await this.changeVisibility(m, 0);
    }
  }
}
