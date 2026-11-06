import { Money } from '../money/money';
import { InvariantViolationError } from '../shared/errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  /** Versão da wallet APÓS o lançamento. (walletId, walletVersion) é único e ordena o ledger. */
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger. Sem setters, sem métodos de transição e instância congelada:
 * a imutabilidade é estrutural. O banco reforça (triggers que proíbem UPDATE/DELETE/TRUNCATE).
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly walletVersion: number,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética: balanceBefore ± money === balanceAfter, valor positivo e saldos não negativos. */
  static create(s: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(s);
    if (!s.money.isPositive()) throw new InvariantViolationError('ledger entry amount must be positive');
    if (s.balanceBefore.isNegative() || s.balanceAfter.isNegative()) {
      throw new InvariantViolationError('ledger entry balances must be non-negative');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError('unbalanced ledger entry', {
        direction: s.direction,
        before: s.balanceBefore.amount,
        amount: s.money.amount,
        after: s.balanceAfter.amount,
      });
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(s);
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(s.id, s.walletId, s.transactionId, s.walletVersion, s.direction, s.money, s.balanceBefore, s.balanceAfter, s.createdAt);
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
