import { Migration } from '@mikro-orm/migrations';

export class Migration20260801000002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       varchar(64)   NOT NULL,
        external_transaction_id           varchar(128)  NOT NULL,
        idempotency_key                   varchar(256)  NOT NULL,
        payload_hash                      char(64)      NOT NULL,
        wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
        player_id                         varchar(128)  NOT NULL,
        round_id                          varchar(128)  NOT NULL,
        game_id                           varchar(128)  NOT NULL,
        kind                              varchar(16)   NOT NULL,
        amount                            numeric(19,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid          REFERENCES wager_transactions (id),
        status                            varchar(24)   NOT NULL,
        failure_code                      varchar(64),
        balance_observed                  numeric(19,2),
        reference_attempts                integer       NOT NULL DEFAULT 0,
        next_reference_check_at           timestamptz,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        -- idempotência persistente: a identidade do provedor e a Idempotency-Key são únicas POR provedor
        CONSTRAINT uq_wager_tx_provider_external   UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_tx_provider_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT ck_wager_tx_kind   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT ck_wager_tx_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT ck_wager_tx_amount CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
        CONSTRAINT ck_wager_tx_currency CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT ck_wager_tx_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        -- OPENING é interno: só com o provider reservado e nunca referencia nada
        CONSTRAINT ck_wager_tx_opening_internal
          CHECK ((kind = 'OPENING') = (provider_id = 'internal') AND (kind <> 'OPENING' OR reference_external_transaction_id IS NULL)),
        CONSTRAINT ck_wager_tx_status_fields CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL AND failure_code IS NULL AND balance_observed IS NOT NULL)
          OR (status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL)
          OR (status IN ('PENDING','PENDING_REFERENCE') AND processed_at IS NULL AND failure_code IS NULL)
        ),
        CONSTRAINT ck_wager_tx_pending_schedule CHECK (status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL)
      );
    `);
    // "uma referência não pode ser revertida duas vezes": no máximo UMA reversão aplicada por transação referenciada
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
    `);
    this.addSql(`CREATE INDEX ix_wager_tx_pending_due ON wager_transactions (next_reference_check_at) WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`CREATE INDEX ix_wager_tx_pending_ref ON wager_transactions (provider_id, reference_external_transaction_id) WHERE status = 'PENDING_REFERENCE';`);
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        -- PROCESSED, REJECTED e FAILED são terminais
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'transaction % is in terminal status % and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid status transition PENDING_REFERENCE -> PENDING' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.provider_id <> OLD.provider_id OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.wallet_id <> OLD.wallet_id OR NEW.player_id <> OLD.player_id OR NEW.round_id <> OLD.round_id
           OR NEW.game_id <> OLD.game_id OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount
           OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id THEN
          RAISE EXCEPTION 'wager transaction business columns are immutable' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`CREATE TRIGGER trg_wager_transactions_guard BEFORE UPDATE OR DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_wager_transactions_guard ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transactions_guard();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
  }
}
