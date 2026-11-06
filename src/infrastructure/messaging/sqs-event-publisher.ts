import { SendMessageBatchCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { EventPublisher, PublishOutcome } from '@/application/ports/event-publisher';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { SQS, SqsQueues } from './sqs';

const attributes = (m: OutboxMessage) => ({
  EventType: { DataType: 'String', StringValue: m.eventType },
  EventId: { DataType: 'String', StringValue: m.id },
  ...(typeof m.payload.correlationId === 'string' ? { CorrelationId: { DataType: 'String', StringValue: m.payload.correlationId } } : {}),
});

/**
 * Publica o envelope da outbox na fila de eventos. MessageGroupId = aggregateId (walletId) e
 * MessageDeduplicationId = eventId ajudam, mas NÃO são a garantia: consumidores deduplicam por eventId e
 * ordenam por `walletVersion` (a publicação é at-least-once). Usa SendMessageBatch (≤ 10 por chamada).
 */
@Injectable()
export class SqsEventPublisher extends EventPublisher {
  constructor(
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(SqsQueues) private readonly queues: SqsQueues,
  ) {
    super();
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.queues.ensure();
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queues.eventsUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: attributes(message),
      }),
    );
  }

  override async publishBatch(messages: OutboxMessage[]): Promise<PublishOutcome[]> {
    const fail = (error: unknown): PublishOutcome[] =>
      messages.map((m) => ({ id: m.id, status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }));
    try {
      await this.queues.ensure();
    } catch (error) {
      return fail(error);
    }
    const outcomes: PublishOutcome[] = [];
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      try {
        const out = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queues.eventsUrl,
            Entries: chunk.map((m, idx) => ({
              Id: String(idx), MessageBody: JSON.stringify(m.payload), MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id, MessageAttributes: attributes(m),
            })),
          }),
        );
        const failed = new Map((out.Failed ?? []).map((f) => [f.Id!, f.Message ?? f.Code ?? 'send failed']));
        chunk.forEach((m, idx) => {
          const error = failed.get(String(idx));
          outcomes.push(error === undefined ? { id: m.id, status: 'published' } : { id: m.id, status: 'failed', error });
        });
      } catch (error) {
        chunk.forEach((m) => outcomes.push({ id: m.id, status: 'failed', error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return outcomes;
  }
}
