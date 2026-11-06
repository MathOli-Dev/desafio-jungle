import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Failpoints } from '@/application/failpoints';
import { SystemClock } from '@/application/ports/clock';
import { EventPublisher } from '@/application/ports/event-publisher';
import { loadConfig } from '@/config/config';
import { WagerTransactionStatus as Status } from '@/domain/wagering/wager-transaction';
import { OutboxMessage } from '@/domain/messaging/outbox-message';
import { SqsEventPublisher } from '@/infrastructure/messaging/sqs-event-publisher';
import { SqsQueues } from '@/infrastructure/messaging/sqs';
import { Orm } from '@/infrastructure/persistence/orm';
import { OutboxPublisherWorker } from '@/infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '@/infrastructure/workers/pending-reference.worker';
import { assertLedgerInvariant, buildHarness, cmd, ctx, Harness, newWallet } from '@test/support/harness';
import { createMigratedOrm, createTestDatabase, TestDatabase, withPg } from '@test/support/infra';
import { RecordingMetrics, SilentLogger } from '@test/support/fakes';
import { createTestQueues, drainQueue, instanceEnv, TestQueues, waitFor } from '@test/support/sqs';

let db: TestDatabase;
let orm: Orm;
let h: Harness;
let q: TestQueues;
let publisher: SqsEventPublisher;

beforeAll(async () => {
  db = await createTestDatabase('wager_outbox');
  orm = await createMigratedOrm(db.url);
  h = buildHarness(orm);
  q = await createTestQueues();
  const queues = new SqsQueues(q.sqs, loadConfig(instanceEnv(db.url, q)), new SilentLogger());
  await queues.ensure();
  publisher = new SqsEventPublisher(q.sqs, queues);
});
afterAll(async () => {
  await assertLedgerInvariant(db.url);
  await orm.close(true);
  await db.drop();
});

class RecordingPublisher extends EventPublisher {
  readonly published: string[] = [];
  healthy = true;
  async publish(m: OutboxMessage): Promise<void> {
    if (!this.healthy) throw new Error('broker unavailable');
    await new Promise((r) => setTimeout(r, 1)); // cede o event loop para intercalar publishers de verdade
    this.published.push(m.id);
  }
}

