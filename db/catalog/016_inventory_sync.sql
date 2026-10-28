-- ICE catalog increment 016 (fresh structure, repair v2): BigSeller inventory sync.
--
-- Contract: .local/inventory-sync-repair-20261026/contract.md sections 1.1-1.3.
-- This file is the FRESH instance structure only (tables/indexes/constraints/triggers/RLS/table
-- privileges + schema_version handshake row). Functions live in 016_inventory_sync_functions.sql and
-- are applied separately by prepare-instance (CREATE OR REPLACE, every time). Do NOT reference psql
-- meta-commands here.
--
-- Repair v2 rules encoded in the schema:
--  * only warehouse-level confirmed mappings are effective (account-level history is kept as a fact
--    but ignored by publish/read; see inventory_sku_mapping comments)
--  * current inventory = rows of each warehouse's latest complete successful batch
--    (inventory_warehouse_state.last_batch_id), gated by the mapping still being confirmed
--  * observation time is always inventory_sync_run.export_finished_at (no now() substitution)
--  * export file sha256 is NOT a global identity: only (run, content) uniqueness is enforced in RPC
--  * empty scope is a legal persisted state (inventory_scope.warehouse_ids may be empty)
--  * mapping candidates, recheck state and pending actions are first-class tables
--  * catalog.inventory_schema_state is the version handshake read by prepare-instance; prepare
--    overwrites source_sha256/functions_sha256 after applying the files.
--
-- Everything money-like stays in catalog_private.inventory_run_row_amount. This file does not
-- modify 00001-00015.
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE catalog.inventory_source_account (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_key text NOT NULL UNIQUE
  CHECK(length(btrim(account_key))>0 AND account_key=btrim(account_key) AND length(account_key)<=200),
 account_label text NOT NULL CHECK(length(btrim(account_label))>0 AND length(account_label)<=200),
 external_account_code text,
 source_system text NOT NULL DEFAULT 'bigseller',
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','needs_login','disabled')),
 credential_state text,
 last_login_ok_at timestamptz,
 last_login_check_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.inventory_warehouse (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 external_warehouse_id text NOT NULL
  CHECK(length(btrim(external_warehouse_id))>0 AND external_warehouse_id=btrim(external_warehouse_id)),
 external_name text NOT NULL CHECK(length(btrim(external_name))>0),
 normalized_name text NOT NULL CHECK(length(btrim(normalized_name))>0),
 status text NOT NULL DEFAULT 'candidate' CHECK(status IN('confirmed','candidate','excluded')),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object'),
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 -- Market only when the source warehouse name carries an explicit market token; NULL = 待确认.
 market text CHECK(market IS NULL OR (length(btrim(market))>0 AND length(market)<=20)),
 market_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(market_evidence)='object'),
 UNIQUE(account_id,external_warehouse_id)
);

-- Empty warehouse_ids is a legal persisted state: "参与仓库为空：已停止发布".
CREATE TABLE catalog.inventory_scope (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0),
 warehouse_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
 note text,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object'),
 UNIQUE(account_id,version)
);

CREATE TABLE catalog.inventory_sync_settings (
 account_id uuid PRIMARY KEY REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false,
 interval_minutes integer NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 5 AND 1440),
 scope_id uuid NOT NULL REFERENCES catalog.inventory_scope ON DELETE RESTRICT,
 next_run_at timestamptz,
 plan_anchor_at timestamptz,
 config_version integer NOT NULL DEFAULT 1 CHECK(config_version>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES public.profiles ON DELETE RESTRICT
);

CREATE TABLE catalog.inventory_sync_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE,
 account_id uuid NOT NULL REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 scope_id uuid NOT NULL REFERENCES catalog.inventory_scope ON DELETE RESTRICT,
 trigger_kind text NOT NULL CHECK(trigger_kind IN('manual','schedule','retry','recovery')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN(
  'queued','running','downloading','parsing','publishing','success','partial','failed',
  'needs_login','outcome_unknown')),
 planned_for timestamptz,
 covered_slots timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[],
 started_at timestamptz,
 finished_at timestamptz,
 lease_owner text,
 lease_token uuid,
 lease_expires_at timestamptz,
 heartbeat_at timestamptz,
 attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0),
 export_mark text,
 export_started_at timestamptz,
 export_finished_at timestamptz,
 export_bytes bigint CHECK(export_bytes IS NULL OR export_bytes>=0),
 file_id uuid,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(summary)='object'),
 error_code text,
 error_detail text,
 requested_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 -- R3 identity/file gates: publish impossible unless identity verified and file validation ok.
 account_identity_status text NOT NULL DEFAULT 'unknown'
  CHECK(account_identity_status IN('unknown','verified','missing','mismatch')),
 account_identity_label text,
 file_validation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(file_validation)='object'),
 warehouse_discovery jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(warehouse_discovery)='array'),
 source_row_count integer CHECK(source_row_count IS NULL OR source_row_count>=0)
);
CREATE UNIQUE INDEX inventory_sync_run_one_active_per_account
 ON catalog.inventory_sync_run(account_id)
 WHERE status IN('queued','running','downloading','parsing','publishing','outcome_unknown');
