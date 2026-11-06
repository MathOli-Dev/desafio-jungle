import { hostname } from 'node:os';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(3000, 0),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  INSTANCE_ID: z.string().default(`${hostname()}-${process.pid}`),

  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/wager'),
  DB_POOL_MIN: int(1),
  DB_POOL_MAX: int(20, 1),
  DB_ACQUIRE_TIMEOUT_MS: int(10_000, 100),
  DB_LOCK_TIMEOUT_MS: int(5_000, 100),
  DB_STATEMENT_TIMEOUT_MS: int(15_000, 100),
  DB_IDLE_IN_TX_TIMEOUT_MS: int(30_000, 1_000),
  AUTO_MIGRATE: bool(false),

  AWS_REGION: z.string().default('us-east-1'),
  SQS_ENDPOINT: z.string().optional(),
  SQS_TRANSACTIONS_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wager-events.fifo'),
  /** Cria filas (idempotente) no boot. Em produção as filas vêm da infraestrutura (IaC). */
  SQS_AUTO_CREATE: bool(true),
  /** Rede de segurança do broker: após N recebimentos o SQS move para a DLQ por conta própria. */
  SQS_REDRIVE_MAX_RECEIVE_COUNT: int(10, 1),
  SQS_VISIBILITY_TIMEOUT_S: int(60, 1),

  RUN_HTTP: bool(true),
  RUN_CONSUMER: bool(true),
  RUN_OUTBOX_PUBLISHER: bool(true),
  RUN_PENDING_REFERENCE_WORKER: bool(true),

  CONSUMER_WAIT_TIME_S: int(20, 0),
  /** Número de loops de polling concorrentes (cada um recebe até 10 mensagens por vez). */
  CONSUMER_CONCURRENCY: int(4, 1),
  /** Limite de tentativas da aplicação antes de enviar à DLQ (≤ SQS_REDRIVE_MAX_RECEIVE_COUNT). */
  CONSUMER_MAX_ATTEMPTS: int(5, 1),
  CONSUMER_BACKOFF_BASE_S: int(2, 0),
  CONSUMER_BACKOFF_MAX_S: int(300, 1),
  CONSUMER_SHUTDOWN_TIMEOUT_MS: int(25_000, 0),

  OUTBOX_POLL_INTERVAL_MS: int(500, 10),
  OUTBOX_BATCH_SIZE: int(50, 1),
  /** Lease do claim: se o publisher morrer, outro assume após este prazo. */
  OUTBOX_LEASE_MS: int(30_000, 100),

  PENDING_POLL_INTERVAL_MS: int(1_000, 10),
  PENDING_BATCH_SIZE: int(50, 1),
  PENDING_MAX_ATTEMPTS: int(10, 1),
  PENDING_TTL_MS: int(300_000, 1),
  PENDING_BASE_DELAY_MS: int(1_000, 1),
  PENDING_MAX_DELAY_MS: int(60_000, 1),

  /** Injeção de falhas para testes de caos. Só ativa com ENABLE_FAILPOINTS=true (nunca em produção). */
  ENABLE_FAILPOINTS: bool(false),
  FAILPOINTS: z.string().default(''),
});

export interface AppConfig {
  env: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  instanceId: string;
  db: {
    url: string; poolMin: number; poolMax: number; acquireTimeoutMs: number; lockTimeoutMs: number;
    statementTimeoutMs: number; idleInTxTimeoutMs: number; autoMigrate: boolean;
  };
  sqs: {
    region: string; endpoint: string | undefined; transactionsQueue: string; dlq: string; eventsQueue: string;
    autoCreate: boolean; redriveMaxReceiveCount: number; visibilityTimeoutS: number;
  };
  run: { http: boolean; consumer: boolean; outboxPublisher: boolean; pendingReferenceWorker: boolean };
  consumer: {
    waitTimeS: number; concurrency: number; maxAttempts: number; backoffBaseS: number; backoffMaxS: number; shutdownTimeoutMs: number;
  };
  outbox: { pollIntervalMs: number; batchSize: number; leaseMs: number };
  pending: { pollIntervalMs: number; batchSize: number; maxAttempts: number; ttlMs: number; baseDelayMs: number; maxDelayMs: number };
  failpoints: { enabled: boolean; spec: string };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const e = schema.parse(env);
  return {
    env: e.NODE_ENV, port: e.PORT, logLevel: e.LOG_LEVEL, instanceId: e.INSTANCE_ID,
    db: {
      url: e.DATABASE_URL, poolMin: e.DB_POOL_MIN, poolMax: e.DB_POOL_MAX, acquireTimeoutMs: e.DB_ACQUIRE_TIMEOUT_MS,
      lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS, statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      idleInTxTimeoutMs: e.DB_IDLE_IN_TX_TIMEOUT_MS, autoMigrate: e.AUTO_MIGRATE,
    },
    sqs: {
      region: e.AWS_REGION, endpoint: e.SQS_ENDPOINT, transactionsQueue: e.SQS_TRANSACTIONS_QUEUE, dlq: e.SQS_TRANSACTIONS_DLQ,
      eventsQueue: e.SQS_EVENTS_QUEUE, autoCreate: e.SQS_AUTO_CREATE, redriveMaxReceiveCount: e.SQS_REDRIVE_MAX_RECEIVE_COUNT,
      visibilityTimeoutS: e.SQS_VISIBILITY_TIMEOUT_S,
    },
    run: { http: e.RUN_HTTP, consumer: e.RUN_CONSUMER, outboxPublisher: e.RUN_OUTBOX_PUBLISHER, pendingReferenceWorker: e.RUN_PENDING_REFERENCE_WORKER },
    consumer: {
      waitTimeS: e.CONSUMER_WAIT_TIME_S, concurrency: e.CONSUMER_CONCURRENCY, maxAttempts: e.CONSUMER_MAX_ATTEMPTS,
      backoffBaseS: e.CONSUMER_BACKOFF_BASE_S, backoffMaxS: e.CONSUMER_BACKOFF_MAX_S, shutdownTimeoutMs: e.CONSUMER_SHUTDOWN_TIMEOUT_MS,
    },
    outbox: { pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS, batchSize: e.OUTBOX_BATCH_SIZE, leaseMs: e.OUTBOX_LEASE_MS },
    pending: {
      pollIntervalMs: e.PENDING_POLL_INTERVAL_MS, batchSize: e.PENDING_BATCH_SIZE, maxAttempts: e.PENDING_MAX_ATTEMPTS,
      ttlMs: e.PENDING_TTL_MS, baseDelayMs: e.PENDING_BASE_DELAY_MS, maxDelayMs: e.PENDING_MAX_DELAY_MS,
    },
    failpoints: { enabled: e.ENABLE_FAILPOINTS && e.NODE_ENV !== 'production', spec: e.FAILPOINTS },
  };
}
