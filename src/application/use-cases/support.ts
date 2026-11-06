import { isRetryableConflict, TransientInfrastructureError } from '../errors';
import { Metrics } from '../ports/observability';
import { Repositories } from '../ports/repositories';
import { EventContext, IntegrationEvent } from '@/domain/messaging/integration-event';
import {
  WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from '@/domain/messaging/events/events';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { MoneyProps } from '@/domain/money/money';
import { FailureCode } from '@/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionStatus } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { WalletLedgerEntry } from '@/domain/wallet/wallet-ledger-entry';

export interface SubmissionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado quando a transação foi resolvida (replays devolvem o mesmo valor). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): SubmissionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.balanceObserved ? { balance: tx.balanceObserved.toJSON() } : {}),
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    idempotentReplay,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Repete a unidade de trabalho quando o erro é um conflito de concorrência resolvível relendo o estado
 * (lock timeout, deadlock, serialização, corrida de unique, conflito de versão). Backoff curto com jitter.
 */
export async function withConflictRetries<T>(
  component: string,
  metrics: Metrics,
  work: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!isRetryableConflict(error) || attempt >= maxAttempts) throw error;
      metrics.retry(component);
      await sleep(Math.round((15 * attempt + Math.random() * 25) * attempt));
    }
  }
}

export function uniqueConflict(what: string): TransientInfrastructureError {
  return new TransientInfrastructureError(`unique conflict while inserting ${what}`, 'UNIQUE_CONFLICT');
}

const enqueue = (repos: Repositories, events: IntegrationEvent<unknown>[]) =>
  repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));

/**
 * Persiste uma transação aplicada: transação + lançamento + saldo + eventos na MESMA transação SQL.
 * `wallet` já contém o novo saldo/versão; `expectedVersion` é a versão lida sob lock.
 */
export async function persistProcessed(
  repos: Repositories,
  p: {
    tx: WagerTransaction; wallet: Wallet; expectedVersion: number; entry: WalletLedgerEntry | undefined; isNew: boolean;
    eventCtx: EventContext;
    /** false na abertura: a wallet acabou de ser inserida já com o saldo/versão finais. */
    persistWallet?: boolean;
  },
): Promise<void> {
  if (p.isNew) {
    if (!(await repos.transactions.insert(p.tx))) throw uniqueConflict('wager transaction');
  } else {
    await repos.transactions.update(p.tx);
  }
  if (p.entry) {
    await repos.ledger.insert(p.entry);
    if (p.persistWallet !== false) await repos.wallets.saveBalance(p.wallet, p.expectedVersion);
  }
  await enqueue(repos, [
    WagerTransactionProcessed.from(p.tx, p.eventCtx),
    ...(p.entry ? [WalletBalanceChanged.from(p.wallet, p.entry, p.eventCtx)] : []),
  ]);
  await repos.transactions.wakeDependents(p.tx.providerId, p.tx.externalTransactionId, p.eventCtx.occurredAt);
}

export async function persistRejected(
  repos: Repositories,
  p: { tx: WagerTransaction; isNew: boolean; eventCtx: EventContext },
): Promise<void> {
  if (p.isNew) {
    if (!(await repos.transactions.insert(p.tx))) throw uniqueConflict('wager transaction');
  } else {
    await repos.transactions.update(p.tx);
  }
  await enqueue(repos, [WagerTransactionRejected.from(p.tx, p.eventCtx)]);
  await repos.transactions.wakeDependents(p.tx.providerId, p.tx.externalTransactionId, p.eventCtx.occurredAt);
}

export async function persistPending(
  repos: Repositories,
  p: { tx: WagerTransaction; eventCtx: EventContext },
): Promise<void> {
  if (!(await repos.transactions.insert(p.tx))) throw uniqueConflict('wager transaction');
  await enqueue(repos, [WagerTransactionPendingReference.from(p.tx, p.eventCtx)]);
}