function makeWorker(instanceId: string, pub: EventPublisher, extraEnv: Record<string, string> = {}, failpoints = new Failpoints(false)) {
  const config = loadConfig(instanceEnv(db.url, q, { INSTANCE_ID: instanceId, OUTBOX_BATCH_SIZE: '20', ...extraEnv }));
  return new OutboxPublisherWorker(h.uow, pub, new SystemClock(), new RecordingMetrics(), new SilentLogger(), config, failpoints);
}
const pendingCount = async () => (await withPg(db.url, (c) => c.query(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`))).rows[0].n as number;
const totalCount = async () => (await withPg(db.url, (c) => c.query(`SELECT count(*)::int AS n FROM outbox_messages`))).rows[0].n as number;
const drainAll = async (w: OutboxPublisherWorker) => {
  while ((await w.tick()) > 0) { /* continua até não haver mais devidos */ }
};

describe('transactional outbox', () => {
  test('publica o envelope completo na fila de eventos (grupo = walletId, dedup = eventId) e marca como publicado', async () => {
    const w = await newWallet(h, '100.00');
    await h.submit.execute(cmd(w, 'BET', '10.00'), ctx('corr-outbox-1'));
    const expected = (await withPg(db.url, (c) => c.query(`SELECT id, event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq`, [w.id]))).rows;
    expect(expected.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WagerTransactionProcessed', 'WalletBalanceChanged']);

    // esvazia a fila de eventos de testes anteriores e publica
    await drainQueue(q.sqs, q.urls.events, { waitMs: 500 });
    await drainAll(makeWorker('pub-1', publisher));
    expect(await pendingCount()).toBe(0);

    const messages = await drainQueue(q.sqs, q.urls.events, { max: 100, waitMs: 3000 });
    const mine = messages.filter((m) => m.Attributes?.MessageGroupId === w.id);
    expect(mine).toHaveLength(4);
    const first = JSON.parse(mine.find((m) => JSON.parse(m.Body!).eventType === 'WalletBalanceChanged' && JSON.parse(m.Body!).data.direction === 'DEBIT')!.Body!);
    expect(first).toMatchObject({
      eventType: 'WalletBalanceChanged', version: 1, aggregateId: w.id, correlationId: 'corr-outbox-1',
      data: { walletId: w.id, direction: 'DEBIT', money: { amount: '10.00', currency: 'BRL' }, balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '90.00' }, walletVersion: 2 },
    });
    expect(expected.map((r) => r.id).sort()).toEqual(mine.map((m) => JSON.parse(m.Body!).eventId).sort());
  });

  test('DOIS publishers concorrentes sobre a mesma outbox: cada evento é publicado exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet(h, '1000.00')));
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 12 }, () => h.submit.execute(cmd(w, 'BET', '1.00'), ctx()))));
    const before = await pendingCount();
    expect(before).toBeGreaterThan(200);

    const rec = new RecordingPublisher();
    const [a, b] = [makeWorker('pub-A', rec), makeWorker('pub-B', rec)];
    await Promise.all([drainAll(a), drainAll(b)]);

    expect(await pendingCount()).toBe(0);
    expect(rec.published).toHaveLength(before); // nenhuma duplicata entre os dois publishers
    expect(new Set(rec.published).size).toBe(before);
  });

  test('falha do broker ⇒ backoff por evento, nada se perde; ao recuperar, tudo é publicado', async () => {
    const w = await newWallet(h, '100.00');
    await h.submit.execute(cmd(w, 'BET', '5.00'), ctx());
    await h.submit.execute(cmd(w, 'WIN', '7.00'), ctx());
    await drainAll(makeWorker('drain', new RecordingPublisher())); // zera o que sobrou

    await h.submit.execute(cmd(w, 'BET', '1.00'), ctx());
    const rec = new RecordingPublisher();
    rec.healthy = false;
    const worker = makeWorker('pub-flaky', rec);
    await worker.tick();
    const rows = (await withPg(db.url, (c) => c.query(`SELECT attempts, next_attempt_at > now() AS in_future, published_at, locked_by, last_error FROM outbox_messages WHERE published_at IS NULL`))).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.published_at === null)).toBe(true);
    expect(rows.some((r) => r.attempts >= 1 && r.in_future && r.last_error === 'broker unavailable')).toBe(true);
    expect(rows.every((r) => r.locked_by === null)).toBe(true); // lease devolvido: ninguém fica "preso"

    rec.healthy = true;
    await waitFor(async () => { await worker.tick(); return (await pendingCount()) === 0; }, { timeoutMs: 15_000, intervalMs: 300, message: 'backoff vence e tudo é publicado' });
    expect(rec.published.length).toBeGreaterThanOrEqual(rows.length);
  });

  test('publisher morre depois do claim: OUTRA instância assume quando o lease expira (nenhum evento perdido)', async () => {
    const w = await newWallet(h, '100.00');
    await h.submit.execute(cmd(w, 'BET', '2.00'), ctx());
    await drainAll(makeWorker('drain2', new RecordingPublisher()));
    await h.submit.execute(cmd(w, 'BET', '3.00'), ctx());
    const pending = await pendingCount();
    expect(pending).toBeGreaterThan(0);

    // "instância morta": claima com lease curto e nunca publica nem marca
    const claimed = await h.uow.read((r) => r.outbox.claimDue(50, 'dead-instance', 800, new Date()));
    expect(claimed).toHaveLength(pending);

    const rec = new RecordingPublisher();
    const rescuer = makeWorker('pub-rescuer', rec);
    expect(await rescuer.tick()).toBe(0); // lease ainda vigente: não pega
    await new Promise((r) => setTimeout(r, 1000)); // lease expira
    expect(await rescuer.tick()).toBe(pending);
    expect(rec.published).toHaveLength(pending);
    expect(await pendingCount()).toBe(0);
  });

  test('morre depois de PUBLICAR e antes de MARCAR: outra instância republica (duplicata), segura para o consumidor', async () => {
    const w = await newWallet(h, '100.00');
    await h.submit.execute(cmd(w, 'LOSS', '1.00'), ctx());
    await drainAll(makeWorker('drain3', new RecordingPublisher()));
    await drainQueue(q.sqs, q.urls.events, { waitMs: 500 });
    await h.submit.execute(cmd(w, 'LOSS', '2.00'), ctx()); // 1 evento: WagerTransactionProcessed (LOSS não move saldo)

    // instância A: claima e PUBLICA de verdade, mas morre antes de marcar
    const [event] = await h.uow.read((r) => r.outbox.claimDue(10, 'instance-A', 500, new Date()));
    await publisher.publish(event!);
    await new Promise((r) => setTimeout(r, 700)); // lease de A expira

    // instância B republica o mesmo evento
    const rec = new RecordingPublisher();
    await drainAll(makeWorker('instance-B', rec));
    expect(rec.published).toEqual([event!.id]); // o MESMO eventId é publicado de novo
    expect(await pendingCount()).toBe(0);

    // a fila FIFO deduplica por MessageDeduplicationId=eventId — mas isso é otimização: o consumidor deduplica por eventId
    await drainAll(makeWorker('instance-C', publisher));
    const msgs = await drainQueue(q.sqs, q.urls.events, { max: 10, waitMs: 2500 });
    const ids = msgs.map((m) => JSON.parse(m.Body!).eventId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(event!.id);
  });

  test('NUNCA publica antes do commit: transação abortada não deixa evento na outbox nem na fila', async () => {
    const hh = buildHarness(orm, { failpoints: new Failpoints(true, 'submit.before-commit:throw') });
    const w = await newWallet(h, '100.00');
    await drainAll(makeWorker('drain4', new RecordingPublisher()));
    await drainQueue(q.sqs, q.urls.events, { waitMs: 500 });
    const total = await totalCount();
    await expect(hh.submit.execute(cmd(w, 'BET', '10.00'), ctx())).rejects.toThrow('failpoint');
    expect(await totalCount()).toBe(total); // nada na outbox
    const rec = new RecordingPublisher();
    await makeWorker('pub-5', rec).tick();
    expect(rec.published).toHaveLength(0);
    expect(await drainQueue(q.sqs, q.urls.events, { waitMs: 800 })).toHaveLength(0);
  });

  test('stats da outbox: pending e evento pendente mais antigo (base da métrica de lag)', async () => {
    const w = await newWallet(h, '10.00');
    await h.submit.execute(cmd(w, 'LOSS', '1.00'), ctx());
    const stats = await h.uow.read((r) => r.outbox.stats());
    expect(stats.pending).toBeGreaterThan(0);
    expect(stats.oldestOccurredAt).toBeInstanceOf(Date);
    await drainAll(makeWorker('drain5', new RecordingPublisher()));
    expect((await h.uow.read((r) => r.outbox.stats())).pending).toBe(0);
  });
});

describe('worker de PENDING_REFERENCE (agendado)', () => {
  test('REFUND que chegou antes da BET é aplicado pelo worker assim que a BET chega', async () => {
    const w = await newWallet(h, '100.00');
    const bet = cmd(w, 'BET', '30.00');
    const refund = await h.submit.execute(cmd(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId }), ctx());
    expect(refund.status).toBe(Status.PendingReference);

    const config = loadConfig(instanceEnv(db.url, q, { PENDING_BATCH_SIZE: '50' }));
    const worker = new PendingReferenceWorker(h.uow, h.reprocess, new SystemClock(), new SilentLogger(), config);
    expect(await worker.tick()).toBe(0); // ainda não está devida (backoff + referência ausente)

    await h.submit.execute(bet, ctx()); // a BET chega ⇒ a pendência é acordada
    expect(await worker.tick()).toBe(1);
    expect((await h.txQueries.getById(refund.transactionId)).status).toBe('PROCESSED');
    expect((await h.walletQueries.getWallet(w.id)).balance.amount).toBe('100.00');
  });

  test('várias instâncias do worker disputando as mesmas pendências: cada uma é aplicada uma vez', async () => {
    const w = await newWallet(h, '500.00');
    const bets = Array.from({ length: 15 }, () => cmd(w, 'BET', '10.00'));
    const refunds = await Promise.all(bets.map((b) => h.submit.execute(cmd(w, 'REFUND', '10.00', { referenceExternalTransactionId: b.externalTransactionId }), ctx())));
    expect(refunds.every((r) => r.status === Status.PendingReference)).toBe(true);
    await Promise.all(bets.map((b) => h.submit.execute(b, ctx())));

    const config = loadConfig(instanceEnv(db.url, q, { PENDING_BATCH_SIZE: '50' }));
    const workers = Array.from({ length: 3 }, () => new PendingReferenceWorker(h.uow, h.reprocess, new SystemClock(), new SilentLogger(), config));
    await Promise.all(workers.map((wk) => wk.tick()));
    for (const r of refunds) expect((await h.txQueries.getById(r.transactionId)).status).toBe('PROCESSED');
    expect((await h.walletQueries.getWallet(w.id)).balance.amount).toBe('500.00');
    const refundEntries = await withPg(db.url, (c) => c.query(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'`, [w.id]));
    expect(refundEntries.rows[0].n).toBe(16); // OPENING + 15 estornos, sem duplicar
  });
});
