import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Failpoints } from '@/application/failpoints';
import { InboxPayloadMismatchError } from '@/application/errors';
import { FailureCode } from '@/domain/wagering/failure-code';
import { PendingReferencePolicy } from '@/domain/wagering/pending-reference-policy';
import { WagerTransactionStatus as Status } from '@/domain/wagering/wager-transaction';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from '@/domain/shared/errors';
import { uuidv7 } from '@/domain/shared/uuid';
import { createOrm, Orm } from '@/infrastructure/persistence/orm';
import { createMigratedOrm, createTestDatabase, TestDatabase, withPg } from '@test/support/infra';
import { assertLedgerInvariant, buildHarness, cmd, count, ctx, Harness, ManualClock, newWallet } from '@test/support/harness';

let db: TestDatabase;
let orm: Orm;
let h: Harness;

beforeAll(async () => {
  db = await createTestDatabase('wager_uc');
  orm = await createMigratedOrm(db.url);
  h = buildHarness(orm);
});
afterAll(async () => {
  await assertLedgerInvariant(db.url); // invariante final: balance == ledger para TODAS as wallets do arquivo
  await orm.close(true);
  await db.drop();
});

const balanceOf = async (id: string) => (await h.walletQueries.getWallet(id)).balance.amount;

describe('criação de wallet', () => {
  test('saldo inicial > 0 gera OPENING + CREDIT no ledger + eventos, na mesma transação; version = 1', async () => {
    const w = await h.createWallet.execute({ playerId: 'p-open', initialBalance: { amount: '1000.00', currency: 'BRL' } }, { correlationId: 'c1' });
    expect(w).toMatchObject({ playerId: 'p-open', balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const ledger = await h.walletQueries.listLedger(w.id, undefined, 50);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({ direction: 'CREDIT', walletVersion: 1, balanceBefore: { amount: '0.00' }, balanceAfter: { amount: '1000.00' } });
    const tx = await h.txQueries.getById(ledger.items[0]!.transactionId);
    expect(tx).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', providerId: 'internal' });
    const events = await withPg(db.url, (c) => c.query(`SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq`, [w.id]));
    expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await assertLedgerInvariant(db.url, w.id);
  });

  test('saldo inicial zero: sem OPENING, sem lançamento, sem eventos', async () => {
    const w = await h.createWallet.execute({ playerId: 'p-zero', initialBalance: { amount: '0.00', currency: 'BRL' } }, { correlationId: 'c' });
    expect(w.version).toBe(1);
    expect((await h.walletQueries.listLedger(w.id, undefined, 10)).items).toHaveLength(0);
    expect(await count(db.url, `SELECT 1 FROM outbox_messages WHERE aggregate_id = '${w.id}'`)).toBe(0);
  });

  test('wallet duplicada (mesmo playerId + moeda) é conflito; outra moeda é permitida', async () => {
    await h.createWallet.execute({ playerId: 'p-dup', initialBalance: { amount: '1.00', currency: 'BRL' } }, { correlationId: 'c' });
    await expect(h.createWallet.execute({ playerId: 'p-dup', initialBalance: { amount: '5.00', currency: 'BRL' } }, { correlationId: 'c' })).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    await h.createWallet.execute({ playerId: 'p-dup', initialBalance: { amount: '1.00', currency: 'USD' } }, { correlationId: 'c' });
  });

  test('criações concorrentes da mesma wallet: exatamente uma vence', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => h.createWallet.execute({ playerId: 'p-race', initialBalance: { amount: '10.00', currency: 'BRL' } }, { correlationId: 'c' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof WalletAlreadyExistsError)).toHaveLength(7);
  });
});

describe('BET / WIN / LOSS e idempotência persistente', () => {
  test('BET debita; replay devolve o resultado original (inclusive o saldo observado) com idempotentReplay=true', async () => {
    const w = await newWallet(h, '1000.00');
    const bet = cmd(w, 'BET', '25.00');
    const first = await h.submit.execute(bet, ctx());
    expect(first).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    await h.submit.execute(cmd(w, 'WIN', '100.00'), ctx()); // o saldo muda depois...
    const replay = await h.submit.execute(bet, ctx());
    expect(replay).toEqual({ ...first, idempotentReplay: true }); // ...mas o replay devolve o saldo DAQUELE momento
    expect(await balanceOf(w.id)).toBe('1075.00');
    expect(await count(db.url, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
  });

  test('mesma Idempotency-Key com payload diferente é CONFLITO (não replay) e não altera nada', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '10.00');
    await h.submit.execute(bet, ctx());
    await expect(h.submit.execute({ ...bet, money: { amount: '10.01', currency: 'BRL' } }, ctx())).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(h.submit.execute({ ...bet, gameId: 'outro-jogo' }, ctx())).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(w.id)).toBe('90.00');
  });

  test('mesmo externalTransactionId com outra key: payload igual ⇒ replay; payload diferente ⇒ conflito', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '10.00');
    const first = await h.submit.execute(bet, ctx());
    const again = await h.submit.execute({ ...bet, idempotencyKey: 'outra-chave' }, ctx());
    expect(again).toMatchObject({ transactionId: first.transactionId, idempotentReplay: true });
    await expect(h.submit.execute({ ...bet, idempotencyKey: 'outra-chave-2', money: { amount: '11.00', currency: 'BRL' } }, ctx())).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(w.id)).toBe('90.00');
  });

  test('idempotência é persistente: uma "nova instância" (novo ORM/pool) enxerga o registro', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '10.00');
    const first = await h.submit.execute(bet, ctx());
    const orm2 = await createOrm({ ...(await import('@test/support/infra')).testDbConfig(db.url) });
    try {
      const replay = await buildHarness(orm2).submit.execute(bet, ctx());
      expect(replay).toEqual({ ...first, idempotentReplay: true });
    } finally {
      await orm2.close(true);
    }
  });

  test('LOSS registra sem mover saldo: sem lançamento e sem incremento de versão; emite Processed mas não BalanceChanged', async () => {
    const w = await newWallet(h, '50.00');
    const r = await h.submit.execute(cmd(w, 'LOSS', '10.00'), ctx());
    expect(r).toMatchObject({ status: 'PROCESSED', balance: { amount: '50.00' } });
    expect((await h.walletQueries.getWallet(w.id)).version).toBe(1);
    const ev = await withPg(db.url, (c) => c.query(`SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq`, [w.id]));
    expect(ev.rows.map((x) => x.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WagerTransactionProcessed']);
  });

  test('rejeição por saldo insuficiente é persistida (auditável), sem ledger, e o replay devolve a mesma rejeição', async () => {
    const w = await newWallet(h, '10.00');
    const bet = cmd(w, 'BET', '10.01');
    const r = await h.submit.execute(bet, ctx());
    expect(r).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' }, idempotentReplay: false });
    expect(await h.submit.execute(bet, ctx())).toEqual({ ...r, idempotentReplay: true });
    expect(await balanceOf(w.id)).toBe('10.00');
    expect(await count(db.url, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = '${w.id}'`)).toBe(1); // só o OPENING
    const ev = await withPg(db.url, (c) => c.query(`SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq DESC LIMIT 1`, [w.id]));
    expect(ev.rows[0].event_type).toBe('WagerTransactionRejected');
    expect(ev.rows[0].payload.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('moeda diferente / jogador diferente do dono ⇒ REJECTED auditável; wallet inexistente ⇒ WalletNotFoundError', async () => {
    const w = await newWallet(h, '10.00');
    expect(await h.submit.execute(cmd(w, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }), ctx())).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
    expect(await h.submit.execute(cmd(w, 'BET', '1.00', { playerId: 'intruso' }), ctx())).toMatchObject({ status: 'REJECTED', failureCode: 'PLAYER_WALLET_MISMATCH' });
    await expect(h.submit.execute(cmd({ id: uuidv7(), playerId: 'x' }, 'BET', '1.00'), ctx())).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe('concorrência real (várias conexões simultâneas ao PostgreSQL)', () => {
  test('CENÁRIO OBRIGATÓRIO: saldo 100.00, duas apostas de 80.00 simultâneas ⇒ 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito', async () => {
    const w = await newWallet(h, '100.00');
    const [a, b] = [cmd(w, 'BET', '80.00'), cmd(w, 'BET', '80.00')];
    const results = await Promise.all([h.submit.execute(a, ctx()), h.submit.execute(b, ctx())]);
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(w.id)).toBe('20.00');
    expect(await count(db.url, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
    // "nenhum retry duplica o débito"
    await Promise.all([h.submit.execute(a, ctx()), h.submit.execute(b, ctx()), h.submit.execute(a, ctx()), h.submit.execute(b, ctx())]);
    expect(await balanceOf(w.id)).toBe('20.00');
    expect(await count(db.url, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
    await assertLedgerInvariant(db.url, w.id);
  });

  test('a MESMA aposta enviada 50 vezes em paralelo ⇒ um único débito; 49 replays', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '25.00');
    const before = h.metrics.get('duplicate');
    const results = await Promise.all(Array.from({ length: 50 }, () => h.submit.execute(bet, ctx())));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '75.00')).toBe(true);
    expect(h.metrics.get('duplicate') - before).toBe(49);
    expect(await balanceOf(w.id)).toBe('75.00');
    expect(await count(db.url, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = '${w.id}' AND direction = 'DEBIT'`)).toBe(1);
    expect(await count(db.url, `SELECT 1 FROM wager_transactions WHERE wallet_id = '${w.id}' AND kind = 'BET'`)).toBe(1);
    await assertLedgerInvariant(db.url, w.id);
  });

  test('hot wallet: 130 apostas distintas de 1.00 sobre 100.00 ⇒ exatamente 100 PROCESSED, 30 REJECTED, saldo 0.00, nunca negativo', async () => {
    const w = await newWallet(h, '100.00');
    const results = await Promise.all(Array.from({ length: 130 }, () => h.submit.execute(cmd(w, 'BET', '1.00'), ctx())));
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(100);
    expect(results.filter((r) => r.status === 'REJECTED' && r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(30);
    expect(await balanceOf(w.id)).toBe('0.00');
    const wallet = await h.walletQueries.getWallet(w.id);
    expect(wallet.version).toBe(101); // 1 (abertura) + 100 movimentações; as rejeitadas não mexem na versão
    await assertLedgerInvariant(db.url, w.id);
  });

  test('wallets distintas processadas em paralelo não interferem entre si', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => newWallet(h, '50.00')));
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 5 }, () => h.submit.execute(cmd(w, 'BET', '10.00'), ctx()))));
    for (const w of wallets) expect(await balanceOf(w.id)).toBe('0.00');
    await assertLedgerInvariant(db.url);
  });

  test('mistura concorrente BET/WIN/LOSS na mesma wallet preserva saldo = ledger', async () => {
    const w = await newWallet(h, '100.00');
    const ops = Array.from({ length: 60 }, (_, i) => cmd(w, (['BET', 'WIN', 'LOSS'] as const)[i % 3]!, i % 3 === 1 ? '7.50' : '3.25'));
    await Promise.all(ops.map((o) => h.submit.execute(o, ctx())));
    await assertLedgerInvariant(db.url, w.id);
  });
});

