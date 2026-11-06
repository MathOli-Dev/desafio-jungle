import { Migration } from '@mikro-orm/migrations';

export class Migration20260801000004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(64)  NOT NULL,
        message_id    varchar(128) NOT NULL,
        payload_hash  char(64)     NOT NULL,
        received_at   timestamptz  NOT NULL,
        processed_at  timestamptz,
        -- dedup persistente do consumidor
        PRIMARY KEY (consumer_name, message_id)
      );
    `);
    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid         PRIMARY KEY,
        seq             bigint       GENERATED ALWAYS AS IDENTITY,
        aggregate_id    varchar(64)  NOT NULL,
        event_type      varchar(64)  NOT NULL,
        payload         jsonb        NOT NULL,
        occurred_at     timestamptz  NOT NULL,
        attempts        integer      NOT NULL DEFAULT 0,
        next_attempt_at timestamptz  NOT NULL,
        published_at    timestamptz,
        locked_by       varchar(64),
        locked_until    timestamptz,
        last_error      text,
        CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0)
      );
    `);
    this.addSql(`CREATE INDEX ix_outbox_pending ON outbox_messages (seq) WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
  }
}
