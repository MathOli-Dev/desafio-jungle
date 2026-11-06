import { InvariantViolationError } from '../../shared/errors';
import { uuidv7 } from '../../shared/uuid';
import { MoneyProps } from '../../money/money';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/wager-transaction';
import { FailureCode } from '../../wagering/failure-code';
import { LedgerDirection, WalletLedgerEntry } from '../../wallet/wallet-ledger-entry';
import { Wallet } from '../../wallet/wallet';
import { EventContext, IntegrationEvent } from '../integration-event';

function observedBalance(tx: WagerTransaction): MoneyProps {
  if (!tx.balanceObserved) throw new InvariantViolationError('transaction has no observed balance', { transactionId: tx.id });
  return tx.balanceObserved.toJSON();
}

function base(tx: WagerTransaction, ctx: EventContext) {
  return {
    eventId: uuidv7(),
    aggregateId: tx.walletId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
  };
}

// ---------------------------------------------------------------- WagerTransactionProcessed
export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Saldo observado após aplicar (inclui LOSS, que não altera o saldo). */
  balance: MoneyProps;
  balanceChanged: boolean;
  referenceTransactionId?: string;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...base(tx, ctx),
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        playerId: tx.playerId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balance: observedBalance(tx),
        balanceChanged: tx.affectsBalance(),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

// ---------------------------------------------------------------- WagerTransactionRejected
export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  balance?: MoneyProps;
}

/** Transação rejeitada por regra de negócio (inclui a rejeição por referência inexistente após o TTL). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new InvariantViolationError('rejected transaction without failureCode', { transactionId: tx.id });
    return new WagerTransactionRejected({
      ...base(tx, ctx),
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        playerId: tx.playerId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
        ...(tx.balanceObserved ? { balance: tx.balanceObserved.toJSON() } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------- WalletBalanceChanged
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. `walletVersion` permite ao consumidor ordenar/ignorar eventos antigos. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: uuidv7(),
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

// ---------------------------------------------------------------- WagerTransactionPendingReference
export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  nextAttemptAt?: string;
}

/** Referência ausente: transação persistida como PENDING_REFERENCE. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...base(tx, ctx),
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
        ...(tx.nextReferenceCheckAt ? { nextAttemptAt: tx.nextReferenceCheckAt.toISOString() } : {}),
      },
    });
  }
}
