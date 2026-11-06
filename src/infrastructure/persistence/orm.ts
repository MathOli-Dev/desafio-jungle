import { Migrator } from '@mikro-orm/migrations';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { EntityManager, MikroORM, Options, PostgreSqlDriver, SqlEntityManager } from '@mikro-orm/postgresql';
import type { AppConfig } from '@/config/config';
import { MIGRATIONS } from './migrations';
import { ALL_SCHEMAS } from './records/records';

export type Orm = CoreMikroORM<PostgreSqlDriver, SqlEntityManager<PostgreSqlDriver> & EntityManager>;
export const ORM = Symbol('MIKRO_ORM');

export function ormOptions(db: AppConfig['db'], log: (message: string) => void = () => undefined): Options {
  return {
    driver: PostgreSqlDriver,
    clientUrl: db.url,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    // Sem contexto global: todo acesso usa um fork explícito (Identity Map por unidade de trabalho).
    allowGlobalContext: false,
    ensureDatabase: false,
    debug: false,
    // Silencioso por padrão (testes/app); scripts/migrate.ts injeta console.log.
    logger: log,
    pool: { min: db.poolMin, max: db.poolMax, acquireTimeoutMillis: db.acquireTimeoutMs },
    driverOptions: {
      connection: {
        // lock_timeout limita a espera na fila do lock da wallet; statement_timeout e idle_in_transaction evitam
        // statements/transações penduradas segurando locks.
        options: `-c lock_timeout=${db.lockTimeoutMs} -c statement_timeout=${db.statementTimeoutMs} -c idle_in_transaction_session_timeout=${db.idleInTxTimeoutMs}`,
      },
    },
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      disableForeignKeys: false,
    },
  };
}

export const createOrm = (db: AppConfig['db'], log?: (message: string) => void): Promise<Orm> => MikroORM.init(ormOptions(db, log));

export async function migrateUp(orm: Orm): Promise<string[]> {
  const done = await orm.migrator.up();
  return done.map((m) => m.name);
}

/** Reverte a última migration (ou todas com `all`). */
export async function migrateDown(orm: Orm, opts: { all?: boolean } = {}): Promise<string[]> {
  const done = opts.all ? await orm.migrator.down({ to: 0 }) : await orm.migrator.down();
  return done.map((m) => m.name);
}