CREATE INDEX inventory_sync_run_account_time ON catalog.inventory_sync_run(account_id,created_at DESC,id DESC);
CREATE INDEX inventory_sync_run_status ON catalog.inventory_sync_run(status,created_at);

-- sha256 is the content hash of one export, NOT a global capture identity (R3/R4).
CREATE TABLE catalog.inventory_export_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL UNIQUE REFERENCES catalog.inventory_sync_run ON DELETE RESTRICT,
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 size_bytes bigint CHECK(size_bytes IS NULL OR size_bytes>=0),
 storage_relpath text NOT NULL CHECK(length(btrim(storage_relpath))>0),
 sheet_name text,
 header jsonb NOT NULL CHECK(jsonb_typeof(header) IN('array','object')),
 header_sha256 text NOT NULL CHECK(header_sha256~'^[a-f0-9]{64}$'),
 row_count integer CHECK(row_count IS NULL OR row_count>=0),
 blank_row_count integer CHECK(blank_row_count IS NULL OR blank_row_count>=0),
 parser_version text NOT NULL CHECK(length(btrim(parser_version))>0),
 downloaded_at timestamptz NOT NULL
);
CREATE INDEX inventory_export_file_sha_idx ON catalog.inventory_export_file(sha256);
ALTER TABLE catalog.inventory_sync_run
 ADD CONSTRAINT inventory_sync_run_file_fk FOREIGN KEY(file_id)
 REFERENCES catalog.inventory_export_file(id) ON DELETE RESTRICT;

CREATE TABLE catalog.inventory_run_row (
 run_id uuid NOT NULL REFERENCES catalog.inventory_sync_run ON DELETE RESTRICT,
 excel_row integer NOT NULL CHECK(excel_row>0),
 warehouse_external_id text,
 warehouse_name text,
 external_sku text,
 product_name text,
 gtin text,
 on_hand_text text,
 order_locked_text text,
 warehouse_available_text text,
 activity_reserved_text text,
 in_transit_text text,
 row_hash text NOT NULL CHECK(length(btrim(row_hash))>0),
 parse_status text NOT NULL CHECK(parse_status IN(
  'ok','invalid_quantity','missing_warehouse','missing_sku','duplicate_sku','combo_sku')),
 reason text,
 PRIMARY KEY(run_id,excel_row)
);
CREATE INDEX inventory_run_row_sku ON catalog.inventory_run_row(run_id,external_sku);
CREATE INDEX inventory_run_row_warehouse ON catalog.inventory_run_row(run_id,warehouse_external_id);

CREATE TABLE catalog_private.inventory_run_row_amount (
 run_id uuid NOT NULL,
 excel_row integer NOT NULL,
 total_cost_text text,
 currency text,
 PRIMARY KEY(run_id,excel_row),
 FOREIGN KEY(run_id,excel_row) REFERENCES catalog.inventory_run_row(run_id,excel_row) ON DELETE RESTRICT
);

-- unit optional: only a confirmed mapping requires one; fresh prepare no longer pre-creates variants.
CREATE TABLE catalog.inventory_variant (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 variant_key text NOT NULL
  CHECK(length(btrim(variant_key))>0 AND variant_key=btrim(variant_key) AND length(variant_key)<=100),
 market text,
 unit text CHECK(unit IS NULL OR (length(btrim(unit))>0 AND length(btrim(unit))<=20)),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(item_id,variant_key)
);

