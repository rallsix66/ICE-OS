-- ICE catalog increment 017: upgrade inventory sync schema from old 016
-- (sha256 7f12c313b68dedd4bb5ee727bbc772508ff5670e285ba469eb8d63286b08400e) to repair v2.
--
-- Contract: .local/inventory-sync-repair-20261026/contract.md sections 1.1-1.3, R1-R7.
-- prepare-instance applies this file only when catalog.inventory_schema_state is missing/older;
-- the functions file (016_inventory_sync_functions.sql) is ALWAYS applied afterwards via CREATE OR
-- REPLACE, then prepare writes the real source/functions sha256 into inventory_schema_state.
--
-- Principles: preserve all existing facts (batches/rows/files/history are immutable), do not delete
-- history, do not rewrite old values; correct the *interpretation*:
--  * legacy confirmed mappings (including account-level defaults and the 430 frozen-sample rows) are
--    downgraded to status='disabled' with a repair note and inserted as evidence candidates;
--  * batch observation time is backfilled from the run's export_finished_at (not publish time);
--  * new structural columns/tables are added idempotently.
--
-- DDL runs as the package owner; data backfills run as the bootstrap superuser because FORCE RLS
-- intentionally hides rows from the definer role outside a request identity. The immutable-history
-- triggers are disabled only for the two historical backfills below and re-enabled afterwards.
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. Guard: the upgrade target must look like the old 016 schema
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 IF to_regclass('catalog.inventory_sync_run') IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_SCHEMA_UPGRADE_FAILED:016 schema missing' USING ERRCODE='55000';
 END IF;
 IF to_regclass('catalog.inventory_sku_mapping') IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_SCHEMA_UPGRADE_FAILED:mapping table missing' USING ERRCODE='55000';
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. inventory_warehouse: market + market_evidence
-- ---------------------------------------------------------------------------
ALTER TABLE catalog.inventory_warehouse
 ADD COLUMN IF NOT EXISTS market text
  CHECK(market IS NULL OR (length(btrim(market))>0 AND length(market)<=20)),
 ADD COLUMN IF NOT EXISTS market_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK(jsonb_typeof(market_evidence)='object');

