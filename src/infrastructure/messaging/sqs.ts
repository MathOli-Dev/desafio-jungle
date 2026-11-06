import {
  CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, QueueDoesNotExist, SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@/config/config';
import { AppLogger } from '@/application/ports/observability';

export const SQS = Symbol('SQS_CLIENT');
export const APP_CONFIG = Symbol('APP_CONFIG');

export function createSqsClient(cfg: AppConfig['sqs']): SQSClient {
  const hasEnvCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  return new SQSClient({
    region: cfg.region,
    maxAttempts: 3,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    // Emuladores (LocalStack/MiniStack) aceitam qualquer credencial; em AWS real vem do ambiente/role.
    ...(cfg.endpoint && !hasEnvCredentials ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
  });
}

/**
 * Resolve (e, em dev/teste, cria de forma idempotente) as filas FIFO. `ensure()` é preguiçosa e repetível:
 * se o SQS estiver fora do ar no boot, os workers simplesmente tentam de novo — o processo não morre.
 */
@Injectable()
export class SqsQueues {
  transactionsUrl = '';
  dlqUrl = '';
  eventsUrl = '';
  private ready: Promise<void> | undefined;

  constructor(
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  ensure(): Promise<void> {
    if (this.transactionsUrl && this.dlqUrl && this.eventsUrl) return Promise.resolve();
    this.ready ??= this.resolve().catch((error) => {
      this.ready = undefined; // permite nova tentativa
      throw error;
    });
    return this.ready;
  }

  private async resolve(): Promise<void> {
    const cfg = this.config.sqs;
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const dlqUrl = await this.getOrCreate(cfg.dlq, fifo);
    const dlqArn = await this.arn(dlqUrl);
    const transactionsUrl = await this.getOrCreate(cfg.transactionsQueue, {
      ...fifo,
      VisibilityTimeout: String(cfg.visibilityTimeoutS),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: cfg.redriveMaxReceiveCount }),
    });
    const eventsUrl = await this.getOrCreate(cfg.eventsQueue, fifo);
    Object.assign(this, { dlqUrl, transactionsUrl, eventsUrl });
    this.logger.info('sqs queues ready', { transactions: cfg.transactionsQueue, dlq: cfg.dlq, events: cfg.eventsQueue });
  }

  private async getOrCreate(name: string, attributes: Record<string, string>): Promise<string> {
    if (this.config.sqs.autoCreate) {
      try {
        const created = await this.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
        if (created.QueueUrl) return created.QueueUrl;
      } catch (error) {
        // fila já existe com outros atributos: usa a existente
        if ((error as { name?: string }).name !== 'QueueNameExists') throw error;
      }
    }
    try {
      return (await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    } catch (error) {
      if (error instanceof QueueDoesNotExist) throw new Error(`SQS queue ${name} does not exist (SQS_AUTO_CREATE=false)`);
      throw error;
    }
  }

  private async arn(queueUrl: string): Promise<string> {
    const out = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
    return out.Attributes!.QueueArn!;
  }

  /** Readiness: o SQS responde e a fila principal existe. */
  async ping(): Promise<void> {
    await this.ensure();
    await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.transactionsUrl, AttributeNames: ['QueueArn'] }));
  }
}
