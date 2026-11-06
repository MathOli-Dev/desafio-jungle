import { Migration } from '@mikro-orm/migrations';

export class Migration20260801000003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid          PRIMARY KEY,
        wallet_id      uuid          NOT NULL REFERENCES wallets (id),
        transaction_id uuid          NOT NULL REFERENCES wager_transactions (id),
        wallet_version integer       NOT NULL,
        direction      varchar(6)    NOT NULL,
        amount         numeric(19,2) NOT NULL,
        currency       char(3)       NOT NULL,
        balance_before numeric(19,2) NOT NULL,
        balance_after  numeric(19,2) NOT NULL,
        created_at     timestamptz   NOT NULL,
        -- cada alteração de saldo = uma versão da wallet = exatamente um lançamento
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        -- uma transação financeira produz no máximo um lançamento por wallet
        CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ck_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        -- aritmética do lançamento verificada no banco (equivalente ao isBalanced() do domínio)
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);

    // Imutabilidade: sem UPDATE, DELETE ou TRUNCATE (append-only).
    this.addSql(`
      CREATE FUNCTION wallet_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% is not allowed)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$;
    `);
    this.addSql(`CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION wallet_ledger_immutable();`);
    this.addSql(`CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_immutable();`);

    // Continuidade da cadeia: balance_before == balance_after do lançamento anterior (ou 0 no primeiro).
    this.addSql(`
      CREATE FUNCTION wallet_ledger_chain_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        last_after   numeric(19,2);
        last_version integer;
      BEGIN
        SELECT balance_after, wallet_version INTO last_after, last_version
          FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN last_after := 0; last_version := 0; END IF;
        IF NEW.balance_before <> last_after THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % but previous balance_after %',
            NEW.wallet_id, NEW.balance_before, last_after USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.wallet_version <= last_version THEN
          RAISE EXCEPTION 'ledger wallet_version % is not greater than %', NEW.wallet_version, last_version
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`CREATE TRIGGER trg_ledger_chain BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION wallet_ledger_chain_check();`);

    // Saldo materializado == último lançamento do ledger, verificado no COMMIT (constraint triggers adiados).
    // Dispara tanto quando a wallet muda sem lançamento quanto quando há lançamento sem a wallet ter mudado.
    this.addSql(`
      CREATE FUNCTION assert_wallet_matches_ledger(p_wallet_id uuid) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE
        w_balance numeric(19,2); w_version integer;
        l_balance numeric(19,2); l_version integer;
      BEGIN
        SELECT balance, version INTO w_balance, w_version FROM wallets WHERE id = p_wallet_id;
        IF NOT FOUND THEN RETURN; END IF;
        SELECT balance_after, wallet_version INTO l_balance, l_version
          FROM wallet_ledger_entries WHERE wallet_id = p_wallet_id ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF w_balance <> 0 OR w_version <> 1 THEN
            RAISE EXCEPTION 'wallet % (balance %, version %) has no ledger entries', p_wallet_id, w_balance, w_version
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN;
        END IF;
        IF l_balance <> w_balance OR l_version <> w_version THEN
          RAISE EXCEPTION 'wallet % (balance %, version %) diverges from ledger (balance %, version %)',
            p_wallet_id, w_balance, w_version, l_balance, l_version USING ERRCODE = 'integrity_constraint_violation';
        END IF;
      END $$;
    `);
    this.addSql(`
      CREATE FUNCTION wallets_match_ledger_trg() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM assert_wallet_matches_ledger(NEW.id); RETURN NULL; END $$;
    `);
    this.addSql(`
      CREATE FUNCTION ledger_match_wallet_trg() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM assert_wallet_matches_ledger(NEW.wallet_id); RETURN NULL; END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallets_match_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallets_match_ledger_trg();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_match_wallet AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_match_wallet_trg();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallets_match_ledger ON wallets;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_match_ledger_trg();`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_match_wallet_trg();`);
    this.addSql(`DROP FUNCTION IF EXISTS assert_wallet_matches_ledger(uuid);`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_chain_check();`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_immutable();`);
  }
}
