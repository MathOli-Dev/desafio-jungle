import { InboxMessage } from '@/domain/messaging/inbox-message';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { Money } from '@/domain/money/money';
import { WagerTransaction } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { WalletLedgerEntry } from '@/domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE (lock pessimista por wallet). Exige transação. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** `false` quando já existe wallet para (playerId, currency). */
  insert(wallet: Wallet): Promise<boolean>;
  /** UPDATE ... WHERE version = expectedVersion. Lança ConcurrencyConflictError se nenhuma linha for afetada. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface DuePendingTransaction {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Procura por (provider, idempotencyKey) OU (provider, externalTransactionId); prefere o match por key. */
  findExisting(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** `false` quando alguma restrição de unicidade já existe (INSERT ... ON CONFLICT DO NOTHING). */
  insert(tx: WagerTransaction): Promise<boolean>;
  update(tx: WagerTransaction): Promise<void>;
  /** Existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** Torna imediatamente devidas as pendências que aguardam (providerId, externalTransactionId). */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<void>;
  findDuePending(now: Date, limit: number): Promise<DuePendingTransaction[]>;
}

export interface ReconciliationSnapshot {
  walletId: string;
  stored: Money;
  /** Σ créditos − Σ débitos do ledger (pode ser negativo se houver corrupção). */
  calculated: Money;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Ordem crescente de walletVersion; estável sob escritas concorrentes (append-only). */
  list(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  /** Saldo armazenado vs reconstruído, lidos em UM statement (snapshot consistente). */
  reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. `false` ⇒ já recebida (duplicata). */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxStats {
  pending: number;
  oldestOccurredAt: Date | undefined;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** Claim com lease via FOR UPDATE SKIP LOCKED: múltiplos publishers não pegam as mesmas linhas. */
  claimDue(limit: number, lockedBy: string, leaseMs: number, now: Date): Promise<OutboxMessage[]>;
  /** Marca o lote como publicado (1 statement). Devolve quantas linhas ainda estavam sob o lease deste publisher. */
  markPublished(messages: OutboxMessage[], lockedBy: string): Promise<number>;
  scheduleRetry(message: OutboxMessage, lockedBy: string, error: string): Promise<boolean>;
  /** Devolve claims não utilizados (ex.: shutdown) sem contar tentativa. */
  release(ids: string[], lockedBy: string): Promise<void>;
  stats(): Promise<OutboxStats>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export abstract class UnitOfWork {
  /** Executa `work` em UMA transação SQL (commit se resolver, rollback se lançar). */
  abstract run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  /** Leituras fora de transação (cada statement em autocommit). */
  abstract read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