-- warehouse_id nullable only to preserve legacy facts (old account-level defaults). Repair v2
-- ignores account-level rows for publish/read and RPCs require a concrete warehouse for new rows.
CREATE TABLE catalog.inventory_sku_mapping (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 warehouse_id uuid REFERENCES catalog.inventory_warehouse ON DELETE RESTRICT,
 external_sku text NOT NULL
  CHECK(length(btrim(external_sku))>0 AND external_sku=btrim(external_sku) AND length(external_sku)<=200),
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 variant_id uuid NOT NULL REFERENCES catalog.inventory_variant ON DELETE RESTRICT,
 unit text NOT NULL CHECK(length(btrim(unit))>0 AND length(unit)<=20),
 status text NOT NULL CHECK(status IN('confirmed','disabled','recheck')),
 version integer NOT NULL CHECK(version>0),
 supersedes_id uuid REFERENCES catalog.inventory_sku_mapping ON DELETE RESTRICT,
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object'),
 note text,
 actor_id uuid REFERENCES public.profiles ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,warehouse_id,external_sku,version)
);
CREATE UNIQUE INDEX inventory_sku_mapping_confirmed_unique
 ON catalog.inventory_sku_mapping(account_id,coalesce(warehouse_id,'00000000-0000-0000-0000-000000000000'::uuid),external_sku)
 WHERE status='confirmed';
CREATE UNIQUE INDEX inventory_sku_mapping_version_unique
 ON catalog.inventory_sku_mapping(account_id,coalesce(warehouse_id,'00000000-0000-0000-0000-000000000000'::uuid),external_sku,version);
CREATE INDEX inventory_sku_mapping_item ON catalog.inventory_sku_mapping(item_id) WHERE status='confirmed';
CREATE INDEX inventory_sku_mapping_account_sku ON catalog.inventory_sku_mapping(account_id,external_sku);
CREATE INDEX inventory_sku_mapping_warehouse_status ON catalog.inventory_sku_mapping(account_id,warehouse_id,status);

-- Evidence-backed suggestions only; nothing aggregates until an admin confirms.
CREATE TABLE catalog.inventory_mapping_candidate (
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
CREATE UNIQUE INDEX inventory_mapping_candidate_key
 ON catalog.inventory_mapping_candidate(account_id,coalesce(warehouse_id,'00000000-0000-0000-0000-000000000000'::uuid),external_sku);
CREATE INDEX inventory_mapping_candidate_status ON catalog.inventory_mapping_candidate(account_id,status,created_at);

CREATE TABLE catalog.inventory_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL REFERENCES catalog.inventory_sync_run ON DELETE RESTRICT,
 warehouse_id uuid NOT NULL REFERENCES catalog.inventory_warehouse ON DELETE RESTRICT,
 warehouse_name_snapshot text NOT NULL CHECK(length(btrim(warehouse_name_snapshot))>0),
 scope_id uuid NOT NULL REFERENCES catalog.inventory_scope ON DELETE RESTRICT,
 mapping_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(mapping_snapshot)='object'),
 source_file_sha256 text NOT NULL CHECK(source_file_sha256~'^[a-f0-9]{64}$'),
 row_count integer NOT NULL CHECK(row_count>=0),
 adopted_count integer NOT NULL CHECK(adopted_count>=0),
 unmapped_count integer NOT NULL CHECK(unmapped_count>=0),
 published_at timestamptz NOT NULL DEFAULT now(),
 published_by text NOT NULL CHECK(length(btrim(published_by))>0),
 UNIQUE(run_id,warehouse_id),
 CHECK(row_count=adopted_count+unmapped_count),
 -- Observation time is the source export completion time, never publish/now().
 observation_at timestamptz NOT NULL,
 source_row_count integer NOT NULL CHECK(source_row_count>=0 AND source_row_count=row_count)
);
CREATE INDEX inventory_batch_warehouse_time ON catalog.inventory_batch(warehouse_id,published_at DESC);