describe('atomicidade (wallet + ledger + inbox + outbox na mesma transação SQL)', () => {
  test('morte/erro ANTES do commit ⇒ rollback total: nada de saldo, ledger, transação, inbox ou outbox', async () => {
    const h2 = buildHarness(orm, { failpoints: new Failpoints(true, 'submit.before-commit:throw') });
    const w = await newWallet(h, '100.00');
    const [ledgerBefore, outboxBefore] = [
      await count(db.url, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = '${w.id}'`),
      await count(db.url, `SELECT 1 FROM outbox_messages WHERE aggregate_id = '${w.id}'`),
    ];
    const inboxCtx = { source: 'sqs' as const, correlationId: 'c', inbox: { consumerName: 'consumer', messageId: 'msg-atomic', payloadHash: 'h'.repeat(64) } };
    await expect(h2.submit.execute(cmd(w, 'BET', '40.00'), inboxCtx)).rejects.toThrow('failpoint submit.before-commit');
    expect(await balanceOf(w.id)).toBe('100.00');
    expect((await h.walletQueries.getWallet(w.id)).version).toBe(1);
    expect(await count(db.url, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = '${w.id}'`)).toBe(ledgerBefore);
    expect(await count(db.url, `SELECT 1 FROM outbox_messages WHERE aggregate_id = '${w.id}'`)).toBe(outboxBefore);
    expect(await count(db.url, `SELECT 1 FROM wager_transactions WHERE wallet_id = '${w.id}' AND kind = 'BET'`)).toBe(0);
    expect(await count(db.url, `SELECT 1 FROM inbox_messages WHERE message_id = 'msg-atomic'`)).toBe(0);
  });

  test('após o commit, os efeitos aparecem JUNTOS: transação, lançamento, saldo, inbox e eventos', async () => {
    const w = await newWallet(h, '100.00');
    const inboxCtx = { source: 'sqs' as const, correlationId: 'c', inbox: { consumerName: 'consumer', messageId: 'msg-ok', payloadHash: 'h'.repeat(64) } };
    const r = await h.submit.execute(cmd(w, 'BET', '40.00'), inboxCtx);
    expect(r.status).toBe(Status.Processed);
    const inbox = await withPg(db.url, (c) => c.query(`SELECT processed_at FROM inbox_messages WHERE consumer_name = 'consumer' AND message_id = 'msg-ok'`));
    expect(inbox.rows[0].processed_at).not.toBeNull();
    const ev = await withPg(db.url, (c) => c.query(`SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq DESC LIMIT 2`, [w.id]));
    expect(ev.rows.map((x) => x.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await balanceOf(w.id)).toBe('60.00');
  });
});

describe('inbox (dedup persistente por consumerName + messageId)', () => {
  const sqsCtx = (messageId: string, hash = 'a'.repeat(64)) => ({ source: 'sqs' as const, correlationId: messageId, inbox: { consumerName: 'wager-consumer', messageId, payloadHash: hash } });

  test('redelivery do mesmo messageId não duplica efeitos e devolve o resultado original', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    const first = await h.submit.execute(bet, sqsCtx('msg-1'));
    const redelivered = await h.submit.execute(bet, sqsCtx('msg-1'));
    expect(redelivered).toEqual({ ...first, idempotentReplay: true });
    expect(await balanceOf(w.id)).toBe('70.00');
  });

  test('o mesmo messageId chegando em paralelo (visibilidade expirada) produz um único efeito', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    await Promise.all(Array.from({ length: 10 }, () => h.submit.execute(bet, sqsCtx('msg-par'))));
    expect(await balanceOf(w.id)).toBe('70.00');
    expect(await count(db.url, `SELECT 1 FROM inbox_messages WHERE message_id = 'msg-par'`)).toBe(1);
  });

  test('messageIds DIFERENTES para a mesma operação de negócio: a idempotency key segura (sem duplicar)', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    await h.submit.execute(bet, sqsCtx('msg-a'));
    const r = await h.submit.execute(bet, sqsCtx('msg-b'));
    expect(r.idempotentReplay).toBe(true);
    expect(await balanceOf(w.id)).toBe('70.00');
  });

  test('mesmo messageId com conteúdo diferente ⇒ InboxPayloadMismatchError (bug do produtor)', async () => {
    const w = await newWallet(h, '100.00');
    const other = await newWallet(h, '100.00');
    await h.submit.execute(cmd(w, 'BET', '10.00'), sqsCtx('msg-mm', 'a'.repeat(64)));
    await expect(h.submit.execute(cmd(other, 'BET', '10.00'), sqsCtx('msg-mm', 'b'.repeat(64)))).rejects.toBeInstanceOf(InboxPayloadMismatchError);
    expect(await balanceOf(other.id)).toBe('100.00');
  });
});

