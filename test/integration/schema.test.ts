import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { uuidv7 } from '@/domain/shared/uuid';
import { createOrm, migrateDown, migrateUp, Orm } from '@/infrastructure/persistence/orm';
import { createTestDatabase, TestDatabase, testDbConfig, withPg } from '@test/support/infra';

const HASH = 'a'.repeat(64);
let db: TestDatabase;
let orm: Orm;

beforeAll(async () => {
  db = await createTestDatabase('wager_schema');
  orm = await createOrm(testDbConfig(db.url));
});
afterAll(async () => {
  await orm.close(true);
  await db.drop();
});

const tables = (c: Client) =>
  c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`).then((r) => r.rows.map((x) => x.table_name as string));

describe('migrations versionadas e reversíveis', () => {
  test('up → down (uma a uma) → up de novo', async () => {
    const applied = await migrateUp(orm);
    expect(applied).toHaveLength(4);
    await withPg(db.url, async (c) => {
      expect(await tables(c)).toEqual(expect.arrayContaining(['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages']));
    });

    expect(await migrateUp(orm)).toHaveLength(0); // idempotente

    const reverted = await migrateDown(orm);
    expect(reverted).toEqual(['Migration20260801000004_inbox_outbox']);
    await withPg(db.url, async (c) => {
      const t = await tables(c);
      expect(t).not.toContain('outbox_messages');
      expect(t).toContain('wallet_ledger_entries');
    });

    await migrateDown(orm, { all: true });
    await withPg(db.url, async (c) => {
      const t = await tables(c);
      for (const name of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages']) expect(t).not.toContain(name);
      const fns = await c.query(`SELECT proname FROM pg_proc WHERE proname IN ('wallets_guard','wager_transactions_guard','wallet_ledger_immutable','assert_wallet_matches_ledger')`);
      expect(fns.rowCount).toBe(0); // down não deixa lixo
    });

    expect(await migrateUp(orm)).toHaveLength(4);
  });
});

async function seedWallet(c: Client, balance = '100.00', currency = 'BRL') {
  const walletId = uuidv7();
  const txId = uuidv7();
  await c.query('BEGIN');
  await c.query(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES ($1,$2,$3,$4,1,now(),now())`, [walletId, `p-${walletId}`, currency, balance]);
  await c.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, balance_observed, created_at, processed_at)
     VALUES ($1,'internal',$2,$2,$3,$4,$5,'opening','opening','OPENING',$6,$7,'PROCESSED',$6,now(),now())`,
    [txId, `opening:${walletId}`, HASH, walletId, `p-${walletId}`, balance, currency],
  );
  await c.query(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
     VALUES ($1,$2,$3,1,'CREDIT',$4,$5,0,$4,now())`,
    [uuidv7(), walletId, txId, balance, currency],
  );
  await c.query('COMMIT');
  return { walletId, txId };
}

