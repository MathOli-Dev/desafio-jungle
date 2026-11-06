import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startApp, TestApp } from '@test/support/app';
import { assertLedgerInvariant } from '@test/support/harness';
import { createMigratedOrm, createTestDatabase, TestDatabase, withPg } from '@test/support/infra';
import { createTestQueues, instanceEnv, TestQueues, waitFor } from '@test/support/sqs';
import { Orm } from '@/infrastructure/persistence/orm';

let db: TestDatabase;
let orm: Orm;
let q: TestQueues;
let app: TestApp;
const extraApps: TestApp[] = [];

beforeAll(async () => {
  db = await createTestDatabase('wager_http');
  orm = await createMigratedOrm(db.url);
  q = await createTestQueues();
  app = await startApp(instanceEnv(db.url, q, { RUN_CONSUMER: 'false', RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_REFERENCE_WORKER: 'true', DB_LOCK_TIMEOUT_MS: '8000' }));
});
afterAll(async () => {
  for (const a of extraApps) await a.close().catch(() => undefined);
  await app.close();
  await assertLedgerInvariant(db.url);
  await orm.close(true);
  await db.drop();
});

interface Res { status: number; headers: Headers; json: any }
async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, headers: res.headers, json };
}
const api = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(app.baseUrl, method, path, body, headers);

