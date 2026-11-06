import { Money } from '../money/money';
import { CurrencyMismatchError, DomainValidationError, InsufficientFundsError } from '../shared/errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementCommand {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. Invariantes:
 *  - saldo nunca negativo;
 *  - moeda da operação == moeda da wallet;
 *  - toda alteração de saldo devolve o lançamento correspondente (saldo e ledger mudam juntos);
 *  - `version` começa em 1 e só incrementa quando o saldo muda.
 * A unicidade (playerId, currency) e o anti-lost-update são garantidos pelo schema/locks (ver ARCHITECTURE.md).
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (typeof props.playerId !== 'string' || props.playerId.trim() === '' || props.playerId.length > 128) {
      throw new DomainValidationError('playerId must be a non-empty string with at most 128 chars');
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainValidationError('initial balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Lançamento de abertura (CREDIT do saldo inicial, balanceBefore = 0, versão 1).
   * Só faz sentido logo após `open`; `undefined` quando o saldo inicial é zero.
   */
  openingEntry(cmd: { entryId: string; transactionId: string; at: Date }): WalletLedgerEntry | undefined {
    if (this._version !== 1 || this._balance.isZero()) return undefined;
    return WalletLedgerEntry.create({
      id: cmd.entryId,
      walletId: this.id,
      transactionId: cmd.transactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: cmd.at,
    });
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debita e devolve o lançamento DEBIT. Lança InsufficientFundsError se o saldo ficaria negativo. */
  debit(cmd: MovementCommand): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, cmd);
  }

  /** Credita e devolve o lançamento CREDIT. */
  credit(cmd: MovementCommand): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, cmd);
  }

  private apply(direction: LedgerDirection, cmd: MovementCommand): WalletLedgerEntry {
    this.assertSameCurrency(cmd.money);
    if (!cmd.money.isPositive()) throw new DomainValidationError('movement amount must be positive');
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(cmd.money) : before.add(cmd.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError('wallet balance cannot become negative', { walletId: this.id });
    }
    const entry = WalletLedgerEntry.create({
      id: cmd.entryId,
      walletId: this.id,
      transactionId: cmd.transactionId,
      walletVersion: this._version + 1,
      direction,
      money: cmd.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: cmd.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = cmd.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet currency is ${this.currency}, operation is ${money.currency}`, {
        walletCurrency: this.currency,
        operationCurrency: money.currency,
      });
    }
  }
}
