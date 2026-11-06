import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Instance, spawnInstance } from '@test/support/app';
import { assertLedgerInvariant, buildHarness, cmd, ctx, Harness, newWallet } from '@test/support/harness';
import { createMigratedOrm, createTestDatabase, TestDatabase, withPg } from '@test/support/infra';
import { createTestQueues, drainQueue, instanceEnv, queueDepth, sendMessages, TestQueues, wagerMessage, waitFor } from '@test/support/sqs';
import { Orm } from '@/infrastructure/persistence/orm';

/**
 * Concorrência com PROCESSOS REAIS (`bun src/main.ts`): cada instância tem seu próprio pool, workers e memória.
 * Compartilham apenas PostgreSQL e SQS — exatamente o cenário de produção com várias réplicas.
 */
let db: TestDatabase;
let orm: Orm;
let h: Harness;
const running: Instance[] = [];

beforeAll(async () => {
  db = await createTestDatabase('wager_multi');
  orm = await createMigratedOrm(db.url);
  h = buildHarness(orm);
});
afterAll(async () => {
  await Promise.all(running.map((i) => i.stop('SIGKILL').catch(() => undefined)));
  await assertLedgerInvariant(db.url);
  await orm.close(true);
  await db.drop();
});

async function spawn(name: string, q: TestQueues, extra: Record<string, string> = {}): Promise<Instance> {
  const inst = await spawnInstance(name, instanceEnv(db.url, q, extra));
  running.push(inst);
  return inst;
}
const spawnMany = (names: string[], q: TestQueues, extra: Record<string, string> = {}) => Promise.all(names.map((n) => spawn(n, q, extra)));
/** Encerra (SIGTERM, com drenagem) as instâncias de cenários anteriores: cada cenário começa com publishers/workers só seus. */
async function stopAll(): Promise<void> {
  const all = running.splice(0);
  await Promise.all(all.map((i) => i.stop('SIGTERM').catch(() => undefined)));
}

