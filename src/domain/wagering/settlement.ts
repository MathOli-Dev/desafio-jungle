import { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export type SettlementResult =
  | { outcome: 'PROCESSED'; entry?: WalletLedgerEntry }
  | { outcome: 'REJECTED'; code: FailureCode }
  | { outcome: 'PENDING_REFERENCE'; reason: 'REFERENCE_MISSING' | 'REFERENCE_UNRESOLVED' };

export interface SettlementInput {
  tx: WagerTransaction;
  /** Wallet JÁ bloqueada pelo chamador (lock pessimista). É mutada quando a transação é aplicada. */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se ainda não existe. */
  reference: WagerTransaction | undefined;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para a referência? */
  referenceAlreadyReversed: boolean;
  now: Date;
  newEntryId: () => string;
}

const REVERSIBLE_KINDS = new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]);

type ReferenceVerdict = { kind: 'OK' } | { kind: 'WAIT' } | { kind: 'REJECT'; code: FailureCode };

function checkReference(tx: WagerTransaction, ref: WagerTransaction, alreadyReversed: boolean): ReferenceVerdict {
  const reject = (code: FailureCode): ReferenceVerdict => ({ kind: 'REJECT', code });

  // Mesmo provider (garantido pela busca), player, wallet, moeda e rodada.
  if (
    ref.providerId !== tx.providerId || ref.walletId !== tx.walletId || ref.playerId !== tx.playerId ||
    ref.roundId !== tx.roundId || ref.money.currency !== tx.money.currency
  ) {
    return reject(FailureCode.ReferenceMismatch);
  }
  // Referência ainda não resolvida (ela própria aguardando outra): dependente também espera.
  if (!ref.isTerminal()) return { kind: 'WAIT' };
  if (ref.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);

  switch (tx.kind) {
    case WagerTransactionKind.Refund: // REFUND só referencia BET
    case WagerTransactionKind.Win: // WIN/LOSS, quando referenciam, referenciam a BET da rodada
    case WagerTransactionKind.Loss:
      if (ref.kind !== WagerTransactionKind.Bet) return reject(FailureCode.InvalidReferenceKind);
      break;
    case WagerTransactionKind.Rollback: // ROLLBACK: BET, WIN ou REFUND
      if (!REVERSIBLE_KINDS.has(ref.kind)) return reject(FailureCode.InvalidReferenceKind);
      break;
    default:
      return reject(FailureCode.InvalidReferenceKind);
  }

  if (tx.isReversal()) {
    if (!ref.money.equals(tx.money)) return reject(FailureCode.ReferenceAmountMismatch);
    // Interpretação (ver ARCHITECTURE.md §6): no máximo UMA reversão aplicada por referência, de qualquer tipo —
    // REFUND + ROLLBACK da mesma BET creditariam duas vezes.
    if (alreadyReversed) return reject(FailureCode.AlreadyReversed);
  }
  return { kind: 'OK' };
}

/**
 * Decide e aplica uma transação sobre uma wallet já bloqueada. Função de domínio pura (sem I/O):
 *  - PROCESSED/REJECTED: muta `tx` (e `wallet`, quando há movimentação) e devolve o resultado;
 *  - PENDING_REFERENCE: NÃO muta `tx` — o chamador decide entre marcar pendente (1ª vez) ou reagendar (retry).
 * Reutilizada pela submissão (HTTP/SQS) e pelo reprocessamento de pendências.
 */
export function settle(input: SettlementInput): SettlementResult {
  const { tx, wallet, reference, now } = input;

  const rejected = (code: FailureCode): SettlementResult => {
    tx.reject(code, { balanceObserved: wallet.balance, ...(reference ? { referenceTransactionId: reference.id } : {}) });
    return { outcome: 'REJECTED', code };
  };

  if (tx.playerId !== wallet.playerId) return rejected(FailureCode.PlayerWalletMismatch);
  if (tx.money.currency !== wallet.currency) return rejected(FailureCode.CurrencyMismatch);

  if (tx.referenceExternalTransactionId !== undefined) {
    if (!reference) return { outcome: 'PENDING_REFERENCE', reason: 'REFERENCE_MISSING' };
    const verdict = checkReference(tx, reference, input.referenceAlreadyReversed);
    if (verdict.kind === 'WAIT') return { outcome: 'PENDING_REFERENCE', reason: 'REFERENCE_UNRESOLVED' };
    if (verdict.kind === 'REJECT') return rejected(verdict.code);
  }

  const movement = { entryId: input.newEntryId(), transactionId: tx.id, money: tx.money, at: now };
  let entry: WalletLedgerEntry | undefined;

  switch (tx.kind) {
    case WagerTransactionKind.Bet:
      if (!wallet.canDebit(tx.money)) return rejected(FailureCode.InsufficientFunds);
      entry = wallet.debit(movement);
      break;
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
      entry = wallet.credit(movement);
      break;
    case WagerTransactionKind.Loss:
      break; // registra o resultado sem mover saldo, sem lançamento
    case WagerTransactionKind.Rollback:
      if (tx.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
        if (!wallet.canDebit(tx.money)) return rejected(FailureCode.ReversalWouldOverdraw);
        entry = wallet.debit(movement);
      } else {
        entry = wallet.credit(movement);
      }
      break;
    default:
      // OPENING nunca passa por aqui (é aplicado na criação da wallet).
      throw new Error(`settle: unsupported kind ${tx.kind}`);
  }

  tx.markProcessed(now, wallet.balance, reference?.id);
  return entry ? { outcome: 'PROCESSED', entry } : { outcome: 'PROCESSED' };
}
