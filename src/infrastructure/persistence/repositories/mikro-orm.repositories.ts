import { LockMode, QueryResult } from '@mikro-orm/core';
import { SqlEntityManager } from '@mikro-orm/postgresql';
import {
  DuePendingTransaction, InboxRepository, LedgerRepository, OutboxRepository, OutboxStats, ReconciliationSnapshot,
  Repositories, WagerTransactionRepository, WalletRepository,
} from '@/application/ports/repositories';
import { ConcurrencyConflictError } from '@/application/errors';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import { FailureCode } from '@/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/wallet/wallet-ledger-entry';
import { LedgerEntryRecord, OutboxMessageRecord, WalletRecord } from '../records/records';

type Em = SqlEntityManager;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const query = (em: Em, sql: string, params: unknown[] = []): Promise<Row[]> => em.execute<Row[]>(sql, params);
const run = async (em: Em, sql: string, params: unknown[] = []): Promise<number> =>
  (await em.execute<QueryResult>(sql, params, 'run')).affectedRows;
const asDate = (v: unknown): Date | undefined => (v === null || v === undefined ? undefined : v instanceof Date ? v : new Date(v as string));
const money = (amount: unknown, currency: string): Money => Money.from({ amount: String(amount), currency });

// ------------------------------------------------------------------------------------------------ wallets
class WalletRepo implements WalletRepository {
  constructor(private readonly em: Em) {}

  private toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id, playerId: r.playerId, currency: r.currency, balance: money(r.balance, r.currency),
      version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt,
    });
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const rec = await this.em.findOne(WalletRecord, { id }, { refresh: true });
    return rec ? this.toDomain(rec) : undefined;
  }

  /** Lock pessimista por wallet: serializa só as operações da MESMA wallet (wallets distintas seguem em paralelo). */
  async lockById(id: string): Promise<Wallet | undefined> {
    const rec = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return rec ? this.toDomain(rec) : undefined;
  }

  async insert(w: Wallet): Promise<boolean> {
    const rows = await query(
      this.em,
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (player_id, currency) DO NOTHING RETURNING id`,
      [w.id, w.playerId, w.currency, w.balance.amount, w.version, w.createdAt, w.updatedAt],
    );
    return rows.length === 1;
  }

  async saveBalance(w: Wallet, expectedVersion: number): Promise<void> {
    const affected = await run(
      this.em,
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
      [w.balance.amount, w.version, w.updatedAt, w.id, expectedVersion],
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`wallet ${w.id} was modified concurrently (expected version ${expectedVersion})`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ transactions
const TX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
  game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code,
  balance_observed, reference_attempts, next_reference_check_at, created_at, processed_at`;

function rowToTransaction(r: Row): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id, providerId: r.provider_id, externalTransactionId: r.external_transaction_id, idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash, walletId: r.wallet_id, playerId: r.player_id, roundId: r.round_id, gameId: r.game_id,
    kind: r.kind as WagerTransactionKind, money: money(r.amount, r.currency),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined, createdAt: asDate(r.created_at)!,
    status: r.status as WagerTransactionStatus, referenceTransactionId: r.reference_transaction_id ?? undefined,
    failureCode: (r.failure_code ?? undefined) as FailureCode | undefined, processedAt: asDate(r.processed_at),
    balanceObserved: r.balance_observed === null || r.balance_observed === undefined ? undefined : money(r.balance_observed, r.currency),
    referenceAttempts: Number(r.reference_attempts), nextReferenceCheckAt: asDate(r.next_reference_check_at),
  });
}

class WagerTransactionRepo implements WagerTransactionRepository {
  constructor(private readonly em: Em) {}

  private async one(where: string, params: unknown[], suffix = ''): Promise<WagerTransaction | undefined> {
    const rows = await query(this.em, `SELECT ${TX_COLUMNS} FROM wager_transactions WHERE ${where} ${suffix} LIMIT 1`, params);
    return rows[0] ? rowToTransaction(rows[0]) : undefined;
  }

