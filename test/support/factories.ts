import { Money } from '@/domain/money/money';
import { uuidv7 } from '@/domain/shared/uuid';
import { Wallet } from '@/domain/wallet/wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/domain/wagering/wager-transaction';

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export function makeWallet(balance = '100.00', overrides: { currency?: string; playerId?: string } = {}): Wallet {
  return Wallet.open({
    id: uuidv7(),
    playerId: overrides.playerId ?? 'player-1',
    initialBalance: Money.from({ amount: balance, currency: overrides.currency ?? 'BRL' }),
  });
}

export interface TxOverrides {
  providerId?: string;
  externalTransactionId?: string;
  playerId?: string;
  roundId?: string;
  currency?: string;
  reference?: string | undefined;
  idempotencyKey?: string;
}

let counter = 0;
export function makeTx(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  o: TxOverrides = {},
): WagerTransaction {
  const externalTransactionId = o.externalTransactionId ?? `ext-${++counter}`;
  return WagerTransaction.create({
    id: uuidv7(),
    providerId: o.providerId ?? 'provider-a',
    externalTransactionId,
    idempotencyKey: o.idempotencyKey ?? `${o.providerId ?? 'provider-a'}:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: o.playerId ?? wallet.playerId,
    roundId: o.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount, currency: o.currency ?? wallet.currency }),
    referenceExternalTransactionId: o.reference,
    createdAt: new Date(),
  });
}

/** Aplica uma transação já "processada" (estado persistido) para servir de referência. */
export function processed(tx: WagerTransaction, wallet: Wallet): WagerTransaction {
  tx.markProcessed(new Date(), wallet.balance);
  return tx;
}

export const rehydrateWithStatus = (tx: WagerTransaction, status: WagerTransactionStatus): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash, walletId: tx.walletId, playerId: tx.playerId,
    roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind, money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId, createdAt: tx.createdAt, status,
  });
