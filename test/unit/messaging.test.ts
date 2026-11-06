import { describe, expect, test } from 'bun:test';
import { canonicalHash, canonicalJson } from '@/domain/shared/hash';
import { InvalidTransactionStateError } from '@/domain/shared/errors';
import { isUuid, uuidv7 } from '@/domain/shared/uuid';
import { InboxMessage } from '@/domain/messaging/inbox-message';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference } from '@/domain/messaging/events/events';
import { FailureCode } from '@/domain/wagering/failure-code';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { settle } from '@/domain/wagering/settlement';
import { WagerTransactionKind as K } from '@/domain/wagering/wager-transaction';
import { makeTx, makeWallet, brl } from '@test/support/factories';

describe('JSON canônico e hash', () => {
  test('ordem das chaves não importa (em qualquer nível)', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [3, 1, 2] } })).toBe('{"a":{"c":[3,1,2],"d":1},"b":1}');
    expect(canonicalHash({ a: 1, b: { x: 1, y: 2 } })).toBe(canonicalHash({ b: { y: 2, x: 1 }, a: 1 }));
  });
  test('undefined é omitido em objetos; arrays preservam ordem; valores distintos ⇒ hashes distintos', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
    expect(canonicalHash({ a: '1' })).not.toBe(canonicalHash({ a: 1 }));
  });
  test('uuidv7: formato válido, versão 7 e ordenável por tempo', () => {
    const a = uuidv7(1_000), b = uuidv7(2_000);
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

describe('Eventos de integração', () => {
  const ctx = { correlationId: 'corr-1', causationId: 'cause-1', occurredAt: new Date('2026-07-29T15:00:00.000Z') };

  test('WalletBalanceChanged: envelope versionável, dinheiro como string decimal e eventType/version no tipo', () => {
    const w = makeWallet('100.00');
    const tx = makeTx(w, K.Bet, '25.00');
    const r = settle({ tx, wallet: w, reference: undefined, referenceAlreadyReversed: false, now: ctx.occurredAt, newEntryId: uuidv7 });
    if (r.outcome !== 'PROCESSED' || !r.entry) throw new Error('esperava lançamento');
    const ev = WalletBalanceChanged.from(w, r.entry, ctx);
    const json = JSON.parse(JSON.stringify(ev));
    expect(ev.eventType).toBe('WalletBalanceChanged');
    expect(ev.version).toBe(1);
    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged', version: 1, aggregateId: w.id, correlationId: 'corr-1', causationId: 'cause-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: { walletId: w.id, direction: 'DEBIT', money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' }, walletVersion: 2 },
    });
    expect(isUuid(json.eventId)).toBe(true);
    expect(typeof json.data.money.amount).toBe('string');
  });

  test('WagerTransactionProcessed (inclui LOSS), Rejected e PendingReference', () => {
    const w = makeWallet('100.00');
    const loss = makeTx(w, K.Loss, '5.00');
    settle({ tx: loss, wallet: w, reference: undefined, referenceAlreadyReversed: false, now: ctx.occurredAt, newEntryId: uuidv7 });
    const processed = WagerTransactionProcessed.from(loss, ctx).toJSON();
    expect(processed.eventType).toBe('WagerTransactionProcessed');
    expect(processed.data).toMatchObject({ kind: 'LOSS', balanceChanged: false, balance: { amount: '100.00', currency: 'BRL' } });

    const bet = makeTx(w, K.Bet, '500.00');
    settle({ tx: bet, wallet: w, reference: undefined, referenceAlreadyReversed: false, now: ctx.occurredAt, newEntryId: uuidv7 });
    const rejected = WagerTransactionRejected.from(bet, ctx).toJSON();
    expect(rejected.data).toMatchObject({ failureCode: FailureCode.InsufficientFunds, kind: 'BET' });

    const refund = makeTx(w, K.Refund, '1.00', { reference: 'bet-x' });
    refund.markPendingReference(ctx.occurredAt, new PendingReferencePolicy(), w.balance);
    const pending = WagerTransactionPendingReference.from(refund, ctx).toJSON();
    expect(pending.data).toMatchObject({ referenceExternalTransactionId: 'bet-x', kind: 'REFUND' });
    expect(pending.data.nextAttemptAt).toBe('2026-07-29T15:00:01.000Z');
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const w = makeWallet('10.00');
    const tx = makeTx(w, K.Loss, '1.00');
    settle({ tx, wallet: w, reference: undefined, referenceAlreadyReversed: false, now: new Date(), newEntryId: uuidv7 });
    return WagerTransactionProcessed.from(tx, { correlationId: 'c', occurredAt: new Date('2026-01-01T00:00:00Z') });
  };

  test('enqueue: pendente, devida imediatamente, id = eventId, payload = envelope', () => {
    const ev = event();
    const m = OutboxMessage.enqueue(ev);
    expect(m.id).toBe(ev.eventId);
    expect(m.aggregateId).toBe(ev.aggregateId);
    expect(m.payload).toEqual(JSON.parse(JSON.stringify(ev)));
    expect(m.isPending()).toBe(true);
    expect(m.isDue(new Date('2026-01-01T00:00:00Z'))).toBe(true);
    expect(m.attempts).toBe(0);
  });

  test('scheduleRetry: backoff exponencial (jitter neutro), cap de 5 min, attempts incrementa', () => {
    const m = OutboxMessage.enqueue(event());
    const now = new Date('2026-01-01T00:00:00Z');
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      m.scheduleRetry(now, () => 0.5);
      delays.push(m.nextAttemptAt!.getTime() - now.getTime());
    }
    expect(m.attempts).toBe(12);
    expect(delays.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...delays)).toBe(300_000);
    expect(m.isDue(now)).toBe(false);
    expect(m.isDue(new Date(now.getTime() + 300_001))).toBe(true);
  });

  test('jitter fica em ±20%', () => {
    const m = OutboxMessage.enqueue(event());
    const now = new Date();
    m.scheduleRetry(now, () => 0);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(800);
    const m2 = OutboxMessage.enqueue(event());
    m2.scheduleRetry(now, () => 0.999999);
    expect(m2.nextAttemptAt!.getTime() - now.getTime()).toBeLessThanOrEqual(1200);
  });

  test('markPublished: deixa de ser pendente e devida', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(new Date());
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date())).toBe(false);
    expect(m.publishedAt).toBeInstanceOf(Date);
  });
});

describe('InboxMessage', () => {
  test('receive → markProcessed uma única vez', () => {
    const msg = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'c', payloadHash: 'h', receivedAt: new Date() });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(new Date());
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(new Date())).toThrow(InvalidTransactionStateError);
  });
});