async function insertTx(c: Client, walletId: string, o: Partial<{ id: string; provider: string; ext: string; key: string; kind: string; amount: string; status: string; ref: string | null; refTx: string | null; processedAt: boolean }> = {}) {
  const id = o.id ?? uuidv7();
  const ext = o.ext ?? `ext-${id}`;
  const status = o.status ?? 'PROCESSED';
  await c.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, reference_transaction_id, status, failure_code, balance_observed, next_reference_check_at, created_at, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'p','r','g',$7,$8,'BRL',$9,$10,$11,$12,$13,$14,now(),$15)`,
    [
      id, o.provider ?? 'prov', ext, o.key ?? `key-${id}`, HASH, walletId, o.kind ?? 'BET', o.amount ?? '10.00', o.ref ?? null, o.refTx ?? null, status,
      status === 'REJECTED' || status === 'FAILED' ? 'INSUFFICIENT_FUNDS' : null,
      status === 'PROCESSED' ? '90.00' : null, status === 'PENDING_REFERENCE' ? new Date() : null,
      status === 'PROCESSED' ? new Date() : null,
    ],
  );
  return id;
}

describe('constraints do schema (PostgreSQL real)', () => {
  test('wallets: saldo negativo é rejeitado (CHECK) e duplicidade (player, currency) é conflito (UNIQUE)', async () => {
    await withPg(db.url, async (c) => {
      await expect(c.query(`INSERT INTO wallets VALUES ($1,'p','BRL',-0.01,1,now(),now())`, [uuidv7()])).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`INSERT INTO wallets VALUES ($1,'p','brl',1,1,now(),now())`, [uuidv7()])).rejects.toMatchObject({ code: '23514' });
      await c.query(`INSERT INTO wallets VALUES ($1,'dup','BRL',0,1,now(),now())`, [uuidv7()]);
      await expect(c.query(`INSERT INTO wallets VALUES ($1,'dup','BRL',0,1,now(),now())`, [uuidv7()])).rejects.toMatchObject({ code: '23505' });
      await c.query(`INSERT INTO wallets VALUES ($1,'dup','USD',0,1,now(),now())`, [uuidv7()]); // outra moeda pode
    });
  });

  test('wallets: UPDATE que deixaria saldo negativo falha no banco mesmo sem checagem de aplicação', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c, '10.00');
      await expect(c.query(`UPDATE wallets SET balance = -1, version = 2 WHERE id = $1`, [walletId])).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('wallets: version só incrementa (+1) quando o saldo muda; identidade é imutável; DELETE proibido', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c, '10.00');
      await expect(c.query(`UPDATE wallets SET balance = 5, version = 3 WHERE id = $1`, [walletId])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`UPDATE wallets SET version = 2 WHERE id = $1`, [walletId])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`UPDATE wallets SET player_id = 'other' WHERE id = $1`, [walletId])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`DELETE FROM wallets WHERE id = $1`, [walletId])).rejects.toMatchObject({ code: '23000' });
    });
  });

  test('ledger é append-only: UPDATE, DELETE e TRUNCATE são bloqueados por trigger', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c, '100.00');
      await expect(c.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = $1`, [walletId])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [walletId])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`TRUNCATE wallet_ledger_entries`)).rejects.toMatchObject({ code: '23000' });
      const r = await c.query(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1`, [walletId]);
      expect(r.rows[0].n).toBe(1);
    });
  });

  test('ledger: aritmética, valor positivo, versão única, 1 lançamento por (transação, wallet) e cadeia contínua', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c, '100.00');
      const tx = await insertTx(c, walletId);
      const entry = (o: { id?: string; tx: string; ver: number; dir: string; amt: string; before: string; after: string }) =>
        c.query(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at) VALUES ($1,$2,$3,$4,$5,$6,'BRL',$7,$8,now())`,
          [o.id ?? uuidv7(), walletId, o.tx, o.ver, o.dir, o.amt, o.before, o.after],
        );
      // aritmética errada (débito de 10 que "resulta" em 95)
      await expect(entry({ tx, ver: 2, dir: 'DEBIT', amt: '10.00', before: '100.00', after: '95.00' })).rejects.toMatchObject({ code: '23514' });
      // valor não positivo
      await expect(entry({ tx, ver: 2, dir: 'CREDIT', amt: '0.00', before: '100.00', after: '100.00' })).rejects.toMatchObject({ code: '23514' });
      // saldo que ficaria negativo
      await expect(entry({ tx, ver: 2, dir: 'DEBIT', amt: '150.00', before: '100.00', after: '-50.00' })).rejects.toMatchObject({ code: '23514' });
      // cadeia quebrada: balance_before não bate com o lançamento anterior
      await expect(entry({ tx, ver: 2, dir: 'DEBIT', amt: '10.00', before: '90.00', after: '80.00' })).rejects.toMatchObject({ code: '23000' });
      // versão não crescente
      await expect(entry({ tx, ver: 1, dir: 'DEBIT', amt: '10.00', before: '100.00', after: '90.00' })).rejects.toMatchObject({ code: '23000' });
    });
  });

  test('saldo materializado × ledger: verificado no COMMIT (wallet sem lançamento / lançamento sem wallet)', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c, '100.00');
      const tx = await insertTx(c, walletId);
      const ledgerInsert = () =>
        c.query(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at) VALUES ($1,$2,$3,2,'DEBIT',10,'BRL',100,90,now())`,
          [uuidv7(), walletId, tx],
        );
      const walletUpdate = () => c.query(`UPDATE wallets SET balance = 90, version = 2, updated_at = now() WHERE id = $1`, [walletId]);

      // 1) mexe só no saldo ⇒ COMMIT falha
      await c.query('BEGIN');
      await walletUpdate();
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23000' });

      // 2) lança só no ledger ⇒ COMMIT falha
      await c.query('BEGIN');
      await ledgerInsert();
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23000' });

      // 3) nada foi gravado pelos commits que falharam
      const before = await c.query(`SELECT balance::text, version FROM wallets WHERE id = $1`, [walletId]);
      expect(before.rows[0]).toEqual({ balance: '100.00', version: 1 });

      // 4) os dois juntos ⇒ commit OK
      await c.query('BEGIN');
      await ledgerInsert();
      await walletUpdate();
      await c.query('COMMIT');
      const after = await c.query(`SELECT balance::text, version FROM wallets WHERE id = $1`, [walletId]);
      expect(after.rows[0]).toEqual({ balance: '90.00', version: 2 });
    });
  });

  test('wager_transactions: unicidade por (provider, externalId) e (provider, idempotency key); mesma key em outro provider pode', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c);
      await insertTx(c, walletId, { provider: 'a', ext: 'x-1', key: 'k-1' });
      await expect(insertTx(c, walletId, { provider: 'a', ext: 'x-1', key: 'k-2' })).rejects.toMatchObject({ code: '23505' });
      await expect(insertTx(c, walletId, { provider: 'a', ext: 'x-2', key: 'k-1' })).rejects.toMatchObject({ code: '23505' });
      await insertTx(c, walletId, { provider: 'b', ext: 'x-1', key: 'k-1' });
    });
  });

  test('wager_transactions: kinds/valores/referência/OPENING interno', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c);
      await expect(insertTx(c, walletId, { kind: 'HACK' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertTx(c, walletId, { kind: 'BET', amount: '0.00' })).rejects.toMatchObject({ code: '23514' });
      await insertTx(c, walletId, { kind: 'LOSS', amount: '0.00' });
      await expect(insertTx(c, walletId, { kind: 'REFUND', ref: null })).rejects.toMatchObject({ code: '23514' });
      await expect(insertTx(c, walletId, { kind: 'OPENING', provider: 'prov' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertTx(c, walletId, { kind: 'BET', provider: 'internal' })).rejects.toMatchObject({ code: '23514' });
    });
  });

  test('wager_transactions: estados terminais não mudam e não há DELETE; PENDING_REFERENCE não volta a PENDING', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c);
      const processed = await insertTx(c, walletId, { status: 'PROCESSED' });
      const rejected = await insertTx(c, walletId, { status: 'REJECTED' });
      const failed = await insertTx(c, walletId, { status: 'FAILED' });
      for (const id of [processed, rejected, failed]) {
        await expect(c.query(`UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`UPDATE wager_transactions SET balance_observed = 1 WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23000' });
        await expect(c.query(`DELETE FROM wager_transactions WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23000' });
      }
      const pending = await insertTx(c, walletId, { status: 'PENDING_REFERENCE', kind: 'REFUND', ref: 'bet-x' });
      await expect(c.query(`UPDATE wager_transactions SET status = 'PENDING', next_reference_check_at = NULL WHERE id = $1`, [pending])).rejects.toMatchObject({ code: '23000' });
      await expect(c.query(`UPDATE wager_transactions SET amount = 99 WHERE id = $1`, [pending])).rejects.toMatchObject({ code: '23000' }); // campos de negócio imutáveis
      await c.query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', next_reference_check_at = NULL WHERE id = $1`, [pending]);
    });
  });

  test('wager_transactions: PROCESSED exige processed_at, balance_observed e não tem failure_code; REJECTED exige failure_code', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c);
      const base = (status: string) => {
        const id = uuidv7();
        return c.query(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
           VALUES ($1,'p',$2,$2,$3,$4,'p','r','g','BET',1,'BRL',$5,now())`,
          [id, `ext-${id}`, HASH, walletId, status],
        );
      };
      await expect(base('PROCESSED')).rejects.toMatchObject({ code: '23514' }); // sem processed_at/balance_observed
      await expect(base('REJECTED')).rejects.toMatchObject({ code: '23514' }); // sem failure_code
      await expect(base('PENDING_REFERENCE')).rejects.toMatchObject({ code: '23514' }); // sem next_reference_check_at
      await base('PENDING'); // PENDING simples é válido
    });
  });

  test('"uma referência não pode ser revertida duas vezes": no máximo uma reversão PROCESSED por referência', async () => {
    await withPg(db.url, async (c) => {
      const { walletId } = await seedWallet(c);
      const bet = await insertTx(c, walletId, { kind: 'BET', ext: 'bet-1' });
      await insertTx(c, walletId, { kind: 'REFUND', ref: 'bet-1', refTx: bet, ext: 'rf-1' });
      await expect(insertTx(c, walletId, { kind: 'REFUND', ref: 'bet-1', refTx: bet, ext: 'rf-2' })).rejects.toMatchObject({ code: '23505' });
      await expect(insertTx(c, walletId, { kind: 'ROLLBACK', ref: 'bet-1', refTx: bet, ext: 'rb-1' })).rejects.toMatchObject({ code: '23505' }); // vale entre tipos
      // reversões REJECTED não ocupam a vaga
      await insertTx(c, walletId, { kind: 'REFUND', ref: 'bet-1', refTx: bet, ext: 'rf-3', status: 'REJECTED' });
    });
  });
});
