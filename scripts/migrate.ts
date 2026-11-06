import { loadConfig } from '@/config/config';
import { createOrm, migrateDown, migrateUp } from '@/infrastructure/persistence/orm';

/** bun scripts/migrate.ts up | down [--all] | status */
const [command = 'up', flag] = process.argv.slice(2);
const orm = await createOrm(loadConfig().db, (message) => console.log(message));
try {
  if (command === 'up') {
    const applied = await migrateUp(orm);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  } else if (command === 'down') {
    const reverted = await migrateDown(orm, { all: flag === '--all' });
    console.log(reverted.length ? `reverted: ${reverted.join(', ')}` : 'nothing to revert');
  } else if (command === 'status') {
    const executed = await orm.migrator.getExecutedMigrations();
    const pending = await orm.migrator.getPendingMigrations();
    console.log(`executed (${executed.length}): ${executed.map((m) => m.name).join(', ') || '-'}`);
    console.log(`pending  (${pending.length}): ${pending.map((m) => m.name).join(', ') || '-'}`);
  } else {
    console.error(`unknown command "${command}" (use: up | down [--all] | status)`);
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