  findById(id: string) {
    return this.one('id = ?', [id]);
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.one('provider_id = ? AND external_transaction_id = ?', [providerId, externalTransactionId]);
  }

  findExisting(providerId: string, idempotencyKey: string, externalTransactionId: string) {
    return this.one(
      'provider_id = ? AND (idempotency_key = ? OR external_transaction_id = ?)',
      [providerId, idempotencyKey, externalTransactionId, idempotencyKey],
      'ORDER BY (idempotency_key = ?) DESC',
    );
  }

  async insert(tx: WagerTransaction): Promise<boolean> {
    const rows = await query(
      this.em,
      `INSERT INTO wager_transactions (${TX_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId,
        tx.roundId, tx.gameId, tx.kind, tx.money.amount, tx.money.currency, tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null, tx.status, tx.failureCode ?? null, tx.balanceObserved?.amount ?? null,
        tx.referenceAttempts, tx.nextReferenceCheckAt ?? null, tx.createdAt, tx.processedAt ?? null,
      ],
    );
    return rows.length === 1;
  }

  async update(tx: WagerTransaction): Promise<void> {
    const affected = await run(
      this.em,
      `UPDATE wager_transactions
          SET status = ?, failure_code = ?, reference_transaction_id = ?, balance_observed = ?,
              reference_attempts = ?, next_reference_check_at = ?, processed_at = ?
        WHERE id = ?`,
      [
        tx.status, tx.failureCode ?? null, tx.referenceTransactionId ?? null, tx.balanceObserved?.amount ?? null,
        tx.referenceAttempts, tx.nextReferenceCheckAt ?? null, tx.processedAt ?? null, tx.id,
      ],
    );
    if (affected !== 1) throw new Error(`wager transaction ${tx.id} not found for update`);
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const rows = await query(
      this.em,
      `SELECT 1 AS found FROM wager_transactions
        WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<void> {
    await run(
      this.em,
      `UPDATE wager_transactions SET next_reference_check_at = ?
        WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
          AND next_reference_check_at > ?`,
      [now, providerId, externalTransactionId, now],
    );
  }

  async findDuePending(now: Date, limit: number): Promise<DuePendingTransaction[]> {
    const rows = await query(
      this.em,
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= ?
        ORDER BY next_reference_check_at LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: r.id as string, walletId: r.wallet_id as string }));
  }
}

// ------------------------------------------------------------------------------------------------ ledger
class LedgerRepo implements LedgerRepository {
  constructor(private readonly em: Em) {}

