import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { uuidv7 } from '@/domain/shared/uuid';
import { Orm } from '@/infrastructure/persistence/orm';
import { startApp, TestApp } from '@test/support/app';
import { assertLedgerInvariant, buildHarness, Harness, newWallet } from '@test/support/harness';
import { createMigratedOrm, createTestDatabase, TestDatabase, withPg } from '@test/support/infra';
import { createTestQueues, drainQueue, instanceEnv, queueDepth, sendMessages, TestQueues, waitFor, wagerMessage } from '@test/support/sqs';

let db: TestDatabase;
let orm: Orm;
let h: Harness;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = await createTestDatabase('wager_sqs');
  orm = await createMigratedOrm(db.url);
  h = buildHarness(orm);
});
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => undefined);
  await assertLedgerInvariant(db.url);
  await orm.close(true);
  await db.drop();
});

/** Sobe uma instância (consumer on; publisher/pending off) com filas próprias. */
async function consumerApp(extra: Record<string, string> = {}): Promise<{ app: TestApp; q: TestQueues }> {
  const q = await createTestQueues();
  const app = await startApp(instanceEnv(db.url, q, { RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_REFERENCE_WORKER: 'false', ...extra }));
  cleanups.push(() => app.close());
  return { app, q };
}

const txRow = async (provider: string, ext: string) =>
  (await withPg(db.url, (c) => c.query(`SELECT status, failure_code, balance_observed::text AS balance FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2`, [provider, ext]))).rows[0] as
    | { status: string; failure_code: string | null; balance: string | null }
    | undefined;
