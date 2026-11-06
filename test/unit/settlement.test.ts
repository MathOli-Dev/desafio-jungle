import { describe, expect, test } from 'bun:test';
import { uuidv7 } from '@/domain/shared/uuid';
import { FailureCode } from '@/domain/wagering/failure-code';
import { settle, SettlementResult } from '@/domain/wagering/settlement';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '@/domain/wagering/wager-transaction';
import { Wallet } from '@/domain/wallet/wallet';
import { LedgerDirection } from '@/domain/wallet/wallet-ledger-entry';
import { makeTx, makeWallet, processed, rehydrateWithStatus, TxOverrides } from '@test/support/factories';

const run = (
  tx: WagerTransaction,
  wallet: Wallet,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
): SettlementResult => settle({ tx, wallet, reference, referenceAlreadyReversed, now: new Date(), newEntryId: uuidv7 });

describe('BET', () => {
  test('debita e gera 1 lançamento DEBIT', () => {
    const w = makeWallet('100.00');
    const tx = makeTx(w, K.Bet, '25.00');
    const r = run(tx, w);
    expect(r.outcome).toBe('PROCESSED');
    expect(w.balance.amount).toBe('75.00');
    expect(tx.status).toBe(S.Processed);
    expect(tx.balanceObserved?.amount).toBe('75.00');
    expect(r.outcome === 'PROCESSED' && r.entry?.direction).toBe(LedgerDirection.Debit);
  });

  test('saldo insuficiente ⇒ REJECTED/INSUFFICIENT_FUNDS, sem lançamento e sem alterar saldo/versão', () => {
    const w = makeWallet('10.00');
    const tx = makeTx(w, K.Bet, '10.01');
    const r = run(tx, w);
    expect(r).toEqual({ outcome: 'REJECTED', code: FailureCode.InsufficientFunds });
    expect(tx.status).toBe(S.Rejected);
    expect(tx.balanceObserved?.amount).toBe('10.00');
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('cenário obrigatório (modelo): saldo 100, duas apostas de 80 ⇒ uma PROCESSED, outra REJECTED, saldo 20, 1 débito', () => {
    const w = makeWallet('100.00');
    const [a, b] = [makeTx(w, K.Bet, '80.00'), makeTx(w, K.Bet, '80.00')];
    const results = [run(a, w), run(b, w)];
    expect(results.filter((r) => r.outcome === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'REJECTED')).toHaveLength(1);
    expect(w.balance.amount).toBe('20.00');
    expect(results.flatMap((r) => (r.outcome === 'PROCESSED' && r.entry ? [r.entry] : []))).toHaveLength(1);
  });

  test('moeda diferente da wallet ⇒ REJECTED/CURRENCY_MISMATCH', () => {
    const w = makeWallet('100.00');
    const tx = makeTx(w, K.Bet, '1.00', { currency: 'USD' });
    expect(run(tx, w)).toEqual({ outcome: 'REJECTED', code: FailureCode.CurrencyMismatch });
    expect(w.balance.amount).toBe('100.00');
  });

  test('playerId diferente do dono ⇒ REJECTED/PLAYER_WALLET_MISMATCH', () => {
    const w = makeWallet('100.00');
    const tx = makeTx(w, K.Bet, '1.00', { playerId: 'intruso' });
    expect(run(tx, w)).toEqual({ outcome: 'REJECTED', code: FailureCode.PlayerWalletMismatch });
  });
});

describe('WIN e LOSS', () => {
  test('WIN credita e gera 1 lançamento CREDIT', () => {
    const w = makeWallet('10.00');
    const tx = makeTx(w, K.Win, '40.00');
    const r = run(tx, w);
    expect(w.balance.amount).toBe('50.00');
    expect(r.outcome === 'PROCESSED' && r.entry?.direction).toBe(LedgerDirection.Credit);
  });

  test('WIN referenciando a BET da mesma rodada (PROCESSED) é aplicado e liga a referência', () => {
    const w = makeWallet('100.00');
    const bet = makeTx(w, K.Bet, '10.00', { externalTransactionId: 'bet-1' });
    run(bet, w);
    const win = makeTx(w, K.Win, '30.00', { reference: 'bet-1' });
    expect(run(win, w, bet).outcome).toBe('PROCESSED');
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.amount).toBe('120.00');
  });

  test('WIN referenciando BET de OUTRA rodada ⇒ REFERENCE_MISMATCH', () => {
    const w = makeWallet('100.00');
    const bet = makeTx(w, K.Bet, '10.00', { externalTransactionId: 'bet-1', roundId: 'round-A' });
    run(bet, w);
    const win = makeTx(w, K.Win, '30.00', { reference: 'bet-1', roundId: 'round-B' });
    expect(run(win, w, bet)).toEqual({ outcome: 'REJECTED', code: FailureCode.ReferenceMismatch });
  });

  test('WIN referenciando uma transação que não é BET ⇒ INVALID_REFERENCE_KIND', () => {
    const w = makeWallet('100.00');
    const other = makeTx(w, K.Win, '10.00', { externalTransactionId: 'w-1' });
    run(other, w);
    const win = makeTx(w, K.Win, '5.00', { reference: 'w-1' });
    expect(run(win, w, other)).toEqual({ outcome: 'REJECTED', code: FailureCode.InvalidReferenceKind });
  });

  test('LOSS registra o resultado sem mover saldo, sem lançamento e sem incrementar a versão', () => {
    const w = makeWallet('100.00');
    const tx = makeTx(w, K.Loss, '10.00');
    const r = run(tx, w);
    expect(r).toEqual({ outcome: 'PROCESSED' });
    expect(tx.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
    expect(tx.balanceObserved?.amount).toBe('100.00');
  });
});

describe('REFUND', () => {
  const setup = () => {
    const w = makeWallet('100.00');
    const bet = makeTx(w, K.Bet, '30.00', { externalTransactionId: 'bet-1' });
    run(bet, w);
    return { w, bet };
  };

  test('reverte uma BET PROCESSED creditando o valor', () => {
    const { w, bet } = setup();
    const refund = makeTx(w, K.Refund, '30.00', { reference: 'bet-1' });
    const r = run(refund, w, bet);
    expect(r.outcome).toBe('PROCESSED');
    expect(w.balance.amount).toBe('100.00');
    expect(r.outcome === 'PROCESSED' && r.entry?.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('só uma vez: referência já revertida ⇒ ALREADY_REVERSED', () => {
    const { w, bet } = setup();
    const again = makeTx(w, K.Refund, '30.00', { reference: 'bet-1' });
    expect(run(again, w, bet, true)).toEqual({ outcome: 'REJECTED', code: FailureCode.AlreadyReversed });
    expect(w.balance.amount).toBe('70.00');
  });

  test('valor diferente da referência ⇒ REFERENCE_AMOUNT_MISMATCH (reversão parcial fora de escopo)', () => {
    const { w, bet } = setup();
    const refund = makeTx(w, K.Refund, '10.00', { reference: 'bet-1' });
    expect(run(refund, w, bet)).toEqual({ outcome: 'REJECTED', code: FailureCode.ReferenceAmountMismatch });
  });

  test('REFUND só referencia BET ⇒ referência WIN gera INVALID_REFERENCE_KIND', () => {
    const { w } = setup();
    const win = makeTx(w, K.Win, '30.00', { externalTransactionId: 'win-1' });
    run(win, w);
    const refund = makeTx(w, K.Refund, '30.00', { reference: 'win-1' });
    expect(run(refund, w, win)).toEqual({ outcome: 'REJECTED', code: FailureCode.InvalidReferenceKind });
  });

  test('referência de outro player/wallet/moeda/rodada ⇒ REFERENCE_MISMATCH', () => {
    const { w, bet } = setup();
    const other: TxOverrides[] = [{ roundId: 'round-2' }];
    for (const o of other) {
      const refund = makeTx(w, K.Refund, '30.00', { reference: 'bet-1', ...o });
      expect(run(refund, w, bet)).toEqual({ outcome: 'REJECTED', code: FailureCode.ReferenceMismatch });
    }
    const otherProvider = makeTx(w, K.Refund, '30.00', { reference: 'bet-1', providerId: 'provider-b' });
    expect(run(otherProvider, w, bet)).toEqual({ outcome: 'REJECTED', code: FailureCode.ReferenceMismatch });
  });

  test('referência REJECTED ⇒ REFERENCE_NOT_PROCESSED (não há o que reverter)', () => {
    const w = makeWallet('5.00');
    const bet = makeTx(w, K.Bet, '30.00', { externalTransactionId: 'bet-1' });
    run(bet, w); // rejeitada por saldo
    expect(bet.status).toBe(S.Rejected);
    const refund = makeTx(w, K.Refund, '30.00', { reference: 'bet-1' });
    expect(run(refund, w, bet)).toEqual({ outcome: 'REJECTED', code: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('reverter BET credita (inverso do débito)', () => {
    const w = makeWallet('100.00');
    const bet = makeTx(w, K.Bet, '30.00', { externalTransactionId: 'bet-1' });
    run(bet, w);
    const rb = makeTx(w, K.Rollback, '30.00', { reference: 'bet-1' });
    const r = run(rb, w, bet);
    expect(w.balance.amount).toBe('100.00');
    expect(r.outcome === 'PROCESSED' && r.entry?.direction).toBe(LedgerDirection.Credit);
  });

  test('reverter WIN debita (inverso do crédito)', () => {
    const w = makeWallet('100.00');
    const win = makeTx(w, K.Win, '50.00', { externalTransactionId: 'win-1' });
    run(win, w);
    const rb = makeTx(w, K.Rollback, '50.00', { reference: 'win-1' });
    const r = run(rb, w, win);
    expect(w.balance.amount).toBe('100.00');
    expect(r.outcome === 'PROCESSED' && r.entry?.direction).toBe(LedgerDirection.Debit);
  });

  test('reverter REFUND debita', () => {
    const w = makeWallet('100.00');
    const bet = makeTx(w, K.Bet, '20.00', { externalTransactionId: 'bet-1' });
    run(bet, w);
    const refund = makeTx(w, K.Refund, '20.00', { externalTransactionId: 'rf-1', reference: 'bet-1' });
    run(refund, w, bet);
    const rb = makeTx(w, K.Rollback, '20.00', { reference: 'rf-1' });
    run(rb, w, refund);
    expect(w.balance.amount).toBe('80.00');
  });

  test('reversão que produziria saldo negativo ⇒ REVERSAL_WOULD_OVERDRAW (distinto de INSUFFICIENT_FUNDS)', () => {
    const w = makeWallet('0.00');
    const win = makeTx(w, K.Win, '50.00', { externalTransactionId: 'win-1' });
    run(win, w);
    const bet = makeTx(w, K.Bet, '40.00');
    run(bet, w); // o jogador gastou o prêmio: saldo 10
    const rb = makeTx(w, K.Rollback, '50.00', { reference: 'win-1' });
    const r = run(rb, w, win);
    expect(r).toEqual({ outcome: 'REJECTED', code: FailureCode.ReversalWouldOverdraw });
    expect(r.outcome === 'REJECTED' && r.code).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe('10.00');
    expect(rb.status).toBe(S.Rejected);
  });

  test('ROLLBACK de LOSS ou de ROLLBACK ⇒ INVALID_REFERENCE_KIND', () => {
    const w = makeWallet('100.00');
    const loss = makeTx(w, K.Loss, '10.00', { externalTransactionId: 'loss-1' });
    run(loss, w);
    expect(run(makeTx(w, K.Rollback, '10.00', { reference: 'loss-1' }), w, loss)).toEqual({ outcome: 'REJECTED', code: FailureCode.InvalidReferenceKind });
  });

  test('ROLLBACK já aplicado à referência ⇒ ALREADY_REVERSED (REFUND+ROLLBACK não creditam duas vezes)', () => {
    const w = makeWallet('100.00');
    const bet = makeTx(w, K.Bet, '10.00', { externalTransactionId: 'bet-1' });
    run(bet, w);
    const rb = makeTx(w, K.Rollback, '10.00', { reference: 'bet-1' });
    expect(run(rb, w, bet, true)).toEqual({ outcome: 'REJECTED', code: FailureCode.AlreadyReversed });
  });
});

describe('referências fora de ordem', () => {
  test('referência ausente ⇒ PENDING_REFERENCE sem mutar a transação nem a wallet', () => {
    const w = makeWallet('100.00');
    const refund = makeTx(w, K.Refund, '10.00', { reference: 'bet-ainda-nao-chegou' });
    expect(run(refund, w, undefined)).toEqual({ outcome: 'PENDING_REFERENCE', reason: 'REFERENCE_MISSING' });
    expect(refund.status).toBe(S.Pending);
    expect(w.version).toBe(1);
  });

  test('referência existente porém ainda pendente ⇒ dependente também espera', () => {
    const w = makeWallet('100.00');
    const win = makeTx(w, K.Win, '10.00', { externalTransactionId: 'win-1', reference: 'bet-1' });
    const pendingWin = rehydrateWithStatus(win, S.PendingReference);
    const rb = makeTx(w, K.Rollback, '10.00', { reference: 'win-1' });
    expect(run(rb, w, pendingWin)).toEqual({ outcome: 'PENDING_REFERENCE', reason: 'REFERENCE_UNRESOLVED' });
  });

  test('re-execução depois que a referência chegou aplica normalmente', () => {
    const w = makeWallet('100.00');
    const refund = makeTx(w, K.Refund, '10.00', { reference: 'bet-1' });
    expect(run(refund, w, undefined).outcome).toBe('PENDING_REFERENCE');
    const bet = makeTx(w, K.Bet, '10.00', { externalTransactionId: 'bet-1' });
    run(bet, w);
    expect(run(refund, w, bet).outcome).toBe('PROCESSED');
    expect(w.balance.amount).toBe('100.00');
  });
});

describe('invariante global', () => {
  test('sequência arbitrária: saldo nunca negativo e igual à reconstrução pelo ledger', () => {
    const w = makeWallet('50.00');
    const entries = [];
    const bets: WagerTransaction[] = [];
    for (let i = 0; i < 40; i++) {
      const tx = makeTx(w, i % 3 === 0 ? K.Win : K.Bet, i % 3 === 0 ? '7.00' : '9.00', { externalTransactionId: `x-${i}` });
      const r = run(tx, w);
      if (r.outcome === 'PROCESSED' && r.entry) entries.push(r.entry);
      if (tx.kind === K.Bet && tx.status === S.Processed) bets.push(tx);
      expect(w.balance.isNegative()).toBe(false);
    }
    let rebuilt = makeWallet('50.00').balance;
    for (const e of entries) rebuilt = e.direction === LedgerDirection.Credit ? rebuilt.add(e.money) : rebuilt.subtract(e.money);
    expect(rebuilt.equals(w.balance)).toBe(true);
    expect(bets.length).toBeGreaterThan(0);
  });
});
