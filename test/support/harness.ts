import { expect } from 'bun:test';
import { Failpoints } from '@/application/failpoints';
import { Clock, SystemClock } from '@/application/ports/clock';
import { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import { TransactionQueries, WalletQueries } from '@/application/use-cases/queries';
import { RecordFailedTransactionUseCase } from '@/application/use-cases/record-failed-transaction';
import { ReprocessPendingReferenceUseCase } from '@/application/use-cases/reprocess-pending-reference';
import { SubmitWagerTransactionCommand, SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import { Orm } from '@/infrastructure/persistence/orm';
import { MikroOrmUnitOfWork } from '@/infrastructure/persistence/unit-of-work';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { RecordingMetrics, SilentLogger } from './fakes';
import { withPg } from './infra';

export class ManualClock extends Clock {
  constructor(private t: Date = new Date()) {
    super();
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export interface Harness {
  orm: Orm;
  uow: MikroOrmUnitOfWork;
  metrics: RecordingMetrics;
  logger: SilentLogger;
  clock: Clock;
  policy: PendingReferencePolicy;
  submit: SubmitWagerTransactionUseCase;
  createWallet: CreateWalletUseCase;
  reprocess: ReprocessPendingReferenceUseCase;
  recordFailed: RecordFailedTransactionUseCase;
  walletQueries: WalletQueries;
  txQueries: TransactionQueries;
}

export function buildHarness(orm: Orm, opts: { policy?: PendingReferencePolicy; failpoints?: Failpoints; clock?: Clock } = {}): Harness {
  const metrics = new RecordingMetrics();
  const logger = new SilentLogger();
  const clock = opts.clock ?? new SystemClock();
  const policy = opts.policy ?? new PendingReferencePolicy();
  const failpoints = opts.failpoints ?? new Failpoints(false);
  const uow = new MikroOrmUnitOfWork(orm, metrics);
  return {
    orm, uow, metrics, logger, clock, policy,
    submit: new SubmitWagerTransactionUseCase(uow, clock, metrics, logger, policy, failpoints),
    createWallet: new CreateWalletUseCase(uow, clock, logger),
    reprocess: new ReprocessPendingReferenceUseCase(uow, clock, metrics, logger, policy),
    recordFailed: new RecordFailedTransactionUseCase(uow, clock, metrics, logger),
    walletQueries: new WalletQueries(uow, metrics, logger),
    txQueries: new TransactionQueries(uow),
  };
}

let seq = 0;
export function cmd(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  o: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const ext = o.externalTransactionId ?? `ext-${process.pid}-${Date.now()}-${++seq}`;
  const provider = o.providerId ?? 'provider-a';
  return {
    idempotencyKey: `${provider}:${ext}`, providerId: provider, externalTransactionId: ext, playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round-1', gameId: 'fortune-chimp', kind, money: { amount, currency: 'BRL' }, ...o,
  };
}

export const ctx = (correlationId = 'test-correlation') => ({ source: 'http' as const, correlationId });

let playerSeq = 0;
export async function newWallet(h: Harness, balance = '100.00'): Promise<{ id: string; playerId: string }> {
  const playerId = `player-${process.pid}-${Date.now()}-${++playerSeq}`;
  const w = await h.createWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }, { correlationId: 'seed' });
  return { id: w.id, playerId };
}

/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger (e nunca negativo). */
export async function assertLedgerInvariant(url: string, walletId?: string): Promise<void> {
  const res = await withPg(url, (c) =>
    c.query(
      `SELECT w.id, (w.balance = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)) AS ok,
              (w.balance >= 0) AS non_negative,
              (w.version = COALESCE(MAX(l.wallet_version), 1)) AS version_ok
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
         ${walletId ? 'WHERE w.id = $1' : ''} GROUP BY w.id`,
      walletId ? [walletId] : [],
    ),
  );
  expect(res.rowCount).toBeGreaterThan(0);
  for (const row of res.rows) {
    expect(row.ok).toBe(true);
    expect(row.non_negative).toBe(true);
    expect(row.version_ok).toBe(true);
  }
}

export const count = async (url: string, sql: string, params: unknown[] = []): Promise<number> =>
  (await withPg(url, (c) => c.query(`SELECT count(*)::int AS n FROM (${sql}) t`, params))).rows[0].n as number;