const walletBalance = async (id: string) => (await h.walletQueries.getWallet(id)).balance.amount;
const queueIdle = (q: TestQueues) => async () => {
  const d = await queueDepth(q.sqs, q.urls.transactions);
  return d.visible === 0 && d.inFlight === 0;
};
const metric = async (app: TestApp, name: string) => {
  const text = await (await fetch(`${app.baseUrl}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(name));
  return line ? Number(line.split(' ').pop()) : 0;
};
const debits = (walletId: string) =>
  withPg(db.url, (c) => c.query(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`, [walletId])).then((r) => r.rows[0].n as number);

describe('consumidor SQS — caminho feliz, ack e deduplicação', () => {
  test('processa a mensagem: efeito no banco + inbox, e o ACK só acontece depois do commit', async () => {
    const { q } = await consumerApp();
    const w = await newWallet(h, '100.00');
    const m = wagerMessage(w, 'BET', '30.00', { externalTransactionId: 'happy-1', messageId: 'msg-happy-1' });
    await sendMessages(q.sqs, q.urls.transactions, [m]);

    await waitFor(async () => (await txRow('provider-a', 'happy-1'))?.status === 'PROCESSED', { message: 'BET processada' });
    await waitFor(queueIdle(q), { message: 'mensagem removida da fila' });
    expect(await walletBalance(w.id)).toBe('70.00');
    const inbox = await withPg(db.url, (c) => c.query(`SELECT processed_at FROM inbox_messages WHERE consumer_name = 'wager-transactions-consumer' AND message_id = 'msg-happy-1'`));
    expect(inbox.rows[0].processed_at).not.toBeNull();
  });

  test('redelivery: o MESMO messageId entregue duas vezes não duplica o efeito e ambas as entregas são ackadas', async () => {
    const { app, q } = await consumerApp();
    const w = await newWallet(h, '100.00');
    const m = wagerMessage(w, 'BET', '30.00', { externalTransactionId: 'dup-1', messageId: 'msg-dup-1' });
    await sendMessages(q.sqs, q.urls.transactions, [m, m, m]); // 3 entregas do mesmo messageId (dedup ids distintos)
    await waitFor(queueIdle(q), { message: 'fila drenada' });
    expect(await walletBalance(w.id)).toBe('70.00');
    expect(await debits(w.id)).toBe(1);
    expect(await metric(app, 'wager_sqs_messages_total{result="duplicate"}')).toBeGreaterThanOrEqual(1);
  });

  test('mesma operação de negócio com messageIds DIFERENTES: a idempotency key impede o duplo débito', async () => {
    const { q } = await consumerApp();
    const w = await newWallet(h, '100.00');
    const base = { externalTransactionId: 'biz-dup-1' };
    await sendMessages(q.sqs, q.urls.transactions, [wagerMessage(w, 'BET', '30.00', { ...base, messageId: 'm-a' }), wagerMessage(w, 'BET', '30.00', { ...base, messageId: 'm-b' })]);
    await waitFor(queueIdle(q));
    expect(await walletBalance(w.id)).toBe('70.00');
    expect(await debits(w.id)).toBe(1);
  });

  test('rejeição por regra de negócio é TERMINAL: REJECTED persistido + ack (sem retry e sem DLQ)', async () => {
    const { q } = await consumerApp();
    const w = await newWallet(h, '10.00');
    await sendMessages(q.sqs, q.urls.transactions, [wagerMessage(w, 'BET', '99.00', { externalTransactionId: 'biz-rej-1' })]);
    await waitFor(async () => (await txRow('provider-a', 'biz-rej-1'))?.status === 'REJECTED');
    await waitFor(queueIdle(q));
    expect(await txRow('provider-a', 'biz-rej-1')).toMatchObject({ failure_code: 'INSUFFICIENT_FUNDS', balance: '10.00' });
    expect(await drainQueue(q.sqs, q.urls.dlq, { waitMs: 1500 })).toHaveLength(0);
  });

  test('ordem por MessageGroupId: WIN antes de BET na mesma wallet (saldo 0) — a BET só passa porque a ordem foi respeitada', async () => {
    const { q } = await consumerApp();
    const w = await newWallet(h, '0.00');
    await sendMessages(q.sqs, q.urls.transactions, [
      wagerMessage(w, 'WIN', '50.00', { externalTransactionId: 'ord-1' }),
      wagerMessage(w, 'BET', '40.00', { externalTransactionId: 'ord-2' }),
      wagerMessage(w, 'BET', '10.00', { externalTransactionId: 'ord-3' }),
    ]);
    await waitFor(queueIdle(q));
    expect((await txRow('provider-a', 'ord-2'))?.status).toBe('PROCESSED');
    expect((await txRow('provider-a', 'ord-3'))?.status).toBe('PROCESSED');
    expect(await walletBalance(w.id)).toBe('0.00');
  });
});

describe('consumidor SQS — erros permanentes vão para a DLQ (sem perder a mensagem)', () => {
  test('JSON inválido, contrato inválido, conflito de idempotência e wallet inexistente', async () => {
    const { q } = await consumerApp();
    const w = await newWallet(h, '100.00');
    const ok = wagerMessage(w, 'BET', '10.00', { externalTransactionId: 'dlq-ok', idempotencyKey: 'provider-a:dlq-key' });
    await sendMessages(q.sqs, q.urls.transactions, [ok]);
    await waitFor(async () => (await txRow('provider-a', 'dlq-ok'))?.status === 'PROCESSED');

    const conflict = wagerMessage(w, 'BET', '11.00', { externalTransactionId: 'dlq-ok', idempotencyKey: 'provider-a:dlq-key' }); // mesma key, valor diferente
    const noWallet = wagerMessage({ id: uuidv7(), playerId: 'x' }, 'BET', '1.00');
    const opening = JSON.parse(wagerMessage(w, 'BET', '1.00').body);
    opening.data.kind = 'OPENING';
    await sendMessages(q.sqs, q.urls.transactions, [
      { messageId: 'bad-json', groupId: 'g-bad', body: '{isto não é json' },
      { messageId: 'opening', groupId: 'g-opening', body: JSON.stringify(opening) },
      conflict,
      noWallet,
    ]);
    const dead = await drainQueue(q.sqs, q.urls.dlq, { max: 4, waitMs: 20_000 });
    const reasons = dead.map((m) => m.MessageAttributes?.FailureReason?.StringValue).sort();
    expect(reasons).toEqual(['IDEMPOTENCY_CONFLICT', 'MALFORMED_MESSAGE', 'MALFORMED_MESSAGE', 'WALLET_NOT_FOUND']);
    expect(dead.every((m) => m.MessageAttributes?.OriginalMessageId?.StringValue)).toBe(true);
    await waitFor(queueIdle(q));
    expect(await walletBalance(w.id)).toBe('90.00'); // só a BET original foi aplicada
  });

  test('erro inesperado persistente: tentativas esgotadas ⇒ transação FAILED auditável + DLQ; saldo intacto', async () => {
    const { q, app } = await consumerApp({ ENABLE_FAILPOINTS: 'true', FAILPOINTS: 'submit.before-commit:throw', CONSUMER_MAX_ATTEMPTS: '2', CONSUMER_BACKOFF_BASE_S: '0' });
    const w = await newWallet(h, '100.00');
    await sendMessages(q.sqs, q.urls.transactions, [wagerMessage(w, 'BET', '25.00', { externalTransactionId: 'failed-1' })]);
    const dead = await drainQueue(q.sqs, q.urls.dlq, { max: 1, waitMs: 20_000 });
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.FailureReason?.StringValue).toBe('UNEXPECTED_ERROR_RETRIES_EXHAUSTED');
    expect(await txRow('provider-a', 'failed-1')).toMatchObject({ status: 'FAILED', failure_code: 'INFRASTRUCTURE_FAILURE' });
    expect(await walletBalance(w.id)).toBe('100.00');
    expect(await metric(app, 'wager_dlq_messages_total{reason="UNEXPECTED_ERROR_RETRIES_EXHAUSTED"}')).toBe(1);
    expect(await metric(app, 'wager_retries_total{component="sqs-consumer"}')).toBeGreaterThanOrEqual(1);
  });
});