CREATE TABLE catalog.inventory_batch_row (
 batch_id uuid NOT NULL REFERENCES catalog.inventory_batch ON DELETE RESTRICT,
 external_sku text NOT NULL,
 gtin text,
 item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 variant_id uuid REFERENCES catalog.inventory_variant ON DELETE RESTRICT,
 mapping_id uuid REFERENCES catalog.inventory_sku_mapping ON DELETE RESTRICT,
 unit text,
 on_hand integer,
 order_locked integer,
 warehouse_available integer,
 activity_reserved integer,
 in_transit integer,
 raw_on_hand text,
 raw_order_locked text,
 raw_warehouse_available text,
 raw_activity_reserved text,
 raw_in_transit text,
 observation_at timestamptz NOT NULL,
 previous_batch_id uuid REFERENCES catalog.inventory_batch ON DELETE RESTRICT,
 row_hash text NOT NULL CHECK(length(btrim(row_hash))>0),
 status text NOT NULL CHECK(status IN('adopted','unmapped')),
 excel_row integer NOT NULL CHECK(excel_row>0),
 item_revision integer,
 PRIMARY KEY(batch_id,external_sku)
);
CREATE INDEX inventory_batch_row_item ON catalog.inventory_batch_row(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX inventory_batch_row_excel ON catalog.inventory_batch_row(batch_id,excel_row);

CREATE TABLE catalog.inventory_current (
 warehouse_id uuid NOT NULL REFERENCES catalog.inventory_warehouse ON DELETE RESTRICT,
 external_sku text NOT NULL CHECK(length(btrim(external_sku))>0),
 batch_id uuid NOT NULL REFERENCES catalog.inventory_batch ON DELETE RESTRICT,
 item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 variant_id uuid REFERENCES catalog.inventory_variant ON DELETE RESTRICT,
 unit text,
 on_hand integer,
 order_locked integer,
 warehouse_available integer,
 activity_reserved integer,
 in_transit integer,
 observation_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(warehouse_id,external_sku)
);
CREATE INDEX inventory_current_item ON catalog.inventory_current(item_id) WHERE item_id IS NOT NULL;

CREATE TABLE catalog.inventory_warehouse_state (
 account_id uuid NOT NULL REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 warehouse_id uuid NOT NULL REFERENCES catalog.inventory_warehouse ON DELETE RESTRICT,
 last_success_at timestamptz,
 last_success_run_id uuid REFERENCES catalog.inventory_sync_run ON DELETE RESTRICT,
 last_batch_id uuid REFERENCES catalog.inventory_batch ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now(),
 last_publish_at timestamptz,
 last_observation_at timestamptz,
 PRIMARY KEY(account_id,warehouse_id)
);

CREATE TABLE catalog.inventory_scope_state (
 account_id uuid NOT NULL REFERENCES catalog.inventory_source_account ON DELETE RESTRICT,
 scope_id uuid NOT NULL REFERENCES catalog.inventory_scope ON DELETE RESTRICT,
 last_all_success_at timestamptz,
 last_all_success_run_id uuid REFERENCES catalog.inventory_sync_run ON DELETE RESTRICT,
 PRIMARY KEY(account_id,scope_id)
);

CREATE TABLE catalog.inventory_request (
 request_id uuid PRIMARY KEY,
 action text NOT NULL CHECK(length(btrim(action))>0 AND length(action)<=100),
 intent_hash text NOT NULL CHECK(intent_hash~'^[a-f0-9]{64}$'),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object'),
 run_id uuid REFERENCES catalog.inventory_sync_run ON DELETE RESTRICT,
 response jsonb CHECK(response IS NULL OR jsonb_typeof(response)='object'),
 actor_id uuid REFERENCES public.profiles ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);

-- R5 "结果未知" lock: at most one pending action per account; mutable until completed/failed.
CREATE TABLE catalog.inventory_pending_action (
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
CREATE UNIQUE INDEX inventory_pending_action_one_pending_per_account
 ON catalog.inventory_pending_action(account_id) WHERE status='pending';

CREATE TABLE catalog.inventory_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid REFERENCES public.profiles ON DELETE RESTRICT,
 action text NOT NULL CHECK(length(btrim(action))>0 AND length(action)<=100),
 entity_ref text,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object'),
 at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.inventory_worker (
 worker_id text PRIMARY KEY
  CHECK(length(btrim(worker_id))>0 AND worker_id=btrim(worker_id) AND length(worker_id)<=100),
 host text,
 pid integer,
 version text,
 state text NOT NULL DEFAULT 'online' CHECK(state IN('online','offline')),
 started_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Version handshake (R6.4). prepare-instance reads version; after applying files it overwrites
-- source_sha256/functions_sha256 with the real hashes. 016/017 never write final hashes.
CREATE TABLE catalog.inventory_schema_state (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 version integer NOT NULL CHECK(version>0),
 source_sha256 text NOT NULL,
 functions_sha256 text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now(),
 upgraded_from text
);

-- ---------------------------------------------------------------------------
-- 2. Immutability triggers (evidence/history rows cannot be mutated or deleted)
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inventory_export_file','inventory_run_row','inventory_batch',
  'inventory_batch_row','inventory_request','inventory_audit'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog.%I FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()',t);
 END LOOP;
 EXECUTE 'CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog_private.inventory_run_row_amount FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Row level security.
--  * enabled_admin: app-role sessions with a verified admin JWT. The current_user guard is first
--    so definer-owner function execution never evaluates catalog.is_admin() per row (the old policy
--    made read_inventory_list seconds slow because every row hit profiles).
--  * inventory_sync_worker: definer-owner called from the sync role session.
--  * inventory_definer_owner: SECURITY DEFINER functions run as the package owner; all app/sync
--    entry points still enforce require_admin()/fixed account/worker identity themselves. A direct
--    app-role SELECT never matches this policy (app role is not owner and cannot SET ROLE owner).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inventory_source_account','inventory_warehouse','inventory_scope',
  'inventory_sync_settings','inventory_sync_run','inventory_export_file','inventory_run_row',
  'inventory_variant','inventory_sku_mapping','inventory_mapping_candidate','inventory_batch',
  'inventory_batch_row','inventory_current','inventory_warehouse_state','inventory_scope_state',
  'inventory_request','inventory_pending_action','inventory_audit','inventory_worker',
  'inventory_schema_state'] LOOP
  EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY enabled_admin ON catalog.%I FOR ALL USING (current_user <> %L AND catalog.is_admin()) WITH CHECK (current_user <> %L AND catalog.is_admin())',
   t,'ice_p0_02_owner','ice_p0_02_owner');
  EXECUTE format('CREATE POLICY inventory_sync_worker ON catalog.%I FOR ALL USING (current_user=%L AND session_user=%L) WITH CHECK (current_user=%L AND session_user=%L)',
   t,'ice_p0_02_owner','ice_p0_02_sync_runner','ice_p0_02_owner','ice_p0_02_sync_runner');
  EXECUTE format('CREATE POLICY inventory_definer_owner ON catalog.%I FOR ALL USING (current_user=%L) WITH CHECK (current_user=%L)',
   t,'ice_p0_02_owner','ice_p0_02_owner');
 END LOOP;
 EXECUTE 'ALTER TABLE catalog_private.inventory_run_row_amount ENABLE ROW LEVEL SECURITY';
 EXECUTE 'ALTER TABLE catalog_private.inventory_run_row_amount FORCE ROW LEVEL SECURITY';
 EXECUTE format('CREATE POLICY enabled_admin ON catalog_private.inventory_run_row_amount FOR ALL USING (current_user <> %L AND catalog.is_admin()) WITH CHECK (current_user <> %L AND catalog.is_admin())',
  'ice_p0_02_owner','ice_p0_02_owner');
 EXECUTE format('CREATE POLICY inventory_sync_worker ON catalog_private.inventory_run_row_amount FOR ALL USING (current_user=%L AND session_user=%L) WITH CHECK (current_user=%L AND session_user=%L)',
  'ice_p0_02_owner','ice_p0_02_sync_runner','ice_p0_02_owner','ice_p0_02_sync_runner');
 EXECUTE format('CREATE POLICY inventory_definer_owner ON catalog_private.inventory_run_row_amount FOR ALL USING (current_user=%L) WITH CHECK (current_user=%L)',
  'ice_p0_02_owner','ice_p0_02_owner');
END $$;

-- ---------------------------------------------------------------------------
-- 4. Table privileges (functions own all writes; app gets read-only projection tables)
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE
 catalog.inventory_source_account,catalog.inventory_warehouse,catalog.inventory_scope,
 catalog.inventory_sync_settings,catalog.inventory_sync_run,catalog.inventory_export_file,
 catalog.inventory_run_row,catalog.inventory_variant,catalog.inventory_sku_mapping,
 catalog.inventory_mapping_candidate,catalog.inventory_batch,catalog.inventory_batch_row,
 catalog.inventory_current,catalog.inventory_warehouse_state,catalog.inventory_scope_state,
 catalog.inventory_request,catalog.inventory_pending_action,catalog.inventory_audit,
 catalog.inventory_worker,catalog.inventory_schema_state
 FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;
REVOKE ALL ON TABLE catalog_private.inventory_run_row_amount
 FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;

GRANT USAGE ON SCHEMA catalog TO ice_p0_02_app_runner,ice_p0_02_sync_runner;
GRANT SELECT ON TABLE
 catalog.inventory_source_account,catalog.inventory_warehouse,catalog.inventory_scope,
 catalog.inventory_sync_settings,catalog.inventory_sync_run,catalog.inventory_export_file,
 catalog.inventory_run_row,catalog.inventory_variant,catalog.inventory_sku_mapping,
 catalog.inventory_mapping_candidate,catalog.inventory_batch,catalog.inventory_batch_row,
 catalog.inventory_current,catalog.inventory_warehouse_state,catalog.inventory_scope_state,
 catalog.inventory_request,catalog.inventory_pending_action,catalog.inventory_audit,
 catalog.inventory_worker
 TO ice_p0_02_app_runner;

-- ---------------------------------------------------------------------------
-- 5. Version handshake row (final sha256 values are written by prepare-instance)
-- ---------------------------------------------------------------------------
RESET ROLE;
INSERT INTO catalog.inventory_schema_state(id,version,source_sha256,functions_sha256,applied_at,upgraded_from)
VALUES(true,2,'pending','pending',now(),NULL)
ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version;

RESET ROLE;
