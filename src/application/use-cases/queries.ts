import { Inject, Injectable } from '@nestjs/common';
import { AppLogger, Metrics } from '../ports/observability';
import { UnitOfWork } from '../ports/repositories';
import { toWalletView, WalletView } from './create-wallet';
import { MoneyProps } from '@/domain/money/money';
import { DomainValidationError, TransactionNotFoundError, WalletNotFoundError } from '@/domain/shared/errors';
import { FAILURE_CODE_INFO, FailureCode, ProviderAction } from '@/domain/wagering/failure-code';
import { WagerTransaction } from '@/domain/wagering/wager-transaction';
import { WalletLedgerEntry } from '@/domain/wallet/wallet-ledger-entry';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: FailureCode;
  failureAction?: ProviderAction;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const MAX_LEDGER_PAGE = 200;

/** Cursor opaco e estável: base64url({ v: walletVersion }). O ledger é append-only ⇒ a ordem nunca muda sob escrita. */
export const encodeCursor = (walletVersion: number): string => Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 0) return parsed.v;
  } catch {
    /* cai no erro abaixo */
  }
  throw new DomainValidationError('invalid cursor', { field: 'cursor' });
}

const toLedgerView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id, transactionId: e.transactionId, walletVersion: e.walletVersion, direction: e.direction, money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(), balanceAfter: e.balanceAfter.toJSON(), createdAt: e.createdAt.toISOString(),
});

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId, walletId: tx.walletId,
    playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind, money: tx.money.toJSON(), status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode, failureAction: FAILURE_CODE_INFO[tx.failureCode].providerAction } : {}),
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.balanceObserved ? { balance: tx.balanceObserved.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

@Injectable()
export class WalletQueries {
  constructor(
    @Inject(UnitOfWork) private readonly uow: UnitOfWork,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    return toWalletView(wallet);
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<{ items: LedgerEntryView[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE) {
      throw new DomainValidationError(`limit must be an integer between 1 and ${MAX_LEDGER_PAGE}`, { field: 'limit' });
    }
    const after = cursor ? decodeCursor(cursor) : 0;
    const { wallet, entries } = await this.uow.read(async (r) => ({
      wallet: await r.wallets.findById(walletId),
      entries: await r.ledger.list(walletId, after, limit + 1),
    }));
    if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    const page = entries.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toLedgerView), nextCursor: entries.length > limit && last ? encodeCursor(last.walletVersion) : null };
  }

  /** Divergências NÃO são corrigidas em silêncio: são logadas, contabilizadas em métrica e sinalizadas na resposta. */
  async reconcile(walletId: string): Promise<ReconciliationView> {
    const snapshot = await this.uow.read((r) => r.ledger.reconcile(walletId));
    if (!snapshot) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    const difference = snapshot.stored.subtract(snapshot.calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet reconciliation divergence detected', { walletId, difference: difference.amount, checkedEntries: snapshot.entries });
    }
    return {
      walletId, storedBalance: snapshot.stored.toJSON(), calculatedBalance: snapshot.calculated.toJSON(),
      difference: difference.toJSON(), consistent, checkedEntries: snapshot.entries,
    };
  }
}

@Injectable()
export class TransactionQueries {
  constructor(@Inject(UnitOfWork) private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<TransactionView> {
    const tx = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
    return toTransactionView(tx);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.uow.read((r) => r.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new TransactionNotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
    return toTransactionView(tx);
  }
}