describe('consumidor SQS — falhas transitórias e queda do worker', () => {
  test('lock timeout (transitório) ⇒ retry com backoff; ao liberar, processa UMA vez', async () => {
    const { q, app } = await consumerApp({ DB_LOCK_TIMEOUT_MS: '300', CONSUMER_MAX_ATTEMPTS: '8', CONSUMER_BACKOFF_BASE_S: '1' });
    const w = await newWallet(h, '100.00');
    const { Client } = await import('pg');
    const blocker = new Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [w.id]); // segura o lock da wallet
    try {
      await sendMessages(q.sqs, q.urls.transactions, [wagerMessage(w, 'BET', '40.00', { externalTransactionId: 'transient-1' })]);
      await waitFor(async () => (await metric(app, 'wager_retries_total{component="sqs-consumer"}')) >= 1, { timeoutMs: 30_000, message: 'ao menos um retry de backoff' });
      expect(await txRow('provider-a', 'transient-1')).toBeUndefined(); // nada aplicado enquanto bloqueado
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    await waitFor(async () => (await txRow('provider-a', 'transient-1'))?.status === 'PROCESSED', { timeoutMs: 30_000, message: 'processada após liberar o lock' });
    await waitFor(queueIdle(q));
    expect(await walletBalance(w.id)).toBe('60.00');
    expect(await debits(w.id)).toBe(1);
    expect(await drainQueue(q.sqs, q.urls.dlq, { waitMs: 1000 })).toHaveLength(0);
  });

  test('falha DEPOIS do commit e ANTES do ack: a mensagem volta, a inbox absorve e o efeito não duplica', async () => {
    const { q } = await consumerApp({ ENABLE_FAILPOINTS: 'true', FAILPOINTS: 'consumer.after-commit:throw-once', CONSUMER_BACKOFF_BASE_S: '1' });
    const w = await newWallet(h, '100.00');
    await sendMessages(q.sqs, q.urls.transactions, [wagerMessage(w, 'BET', '30.00', { externalTransactionId: 'after-commit-1', messageId: 'msg-after-commit-1' })]);
    await waitFor(async () => (await txRow('provider-a', 'after-commit-1'))?.status === 'PROCESSED');
    await waitFor(queueIdle(q), { timeoutMs: 30_000, message: 'segunda entrega ackada' });
    expect(await walletBalance(w.id)).toBe('70.00');
    expect(await debits(w.id)).toBe(1);
  });

  test('shutdown gracioso no meio da carga: nada se perde e nada duplica quando outra instância assume', async () => {
    const q = await createTestQueues();
    const env = instanceEnv(db.url, q, { RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_REFERENCE_WORKER: 'false', CONSUMER_CONCURRENCY: '3' });
    const a = await startApp(env);
    const wallets = await Promise.all(Array.from({ length: 8 }, () => newWallet(h, '1000.00')));
    const messages = wallets.flatMap((w) => Array.from({ length: 6 }, () => wagerMessage(w, 'BET', '5.00')));
    await sendMessages(q.sqs, q.urls.transactions, messages);
    await waitFor(async () => (await withPg(db.url, (c) => c.query(`SELECT count(*)::int AS n FROM inbox_messages`))).rows[0].n >= 6, { message: 'processamento começou' });
    await a.close(); // SIGTERM equivalente: conclui as em andamento e devolve a visibilidade do resto
    const b = await startApp(env);
    cleanups.push(() => b.close());
    await waitFor(queueIdle(q), { timeoutMs: 60_000, message: 'segunda instância drena a fila' });
    for (const w of wallets) {
      expect(await walletBalance(w.id)).toBe('970.00'); // 6 × 5.00 exatamente uma vez cada
      expect(await debits(w.id)).toBe(6);
    }
    expect(await drainQueue(q.sqs, q.urls.dlq, { waitMs: 1000 })).toHaveLength(0);
    await assertLedgerInvariant(db.url);
  });
});
