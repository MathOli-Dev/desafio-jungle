import { Migration } from '@mikro-orm/migrations';

export class Migration20260801000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid         PRIMARY KEY,
        player_id   varchar(128) NOT NULL,
        currency    char(3)      NOT NULL,
        balance     numeric(19,2) NOT NULL,
        version     integer      NOT NULL,
        created_at  timestamptz  NOT NULL,
        updated_at  timestamptz  NOT NULL,
        -- no máximo uma wallet por jogador e moeda
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        -- saldo nunca negativo: última linha de defesa contra race/bug de aplicação
        CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT ck_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT ck_wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);
    this.addSql(`
      CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        -- version incrementa em +1 se (e somente se) o saldo mudou
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % balance changed without version + 1', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version changed without a balance change', OLD.id USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`CREATE TRIGGER trg_wallets_guard BEFORE UPDATE OR DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_guard();`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallets_guard ON wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_guard();`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
