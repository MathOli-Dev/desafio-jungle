import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { loadConfig } from '@/config/config';
import { createOrm, migrateUp, Orm } from '@/infrastructure/persistence/orm';

/** Infra real (PostgreSQL/SQS em containers via docker compose; ver README). Sobrescreva por variável de ambiente. */
export const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:4566';

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** Cria um banco isolado por arquivo de teste (nada de TRUNCATE: o ledger é append-only). */
export async function createTestDatabase(prefix = 'wager_it'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_DATABASE_URL);
  u.pathname = `/${name}`;
  return {
    name,
    url: u.toString(),
    drop: async () => {
      const c = new Client({ connectionString: ADMIN_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

export async function withPg<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const testDbConfig = (url: string, extra: Record<string, string> = {}) =>
  loadConfig({ DATABASE_URL: url, DB_POOL_MAX: '10', DB_LOCK_TIMEOUT_MS: '10000', ...extra }).db;

export async function createMigratedOrm(url: string): Promise<Orm> {
  const orm = await createOrm(testDbConfig(url));
  await migrateUp(orm);
  return orm;
}
