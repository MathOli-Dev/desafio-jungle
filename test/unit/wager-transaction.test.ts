import { describe, expect, test } from 'bun:test';
import { DomainValidationError, InvalidTransactionStateError, InvariantViolationError } from '@/domain/shared/errors';
import { uuidv7 } from '@/domain/shared/uuid';
import { FailureCode } from '@/domain/wagering/failure-code';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '@/domain/wagering/wager-transaction';
import { LedgerDirection } from '@/domain/wallet/wallet-ledger-entry';
import { brl, makeTx, makeWallet, processed } from '@test/support/factories';

const w = makeWallet('100.00');
const now = new Date('2026-07-29T15:00:00.000Z');

describe('WagerTransaction.create — validações', () => {
  test('nasce em PENDING', () => {
    const tx = makeTx(w, K.Bet, '10.00');
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING é interno: não pode ser submetido', () => {
    expect(() => makeTx(w, K.Opening, '10.00')).toThrow(DomainValidationError);
  });

  test('providerId reservado "internal" é rejeitado', () => {
    expect(() => makeTx(w, K.Bet, '1.00', { providerId: 'internal' })).toThrow(DomainValidationError);
  });

  test('REFUND e ROLLBACK exigem referenceExternalTransactionId', () => {
    expect(() => makeTx(w, K.Refund, '1.00')).toThrow(DomainValidationError);
    expect(() => makeTx(w, K.Rollback, '1.00')).toThrow(DomainValidationError);
    expect(makeTx(w, K.Refund, '1.00', { reference: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('BET não pode referenciar; WIN/LOSS podem (opcional); auto-referência é rejeitada', () => {
    expect(() => makeTx(w, K.Bet, '1.00', { reference: 'x' })).toThrow(DomainValidationError);
    expect(makeTx(w, K.Win, '1.00', { reference: 'bet-1' }).referenceExternalTransactionId).toBe('bet-1');
    expect(makeTx(w, K.Win, '1.00').referenceExternalTransactionId).toBeUndefined();
    expect(() => makeTx(w, K.Refund, '1.00', { externalTransactionId: 'same', reference: 'same' })).toThrow(DomainValidationError);
  });

  test('valor zero só é aceito em LOSS', () => {
    for (const k of [K.Bet, K.Win]) expect(() => makeTx(w, k, '0.00')).toThrow(DomainValidationError);
    expect(makeTx(w, K.Loss, '0.00').affectsBalance()).toBe(false);
  });

  test('affectsBalance: false só para LOSS', () => {
    const needsRef = (k: K) => (k === K.Refund || k === K.Rollback ? { reference: 'r' } : {});
    expect([K.Bet, K.Win, K.Refund, K.Rollback].every((k) => makeTx(w, k, '1.00', needsRef(k)).affectsBalance())).toBe(true);
    expect(makeTx(w, K.Loss, '1.00').affectsBalance()).toBe(false);
  });

  test('transação OPENING interna usa provider reservado e creditar', () => {
    const t = WagerTransaction.opening({ id: uuidv7(), walletId: w.id, playerId: w.playerId, money: brl('10.00'), createdAt: now });
    expect(t.providerId).toBe('internal');
    expect(t.kind).toBe(K.Opening);
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction — máquina de estados', () => {
  test('PENDING → PROCESSED', () => {
    const tx = makeTx(w, K.Bet, '10.00');
    tx.markProcessed(now, brl('90.00'));
    expect(tx.status).toBe(S.Processed);
    expect(tx.processedAt).toEqual(now);
    expect(tx.balanceObserved?.amount).toBe('90.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED guarda failureCode', () => {
    const tx = makeTx(w, K.Bet, '10.00');
    tx.reject(FailureCode.InsufficientFunds, { balanceObserved: brl('5.00') });
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → FAILED', () => {
    const tx = makeTx(w, K.Bet, '10.00');
    tx.fail(FailureCode.InfrastructureFailure);
    expect(tx.status).toBe(S.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED | REJECTED | FAILED', () => {
    const policy = new PendingReferencePolicy();
    for (const finish of [
      (t: WagerTransaction) => t.markProcessed(now, brl('1.00')),
      (t: WagerTransaction) => t.reject(FailureCode.ReferenceNotFound),
      (t: WagerTransaction) => t.fail(FailureCode.InfrastructureFailure),
    ]) {
      const tx = makeTx(w, K.Refund, '10.00', { reference: 'bet-x' });
      tx.markPendingReference(now, policy, brl('100.00'));
      expect(tx.status).toBe(S.PendingReference);
      expect(tx.nextReferenceCheckAt).toEqual(new Date(now.getTime() + 1_000));
      finish(tx);
      expect(tx.isTerminal()).toBe(true);
    }
  });

  test('estados terminais não transicionam: qualquer tentativa é erro de programação', () => {
    const policy = new PendingReferencePolicy();
    const terminals: WagerTransaction[] = [];
    const a = makeTx(w, K.Bet, '1.00'); a.markProcessed(now, brl('1.00')); terminals.push(a);
    const b = makeTx(w, K.Bet, '1.00'); b.reject(FailureCode.InsufficientFunds); terminals.push(b);
    const c = makeTx(w, K.Bet, '1.00'); c.fail(FailureCode.InfrastructureFailure); terminals.push(c);
    for (const t of terminals) {
      expect(() => t.markProcessed(now, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
      expect(() => t.markPendingReference(now, policy, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => t.scheduleReferenceRetry(now, policy)).toThrow(InvalidTransactionStateError);
    }
  });

  test('markPendingReference só a partir de PENDING; scheduleReferenceRetry só em PENDING_REFERENCE', () => {
    const policy = new PendingReferencePolicy();
    const tx = makeTx(w, K.Refund, '1.00', { reference: 'r' });
    expect(() => tx.scheduleReferenceRetry(now, policy)).toThrow(InvalidTransactionStateError);
    tx.markPendingReference(now, policy, brl('1.00'));
    expect(() => tx.markPendingReference(now, policy, brl('1.00'))).toThrow(InvalidTransactionStateError);
  });

  test('backoff exponencial de referência: 1s, 2s, 4s... limitado por maxDelay; esgota por tentativas', () => {
    const policy = new PendingReferencePolicy(5, 3_600_000, 1_000, 4_000);
    const tx = makeTx(w, K.Refund, '1.00', { reference: 'r' });
    tx.markPendingReference(now, policy, brl('1.00'));
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect(tx.scheduleReferenceRetry(now, policy)).toBe('RESCHEDULED');
      delays.push(tx.nextReferenceCheckAt!.getTime() - now.getTime());
    }
    expect(delays).toEqual([2_000, 4_000, 4_000]);
    expect(tx.referenceAttempts).toBe(3);
    expect(tx.scheduleReferenceRetry(now, policy)).toBe('RESCHEDULED'); // tentativa 4
    expect(tx.scheduleReferenceRetry(now, policy)).toBe('EXHAUSTED'); // 5 atingiu o limite
    expect(tx.status).toBe(S.PendingReference); // o chamador é quem rejeita
  });

  test('esgota por TTL mesmo com tentativas sobrando', () => {
    const policy = new PendingReferencePolicy(100, 10_000, 1_000, 60_000);
    const tx = makeTx(w, K.Refund, '1.00', { reference: 'r' });
    tx.markPendingReference(tx.createdAt, policy, brl('1.00'));
    expect(tx.scheduleReferenceRetry(new Date(tx.createdAt.getTime() + 9_000), policy)).toBe('RESCHEDULED');
    expect(tx.scheduleReferenceRetry(new Date(tx.createdAt.getTime() + 10_001), policy)).toBe('EXHAUSTED');
  });
});

describe('WagerTransaction — direção do ledger', () => {
  test('BET debita; WIN e REFUND creditam', () => {
    expect(makeTx(w, K.Bet, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(makeTx(w, K.Win, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(makeTx(w, K.Refund, '1.00', { reference: 'r' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK é o inverso da referência', () => {
    const rb = makeTx(w, K.Rollback, '1.00', { reference: 'r' });
    expect(rb.ledgerDirectionFor(makeTx(w, K.Bet, '1.00'))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(makeTx(w, K.Win, '1.00'))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(makeTx(w, K.Refund, '1.00', { reference: 'x' }))).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test('LOSS não produz lançamento', () => {
    expect(() => makeTx(w, K.Loss, '1.00').ledgerDirectionFor()).toThrow(InvariantViolationError);
  });
});

describe('WagerTransaction — hash de payload e idempotência', () => {
  const same = { providerId: 'provider-a', externalTransactionId: 'transaction-123', playerId: 'p', walletId: w.id, roundId: 'round-987', gameId: 'fortune-chimp' };
  const mk = (o: Partial<{ amount: string; idem: string; gameId: string; reference: string }> = {}) =>
    WagerTransaction.create({
      id: uuidv7(), ...same, gameId: o.gameId ?? same.gameId, idempotencyKey: o.idem ?? 'provider-a:transaction-123',
      kind: K.Bet, money: brl(o.amount ?? '25.00'), createdAt: now,
    });

  test('hash é determinístico, hex de 64 chars, e NÃO depende da Idempotency-Key (header)', () => {
    const a = mk();
    const b = mk({ idem: 'outra-chave-qualquer' });
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.matchesPayload(b.payloadHash)).toBe(true);
  });

  test('"25" e "25.00" produzem o mesmo hash (valores normalizados)', () => {
    expect(mk({ amount: '25' }).payloadHash).toBe(mk({ amount: '25.00' }).payloadHash);
  });

  test('mesma key com payload diferente ⇒ hash diferente (conflito, não replay)', () => {
    const original = mk();
    expect(original.matchesPayload(mk({ amount: '25.01' }).payloadHash)).toBe(false);
    expect(original.matchesPayload(mk({ gameId: 'other-game' }).payloadHash)).toBe(false);
  });

  test('o hash cobre todos os campos de negócio', () => {
    const base = { providerId: 'p', externalTransactionId: 'e', playerId: 'pl', walletId: 'w', roundId: 'r', gameId: 'g', kind: K.Bet, money: { amount: '1.00', currency: 'BRL' } };
    const h = WagerTransaction.computePayloadHash(base);
    const variants = [
      { ...base, providerId: 'p2' }, { ...base, externalTransactionId: 'e2' }, { ...base, playerId: 'x' },
      { ...base, walletId: 'x' }, { ...base, roundId: 'x' }, { ...base, gameId: 'x' }, { ...base, kind: K.Win },
      { ...base, money: { amount: '1.01', currency: 'BRL' } }, { ...base, money: { amount: '1.00', currency: 'USD' } },
      { ...base, referenceExternalTransactionId: 'ref' },
    ];
    for (const v of variants) expect(WagerTransaction.computePayloadHash(v)).not.toBe(h);
  });
});
