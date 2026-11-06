import { Migration20260801000001 } from './m001-wallets';
import { Migration20260801000002 } from './m002-wager-transactions';
import { Migration20260801000003 } from './m003-ledger';
import { Migration20260801000004 } from './m004-inbox-outbox';

/** Lista explícita (sem glob de filesystem): funciona igual em Bun, testes e imagem Docker. */
export const MIGRATIONS = [
  { name: 'Migration20260801000001_wallets', class: Migration20260801000001 },
  { name: 'Migration20260801000002_wager_transactions', class: Migration20260801000002 },
  { name: 'Migration20260801000003_ledger_and_integrity', class: Migration20260801000003 },
  { name: 'Migration20260801000004_inbox_outbox', class: Migration20260801000004 },
];
