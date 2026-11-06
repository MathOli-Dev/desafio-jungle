import { randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand, GetQueueAttributesCommand, Message, ReceiveMessageCommand, SendMessageBatchCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '@/config/config';
import { SilentLogger } from './fakes';
import { SQS_ENDPOINT } from './infra';
import { SqsQueues } from '@/infrastructure/messaging/sqs';

export const testSqsClient = (): SQSClient =>
  new SQSClient({ region: 'us-east-1', endpoint: SQS_ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

export interface TestQueues {
  names: { transactions: string; dlq: string; events: string };
  urls: { transactions: string; dlq: string; events: string };
  sqs: SQSClient;
}

/** Filas FIFO únicas por arquivo de teste, criadas exatamente como o serviço as cria (DLQ + redrive). */
export async function createTestQueues(extraEnv: Record<string, string> = {}): Promise<TestQueues> {
  const id = randomBytes(4).toString('hex');
  const names = { transactions: `it-${id}-tx.fifo`, dlq: `it-${id}-dlq.fifo`, events: `it-${id}-events.fifo` };
  const sqs = testSqsClient();
  const config = loadConfig({
    SQS_ENDPOINT, SQS_TRANSACTIONS_QUEUE: names.transactions, SQS_TRANSACTIONS_DLQ: names.dlq, SQS_EVENTS_QUEUE: names.events,
    SQS_AUTO_CREATE: 'true', SQS_VISIBILITY_TIMEOUT_S: '5', ...extraEnv,
  });
  const queues = new SqsQueues(sqs, config, new SilentLogger());
  await queues.ensure();
  return { names, urls: { transactions: queues.transactionsUrl, dlq: queues.dlqUrl, events: queues.eventsUrl }, sqs };
}

/** Variáveis de ambiente de uma instância de teste (usadas in-process e nos processos filhos). */
export function instanceEnv(dbUrl: string, q: TestQueues, extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test', PORT: '0',
    DATABASE_URL: dbUrl, DB_POOL_MAX: '8', DB_LOCK_TIMEOUT_MS: '8000',
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', SQS_ENDPOINT,
    SQS_TRANSACTIONS_QUEUE: q.names.transactions, SQS_TRANSACTIONS_DLQ: q.names.dlq, SQS_EVENTS_QUEUE: q.names.events,
    SQS_AUTO_CREATE: 'true', SQS_VISIBILITY_TIMEOUT_S: '5',
    CONSUMER_WAIT_TIME_S: '1', CONSUMER_CONCURRENCY: '2', CONSUMER_MAX_ATTEMPTS: '3', CONSUMER_BACKOFF_BASE_S: '1', CONSUMER_BACKOFF_MAX_S: '4',
    CONSUMER_SHUTDOWN_TIMEOUT_MS: '10000',
    OUTBOX_POLL_INTERVAL_MS: '100', OUTBOX_LEASE_MS: '3000', PENDING_POLL_INTERVAL_MS: '200',
    ...extra,
  };
}

export interface WagerMessage {
  messageId: string;
  groupId: string;
  body: string;
}

export function wagerMessage(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  o: Partial<{ messageId: string; providerId: string; externalTransactionId: string; idempotencyKey: string; referenceExternalTransactionId: string; roundId: string }> = {},
): WagerMessage {
  const messageId = o.messageId ?? `msg-${randomUUID()}`;
  const providerId = o.providerId ?? 'provider-a';
  const externalTransactionId = o.externalTransactionId ?? `ext-${randomUUID()}`;
  const body = JSON.stringify({
    messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: {
      providerId, externalTransactionId, idempotencyKey: o.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
      playerId: wallet.playerId, walletId: wallet.id, roundId: o.roundId ?? 'round-1', gameId: 'fortune-chimp', kind,
      money: { amount, currency: 'BRL' }, ...(o.referenceExternalTransactionId ? { referenceExternalTransactionId: o.referenceExternalTransactionId } : {}),
    },
  });
  return { messageId, groupId: wallet.id, body };
}

/** Envia em lotes de 10 (limite do SQS). `dedup` único por envio ⇒ o mesmo messageId pode ser reenviado de propósito. */
export async function sendMessages(sqs: SQSClient, queueUrl: string, messages: WagerMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 10) {
    const chunk = messages.slice(i, i + 10);
    const out = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: chunk.map((m, idx) => ({ Id: String(idx), MessageBody: m.body, MessageGroupId: m.groupId, MessageDeduplicationId: randomUUID() })),
      }),
    );
    if (out.Failed?.length) throw new Error(`send failed: ${JSON.stringify(out.Failed)}`);
  }
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
  );
  return { visible: Number(out.Attributes?.ApproximateNumberOfMessages ?? 0), inFlight: Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) };
}

/** Lê (e remove) mensagens de uma fila — usado para inspecionar DLQ e fila de eventos. */
export async function drainQueue(sqs: SQSClient, queueUrl: string, opts: { max?: number; waitMs?: number } = {}): Promise<Message[]> {
  const collected: Message[] = [];
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  while (Date.now() < deadline && collected.length < (opts.max ?? 1000)) {
    const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'], AttributeNames: ['All'], VisibilityTimeout: 30 }));
    if (!out.Messages?.length) {
      if (collected.length > 0) break; // já esvaziou o que existia
      continue;
    }
    for (const m of out.Messages) {
      collected.push(m);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return collected;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
  throw new Error(`timeout waiting for: ${opts.message ?? 'condition'}${last ? ` (last error: ${String(last)})` : ''}`);
}
