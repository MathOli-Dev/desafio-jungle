import { EntitySchema } from '@mikro-orm/core';

/**
 * Modelos de PERSISTÊNCIA (separados do domínio). O domínio nunca enxerga o ORM: repositórios convertem
 * linha ↔ agregado. Dinheiro é `string` mapeada para numeric(19,2) — exato, sem number/float no caminho.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    playerId: { type: 'string', columnType: 'varchar(128)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(19,2)' },
    version: { type: 'number', columnType: 'int' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  balanceObserved?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    providerId: { type: 'string', columnType: 'varchar(64)' },
    externalTransactionId: { type: 'string', columnType: 'varchar(128)' },
    idempotencyKey: { type: 'string', columnType: 'varchar(256)' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'string', columnType: 'uuid' },
    playerId: { type: 'string', columnType: 'varchar(128)' },
    roundId: { type: 'string', columnType: 'varchar(128)' },
    gameId: { type: 'string', columnType: 'varchar(128)' },
    kind: { type: 'string', columnType: 'varchar(16)' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', columnType: 'varchar(128)', nullable: true },
    referenceTransactionId: { type: 'string', columnType: 'uuid', nullable: true },
    status: { type: 'string', columnType: 'varchar(24)' },
    failureCode: { type: 'string', columnType: 'varchar(64)', nullable: true },
    balanceObserved: { type: 'string', columnType: 'numeric(19,2)', nullable: true },
    referenceAttempts: { type: 'number', columnType: 'int' },
    nextReferenceCheckAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    walletId: { type: 'string', columnType: 'uuid' },
    transactionId: { type: 'string', columnType: 'uuid' },
    walletVersion: { type: 'number', columnType: 'int' },
    direction: { type: 'string', columnType: 'varchar(6)' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'string', columnType: 'numeric(19,2)' },
    balanceAfter: { type: 'string', columnType: 'numeric(19,2)' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true, columnType: 'varchar(64)' },
    messageId: { type: 'string', primary: true, columnType: 'varchar(128)' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt?: Date | null;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
  lastError?: string | null;
}

/** `seq` (identity) existe só no banco: ordena a publicação e não é mapeado. */
export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'string', primary: true, columnType: 'uuid' },
    aggregateId: { type: 'string', columnType: 'varchar(64)' },
    eventType: { type: 'string', columnType: 'varchar(64)' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz' },
    attempts: { type: 'number', columnType: 'int' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz' },
    publishedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    lockedBy: { type: 'string', columnType: 'varchar(64)', nullable: true },
    lockedUntil: { type: 'Date', columnType: 'timestamptz', nullable: true },
    lastError: { type: 'text', nullable: true },
  },
});

export const ALL_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema];
