import { describe, expect, test } from 'bun:test';
import { Money } from '@/domain/money/money';
import { CurrencyMismatchError, DomainValidationError, InsufficientFundsError, InvariantViolationError } from '@/domain/shared/errors';
import { uuidv7 } from '@/domain/shared/uuid';
import { Wallet } from '@/domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/wallet/wallet-ledger-entry';
import { brl, makeWallet } from '@test/support/factories';

const mv = (money: Money) => ({ entryId: uuidv7(), transactionId: uuidv7(), money, at: new Date() });

describe('Wallet — invariantes', () => {
  test('open: versão inicia em 1 e saldo é o inicial', () => {
    const w = makeWallet('1000.00');
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('1000.00');
    expect(w.currency).toBe('BRL');
  });

  test('open: playerId vazio é rejeitado', () => {
    expect(() => Wallet.open({ id: uuidv7(), playerId: ' ', initialBalance: brl('1.00') })).toThrow(DomainValidationError);
  });

  test('open: saldo inicial negativo é rejeitado', () => {
    expect(() => Wallet.open({ id: uuidv7(), playerId: 'p', initialBalance: brl('1.00').negate() })).toThrow(DomainValidationError);
  });

  test('débito devolve lançamento DEBIT balanceado e incrementa a versão', () => {
    const w = makeWallet('100.00');
    const entry = w.debit(mv(brl('30.00')));
    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('crédito devolve lançamento CREDIT e incrementa a versão', () => {
    const w = makeWallet('0.00');
    const entry = w.credit(mv(brl('12.34')));
    expect(w.balance.amount).toBe('12.34');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('0.00');
    expect(w.version).toBe(2);
  });

  test('saldo nunca fica negativo: débito acima do saldo lança e NÃO altera estado', () => {
    const w = makeWallet('50.00');
    expect(() => w.debit(mv(brl('50.01')))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('50.00');
    expect(w.version).toBe(1);
  });

  test('débito exatamente igual ao saldo zera a wallet', () => {
    const w = makeWallet('50.00');
    w.debit(mv(brl('50.00')));
    expect(w.balance.isZero()).toBe(true);
  });

  test('moeda da operação deve ser igual à da wallet', () => {
    const w = makeWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => w.debit(mv(usd))).toThrow(CurrencyMismatchError);
    expect(() => w.credit(mv(usd))).toThrow(CurrencyMismatchError);
    expect(() => w.canDebit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('movimentação com valor zero é rejeitada (version só incrementa quando o saldo muda)', () => {
    const w = makeWallet('10.00');
    expect(() => w.credit(mv(Money.zero('BRL')))).toThrow(DomainValidationError);
    expect(w.version).toBe(1);
  });

  test('openingEntry: CREDIT do saldo inicial na versão 1; zero ⇒ sem lançamento', () => {
    const w = makeWallet('1000.00');
    const e = w.openingEntry({ entryId: uuidv7(), transactionId: uuidv7(), at: new Date() })!;
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.balanceBefore.isZero()).toBe(true);
    expect(e.balanceAfter.amount).toBe('1000.00');
    expect(e.walletVersion).toBe(1);
    expect(makeWallet('0.00').openingEntry({ entryId: uuidv7(), transactionId: uuidv7(), at: new Date() })).toBeUndefined();
  });

  test('rehydrate não revalida e preserva o estado', () => {
    const w = makeWallet('10.00');
    const copy = Wallet.rehydrate({ id: w.id, playerId: w.playerId, currency: w.currency, balance: w.balance, version: 7, createdAt: w.createdAt, updatedAt: w.updatedAt });
    expect(copy.version).toBe(7);
  });

  test('sequência de operações mantém saldo == reconstrução pelo ledger', () => {
    const w = makeWallet('100.00');
    const entries: WalletLedgerEntry[] = [];
    entries.push(w.debit(mv(brl('10.00'))), w.credit(mv(brl('2.50'))), w.debit(mv(brl('0.01'))), w.credit(mv(brl('100.00'))));
    let rebuilt = brl('100.00');
    for (const e of entries) rebuilt = e.direction === LedgerDirection.Credit ? rebuilt.add(e.money) : rebuilt.subtract(e.money);
    expect(rebuilt.equals(w.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([2, 3, 4, 5]);
  });
});

describe('WalletLedgerEntry — imutabilidade e aritmética', () => {
  const base = () => ({
    id: uuidv7(), walletId: uuidv7(), transactionId: uuidv7(), walletVersion: 2, direction: LedgerDirection.Debit,
    money: brl('10.00'), balanceBefore: brl('100.00'), balanceAfter: brl('90.00'), createdAt: new Date(),
  });

  test('create valida a aritmética (before − money === after)', () => {
    expect(WalletLedgerEntry.create(base()).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base(), balanceAfter: brl('91.00') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base(), direction: LedgerDirection.Credit })).toThrow(InvariantViolationError);
  });

  test('create rejeita valor não positivo e saldos negativos', () => {
    expect(() => WalletLedgerEntry.create({ ...base(), money: Money.zero('BRL'), balanceAfter: brl('100.00') })).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base(), balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('10.00')) })).toThrow(InvariantViolationError);
  });

  test('instância é estruturalmente imutável (congelada)', () => {
    const e = WalletLedgerEntry.create(base());
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { id: string }).id = 'x';
    }).toThrow();
  });

  test('rehydrate não revalida (estado já persistido)', () => {
    const e = WalletLedgerEntry.rehydrate({ ...base(), balanceAfter: brl('1.00') });
    expect(e.isBalanced()).toBe(false);
  });
});