-- ---------------------------------------------------------------------------
-- 3. inventory_scope: empty scope is legal; evidence column
-- ---------------------------------------------------------------------------
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT con.conname FROM pg_constraint con
  JOIN pg_class rel ON rel.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='catalog' AND rel.relname='inventory_scope' AND con.contype='c'
   AND pg_get_constraintdef(con.oid) ILIKE '%cardinality(warehouse_ids)%'
 LOOP
  EXECUTE format('ALTER TABLE catalog.inventory_scope DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE catalog.inventory_scope ALTER COLUMN warehouse_ids SET DEFAULT '{}'::uuid[];
ALTER TABLE catalog.inventory_scope
 ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK(jsonb_typeof(evidence)='object');

-- ---------------------------------------------------------------------------
-- 4. inventory_variant: unit becomes optional (only confirmed mappings require a unit)
-- ---------------------------------------------------------------------------
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT con.conname FROM pg_constraint con
  JOIN pg_class rel ON rel.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='catalog' AND rel.relname='inventory_variant' AND con.contype='c'
   AND pg_get_constraintdef(con.oid) ILIKE '%btrim(unit)%'
 LOOP
  EXECUTE format('ALTER TABLE catalog.inventory_variant DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE catalog.inventory_variant ALTER COLUMN unit DROP DEFAULT;
ALTER TABLE catalog.inventory_variant ALTER COLUMN unit DROP NOT NULL;
ALTER TABLE catalog.inventory_variant
 ADD CONSTRAINT inventory_variant_unit_check
 CHECK(unit IS NULL OR (length(btrim(unit))>0 AND length(btrim(unit))<=20));

-- ---------------------------------------------------------------------------
-- 5. inventory_sku_mapping: status gains 'recheck'
-- ---------------------------------------------------------------------------
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT con.conname FROM pg_constraint con
  JOIN pg_class rel ON rel.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='catalog' AND rel.relname='inventory_sku_mapping' AND con.contype='c'
   AND pg_get_constraintdef(con.oid) ILIKE '%status%'
 LOOP
  EXECUTE format('ALTER TABLE catalog.inventory_sku_mapping DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE catalog.inventory_sku_mapping
 ADD CONSTRAINT inventory_sku_mapping_status_check
 CHECK(status IN('confirmed','disabled','recheck'));

-- ---------------------------------------------------------------------------
-- 6. inventory_sync_run: identity/file/discovery/source-row columns
-- ---------------------------------------------------------------------------
ALTER TABLE catalog.inventory_sync_run
 ADD COLUMN IF NOT EXISTS account_identity_status text NOT NULL DEFAULT 'unknown'
  CHECK(account_identity_status IN('unknown','verified','missing','mismatch')),
 ADD COLUMN IF NOT EXISTS account_identity_label text,
 ADD COLUMN IF NOT EXISTS file_validation jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK(jsonb_typeof(file_validation)='object'),
 ADD COLUMN IF NOT EXISTS warehouse_discovery jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK(jsonb_typeof(warehouse_discovery)='array'),
 ADD COLUMN IF NOT EXISTS source_row_count integer CHECK(source_row_count IS NULL OR source_row_count>=0);

-- ---------------------------------------------------------------------------
-- 7. inventory_export_file: sha256 is not a global capture identity
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
   JOIN pg_namespace n ON n.oid=rel.relnamespace
   WHERE n.nspname='catalog' AND rel.relname='inventory_export_file'
    AND con.contype='u' AND con.conname='inventory_export_file_sha256_key') THEN
  ALTER TABLE catalog.inventory_export_file DROP CONSTRAINT inventory_export_file_sha256_key;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS inventory_export_file_sha_idx ON catalog.inventory_export_file(sha256);

-- ---------------------------------------------------------------------------
-- 8. inventory_run_row: parse_status gains combo_sku
-- ---------------------------------------------------------------------------
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT con.conname FROM pg_constraint con
  JOIN pg_class rel ON rel.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='catalog' AND rel.relname='inventory_run_row' AND con.contype='c'
   AND pg_get_constraintdef(con.oid) ILIKE '%parse_status%'
 LOOP
  EXECUTE format('ALTER TABLE catalog.inventory_run_row DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE catalog.inventory_run_row
 ADD CONSTRAINT inventory_run_row_parse_status_check
 CHECK(parse_status IN('ok','invalid_quantity','missing_warehouse','missing_sku','duplicate_sku','combo_sku'));

-- ---------------------------------------------------------------------------
-- 9. inventory_batch / inventory_batch_row: new columns (backfilled after the DDL block)
-- ---------------------------------------------------------------------------
ALTER TABLE catalog.inventory_batch
 ADD COLUMN IF NOT EXISTS observation_at timestamptz,
 ADD COLUMN IF NOT EXISTS source_row_count integer;
ALTER TABLE catalog.inventory_batch_row
 ADD COLUMN IF NOT EXISTS excel_row integer,
 ADD COLUMN IF NOT EXISTS item_revision integer;

-- ---------------------------------------------------------------------------
-- 10. inventory_warehouse_state: last_run_id -> last_success_run_id + time columns
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns
   WHERE table_schema='catalog' AND table_name='inventory_warehouse_state' AND column_name='last_run_id')
  AND NOT EXISTS(SELECT 1 FROM information_schema.columns
   WHERE table_schema='catalog' AND table_name='inventory_warehouse_state' AND column_name='last_success_run_id') THEN
  ALTER TABLE catalog.inventory_warehouse_state RENAME COLUMN last_run_id TO last_success_run_id;
 END IF;
END $$;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT con.conname FROM pg_constraint con
  JOIN pg_class rel ON rel.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=rel.relnamespace
  WHERE n.nspname='catalog' AND rel.relname='inventory_warehouse_state' AND con.contype='f'
   AND con.conname LIKE '%last_run_id%'
 LOOP
  EXECUTE format('ALTER TABLE catalog.inventory_warehouse_state RENAME CONSTRAINT %I TO %I',
   c.conname, replace(c.conname,'last_run_id','last_success_run_id'));
 END LOOP;
END $$;
ALTER TABLE catalog.inventory_warehouse_state
 ADD COLUMN IF NOT EXISTS last_publish_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_observation_at timestamptz;

-- ---------------------------------------------------------------------------
-- 11. New tables (same DDL as fresh 016; names/columns must match exactly)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog.inventory_mapping_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 warehouse_id uuid REFERENCES catalog.inventory_warehouse ON DELETE RESTRICT,
 external_sku text NOT NULL CHECK(length(btrim(external_sku))>0 AND external_sku=btrim(external_sku) AND length(external_sku)<=200),
 suggested_item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','dismissed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_mapping_id uuid REFERENCES catalog.inventory_sku_mapping ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_mapping_candidate_key
 ON catalog.inventory_mapping_candidate(account_id,coalesce(warehouse_id,'00000000-0000-0000-0000-000000000000'::uuid),external_sku);
CREATE INDEX IF NOT EXISTS inventory_mapping_candidate_status
 ON catalog.inventory_mapping_candidate(account_id,status,created_at);

CREATE TABLE IF NOT EXISTS catalog.inventory_pending_action (
 request_id uuid PRIMARY KEY,
 account_id uuid REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 actor_id uuid REFERENCES public.profiles ON DELETE RESTRICT,
 action text NOT NULL CHECK(length(btrim(action))>0 AND length(action)<=100),
 intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed','failed')),
 response jsonb CHECK(response IS NULL OR jsonb_typeof(response)='object'),
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_pending_action_one_pending_per_account
 ON catalog.inventory_pending_action(account_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS catalog.inventory_schema_state (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 version integer NOT NULL CHECK(version>0),
 source_sha256 text NOT NULL,
 functions_sha256 text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now(),
 upgraded_from text
);

CREATE INDEX IF NOT EXISTS inventory_batch_row_excel ON catalog.inventory_batch_row(batch_id,excel_row);
CREATE INDEX IF NOT EXISTS inventory_sku_mapping_warehouse_status
 ON catalog.inventory_sku_mapping(account_id,warehouse_id,status);

-- RLS policies for every inventory table (existing + new), replacing any old enabled_admin policy.
--  * enabled_admin: app-role admin JWT path; the current_user guard is first so definer-owner
--    execution never evaluates catalog.is_admin() per row (that per-row profiles lookup made
--    read_inventory_list take seconds).
--  * inventory_sync_worker: definer-owner called from the sync role session.
--  * inventory_definer_owner: SECURITY DEFINER functions run as package owner; app/sync entry
--    points still enforce require_admin()/fixed account/worker identity. Direct app-role SELECT
--    never matches it (app role is not owner and cannot SET ROLE owner).
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='catalog' AND c.relkind='r' AND c.relname LIKE 'inventory\_%'
 LOOP
  EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS enabled_admin ON catalog.%I',t);
  EXECUTE format('DROP POLICY IF EXISTS inventory_sync_worker ON catalog.%I',t);
  EXECUTE format('DROP POLICY IF EXISTS inventory_definer_owner ON catalog.%I',t);
  EXECUTE format('CREATE POLICY enabled_admin ON catalog.%I FOR ALL USING (current_user <> %L AND catalog.is_admin()) WITH CHECK (current_user <> %L AND catalog.is_admin())',
   t,'ice_p0_02_owner','ice_p0_02_owner');
  EXECUTE format('CREATE POLICY inventory_sync_worker ON catalog.%I FOR ALL USING (current_user=%L AND session_user=%L) WITH CHECK (current_user=%L AND session_user=%L)',
   t,'ice_p0_02_owner','ice_p0_02_sync_runner','ice_p0_02_owner','ice_p0_02_sync_runner');
  EXECUTE format('CREATE POLICY inventory_definer_owner ON catalog.%I FOR ALL USING (current_user=%L) WITH CHECK (current_user=%L)',
   t,'ice_p0_02_owner','ice_p0_02_owner');
 END LOOP;
 EXECUTE 'ALTER TABLE catalog_private.inventory_run_row_amount ENABLE ROW LEVEL SECURITY';
 EXECUTE 'ALTER TABLE catalog_private.inventory_run_row_amount FORCE ROW LEVEL SECURITY';
 EXECUTE 'DROP POLICY IF EXISTS enabled_admin ON catalog_private.inventory_run_row_amount';
 EXECUTE 'DROP POLICY IF EXISTS inventory_sync_worker ON catalog_private.inventory_run_row_amount';
 EXECUTE 'DROP POLICY IF EXISTS inventory_definer_owner ON catalog_private.inventory_run_row_amount';
 EXECUTE format('CREATE POLICY enabled_admin ON catalog_private.inventory_run_row_amount FOR ALL USING (current_user <> %L AND catalog.is_admin()) WITH CHECK (current_user <> %L AND catalog.is_admin())',
  'ice_p0_02_owner','ice_p0_02_owner');
 EXECUTE format('CREATE POLICY inventory_sync_worker ON catalog_private.inventory_run_row_amount FOR ALL USING (current_user=%L AND session_user=%L) WITH CHECK (current_user=%L AND session_user=%L)',
  'ice_p0_02_owner','ice_p0_02_sync_runner','ice_p0_02_owner','ice_p0_02_sync_runner');
 EXECUTE format('CREATE POLICY inventory_definer_owner ON catalog_private.inventory_run_row_amount FOR ALL USING (current_user=%L) WITH CHECK (current_user=%L)',
  'ice_p0_02_owner','ice_p0_02_owner');
END $$;

-- Table privileges: no runtime DML; app read-only on public projection tables.
REVOKE ALL ON TABLE catalog.inventory_mapping_candidate,catalog.inventory_pending_action,
 catalog.inventory_schema_state
 FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;
GRANT USAGE ON SCHEMA catalog TO ice_p0_02_app_runner,ice_p0_02_sync_runner;
GRANT SELECT ON TABLE catalog.inventory_mapping_candidate,catalog.inventory_pending_action
 TO ice_p0_02_app_runner;

-- ---------------------------------------------------------------------------
-- 12. Data backfill / evidence correction (bootstrap superuser; FORCE RLS hides rows from the
--     definer role, and the immutable-history triggers must be paused only for backfills).
-- ---------------------------------------------------------------------------
RESET ROLE;
ALTER TABLE catalog.inventory_batch DISABLE TRIGGER immutable_history;
ALTER TABLE catalog.inventory_batch_row DISABLE TRIGGER immutable_history;

UPDATE catalog.inventory_sync_run r SET source_row_count=(
  SELECT count(*)::integer FROM catalog.inventory_run_row rr WHERE rr.run_id=r.id)
 WHERE r.source_row_count IS NULL;

UPDATE catalog.inventory_batch b SET observation_at=coalesce(
  (SELECT r.export_finished_at FROM catalog.inventory_sync_run r WHERE r.id=b.run_id),
  b.published_at)
 WHERE b.observation_at IS NULL;
UPDATE catalog.inventory_batch b SET source_row_count=b.row_count WHERE b.source_row_count IS NULL;
ALTER TABLE catalog.inventory_batch ALTER COLUMN observation_at SET NOT NULL;
ALTER TABLE catalog.inventory_batch ALTER COLUMN source_row_count SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
   JOIN pg_namespace n ON n.oid=rel.relnamespace
   WHERE n.nspname='catalog' AND rel.relname='inventory_batch'
    AND con.conname='inventory_batch_source_row_count_check') THEN
  ALTER TABLE catalog.inventory_batch ADD CONSTRAINT inventory_batch_source_row_count_check
   CHECK(source_row_count>=0 AND source_row_count=row_count);
 END IF;
END $$;

UPDATE catalog.inventory_batch_row br SET excel_row=coalesce((
  SELECT min(rr.excel_row) FROM catalog.inventory_batch b
  JOIN catalog.inventory_warehouse w ON w.id=b.warehouse_id
  JOIN catalog.inventory_run_row rr
   ON rr.run_id=b.run_id AND rr.external_sku=br.external_sku
   AND rr.warehouse_external_id=w.external_warehouse_id
  WHERE b.id=br.batch_id),1)
 WHERE br.excel_row IS NULL;
ALTER TABLE catalog.inventory_batch_row ALTER COLUMN excel_row SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
   JOIN pg_namespace n ON n.oid=rel.relnamespace
   WHERE n.nspname='catalog' AND rel.relname='inventory_batch_row'
    AND con.conname='inventory_batch_row_excel_row_check') THEN
  ALTER TABLE catalog.inventory_batch_row ADD CONSTRAINT inventory_batch_row_excel_row_check
   CHECK(excel_row>0);
 END IF;
END $$;

ALTER TABLE catalog.inventory_batch ENABLE TRIGGER immutable_history;
ALTER TABLE catalog.inventory_batch_row ENABLE TRIGGER immutable_history;

UPDATE catalog.inventory_warehouse_state ws SET
 last_publish_at=coalesce(ws.last_success_at,now()),
 last_observation_at=coalesce((SELECT b.observation_at FROM catalog.inventory_batch b
   WHERE b.id=ws.last_batch_id),ws.last_success_at,now())
 WHERE ws.last_publish_at IS NULL OR ws.last_observation_at IS NULL;

-- Legacy mapping correction (R2): downgrade confirmed facts to evidence candidates.
-- Existing rows keep their version/unit/actor/evidence; only the interpretation changes.
UPDATE catalog.inventory_sku_mapping m
SET status='disabled',
    note=concat_ws(' ', m.note, '修复v2：未经本次确认的历史对应已降级为候选（保留原事实）')
WHERE m.status='confirmed';
INSERT INTO catalog.inventory_mapping_candidate(account_id,warehouse_id,external_sku,
 suggested_item_id,evidence,status,created_at)
SELECT m.account_id,m.warehouse_id,m.external_sku,m.item_id,
 jsonb_build_object('source',coalesce(m.evidence->>'source','legacy_confirmed_mapping'),
  'label','历史对应降级为候选','legacyMappingId',m.id,'legacyVersion',m.version,
  'legacyUnit',m.unit,'legacyActorId',m.actor_id,'legacyEvidence',m.evidence,
  'repair','inventory-sync-repair-v2','originalCreatedAt',m.created_at),
 'pending',now()
FROM (SELECT DISTINCT ON (account_id,warehouse_id,external_sku)
        account_id,warehouse_id,external_sku,item_id,evidence,version,unit,actor_id,created_at,id
      FROM catalog.inventory_sku_mapping
      ORDER BY account_id,warehouse_id,external_sku,version DESC) m
ON CONFLICT (account_id,coalesce(warehouse_id,'00000000-0000-0000-0000-000000000000'::uuid),external_sku)
DO NOTHING;

-- ---------------------------------------------------------------------------
-- 13. Drop old function signatures replaced by repair v2 (new definitions come from the always-
--     applied functions file).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS catalog.update_inventory_sync_settings(uuid,text,boolean,integer,text[]);
DROP FUNCTION IF EXISTS catalog.read_inventory_mapping_queue(integer);
DROP FUNCTION IF EXISTS catalog.read_inventory_item(uuid);
DROP FUNCTION IF EXISTS catalog.inventory_mapping_queue_payload(uuid,integer);
DROP FUNCTION IF EXISTS catalog.inventory_record_schema_state(integer,text);

-- ---------------------------------------------------------------------------
-- 14. Version handshake: upgraded_from = old 016 sha256 (prepare overwrites real sha values)
-- ---------------------------------------------------------------------------
INSERT INTO catalog.inventory_schema_state(id,version,source_sha256,functions_sha256,applied_at,upgraded_from)
VALUES(true,2,'pending','pending',now(),
 '7f12c313b68dedd4bb5ee727bbc772508ff5670e285ba469eb8d63286b08400e')
ON CONFLICT(id) DO UPDATE SET version=2,
 upgraded_from=coalesce(catalog.inventory_schema_state.upgraded_from,
  '7f12c313b68dedd4bb5ee727bbc772508ff5670e285ba469eb8d63286b08400e');

RESET ROLE;
