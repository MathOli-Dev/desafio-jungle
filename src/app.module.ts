import 'reflect-metadata';
import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppConfig } from './config/config';
import { Failpoints } from './application/failpoints';
import { Clock, SystemClock } from './application/ports/clock';
import { EventPublisher } from './application/ports/event-publisher';
import { AppLogger, Metrics } from './application/ports/observability';
import { NoopProviderIdentity, ProviderIdentityPort } from './application/ports/provider-identity';
import { UnitOfWork } from './application/ports/repositories';
import { CreateWalletUseCase } from './application/use-cases/create-wallet';
import { TransactionQueries, WalletQueries } from './application/use-cases/queries';
import { RecordFailedTransactionUseCase } from './application/use-cases/record-failed-transaction';
import { ReprocessPendingReferenceUseCase } from './application/use-cases/reprocess-pending-reference';
import { PENDING_REFERENCE_POLICY, SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction';
import { PendingReferencePolicy } from './domain/wagering/pending-reference-policy';
import { APP_CONFIG, createSqsClient, SQS, SqsQueues } from './infrastructure/messaging/sqs';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { WagerTransactionsConsumer } from './infrastructure/messaging/wager-transactions-consumer';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { createOrm, migrateUp, ORM } from './infrastructure/persistence/orm';
import type { Orm } from './infrastructure/persistence/orm';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/unit-of-work';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { AuthGuard } from './interfaces/http/auth/auth';
import { AllExceptionsFilter } from './interfaces/http/filters/all-exceptions.filter';
import { HealthController, MetricsController } from './interfaces/http/health.controller';
import { httpObservability } from './interfaces/http/middleware/http-observability';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

/** Fecha o pool do ORM por último (depois dos workers drenarem e do servidor HTTP parar). */
@Injectable()
class OrmLifecycle implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: Orm) {}
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: AppLogger, useValue: new JsonLogger(config.logLevel) },
        PrometheusMetrics,
        { provide: Metrics, useExisting: PrometheusMetrics },
        { provide: Clock, useClass: SystemClock },
        { provide: Failpoints, useValue: new Failpoints(config.failpoints.enabled, config.failpoints.spec) },
        {
          provide: PENDING_REFERENCE_POLICY,
          useValue: new PendingReferencePolicy(config.pending.maxAttempts, config.pending.ttlMs, config.pending.baseDelayMs, config.pending.maxDelayMs),
        },
        {
          provide: ORM,
          useFactory: async (): Promise<Orm> => {
            const orm = await createOrm(config.db);
            if (config.db.autoMigrate) await migrateUp(orm);
            return orm;
          },
        },
        OrmLifecycle,
        { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
        { provide: ProviderIdentityPort, useClass: NoopProviderIdentity },
        { provide: SQS, useFactory: () => createSqsClient(config.sqs) },
        SqsQueues,
        { provide: EventPublisher, useClass: SqsEventPublisher },
        SubmitWagerTransactionUseCase,
        ReprocessPendingReferenceUseCase,
        RecordFailedTransactionUseCase,
        CreateWalletUseCase,
        WalletQueries,
        TransactionQueries,
        WagerTransactionsConsumer,
        OutboxPublisherWorker,
        PendingReferenceWorker,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}

/**
 * Configuração comum (main.ts e testes): correlação ANTES do body-parser (erros de JSON quebrado também levam
 * X-Correlation-Id), logs JSON, limite de corpo e shutdown hooks.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(AppLogger) as unknown as JsonLogger);
  app.use(httpObservability(app.get(AppLogger), app.get(PrometheusMetrics)));
  app.useBodyParser('json', { limit: '100kb' });
  app.enableShutdownHooks(); // SIGTERM/SIGINT ⇒ drena consumer/publisher/worker, fecha HTTP e depois o pool
}

export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { logger: ['error', 'warn'], bodyParser: false });
  configureApp(app);
  return app;
}