  async insert(e: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, {
      id: e.id, walletId: e.walletId, transactionId: e.transactionId, walletVersion: e.walletVersion,
      direction: e.direction, amount: e.money.amount, currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount, balanceAfter: e.balanceAfter.amount, createdAt: e.createdAt,
    });
  }

  async list(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    const rows = await query(
      this.em,
      `SELECT id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at
         FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version > ? ORDER BY wallet_version ASC LIMIT ?`,
      [walletId, afterVersion, limit],
    );
    return rows.map((r) =>
      WalletLedgerEntry.rehydrate({
        id: r.id, walletId: r.wallet_id, transactionId: r.transaction_id, walletVersion: Number(r.wallet_version),
        direction: r.direction as LedgerDirection, money: money(r.amount, r.currency),
        balanceBefore: money(r.balance_before, r.currency), balanceAfter: money(r.balance_after, r.currency),
        createdAt: asDate(r.created_at)!,
      }),
    );
  }

  /** Um único statement ⇒ snapshot consistente entre o saldo armazenado e o somatório do ledger. */
  async reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    const rows = await query(
      this.em,
      `SELECT w.id, w.currency, w.balance AS stored,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'CREDIT'), 0) AS credits,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'DEBIT'), 0) AS debits,
              COUNT(l.id) AS entries
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      walletId: r.id,
      stored: money(r.stored, r.currency),
      calculated: money(r.credits, r.currency).subtract(money(r.debits, r.currency)),
      entries: Number(r.entries),
    };
  }
}

// ------------------------------------------------------------------------------------------------ inbox
class InboxRepo implements InboxRepository {
  constructor(private readonly em: Em) {}

  async tryReceive(m: InboxMessage): Promise<boolean> {
    const rows = await query(
      this.em,
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING message_id`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const rows = await query(
      this.em,
      `SELECT consumer_name, message_id, payload_hash, received_at, processed_at FROM inbox_messages
        WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    const r = rows[0];
    return r
      ? InboxMessage.rehydrate({
          consumerName: r.consumer_name, messageId: r.message_id, payloadHash: r.payload_hash,
          receivedAt: asDate(r.received_at)!, processedAt: asDate(r.processed_at),
        })
      : undefined;
  }

  async markProcessed(m: InboxMessage): Promise<void> {
    await run(this.em, `UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?`, [
      m.processedAt ?? new Date(), m.consumerName, m.messageId,
    ]);
  }
}

// ------------------------------------------------------------------------------------------------ outbox
class OutboxRepo implements OutboxRepository {
  constructor(private readonly em: Em) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map((m) => ({
        id: m.id, aggregateId: m.aggregateId, eventType: m.eventType, payload: m.payload as Record<string, unknown>,
        occurredAt: m.occurredAt, attempts: m.attempts, nextAttemptAt: m.nextAttemptAt ?? m.occurredAt,
      })),
    );
  }

  /**
   * Claim com lease. `FOR UPDATE SKIP LOCKED` faz publishers concorrentes pularem linhas já travadas;
   * `locked_until` torna o claim durável: se o publisher morrer, outro assume quando o lease expira.
   */
  async claimDue(limit: number, lockedBy: string, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await query(
      this.em,
      `WITH due AS (
         SELECT id FROM outbox_messages
          WHERE published_at IS NULL AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?)
          ORDER BY seq LIMIT ? FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_messages o SET locked_by = ?, locked_until = ?
         FROM due WHERE o.id = due.id
       RETURNING o.id, o.seq, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts, o.next_attempt_at, o.published_at`,
      [now, now, limit, lockedBy, new Date(now.getTime() + leaseMs)],
    );
    rows.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id, aggregateId: r.aggregate_id, eventType: r.event_type,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        occurredAt: asDate(r.occurred_at)!, attempts: Number(r.attempts), nextAttemptAt: asDate(r.next_attempt_at),
        publishedAt: asDate(r.published_at),
      }),
    );
  }

  async markPublished(messages: OutboxMessage[], lockedBy: string): Promise<number> {
    if (messages.length === 0) return 0;
    return run(
      this.em,
      `UPDATE outbox_messages SET published_at = ?, last_error = NULL, locked_by = NULL, locked_until = NULL
        WHERE id IN (?) AND locked_by = ? AND published_at IS NULL`,
      [messages[0]!.publishedAt ?? new Date(), messages.map((m) => m.id), lockedBy],
    );
  }

  async scheduleRetry(m: OutboxMessage, lockedBy: string, error: string): Promise<boolean> {
    const affected = await run(
      this.em,
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL
        WHERE id = ? AND locked_by = ?`,
      [m.attempts, m.nextAttemptAt ?? new Date(), error.slice(0, 1000), m.id, lockedBy],
    );
    return affected === 1;
  }

  async release(ids: string[], lockedBy: string): Promise<void> {
    if (ids.length === 0) return;
    await run(this.em, `UPDATE outbox_messages SET locked_by = NULL, locked_until = NULL WHERE id IN (?) AND locked_by = ?`, [ids, lockedBy]);
  }

  async stats(): Promise<OutboxStats> {
    const rows = await query(this.em, `SELECT COUNT(*) AS pending, MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`);
    return { pending: Number(rows[0]?.pending ?? 0), oldestOccurredAt: asDate(rows[0]?.oldest) };
  }
}

export function buildRepositories(em: Em): Repositories {
  return {
    wallets: new WalletRepo(em),
    transactions: new WagerTransactionRepo(em),
    ledger: new LedgerRepo(em),
    inbox: new InboxRepo(em),
    outbox: new OutboxRepo(em),
  };
}