describe('reversões', () => {
  test('REFUND reverte BET uma única vez; ROLLBACK da mesma BET também é bloqueado (sem crédito duplo)', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    await h.submit.execute(bet, ctx());
    const refund = await h.submit.execute(cmd(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const again = await h.submit.execute(cmd(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    expect(again).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    const rollback = await h.submit.execute(cmd(w, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect(await balanceOf(w.id)).toBe('100.00');
  });

  test('ROLLBACK de WIN debita; se o saldo não comporta ⇒ REVERSAL_WOULD_OVERDRAW (≠ INSUFFICIENT_FUNDS), auditável', async () => {
    const w = await newWallet(h, '0.00');
    const win = cmd(w, 'WIN', '50.00');
    await h.submit.execute(win, ctx());
    await h.submit.execute(cmd(w, 'BET', '40.00'), ctx()); // saldo 10.00
    const rb = await h.submit.execute(cmd(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }), ctx());
    expect(rb).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: { amount: '10.00' } });
    expect(await balanceOf(w.id)).toBe('10.00');
    const view = await h.txQueries.getById(rb.transactionId);
    expect(view).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', failureAction: 'NEW_ID_IF_CHANGED' });
    await h.submit.execute(cmd(w, 'WIN', '100.00'), ctx()); // agora há saldo, mas a rejeição anterior continua terminal
    expect((await h.txQueries.getById(rb.transactionId)).status).toBe('REJECTED');
  });

  test('referências: valor diferente, tipo inválido e rodada diferente são rejeitados com códigos distintos', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    await h.submit.execute(bet, ctx());
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    expect(await h.submit.execute(cmd(w, 'REFUND', '10.00', ref), ctx())).toMatchObject({ failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
    expect(await h.submit.execute(cmd(w, 'REFUND', '30.00', { ...ref, roundId: 'round-X' }), ctx())).toMatchObject({ failureCode: 'REFERENCE_MISMATCH' });
    const win = cmd(w, 'WIN', '5.00');
    await h.submit.execute(win, ctx());
    expect(await h.submit.execute(cmd(w, 'REFUND', '5.00', { referenceExternalTransactionId: win.externalTransactionId }), ctx())).toMatchObject({ failureCode: 'INVALID_REFERENCE_KIND' });
  });

  test('a referência é resolvida por (provider, externalId): mesmo externalId em outro provider não conta', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '30.00', { providerId: 'provider-a' });
    await h.submit.execute(bet, ctx());
    const r = await h.submit.execute(cmd(w, 'REFUND', '30.00', { providerId: 'provider-b', referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    expect(r.status).toBe(Status.PendingReference); // provider-b não tem essa transação
  });
});

describe('referências fora de ordem (PENDING_REFERENCE)', () => {
  test('REFUND chega antes da BET: fica PENDING_REFERENCE (202), é acordado quando a BET chega e então é aplicado', async () => {
    const clock = new ManualClock();
    const hh = buildHarness(orm, { clock, policy: new PendingReferencePolicy(10, 600_000, 1_000, 60_000) });
    const w = await newWallet(hh, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    const refund = await hh.submit.execute(cmd(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    expect(refund).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' }, idempotentReplay: false });
    expect(await count(db.url, `SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference' AND payload->'data'->>'transactionId' = '${refund.transactionId}'`)).toBe(1);

    // ainda sem a BET: reagenda com backoff (não está devida agora)
    expect(await hh.reprocess.execute(refund.transactionId)).toBe('RESCHEDULED');
    expect(await hh.uow.read((r) => r.transactions.findDuePending(clock.now(), 10))).toHaveLength(0);
    expect((await hh.txQueries.getById(refund.transactionId)).status).toBe('PENDING_REFERENCE' as string);

    // a BET chega: a pendência fica devida imediatamente (wake)
    await hh.submit.execute(bet, ctx());
    const due = await hh.uow.read((r) => r.transactions.findDuePending(clock.now(), 10));
    expect(due.map((d) => d.id)).toContain(refund.transactionId);
    expect(await hh.reprocess.execute(refund.transactionId)).toBe('PROCESSED');
    expect(await hh.txQueries.getById(refund.transactionId)).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect(await hh.walletQueries.getWallet(w.id)).toMatchObject({ balance: { amount: '100.00' } });
    // um replay da submissão original devolve agora o estado atual (PROCESSED)
    const replay = await hh.submit.execute(cmd(w, 'REFUND', '30.00', { externalTransactionId: (await hh.txQueries.getById(refund.transactionId)).externalTransactionId, referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    expect(replay).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    await assertLedgerInvariant(db.url, w.id);
  });

  test('ROLLBACK de uma WIN que ainda está PENDING_REFERENCE também espera (cadeia de dependências)', async () => {
    const clock = new ManualClock();
    const hh = buildHarness(orm, { clock });
    const w = await newWallet(hh, '100.00');
    const bet = cmd(w, 'BET', '10.00');
    const win = cmd(w, 'WIN', '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const rb = cmd(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: win.externalTransactionId });
    const rWin = await hh.submit.execute(win, ctx()); // WIN referencia BET que não existe ⇒ pendente
    const rRb = await hh.submit.execute(rb, ctx()); // ROLLBACK referencia a WIN pendente ⇒ também pendente
    expect([rWin.status, rRb.status]).toEqual([Status.PendingReference, Status.PendingReference]);
    await hh.submit.execute(bet, ctx());
    expect(await hh.reprocess.execute(rRb.transactionId)).toBe('RESCHEDULED'); // WIN ainda pendente
    expect(await hh.reprocess.execute(rWin.transactionId)).toBe('PROCESSED');
    expect(await hh.reprocess.execute(rRb.transactionId)).toBe('PROCESSED');
    expect(await hh.walletQueries.getWallet(w.id)).toMatchObject({ balance: { amount: '90.00' } }); // BET -10, WIN +25, ROLLBACK(WIN) -25
    await assertLedgerInvariant(db.url, w.id);
  });

  test('esgotado o limite de tentativas ⇒ REJECTED/REFERENCE_NOT_FOUND + evento WagerTransactionRejected', async () => {
    const clock = new ManualClock();
    const hh = buildHarness(orm, { clock, policy: new PendingReferencePolicy(3, 3_600_000, 1_000, 8_000) });
    const w = await newWallet(hh, '100.00');
    const r = await hh.submit.execute(cmd(w, 'REFUND', '30.00', { referenceExternalTransactionId: 'nunca-chega' }), ctx());
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(await hh.reprocess.execute(r.transactionId));
      clock.advance(60_000);
    }
    expect(outcomes).toEqual(['RESCHEDULED', 'RESCHEDULED', 'REJECTED']);
    expect(await hh.txQueries.getById(r.transactionId)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    const ev = await withPg(db.url, (c) => c.query(`SELECT payload FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload->'data'->>'transactionId' = $1`, [r.transactionId]));
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload.data.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await hh.reprocess.execute(r.transactionId)).toBe('SKIPPED'); // terminal: nada mais a fazer
    expect(await hh.walletQueries.getWallet(w.id)).toMatchObject({ balance: { amount: '100.00' } });
  });

  test('esgotado o TTL (mesmo com tentativas sobrando) ⇒ REJECTED', async () => {
    const clock = new ManualClock();
    const hh = buildHarness(orm, { clock, policy: new PendingReferencePolicy(100, 5_000, 1_000, 8_000) });
    const w = await newWallet(hh, '100.00');
    const r = await hh.submit.execute(cmd(w, 'ROLLBACK', '30.00', { referenceExternalTransactionId: 'nunca-chega-2' }), ctx());
    clock.advance(6_000);
    expect(await hh.reprocess.execute(r.transactionId)).toBe('REJECTED');
    expect(await hh.txQueries.getById(r.transactionId)).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND' });
  });

  test('vários reprocessamentos concorrentes da mesma pendência aplicam UMA vez', async () => {
    const hh = buildHarness(orm);
    const w = await newWallet(hh, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    const r = await hh.submit.execute(cmd(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    await hh.submit.execute(bet, ctx());
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => hh.reprocess.execute(r.transactionId)));
    expect(outcomes.filter((o) => o === 'PROCESSED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'SKIPPED')).toHaveLength(7);
    expect(await hh.walletQueries.getWallet(w.id)).toMatchObject({ balance: { amount: '100.00' } });
    await assertLedgerInvariant(db.url, w.id);
  });
});

describe('FAILED (erro permanente de infraestrutura, auditável)', () => {
  test('registra FAILED terminal; replay devolve FAILED; sem wallet não registra', async () => {
    const w = await newWallet(h, '100.00');
    const c = cmd(w, 'BET', '10.00');
    expect(await h.recordFailed.execute(c, 'sqs')).toBe(true);
    expect(await h.recordFailed.execute(c, 'sqs')).toBe(false); // já registrada
    expect(await h.submit.execute(c, ctx())).toMatchObject({ status: 'FAILED', failureCode: 'INFRASTRUCTURE_FAILURE', idempotentReplay: true });
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await h.recordFailed.execute(cmd({ id: uuidv7(), playerId: 'x' }, 'BET', '1.00'), 'sqs')).toBe(false);
  });
});

describe('ledger e reconciliação', () => {
  test('paginação por cursor opaco é estável mesmo com escritas concorrentes (ledger append-only)', async () => {
    const w = await newWallet(h, '1000.00');
    for (let i = 0; i < 7; i++) await h.submit.execute(cmd(w, 'BET', '1.00'), ctx());
    const p1 = await h.walletQueries.listLedger(w.id, undefined, 3);
    expect(p1.items.map((e) => e.walletVersion)).toEqual([1, 2, 3]);
    expect(typeof p1.nextCursor).toBe('string');
    await h.submit.execute(cmd(w, 'WIN', '5.00'), ctx()); // escrita entre as páginas
    const p2 = await h.walletQueries.listLedger(w.id, p1.nextCursor!, 3);
    expect(p2.items.map((e) => e.walletVersion)).toEqual([4, 5, 6]);
    const p3 = await h.walletQueries.listLedger(w.id, p2.nextCursor!, 3);
    expect(p3.items.map((e) => e.walletVersion)).toEqual([7, 8, 9]);
    expect(p3.nextCursor).toBeNull();
    await expect(h.walletQueries.listLedger(w.id, 'lixo', 3)).rejects.toThrow('invalid cursor');
    await expect(h.walletQueries.listLedger(w.id, undefined, 0)).rejects.toThrow('limit');
    await expect(h.walletQueries.listLedger(uuidv7(), undefined, 3)).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('reconciliação consistente: saldo armazenado == calculado, diferença 0.00 e contagem de lançamentos', async () => {
    const w = await newWallet(h, '975.00');
    await h.submit.execute(cmd(w, 'BET', '75.00'), ctx());
    const r = await h.walletQueries.reconcile(w.id);
    expect(r).toEqual({
      walletId: w.id, storedBalance: { amount: '900.00', currency: 'BRL' }, calculatedBalance: { amount: '900.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: 2,
    });
  });

  test('divergência NÃO é corrigida em silêncio: sinalizada na resposta, logada e contabilizada em métrica', async () => {
    const w = await newWallet(h, '100.00');
    // adulteração fora de banda (superuser + triggers desativadas) — o que a reconciliação existe para detectar
    await withPg(db.url, async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE wallets SET balance = 130.00 WHERE id = $1`, [w.id]);
      await c.query('COMMIT');
    });
    const before = h.metrics.get('reconciliation_divergence');
    const r = await h.walletQueries.reconcile(w.id);
    expect(r).toMatchObject({ consistent: false, storedBalance: { amount: '130.00' }, calculatedBalance: { amount: '100.00' }, difference: { amount: '30.00' } });
    expect(h.metrics.get('reconciliation_divergence')).toBe(before + 1);
    expect(h.logger.lines.some((l) => l.level === 'error' && l.message.includes('divergence'))).toBe(true);
    expect((await h.walletQueries.getWallet(w.id)).balance.amount).toBe('130.00'); // nada foi "consertado"
    await withPg(db.url, async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`UPDATE wallets SET balance = 100.00 WHERE id = $1`, [w.id]); // restaura para a invariante final do arquivo
      await c.query('COMMIT');
    });
  });
});