const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await withPg(db.url, (c) => c.query(text, params))).rows as T[];
const num = async (text: string, params: unknown[] = []) => Number((await sql(text, params))[0]?.n ?? 0);
const balance = async (walletId: string) => (await h.walletQueries.getWallet(walletId)).balance.amount;
const debits = (walletId: string) => num(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId]);
const idle = (q: TestQueues) => async () => {
  const d = await queueDepth(q.sqs, q.urls.transactions);
  return d.visible === 0 && d.inFlight === 0;
};
const outboxPending = () => num(`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);
const outboxTotal = () => num(`SELECT count(*)::int AS n FROM outbox_messages`);

let seq = 0;
const httpBody = (w: { id: string; playerId: string }, kind: string, amount: string, o: Record<string, unknown> = {}) => ({
  providerId: 'provider-a', externalTransactionId: `mi-${process.pid}-${Date.now()}-${++seq}`, playerId: w.playerId, walletId: w.id,
  roundId: 'round-1', gameId: 'fortune-chimp', kind, money: { amount, currency: 'BRL' }, ...o,
});
async function post(base: string, body: Record<string, any>, key?: string) {
  const res = await fetch(`${base}/wagering/transactions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}` }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe('3 instâncias (processos) atrás de HTTP, com 3 publishers e 3 workers de pendência concorrentes', () => {
  let instances: Instance[];
  let q: TestQueues;
  const bases = () => instances.map((i) => i.baseUrl!);
  const rr = (i: number) => bases()[i % bases().length]!;

  beforeAll(async () => {
    q = await createTestQueues();
    instances = await spawnMany(['A', 'B', 'C'], q, { RUN_CONSUMER: 'false', OUTBOX_LEASE_MS: '3000' });
    expect(instances.every((i) => i.baseUrl)).toBe(true);
  }, 120_000);
  afterAll(() => stopAll(), 60_000);

  test('cenário obrigatório entre PROCESSOS: 2 apostas de 80 sobre 100 em instâncias diferentes ⇒ 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito', async () => {
    const w = await newWallet(h, '100.00');
    const results = await Promise.all([post(bases()[0]!, httpBody(w, 'BET', '80.00')), post(bases()[1]!, httpBody(w, 'BET', '80.00'))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await balance(w.id)).toBe('20.00');
    expect(await debits(w.id)).toBe(1);
  }, 60_000);

  test('a MESMA aposta 60× em paralelo, espalhada nas 3 instâncias ⇒ um único débito', async () => {
    const w = await newWallet(h, '100.00');
    const body = httpBody(w, 'BET', '25.00');
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => post(rr(i), body)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => !r.json.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json.transactionId)).size).toBe(1);
    expect(await balance(w.id)).toBe('75.00');
    expect(await debits(w.id)).toBe(1);
  }, 60_000);

  test('hot wallet entre 3 processos: 130 apostas distintas de 1.00 sobre 100.00 ⇒ exatamente 100 PROCESSED, saldo 0.00, nunca negativo', async () => {
    const w = await newWallet(h, '100.00');
    const results = await Promise.all(Array.from({ length: 130 }, (_, i) => post(rr(i), httpBody(w, 'BET', '1.00'))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(100);
    expect(results.filter((r) => r.status === 422 && r.json.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(30);
    expect(await balance(w.id)).toBe('0.00');
    await assertLedgerInvariant(db.url, w.id);
  }, 90_000);

  test('wallets distintas em paralelo (20 wallets × 5 apostas) espalhadas nas instâncias', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => newWallet(h, '50.00')));
    const results = await Promise.all(wallets.flatMap((w, wi) => Array.from({ length: 5 }, (_, k) => post(rr(wi + k), httpBody(w, 'BET', '10.00')))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    for (const w of wallets) expect(await balance(w.id)).toBe('0.00');
  }, 90_000);

  test('REFUND numa instância e a BET referenciada em outra: os workers de pendência (3 processos) aplicam UMA vez', async () => {
    const w = await newWallet(h, '100.00');
    const pairs = Array.from({ length: 12 }, () => httpBody(w, 'BET', '5.00'));
    const refunds = await Promise.all(pairs.map((b, i) => post(rr(i), httpBody(w, 'REFUND', '5.00', { referenceExternalTransactionId: b.externalTransactionId }))));
    expect(refunds.every((r) => r.status === 202)).toBe(true);
    await Promise.all(pairs.map((b, i) => post(rr(i + 1), b)));
    await waitFor(async () => (await num(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'REFUND' AND status = 'PROCESSED'`, [w.id])) === 12, { timeoutMs: 30_000, message: 'estornos aplicados' });
    expect(await balance(w.id)).toBe('100.00');
    expect(await num(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'CREDIT'`, [w.id])).toBe(13); // OPENING + 12 estornos
    await assertLedgerInvariant(db.url, w.id);
  }, 90_000);

  test('outbox com 3 publishers em processos distintos: tudo publicado, nada perdido, eventIds únicos na fila', async () => {
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 60_000, message: 'outbox drenada pelos 3 publishers' });
    const total = await outboxTotal();
    expect(total).toBeGreaterThan(500);
    const ids = await sql<{ id: string }>(`SELECT id FROM outbox_messages`);
    const messages = await drainQueue(q.sqs, q.urls.events, { max: 100_000, waitMs: 60_000 });
    const published = new Set(messages.map((m) => JSON.parse(m.Body!).eventId as string));
    expect(published.size).toBe(total); // cada evento chegou (a dedup FIFO por eventId absorve qualquer duplicata)
    expect(ids.every((r) => published.has(r.id))).toBe(true);
  }, 180_000);
});

describe('workers SQS em 3 processos (sem HTTP)', () => {
  test('400+ mensagens com duplicatas de broker e de negócio: cada operação é aplicada exatamente uma vez', async () => {
    await stopAll();
    const q = await createTestQueues();
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet(h, '1000.00')));
    const messages = [];
    for (const w of wallets) {
      for (let i = 0; i < 30; i++) {
        const m = wagerMessage(w, 'BET', '2.00', { externalTransactionId: `sqs-${w.id}-${i}`, messageId: `m-${w.id}-${i}` });
        messages.push(m);
        if (i % 3 === 0) messages.push(m); // entrega duplicada do broker (mesmo messageId)
        if (i % 3 === 1) messages.push(wagerMessage(w, 'BET', '2.00', { externalTransactionId: `sqs-${w.id}-${i}`, messageId: `m2-${w.id}-${i}` })); // reenvio do provedor (outro messageId, mesma key)
      }
    }
    expect(messages.length).toBe(10 * 50);
    await sendMessages(q.sqs, q.urls.transactions, messages);

    await spawnMany(['W1', 'W2', 'W3'], q, { RUN_HTTP: 'false', CONSUMER_CONCURRENCY: '3', CONSUMER_MAX_ATTEMPTS: '6' });
    await waitFor(idle(q), { timeoutMs: 150_000, intervalMs: 500, message: 'fila drenada pelos 3 workers' });

    for (const w of wallets) {
      expect(await balance(w.id)).toBe('940.00'); // 30 BETs únicas × 2.00
      expect(await debits(w.id)).toBe(30);
    }
    expect(await num(`SELECT count(*)::int AS n FROM wager_transactions WHERE kind = 'BET' AND external_transaction_id LIKE 'sqs-%'`)).toBe(300);
    expect(await drainQueue(q.sqs, q.urls.dlq, { waitMs: 1500 })).toHaveLength(0);
    await assertLedgerInvariant(db.url);
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 60_000, message: 'eventos publicados' });
    await stopAll();
  }, 240_000);
});

describe('morte de processo (kill -9) em pontos críticos', () => {
  test('worker MORTO depois do commit e antes do ack: a mensagem volta, a inbox absorve, nada duplica', async () => {
    await stopAll();
    const q = await createTestQueues();
    const wallets = await Promise.all(Array.from({ length: 4 }, () => newWallet(h, '1000.00')));
    const inboxBefore = await num(`SELECT count(*)::int AS n FROM inbox_messages`);
    const doomed = await spawn('doomed', q, { RUN_HTTP: 'false', ENABLE_FAILPOINTS: 'true', FAILPOINTS: 'consumer.after-commit:kill' });
    await sendMessages(q.sqs, q.urls.transactions, wallets.flatMap((w) => Array.from({ length: 5 }, () => wagerMessage(w, 'BET', '2.00'))));

    await doomed.exited; // morreu por SIGKILL logo após o primeiro commit
    expect(doomed.proc.signalCode).toBe('SIGKILL');
    const committed = (await num(`SELECT count(*)::int AS n FROM inbox_messages`)) - inboxBefore;
    expect(committed).toBeGreaterThanOrEqual(1); // o efeito foi commitado...
    const depth = await queueDepth(q.sqs, q.urls.transactions);
    expect(depth.visible + depth.inFlight).toBe(20); // ...mas NENHUMA mensagem foi ackada

    await spawnMany(['healthy-1', 'healthy-2'], q, { RUN_HTTP: 'false' });
    await waitFor(idle(q), { timeoutMs: 120_000, intervalMs: 500, message: 'redelivery após a visibilidade expirar' });
    for (const w of wallets) {
      expect(await balance(w.id)).toBe('990.00'); // 5 × 2.00, uma vez cada (inclusive a que foi commitada antes da morte)
      expect(await debits(w.id)).toBe(5);
    }
    expect(await drainQueue(q.sqs, q.urls.dlq, { waitMs: 1500 })).toHaveLength(0);
    await stopAll();
  }, 240_000);

  test('publisher MORTO depois de publicar e antes de marcar: outra instância assume e republica; nenhum evento se perde', async () => {
    await stopAll();
    const q = await createTestQueues();
    await sql(`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`).catch(() => undefined); // isola o cenário (UPDATE permitido na outbox)
    const w = await newWallet(h, '500.00');
    for (let i = 0; i < 6; i++) await h.submit.execute(cmd(w, 'BET', '1.00'), ctx());
    const expectedIds = (await sql<{ id: string }>(`SELECT id FROM outbox_messages WHERE published_at IS NULL`)).map((r) => r.id);
    expect(expectedIds.length).toBe(14);

    const doomed = await spawn('pub-doomed', q, { RUN_HTTP: 'false', RUN_CONSUMER: 'false', RUN_PENDING_REFERENCE_WORKER: 'false', ENABLE_FAILPOINTS: 'true', FAILPOINTS: 'outbox.after-publish:kill', OUTBOX_LEASE_MS: '2500' });
    await doomed.exited;
    expect(doomed.proc.signalCode).toBe('SIGKILL');
    expect(await outboxPending()).toBe(14); // morreu antes de marcar QUALQUER evento
    expect((await queueDepth(q.sqs, q.urls.events)).visible).toBeGreaterThanOrEqual(1); // mas já havia publicado um

    await spawn('pub-rescuer', q, { RUN_HTTP: 'false', RUN_CONSUMER: 'false', RUN_PENDING_REFERENCE_WORKER: 'false', OUTBOX_LEASE_MS: '2500' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 60_000, message: 'outra instância assumiu após o lease' });
    const messages = await drainQueue(q.sqs, q.urls.events, { max: 1000, waitMs: 15_000 });
    const got = new Set(messages.map((m) => JSON.parse(m.Body!).eventId as string));
    for (const id of expectedIds) expect(got.has(id)).toBe(true); // todos chegaram (duplicata, se houver, é segura: mesmo eventId)
    await stopAll();
  }, 120_000);
});

describe('reinício do serviço com comprovação da consistência final', () => {
  test('queda TOTAL (kill -9 em todas as instâncias) com carga SQS + HTTP em andamento; novas instâncias convergem para o estado exato', async () => {
    await stopAll();
    const q = await createTestQueues();
    const sqsWallets = await Promise.all(Array.from({ length: 6 }, () => newWallet(h, '1000.00')));
    const httpWallets = await Promise.all(Array.from({ length: 6 }, () => newWallet(h, '1000.00')));
    await sendMessages(q.sqs, q.urls.transactions, sqsWallets.flatMap((w) => Array.from({ length: 20 }, () => wagerMessage(w, 'BET', '1.00'))));

    let live = await spawnMany(['R1', 'R2', 'R3'], q, { CONSUMER_CONCURRENCY: '2', CONSUMER_MAX_ATTEMPTS: '8', OUTBOX_LEASE_MS: '3000' });
    const ops = httpWallets.flatMap((w) => Array.from({ length: 10 }, () => httpBody(w, 'BET', '1.00')));

    // clientes realistas: repetem o MESMO pedido (mesma Idempotency-Key) até receberem resposta definitiva
    const settled: number[] = [];
    const client = async (op: Record<string, any>, i: number) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const alive = live.filter((x) => x.baseUrl && x.proc.exitCode === null && x.proc.signalCode === null);
        const base = (alive.length ? alive : live)[(i + attempt) % Math.max(1, (alive.length ? alive : live).length)]!.baseUrl!;
        try {
          const r = await post(base, op);
          if (r.status === 201 || r.status === 422) { settled.push(r.status); return r; }
        } catch { /* conexão recusada/derrubada: tenta de novo */ }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('cliente desistiu');
    };
    const clients = ops.map((op, i) => client(op, i));

    await new Promise((r) => setTimeout(r, 1500)); // deixa a carga andar um pouco...
    await Promise.all(live.map((i) => i.stop('SIGKILL'))); // ...e derruba TUDO sem cleanup
    expect(live.every((i) => i.proc.signalCode === 'SIGKILL')).toBe(true);

    const fresh = await spawnMany(['N1', 'N2'], q, { CONSUMER_CONCURRENCY: '2', CONSUMER_MAX_ATTEMPTS: '8', OUTBOX_LEASE_MS: '3000' });
    live = fresh;
    await Promise.all(clients); // todas as operações HTTP terminam (replays seguros após a queda)
    expect(settled).toHaveLength(ops.length);
    expect(settled.every((s) => s === 201)).toBe(true);

    await waitFor(idle(q), { timeoutMs: 150_000, intervalMs: 500, message: 'fila SQS drenada após a recuperação' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 90_000, message: 'outbox drenada após a recuperação' });

    for (const w of sqsWallets) {
      expect(await balance(w.id)).toBe('980.00');
      expect(await debits(w.id)).toBe(20);
    }
    for (const w of httpWallets) {
      expect(await balance(w.id)).toBe('990.00');
      expect(await debits(w.id)).toBe(10);
    }
    expect(await num(`SELECT count(*)::int AS n FROM wager_transactions WHERE kind = 'BET' AND wallet_id = ANY($1::uuid[])`, [[...sqsWallets, ...httpWallets].map((w) => w.id)])).toBe(6 * 20 + 6 * 10);
    expect(await drainQueue(q.sqs, q.urls.dlq, { waitMs: 1500 })).toHaveLength(0);
    await assertLedgerInvariant(db.url); // wallet.balance == saldo reconstruído pelo ledger, em TODAS as wallets
  }, 360_000);
});