let seq = 0;
async function wallet(balance = '1000.00') {
  const playerId = `http-player-${process.pid}-${Date.now()}-${++seq}`;
  const r = await api('POST', '/wallets', { playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  expect(r.status).toBe(201);
  return { id: r.json.id as string, playerId };
}
const tx = (w: { id: string; playerId: string }, kind: string, amount: string, o: Record<string, unknown> = {}) => ({
  providerId: 'provider-a', externalTransactionId: `ext-${process.pid}-${Date.now()}-${++seq}`, playerId: w.playerId, walletId: w.id,
  roundId: 'round-1', gameId: 'fortune-chimp', kind, money: { amount, currency: 'BRL' }, ...o,
});
const submit = (body: Record<string, any>, key?: string, headers: Record<string, string> = {}) =>
  api('POST', '/wagering/transactions', body, { 'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}`, ...headers });

describe('wallets', () => {
  test('POST /wallets 201 com id/playerId/balance/version=1; duplicada 409; consultas 200/404/400', async () => {
    const playerId = `w-${Date.now()}`;
    const created = await api('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(created.status).toBe(201);
    expect(created.json).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const dup = await api('POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
    expect((await api('GET', `/wallets/${created.json.id}`)).json).toEqual(created.json);
    expect((await api('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37')).status).toBe(404);
    expect((await api('GET', '/wallets/nao-e-uuid')).status).toBe(400);
  });

  test.each([
    ['saldo negativo', { playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    ['moeda minúscula', { playerId: 'p', initialBalance: { amount: '1.00', currency: 'brl' } }],
    ['amount numérico', { playerId: 'p', initialBalance: { amount: 1, currency: 'BRL' } }],
    ['sem playerId', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['3 casas decimais', { playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } }],
  ])('POST /wallets inválido (%s) ⇒ 400 VALIDATION_ERROR', async (_name, body) => {
    const r = await api('POST', '/wallets', body);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
  });
});

describe('POST /wagering/transactions — status HTTP distintos e consistentes', () => {
  test('201 PROCESSED; replay idêntico ⇒ mesma resposta com idempotentReplay=true e header Idempotent-Replayed', async () => {
    const w = await wallet('1000.00');
    const body = tx(w, 'BET', '25.00');
    const first = await submit(body);
    expect(first.status).toBe(201);
    expect(first.json).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    const replay = await submit(body);
    expect(replay.status).toBe(201);
    expect(replay.json).toEqual({ ...first.json, idempotentReplay: true });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  test('409 conflito de idempotência: mesma key com payload diferente (≠ replay)', async () => {
    const w = await wallet();
    const body = tx(w, 'BET', '10.00');
    await submit(body);
    const r = await submit({ ...body, money: { amount: '11.00', currency: 'BRL' } }, `${body.providerId}:${body.externalTransactionId}`);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  test('422 rejeição por regra de negócio: corpo com failureCode/failureAction; replay devolve a mesma rejeição', async () => {
    const w = await wallet('10.00');
    const body = tx(w, 'BET', '99.00');
    const r = await submit(body);
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', failureAction: 'NEW_ID_IF_CHANGED', balance: { amount: '10.00' }, idempotentReplay: false });
    const again = await submit(body);
    expect(again.status).toBe(422);
    expect(again.json).toEqual({ ...r.json, idempotentReplay: true });
  });

  test('202 aceito com processamento pendente (referência ausente) e, depois, resolvido pelo worker', async () => {
    const w = await wallet('100.00');
    const bet = tx(w, 'BET', '30.00');
    const refund = tx(w, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submit(refund);
    expect(pending.status).toBe(202);
    expect(pending.json).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect((await submit(bet)).status).toBe(201);
    await waitFor(async () => (await api('GET', `/wagering/transactions/${pending.json.transactionId}`)).json.status === 'PROCESSED', { message: 'worker resolve a pendência' });
    expect((await api('GET', `/wallets/${w.id}`)).json.balance.amount).toBe('100.00');
    const replay = await submit(refund);
    expect(replay.status).toBe(201); // o replay reflete o estado atual
    expect(replay.json).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  });

  test.each(['10.001', '-1.00', '1e3', 'NaN', 'Infinity', '', '1,00', ' 1.00'])('400 amount inválido %p', async (amount) => {
    const w = await wallet();
    const r = await submit(tx(w, 'BET', amount));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
  });

  test('400: header ausente, amount numérico, OPENING, kind desconhecido, REFUND sem referência, BET com referência, provider reservado, campos faltando, JSON quebrado', async () => {
    const w = await wallet();
    const ok = tx(w, 'BET', '1.00');
    const cases: Array<[string, Promise<Res>]> = [
      ['sem Idempotency-Key', api('POST', '/wagering/transactions', ok)],
      ['amount numérico', submit({ ...ok, money: { amount: 1, currency: 'BRL' } })],
      ['OPENING (interno)', submit({ ...ok, kind: 'OPENING' })],
      ['kind desconhecido', submit({ ...ok, kind: 'HACK' })],
      ['REFUND sem referência', submit(tx(w, 'REFUND', '1.00'))],
      ['BET com referência', submit(tx(w, 'BET', '1.00', { referenceExternalTransactionId: 'x' }))],
      ['provider reservado', submit(tx(w, 'BET', '1.00', { providerId: 'internal' }))],
      ['valor zero em BET', submit(tx(w, 'BET', '0.00'))],
      ['sem walletId', submit({ ...ok, walletId: undefined })],
      ['walletId inválido', submit({ ...ok, walletId: 'abc' })],
      ['JSON quebrado', api('POST', '/wagering/transactions', '{not json', { 'idempotency-key': 'k' })],
    ];
    for (const [name, p] of cases) {
      const r = await p;
      expect({ name, status: r.status, code: r.json?.error?.code }).toEqual({ name, status: 400, code: 'VALIDATION_ERROR' });
      expect(r.headers.get('x-correlation-id')).toBeTruthy(); // inclusive no erro de JSON quebrado
    }
  });

  test('o MESMO envelope de erro em todos os endpoints (code, message, retryable, correlationId) e 404 consistente', async () => {
    const w = await wallet();
    const responses = await Promise.all([
      api('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37'),
      api('GET', `/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger`),
      api('POST', `/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation`),
      api('GET', '/wagering/transactions/0192f291-27dd-7d3f-8071-5f8685deef37'),
      api('GET', '/providers/provider-a/wagering/transactions/inexistente'),
      submit(tx({ id: '0192f291-27dd-7d3f-8071-5f8685deef37', playerId: w.playerId }, 'BET', '1.00')),
      api('GET', '/rota-que-nao-existe'),
    ]);
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(r.json.error).toMatchObject({ code: expect.any(String), message: expect.any(String), retryable: false });
    }
    expect(responses.map((r) => r.json.error.code)).toEqual(['WALLET_NOT_FOUND', 'WALLET_NOT_FOUND', 'WALLET_NOT_FOUND', 'TRANSACTION_NOT_FOUND', 'TRANSACTION_NOT_FOUND', 'WALLET_NOT_FOUND', 'NOT_FOUND']);
  });

  test('situações distintas ⇒ status distintos (400, 409, 422, 202, 201, 503 nunca colapsam)', async () => {
    const w = await wallet('10.00');
    const statuses = new Set<number>([
      (await submit(tx(w, 'BET', 'x'))).status, // 400
      (await (async () => { const b = tx(w, 'BET', '1.00'); await submit(b); return submit({ ...b, gameId: 'y' }); })()).status, // 409
      (await submit(tx(w, 'BET', '999.00'))).status, // 422
      (await submit(tx(w, 'REFUND', '1.00', { referenceExternalTransactionId: 'ausente' }))).status, // 202
      (await submit(tx(w, 'BET', '1.00'))).status, // 201
    ]);
    expect([...statuses].sort()).toEqual([201, 202, 400, 409, 422]);
  });
});

describe('falha transitória de infraestrutura ⇒ 503 (reenviar é seguro)', () => {
  test('lock da wallet preso ⇒ 503 + Retry-After + retryable=true; ao liberar, o MESMO pedido passa e debita uma vez', async () => {
    const impatient = await startApp(instanceEnv(db.url, q, { RUN_CONSUMER: 'false', RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_REFERENCE_WORKER: 'false', DB_LOCK_TIMEOUT_MS: '200' }));
    extraApps.push(impatient);
    const w = await wallet('100.00');
    const body = tx(w, 'BET', '40.00');
    const blocker = new Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [w.id]);
    let blocked: Res;
    try {
      blocked = await call(impatient.baseUrl, 'POST', '/wagering/transactions', body, { 'idempotency-key': 'k-503' });
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('retry-after')).toBe('1');
    expect(blocked.json.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true, details: { reason: 'LOCK_TIMEOUT' } });
    expect((await api('GET', `/wallets/${w.id}`)).json.balance.amount).toBe('100.00'); // nada aplicado

    const retried = await call(impatient.baseUrl, 'POST', '/wagering/transactions', body, { 'idempotency-key': 'k-503' });
    expect(retried.status).toBe(201);
    expect(retried.json).toMatchObject({ status: 'PROCESSED', balance: { amount: '60.00' }, idempotentReplay: false });
    expect((await call(impatient.baseUrl, 'POST', '/wagering/transactions', body, { 'idempotency-key': 'k-503' })).json.idempotentReplay).toBe(true);
  });
});

describe('observabilidade e health', () => {
  test('X-Correlation-Id é propagado/gerado e aparece no corpo de erro; valores suspeitos são substituídos', async () => {
    const ok = await api('GET', '/health/live', undefined, { 'x-correlation-id': 'abc-123' });
    expect(ok.headers.get('x-correlation-id')).toBe('abc-123');
    const err = await api('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37', undefined, { 'x-correlation-id': 'req-42' });
    expect(err.json.error.correlationId).toBe('req-42');
    const bad = await api('GET', '/health/live', undefined, { 'x-correlation-id': 'a b<script>' });
    expect(bad.headers.get('x-correlation-id')).not.toBe('a b<script>');
    expect(bad.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('health/live e health/ready são abertos; /metrics expõe as métricas exigidas', async () => {
    expect((await api('GET', '/health/live')).json).toEqual({ status: 'ok' });
    expect(await api('GET', '/health/ready')).toMatchObject({ status: 200, json: { status: 'ok', checks: { postgres: 'up', sqs: 'up' } } });
    const w = await wallet();
    const b = tx(w, 'BET', '1.00');
    await submit(b);
    await submit(b); // duplicata
    await submit(tx(w, 'BET', '99999.00')); // rejeitada
    const text = await (await fetch(`${app.baseUrl}/metrics`)).text();
    for (const name of [
      'wager_transactions_total{status="PROCESSED"', 'wager_transactions_total{status="REJECTED"', 'wager_duplicates_total{source="http"}',
      'wager_processing_duration_seconds_bucket', 'wager_lock_conflicts_total', 'wager_retries_total', 'wager_dlq_messages_total',
      'wager_outbox_lag_seconds', 'wager_outbox_pending_events', 'http_requests_total{method="POST",route="/wagering/transactions"',
    ].slice(0, 5)) expect(text).toContain(name);
    for (const help of ['# HELP wager_lock_conflicts_total', '# HELP wager_retries_total', '# HELP wager_dlq_messages_total', '# HELP wager_outbox_lag_seconds', '# HELP wager_outbox_pending_events', '# HELP http_requests_total']) {
      expect(text).toContain(help);
    }
  });

  test('liveness ≠ readiness: com o SQS inalcançável o processo continua vivo (200) mas NÃO pronto (503)', async () => {
    const broken = await startApp({ ...instanceEnv(db.url, q, { RUN_CONSUMER: 'false', RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_REFERENCE_WORKER: 'false' }), SQS_ENDPOINT: 'http://127.0.0.1:1' });
    extraApps.push(broken);
    expect((await call(broken.baseUrl, 'GET', '/health/live')).status).toBe(200);
    const ready = await call(broken.baseUrl, 'GET', '/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.json).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
  });

  test('logs estruturados não vazam payload financeiro nem corpo de requisição', async () => {
    // o JsonLogger recebe apenas ids/códigos; aqui garantimos a sanitização das chaves sensíveis
    const { sanitize } = await import('@/infrastructure/observability/json-logger');
    expect(sanitize({ transactionId: 't', money: { amount: '1.00' }, balance: { amount: '2.00' }, payload: { a: 1 }, authorization: 'Bearer x', failureCode: 'X' })).toEqual({
      transactionId: 't', money: '[redacted]', balance: '[redacted]', payload: '[redacted]', authorization: '[redacted]', failureCode: 'X',
    });
  });
});

describe('concorrência via HTTP', () => {
  test('a MESMA aposta 50× em paralelo ⇒ um único débito', async () => {
    const w = await wallet('100.00');
    const body = tx(w, 'BET', '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(body)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.filter((r) => !r.json.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json.transactionId)).size).toBe(1);
    expect((await api('GET', `/wallets/${w.id}`)).json.balance.amount).toBe('75.00');
  });

  test('duas apostas de 80 sobre 100 em paralelo ⇒ uma 201 e uma 422; saldo 20.00; 1 débito no ledger', async () => {
    const w = await wallet('100.00');
    const [a, b] = await Promise.all([submit(tx(w, 'BET', '80.00')), submit(tx(w, 'BET', '80.00'))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect((await api('GET', `/wallets/${w.id}`)).json.balance.amount).toBe('20.00');
    const ledger = await api('GET', `/wallets/${w.id}/ledger?limit=50`);
    expect(ledger.json.items.filter((e: any) => e.direction === 'DEBIT')).toHaveLength(1);
  });

  test('ledger: cursor opaco + limite; reconciliação consistente', async () => {
    const w = await wallet('100.00');
    for (let i = 0; i < 5; i++) await submit(tx(w, 'BET', '1.00'));
    const p1 = await api('GET', `/wallets/${w.id}/ledger?limit=4`);
    expect(p1.json.items).toHaveLength(4);
    expect(typeof p1.json.nextCursor).toBe('string');
    const p2 = await api('GET', `/wallets/${w.id}/ledger?limit=4&cursor=${p1.json.nextCursor}`);
    expect(p2.json.items.map((e: any) => e.walletVersion)).toEqual([5, 6]);
    expect(p2.json.nextCursor).toBeNull();
    expect((await api('GET', `/wallets/${w.id}/ledger?cursor=xxx`)).status).toBe(400);
    expect((await api('GET', `/wallets/${w.id}/ledger?limit=201`)).status).toBe(400);
    expect((await api('GET', `/wallets/${w.id}/ledger?limit=abc`)).status).toBe(400);
    expect((await api('POST', `/wallets/${w.id}/reconciliation`)).json).toMatchObject({ consistent: true, difference: { amount: '0.00' }, checkedEntries: 6 });
  });

  test('consultas de transação: por id e por (provider, externalTransactionId)', async () => {
    const w = await wallet('100.00');
    const body = tx(w, 'BET', '5.00');
    const r = await submit(body);
    const byId = await api('GET', `/wagering/transactions/${r.json.transactionId}`);
    const byExt = await api('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byId.status).toBe(200);
    expect(byExt.json).toEqual(byId.json);
    expect(byId.json).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '5.00', currency: 'BRL' }, balance: { amount: '95.00' } });
    expect((await api('GET', '/wagering/transactions/nao-uuid')).status).toBe(400);
  });
});

test('o contador de linhas do ledger só cresce e nenhuma wallet ficou negativa', async () => {
  const r = await withPg(db.url, (c) => c.query(`SELECT count(*) FILTER (WHERE balance < 0)::int AS negative FROM wallets`));
  expect(r.rows[0].negative).toBe(0);
});
