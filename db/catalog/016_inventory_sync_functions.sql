-- ICE catalog 016 inventory sync repair v2: functions (CREATE OR REPLACE, idempotent).
-- Applied by prepare-instance after 016 (fresh) / 017 (upgrade), every time, so the database
-- functions always match this file. Contract: .local/inventory-sync-repair-20261026/contract.md.
-- ICE catalog 016 inventory sync repair v2: functions (CREATE OR REPLACE, idempotent apply).
-- Included by 016_inventory_sync.sql (fresh) and 017_inventory_sync_repair_v2.sql (upgrade).
-- Contract: .local/inventory-sync-repair-20261026/contract.md section 1.3.
--
-- Effective mapping rule (repair v2): only warehouse-level confirmed mappings aggregate. Account
-- level rows (warehouse_id IS NULL) are retained as historical facts and ignored by publish/read.
-- Read model: rows of each warehouse's latest complete successful batch (warehouse_state.last_batch_id)
-- whose mapping_id is still the current confirmed warehouse mapping. A missing row is "本次未见";
-- a failed warehouse keeps its old batch but is marked stale.
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- RLS policy refresh (idempotent; prepare re-applies this file after 016/017).
-- SECURITY DEFINER functions execute as ice_p0_02_owner, so a cheap definer-owner policy replaces
-- per-row catalog.is_admin() profile lookups on the read paths. The admin policy keeps the same
-- app-role semantics (verified admin JWT) but skips is_admin for the definer role via the leading
-- current_user guard; the sync worker policy is unchanged. App/sync roles do not own the tables and
-- cannot SET ROLE owner, so direct runtime SELECT still only matches the admin policy.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.inventory_text_or_null(p_value jsonb,p_label text) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value)='null' THEN RETURN NULL; END IF;
 IF jsonb_typeof(p_value)<>'string' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_ROW:%',p_label USING ERRCODE='22023'; END IF;
 RETURN p_value #>> '{}';
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_int_or_null(p_value jsonb,p_label text) RETURNS integer
 LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_text text;
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value)='null' THEN RETURN NULL; END IF;
 IF jsonb_typeof(p_value)<>'number' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_ROW:%',p_label USING ERRCODE='22023'; END IF;
 v_text:=p_value #>> '{}';
 IF v_text !~ '^-?[0-9]+$' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_ROW:%',p_label USING ERRCODE='22023'; END IF;
 RETURN v_text::integer;
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_ts_or_null(p_value jsonb,p_label text) RETURNS timestamptz
 LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value)='null' THEN RETURN NULL; END IF;
 IF jsonb_typeof(p_value)<>'string' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_ROW:%',p_label USING ERRCODE='22023'; END IF;
 BEGIN
  RETURN (p_value #>> '{}')::timestamptz;
 EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_ROW:%',p_label USING ERRCODE='22023';
 END;
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_jsonb_array(p_value jsonb) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN jsonb_typeof(p_value)='array' THEN p_value ELSE '[]'::jsonb END
$$;

CREATE OR REPLACE FUNCTION catalog.inventory_bound_account_id() RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
 SELECT a.id INTO v_id
 FROM catalog.inventory_source_account a
 LEFT JOIN catalog.inventory_sync_settings s ON s.account_id=a.id
 ORDER BY (s.account_id IS NULL), a.created_at, a.id
 LIMIT 1;
 RETURN v_id;
END $$;

DROP FUNCTION IF EXISTS catalog.inventory_request_prior(uuid,text,text);
CREATE OR REPLACE FUNCTION catalog.inventory_request_prior(p_request uuid,p_intent text,p_action text,
 p_payload jsonb DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_row catalog.inventory_request;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_request IS NULL OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$' OR p_action IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,940));
 SELECT * INTO v_row FROM catalog.inventory_request r WHERE r.request_id=p_request FOR UPDATE;
 IF FOUND THEN
  IF v_row.intent_hash<>p_intent OR v_row.action<>p_action
   OR (v_row.actor_id IS NOT NULL AND v_row.actor_id<>v_actor) THEN
   RAISE EXCEPTION 'INVENTORY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  -- Same request/intent must also carry the same complete content: a colliding old fingerprint is not
  -- allowed to substitute a different mapping set / settings payload.
  IF p_payload IS NOT NULL AND catalog.inventory_payload_key(p_action,v_row.payload)
   IS DISTINCT FROM catalog.inventory_payload_key(p_action,p_payload) THEN
   RAISE EXCEPTION 'INVENTORY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  IF v_row.response IS NULL THEN
   RAISE EXCEPTION 'INVENTORY_REQUEST_INCOMPLETE' USING ERRCODE='40001'; END IF;
  RETURN v_row.response;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_record_request(p_request uuid,p_intent text,p_action text,
 p_payload jsonb,p_run uuid,p_response jsonb,p_actor uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO catalog.inventory_request(request_id,action,intent_hash,payload,run_id,response,actor_id)
 VALUES(p_request,p_action,p_intent,coalesce(p_payload,'{}'::jsonb),p_run,p_response,p_actor)
 ON CONFLICT(request_id) DO NOTHING;
END $$;

-- Canonical "complete content" key for one pending/request payload (R2 v4).
-- Two operations are the same request only if actor/action/intent AND this key match; free-text
-- fields are compared structurally (sorted JSON array for mappings, sorted warehouse ids, fixed keys
-- for mapping actions), never by concatenating with delimiters.
CREATE OR REPLACE FUNCTION catalog.inventory_payload_key(p_action text,p_payload jsonb) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE p_action
  WHEN 'update_inventory_sync_settings' THEN jsonb_build_object(
    'enabled',coalesce(lower(coalesce(p_payload->>'enabled','false'))='true',false),
    'intervalMinutes',CASE WHEN coalesce(p_payload->>'intervalMinutes','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'intervalMinutes')::integer ELSE NULL END,
    'scopeProvided',coalesce(lower(coalesce(p_payload->>'scopeProvided','false'))='true',false),
    'warehouseIds',coalesce((SELECT jsonb_agg(s.value ORDER BY s.value) FROM (
      SELECT DISTINCT value FROM jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(p_payload->'warehouseIds')='array' THEN p_payload->'warehouseIds'
        ELSE '[]'::jsonb END)) s),'[]'::jsonb)
   )::text
  WHEN 'request_inventory_manual_sync' THEN '{}'
  WHEN 'confirm_inventory_mapping' THEN coalesce((SELECT jsonb_agg(x ORDER BY x::text)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'mappings')='array'
     THEN p_payload->'mappings' ELSE '[]'::jsonb END) AS x),'[]'::jsonb)::text
  WHEN 'recheck_inventory_mapping' THEN jsonb_build_object(
    'mappingId',coalesce(p_payload->>'mappingId',''),
    'expectedVersion',CASE WHEN coalesce(p_payload->>'expectedVersion','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'expectedVersion')::integer ELSE NULL END,
    'reason',coalesce(p_payload->>'reason',p_payload->>'note','')
   )::text
  WHEN 'disable_inventory_mapping' THEN jsonb_build_object(
    'mappingId',coalesce(p_payload->>'mappingId',''),
    'expectedVersion',CASE WHEN coalesce(p_payload->>'expectedVersion','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'expectedVersion')::integer ELSE NULL END,
    'reason',coalesce(p_payload->>'reason',p_payload->>'note','')
   )::text
  ELSE coalesce(p_payload,'{}'::jsonb)::text END
$$;

CREATE OR REPLACE FUNCTION catalog.inventory_audit_write(p_actor uuid,p_action text,p_entity text,p_detail jsonb) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO catalog.inventory_audit(actor_id,action,entity_ref,detail)
 VALUES(p_actor,p_action,p_entity,coalesce(p_detail,'{}'::jsonb));
END $$;

-- R5 gate: while a request has an unknown outcome, no other write may replace it. The persisted
-- pending row is authoritative: same requestId must also carry the same actor/action/intent, and a
-- different requestId for the same account is "busy" (even for another administrator).
DROP FUNCTION IF EXISTS catalog.inventory_block_if_pending(uuid,uuid,uuid,text,text);
CREATE OR REPLACE FUNCTION catalog.inventory_block_if_pending(p_account uuid,p_request uuid,
 p_actor uuid,p_action text,p_intent text,p_payload jsonb DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row catalog.inventory_pending_action;
BEGIN
 IF p_account IS NULL THEN RETURN; END IF;
 SELECT * INTO v_row FROM catalog.inventory_pending_action p
 WHERE p.account_id=p_account AND p.status='pending'
 ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE;
 IF v_row.request_id IS NULL THEN RETURN; END IF;
 IF p_request IS NULL OR v_row.request_id<>p_request THEN
  RAISE EXCEPTION 'INVENTORY_PENDING_RECOVERY_REQUIRED' USING ERRCODE='55000';
 END IF;
 -- Same requestId but a different operator/action/intent must never execute or unlock the original.
 IF (v_row.actor_id IS DISTINCT FROM p_actor)
  OR (v_row.action IS DISTINCT FROM p_action)
  OR (v_row.intent_hash IS DISTINCT FROM p_intent) THEN
  RAISE EXCEPTION 'INVENTORY_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 -- The business write must match the registered complete content, not only the (possibly legacy)
 -- intent hash: an ambiguous old fingerprint cannot be replayed with a different payload.
 IF p_payload IS NOT NULL AND catalog.inventory_payload_key(p_action,v_row.payload)
  IS DISTINCT FROM catalog.inventory_payload_key(p_action,p_payload) THEN
  RAISE EXCEPTION 'INVENTORY_REQUEST_CONFLICT' USING ERRCODE='23505';
 END IF;
END $$;

-- Resolve an explicit participation set. Canonical (sorted, deduplicated) uuid[].
CREATE OR REPLACE FUNCTION catalog.inventory_resolve_scope_warehouses(p_account uuid,p_ids text[]) RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_raw uuid[]:=ARRAY[]::uuid[]; v_item text; v_id uuid;
BEGIN
 IF p_ids IS NULL OR cardinality(p_ids)=0 THEN RETURN NULL; END IF;
 FOREACH v_item IN ARRAY p_ids LOOP
  IF v_item IS NULL OR length(btrim(v_item))=0 THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_id:=NULL;
  BEGIN
   v_id:=(btrim(v_item))::uuid;
  EXCEPTION WHEN OTHERS THEN
   v_id:=NULL;
  END;
  IF v_id IS NOT NULL THEN
   SELECT w.id INTO v_id FROM catalog.inventory_warehouse w
   WHERE w.id=v_id AND w.account_id=p_account;
  END IF;
  IF v_id IS NULL THEN
   SELECT w.id INTO v_id FROM catalog.inventory_warehouse w
   WHERE w.account_id=p_account AND w.external_warehouse_id=btrim(v_item);
  END IF;
  IF v_id IS NULL THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN:%',v_item USING ERRCODE='22023'; END IF;
  IF NOT(v_id=ANY(v_raw)) THEN v_raw:=v_raw||v_id; END IF;
 END LOOP;
 RETURN ARRAY(SELECT x FROM unnest(v_raw) x ORDER BY x::text);
END $$;

-- Only warehouse-level confirmed mappings are effective (repair v2 R1).
CREATE OR REPLACE FUNCTION catalog.inventory_resolve_mapping(p_account uuid,p_warehouse uuid,p_sku text)
 RETURNS catalog.inventory_sku_mapping
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT m.* FROM catalog.inventory_sku_mapping m
 JOIN catalog.inventory_variant v ON v.id=m.variant_id AND v.item_id=m.item_id
 WHERE m.account_id=p_account AND m.warehouse_id=p_warehouse AND m.external_sku=p_sku
  AND m.status='confirmed'
 ORDER BY m.version DESC, m.created_at DESC
 LIMIT 1
$$;

-- Shared effective-row model (list/detail/totals/gaps all read this; never joins current by sku only).
CREATE OR REPLACE FUNCTION catalog.inventory_effective_rows(p_account uuid,p_scope_wh uuid[])
 RETURNS TABLE(
  item_id uuid, warehouse_id uuid, warehouse_external_id text, warehouse_name text, market text,
  external_sku text, mapping_id uuid, mapping_version integer, variant_id uuid, unit text,
  on_hand integer, order_locked integer, warehouse_available integer, activity_reserved integer,
  in_transit integer, gtin text, observed_at timestamptz, batch_id uuid, excel_row integer,
  item_revision integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT br.item_id,w.id,w.external_warehouse_id,w.external_name,w.market,br.external_sku,
  m.id,m.version,m.variant_id,coalesce(br.unit,m.unit),br.on_hand,br.order_locked,
  br.warehouse_available,br.activity_reserved,br.in_transit,br.gtin,br.observation_at,
  b.id,br.excel_row,br.item_revision
 FROM catalog.inventory_warehouse_state ws
 JOIN catalog.inventory_warehouse w
  ON w.id=ws.warehouse_id AND w.account_id=p_account AND w.id=ANY(p_scope_wh)
 JOIN catalog.inventory_batch b ON b.id=ws.last_batch_id AND b.warehouse_id=w.id
 JOIN catalog.inventory_batch_row br ON br.batch_id=b.id AND br.status='adopted' AND br.item_id IS NOT NULL
 JOIN catalog.inventory_sku_mapping m
  ON m.id=br.mapping_id AND m.account_id=p_account AND m.warehouse_id=w.id AND m.status='confirmed'
$$;

-- Per-warehouse read state: last good batch, latest run result, failed/stale flags (R1/R3).
CREATE OR REPLACE FUNCTION catalog.inventory_warehouse_read_state(p_account uuid,p_scope_wh uuid[])
 RETURNS TABLE(
  warehouse_id uuid, external_warehouse_id text, warehouse_name text, market text, warehouse_status text,
  last_success_at timestamptz, last_success_run_id uuid, last_batch_id uuid,
  last_publish_at timestamptz, last_observation_at timestamptz,
  latest_run_id uuid, latest_run_status text, latest_run_finished_at timestamptz,
  failed boolean, stale boolean, last_error_code text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH w AS (
  SELECT wh.id,wh.external_warehouse_id,wh.external_name,wh.market,wh.status
  FROM catalog.inventory_warehouse wh WHERE wh.account_id=p_account AND wh.id=ANY(p_scope_wh)
 ), ws AS (
  SELECT s.* FROM catalog.inventory_warehouse_state s WHERE s.account_id=p_account
 ), lr AS (
  SELECT DISTINCT ON (w.id) w.id AS wid, r.id AS run_id, r.status AS run_status,
   r.finished_at, r.error_code,
   EXISTS(SELECT 1 FROM catalog.inventory_batch b WHERE b.run_id=r.id AND b.warehouse_id=w.id) AS published,
   (SELECT x->>'errorCode' FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(r.summary->'warehouseResults')='array' THEN r.summary->'warehouseResults'
      ELSE '[]'::jsonb END) x WHERE x->>'warehouseId'=w.id::text LIMIT 1) AS wh_error
  FROM w
  JOIN catalog.inventory_sync_run r ON r.account_id=p_account
   AND r.status IN('success','partial','failed','needs_login','outcome_unknown')
  JOIN catalog.inventory_scope sc ON sc.id=r.scope_id AND w.id=ANY(sc.warehouse_ids)
  ORDER BY w.id, r.created_at DESC, r.id DESC
 ), lrf AS (
  SELECT lr.*,
   CASE WHEN lr.run_id IS NULL THEN false
    WHEN lr.run_status='success' THEN false
    -- partial: only a warehouse with a registered per-warehouse error is failed; a scope warehouse
    -- simply not attempted in this run (e.g. filtered subset) stays "not covered", not "failed".
    WHEN lr.run_status='partial' THEN lr.wh_error IS NOT NULL
    ELSE true END AS is_failed
  FROM lr
 )
 SELECT w.id,w.external_warehouse_id,w.external_name,w.market,w.status,
  ws.last_success_at,ws.last_success_run_id,ws.last_batch_id,ws.last_publish_at,ws.last_observation_at,
  lrf.run_id,lrf.run_status,lrf.finished_at,lrf.is_failed,
  (lrf.is_failed AND ws.last_success_at IS NOT NULL) AS is_stale,
  coalesce(lrf.wh_error, CASE WHEN lrf.is_failed THEN lrf.error_code END) AS err
 FROM w
 LEFT JOIN ws ON ws.warehouse_id=w.id
 LEFT JOIN lrf ON lrf.wid=w.id
$$;

-- Replay identity: exact registered excel rows. gtin is deliberately excluded (a corrected 69 code
-- on otherwise identical content must still replay), matching repair contract R4/previous ruling.
CREATE OR REPLACE FUNCTION catalog.inventory_canonical_rows(p_rows jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_out jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'excelRow',CASE WHEN r.value ? 'excelRow' THEN r.value->'excelRow' ELSE 'null'::jsonb END,
  'externalSku',CASE WHEN r.value ? 'externalSku' THEN r.value->'externalSku' ELSE 'null'::jsonb END,
  'onHand',CASE WHEN r.value ? 'onHand' THEN r.value->'onHand' ELSE 'null'::jsonb END,
  'orderLocked',CASE WHEN r.value ? 'orderLocked' THEN r.value->'orderLocked' ELSE 'null'::jsonb END,
  'warehouseAvailable',CASE WHEN r.value ? 'warehouseAvailable' THEN r.value->'warehouseAvailable' ELSE 'null'::jsonb END,
  'activityReserved',CASE WHEN r.value ? 'activityReserved' THEN r.value->'activityReserved' ELSE 'null'::jsonb END,
  'inTransit',CASE WHEN r.value ? 'inTransit' THEN r.value->'inTransit' ELSE 'null'::jsonb END,
  'rawOnHand',CASE WHEN r.value ? 'rawOnHand' THEN r.value->'rawOnHand' ELSE 'null'::jsonb END,
  'rawOrderLocked',CASE WHEN r.value ? 'rawOrderLocked' THEN r.value->'rawOrderLocked' ELSE 'null'::jsonb END,
  'rawWarehouseAvailable',CASE WHEN r.value ? 'rawWarehouseAvailable' THEN r.value->'rawWarehouseAvailable' ELSE 'null'::jsonb END,
  'rawActivityReserved',CASE WHEN r.value ? 'rawActivityReserved' THEN r.value->'rawActivityReserved' ELSE 'null'::jsonb END,
  'rawInTransit',CASE WHEN r.value ? 'rawInTransit' THEN r.value->'rawInTransit' ELSE 'null'::jsonb END,
  'rowHash',CASE WHEN r.value ? 'rowHash' THEN r.value->'rowHash' ELSE 'null'::jsonb END
 ) ORDER BY (CASE WHEN r.value ? 'excelRow' THEN r.value->>'excelRow' ELSE '' END),
    (CASE WHEN r.value ? 'externalSku' THEN r.value->>'externalSku' ELSE '' END)),'[]'::jsonb)
 INTO v_out
 FROM jsonb_array_elements(catalog.inventory_jsonb_array(p_rows)) r;
 RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_stored_batch_rows(p_batch uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_out jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'excelRow',to_jsonb(r.excel_row),
  'externalSku',to_jsonb(r.external_sku),
  'onHand',to_jsonb(r.on_hand),
  'orderLocked',to_jsonb(r.order_locked),
  'warehouseAvailable',to_jsonb(r.warehouse_available),
  'activityReserved',to_jsonb(r.activity_reserved),
  'inTransit',to_jsonb(r.in_transit),
  'rawOnHand',to_jsonb(r.raw_on_hand),
  'rawOrderLocked',to_jsonb(r.raw_order_locked),
  'rawWarehouseAvailable',to_jsonb(r.raw_warehouse_available),
  'rawActivityReserved',to_jsonb(r.raw_activity_reserved),
  'rawInTransit',to_jsonb(r.raw_in_transit),
  'rowHash',to_jsonb(r.row_hash)
 ) ORDER BY r.excel_row, r.external_sku),'[]'::jsonb)
 INTO v_out
 FROM catalog.inventory_batch_row r WHERE r.batch_id=p_batch;
 RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_require_lease(p_run uuid,p_lease uuid) RETURNS catalog.inventory_sync_run
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run;
BEGIN
 IF p_run IS NULL OR p_lease IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_LEASE_LOST' USING ERRCODE='40001'; END IF;
 SELECT * INTO v_run FROM catalog.inventory_sync_run r WHERE r.id=p_run FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'INVENTORY_RUN_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_run.lease_token IS NULL OR v_run.lease_token<>p_lease THEN
  RAISE EXCEPTION 'INVENTORY_LEASE_LOST' USING ERRCODE='40001'; END IF;
 RETURN v_run;
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_advance_due_slots(p_account uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_s catalog.inventory_sync_settings; v_run catalog.inventory_sync_run;
 v_slot timestamptz; v_next timestamptz; v_added timestamptz[]:='{}'::timestamptz[];
BEGIN
 SELECT * INTO v_s FROM catalog.inventory_sync_settings s WHERE s.account_id=p_account FOR UPDATE;
 IF NOT FOUND OR NOT v_s.enabled OR v_s.next_run_at IS NULL THEN RETURN; END IF;
 SELECT * INTO v_run FROM catalog.inventory_sync_run r
 WHERE r.account_id=p_account
  AND r.status IN('queued','running','downloading','parsing','publishing','outcome_unknown')
 ORDER BY r.created_at DESC, r.id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF v_s.next_run_at>now() THEN RETURN; END IF;
 v_slot:=v_s.next_run_at;
 WHILE v_slot<=now() LOOP
  v_added:=v_added||v_slot;
  v_slot:=v_slot+make_interval(mins=>v_s.interval_minutes);
 END LOOP;
 v_next:=v_slot;
 UPDATE catalog.inventory_sync_run SET
  covered_slots=ARRAY(SELECT DISTINCT x FROM unnest(covered_slots||v_added) x ORDER BY x),
  updated_at=now()
 WHERE id=v_run.id;
 UPDATE catalog.inventory_sync_settings SET next_run_at=v_next,updated_at=now()
 WHERE account_id=p_account;
END $$;

-- Evidence-based suggestion for one (warehouse, sku): frozen BS sample + pending candidate rows.
CREATE OR REPLACE FUNCTION catalog.inventory_suggestion_for(p_account uuid,p_warehouse uuid,p_sku text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_sugg jsonb:=NULL; v_cand record;
BEGIN
 IF to_regclass('catalog.bs_sample_inventory_row') IS NOT NULL THEN
  EXECUTE $q$
   SELECT jsonb_build_object('itemId',b.selected_item_id,
    'iceCode',(SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=b.selected_item_id),
    'nameCn',(SELECT rv.name_cn FROM catalog.item_current ic
      JOIN catalog.item_revision rv ON rv.item_id=ic.item_id AND rv.revision=ic.revision
      WHERE ic.item_id=b.selected_item_id),
    'evidence','BS冻结样表已确认','source','bs_sample_export')
   FROM catalog.bs_sample_inventory_row b
   WHERE b.sku=$1 AND b.selection_state='confirmed' AND b.selected_item_id IS NOT NULL
   ORDER BY b.excel_row LIMIT 1
  $q$ INTO v_sugg USING p_sku;
 END IF;
 IF v_sugg IS NOT NULL THEN RETURN v_sugg; END IF;
 SELECT c.suggested_item_id,c.evidence INTO v_cand
 FROM catalog.inventory_mapping_candidate c
 WHERE c.account_id=p_account AND c.warehouse_id IS NOT DISTINCT FROM p_warehouse
  AND c.external_sku=p_sku
  AND c.suggested_item_id IS NOT NULL
 ORDER BY c.created_at DESC LIMIT 1;
 IF v_cand.suggested_item_id IS NOT NULL THEN
  RETURN jsonb_build_object('itemId',v_cand.suggested_item_id,
   'iceCode',(SELECT c2.ice_code FROM catalog.catalog_item_code c2 WHERE c2.item_id=v_cand.suggested_item_id),
   'nameCn',(SELECT rv.name_cn FROM catalog.item_current ic JOIN catalog.item_revision rv
     ON rv.item_id=ic.item_id AND rv.revision=ic.revision WHERE ic.item_id=v_cand.suggested_item_id),
   'evidence',coalesce(v_cand.evidence->>'label','候选'),'source','mapping_candidate');
 END IF;
 RETURN NULL;
END $$;

-- Export registration receipt (new shape includes warehouse identity fields per row).
CREATE OR REPLACE FUNCTION catalog.inventory_export_receipt(p_run uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_file catalog.inventory_export_file; v_rows jsonb;
BEGIN
 SELECT * INTO v_run FROM catalog.inventory_sync_run r WHERE r.id=p_run;
 IF v_run.file_id IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_MISSING' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_file FROM catalog.inventory_export_file f WHERE f.id=v_run.file_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'excelRow',rr.excel_row,'warehouseExternalId',rr.warehouse_external_id,
   'warehouseName',rr.warehouse_name,'externalSku',rr.external_sku,
   'productName',rr.product_name,'gtin',rr.gtin,'onHandText',rr.on_hand_text,
   'orderLockedText',rr.order_locked_text,'warehouseAvailableText',rr.warehouse_available_text,
   'activityReservedText',rr.activity_reserved_text,'inTransitText',rr.in_transit_text,
   'totalCostText',a.total_cost_text,'currency',a.currency,
   'rowHash',rr.row_hash,'parseStatus',rr.parse_status,'reason',rr.reason)
   ORDER BY rr.excel_row),'[]'::jsonb)
 INTO v_rows
 FROM catalog.inventory_run_row rr
 LEFT JOIN catalog_private.inventory_run_row_amount a
  ON a.run_id=rr.run_id AND a.excel_row=rr.excel_row
 WHERE rr.run_id=p_run;
 RETURN jsonb_build_object('exportMark',v_run.export_mark,
  'exportStartedAt',v_run.export_started_at,'exportFinishedAt',v_run.export_finished_at,
  'accountIdentityStatus',v_run.account_identity_status,
  'accountIdentityLabel',v_run.account_identity_label,
  'fileValidation',v_run.file_validation,'warehouseDiscovery',v_run.warehouse_discovery,
  'sourceRowCount',v_run.source_row_count,
  'file',jsonb_build_object('fileId',v_file.id,'storageRelpath',v_file.storage_relpath,
   'sha256',v_file.sha256,'sizeBytes',v_file.size_bytes,'sheetName',v_file.sheet_name,
   'header',v_file.header,'rowCount',v_file.row_count,'blankRowCount',v_file.blank_row_count,
   'parserVersion',v_file.parser_version,'downloadedAt',v_file.downloaded_at),
  'rows',v_rows,'blankRowCount',v_file.blank_row_count);
END $$;


-- ---------------------------------------------------------------------------
-- app-role functions (contract 3.1 + repair v2 additions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.inventory_item_identity(p_item uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('itemId',i.id,
  'iceCode',(SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.id),
  'nameCn',(SELECT r.name_cn FROM catalog.item_current ic
    JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
    WHERE ic.item_id=i.id))
 FROM catalog.catalog_item i WHERE i.id=p_item
$$;

CREATE OR REPLACE FUNCTION catalog.inventory_scope_payload(p_account uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_settings catalog.inventory_sync_settings; v_scope catalog.inventory_scope; v_wh jsonb;
BEGIN
 SELECT * INTO v_settings FROM catalog.inventory_sync_settings s WHERE s.account_id=p_account;
 IF v_settings.scope_id IS NOT NULL THEN
  SELECT * INTO v_scope FROM catalog.inventory_scope s WHERE s.id=v_settings.scope_id;
 END IF;
 IF v_scope.id IS NULL THEN
  SELECT * INTO v_scope FROM catalog.inventory_scope s WHERE s.account_id=p_account
  ORDER BY s.version DESC LIMIT 1;
 END IF;
 IF v_scope.id IS NULL THEN
  RETURN jsonb_build_object('id',NULL::uuid,'version',NULL::integer,'warehouseIds','[]'::jsonb,
   'labels','[]'::jsonb,'warehouseCount',0,'empty',true,'lastAllSuccessAt',NULL::timestamptz,
   'warehouses','[]'::jsonb);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'externalId',w.external_warehouse_id,
   'name',w.external_name,'market',w.market,'status',w.status)
   ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_wh FROM catalog.inventory_warehouse w WHERE w.id=ANY(v_scope.warehouse_ids);
 RETURN jsonb_build_object('id',v_scope.id,'version',v_scope.version,
  'warehouseIds',to_jsonb(v_scope.warehouse_ids),
  'labels',coalesce((SELECT jsonb_agg(w.external_name ORDER BY w.external_warehouse_id)
    FROM catalog.inventory_warehouse w WHERE w.id=ANY(v_scope.warehouse_ids)),'[]'::jsonb),
  'warehouseCount',cardinality(v_scope.warehouse_ids),'empty',cardinality(v_scope.warehouse_ids)=0,
  'lastAllSuccessAt',(SELECT ss.last_all_success_at FROM catalog.inventory_scope_state ss
    WHERE ss.account_id=p_account AND ss.scope_id=v_scope.id),
  'warehouses',v_wh);
END $$;

-- 5.1 overview
CREATE OR REPLACE FUNCTION catalog.read_inventory_sync_overview() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_acct catalog.inventory_source_account; v_settings catalog.inventory_sync_settings;
 v_scope_json jsonb; v_worker jsonb; v_last jsonb; v_runs jsonb; v_wstate jsonb;
 v_pending jsonb; v_market_options jsonb; v_unmapped integer:=0; v_latest uuid;
 v_mappings jsonb; v_candidates integer:=0; v_last_success timestamptz;
 v_scope_wh uuid[]:='{}'::uuid[]; v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('account',NULL::jsonb,'worker',NULL::jsonb,'scope',NULL::jsonb,
   'settings',NULL::jsonb,'warehouses','[]'::jsonb,'warehouseState','[]'::jsonb,'runs','[]'::jsonb,
   'lastRun',NULL::jsonb,'scopeLastAllSuccessAt',NULL::timestamptz,'lastSuccessfulRunAt',NULL::timestamptz,
   'unmappedCount',0,'mappings',jsonb_build_object('confirmed',0,'recheck',0,'disabled',0,'accountLevelIgnored',0),
   'candidates',jsonb_build_object('pending',0),'pendingAction',NULL::jsonb,'marketOptions','[]'::jsonb);
 END IF;
 SELECT * INTO v_acct FROM catalog.inventory_source_account a WHERE a.id=v_aid;
 SELECT * INTO v_settings FROM catalog.inventory_sync_settings s WHERE s.account_id=v_aid;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope_wh:=ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(v_scope_json->'warehouseIds') x);
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseId',r.warehouse_id,'externalId',r.external_warehouse_id,'name',r.warehouse_name,
   'market',r.market,'warehouseStatus',r.warehouse_status,
   'lastSuccessAt',r.last_success_at,'lastSuccessRunId',r.last_success_run_id,
   'lastBatchId',r.last_batch_id,'lastPublishAt',r.last_publish_at,'lastObservationAt',r.last_observation_at,
   'latestRunId',r.latest_run_id,'latestRunStatus',r.latest_run_status,
   'latestRunFinishedAt',r.latest_run_finished_at,'failed',r.failed,'stale',r.stale,
   'lastErrorCode',r.last_error_code)
   ORDER BY r.external_warehouse_id),'[]'::jsonb)
 INTO v_wstate FROM catalog.inventory_warehouse_read_state(v_aid,v_scope_wh) r;
 SELECT jsonb_build_object('online',(wk.state='online' AND wk.last_seen_at>now()-interval '30 seconds'),
   'lastSeenAt',wk.last_seen_at,'host',wk.host,'pid',wk.pid,'workerId',wk.worker_id,'version',wk.version)
 INTO v_worker FROM catalog.inventory_worker wk
 ORDER BY (wk.state='online' AND wk.last_seen_at>now()-interval '30 seconds') DESC,
  wk.last_seen_at DESC NULLS LAST LIMIT 1;
 SELECT jsonb_build_object('id',r.id,'status',r.status,'finishedAt',r.finished_at,
   'triggerKind',r.trigger_kind,'plannedFor',r.planned_for,'startedAt',r.started_at,
   'exportFinishedAt',r.export_finished_at,'accountIdentityStatus',r.account_identity_status,
   'errorCode',r.error_code)
 INTO v_last FROM catalog.inventory_sync_run r WHERE r.account_id=v_aid
 ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(t.obj ORDER BY t.created_at DESC, t.id DESC),'[]'::jsonb)
 INTO v_runs
 FROM (
  SELECT jsonb_build_object(
    'id',r.id,'status',r.status,'triggerKind',r.trigger_kind,'plannedFor',r.planned_for,
    'startedAt',r.started_at,'finishedAt',r.finished_at,
    'exportStartedAt',r.export_started_at,'exportFinishedAt',r.export_finished_at,
    'observationAt',r.export_finished_at,
    'accountIdentityStatus',r.account_identity_status,
    'accountIdentityLabel',r.account_identity_label,
    'fileValidation',r.file_validation,
    'fileValidationBlocked',coalesce((r.file_validation->>'blocked')::boolean,false),
    'warehouseSummary',jsonb_build_object(
     'published',(SELECT count(*)::integer FROM catalog.inventory_batch b WHERE b.run_id=r.id),
     'blocked',coalesce((r.summary->'warehouseSummary'->>'blocked')::integer,0),
     'failed',coalesce((r.summary->'warehouseSummary'->>'failed')::integer,0),
     'noRows',coalesce((r.summary->'warehouseSummary'->>'noRows')::integer,0)),
    'errorCode',r.error_code) AS obj,
   r.created_at,r.id
  FROM catalog.inventory_sync_run r WHERE r.account_id=v_aid
  ORDER BY r.created_at DESC, r.id DESC LIMIT 10) t;
 SELECT jsonb_build_object(
   'confirmed',count(*) FILTER(WHERE status='confirmed')::integer,
   'recheck',count(*) FILTER(WHERE status='recheck')::integer,
   'disabled',count(*) FILTER(WHERE status='disabled')::integer,
   'accountLevelIgnored',count(*) FILTER(WHERE warehouse_id IS NULL)::integer)
 INTO v_mappings FROM catalog.inventory_sku_mapping m WHERE m.account_id=v_aid;
 SELECT count(*)::integer INTO v_candidates FROM catalog.inventory_mapping_candidate c
 WHERE c.account_id=v_aid AND c.status='pending';
 SELECT CASE WHEN p.actor_id IS NOT DISTINCT FROM v_actor
   THEN jsonb_build_object('requestId',p.request_id,'action',p.action,'intentHash',p.intent_hash,
    'payload',p.payload,'actorId',p.actor_id,'accountId',p.account_id,'mine',true,
    'createdAt',p.created_at,'updatedAt',p.updated_at)
   ELSE jsonb_build_object('foreign',true,'mine',false,'action',p.action,
    'createdAt',p.created_at,'updatedAt',p.updated_at) END
 INTO v_pending FROM catalog.inventory_pending_action p
 WHERE p.account_id=v_aid AND p.status='pending'
 ORDER BY p.created_at DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(jsonb_build_object('market',x.market,
   'warehouseCount',x.warehouse_count,'warehouses',x.warehouses) ORDER BY x.market),'[]'::jsonb)
 INTO v_market_options FROM (
   SELECT m.market,count(*)::integer AS warehouse_count,
    jsonb_agg(jsonb_build_object('id',m.id,'externalId',m.external_warehouse_id,
      'name',m.external_name)) AS warehouses
   FROM (SELECT w.id,w.external_warehouse_id,w.external_name,w.market
     FROM catalog.inventory_warehouse w
     WHERE w.account_id=v_aid AND w.market IS NOT NULL
      AND w.id=ANY(v_scope_wh)) m
   GROUP BY m.market) x;
 SELECT r.id INTO v_latest FROM catalog.inventory_sync_run r
 WHERE r.account_id=v_aid AND EXISTS(SELECT 1 FROM catalog.inventory_run_row rr WHERE rr.run_id=r.id)
 ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
 IF v_latest IS NOT NULL THEN
  SELECT count(*)::integer INTO v_unmapped
  FROM (
   SELECT DISTINCT rr.warehouse_external_id,rr.external_sku
   FROM catalog.inventory_run_row rr
   WHERE rr.run_id=v_latest AND rr.parse_status='ok'
    AND rr.external_sku IS NOT NULL AND rr.warehouse_external_id IS NOT NULL
    AND NOT EXISTS(
     SELECT 1 FROM catalog.inventory_sku_mapping m2
     JOIN catalog.inventory_warehouse w2 ON w2.id=m2.warehouse_id
     WHERE m2.account_id=v_aid AND m2.status='confirmed'
      AND m2.external_sku=rr.external_sku
      AND w2.external_warehouse_id=rr.warehouse_external_id)
  ) pending_rows;
 END IF;
 SELECT max(r.export_finished_at) INTO v_last_success FROM catalog.inventory_sync_run r
 WHERE r.account_id=v_aid AND r.status='success';
 RETURN jsonb_build_object(
  'account',jsonb_build_object('label',v_acct.account_label,'accountId',v_acct.id,'status',v_acct.status,
   'lastLoginOkAt',v_acct.last_login_ok_at,'accountKey',v_acct.account_key,
   'externalAccountCode',v_acct.external_account_code),
  'worker',v_worker,
  'scope',v_scope_json,
  'settings',CASE WHEN v_settings.account_id IS NULL THEN NULL::jsonb ELSE jsonb_build_object(
   'enabled',v_settings.enabled,'intervalMinutes',v_settings.interval_minutes,
   'nextRunAt',v_settings.next_run_at,'planAnchorAt',v_settings.plan_anchor_at,
   'configVersion',v_settings.config_version,'scopeId',v_settings.scope_id) END,
  -- R7: warehouse selection options are the account's full warehouse list (confirmed/candidate/
  -- excluded), so an empty scope can be re-selected from the UI. Scope details live in scope.*.
  'warehouses',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',w.id,'externalId',w.external_warehouse_id,'name',w.external_name,
    'status',w.status,'market',w.market) ORDER BY w.external_warehouse_id),'[]'::jsonb)
    FROM catalog.inventory_warehouse w WHERE w.account_id=v_aid),
  'warehouseState',v_wstate,
  'lastRun',v_last,
  'runs',v_runs,
  'scopeLastAllSuccessAt',v_scope_json->'lastAllSuccessAt',
  'lastSuccessfulRunAt',v_last_success,
  'unmappedCount',v_unmapped,
  'mappings',v_mappings,
  'candidates',jsonb_build_object('pending',v_candidates),
  'pendingAction',v_pending,
  'marketOptions',v_market_options);
END $$;

-- 5.2 one run detail
CREATE OR REPLACE FUNCTION catalog.read_inventory_sync_run(p_run uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_scope catalog.inventory_scope; v_file jsonb;
 v_warehouses jsonb; v_issues jsonb; v_groups jsonb; v_lease jsonb; v_results jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_run IS NULL THEN RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:runId' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_run FROM catalog.inventory_sync_run r WHERE r.id=p_run;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_RUN_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_scope FROM catalog.inventory_scope s WHERE s.id=v_run.scope_id;
 IF v_run.file_id IS NOT NULL THEN
  SELECT jsonb_build_object('fileId',f.id,'sha256',left(f.sha256,12),'sha256Full',f.sha256,
    'sizeBytes',f.size_bytes,'storageRelpath',f.storage_relpath,'sheetName',f.sheet_name,
    'header',f.header,'headerSha256',f.header_sha256,'rowCount',f.row_count,
    'blankRowCount',f.blank_row_count,'parserVersion',f.parser_version,
    'downloadedAt',f.downloaded_at)
  INTO v_file FROM catalog.inventory_export_file f WHERE f.id=v_run.file_id;
 END IF;
 v_results:=CASE WHEN jsonb_typeof(v_run.summary->'warehouseResults')='array'
  THEN v_run.summary->'warehouseResults' ELSE '[]'::jsonb END;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseId',w.id,'externalId',w.external_warehouse_id,'name',w.external_name,'market',w.market,
   'status',CASE WHEN b.id IS NOT NULL THEN 'published'
     WHEN v_run.status IN('success','partial','failed','needs_login','outcome_unknown') THEN
      coalesce((SELECT x->>'status' FROM jsonb_array_elements(v_results) x
        WHERE x->>'warehouseId'=w.id::text LIMIT 1),'no_rows')
     ELSE 'pending' END,
   'rows',b.row_count,'adopted',b.adopted_count,'unmapped',b.unmapped_count,
   'sourceRowCount',b.source_row_count,'batchId',b.id,'publishedAt',b.published_at,
   'observationAt',b.observation_at,
   'invalidRows',(SELECT count(*)::integer FROM catalog.inventory_run_row rr
     WHERE rr.run_id=v_run.id AND rr.warehouse_external_id=w.external_warehouse_id
      AND rr.parse_status IN('invalid_quantity','missing_warehouse','missing_sku','combo_sku')),
   'duplicateSkuRows',(SELECT count(*)::integer FROM catalog.inventory_run_row rr
     WHERE rr.run_id=v_run.id AND rr.warehouse_external_id=w.external_warehouse_id
      AND rr.parse_status='duplicate_sku'),
   'errorCode',(SELECT x->>'errorCode' FROM jsonb_array_elements(v_results) x
     WHERE x->>'warehouseId'=w.id::text LIMIT 1),
   'reason',(SELECT x->>'reason' FROM jsonb_array_elements(v_results) x
     WHERE x->>'warehouseId'=w.id::text LIMIT 1))
   ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_warehouses
 FROM catalog.inventory_warehouse w
 LEFT JOIN catalog.inventory_batch b ON b.run_id=v_run.id AND b.warehouse_id=w.id
 WHERE w.id=ANY(v_scope.warehouse_ids);
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'excelRow',rr.excel_row,'warehouseExternalId',rr.warehouse_external_id,
   'warehouseName',rr.warehouse_name,'externalSku',rr.external_sku,
   'parseStatus',rr.parse_status,'reason',rr.reason) ORDER BY rr.excel_row),'[]'::jsonb)
 INTO v_issues
 FROM (SELECT * FROM catalog.inventory_run_row r
   WHERE r.run_id=v_run.id AND r.parse_status<>'ok'
   ORDER BY r.excel_row LIMIT 50) rr;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseExternalId',g.warehouse_external_id,'warehouseName',g.warehouse_name,
   'warehouseId',(SELECT w.id FROM catalog.inventory_warehouse w
     WHERE w.account_id=v_run.account_id AND w.external_warehouse_id=g.warehouse_external_id LIMIT 1),
   'rowCount',g.row_count,'okRowCount',g.ok_count,'blocked',g.blocked,'blockedReason',g.blocked_reason)
   ORDER BY g.warehouse_external_id),'[]'::jsonb)
 INTO v_groups
 FROM (
  SELECT rr.warehouse_external_id,max(rr.warehouse_name) AS warehouse_name,
   count(*)::integer AS row_count,
   count(*) FILTER(WHERE rr.parse_status='ok')::integer AS ok_count,
   bool_or(rr.parse_status<>'ok') AS blocked,
   min(rr.reason) FILTER(WHERE rr.parse_status<>'ok') AS blocked_reason
  FROM catalog.inventory_run_row rr WHERE rr.run_id=v_run.id
   AND rr.warehouse_external_id IS NOT NULL
  GROUP BY rr.warehouse_external_id) g;
 v_lease:=CASE WHEN v_run.status IN('queued','running','downloading','parsing','publishing','outcome_unknown')
  THEN jsonb_build_object('owner',v_run.lease_owner,'expiresAt',v_run.lease_expires_at,
   'heartbeatAt',v_run.heartbeat_at,'attempt',v_run.attempt,'held',v_run.lease_token IS NOT NULL)
  ELSE NULL::jsonb END;
 RETURN jsonb_build_object(
  'id',v_run.id,'requestId',v_run.request_id,'accountId',v_run.account_id,'scopeId',v_run.scope_id,
  'triggerKind',v_run.trigger_kind,'status',v_run.status,'plannedFor',v_run.planned_for,
  'coveredSlots',to_jsonb(v_run.covered_slots),'startedAt',v_run.started_at,
  'finishedAt',v_run.finished_at,'attempt',v_run.attempt,'exportMark',v_run.export_mark,
  'exportStartedAt',v_run.export_started_at,'exportFinishedAt',v_run.export_finished_at,
  'observationAt',v_run.export_finished_at,'exportBytes',v_run.export_bytes,
  'accountIdentityStatus',v_run.account_identity_status,
  'accountIdentityLabel',v_run.account_identity_label,
  'fileValidation',v_run.file_validation,'warehouseDiscovery',v_run.warehouse_discovery,
  'sourceRowCount',v_run.source_row_count,'summary',v_run.summary,
  'errorCode',v_run.error_code,'errorDetail',v_run.error_detail,
  'createdAt',v_run.created_at,'updatedAt',v_run.updated_at,
  'file',v_file,'warehouses',v_warehouses,'groups',v_groups,'issues',v_issues,'lease',v_lease);
END $$;

-- 5.3 save settings: p_scope_provided distinguishes "不改范围" from "明确清空"
CREATE OR REPLACE FUNCTION catalog.update_inventory_sync_settings(p_request uuid,p_intent text,
 p_enabled boolean,p_interval_minutes integer,p_scope_provided boolean,p_warehouse_ids text[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_aid uuid; v_settings catalog.inventory_sync_settings;
 v_interval integer; v_enabled boolean; v_scope_wh uuid[]; v_scope_id uuid; v_scope_ver integer;
 v_old_scope uuid[]; v_old_ver integer; v_changed text[]:=ARRAY[]::text[]; v_plan_reset boolean:=false;
 v_anchor timestamptz; v_next timestamptz; v_result jsonb; v_apply boolean:=false;
 v_scope_empty boolean; v_scope_changed boolean:=false;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.inventory_request_prior(p_request,p_intent,'update_inventory_sync_settings',
  jsonb_build_object('enabled',coalesce(p_enabled,false),
   'intervalMinutes',coalesce(p_interval_minutes,60),
   'scopeProvided',coalesce(p_scope_provided,false),
   'warehouseIds',to_jsonb(coalesce(p_warehouse_ids,'{}'::text[]))));
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RAISE EXCEPTION 'INVENTORY_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
 PERFORM catalog.inventory_block_if_pending(v_aid,p_request,v_actor,'update_inventory_sync_settings',p_intent,
  jsonb_build_object('enabled',coalesce(p_enabled,false),
   'intervalMinutes',coalesce(p_interval_minutes,60),
   'scopeProvided',coalesce(p_scope_provided,false),
   'warehouseIds',to_jsonb(coalesce(p_warehouse_ids,'{}'::text[]))));
 v_interval:=coalesce(p_interval_minutes,60);
 IF v_interval<5 OR v_interval>1440 THEN
  RAISE EXCEPTION 'INVENTORY_INTERVAL_INVALID' USING ERRCODE='22023'; END IF;
 v_enabled:=coalesce(p_enabled,false);
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.settings:'||v_aid::text,942));
 SELECT * INTO v_settings FROM catalog.inventory_sync_settings s WHERE s.account_id=v_aid FOR UPDATE;
 IF coalesce(p_scope_provided,false) THEN
  IF p_warehouse_ids IS NULL OR cardinality(p_warehouse_ids)=0 THEN
   v_scope_wh:='{}'::uuid[];
  ELSE
   v_scope_wh:=coalesce(catalog.inventory_resolve_scope_warehouses(v_aid,p_warehouse_ids),'{}'::uuid[]);
  END IF;
 END IF;
 IF v_settings.account_id IS NULL THEN
  IF NOT coalesce(p_scope_provided,false) THEN
   RAISE EXCEPTION 'INVENTORY_SCOPE_EMPTY' USING ERRCODE='22023'; END IF;
  INSERT INTO catalog.inventory_scope(account_id,version,warehouse_ids,note,created_by)
  VALUES(v_aid,1,v_scope_wh,'首次保存范围',v_actor) RETURNING id INTO v_scope_id;
  UPDATE catalog.inventory_warehouse w SET status='confirmed'
  WHERE w.id=ANY(v_scope_wh) AND w.status<>'excluded';
  v_scope_ver:=1;
  IF cardinality(v_scope_wh)>0 THEN v_enabled:=v_enabled; ELSE v_enabled:=false; END IF;
  INSERT INTO catalog.inventory_sync_settings(account_id,enabled,interval_minutes,scope_id,
   next_run_at,plan_anchor_at,config_version,updated_at,updated_by)
  VALUES(v_aid,v_enabled,v_interval,v_scope_id,
   CASE WHEN v_enabled THEN now()+make_interval(mins=>v_interval) END,
   CASE WHEN v_enabled THEN now() END,1,now(),v_actor)
  RETURNING * INTO v_settings;
  v_changed:=ARRAY['created'];
  IF v_enabled THEN v_plan_reset:=true; END IF;
  v_apply:=true;
 ELSE
  SELECT s.warehouse_ids,s.version INTO v_old_scope,v_old_ver
  FROM catalog.inventory_scope s WHERE s.id=v_settings.scope_id;
  IF NOT coalesce(p_scope_provided,false) THEN v_scope_wh:=v_old_scope; END IF;
  v_scope_id:=v_settings.scope_id; v_scope_ver:=v_old_ver;
  IF coalesce(p_scope_provided,false) AND v_scope_wh IS DISTINCT FROM v_old_scope THEN
   SELECT coalesce(max(s.version),0)+1 INTO v_scope_ver FROM catalog.inventory_scope s WHERE s.account_id=v_aid;
   INSERT INTO catalog.inventory_scope(account_id,version,warehouse_ids,note,created_by)
   VALUES(v_aid,v_scope_ver,v_scope_wh,'范围更新',v_actor) RETURNING id INTO v_scope_id;
   UPDATE catalog.inventory_warehouse w SET status='confirmed'
   WHERE w.id=ANY(v_scope_wh) AND w.status<>'excluded';
   UPDATE catalog.inventory_warehouse w SET status='candidate'
   WHERE w.account_id=v_aid AND w.id=ANY(v_old_scope)
    AND NOT(w.id=ANY(v_scope_wh)) AND w.status='confirmed';
   v_scope_changed:=true; v_changed:=array_append(v_changed,'scope'); v_apply:=true;
  END IF;
  v_scope_empty:=(cardinality(v_scope_wh)=0);
  IF v_scope_empty THEN
   -- An empty participation scope always stops publishing and clears the automatic plan.
   IF v_settings.enabled OR v_settings.next_run_at IS NOT NULL THEN
    v_changed:=array_append(v_changed,'scopeEmpty'); v_apply:=true; END IF;
   v_enabled:=false; v_plan_reset:=true;
  ELSE
   IF v_settings.enabled IS DISTINCT FROM v_enabled THEN
    v_changed:=array_append(v_changed,'enabled'); v_apply:=true; END IF;
   IF v_settings.interval_minutes<>v_interval THEN
    v_changed:=array_append(v_changed,'intervalMinutes'); v_apply:=true; v_plan_reset:=true; END IF;
   IF v_enabled AND NOT v_settings.enabled THEN v_plan_reset:=true; END IF;
  END IF;
  IF v_plan_reset THEN
   IF v_scope_empty THEN v_anchor:=NULL; v_next:=NULL;
   ELSE v_anchor:=now(); v_next:=now()+make_interval(mins=>v_interval); END IF;
  ELSE
   v_anchor:=v_settings.plan_anchor_at; v_next:=v_settings.next_run_at;
  END IF;
  IF v_apply THEN
   UPDATE catalog.inventory_sync_settings SET enabled=v_enabled,interval_minutes=v_interval,
    scope_id=v_scope_id,plan_anchor_at=v_anchor,next_run_at=v_next,
    config_version=config_version+1,updated_at=now(),updated_by=v_actor
   WHERE account_id=v_aid RETURNING * INTO v_settings;
  END IF;
 END IF;
 v_result:=jsonb_build_object('ok',true,'changed',to_jsonb(v_changed),
  'settings',jsonb_build_object(
   'enabled',v_settings.enabled,'intervalMinutes',v_settings.interval_minutes,
   'nextRunAt',v_settings.next_run_at,'planAnchorAt',v_settings.plan_anchor_at,
   'configVersion',v_settings.config_version,'scopeId',v_settings.scope_id,
   'scopeVersion',v_scope_ver,'scopeEmpty',(cardinality(v_scope_wh)=0),
   'warehouseCount',cardinality(v_scope_wh)));
 PERFORM catalog.inventory_record_request(p_request,p_intent,'update_inventory_sync_settings',
  jsonb_build_object('enabled',v_enabled,'intervalMinutes',v_interval,
   'scopeProvided',coalesce(p_scope_provided,false),'warehouseIds',to_jsonb(p_warehouse_ids)),
  NULL,v_result,v_actor);
 PERFORM catalog.inventory_audit_write(v_actor,'update_inventory_sync_settings',v_aid::text,v_result);
 RETURN v_result;
END $$;

-- 5.4 manual sync (explicit empty scope rejection)
CREATE OR REPLACE FUNCTION catalog.request_inventory_manual_sync(p_request uuid,p_intent text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_aid uuid; v_acct catalog.inventory_source_account;
 v_run catalog.inventory_sync_run; v_scope catalog.inventory_scope; v_settings catalog.inventory_sync_settings;
 v_result jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.inventory_request_prior(p_request,p_intent,'request_inventory_manual_sync','{}'::jsonb);
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RAISE EXCEPTION 'INVENTORY_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
 PERFORM catalog.inventory_block_if_pending(v_aid,p_request,v_actor,'request_inventory_manual_sync',p_intent,
  '{}'::jsonb);
 SELECT * INTO v_acct FROM catalog.inventory_source_account a WHERE a.id=v_aid;
 IF v_acct.status='disabled' THEN
  RAISE EXCEPTION 'INVENTORY_ACCOUNT_DISABLED' USING ERRCODE='42501'; END IF;
 IF v_acct.status='needs_login' THEN
  RAISE EXCEPTION 'INVENTORY_ACCOUNT_NEEDS_LOGIN' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.manual:'||v_aid::text,943));
 SELECT * INTO v_settings FROM catalog.inventory_sync_settings s WHERE s.account_id=v_aid;
 IF v_settings.scope_id IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_SCOPE_EMPTY' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_scope FROM catalog.inventory_scope s WHERE s.id=v_settings.scope_id;
 IF v_scope.id IS NULL OR cardinality(v_scope.warehouse_ids)=0 THEN
  RAISE EXCEPTION 'INVENTORY_SCOPE_EMPTY' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_run FROM catalog.inventory_sync_run r
 WHERE r.account_id=v_aid
  AND r.status IN('queued','running','downloading','parsing','publishing','outcome_unknown')
 ORDER BY r.created_at DESC, r.id DESC LIMIT 1 FOR UPDATE;
 IF v_run.id IS NOT NULL THEN
  v_result:=jsonb_build_object('ok',true,'deduped',true,'runId',v_run.id,'status',v_run.status);
 ELSE
  INSERT INTO catalog.inventory_sync_run(request_id,account_id,scope_id,trigger_kind,status,
   planned_for,covered_slots,requested_by,created_at,updated_at)
  VALUES(p_request,v_aid,v_settings.scope_id,'manual','queued',now(),'{}'::timestamptz[],v_actor,now(),now())
  RETURNING * INTO v_run;
  v_result:=jsonb_build_object('ok',true,'deduped',false,'runId',v_run.id,'status',v_run.status);
 END IF;
 PERFORM catalog.inventory_record_request(p_request,p_intent,'request_inventory_manual_sync',
  '{}'::jsonb,v_run.id,v_result,v_actor);
 PERFORM catalog.inventory_audit_write(v_actor,'request_inventory_manual_sync',v_run.id::text,v_result);
 RETURN v_result;
END $$;

-- 5.5 mapping queue with search/paging (R2)
CREATE OR REPLACE FUNCTION catalog.read_inventory_mapping_queue(p_search text,p_limit integer,p_offset integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_run uuid; v_run_at timestamptz; v_search text; v_limit integer; v_offset integer;
 v_items jsonb:='[]'::jsonb; v_total integer:=0; v_rec record;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RETURN jsonb_build_object('items','[]'::jsonb,'total',0,'limit',0,'offset',0); END IF;
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,20),100));
 v_offset:=greatest(0,coalesce(p_offset,0));
 SELECT r.id,r.created_at INTO v_run,v_run_at FROM catalog.inventory_sync_run r
 WHERE r.account_id=v_aid
  AND EXISTS(SELECT 1 FROM catalog.inventory_run_row rr WHERE rr.run_id=r.id)
 ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
 -- Queue = evidence candidates (all statuses, so the UI can distinguish pending/confirmed/
 -- dismissed) UNION pending (warehouse, sku) pairs from the latest run that has rows. A run is
 -- optional: on a fresh instance with only the 430 seeded candidates the queue is already usable.
 FOR v_rec IN
  WITH cand AS (
    SELECT c.id AS candidate_id,c.warehouse_id,c.external_sku,c.created_at AS cand_at,
     c.status AS cand_status,c.evidence AS cand_evidence
    FROM catalog.inventory_mapping_candidate c
    WHERE c.account_id=v_aid
   ), runpairs AS (
    SELECT w.id AS warehouse_id,rr.external_sku,count(*)::integer AS occurrences
    FROM catalog.inventory_run_row rr
    JOIN catalog.inventory_warehouse w
      ON w.account_id=v_aid AND w.external_warehouse_id=rr.warehouse_external_id
    WHERE v_run IS NOT NULL AND rr.run_id=v_run AND rr.parse_status='ok'
     AND rr.external_sku IS NOT NULL
    GROUP BY w.id,rr.external_sku
   ), src AS (
    SELECT c.warehouse_id,c.external_sku,c.candidate_id,c.cand_at,c.cand_status,
     c.cand_evidence,0 AS occurrences
    FROM cand c
    UNION ALL
    SELECT r.warehouse_id,r.external_sku,NULL::uuid,NULL::timestamptz,NULL::text,
     NULL::jsonb,r.occurrences
    FROM runpairs r
   ), merged AS (
    SELECT warehouse_id,external_sku,
     max(candidate_id::text)::uuid AS candidate_id,
     max(cand_at) AS cand_at,
     max(cand_status) AS cand_status,
     max(cand_evidence::text)::jsonb AS cand_evidence,
     sum(occurrences)::integer AS occurrences
    FROM src GROUP BY warehouse_id,external_sku
   ), filtered AS (
    SELECT m.* FROM merged m
    WHERE NOT EXISTS(SELECT 1 FROM catalog.inventory_sku_mapping sm
     WHERE sm.account_id=v_aid AND sm.warehouse_id IS NOT DISTINCT FROM m.warehouse_id
      AND sm.external_sku=m.external_sku AND sm.status='confirmed')
   ), enriched AS (
    SELECT f.warehouse_id,f.external_sku,f.candidate_id,f.cand_status,f.cand_evidence,
     f.occurrences,
     (SELECT w.external_warehouse_id FROM catalog.inventory_warehouse w WHERE w.id=f.warehouse_id) AS wh_ext,
     (SELECT w.external_name FROM catalog.inventory_warehouse w WHERE w.id=f.warehouse_id) AS wh_name,
     (SELECT w.market FROM catalog.inventory_warehouse w WHERE w.id=f.warehouse_id) AS wh_market,
     catalog.inventory_suggestion_for(v_aid,f.warehouse_id,f.external_sku) AS suggestion,
     CASE WHEN f.occurrences>0 THEN v_run_at ELSE NULL END AS latest_run_at,
     cm.id AS cm_id,cm.status AS cm_status,cm.version AS cm_version,
     cm.item_id AS cm_item_id,cm.unit AS cm_unit,cm.evidence AS cm_evidence,cm.note AS cm_note,
     (coalesce((cm.evidence->>'verification')='true',false)
      OR coalesce((f.cand_evidence->>'verification')='true',false)) AS verification,
     (coalesce((cm.evidence->>'unitConfirmed')='false',false)
      OR coalesce((f.cand_evidence->>'unitConfirmed')='false',false)) AS unit_unconfirmed
    FROM filtered f
    LEFT JOIN LATERAL (
     SELECT m.id,m.status,m.version,m.item_id,m.unit,m.evidence,m.note
     FROM catalog.inventory_sku_mapping m
     WHERE m.account_id=v_aid AND m.warehouse_id IS NOT DISTINCT FROM f.warehouse_id
      AND m.external_sku=f.external_sku
     ORDER BY m.version DESC,m.created_at DESC LIMIT 1) cm ON true
   )
   SELECT * FROM enriched e
  WHERE v_search IS NULL
   OR e.external_sku ILIKE '%'||v_search||'%'
   OR coalesce(e.wh_ext,'') ILIKE '%'||v_search||'%'
   OR coalesce(e.wh_name,'') ILIKE '%'||v_search||'%'
   OR coalesce(e.suggestion->>'iceCode','') ILIKE '%'||v_search||'%'
   OR coalesce(e.suggestion->>'nameCn','') ILIKE '%'||v_search||'%'
  ORDER BY e.wh_ext NULLS LAST,e.external_sku
 LOOP
  v_total:=v_total+1;
  IF v_total>v_offset AND v_total<=v_offset+v_limit THEN
   v_items:=v_items||jsonb_build_array(jsonb_build_object(
    'candidateId',v_rec.candidate_id,
    'externalSku',v_rec.external_sku,
    'warehouseId',v_rec.warehouse_id,
    'warehouseExternalId',v_rec.wh_ext,
    'warehouseName',v_rec.wh_name,
    'market',v_rec.wh_market,
    'occurrences',v_rec.occurrences,
    'latestRunAt',v_rec.latest_run_at,
    'latestWarehouseRunAt',v_rec.latest_run_at,
    'suggestion',v_rec.suggestion,
    'candidateStatus',v_rec.cand_status,
    'mappingStatus',v_rec.cm_status,
    'currentMapping',CASE WHEN v_rec.cm_id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',v_rec.cm_id,'status',v_rec.cm_status,'version',v_rec.cm_version,
      'itemId',v_rec.cm_item_id,'unit',v_rec.cm_unit) END,
    'verification',v_rec.verification,
    'unitUnconfirmed',v_rec.unit_unconfirmed,
    'reason',CASE WHEN v_rec.verification
      THEN coalesce(v_rec.cm_note,v_rec.cand_evidence->>'label','修复验证数据，业务包装单位待确认')
      ELSE NULL END));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('items',v_items,'total',v_total,'limit',v_limit,'offset',v_offset);
END $$;

-- 5.6 confirm mapping (warehouse-level, unit required, candidate resolution)
CREATE OR REPLACE FUNCTION catalog.confirm_inventory_mapping(p_request uuid,p_intent text,p_mappings jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_aid uuid; v_e jsonb; v_applied integer:=0;
 v_skipped jsonb:='[]'::jsonb; v_committed jsonb:='[]'::jsonb; v_sku text; v_unit text; v_reason text;
 v_item uuid; v_wh_ext text; v_wh uuid; v_variant uuid; v_variant_key text;
 v_old catalog.inventory_sku_mapping; v_version integer; v_supersedes uuid; v_expected integer;
 v_verification boolean;
 v_result jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.inventory_request_prior(p_request,p_intent,'confirm_inventory_mapping',
  jsonb_build_object('mappings',p_mappings));
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RAISE EXCEPTION 'INVENTORY_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
 PERFORM catalog.inventory_block_if_pending(v_aid,p_request,v_actor,'confirm_inventory_mapping',p_intent,
  jsonb_build_object('mappings',p_mappings));
 IF p_mappings IS NULL OR jsonb_typeof(p_mappings)<>'array' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:mappings' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.mapping:'||v_aid::text,944));
 FOR v_e IN SELECT m.value FROM jsonb_array_elements(p_mappings) m LOOP
  v_sku:=NULL; v_unit:=NULL; v_reason:=NULL; v_wh_ext:=NULL;
  BEGIN
   IF jsonb_typeof(v_e)<>'object' THEN
    RAISE EXCEPTION 'INVENTORY_MAPPING_INVALID' USING ERRCODE='22023'; END IF;
   v_sku:=nullif(btrim(coalesce(v_e->>'externalSku','')),'');
   v_unit:=nullif(btrim(coalesce(v_e->>'unit','')),'');
   v_wh_ext:=nullif(btrim(coalesce(v_e->>'warehouseExternalId','')),'');
   v_reason:=nullif(btrim(coalesce(v_e->>'reason','')),'');
   v_variant_key:=coalesce(nullif(btrim(coalesce(v_e->>'variantKey','')),''),'default');
   v_item:=NULL;
   IF jsonb_typeof(v_e->'itemId')='string' AND (v_e->>'itemId')<>'' THEN
    BEGIN v_item:=(v_e->>'itemId')::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'INVENTORY_MAPPING_INVALID:itemId' USING ERRCODE='22023'; END;
   END IF;
   v_expected:=catalog.inventory_int_or_null(v_e->'expectedVersion','expectedVersion');
   v_verification:=lower(coalesce(v_e->>'verification',''))='true';
   IF v_sku IS NULL OR v_unit IS NULL OR v_item IS NULL OR v_wh_ext IS NULL OR v_reason IS NULL
    OR length(v_unit)>20 OR length(v_reason)>500 THEN
    RAISE EXCEPTION 'INVENTORY_MAPPING_INVALID' USING ERRCODE='22023'; END IF;
   IF NOT EXISTS(SELECT 1 FROM catalog.catalog_item i WHERE i.id=v_item) THEN
    RAISE EXCEPTION 'INVENTORY_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
   SELECT w.id INTO v_wh FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid AND w.external_warehouse_id=v_wh_ext;
   IF v_wh IS NULL THEN RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
   SELECT v.id INTO v_variant FROM catalog.inventory_variant v
   WHERE v.item_id=v_item AND v.variant_key=v_variant_key;
   IF v_variant IS NULL THEN
    INSERT INTO catalog.inventory_variant(item_id,variant_key,unit)
    VALUES(v_item,v_variant_key,v_unit) RETURNING id INTO v_variant;
   ELSE
    IF (SELECT v.unit FROM catalog.inventory_variant v WHERE v.id=v_variant) IS NOT NULL
     AND (SELECT v.unit FROM catalog.inventory_variant v WHERE v.id=v_variant)<>v_unit THEN
     RAISE EXCEPTION 'INVENTORY_MAPPING_UNIT_CONFLICT' USING ERRCODE='22023'; END IF;
    UPDATE catalog.inventory_variant SET unit=v_unit WHERE id=v_variant AND unit IS NULL;
   END IF;
   SELECT * INTO v_old FROM catalog.inventory_sku_mapping m
   WHERE m.account_id=v_aid AND m.external_sku=v_sku AND m.warehouse_id=v_wh
   ORDER BY m.version DESC LIMIT 1 FOR UPDATE;
   IF v_old.id IS NOT NULL THEN
    -- Any existing row (confirmed/disabled/recheck) must be re-confirmed with the exact version the
    -- operator saw. A missing expectedVersion is only valid for the first mapping of this key.
    IF v_expected IS NULL OR v_expected<>v_old.version THEN
     RAISE EXCEPTION 'INVENTORY_MAPPING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF v_old.status='confirmed' AND v_old.item_id=v_item AND v_old.unit=v_unit THEN
     RAISE EXCEPTION 'INVENTORY_MAPPING_UNCHANGED' USING ERRCODE='22023'; END IF;
    v_supersedes:=v_old.id; v_version:=v_old.version+1;
    IF v_old.status='confirmed' THEN
     UPDATE catalog.inventory_sku_mapping SET status='disabled' WHERE id=v_old.id;
    END IF;
   ELSE
    IF v_expected IS NOT NULL THEN
     RAISE EXCEPTION 'INVENTORY_MAPPING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    v_version:=1;
   END IF;
   INSERT INTO catalog.inventory_sku_mapping(account_id,warehouse_id,external_sku,item_id,
    variant_id,unit,status,version,supersedes_id,evidence,note,actor_id)
   VALUES(v_aid,v_wh,v_sku,v_item,v_variant,v_unit,'confirmed',v_version,v_supersedes,
    jsonb_build_object('source',CASE WHEN v_verification THEN 'manual_confirm_validation' ELSE 'manual_confirm' END,
     'actorId',v_actor,'reason',v_reason,'variantKey',v_variant_key,
     'verification',v_verification,
     'unitConfirmed',CASE WHEN v_verification THEN false ELSE true END),v_reason,v_actor);
   UPDATE catalog.inventory_mapping_candidate c
   SET status='confirmed',resolved_at=now(),
    resolved_mapping_id=(SELECT m.id FROM catalog.inventory_sku_mapping m
     WHERE m.account_id=v_aid AND m.warehouse_id=v_wh AND m.external_sku=v_sku AND m.status='confirmed')
   WHERE c.account_id=v_aid AND c.warehouse_id=v_wh AND c.external_sku=v_sku;
   v_applied:=v_applied+1;
   v_committed:=v_committed||jsonb_build_array(jsonb_build_object(
    'mappingId',(SELECT m.id FROM catalog.inventory_sku_mapping m
      WHERE m.account_id=v_aid AND m.warehouse_id=v_wh AND m.external_sku=v_sku AND m.status='confirmed'),
    'externalSku',v_sku,'warehouseExternalId',v_wh_ext,'itemId',v_item,'unit',v_unit,
    'version',v_version,'effectiveAt','next_batch'));
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS v_reason=MESSAGE_TEXT;
   IF SQLSTATE NOT IN('22023','40001','23505') THEN RAISE; END IF;
   v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object(
    'externalSku',v_sku,'warehouseExternalId',v_wh_ext,
    'reason',coalesce(split_part(v_reason,':',1),'INVENTORY_MAPPING_INVALID')));
  END;
 END LOOP;
 v_result:=jsonb_build_object('ok',true,'applied',v_applied,'skipped',v_skipped,'committed',v_committed);
 PERFORM catalog.inventory_record_request(p_request,p_intent,'confirm_inventory_mapping',
  jsonb_build_object('mappings',p_mappings),NULL,v_result,v_actor);
 PERFORM catalog.inventory_audit_write(v_actor,'confirm_inventory_mapping',v_aid::text,
  jsonb_build_object('applied',v_applied,'skipped',v_skipped,'committed',v_committed));
 RETURN v_result;
END $$;

-- 5.7 recheck mapping (immediately leaves aggregation until re-confirmed + new batch)
CREATE OR REPLACE FUNCTION catalog.recheck_inventory_mapping(p_request uuid,p_intent text,
 p_mapping_id uuid,p_note text,p_expected_version integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_map catalog.inventory_sku_mapping; v_result jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.inventory_request_prior(p_request,p_intent,'recheck_inventory_mapping',
  jsonb_build_object('mappingId',p_mapping_id,'expectedVersion',p_expected_version,'reason',p_note));
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_mapping_id IS NULL OR p_expected_version IS NULL OR p_expected_version<=0
  OR (p_note IS NOT NULL AND length(p_note)>1000) THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.mapping:'||p_mapping_id::text,945));
 SELECT * INTO v_map FROM catalog.inventory_sku_mapping m WHERE m.id=p_mapping_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_MAPPING_NOT_FOUND' USING ERRCODE='22023'; END IF;
 PERFORM catalog.inventory_block_if_pending(v_map.account_id,p_request,v_actor,'recheck_inventory_mapping',p_intent,
  jsonb_build_object('mappingId',p_mapping_id,'expectedVersion',p_expected_version,'reason',p_note));
 IF v_map.version<>p_expected_version THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF v_map.status<>'confirmed' THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_NOT_CONFIRMED' USING ERRCODE='22023'; END IF;
 UPDATE catalog.inventory_sku_mapping SET status='recheck',note=coalesce(p_note,note)
 WHERE id=p_mapping_id;
 v_result:=jsonb_build_object('ok',true,'mappingId',v_map.id,'status','recheck',
  'externalSku',v_map.external_sku,'warehouseId',v_map.warehouse_id,'itemId',v_map.item_id,
  'version',v_map.version,'effectiveAt','immediate');
 PERFORM catalog.inventory_record_request(p_request,p_intent,'recheck_inventory_mapping',
  jsonb_build_object('mappingId',p_mapping_id,'note',p_note,'expectedVersion',p_expected_version),
  NULL,v_result,v_actor);
 PERFORM catalog.inventory_audit_write(v_actor,'recheck_inventory_mapping',p_mapping_id::text,v_result);
 RETURN v_result;
END $$;

-- 5.8 disable mapping (version-guarded; immediate exit from aggregation)
CREATE OR REPLACE FUNCTION catalog.disable_inventory_mapping(p_request uuid,p_intent text,p_mapping_id uuid,
 p_note text,p_expected_version integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_map catalog.inventory_sku_mapping; v_result jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.inventory_request_prior(p_request,p_intent,'disable_inventory_mapping',
  jsonb_build_object('mappingId',p_mapping_id,'expectedVersion',p_expected_version,'reason',p_note));
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_mapping_id IS NULL OR p_expected_version IS NULL OR p_expected_version<=0
  OR (p_note IS NOT NULL AND length(p_note)>1000) THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.mapping:'||p_mapping_id::text,945));
 SELECT * INTO v_map FROM catalog.inventory_sku_mapping m WHERE m.id=p_mapping_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_MAPPING_NOT_FOUND' USING ERRCODE='22023'; END IF;
 PERFORM catalog.inventory_block_if_pending(v_map.account_id,p_request,v_actor,'disable_inventory_mapping',p_intent,
  jsonb_build_object('mappingId',p_mapping_id,'expectedVersion',p_expected_version,'reason',p_note));
 IF v_map.version<>p_expected_version THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF v_map.status='disabled' THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_NOT_CONFIRMED' USING ERRCODE='22023'; END IF;
 UPDATE catalog.inventory_sku_mapping SET status='disabled',
  note=coalesce(nullif(btrim(coalesce(p_note,'')),''),note)
 WHERE id=p_mapping_id;
 v_result:=jsonb_build_object('ok',true,'mappingId',v_map.id,'status','disabled',
  'externalSku',v_map.external_sku,'warehouseId',v_map.warehouse_id,'itemId',v_map.item_id,
  'version',v_map.version);
 PERFORM catalog.inventory_record_request(p_request,p_intent,'disable_inventory_mapping',
  jsonb_build_object('mappingId',p_mapping_id,'note',p_note,'expectedVersion',p_expected_version),
  NULL,v_result,v_actor);
 PERFORM catalog.inventory_audit_write(v_actor,'disable_inventory_mapping',p_mapping_id::text,v_result);
 RETURN v_result;
END $$;
-- derive the adjacent earlier successful observation for (account, warehouse, source sku, item).
-- Ordering is (observation_at, published_at, batch_id); inventory_current is NOT used as the source.
CREATE OR REPLACE FUNCTION catalog.inventory_previous_batch_row(p_account uuid,p_warehouse uuid,
 p_sku text,p_item uuid,p_observation timestamptz,p_published timestamptz,p_batch uuid)
 RETURNS TABLE(batch_id uuid,on_hand integer,observation_at timestamptz,item_revision integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT b.id,br.on_hand,b.observation_at,br.item_revision
 FROM catalog.inventory_batch b
 JOIN catalog.inventory_batch_row br ON br.batch_id=b.id
 JOIN catalog.inventory_warehouse w ON w.id=b.warehouse_id AND w.account_id=p_account
 WHERE b.warehouse_id=p_warehouse AND br.external_sku=p_sku AND br.item_id=p_item
  AND br.status='adopted'
  AND (b.observation_at,b.published_at,b.id) < (p_observation,p_published,p_batch)
 ORDER BY b.observation_at DESC,b.published_at DESC,b.id DESC
 LIMIT 1
$$;

-- Normalize a registered raw quantity text into the canonical integer used for publishing and
-- strict F3 comparison (commas/spaces ignored; null for blank; NULL means unparseable).
CREATE OR REPLACE FUNCTION catalog.inventory_parse_quantity_text(p_text text) RETURNS integer
 LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_clean text;
BEGIN
 IF p_text IS NULL THEN RETURN NULL; END IF;
 v_clean:=regexp_replace(p_text,'[,\s]','','g');
 IF v_clean='' THEN RETURN NULL; END IF;
 IF v_clean !~ '^-?[0-9]+$' THEN RETURN NULL; END IF;
 RETURN v_clean::integer;
END $$;

-- Classify one scope warehouse for one item: current/failed/unseen/not_mapped(unmapped_source|no_source).
-- Source presence is independent of the adoption/mapping relation (R1 v4):
--  * known codes = every confirmed mapping of this item in ANY warehouse + candidate suggested SKUs;
--  * source rows = rows of the latest registered run of this account whose warehouse is this one,
--    external_sku is a known code and parse_status='ok';
--  * a warehouse that already has current adopted rows still reports its other not-yet-mapped source
--    rows (pendingSourceRows) instead of hiding them behind the existing mapping;
--  * a source row is never auto-bound and never added to the totals: it is only a pending hint.
-- Adoption vs mapping (R1 v4 final): "对应已确认" (mappedSkus, current confirmed mapping) is NOT the same as
-- "库存已采用" (adoptedSkus, the SKUs of this warehouse's current effective rows that really make up the
-- total). A mapping confirmed after the latest complete batch stays in pendingAdoptionSkus (= mapped minus
-- adopted) until the next complete batch adopts it; it is never counted or labelled "已计入合计" early.
--
-- Read-speed v1: the same classification is now computed from one request-scoped context (one bulk read
-- of effective rows / read states / warehouses / mappings / candidates / latest registered source rows).
-- The old code re-ran the same effective-row/read-state/mapping/source queries for every item x warehouse
-- (50 items x 7 warehouses made a 50-row list take ~4 seconds). No cross-request cache, no second
-- inventory judgement: list and detail both build this context once and use the same core below.
CREATE OR REPLACE FUNCTION catalog.inventory_read_context(p_account uuid,p_scope_wh uuid[],p_item uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_scope uuid[]:=coalesce(p_scope_wh,'{}'::uuid[]); v_eff jsonb; v_states jsonb; v_ws jsonb;
 v_maps jsonb; v_cands jsonb; v_run uuid; v_rows jsonb; v_rev jsonb; v_items jsonb:='{}'::jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'itemId',e.item_id,'warehouseId',e.warehouse_id,'warehouseExternalId',e.warehouse_external_id,
   'warehouseName',e.warehouse_name,'market',e.market,'externalSku',e.external_sku,
   'mappingId',e.mapping_id,'mappingVersion',e.mapping_version,'variantId',e.variant_id,
   'unit',e.unit,'onHand',e.on_hand,'orderLocked',e.order_locked,
   'warehouseAvailable',e.warehouse_available,'activityReserved',e.activity_reserved,
   'inTransit',e.in_transit,'gtin',e.gtin,'observedAt',e.observed_at,
   'batchId',e.batch_id,'excelRow',e.excel_row,'itemRevision',e.item_revision)
   ORDER BY e.warehouse_external_id,e.external_sku,e.item_id),'[]'::jsonb)
 INTO v_eff FROM catalog.inventory_effective_rows(p_account,v_scope) e
 WHERE p_item IS NULL OR e.item_id=p_item;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseId',r.warehouse_id,'externalWarehouseId',r.external_warehouse_id,
   'warehouseName',r.warehouse_name,'market',r.market,'warehouseStatus',r.warehouse_status,
   'lastSuccessAt',r.last_success_at,'lastSuccessRunId',r.last_success_run_id,
   'lastBatchId',r.last_batch_id,'lastPublishAt',r.last_publish_at,
   'lastObservationAt',r.last_observation_at,'latestRunId',r.latest_run_id,
   'latestRunStatus',r.latest_run_status,'latestRunFinishedAt',r.latest_run_finished_at,
   'failed',r.failed,'stale',r.stale,'lastErrorCode',r.last_error_code)
   ORDER BY r.external_warehouse_id),'[]'::jsonb)
 INTO v_states FROM catalog.inventory_warehouse_read_state(p_account,v_scope) r;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'externalId',w.external_warehouse_id,
   'name',w.external_name,'market',w.market) ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_ws FROM catalog.inventory_warehouse w WHERE w.account_id=p_account AND w.id=ANY(v_scope);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'itemId',m.item_id,'warehouseId',m.warehouse_id,
   'externalSku',m.external_sku,'version',m.version,'status',m.status,'evidence',m.evidence)
   ORDER BY m.item_id,m.external_sku,m.version DESC),'[]'::jsonb)
 INTO v_maps FROM catalog.inventory_sku_mapping m
 WHERE m.account_id=p_account AND (p_item IS NULL OR m.item_id=p_item);
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseId',c.warehouse_id,'externalSku',c.external_sku,
   'suggestedItemId',c.suggested_item_id,'status',c.status)
   ORDER BY c.suggested_item_id,c.external_sku),'[]'::jsonb)
 INTO v_cands FROM catalog.inventory_mapping_candidate c
 WHERE c.account_id=p_account AND (p_item IS NULL OR c.suggested_item_id=p_item);
 SELECT r.id INTO v_run FROM catalog.inventory_sync_run r
 WHERE r.account_id=p_account AND EXISTS(SELECT 1 FROM catalog.inventory_run_row x WHERE x.run_id=r.id)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
 IF v_run IS NOT NULL THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseExternalId',x.warehouse_external_id,
    'externalSku',x.external_sku,'excelRow',x.excel_row,
    'onHand',catalog.inventory_parse_quantity_text(x.on_hand_text),'parseStatus',x.parse_status)
    ORDER BY x.warehouse_external_id,x.excel_row,x.external_sku),'[]'::jsonb)
  INTO v_rows FROM catalog.inventory_run_row x WHERE x.run_id=v_run
   AND (p_item IS NULL OR x.external_sku IN (
    SELECT m.external_sku FROM catalog.inventory_sku_mapping m
    WHERE m.account_id=p_account AND m.item_id=p_item AND m.status='confirmed'
    UNION
    SELECT c.external_sku FROM catalog.inventory_mapping_candidate c
    WHERE c.account_id=p_account AND c.suggested_item_id=p_item));
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',x.item_id,'warehouseId',x.wid,
   'missing',x.missing) ORDER BY x.item_id,x.wid),'[]'::jsonb)
 INTO v_rev FROM (
  SELECT br.item_id,b.warehouse_id wid,count(*)::integer missing
  FROM catalog.inventory_batch_row br
  JOIN catalog.inventory_batch b ON b.id=br.batch_id
  WHERE b.warehouse_id=ANY(v_scope) AND br.status='adopted' AND br.item_revision IS NULL
   AND br.item_id IS NOT NULL AND (p_item IS NULL OR br.item_id=p_item)
  GROUP BY br.item_id,b.warehouse_id) x;
 -- Group the same request-scoped facts per item once, so a 50-row list does not re-parse the full
 -- arrays for every item. The per-item slice below feeds the same core used by detail/totals.
 IF p_item IS NULL THEN
  WITH effs AS (SELECT value AS e FROM jsonb_array_elements(v_eff) t(value)),
   mp AS (SELECT value AS m FROM jsonb_array_elements(v_maps) t(value)),
   cd AS (SELECT value AS c FROM jsonb_array_elements(v_cands) t(value)),
   rv AS (SELECT value AS r FROM jsonb_array_elements(v_rev) t(value)),
   eff_by AS (SELECT coalesce(jsonb_object_agg(item_id,rows),'{}'::jsonb) j FROM (
    SELECT e->>'itemId' item_id,jsonb_agg(e ORDER BY e->>'warehouseExternalId',e->>'externalSku') rows
    FROM effs GROUP BY 1) g),
   map_by AS (SELECT coalesce(jsonb_object_agg(item_id,rows),'{}'::jsonb) j FROM (
    SELECT m->>'itemId' item_id,jsonb_agg(m ORDER BY m->>'externalSku',(m->>'version')::integer DESC) rows
    FROM mp GROUP BY 1) g),
   cand_by AS (SELECT coalesce(jsonb_object_agg(item_id,rows),'{}'::jsonb) j FROM (
    SELECT c->>'suggestedItemId' item_id,jsonb_agg(c ORDER BY c->>'externalSku') rows
    FROM cd WHERE c->>'suggestedItemId' IS NOT NULL GROUP BY 1) g),
   rev_by AS (SELECT coalesce(jsonb_object_agg(item_id,missing),'{}'::jsonb) j FROM (
    SELECT r->>'itemId' item_id,sum((r->>'missing')::integer)::integer missing
    FROM rv GROUP BY 1) g),
   known AS (
    SELECT DISTINCT m->>'itemId' item_id,m->>'externalSku' sku FROM mp m WHERE m->>'status'='confirmed'
    UNION
    SELECT DISTINCT c->>'suggestedItemId',c->>'externalSku' FROM cd c WHERE c->>'suggestedItemId' IS NOT NULL),
   rr AS (SELECT value AS r FROM jsonb_array_elements(coalesce(v_rows,'[]'::jsonb)) t(value)),
   src_by AS (SELECT coalesce(jsonb_object_agg(item_id,rows),'{}'::jsonb) j FROM (
    SELECT k.item_id,jsonb_agg(r ORDER BY r->>'warehouseExternalId',(r->>'excelRow')::integer,r->>'externalSku') rows
    FROM known k JOIN rr r ON r->>'externalSku'=k.sku GROUP BY k.item_id) g),
   ids AS (SELECT item_id FROM (
    SELECT jsonb_object_keys(eff_by.j) item_id FROM eff_by
    UNION SELECT jsonb_object_keys(map_by.j) FROM map_by
    UNION SELECT jsonb_object_keys(cand_by.j) FROM cand_by
    UNION SELECT jsonb_object_keys(rev_by.j) FROM rev_by) z)
  SELECT jsonb_object_agg(i.item_id,jsonb_build_object(
    'effectiveRows',coalesce(eff_by.j->i.item_id,'[]'::jsonb),
    'mappings',coalesce(map_by.j->i.item_id,'[]'::jsonb),
    'candidates',coalesce(cand_by.j->i.item_id,'[]'::jsonb),
    'runRows',coalesce(src_by.j->i.item_id,'[]'::jsonb),
    'revisionMissing',coalesce((rev_by.j->>i.item_id)::integer,0)))
  INTO v_items
  FROM ids i CROSS JOIN eff_by CROSS JOIN map_by CROSS JOIN cand_by CROSS JOIN rev_by CROSS JOIN src_by;
 END IF;
 RETURN jsonb_build_object('effectiveRows',v_eff,'readStates',v_states,'warehouses',v_ws,
  'mappings',v_maps,'candidates',v_cands,'latestRunId',v_run,'runRows',coalesce(v_rows,'[]'::jsonb),
  'revisionMissing',v_rev,'items',coalesce(v_items,'{}'::jsonb));
END $$;

-- Per-warehouse gap for one item, from the request-scoped context (one query for all scope warehouses).
-- Internal helper: list/detail/wrappers call it, it is not granted to the runtime roles.
CREATE OR REPLACE FUNCTION catalog.inventory_item_gaps(p_account uuid,p_item uuid,p_scope_wh uuid[],p_ctx jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_gaps jsonb; v_state jsonb; v_cur_obs timestamptz; v_cur_pub timestamptz; v_prev record;
 v_sku text; v_prev_qty integer; v_prev_found boolean; v_prev_at timestamptz; v_i integer; v_len integer;
 v_wh uuid; v_batch uuid;
BEGIN
 WITH wh AS (
  SELECT x.id,x."externalId",x.name,x.market
  FROM jsonb_to_recordset(p_ctx->'warehouses') AS x(id uuid,"externalId" text,name text,market text)
  WHERE x.id=ANY(p_scope_wh)
 ), maps AS (
  SELECT m.* FROM jsonb_to_recordset(p_ctx->'mappings') AS m(id uuid,"itemId" uuid,"warehouseId" uuid,
    "externalSku" text,version integer,status text,evidence jsonb)
  WHERE m."itemId"=p_item
 ), cands AS (
  SELECT c.* FROM jsonb_to_recordset(p_ctx->'candidates') AS c("warehouseId" uuid,"externalSku" text,
    "suggestedItemId" uuid,status text)
  WHERE c."suggestedItemId"=p_item
 ), eff AS (
  SELECT e.* FROM jsonb_to_recordset(p_ctx->'effectiveRows') AS e("itemId" uuid,"warehouseId" uuid,
    "warehouseExternalId" text,"warehouseName" text,market text,"externalSku" text,
    "mappingId" uuid,"mappingVersion" integer,"variantId" uuid,unit text,"onHand" integer,
    "orderLocked" integer,"warehouseAvailable" integer,"activityReserved" integer,"inTransit" integer,
    gtin text,"observedAt" timestamptz,"batchId" uuid,"excelRow" integer,"itemRevision" integer)
  WHERE e."itemId"=p_item AND e."warehouseId"=ANY(p_scope_wh)
 ), states AS (
  SELECT r.* FROM jsonb_to_recordset(p_ctx->'readStates') AS r("warehouseId" uuid,
    "externalWarehouseId" text,"warehouseName" text,market text,"warehouseStatus" text,
    "lastSuccessAt" timestamptz,"lastSuccessRunId" uuid,"lastBatchId" uuid,
    "lastPublishAt" timestamptz,"lastObservationAt" timestamptz,"latestRunId" uuid,
    "latestRunStatus" text,"latestRunFinishedAt" timestamptz,failed boolean,stale boolean,"lastErrorCode" text)
  WHERE r."warehouseId"=ANY(p_scope_wh)
 ), known AS (
  SELECT DISTINCT k."externalSku" AS sku FROM (
   SELECT m."externalSku" FROM maps m WHERE m.status='confirmed'
   UNION SELECT c."externalSku" FROM cands c) k WHERE k."externalSku" IS NOT NULL
 ), runrows AS (
  SELECT r.* FROM jsonb_to_recordset(p_ctx->'runRows') AS r("warehouseExternalId" text,
    "externalSku" text,"excelRow" integer,"onHand" integer,"parseStatus" text)
  WHERE r."parseStatus"='ok' AND r."externalSku" IN (SELECT sku FROM known)
 ), eff_wh AS (
  SELECT "warehouseId" wid,count(*)::integer eff FROM eff GROUP BY 1
 ), adopted AS (
  SELECT "warehouseId" wid,array_agg(DISTINCT "externalSku" ORDER BY "externalSku")
    FILTER (WHERE "externalSku" IS NOT NULL) skus FROM eff GROUP BY 1
 ), mapped AS (
  SELECT m."warehouseId" wid,array_agg(DISTINCT m."externalSku" ORDER BY m."externalSku") skus
  FROM maps m WHERE m.status='confirmed' GROUP BY 1
 ), src AS (
  SELECT wh.id wid,count(*)::integer cnt,
    array_agg(DISTINCT r."externalSku" ORDER BY r."externalSku") skus
  FROM runrows r JOIN wh ON wh."externalId"=r."warehouseExternalId"
  GROUP BY wh.id
 ), pend AS (
  SELECT wh.id wid,
   jsonb_agg(jsonb_build_object('externalSku',r."externalSku",'excelRow',r."excelRow",
     'onHand',r."onHand",'mapped',mm.id IS NOT NULL,'mappingId',mm.id)
     ORDER BY r."excelRow",r."externalSku") rows,
   count(*) FILTER (WHERE mm.id IS NULL)::integer pending_count,
   array_agg(DISTINCT r."externalSku" ORDER BY r."externalSku") FILTER (WHERE mm.id IS NULL) pending_skus
  FROM runrows r
  JOIN wh ON wh."externalId"=r."warehouseExternalId"
  LEFT JOIN LATERAL (SELECT m.id FROM maps m WHERE m."warehouseId"=wh.id
    AND m."externalSku"=r."externalSku" AND m.status='confirmed'
    ORDER BY m.version DESC LIMIT 1) mm ON true
  GROUP BY wh.id
 ), pending_adoption AS (
  SELECT wid,array_agg(sku ORDER BY sku) skus FROM (
   SELECT m."warehouseId" wid,m."externalSku" sku FROM maps m WHERE m.status='confirmed'
   EXCEPT
   SELECT e."warehouseId",e."externalSku" FROM eff e WHERE e."externalSku" IS NOT NULL) x
  WHERE sku IS NOT NULL AND btrim(sku)<>'' GROUP BY wid
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseId',wh.id,
   'status',CASE WHEN coalesce(st.failed,false) THEN 'failed'
     WHEN coalesce(ew.eff,0)>0 THEN 'current'
     WHEN coalesce(cardinality(mp.skus),0)>0 THEN 'unseen'
     ELSE 'not_mapped' END,
   'reason',CASE WHEN coalesce(st.failed,false) THEN 'failed'
     WHEN coalesce(ew.eff,0)>0 THEN NULL
     WHEN coalesce(cardinality(mp.skus),0)>0 THEN 'unseen'
     WHEN coalesce(sr.cnt,0)>0 THEN 'unmapped_source'
     ELSE 'no_source' END,
   'effRows',coalesce(ew.eff,0),
   'sourceRowCount',coalesce(sr.cnt,0),
   'sourceSkus',to_jsonb(coalesce(sr.skus,'{}'::text[])),
   'pendingSourceRows',coalesce(pd.rows,'[]'::jsonb),
   'pendingSourceRowCount',coalesce(pd.pending_count,0),
   'pendingSkus',to_jsonb(coalesce(pd.pending_skus,'{}'::text[])),
   'mappedSkus',to_jsonb(coalesce(mp.skus,'{}'::text[])),
   'adoptedSkus',to_jsonb(coalesce(ad.skus,'{}'::text[])),
   'pendingAdoptionSkus',to_jsonb(coalesce(pa.skus,'{}'::text[])),
   'lastKnownQty',NULL::integer,'lastKnownObservedAt',NULL::timestamptz)
   ORDER BY wh."externalId"),'[]'::jsonb)
 INTO v_gaps
 FROM wh
 LEFT JOIN eff_wh ew ON ew.wid=wh.id
 LEFT JOIN adopted ad ON ad.wid=wh.id
 LEFT JOIN mapped mp ON mp.wid=wh.id
 LEFT JOIN states st ON st."warehouseId"=wh.id
 LEFT JOIN src sr ON sr.wid=wh.id
 LEFT JOIN pend pd ON pd.wid=wh.id
 LEFT JOIN pending_adoption pa ON pa.wid=wh.id;
 -- 本次未见：上次已知数量仍来自该仓相邻的上一批次（不补 0、不用旧 current 指针）。
 v_len:=jsonb_array_length(v_gaps);
 FOR v_i IN 0..v_len-1 LOOP
  IF v_gaps->v_i->>'status'='unseen' THEN
   v_wh:=(v_gaps->v_i->>'warehouseId')::uuid;
   SELECT r INTO v_state FROM jsonb_array_elements(p_ctx->'readStates') r
    WHERE (r->>'warehouseId')::uuid=v_wh LIMIT 1;
   v_batch:=(v_state->>'lastBatchId')::uuid;
   IF v_batch IS NOT NULL THEN
    SELECT b.observation_at,b.published_at INTO v_cur_obs,v_cur_pub
    FROM catalog.inventory_batch b WHERE b.id=v_batch;
    v_prev_qty:=NULL; v_prev_found:=false; v_prev_at:=NULL;
    FOR v_sku IN SELECT m."externalSku" FROM jsonb_to_recordset(p_ctx->'mappings')
      AS m("itemId" uuid,"warehouseId" uuid,"externalSku" text,status text)
      WHERE m."itemId"=p_item AND m."warehouseId"=v_wh AND m.status='confirmed' LOOP
     SELECT * INTO v_prev FROM catalog.inventory_previous_batch_row(
      p_account,v_wh,v_sku,p_item,v_cur_obs,v_cur_pub,v_batch);
     IF v_prev.batch_id IS NOT NULL THEN
      v_prev_found:=true;
      v_prev_qty:=coalesce(v_prev_qty,0)+coalesce(v_prev.on_hand,0);
      IF v_prev_at IS NULL OR v_prev.observation_at>v_prev_at THEN v_prev_at:=v_prev.observation_at; END IF;
     END IF;
    END LOOP;
    v_gaps:=jsonb_set(v_gaps,ARRAY[v_i::text,'lastKnownQty'],
      CASE WHEN v_prev_found THEN to_jsonb(v_prev_qty) ELSE 'null'::jsonb END);
    v_gaps:=jsonb_set(v_gaps,ARRAY[v_i::text,'lastKnownObservedAt'],
      CASE WHEN v_prev_at IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_prev_at) END);
   END IF;
  END IF;
 END LOOP;
 RETURN v_gaps;
END $$;

-- Shared item summary used by list/detail/totals/gaps (single effective-row model), computed from the
-- request-scoped context. Output shape/semantics are unchanged from the accepted version: per-unit
-- groups, pending dual-code totals (never added), coverage, pending source/adoption hints, failed/unseen.
CREATE OR REPLACE FUNCTION catalog.inventory_item_summary_core(p_account uuid,p_item uuid,p_scope_wh uuid[],
 p_ctx jsonb,p_identity jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_agg jsonb; v_gaps jsonb; v_gap_by_wh jsonb:='{}'::jsonb; v_scope uuid[]:=coalesce(p_scope_wh,'{}'::uuid[]);
 v_covered integer:=0; v_gap jsonb; v_w jsonb; v_rows integer;
 v_not_mapped jsonb:='[]'::jsonb; v_unseen jsonb:='[]'::jsonb; v_failed jsonb:='[]'::jsonb;
 v_pending_sources jsonb:='[]'::jsonb; v_has_pending boolean:=false;
 v_pending_adoption jsonb:='[]'::jsonb; v_has_pending_adoption boolean:=false;
 v_states jsonb; v_state jsonb; v_i integer; v_len integer;
BEGIN
 IF p_identity IS NULL THEN RETURN NULL; END IF;
 WITH eff AS (
  SELECT e.* FROM jsonb_to_recordset(p_ctx->'effectiveRows') AS e("itemId" uuid,"warehouseId" uuid,
    "warehouseExternalId" text,"warehouseName" text,market text,"externalSku" text,
    "mappingId" uuid,"mappingVersion" integer,"variantId" uuid,unit text,"onHand" integer,
    "orderLocked" integer,"warehouseAvailable" integer,"activityReserved" integer,"inTransit" integer,
    gtin text,"observedAt" timestamptz,"batchId" uuid,"excelRow" integer,"itemRevision" integer)
  WHERE e."itemId"=p_item AND e."warehouseId"=ANY(v_scope)
 ), wh AS (
  SELECT x.id,x.market FROM jsonb_to_recordset(p_ctx->'warehouses') AS x(id uuid,"externalId" text,name text,market text)
  WHERE x.id=ANY(v_scope)
 ), maps AS (
  SELECT m.id,m.evidence FROM jsonb_to_recordset(p_ctx->'mappings') AS m(id uuid,"itemId" uuid,
    "warehouseId" uuid,"externalSku" text,version integer,status text,evidence jsonb)
  WHERE m."itemId"=p_item
 ), excl AS (
  SELECT e.* FROM eff e WHERE NOT EXISTS(SELECT 1 FROM eff e2
   WHERE e2."warehouseId"=e."warehouseId" AND e2.unit IS NOT DISTINCT FROM e.unit
    AND e2."externalSku"<>e."externalSku")
 ), units AS (
  SELECT jsonb_agg(jsonb_build_object('unit',u.unit,'subtotal',u.subtotal,'knownOnHand',u.known,
    'rowCount',u.rows,'warehouseCount',u.whs,'hasUnknownQuantity',u.unknown)
    ORDER BY u.unit NULLS FIRST) j
  FROM (SELECT unit,sum("onHand") subtotal,
    count(*) FILTER (WHERE "onHand" IS NOT NULL)::integer known,count(*)::integer rows,
    count(DISTINCT "warehouseId")::integer whs,bool_or("onHand" IS NULL) unknown
   FROM excl GROUP BY unit) u
 ), unit_count AS (SELECT count(DISTINCT unit)::integer n FROM excl),
 obs AS (SELECT max("observedAt") last_observed,count(*)>0 has_rows FROM eff),
 pending_totals AS (
  SELECT coalesce(jsonb_agg(g ORDER BY g->>'externalId'),'[]'::jsonb) j FROM (
   SELECT jsonb_build_object('warehouseId',e."warehouseId",'externalId',e."warehouseExternalId",
    'name',e."warehouseName",'unit',e.unit,'rowCount',count(*)::integer,
    'rows',jsonb_agg(jsonb_build_object('externalSku',e."externalSku",'onHand',e."onHand",
      'excelRow',e."excelRow",'observedAt',e."observedAt") ORDER BY e."externalSku")) g
   FROM eff e GROUP BY e."warehouseId",e."warehouseExternalId",e."warehouseName",e.unit
   HAVING count(*)>1) x
 ), known AS (
  SELECT CASE WHEN (SELECT n FROM unit_count)=1 THEN
    (SELECT sum("onHand") FROM excl WHERE unit IS NOT NULL) ELSE NULL END val
 ), extras AS (
  SELECT (SELECT e.gtin FROM eff e WHERE e.gtin IS NOT NULL
    ORDER BY e."observedAt" DESC,e."batchId" DESC,e."externalSku" LIMIT 1) gtin,
   (SELECT CASE WHEN count(DISTINCT market)>1 THEN NULL ELSE min(market) END FROM eff) market,
   (SELECT coalesce(jsonb_agg(DISTINCT m ORDER BY m),'[]'::jsonb)
     FROM (SELECT market m FROM eff WHERE market IS NOT NULL) x) markets,
   (SELECT EXISTS(SELECT 1 FROM eff WHERE market IS NULL)) has_unknown_market,
   (SELECT bool_or(coalesce((m.evidence->>'verification')='true',false))
     FROM eff e JOIN maps m ON m.id=e."mappingId") verification,
   (SELECT bool_or(coalesce((m.evidence->>'unitConfirmed')='false',false))
     FROM eff e JOIN maps m ON m.id=e."mappingId") unit_unconfirmed,
   (CASE WHEN jsonb_typeof(p_ctx->'revisionMissing')='array' THEN
     (SELECT coalesce(sum((r->>'missing')::integer),0)::integer
      FROM jsonb_array_elements(p_ctx->'revisionMissing') r
      WHERE (r->>'itemId')::uuid=p_item AND (r->>'warehouseId')::uuid=ANY(v_scope))
    ELSE coalesce((p_ctx->>'revisionMissing')::integer,0) END) revision_missing,
   (SELECT EXISTS(SELECT 1 FROM jsonb_to_recordset(p_ctx->'mappings')
     AS m("itemId" uuid,"warehouseId" uuid,status text)
     WHERE m."itemId"=p_item AND m.status='confirmed' AND m."warehouseId"=ANY(v_scope))) mapped
 ), has_unknown AS (
  SELECT (SELECT has_unknown_market FROM extras) OR EXISTS(
   SELECT 1 FROM eff e JOIN wh ON wh.id=e."warehouseId" WHERE wh.market IS NULL) b
 )
 SELECT jsonb_build_object(
  'unitGroups',coalesce((SELECT j FROM units),'[]'::jsonb),
  'unitCount',(SELECT n FROM unit_count),
  'knownSubtotal',(SELECT val FROM known),
  'gtin',(SELECT gtin FROM extras),
  'market',(SELECT market FROM extras),
  'markets',(SELECT markets FROM extras),
  'hasUnknownMarket',(SELECT b FROM has_unknown),
  'verification',(SELECT verification FROM extras),
  'unitUnconfirmed',(SELECT unit_unconfirmed FROM extras),
  'itemRevisionMissing',(SELECT revision_missing FROM extras),
  'lastObservedAt',(SELECT last_observed FROM obs),
  'hasRows',(SELECT has_rows FROM obs),
  'pendingTotalWarehouses',(SELECT j FROM pending_totals),
  'hasPendingTotal',jsonb_array_length((SELECT j FROM pending_totals))>0,
  'mapped',(SELECT mapped FROM extras)
 ) INTO v_agg;
 v_gaps:=catalog.inventory_item_gaps(p_account,p_item,p_scope_wh,p_ctx);
 SELECT coalesce(jsonb_object_agg(g->>'warehouseId',g),'{}'::jsonb) INTO v_gap_by_wh
 FROM jsonb_array_elements(v_gaps) g;
 v_states:=p_ctx->'readStates';
 FOR v_w IN SELECT x FROM jsonb_array_elements(p_ctx->'warehouses') x
   WHERE (x->>'id')::uuid=ANY(v_scope) ORDER BY x->>'externalId' LOOP
  v_gap:=v_gap_by_wh->(v_w->>'id');
  v_rows:=coalesce((v_gap->>'effRows')::integer,0);
  IF v_rows>0 THEN v_covered:=v_covered+1; END IF;
  IF v_gap->>'status'='not_mapped' THEN
   v_not_mapped:=v_not_mapped||jsonb_build_array(jsonb_build_object(
    'warehouseId',v_w->>'id','externalId',v_w->>'externalId','name',v_w->>'name',
    'reason',v_gap->>'reason','sourceRowCount',(v_gap->>'sourceRowCount')::integer,
    'sourceSkus',coalesce(v_gap->'sourceSkus','[]'::jsonb),
    'pendingSourceRows',coalesce(v_gap->'pendingSourceRows','[]'::jsonb)));
  ELSIF v_gap->>'status'='unseen' THEN
   v_unseen:=v_unseen||jsonb_build_array(jsonb_build_object(
    'warehouseId',v_w->>'id','externalId',v_w->>'externalId','name',v_w->>'name',
    'reason','unseen','sourceRowCount',(v_gap->>'sourceRowCount')::integer,
    'lastKnownQty',(v_gap->>'lastKnownQty')::integer,
    'lastKnownObservedAt',(v_gap->>'lastKnownObservedAt')::timestamptz));
  ELSIF v_gap->>'status'='failed' THEN
   SELECT r INTO v_state FROM jsonb_array_elements(v_states) r
    WHERE (r->>'warehouseId')::uuid=(v_w->>'id')::uuid LIMIT 1;
   v_failed:=v_failed||jsonb_build_array(jsonb_build_object(
    'warehouseId',v_w->>'id','externalId',v_w->>'externalId','name',v_w->>'name',
    'reason','failed','lastSuccessAt',(v_state->>'lastSuccessAt')::timestamptz,
    'lastErrorCode',v_state->>'lastErrorCode','stale',(v_state->>'stale')::boolean));
  END IF;
  -- R1 v4: a warehouse with current adopted rows may still have other known-code source rows that are
  -- not mapped yet. They are NOT adopted and NOT counted; report them so the UI can show the same-warehouse
  -- partial gap instead of hiding it behind the existing mapping.
  IF v_rows>0 AND coalesce((v_gap->>'pendingSourceRowCount')::integer,0)>0 THEN
   v_pending_sources:=v_pending_sources||jsonb_build_array(jsonb_build_object(
    'warehouseId',v_w->>'id','externalId',v_w->>'externalId','name',v_w->>'name',
    'sourceRowCount',(v_gap->>'sourceRowCount')::integer,
    'pendingSourceRowCount',(v_gap->>'pendingSourceRowCount')::integer,
    'pendingSkus',coalesce(v_gap->'pendingSkus','[]'::jsonb),
    'mappedSkus',coalesce(v_gap->'mappedSkus','[]'::jsonb),
    'adoptedSkus',coalesce(v_gap->'adoptedSkus','[]'::jsonb),
    'pendingSourceRows',coalesce(v_gap->'pendingSourceRows','[]'::jsonb)));
   v_has_pending:=true;
  END IF;
  -- R1 v4 final: same-warehouse confirmed mappings that are NOT adopted yet (the latest complete batch
  -- does not contain them / they resolve to no effective row). Not counted; shown as
  -- "对应已确认、等待下一次完整同步采用" instead of "已计入合计".
  IF jsonb_array_length(coalesce(v_gap->'pendingAdoptionSkus','[]'::jsonb))>0 THEN
   v_pending_adoption:=v_pending_adoption||jsonb_build_array(jsonb_build_object(
    'warehouseId',v_w->>'id','externalId',v_w->>'externalId','name',v_w->>'name',
    'adoptedSkus',coalesce(v_gap->'adoptedSkus','[]'::jsonb),
    'mappedSkus',coalesce(v_gap->'mappedSkus','[]'::jsonb),
    'pendingAdoptionSkus',coalesce(v_gap->'pendingAdoptionSkus','[]'::jsonb)));
   v_has_pending_adoption:=true;
  END IF;
 END LOOP;
 RETURN p_identity||jsonb_build_object(
  'gtin',v_agg->'gtin','market',v_agg->'market','lastObservedAt',v_agg->'lastObservedAt',
  'unitGroups',v_agg->'unitGroups','unitCount',v_agg->'unitCount','unitConflict',(v_agg->>'unitCount')::integer>1,
  'knownSubtotal',v_agg->'knownSubtotal',
  'knownSubtotalComplete',(NOT (v_agg->>'hasPendingTotal')::boolean AND (v_agg->>'unitCount')::integer<=1),
  'pendingTotalWarehouses',v_agg->'pendingTotalWarehouses','hasPendingTotal',v_agg->'hasPendingTotal',
  'warehouseCount',v_covered,
  'coverage',jsonb_build_object('scopeWarehouses',cardinality(v_scope),'coveredWarehouses',v_covered),
  'hasCurrentData',v_agg->'hasRows','mapped',v_agg->'mapped',
  'notMappedWarehouses',v_not_mapped,'unseenWarehouses',v_unseen,'failedWarehouses',v_failed,
  'pendingSourceWarehouses',v_pending_sources,'hasPendingSourceWarehouses',v_has_pending,
  'pendingAdoptionWarehouses',v_pending_adoption,'hasPendingAdoptionWarehouses',v_has_pending_adoption,
  'markets',v_agg->'markets','hasUnknownMarket',v_agg->'hasUnknownMarket',
  'verificationOnly',coalesce((v_agg->>'verification')::boolean,false),
  'unitUnconfirmed',coalesce((v_agg->>'unitUnconfirmed')::boolean,false),
  'itemRevisionMissing',(v_agg->>'itemRevisionMissing')::integer);
END $$;

-- Backwards-compatible app function: same signature/output as before, one request-scoped build.
CREATE OR REPLACE FUNCTION catalog.inventory_item_warehouse_gap(p_account uuid,p_item uuid,p_warehouse uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_ctx jsonb; v_gaps jsonb; v_gap jsonb;
BEGIN
 v_ctx:=catalog.inventory_read_context(p_account,ARRAY[p_warehouse],p_item);
 v_gaps:=catalog.inventory_item_gaps(p_account,p_item,ARRAY[p_warehouse],v_ctx);
 SELECT g INTO v_gap FROM jsonb_array_elements(v_gaps) g
  WHERE (g->>'warehouseId')::uuid=p_warehouse LIMIT 1;
 RETURN v_gap-'warehouseId';
END $$;

CREATE OR REPLACE FUNCTION catalog.inventory_item_summary(p_account uuid,p_item uuid,p_scope_wh uuid[])
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_identity jsonb; v_ctx jsonb;
BEGIN
 v_identity:=catalog.inventory_item_identity(p_item);
 IF v_identity IS NULL THEN RETURN NULL; END IF;
 v_ctx:=catalog.inventory_read_context(p_account,p_scope_wh,p_item);
 RETURN catalog.inventory_item_summary_core(p_account,p_item,p_scope_wh,v_ctx,v_identity);
END $$;

-- 5.9 inventory list
CREATE OR REPLACE FUNCTION catalog.read_inventory_list(p_search text,p_warehouse text,p_market text,
 p_limit integer,p_offset integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope_json jsonb; v_scope_wh uuid[]:='{}'::uuid[];
 v_filter_wh uuid; v_search text; v_market_filter text; v_limit integer; v_offset integer;
 v_total integer:=0; v_items jsonb:='[]'::jsonb; v_market_options jsonb; v_ctx jsonb; v_page jsonb;
 v_page_items jsonb:='[]'::jsonb; v_identities jsonb:='{}'::jsonb; v_identity jsonb; v_item_ctx jsonb;
 v_i integer; v_len integer;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 v_limit:=greatest(1,least(coalesce(p_limit,50),200));
 v_offset:=greatest(0,coalesce(p_offset,0));
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_market_filter:=nullif(btrim(coalesce(p_market,'')),'');
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('total',0,'offset',v_offset,'limit',v_limit,'items','[]'::jsonb,
   'scope',jsonb_build_object('warehouseCount',0,'empty',true,'lastAllSuccessAt',NULL::timestamptz),
   'marketOptions','[]'::jsonb,'domestic','not_connected','inTransit','not_connected'); END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope_wh:=ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(v_scope_json->'warehouseIds') x);
 IF p_warehouse IS NOT NULL AND length(btrim(p_warehouse))>0 THEN
  BEGIN
   v_filter_wh:=(btrim(p_warehouse))::uuid;
  EXCEPTION WHEN OTHERS THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023';
  END;
  IF NOT EXISTS(SELECT 1 FROM catalog.inventory_warehouse w WHERE w.id=v_filter_wh AND w.account_id=v_aid) THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_scope_wh:=ARRAY(SELECT x FROM unnest(v_scope_wh) x WHERE x=v_filter_wh);
 END IF;
 IF v_market_filter IS NOT NULL THEN
  v_scope_wh:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.id=ANY(v_scope_wh) AND w.market=v_market_filter);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('market',x.market,
   'warehouseCount',x.warehouse_count,'warehouses',x.warehouses) ORDER BY x.market),'[]'::jsonb)
 INTO v_market_options FROM (
   SELECT m.market,count(*)::integer AS warehouse_count,
    jsonb_agg(jsonb_build_object('id',m.id,'externalId',m.external_warehouse_id,
      'name',m.external_name)) AS warehouses
   FROM (SELECT w.id,w.external_warehouse_id,w.external_name,w.market
     FROM catalog.inventory_warehouse w
     WHERE w.account_id=v_aid AND w.market IS NOT NULL
      AND w.id=ANY(v_scope_wh)) m
   GROUP BY m.market) x;
 -- one request-scoped read of the whole effective-row model instead of per-item re-reads
 v_ctx:=catalog.inventory_read_context(v_aid,v_scope_wh,NULL);
 WITH refs AS (
  SELECT m."itemId" item_id,m."warehouseId" warehouse_id
  FROM jsonb_to_recordset(v_ctx->'mappings') AS m("itemId" uuid,"warehouseId" uuid,status text)
  WHERE m.status='confirmed' AND m."warehouseId"=ANY(v_scope_wh)
  UNION
  SELECT m."itemId",m."warehouseId"
  FROM jsonb_to_recordset(v_ctx->'mappings') AS m("itemId" uuid,"warehouseId" uuid,status text)
  WHERE m.status IN('recheck','disabled') AND m."warehouseId"=ANY(v_scope_wh)
  UNION
  SELECT c."suggestedItemId",c."warehouseId"
  FROM jsonb_to_recordset(v_ctx->'candidates') AS c("warehouseId" uuid,"externalSku" text,
    "suggestedItemId" uuid,status text)
  WHERE c.status='pending' AND c."suggestedItemId" IS NOT NULL AND c."warehouseId"=ANY(v_scope_wh)
  UNION
  SELECT e."itemId",e."warehouseId"
  FROM jsonb_to_recordset(v_ctx->'effectiveRows') AS e("itemId" uuid,"warehouseId" uuid,
    "externalSku" text,gtin text)
  WHERE e."warehouseId"=ANY(v_scope_wh)
 ), item_ids AS (SELECT DISTINCT item_id FROM refs WHERE item_id IS NOT NULL),
 matched AS (
  SELECT i.item_id,
   (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.item_id) AS ice_code
  FROM item_ids i
  WHERE v_search IS NULL
   OR EXISTS(SELECT 1 FROM catalog.catalog_item_code c WHERE c.item_id=i.item_id AND c.ice_code ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.item_current ic JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
     WHERE ic.item_id=i.item_id AND r.name_cn ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM jsonb_to_recordset(v_ctx->'effectiveRows') AS e("itemId" uuid,
      "externalSku" text,gtin text)
     WHERE e."itemId"=i.item_id AND (coalesce(e."externalSku",'') ILIKE '%'||v_search||'%'
       OR coalesce(e.gtin,'') ILIKE '%'||v_search||'%'))
 )
 SELECT jsonb_build_object('total',(SELECT count(*)::integer FROM matched),
  'page',coalesce((SELECT jsonb_agg(jsonb_build_object('itemId',p.item_id,'iceCode',p.ice_code))
   FROM (SELECT * FROM matched ORDER BY ice_code NULLS LAST,item_id
     LIMIT v_limit OFFSET v_offset) p),'[]'::jsonb))
 INTO v_page;
 v_total:=(v_page->>'total')::integer;
 v_page_items:=v_page->'page';
 IF jsonb_array_length(v_page_items)>0 THEN
  SELECT coalesce(jsonb_object_agg(i.id::text,jsonb_build_object('itemId',i.id,
    'iceCode',(SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.id),
    'nameCn',(SELECT r.name_cn FROM catalog.item_current ic
      JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
      WHERE ic.item_id=i.id))),'{}'::jsonb)
  INTO v_identities FROM catalog.catalog_item i
  WHERE i.id=ANY(ARRAY(SELECT (x->>'itemId')::uuid FROM jsonb_array_elements(v_page_items) x));
 END IF;
 v_len:=jsonb_array_length(v_page_items);
 FOR v_i IN 0..v_len-1 LOOP
  v_identity:=v_identities->(v_page_items->v_i->>'itemId');
  v_item_ctx:=coalesce(v_ctx->'items'->(v_page_items->v_i->>'itemId'),'{}'::jsonb)
   ||jsonb_build_object('readStates',v_ctx->'readStates','warehouses',v_ctx->'warehouses',
     'latestRunId',v_ctx->'latestRunId');
  v_items:=v_items||jsonb_build_array(catalog.inventory_item_summary_core(
   v_aid,(v_page_items->v_i->>'itemId')::uuid,v_scope_wh,v_item_ctx,v_identity));
 END LOOP;
 RETURN jsonb_build_object('total',v_total,'offset',v_offset,'limit',v_limit,'items',v_items,
  'scope',jsonb_build_object('id',v_scope_json->'id','version',v_scope_json->'version',
   'warehouseCount',cardinality(v_scope_wh),'empty',cardinality(v_scope_wh)=0,
   'lastAllSuccessAt',v_scope_json->'lastAllSuccessAt',
   'marketFilter',v_market_filter,'warehouseFilter',p_warehouse),
  'marketOptions',v_market_options,
  'domestic','not_connected','inTransit','not_connected');
END $$;

-- 5.10 item detail: every source row per warehouse (no LIMIT 1), current scope respected
CREATE OR REPLACE FUNCTION catalog.read_inventory_item(p_item uuid,p_warehouse text,p_market text,
 p_all_warehouses boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_identity jsonb; v_summary jsonb; v_scope_wh uuid[]:='{}'::uuid[];
 v_all boolean:=coalesce(p_all_warehouses,false); v_scope_json jsonb; v_warehouses jsonb:='[]'::jsonb;
 v_history jsonb; v_mapping jsonb; v_candidates jsonb; v_warnings jsonb:='[]'::jsonb;
 v_settings catalog.inventory_sync_settings; v_scope catalog.inventory_scope; v_filter_wh uuid;
 v_w jsonb; v_gap jsonb; v_rows jsonb; v_rows_by_wh jsonb:='{}'::jsonb; v_state jsonb; v_ctx jsonb;
 v_gaps jsonb; v_gap_by_wh jsonb:='{}'::jsonb; v_rev_by_wh jsonb:='{}'::jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_item IS NULL THEN RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:itemId' USING ERRCODE='22023'; END IF;
 v_identity:=catalog.inventory_item_identity(p_item);
 IF v_identity IS NULL THEN RAISE EXCEPTION 'INVENTORY_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('item',v_identity,'warehouses','[]'::jsonb,'totals',
   jsonb_build_object('byUnit','[]'::jsonb,'knownSubtotal',NULL::numeric,'unitConflict',false),
   'mapping','[]'::jsonb,'candidates','[]'::jsonb,'history','[]'::jsonb,'scopedWarnings','[]'::jsonb,
   'scope',jsonb_build_object('warehouseCount',0,'empty',true)); END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope_wh:=ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(v_scope_json->'warehouseIds') x);
 IF v_all THEN
  v_scope_wh:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid ORDER BY w.external_warehouse_id);
 ELSE
  IF p_warehouse IS NOT NULL AND length(btrim(p_warehouse))>0 THEN
   BEGIN
    v_filter_wh:=(btrim(p_warehouse))::uuid;
   EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023';
   END;
   IF NOT EXISTS(SELECT 1 FROM catalog.inventory_warehouse w WHERE w.id=v_filter_wh AND w.account_id=v_aid) THEN
    RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
   v_scope_wh:=ARRAY(SELECT x FROM unnest(v_scope_wh) x WHERE x=v_filter_wh);
  END IF;
  IF p_market IS NOT NULL AND length(btrim(p_market))>0 THEN
   -- 市场待确认哨兵：只保留 market IS NULL 的仓（不猜国家、不退化成全部市场）。
   IF btrim(p_market)='__unknown__' THEN
    v_scope_wh:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
     WHERE w.id=ANY(v_scope_wh) AND w.market IS NULL);
   ELSE
    v_scope_wh:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
     WHERE w.id=ANY(v_scope_wh) AND w.market=btrim(p_market));
   END IF;
  END IF;
 END IF;
 -- F2: every warehouse in the selected range is returned, with a consistent gap reason, not just
 -- the warehouses that happen to have current rows/mapping history.
 v_ctx:=catalog.inventory_read_context(v_aid,v_scope_wh,p_item);
 v_gaps:=catalog.inventory_item_gaps(v_aid,p_item,v_scope_wh,v_ctx);
 SELECT coalesce(jsonb_object_agg(g->>'warehouseId',g),'{}'::jsonb) INTO v_gap_by_wh
 FROM jsonb_array_elements(v_gaps) g;
 WITH eff AS (
  SELECT e.* FROM jsonb_to_recordset(v_ctx->'effectiveRows') AS e("itemId" uuid,"warehouseId" uuid,
    "warehouseExternalId" text,"warehouseName" text,market text,"externalSku" text,
    "mappingId" uuid,"mappingVersion" integer,"variantId" uuid,unit text,"onHand" integer,
    "orderLocked" integer,"warehouseAvailable" integer,"activityReserved" integer,"inTransit" integer,
    gtin text,"observedAt" timestamptz,"batchId" uuid,"excelRow" integer,"itemRevision" integer)
  WHERE e."itemId"=p_item AND e."warehouseId"=ANY(v_scope_wh)
 )
 SELECT coalesce(jsonb_object_agg(x.wid,x.rows),'{}'::jsonb) INTO v_rows_by_wh FROM (
  SELECT e."warehouseId"::text wid,jsonb_agg(jsonb_build_object(
   'excelRow',e."excelRow",'externalSku',e."externalSku",'gtin',e.gtin,'unit',e.unit,
   'onHand',e."onHand",'orderLocked',e."orderLocked",'warehouseAvailable',e."warehouseAvailable",
   'activityReserved',e."activityReserved",'inTransit',e."inTransit",'observedAt',e."observedAt",
   'batchId',e."batchId",'mappingId',e."mappingId",'mappingVersion',e."mappingVersion",
   'variantId',e."variantId",'itemRevision',e."itemRevision")
   ORDER BY e."externalSku") rows
  FROM eff e GROUP BY e."warehouseId") x;
 SELECT coalesce(jsonb_object_agg(r->>'warehouseId',(r->>'missing')::integer),'{}'::jsonb)
 INTO v_rev_by_wh FROM jsonb_array_elements(v_ctx->'revisionMissing') r
 WHERE (r->>'itemId')::uuid=p_item;
 FOR v_w IN SELECT x FROM jsonb_array_elements(v_ctx->'warehouses') x
   WHERE (x->>'id')::uuid=ANY(v_scope_wh) ORDER BY x->>'externalId' LOOP
  v_gap:=v_gap_by_wh->(v_w->>'id');
  SELECT r INTO v_state FROM jsonb_array_elements(v_ctx->'readStates') r
   WHERE (r->>'warehouseId')::uuid=(v_w->>'id')::uuid LIMIT 1;
  v_rows:=coalesce(v_rows_by_wh->(v_w->>'id'),'[]'::jsonb);
  v_warehouses:=v_warehouses||jsonb_build_array(jsonb_build_object(
   'warehouseId',v_w->>'id','externalId',v_w->>'externalId','name',v_w->>'name',
   'market',v_w->'market','status',v_gap->>'status','reason',v_gap->>'reason',
   'gapReason',v_gap->>'reason',
   'sourceRowCount',(v_gap->>'sourceRowCount')::integer,
   'sourceSkus',coalesce(v_gap->'sourceSkus','[]'::jsonb),
   'pendingSourceRows',coalesce(v_gap->'pendingSourceRows','[]'::jsonb),
   'pendingSourceRowCount',coalesce((v_gap->>'pendingSourceRowCount')::integer,0),
   'pendingSkus',coalesce(v_gap->'pendingSkus','[]'::jsonb),
   'mappedSkus',coalesce(v_gap->'mappedSkus','[]'::jsonb),
   'adoptedSkus',coalesce(v_gap->'adoptedSkus','[]'::jsonb),
   'pendingAdoptionSkus',coalesce(v_gap->'pendingAdoptionSkus','[]'::jsonb),
   'lastSuccessAt',(v_state->>'lastSuccessAt')::timestamptz,
   'lastObservationAt',(v_state->>'lastObservationAt')::timestamptz,
   'lastErrorCode',v_state->>'lastErrorCode','stale',coalesce((v_state->>'stale')::boolean,false),
   'rows',v_rows,'lastKnownQty',(v_gap->>'lastKnownQty')::integer,
   'lastKnownAt',(v_gap->>'lastKnownObservedAt')::timestamptz,
   'itemRevisionMissing',coalesce((v_rev_by_wh->>(v_w->>'id'))::integer,0)));
 END LOOP;
 v_summary:=catalog.inventory_item_summary_core(v_aid,p_item,v_scope_wh,v_ctx,v_identity);
 -- F2: previousOnHand is derived from the adjacent earlier observation (never the frozen current
 -- pointer); historical rows themselves are not rewritten.
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'batchId',t.batch_id,'warehouseName',t.warehouse_name,'runId',t.run_id,
   'publishedAt',t.published_at,'observationAt',t.observation_at,
   'excelRow',t.excel_row,'externalSku',t.external_sku,
   'onHand',t.on_hand,'previousOnHand',t.previous_on_hand,
   'unit',t.unit,'itemRevision',t.item_revision,'rowStatus',t.status)
   ORDER BY t.observation_at DESC,t.published_at DESC,t.batch_id DESC,t.excel_row),'[]'::jsonb)
 INTO v_history FROM (
  SELECT br.batch_id,b.warehouse_name_snapshot AS warehouse_name,b.run_id,b.published_at,
   b.observation_at,br.excel_row,br.external_sku,br.on_hand,pb.on_hand AS previous_on_hand,
   br.unit,br.item_revision,br.status
  FROM catalog.inventory_batch_row br
  JOIN catalog.inventory_batch b ON b.id=br.batch_id
  LEFT JOIN LATERAL (
   SELECT * FROM catalog.inventory_previous_batch_row(v_aid,b.warehouse_id,br.external_sku,
    br.item_id,b.observation_at,b.published_at,b.id)) pb ON true
  WHERE br.item_id=p_item AND b.warehouse_id=ANY(v_scope_wh)
  ORDER BY b.observation_at DESC,b.published_at DESC,b.id DESC,br.excel_row LIMIT 50) t;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id',m.id,'externalSku',m.external_sku,'warehouseId',m.warehouse_id,
   'warehouseExternalId',w.external_warehouse_id,'warehouseName',w.external_name,
   'version',m.version,'unit',m.unit,'status',m.status,'accountLevel',m.warehouse_id IS NULL,
   'reason',m.note,'evidence',m.evidence,'actorId',m.actor_id,'createdAt',m.created_at)
   ORDER BY m.external_sku,m.warehouse_id,m.version DESC),'[]'::jsonb)
 INTO v_mapping FROM catalog.inventory_sku_mapping m
 LEFT JOIN catalog.inventory_warehouse w ON w.id=m.warehouse_id
 WHERE m.account_id=v_aid AND m.item_id=p_item;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'candidateId',c.id,'warehouseId',c.warehouse_id,'externalSku',c.external_sku,
   'status',c.status,'evidence',c.evidence,'createdAt',c.created_at)
   ORDER BY c.created_at DESC),'[]'::jsonb)
 INTO v_candidates FROM catalog.inventory_mapping_candidate c
 WHERE c.account_id=v_aid AND c.suggested_item_id=p_item;
 IF coalesce(cardinality(v_scope_wh),0) = 0 THEN
  v_warnings:=v_warnings||to_jsonb('参与仓库为空：当前没有可发布范围'::text); END IF;
 IF coalesce((v_summary->>'unitConflict')::boolean,false) THEN
  v_warnings:=v_warnings||to_jsonb('同一商品存在多种单位，合计已隐藏，请按单位分组核对'::text); END IF;
 IF jsonb_array_length(v_summary->'unseenWarehouses')>0 THEN
  v_warnings:=v_warnings||to_jsonb('部分参与仓最新完整批次未见该商品（本次未见）'::text); END IF;
 IF jsonb_array_length(v_summary->'notMappedWarehouses')>0 THEN
  v_warnings:=v_warnings||to_jsonb('部分参与仓有来源但未对应或没有来源记录，见逐仓原因'::text); END IF;
 IF coalesce((v_summary->>'hasPendingSourceWarehouses')::boolean,false) THEN
  v_warnings:=v_warnings||to_jsonb('部分参与仓同仓还有来源待确认（未对应来源行不计入合计，仅提示核对）'::text); END IF;
  IF coalesce((v_summary->>'hasPendingAdoptionWarehouses')::boolean,false) THEN
   v_warnings:=v_warnings||to_jsonb('部分仓对应已确认、等待下一次完整同步采用（尚未计入合计）'::text); END IF;
 IF coalesce((v_summary->>'hasPendingTotal')::boolean,false) THEN
  v_warnings:=v_warnings||to_jsonb('本商品同仓有多个来源编码，逐行展示、合计待核对（不擅自相加）'::text); END IF;
 IF jsonb_array_length(v_summary->'failedWarehouses')>0 THEN
  v_warnings:=v_warnings||to_jsonb('部分仓库最近一次同步失败，当前值保留上次成功时间'::text); END IF;
 IF coalesce((v_summary->>'verificationOnly')::boolean,false) THEN
  v_warnings:=v_warnings||to_jsonb('本商品含修复验证用对应，业务包装单位仍待确认，不作为正式业务单位'::text); END IF;
 IF coalesce((v_summary->>'itemRevisionMissing')::integer,0)>0 THEN
  v_warnings:=v_warnings||to_jsonb('部分历史批次行缺少当时商品资料修订（当时资料版本缺失）'::text); END IF;
 IF NOT coalesce((v_summary->>'hasCurrentData')::boolean,false) THEN
  v_warnings:=v_warnings||to_jsonb('当前没有可用于合计的批次行'::text); END IF;
 RETURN jsonb_build_object('item',v_identity,'warehouses',v_warehouses,
  'totals',jsonb_build_object('byUnit',v_summary->'unitGroups',
   'knownSubtotal',v_summary->'knownSubtotal','unitConflict',v_summary->'unitConflict',
   'knownSubtotalComplete',v_summary->'knownSubtotalComplete',
   'pendingTotalWarehouses',v_summary->'pendingTotalWarehouses',
   'hasPendingTotal',v_summary->'hasPendingTotal',
   'hasCurrentData',v_summary->'hasCurrentData',
   'warehouseCount',v_summary->'warehouseCount','lastObservedAt',v_summary->'lastObservedAt'),
  'coverage',v_summary->'coverage','markets',v_summary->'markets',
  'hasUnknownMarket',v_summary->'hasUnknownMarket',
  'pendingSourceWarehouses',v_summary->'pendingSourceWarehouses',
  'hasPendingSourceWarehouses',v_summary->'hasPendingSourceWarehouses',
  'pendingAdoptionWarehouses',v_summary->'pendingAdoptionWarehouses',
  'hasPendingAdoptionWarehouses',v_summary->'hasPendingAdoptionWarehouses',
  'verificationOnly',v_summary->'verificationOnly','unitUnconfirmed',v_summary->'unitUnconfirmed',
  'itemRevisionMissing',v_summary->'itemRevisionMissing',
  'gtin',v_summary->'gtin','mapping',v_mapping,'candidates',v_candidates,
  'history',v_history,'scopedWarnings',v_warnings,
  'scope',jsonb_build_object('id',v_scope_json->'id','version',v_scope_json->'version',
   'warehouseCount',cardinality(v_scope_wh),'empty',cardinality(v_scope_wh)=0,
   'allWarehouses',v_all,'warehouseFilter',p_warehouse,'marketFilter',p_market));
END $$;

-- 5.10b catalog unified inventory source: one read-only payload for the catalog list. The data comes
-- from the same effective-row model the inventory page uses (no BS sample table fallback); the catalog
-- service aggregates per item/warehouse in TypeScript so the list stays a single fast query.
CREATE OR REPLACE FUNCTION catalog.read_inventory_catalog_sources() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope_json jsonb; v_scope uuid[]:='{}'::uuid[]; v_ws jsonb;
 v_reads jsonb; v_eff jsonb; v_maps jsonb; v_cands jsonb; v_run uuid; v_run_meta jsonb;
 v_src jsonb; v_finished timestamptz;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('scope',jsonb_build_object('warehouseCount',0,'empty',true,
   'lastAllSuccessAt',NULL::timestamptz),'warehouses','[]'::jsonb,'readStates','[]'::jsonb,
   'effectiveRows','[]'::jsonb,'mappings','[]'::jsonb,'candidates','[]'::jsonb,
   'latestRun',NULL::jsonb,'sourceRows','[]'::jsonb); END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope:=ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(coalesce(v_scope_json->'warehouseIds','[]'::jsonb)) x);
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseId',w.id,'externalId',w.external_warehouse_id,
   'name',w.external_name,'market',w.market,'status',w.status) ORDER BY w.external_warehouse_id),'[]'::jsonb)
  INTO v_ws FROM catalog.inventory_warehouse w WHERE w.id=ANY(v_scope);
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseId',r.warehouse_id,
   'lastSuccessAt',r.last_success_at,'lastPublishAt',r.last_publish_at,
   'lastObservationAt',r.last_observation_at,'latestRunStatus',r.latest_run_status,
   'failed',r.failed,'stale',r.stale,'lastErrorCode',r.last_error_code)),'[]'::jsonb)
  INTO v_reads FROM catalog.inventory_warehouse_read_state(v_aid,v_scope) r;
SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',e.item_id,'warehouseId',e.warehouse_id,
   'warehouseExternalId',e.warehouse_external_id,'warehouseName',e.warehouse_name,'market',e.market,
   'externalSku',e.external_sku,'unit',e.unit,'onHand',e.on_hand,'orderLocked',e.order_locked,
   'warehouseAvailable',e.warehouse_available,'activityReserved',e.activity_reserved,
   'inTransit',e.in_transit,'gtin',e.gtin,'observedAt',e.observed_at,'batchId',e.batch_id,
   'excelRow',e.excel_row,'itemRevision',e.item_revision,'mappingId',e.mapping_id,
   'verification',coalesce((m.evidence->>'verification')='true',false),
   'unitConfirmed',coalesce((m.evidence->>'unitConfirmed')='false',false)=false)
   ORDER BY e.warehouse_external_id,e.external_sku,e.item_id),'[]'::jsonb)
  INTO v_eff FROM catalog.inventory_effective_rows(v_aid,v_scope) e
  JOIN catalog.inventory_sku_mapping m ON m.id=e.mapping_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',m.item_id,'warehouseId',m.warehouse_id,
   'externalSku',m.external_sku,'unit',m.unit,'version',m.version,
   'verification',coalesce((m.evidence->>'verification')='true',false),
   'unitConfirmed',coalesce((m.evidence->>'unitConfirmed')='false',false)=false)
   ORDER BY m.external_sku,m.warehouse_id),'[]'::jsonb)
  INTO v_maps FROM catalog.inventory_sku_mapping m
  WHERE m.account_id=v_aid AND m.status='confirmed' AND m.warehouse_id=ANY(v_scope);
 SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',c.suggested_item_id,'warehouseId',c.warehouse_id,
   'externalSku',c.external_sku,'status',c.status) ORDER BY c.external_sku,c.warehouse_id),'[]'::jsonb)
  INTO v_cands FROM catalog.inventory_mapping_candidate c
  WHERE c.account_id=v_aid AND c.status='pending' AND c.suggested_item_id IS NOT NULL;
 SELECT r.id,r.export_finished_at INTO v_run,v_finished
  FROM catalog.inventory_sync_run r
  WHERE r.account_id=v_aid AND EXISTS(SELECT 1 FROM catalog.inventory_run_row x WHERE x.run_id=r.id)
  ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
 v_run_meta:=CASE WHEN v_run IS NULL THEN NULL
  ELSE jsonb_build_object('runId',v_run,'exportFinishedAt',v_finished) END;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseExternalId',x.warehouse_external_id,
   'externalSku',x.external_sku,'excelRow',x.excel_row,'productName',x.product_name,
   'onHand',catalog.inventory_parse_quantity_text(x.on_hand_text))
   ORDER BY x.warehouse_external_id,x.excel_row),'[]'::jsonb)
  INTO v_src FROM catalog.inventory_run_row x
  WHERE x.run_id=v_run AND x.parse_status='ok'
   AND x.warehouse_external_id IN (SELECT w.external_warehouse_id FROM catalog.inventory_warehouse w
     WHERE w.id=ANY(v_scope));
 RETURN jsonb_build_object('scope',jsonb_build_object('id',v_scope_json->'id',
   'version',v_scope_json->'version','warehouseCount',cardinality(v_scope),
   'empty',cardinality(v_scope)=0,'lastAllSuccessAt',v_scope_json->'lastAllSuccessAt'),
  'warehouses',v_ws,'readStates',v_reads,'effectiveRows',v_eff,'mappings',v_maps,
  'candidates',v_cands,'latestRun',v_run_meta,'sourceRows',v_src);
END $$;

-- 5.11 catalog item search for manual mapping selection (no inventory required)
CREATE OR REPLACE FUNCTION catalog.search_inventory_items(p_search text,p_limit integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_search text; v_limit integer; v_items jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,20),50));
 SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',t.item_id,'iceCode',t.ice_code,
   'nameCn',t.name_cn,'gtin',t.gtin)
   ORDER BY t.ice_code NULLS LAST, t.item_id),'[]'::jsonb)
 INTO v_items FROM (
  SELECT i.id AS item_id,
   (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.id) AS ice_code,
   (SELECT r.name_cn FROM catalog.item_current ic JOIN catalog.item_revision r
     ON r.item_id=ic.item_id AND r.revision=ic.revision WHERE ic.item_id=i.id) AS name_cn,
   (SELECT br.gtin FROM catalog.inventory_batch_row br JOIN catalog.inventory_batch b ON b.id=br.batch_id
     WHERE br.item_id=i.id AND br.gtin IS NOT NULL
     ORDER BY b.published_at DESC, b.id DESC LIMIT 1) AS gtin
  FROM catalog.catalog_item i
  WHERE v_search IS NULL
   OR EXISTS(SELECT 1 FROM catalog.catalog_item_code c
     WHERE c.item_id=i.id AND c.ice_code ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.item_current ic JOIN catalog.item_revision r
     ON r.item_id=ic.item_id AND r.revision=ic.revision
     WHERE ic.item_id=i.id AND r.name_cn ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.inventory_batch_row br
     WHERE br.item_id=i.id AND coalesce(br.gtin,'') ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.inventory_sku_mapping m
     WHERE m.item_id=i.id AND m.external_sku ILIKE '%'||v_search||'%')
  ORDER BY ice_code NULLS LAST, i.id LIMIT v_limit) t;
 RETURN v_items;
END $$;

-- 5.12 R5 pending action RPCs
CREATE OR REPLACE FUNCTION catalog.begin_inventory_pending_action(p_request uuid,p_intent text,
 p_action text,p_payload jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_aid uuid; v_row catalog.inventory_pending_action;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_request IS NULL OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$'
  OR p_action IS NULL OR length(btrim(p_action))=0 OR length(p_action)>100
  OR (p_payload IS NOT NULL AND jsonb_typeof(p_payload)<>'object') THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RAISE EXCEPTION 'INVENTORY_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.pending:'||v_aid::text,948));
 SELECT * INTO v_row FROM catalog.inventory_pending_action p WHERE p.request_id=p_request FOR UPDATE;
 IF v_row.request_id IS NOT NULL THEN
  IF v_row.actor_id IS DISTINCT FROM v_actor THEN
   RAISE EXCEPTION 'INVENTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v_row.intent_hash<>p_intent OR v_row.action<>p_action THEN
   RAISE EXCEPTION 'INVENTORY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  -- The registered content is authoritative: re-registering the same requestId/intent with a
  -- different payload (e.g. an ambiguous legacy fingerprint) is rejected.
  IF catalog.inventory_payload_key(p_action,v_row.payload)
   IS DISTINCT FROM catalog.inventory_payload_key(p_action,coalesce(p_payload,'{}'::jsonb)) THEN
   RAISE EXCEPTION 'INVENTORY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('ok',true,'requestId',v_row.request_id,'action',v_row.action,
   'status',v_row.status,'errorCode',v_row.error_code,'createdAt',v_row.created_at,'replayed',true,
   'actorId',v_row.actor_id,'accountId',v_row.account_id);
 END IF;
 IF EXISTS(SELECT 1 FROM catalog.inventory_pending_action p
   WHERE p.account_id=v_aid AND p.status='pending') THEN
  RAISE EXCEPTION 'INVENTORY_PENDING_RECOVERY_REQUIRED' USING ERRCODE='55000'; END IF;
 INSERT INTO catalog.inventory_pending_action(request_id,account_id,actor_id,action,intent_hash,
  payload,status,created_at,updated_at)
 VALUES(p_request,v_aid,v_actor,p_action,p_intent,coalesce(p_payload,'{}'::jsonb),'pending',now(),now())
 RETURNING * INTO v_row;
 PERFORM catalog.inventory_audit_write(v_actor,'begin_inventory_pending_action',p_request::text,
  jsonb_build_object('action',p_action,'intentHash',p_intent));
 RETURN jsonb_build_object('ok',true,'requestId',v_row.request_id,'action',v_row.action,
  'status',v_row.status,'createdAt',v_row.created_at,'replayed',false,
  'actorId',v_row.actor_id,'accountId',v_row.account_id);
END $$;

CREATE OR REPLACE FUNCTION catalog.complete_inventory_pending_action(p_request uuid,p_status text,
 p_response jsonb,p_error_code text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_row catalog.inventory_pending_action;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_request IS NULL OR p_status IS NULL OR p_status NOT IN('completed','failed') THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:status' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM catalog.inventory_pending_action p WHERE p.request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_PENDING_NOT_FOUND' USING ERRCODE='22023'; END IF;
 -- Only the original operator may resolve the original pending request; another admin sees "busy"
 -- and cannot unlock it by knowing the requestId.
 IF v_row.actor_id IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'INVENTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF v_row.status<>'pending' THEN
  RAISE EXCEPTION 'INVENTORY_PENDING_ALREADY_RESOLVED' USING ERRCODE='55000'; END IF;
 -- A completed unlock requires the real business receipt of the same request/action/intent; a
 -- failure response never counts as "unlocked".
 IF p_status='completed' AND NOT EXISTS(
  SELECT 1 FROM catalog.inventory_request ir
  WHERE ir.request_id=p_request AND ir.response IS NOT NULL
   AND ir.action=v_row.action AND ir.intent_hash=v_row.intent_hash
   AND ir.actor_id IS NOT DISTINCT FROM v_actor) THEN
  RAISE EXCEPTION 'INVENTORY_RECEIPT_MISSING' USING ERRCODE='55000'; END IF;
 UPDATE catalog.inventory_pending_action SET status=p_status,
  response=CASE WHEN p_response IS NULL OR jsonb_typeof(p_response)<>'object' THEN NULL ELSE p_response END,
  error_code=left(coalesce(p_error_code,''),200),updated_at=now()
 WHERE request_id=p_request RETURNING * INTO v_row;
 PERFORM catalog.inventory_audit_write(v_actor,'complete_inventory_pending_action',p_request::text,
  jsonb_build_object('status',p_status,'errorCode',p_error_code));
 RETURN jsonb_build_object('ok',true,'requestId',v_row.request_id,'status',v_row.status,
  'errorCode',v_row.error_code,'updatedAt',v_row.updated_at);
END $$;

-- v4-final R2: settle a *definitively failed original request* only when the caller proves it is the
-- same operator/action/intent/complete payload. Wrong-intent/wrong-param calls are rejected without
-- touching the original lock; a request that already has a success receipt is never flipped to failed.
-- Single transaction with FOR UPDATE, so reconcile/settle cannot be raced into a half state.
CREATE OR REPLACE FUNCTION catalog.settle_inventory_pending_action(p_request uuid,p_action text,
 p_intent text,p_payload jsonb,p_error_code text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_row catalog.inventory_pending_action; v_req catalog.inventory_request;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_request IS NULL OR p_action IS NULL OR length(btrim(p_action))=0
  OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$'
  OR (p_payload IS NOT NULL AND jsonb_typeof(p_payload)<>'object') THEN
  RETURN jsonb_build_object('ok',false,'settled',false,'reason','INVALID_REQUEST'); END IF;
 SELECT * INTO v_row FROM catalog.inventory_pending_action p WHERE p.request_id=p_request FOR UPDATE;
 IF v_row.request_id IS NULL THEN
  -- No pending row: only "nothing was ever registered" can be called settled. A request row without a
  -- response is an incomplete/unknown execution, not a definitive failure.
  SELECT * INTO v_req FROM catalog.inventory_request r WHERE r.request_id=p_request;
  IF v_req.request_id IS NOT NULL THEN
   IF v_req.response IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'settled',false,'reason','HAS_RECEIPT'); END IF;
   RETURN jsonb_build_object('ok',false,'settled',false,'reason','NOT_PENDING'); END IF;
  RETURN jsonb_build_object('ok',true,'settled',true,'reason','NO_PENDING'); END IF;
 IF v_row.actor_id IS DISTINCT FROM v_actor THEN
  RETURN jsonb_build_object('ok',false,'settled',false,'reason','FORBIDDEN'); END IF;
 IF v_row.action IS DISTINCT FROM p_action OR v_row.intent_hash IS DISTINCT FROM p_intent
  OR catalog.inventory_payload_key(p_action,v_row.payload)
   IS DISTINCT FROM catalog.inventory_payload_key(p_action,coalesce(p_payload,'{}'::jsonb)) THEN
  RETURN jsonb_build_object('ok',false,'settled',false,'reason','NOT_ORIGINAL'); END IF;
 IF v_row.status<>'pending' THEN
  RETURN jsonb_build_object('ok',false,'settled',false,'reason','NOT_PENDING'); END IF;
 -- A success receipt from the same request/action/intent must never be re-judged as failed.
 SELECT * INTO v_req FROM catalog.inventory_request r WHERE r.request_id=p_request;
 IF v_req.request_id IS NOT NULL THEN
  IF v_req.response IS NOT NULL THEN
   RETURN jsonb_build_object('ok',false,'settled',false,'reason','HAS_RECEIPT'); END IF;
  -- Incomplete business execution (no response yet) is an unknown outcome, not a definitive failure.
  RETURN jsonb_build_object('ok',false,'settled',false,'reason','NOT_PENDING'); END IF;
 UPDATE catalog.inventory_pending_action SET status='failed',response=NULL,
  error_code=left(coalesce(p_error_code,'INVALID_INPUT'),200),updated_at=now()
 WHERE request_id=p_request RETURNING * INTO v_row;
 PERFORM catalog.inventory_audit_write(v_actor,'settle_inventory_pending_action',p_request::text,
  jsonb_build_object('action',p_action,'intentHash',p_intent,'errorCode',p_error_code));
 RETURN jsonb_build_object('ok',true,'settled',true,'reason','SETTLED','status',v_row.status,
  'errorCode',v_row.error_code,'updatedAt',v_row.updated_at);
END $$;

CREATE OR REPLACE FUNCTION catalog.read_inventory_pending_actions() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_items jsonb; v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RETURN jsonb_build_object('items','[]'::jsonb); END IF;
 SELECT coalesce(jsonb_agg(x.obj ORDER BY x.created_at DESC),'[]'::jsonb)
 INTO v_items FROM (
  SELECT p.created_at,
   CASE WHEN p.actor_id IS NOT DISTINCT FROM v_actor THEN jsonb_build_object(
     'requestId',p.request_id,'action',p.action,'intentHash',p.intent_hash,'payload',p.payload,
     'actorId',p.actor_id,'accountId',p.account_id,'mine',true,
     'status',p.status,'response',p.response,'errorCode',p.error_code,
     'createdAt',p.created_at,'updatedAt',p.updated_at)
    ELSE jsonb_build_object('foreign',true,'mine',false,'action',p.action,
     'status',p.status,'createdAt',p.created_at,'updatedAt',p.updated_at) END AS obj
  FROM catalog.inventory_pending_action p
  WHERE p.account_id=v_aid AND p.status='pending'
  UNION ALL
  SELECT p.created_at,
   jsonb_build_object('requestId',p.request_id,'action',p.action,'intentHash',p.intent_hash,
    'payload',p.payload,'actorId',p.actor_id,'accountId',p.account_id,'mine',(p.actor_id IS NOT DISTINCT FROM v_actor),
    'status',p.status,'response',p.response,'errorCode',p.error_code,
    'createdAt',p.created_at,'updatedAt',p.updated_at)
  FROM catalog.inventory_pending_action p
  WHERE p.account_id=v_aid AND p.status<>'pending'
   AND p.actor_id IS NOT DISTINCT FROM v_actor
   AND p.updated_at>now()-interval '24 hours'
 ) x;
 RETURN jsonb_build_object('items',v_items);
END $$;

-- ---------------------------------------------------------------------------
-- sync-role functions (contract 3.2 + repair v2 additions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.register_inventory_worker(p_worker_id text,p_host text,p_pid integer,
 p_version text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_acct catalog.inventory_source_account; v_settings catalog.inventory_sync_settings;
 v_scope_json jsonb;
BEGIN
 IF p_worker_id IS NULL OR length(btrim(p_worker_id))=0 OR length(p_worker_id)>100 THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:workerId' USING ERRCODE='22023'; END IF;
 INSERT INTO catalog.inventory_worker(worker_id,host,pid,version,state,started_at,last_seen_at)
 VALUES(p_worker_id,p_host,p_pid,p_version,'online',now(),now())
 ON CONFLICT(worker_id) DO UPDATE SET host=EXCLUDED.host,pid=EXCLUDED.pid,
  version=EXCLUDED.version,state='online',last_seen_at=now();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('accountId',NULL::uuid,'settings',NULL::jsonb,
   'warehouseIds','[]'::jsonb,'warehouses','[]'::jsonb,'scopeEmpty',true,
   'accountStatus',NULL::text,'accountLabel',NULL::text);
 END IF;
 SELECT * INTO v_acct FROM catalog.inventory_source_account a WHERE a.id=v_aid;
 SELECT * INTO v_settings FROM catalog.inventory_sync_settings s WHERE s.account_id=v_aid;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 RETURN jsonb_build_object('accountId',v_aid,'accountLabel',v_acct.account_label,
  'accountStatus',v_acct.status,
  'settings',CASE WHEN v_settings.account_id IS NULL THEN NULL::jsonb ELSE jsonb_build_object(
   'enabled',v_settings.enabled,'intervalMinutes',v_settings.interval_minutes,
   'nextRunAt',v_settings.next_run_at,'configVersion',v_settings.config_version,
   'planAnchorAt',v_settings.plan_anchor_at) END,
  'scopeId',v_scope_json->'id','scopeVersion',v_scope_json->'version',
  'scopeEmpty',(v_scope_json->>'empty')::boolean,
  'warehouseIds',v_scope_json->'warehouseIds','warehouses',v_scope_json->'warehouses');
END $$;

-- worker-confirmed login refresh. verified=true only when the worker could prove the bound account
-- identity (label provided and matching). disabled is never revived; mismatch never rewrites label.
CREATE OR REPLACE FUNCTION catalog.refresh_inventory_account_status(p_worker_id text,p_logged_in boolean,
 p_account_label text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_acct catalog.inventory_source_account; v_worker catalog.inventory_worker;
 v_label text; v_identity text; v_verified boolean:=false; v_changed boolean:=false;
 v_can_activate boolean:=false; v_status text;
BEGIN
 IF p_worker_id IS NULL OR length(btrim(p_worker_id))=0 OR length(p_worker_id)>100 THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:workerId' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_worker FROM catalog.inventory_worker w WHERE w.worker_id=p_worker_id;
 IF v_worker.worker_id IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_WORKER_UNKNOWN' USING ERRCODE='22023'; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RAISE EXCEPTION 'INVENTORY_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_acct FROM catalog.inventory_source_account a WHERE a.id=v_aid FOR UPDATE;
 v_label:=nullif(btrim(coalesce(p_account_label,'')),'');
 IF v_label IS NULL THEN
  v_identity:='missing';
 ELSIF v_label=v_acct.account_label THEN
  v_identity:='verified'; v_verified:=coalesce(p_logged_in,false);
 ELSE
  v_identity:='mismatch';
 END IF;
 IF coalesce(p_logged_in,false) AND v_verified THEN
  IF v_acct.status='needs_login' THEN v_changed:=true; END IF;
 ELSE
  v_verified:=false;
 END IF;
 UPDATE catalog.inventory_source_account SET
  status=CASE WHEN coalesce(p_logged_in,false) AND v_verified AND status='needs_login' THEN 'active'
              ELSE status END,
  last_login_ok_at=CASE WHEN coalesce(p_logged_in,false) AND v_verified THEN now() ELSE last_login_ok_at END,
  last_login_check_at=now(),updated_at=now()
 WHERE id=v_aid RETURNING * INTO v_acct;
 PERFORM catalog.inventory_audit_write(NULL,'refresh_inventory_account_status',v_aid::text,
  jsonb_build_object('workerId',p_worker_id,'loggedIn',coalesce(p_logged_in,false),
   'accountIdentityStatus',v_identity,'changed',v_changed,'accountLabelMismatch',v_identity='mismatch'));
 RETURN jsonb_build_object('accountId',v_acct.id,'accountLabel',v_acct.account_label,
  'status',v_acct.status,'changed',v_changed,
  'accountIdentityStatus',v_identity,
  'accountLabelMismatch',v_identity='mismatch',
  'verified',v_verified,
  'lastLoginOkAt',v_acct.last_login_ok_at);
END $$;

-- claim: takeover expired lease, then create a due schedule run. Empty scope => no run.
CREATE OR REPLACE FUNCTION catalog.claim_inventory_run(p_worker_id text,p_lease_seconds integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_acct catalog.inventory_source_account;
 v_scope catalog.inventory_scope; v_scope_json jsonb; v_s catalog.inventory_sync_settings;
 v_slot timestamptz; v_first timestamptz; v_slots timestamptz[]; v_next timestamptz;
 v_aid uuid; v_reason text;
BEGIN
 IF p_worker_id IS NULL OR length(btrim(p_worker_id))=0 OR length(p_worker_id)>100 THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:workerId' USING ERRCODE='22023'; END IF;
 IF p_lease_seconds IS NULL OR p_lease_seconds<10 OR p_lease_seconds>3600 THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:leaseSeconds' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.claim',930));
 INSERT INTO catalog.inventory_worker(worker_id,state,started_at,last_seen_at)
 VALUES(p_worker_id,'online',now(),now())
 ON CONFLICT(worker_id) DO UPDATE SET state='online',last_seen_at=now();
 FOR v_aid IN
  SELECT DISTINCT r.account_id FROM catalog.inventory_sync_run r
  WHERE r.status IN('queued','running','downloading','parsing','publishing','outcome_unknown')
 LOOP
  PERFORM catalog.inventory_advance_due_slots(v_aid);
 END LOOP;
 SELECT * INTO v_run FROM catalog.inventory_sync_run r
 WHERE r.status IN('queued','running','downloading','parsing','publishing','outcome_unknown')
  AND ((r.lease_token IS NULL AND r.status='queued')
   OR (r.lease_token IS NOT NULL AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at<now()))
 ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF v_run.id IS NOT NULL THEN
  UPDATE catalog.inventory_sync_run SET lease_owner=p_worker_id,lease_token=gen_random_uuid(),
   lease_expires_at=now()+make_interval(secs=>p_lease_seconds),heartbeat_at=now(),
   started_at=coalesce(started_at,now()),
   attempt=CASE WHEN v_run.lease_token IS NULL THEN v_run.attempt ELSE v_run.attempt+1 END,
   updated_at=now()
  WHERE id=v_run.id RETURNING * INTO v_run;
 ELSE
  SELECT * INTO v_s FROM catalog.inventory_sync_settings s
  JOIN catalog.inventory_source_account a ON a.id=s.account_id
  WHERE s.enabled AND s.next_run_at IS NOT NULL AND s.next_run_at<=now()
   AND NOT EXISTS(SELECT 1 FROM catalog.inventory_sync_run ar
    WHERE ar.account_id=s.account_id
     AND ar.status IN('queued','running','downloading','parsing','publishing','outcome_unknown'))
  ORDER BY s.next_run_at,s.account_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED;
  IF NOT FOUND THEN
   IF EXISTS(SELECT 1 FROM catalog.inventory_sync_settings s
     JOIN catalog.inventory_scope sc ON sc.id=s.scope_id
     WHERE s.account_id=catalog.inventory_bound_account_id()
      AND cardinality(sc.warehouse_ids)=0) THEN
    RETURN jsonb_build_object('runId',NULL::uuid,'reason','scope_empty');
   END IF;
   RETURN jsonb_build_object('runId',NULL::uuid,'reason','no_due_run');
  END IF;
  SELECT * INTO v_acct FROM catalog.inventory_source_account a WHERE a.id=v_s.account_id;
  IF v_acct.status<>'active' THEN
   RETURN jsonb_build_object('runId',NULL::uuid,
    'reason',CASE WHEN v_acct.status='disabled' THEN 'account_disabled' ELSE 'account_needs_login' END);
  END IF;
  SELECT * INTO v_scope FROM catalog.inventory_scope s WHERE s.id=v_s.scope_id;
  IF v_scope.id IS NULL OR cardinality(v_scope.warehouse_ids)=0 THEN
   RETURN jsonb_build_object('runId',NULL::uuid,'reason','scope_empty');
  END IF;
  v_first:=v_s.next_run_at; v_slot:=v_s.next_run_at; v_slots:='{}'::timestamptz[];
  WHILE v_slot<=now() LOOP
   v_slots:=v_slots||v_slot;
   v_slot:=v_slot+make_interval(mins=>v_s.interval_minutes);
  END LOOP;
  v_next:=v_slot;
  UPDATE catalog.inventory_sync_settings SET next_run_at=v_next,updated_at=now()
  WHERE account_id=v_s.account_id;
  INSERT INTO catalog.inventory_sync_run(request_id,account_id,scope_id,trigger_kind,status,
   planned_for,covered_slots,started_at,lease_owner,lease_token,lease_expires_at,heartbeat_at,
   attempt,created_at,updated_at)
  VALUES(gen_random_uuid(),v_s.account_id,v_s.scope_id,'schedule','queued',v_first,v_slots,
   now(),p_worker_id,gen_random_uuid(),now()+make_interval(secs=>p_lease_seconds),now(),1,
   now(),now())
  RETURNING * INTO v_run;
 END IF;
 SELECT * INTO v_acct FROM catalog.inventory_source_account a WHERE a.id=v_run.account_id;
 v_scope_json:=catalog.inventory_scope_payload(v_run.account_id);
 RETURN jsonb_build_object('runId',v_run.id,'leaseToken',v_run.lease_token,
  'triggerKind',v_run.trigger_kind,'plannedFor',v_run.planned_for,'attempt',v_run.attempt,
  'account',jsonb_build_object('label',v_acct.account_label,'accountId',v_acct.id,
   'status',v_acct.status,'accountKey',v_acct.account_key,
   'externalAccountCode',v_acct.external_account_code),
  'warehouses',v_scope_json->'warehouses','warehouseIds',v_scope_json->'warehouseIds',
  'scopeId',v_scope_json->'id','scopeVersion',v_scope_json->'version',
  'scopeEmpty',(v_scope_json->>'empty')::boolean,
  'coveredSlots',to_jsonb(v_run.covered_slots),'status',v_run.status);
END $$;

CREATE OR REPLACE FUNCTION catalog.update_inventory_run_phase(p_run uuid,p_lease uuid,p_phase text,
 p_detail jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_lease_span interval;
BEGIN
 v_run:=catalog.inventory_require_lease(p_run,p_lease);
 IF p_phase IS NULL OR p_phase NOT IN('running','downloading','parsing','publishing') THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:phase' USING ERRCODE='22023'; END IF;
 IF v_run.status='outcome_unknown' THEN
  RAISE EXCEPTION 'INVENTORY_OUTCOME_UNKNOWN_LOCKED' USING ERRCODE='40001'; END IF;
 v_lease_span:=coalesce(v_run.lease_expires_at-v_run.heartbeat_at,interval '120 seconds');
 IF v_lease_span<interval '10 seconds' THEN v_lease_span:=interval '10 seconds'; END IF;
 UPDATE catalog.inventory_sync_run SET status=p_phase,heartbeat_at=now(),
  lease_expires_at=now()+v_lease_span,updated_at=now(),
  summary=summary||jsonb_build_object('phase',jsonb_build_object(
   'name',p_phase,'detail',coalesce(p_detail,'{}'::jsonb),'at',now()))
 WHERE id=p_run;
 PERFORM catalog.inventory_audit_write(NULL,'update_inventory_run_phase',p_run::text,
  jsonb_build_object('phase',p_phase));
 RETURN jsonb_build_object('ok',true,'runId',p_run,'status',p_phase);
END $$;

-- register export: identity + file validation + warehouse discovery + parsed rows (R3/R4)
CREATE OR REPLACE FUNCTION catalog.register_inventory_export(p_run uuid,p_lease uuid,p_payload jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_file catalog.inventory_export_file; v_rows_in jsonb;
 v_e jsonb; v_sha text; v_relpath text; v_header jsonb; v_header_sha text; v_excel_row integer;
 v_row_hash text; v_result jsonb; v_amt text; v_cur text; v_seen integer[]:='{}';
 v_total integer:=0; v_identity_label text; v_verified boolean:=false; v_identity_status text;
 v_file_validation jsonb; v_discovery jsonb; v_dc jsonb; v_wh record; v_export_finished timestamptz;
 v_source_rows integer; v_account_label text;

BEGIN
 v_run:=catalog.inventory_require_lease(p_run,p_lease);
 IF jsonb_typeof(p_payload)<>'object' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:payload' USING ERRCODE='22023'; END IF;
 IF p_payload->'file' IS NULL OR jsonb_typeof(p_payload->'file')<>'object' THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:file' USING ERRCODE='22023'; END IF;
 v_sha:=nullif(btrim(coalesce(p_payload->'file'->>'sha256','')),'');
 IF v_sha IS NULL OR v_sha!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:sha256' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.export:'||p_run::text,946));
 SELECT * INTO v_file FROM catalog.inventory_export_file f WHERE f.run_id=p_run;
 IF v_file.id IS NOT NULL THEN
  IF v_file.sha256<>v_sha THEN
   RAISE EXCEPTION 'INVENTORY_EXPORT_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN catalog.inventory_export_receipt(p_run);
 END IF;
 IF v_run.status NOT IN('queued','running','downloading','parsing','publishing') THEN
  RAISE EXCEPTION 'INVENTORY_RUN_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
 v_export_finished:=catalog.inventory_ts_or_null(p_payload->'exportFinishedAt','exportFinishedAt');
 IF v_export_finished IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_TIME_MISSING' USING ERRCODE='22023'; END IF;
 -- identity: only a worker-proven label equal to the bound account counts as verified.
 v_identity_label:=nullif(btrim(coalesce(p_payload->'accountIdentity'->>'label','')),'');
 v_verified:=coalesce((p_payload->'accountIdentity'->>'verified')::boolean,false);
 SELECT a.account_label INTO v_account_label FROM catalog.inventory_source_account a WHERE a.id=v_run.account_id;
 IF v_identity_label IS NULL THEN
  v_identity_status:='missing';
 ELSIF v_identity_label=v_account_label AND v_verified THEN
  v_identity_status:='verified';
 ELSE
  v_identity_status:='mismatch';
 END IF;
 v_file_validation:=CASE WHEN p_payload->'fileValidation' IS NULL
  OR jsonb_typeof(p_payload->'fileValidation')<>'object' THEN '{}'::jsonb
  ELSE p_payload->'fileValidation' END;
 v_discovery:=catalog.inventory_jsonb_array(p_payload->'warehouseDiscovery');
 IF jsonb_array_length(v_discovery)=0 THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_DISCOVERY_MISSING' USING ERRCODE='22023'; END IF;
 -- warehouse discovery: upsert every discovered warehouse; name changes need re-confirmation.
 FOR v_dc IN SELECT d.value FROM jsonb_array_elements(v_discovery) d LOOP
  IF jsonb_typeof(v_dc)<>'object' OR nullif(btrim(coalesce(v_dc->>'externalId','')),'') IS NULL THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_DISCOVERY_INVALID' USING ERRCODE='22023'; END IF;
  SELECT w.id,w.status,w.external_name INTO v_wh FROM catalog.inventory_warehouse w
  WHERE w.account_id=v_run.account_id AND w.external_warehouse_id=btrim(v_dc->>'externalId');
  IF v_wh.id IS NULL THEN
   INSERT INTO catalog.inventory_warehouse(account_id,external_warehouse_id,external_name,normalized_name,
    status,evidence,last_seen_at)
   VALUES(v_run.account_id,btrim(v_dc->>'externalId'),
    coalesce(nullif(btrim(coalesce(v_dc->>'name','')),''),btrim(v_dc->>'externalId')),
    lower(coalesce(nullif(btrim(coalesce(v_dc->>'name','')),''),btrim(v_dc->>'externalId'))),
    'candidate',jsonb_build_object('source','warehouse_discovery','runId',v_run.id),now());
  ELSE
   IF nullif(btrim(coalesce(v_dc->>'name','')),'') IS NOT NULL
    AND btrim(v_dc->>'name')<>v_wh.external_name THEN
    UPDATE catalog.inventory_warehouse SET external_name=btrim(v_dc->>'name'),
     normalized_name=lower(btrim(v_dc->>'name')),evidence=evidence||jsonb_build_object(
      'nameChangeAt',now(),'previousName',v_wh.external_name),
     last_seen_at=now() WHERE id=v_wh.id;
   ELSE
    UPDATE catalog.inventory_warehouse SET last_seen_at=now() WHERE id=v_wh.id;
   END IF;
  END IF;
 END LOOP;
 v_relpath:=nullif(btrim(coalesce(p_payload->'file'->>'storageRelpath','')),'');
 IF v_relpath IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:storageRelpath' USING ERRCODE='22023'; END IF;
 v_header:=coalesce(p_payload->'file'->'header','[]'::jsonb);
 IF jsonb_typeof(v_header) NOT IN('array','object') THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:header' USING ERRCODE='22023'; END IF;
 v_header_sha:=encode(sha256(convert_to(v_header::text,'UTF8')),'hex');
 v_rows_in:=catalog.inventory_jsonb_array(p_payload->'rows');
 v_source_rows:=jsonb_array_length(v_rows_in);
 INSERT INTO catalog.inventory_export_file(run_id,sha256,size_bytes,storage_relpath,sheet_name,
  header,header_sha256,row_count,blank_row_count,parser_version,downloaded_at)
 VALUES(p_run,v_sha,
  catalog.inventory_int_or_null(p_payload->'file'->'sizeBytes','sizeBytes'),
  v_relpath,nullif(btrim(coalesce(p_payload->'file'->>'sheetName','')),''),v_header,v_header_sha,
  coalesce(catalog.inventory_int_or_null(p_payload->'file'->'rowCount','rowCount'),v_source_rows),
  catalog.inventory_int_or_null(coalesce(p_payload->'blankRowCount',p_payload->'file'->'blankRowCount'),'blankRowCount'),
  coalesce(nullif(btrim(coalesce(p_payload->'file'->>'parserVersion','')),''),'bigseller-inventory-v1'),
  coalesce(catalog.inventory_ts_or_null(p_payload->'file'->'downloadedAt','downloadedAt'),now()))
 RETURNING * INTO v_file;
 FOR v_e IN SELECT r.value FROM jsonb_array_elements(v_rows_in) r LOOP
  IF jsonb_typeof(v_e)<>'object' THEN
   RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:row' USING ERRCODE='22023'; END IF;
  v_excel_row:=catalog.inventory_int_or_null(v_e->'excelRow','excelRow');
  IF v_excel_row IS NULL OR v_excel_row<=0 THEN
   RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:excelRow' USING ERRCODE='22023'; END IF;
  IF v_excel_row=ANY(v_seen) THEN
   RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:duplicateExcelRow:%',v_excel_row USING ERRCODE='22023'; END IF;
  v_seen:=v_seen||v_excel_row;
  v_row_hash:=nullif(btrim(coalesce(v_e->>'rowHash','')),'');
  IF v_row_hash IS NULL THEN
   RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:rowHash:%',v_excel_row USING ERRCODE='22023'; END IF;
  IF (v_e->>'parseStatus') IS NULL
   OR (v_e->>'parseStatus') NOT IN('ok','invalid_quantity','missing_warehouse','missing_sku','duplicate_sku','combo_sku') THEN
   RAISE EXCEPTION 'INVENTORY_EXPORT_INVALID:parseStatus:%',v_excel_row USING ERRCODE='22023'; END IF;
  INSERT INTO catalog.inventory_run_row(run_id,excel_row,warehouse_external_id,warehouse_name,
   external_sku,product_name,gtin,on_hand_text,order_locked_text,warehouse_available_text,
   activity_reserved_text,in_transit_text,row_hash,parse_status,reason)
  VALUES(p_run,v_excel_row,
   nullif(btrim(coalesce(v_e->>'warehouseExternalId','')),''),
   nullif(btrim(coalesce(v_e->>'warehouseName','')),''),
   nullif(btrim(coalesce(v_e->>'externalSku','')),''),
   nullif(btrim(coalesce(v_e->>'productName','')),''),
   nullif(btrim(coalesce(v_e->>'gtin','')),''),
   catalog.inventory_text_or_null(v_e->'onHandText','onHandText'),
   catalog.inventory_text_or_null(v_e->'orderLockedText','orderLockedText'),
   catalog.inventory_text_or_null(v_e->'warehouseAvailableText','warehouseAvailableText'),
   catalog.inventory_text_or_null(v_e->'activityReservedText','activityReservedText'),
   catalog.inventory_text_or_null(v_e->'inTransitText','inTransitText'),
   left(v_row_hash,200),v_e->>'parseStatus',
   nullif(btrim(coalesce(v_e->>'reason','')),''));
  v_amt:=catalog.inventory_text_or_null(coalesce(v_e->'totalCostText',v_e->'totalCost'),'totalCostText');
  v_cur:=catalog.inventory_text_or_null(v_e->'currency','currency');
  IF v_amt IS NOT NULL OR v_cur IS NOT NULL THEN
   INSERT INTO catalog_private.inventory_run_row_amount(run_id,excel_row,total_cost_text,currency)
   VALUES(p_run,v_excel_row,v_amt,v_cur);
  END IF;
  v_total:=v_total+1;
 END LOOP;
 UPDATE catalog.inventory_sync_run SET file_id=v_file.id,
  export_mark=nullif(btrim(coalesce(p_payload->>'exportMark','')),''),
  export_started_at=catalog.inventory_ts_or_null(p_payload->'exportStartedAt','exportStartedAt'),
  export_finished_at=v_export_finished,
  export_bytes=coalesce(v_file.size_bytes,export_bytes),
  account_identity_status=v_identity_status,
  account_identity_label=v_identity_label,
  file_validation=v_file_validation,
  warehouse_discovery=v_discovery,
  source_row_count=v_total,
  updated_at=now()
 WHERE id=p_run;
 PERFORM catalog.inventory_audit_write(NULL,'register_inventory_export',p_run::text,
  jsonb_build_object('fileId',v_file.id,'sha256',left(v_sha,12),'rows',v_total,
   'identityStatus',v_identity_status,'exportFinishedAt',v_export_finished,
   'fileValidation',v_file_validation));
 RETURN catalog.inventory_export_receipt(p_run);
END $$;

-- publish one complete warehouse. Gates: identity verified, file validation ok, observation time
-- from export_finished_at, exact registered row set (excelRow + rowHash), all rows ok for the
-- warehouse, warehouse in frozen scope + discovery. Old observation never advances success state.
CREATE OR REPLACE FUNCTION catalog.publish_inventory_warehouse(p_run uuid,p_lease uuid,p_warehouse jsonb,
 p_rows jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_scope catalog.inventory_scope; v_wh catalog.inventory_warehouse;
 v_wh_id uuid; v_obs timestamptz; v_batch catalog.inventory_batch; v_rows_in jsonb; v_rows_out jsonb:='[]'::jsonb;
 v_e jsonb; v_sku text; v_seen text[]:='{}'; v_adopted integer:=0; v_unmapped integer:=0;
 v_map catalog.inventory_sku_mapping; v_prev_batch uuid;
 v_canonical jsonb; v_stored jsonb; v_batch_id uuid; v_declared_rows integer;
 v_cur catalog.inventory_current; v_status text; v_item uuid; v_variant uuid;
 v_mapping_id uuid; v_unit text; v_new_qty integer; v_mapping_snapshot jsonb:='[]'::jsonb;
 v_order_locked integer; v_available integer; v_reserved integer; v_transit integer;
 v_raw_on text; v_raw_locked text; v_raw_avail text; v_raw_res text; v_raw_transit text;
 v_hash text; v_gtin text; v_item_revision integer; v_obs_stale boolean:=false;
 v_success boolean:=false; v_expected_count integer; v_payload_count integer;
 v_diff integer; v_reg record; v_decl_sku text; v_decl_on integer; v_on_hand integer;
 v_publish_ts timestamptz;
BEGIN
 v_run:=catalog.inventory_require_lease(p_run,p_lease);
 IF v_run.status='outcome_unknown' THEN
  RAISE EXCEPTION 'INVENTORY_OUTCOME_UNKNOWN_LOCKED' USING ERRCODE='40001'; END IF;
 IF v_run.status NOT IN('queued','running','downloading','parsing','publishing') THEN
  RAISE EXCEPTION 'INVENTORY_RUN_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
 IF v_run.account_identity_status<>'verified' THEN
  RAISE EXCEPTION 'INVENTORY_IDENTITY_UNVERIFIED:%',v_run.account_identity_status USING ERRCODE='42501'; END IF;
 IF coalesce((v_run.file_validation->>'blocked')::boolean,false) THEN
  RAISE EXCEPTION 'INVENTORY_FILE_VALIDATION_BLOCKED' USING ERRCODE='22023'; END IF;
 IF v_run.export_finished_at IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_TIME_MISSING' USING ERRCODE='22023'; END IF;
 v_obs:=v_run.export_finished_at;
 -- whole-file structural blockers are checked before warehouse scope/discovery: a file with an
 -- unattributable warehouse or a combo SKU can never publish any warehouse.
 IF EXISTS(SELECT 1 FROM catalog.inventory_run_row rr WHERE rr.run_id=p_run
   AND (rr.parse_status IN('missing_warehouse','combo_sku')
    OR rr.warehouse_external_id IS NULL)) THEN
  RAISE EXCEPTION 'INVENTORY_FILE_BLOCKED' USING ERRCODE='22023'; END IF;
 IF p_warehouse IS NULL OR jsonb_typeof(p_warehouse)<>'object' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:warehouse' USING ERRCODE='22023'; END IF;
 BEGIN
  v_wh_id:=(p_warehouse->>'warehouseId')::uuid;
 EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE' USING ERRCODE='22023';
 END;
 IF v_wh_id IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_wh FROM catalog.inventory_warehouse w WHERE w.id=v_wh_id;
 IF v_wh.id IS NULL OR v_wh.account_id<>v_run.account_id THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_scope FROM catalog.inventory_scope s WHERE s.id=v_run.scope_id;
 IF v_scope.id IS NULL OR NOT(v_wh.id=ANY(v_scope.warehouse_ids)) THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 IF v_wh.status<>'confirmed' THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 -- identity of the warehouse itself must come from this run's discovery (no guessing).
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_run.warehouse_discovery) d
   WHERE d->>'externalId'=v_wh.external_warehouse_id) THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE' USING ERRCODE='22023'; END IF;
 -- whole-file structural blockers were already enforced above, before warehouse scope checks.
 -- this warehouse must be complete: no invalid/duplicate row registered for it
 IF EXISTS(SELECT 1 FROM catalog.inventory_run_row rr WHERE rr.run_id=p_run
   AND rr.warehouse_external_id=v_wh.external_warehouse_id AND rr.parse_status<>'ok') THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_BLOCKED:%',v_wh.external_warehouse_id USING ERRCODE='22023'; END IF;
 v_rows_in:=catalog.inventory_jsonb_array(p_rows);
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:rows' USING ERRCODE='22023'; END IF;
 v_declared_rows:=catalog.inventory_int_or_null(p_warehouse->'rowCount','rowCount');
 IF v_declared_rows IS NOT NULL AND v_declared_rows<>jsonb_array_length(v_rows_in) THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:rowCount' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.publish:'||p_run::text||':'||v_wh.id::text,947));
 v_canonical:=catalog.inventory_canonical_rows(v_rows_in);
 SELECT * INTO v_batch FROM catalog.inventory_batch b
 WHERE b.run_id=p_run AND b.warehouse_id=v_wh.id;
 IF v_batch.id IS NOT NULL THEN
  v_stored:=catalog.inventory_stored_batch_rows(v_batch.id);
  IF v_stored=v_canonical AND v_batch.row_count=jsonb_array_length(v_rows_in) THEN
   RETURN jsonb_build_object('ok',true,'batchId',v_batch.id,'rowCount',v_batch.row_count,
    'adopted',v_batch.adopted_count,'unmapped',v_batch.unmapped_count,'replayed',true,
    'observationAt',v_batch.observation_at,'publishedAt',v_batch.published_at,
    'observationStale',false,'successRecorded',true);
  END IF;
  RAISE EXCEPTION 'INVENTORY_BATCH_CONFLICT' USING ERRCODE='23505';
 END IF;
 IF v_run.file_id IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_EXPORT_MISSING' USING ERRCODE='22023'; END IF;
 -- exact registered row set check: excelRow + rowHash, nothing more, nothing less.
 SELECT count(*)::integer,count(*) FILTER(WHERE rr.parse_status='ok')::integer
 INTO v_expected_count,v_payload_count
 FROM catalog.inventory_run_row rr
 WHERE rr.run_id=p_run AND rr.warehouse_external_id=v_wh.external_warehouse_id;
 v_payload_count:=jsonb_array_length(v_rows_in);
 SELECT count(*)::integer INTO v_diff
 FROM (
  (SELECT rr.excel_row,rr.row_hash FROM catalog.inventory_run_row rr
    WHERE rr.run_id=p_run AND rr.warehouse_external_id=v_wh.external_warehouse_id AND rr.parse_status='ok'
    EXCEPT
   SELECT (r->>'excelRow')::integer,coalesce(r->>'rowHash','') FROM jsonb_array_elements(v_rows_in) r)
  UNION ALL
  (SELECT (r->>'excelRow')::integer,coalesce(r->>'rowHash','') FROM jsonb_array_elements(v_rows_in) r
    EXCEPT
   SELECT rr.excel_row,rr.row_hash FROM catalog.inventory_run_row rr
    WHERE rr.run_id=p_run AND rr.warehouse_external_id=v_wh.external_warehouse_id AND rr.parse_status='ok')
 ) diffs;
 IF v_diff<>0 THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_INCOMPLETE:%',v_wh.external_warehouse_id USING ERRCODE='22023'; END IF;
 -- pass 1 (F3): the registered inventory_run_row is the ONLY source of business fields. The caller
 -- payload may only repeat the exact registered content; keeping excelRow/hash while changing quantity
 -- or SKU is rejected as INVENTORY_WAREHOUSE_CONTENT_MISMATCH. previous_batch_id is derived from the
 -- adjacent earlier observation (F2), never from inventory_current.
 v_publish_ts:=now();
 FOR v_reg IN SELECT * FROM catalog.inventory_run_row rr
   WHERE rr.run_id=p_run AND rr.warehouse_external_id=v_wh.external_warehouse_id
    AND rr.parse_status='ok' ORDER BY rr.excel_row LOOP
  v_sku:=nullif(btrim(coalesce(v_reg.external_sku,'')),'');
  IF v_sku IS NULL THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_CONTENT_MISMATCH:missingRegisteredSku' USING ERRCODE='22023'; END IF;
  IF v_sku=ANY(v_seen) THEN
   RAISE EXCEPTION 'INVENTORY_DUPLICATE_SKU:%',v_sku USING ERRCODE='22023'; END IF;
  v_seen:=v_seen||v_sku;
  v_e:=NULL;
  SELECT r.value INTO v_e FROM jsonb_array_elements(v_rows_in) r
  WHERE (r.value->>'excelRow')::integer=v_reg.excel_row LIMIT 1;
  IF v_e IS NULL THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_INCOMPLETE:%',v_wh.external_warehouse_id USING ERRCODE='22023'; END IF;
  v_on_hand:=catalog.inventory_parse_quantity_text(v_reg.on_hand_text);
  v_order_locked:=catalog.inventory_parse_quantity_text(v_reg.order_locked_text);
  v_available:=catalog.inventory_parse_quantity_text(v_reg.warehouse_available_text);
  v_reserved:=catalog.inventory_parse_quantity_text(v_reg.activity_reserved_text);
  v_transit:=catalog.inventory_parse_quantity_text(v_reg.in_transit_text);
  v_gtin:=nullif(btrim(v_reg.gtin),'');
  v_hash:=v_reg.row_hash;
  v_decl_sku:=nullif(btrim(coalesce(v_e->>'externalSku','')),'');
  v_decl_on:=catalog.inventory_int_or_null(v_e->'onHand','onHand');
  IF v_decl_sku IS DISTINCT FROM v_sku
   OR v_decl_on IS DISTINCT FROM v_on_hand
   OR catalog.inventory_int_or_null(v_e->'orderLocked','orderLocked') IS DISTINCT FROM v_order_locked
   OR catalog.inventory_int_or_null(v_e->'warehouseAvailable','warehouseAvailable') IS DISTINCT FROM v_available
   OR catalog.inventory_int_or_null(v_e->'activityReserved','activityReserved') IS DISTINCT FROM v_reserved
   OR catalog.inventory_int_or_null(v_e->'inTransit','inTransit') IS DISTINCT FROM v_transit
   OR catalog.inventory_text_or_null(v_e->'rawOnHand','rawOnHand') IS DISTINCT FROM nullif(btrim(v_reg.on_hand_text),'')
   OR catalog.inventory_text_or_null(v_e->'rawOrderLocked','rawOrderLocked') IS DISTINCT FROM nullif(btrim(v_reg.order_locked_text),'')
   OR catalog.inventory_text_or_null(v_e->'rawWarehouseAvailable','rawWarehouseAvailable') IS DISTINCT FROM nullif(btrim(v_reg.warehouse_available_text),'')
   OR catalog.inventory_text_or_null(v_e->'rawActivityReserved','rawActivityReserved') IS DISTINCT FROM nullif(btrim(v_reg.activity_reserved_text),'')
   OR catalog.inventory_text_or_null(v_e->'rawInTransit','rawInTransit') IS DISTINCT FROM nullif(btrim(v_reg.in_transit_text),'')
   OR catalog.inventory_text_or_null(v_e->'gtin','gtin') IS DISTINCT FROM nullif(btrim(v_reg.gtin),'') THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_CONTENT_MISMATCH:%',v_sku USING ERRCODE='22023'; END IF;
  v_map:=catalog.inventory_resolve_mapping(v_run.account_id,v_wh.id,v_sku);
  v_prev_batch:=NULL;
  IF v_map.id IS NULL THEN
   v_status:='unmapped'; v_item:=NULL; v_variant:=NULL; v_mapping_id:=NULL; v_unit:=NULL;
   v_item_revision:=NULL; v_unmapped:=v_unmapped+1;
  ELSE
   v_status:='adopted'; v_item:=v_map.item_id; v_variant:=v_map.variant_id;
   v_mapping_id:=v_map.id; v_unit:=v_map.unit; v_adopted:=v_adopted+1;
   SELECT ic.revision INTO v_item_revision FROM catalog.item_current ic WHERE ic.item_id=v_map.item_id;
   IF v_item_revision IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_ITEM_REVISION_MISSING:%',v_map.item_id USING ERRCODE='22023'; END IF;
   SELECT pr.batch_id INTO v_prev_batch FROM catalog.inventory_previous_batch_row(
    v_run.account_id,v_wh.id,v_sku,v_map.item_id,v_obs,v_publish_ts,
    'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid) pr;
   v_mapping_snapshot:=v_mapping_snapshot||jsonb_build_array(jsonb_build_object(
    'mappingId',v_map.id,'version',v_map.version,'externalSku',v_sku,'unit',v_map.unit,
    'itemId',v_map.item_id,'variantId',v_map.variant_id,'itemRevision',v_item_revision));
  END IF;
  v_rows_out:=v_rows_out||jsonb_build_array(jsonb_build_object(
   'excelRow',v_reg.excel_row,
   'externalSku',v_sku,'gtin',v_gtin,'status',v_status,'itemId',v_item,'variantId',v_variant,
   'mappingId',v_mapping_id,'itemRevision',v_item_revision,'unit',v_unit,
   'onHand',v_on_hand,'orderLocked',v_order_locked,'warehouseAvailable',v_available,
   'activityReserved',v_reserved,'inTransit',v_transit,
   'rawOnHand',v_reg.on_hand_text,'rawOrderLocked',v_reg.order_locked_text,
   'rawWarehouseAvailable',v_reg.warehouse_available_text,
   'rawActivityReserved',v_reg.activity_reserved_text,
   'rawInTransit',v_reg.in_transit_text,'rowHash',v_hash,'previousBatchId',v_prev_batch));
 END LOOP;
 INSERT INTO catalog.inventory_batch(run_id,warehouse_id,warehouse_name_snapshot,scope_id,
  mapping_snapshot,source_file_sha256,row_count,adopted_count,unmapped_count,observation_at,
  source_row_count,published_at,published_by)
 SELECT p_run,v_wh.id,v_wh.external_name,v_run.scope_id,
  jsonb_build_object('warehouseId',v_wh.id,'warehouseExternalId',v_wh.external_warehouse_id,
   'scopeId',v_run.scope_id,'scopeVersion',v_scope.version,'exportFinishedAt',v_run.export_finished_at,
   'mappings',v_mapping_snapshot),
  f.sha256,v_adopted+v_unmapped,v_adopted,v_unmapped,v_obs,
  (SELECT count(*)::integer FROM catalog.inventory_run_row rr WHERE rr.run_id=p_run
    AND rr.warehouse_external_id=v_wh.external_warehouse_id),
  v_publish_ts,'worker:'||coalesce(nullif(v_run.lease_owner,''),'unknown')
 FROM catalog.inventory_export_file f WHERE f.id=v_run.file_id
 RETURNING * INTO v_batch;
 v_batch_id:=v_batch.id;
 -- pass 2: immutable rows + current pointer for adopted rows only
 FOR v_e IN SELECT r.value FROM jsonb_array_elements(v_rows_out) r LOOP
  INSERT INTO catalog.inventory_batch_row(batch_id,external_sku,excel_row,gtin,item_id,variant_id,
   mapping_id,item_revision,unit,on_hand,order_locked,warehouse_available,activity_reserved,in_transit,
   raw_on_hand,raw_order_locked,raw_warehouse_available,raw_activity_reserved,raw_in_transit,
   observation_at,previous_batch_id,row_hash,status)
  VALUES(v_batch_id,v_e->>'externalSku',(v_e->>'excelRow')::integer,v_e->>'gtin',
   nullif(v_e->>'itemId','')::uuid,nullif(v_e->>'variantId','')::uuid,
   nullif(v_e->>'mappingId','')::uuid,(v_e->>'itemRevision')::integer,nullif(v_e->>'unit',''),
   (v_e->>'onHand')::integer,(v_e->>'orderLocked')::integer,
   (v_e->>'warehouseAvailable')::integer,(v_e->>'activityReserved')::integer,
   (v_e->>'inTransit')::integer,
   v_e->>'rawOnHand',v_e->>'rawOrderLocked',v_e->>'rawWarehouseAvailable',
   v_e->>'rawActivityReserved',v_e->>'rawInTransit',
   v_obs,nullif(v_e->>'previousBatchId','')::uuid,v_e->>'rowHash',v_e->>'status');
  IF v_e->>'status'='adopted' THEN
   v_item:=nullif(v_e->>'itemId','')::uuid;
   v_variant:=nullif(v_e->>'variantId','')::uuid;
   v_unit:=nullif(v_e->>'unit','');
   v_new_qty:=(v_e->>'onHand')::integer;
   v_order_locked:=(v_e->>'orderLocked')::integer;
   v_available:=(v_e->>'warehouseAvailable')::integer;
   v_reserved:=(v_e->>'activityReserved')::integer;
   v_transit:=(v_e->>'inTransit')::integer;
   SELECT * INTO v_cur FROM catalog.inventory_current c
   WHERE c.warehouse_id=v_wh.id AND c.external_sku=v_e->>'externalSku' FOR UPDATE;
   IF v_cur.warehouse_id IS NOT NULL THEN
    IF v_cur.observation_at>v_obs THEN
     NULL; -- never move the current pointer backwards
    ELSIF v_cur.observation_at=v_obs AND (
     v_cur.on_hand IS DISTINCT FROM v_new_qty
     OR v_cur.order_locked IS DISTINCT FROM v_order_locked
     OR v_cur.warehouse_available IS DISTINCT FROM v_available
     OR v_cur.activity_reserved IS DISTINCT FROM v_reserved
     OR v_cur.in_transit IS DISTINCT FROM v_transit
     OR v_cur.item_id IS DISTINCT FROM v_item
     OR v_cur.variant_id IS DISTINCT FROM v_variant
     OR v_cur.unit IS DISTINCT FROM v_unit) THEN
     RAISE EXCEPTION 'INVENTORY_OBSERVATION_CONFLICT:%',v_e->>'externalSku' USING ERRCODE='40001';
    ELSE
     NULL;
    END IF;
   ELSE
    INSERT INTO catalog.inventory_current(warehouse_id,external_sku,batch_id,item_id,variant_id,
     unit,on_hand,order_locked,warehouse_available,activity_reserved,in_transit,
     observation_at,updated_at)
    VALUES(v_wh.id,v_e->>'externalSku',v_batch_id,v_item,v_variant,v_unit,v_new_qty,
     v_order_locked,v_available,v_reserved,v_transit,v_obs,now());
   END IF;
  END IF;
 END LOOP;
 -- warehouse success coverage only advances for a not-older observation (R1/R4)
 SELECT coalesce(ws.last_success_at IS NULL OR v_obs>=ws.last_success_at,true)
 INTO v_success FROM catalog.inventory_warehouse_state ws
 WHERE ws.account_id=v_run.account_id AND ws.warehouse_id=v_wh.id;
 IF NOT FOUND THEN v_success:=true; END IF;
 v_obs_stale:=NOT v_success;
 IF v_success THEN
  INSERT INTO catalog.inventory_warehouse_state(account_id,warehouse_id,last_success_at,
   last_success_run_id,last_batch_id,last_publish_at,last_observation_at,updated_at)
  VALUES(v_run.account_id,v_wh.id,v_obs,v_run.id,v_batch_id,now(),v_obs,now())
  ON CONFLICT(account_id,warehouse_id) DO UPDATE SET
   last_success_at=EXCLUDED.last_success_at,last_success_run_id=EXCLUDED.last_success_run_id,
   last_batch_id=EXCLUDED.last_batch_id,last_publish_at=EXCLUDED.last_publish_at,
   last_observation_at=EXCLUDED.last_observation_at,updated_at=now();
 ELSE
  INSERT INTO catalog.inventory_warehouse_state(account_id,warehouse_id,last_publish_at,updated_at)
  VALUES(v_run.account_id,v_wh.id,now(),now())
  ON CONFLICT(account_id,warehouse_id) DO UPDATE SET last_publish_at=now(),updated_at=now();
 END IF;
 PERFORM catalog.inventory_audit_write(NULL,'publish_inventory_warehouse',p_run::text,
  jsonb_build_object('batchId',v_batch_id,'warehouseId',v_wh.id,'rowCount',v_adopted+v_unmapped,
   'adopted',v_adopted,'unmapped',v_unmapped,'observationAt',v_obs,
   'observationStale',v_obs_stale,'successRecorded',v_success));
 RETURN jsonb_build_object('ok',true,'batchId',v_batch_id,'rowCount',v_adopted+v_unmapped,
  'adopted',v_adopted,'unmapped',v_unmapped,'replayed',false,
  'observationAt',v_obs,'observationStale',v_obs_stale,'successRecorded',v_success,
  'publishedAt',v_batch.published_at);
END $$;

-- finish: all-green means every scope warehouse's last_success_run_id = this run
CREATE OR REPLACE FUNCTION catalog.finish_inventory_run(p_run uuid,p_lease uuid,p_status text,p_summary jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_scope catalog.inventory_scope;
 v_expected integer:=0; v_published integer:=0; v_green integer:=0; v_all boolean:=false;
 v_final text; v_result jsonb; v_obs timestamptz;
BEGIN
 v_run:=catalog.inventory_require_lease(p_run,p_lease);
 IF p_status IS NULL OR p_status NOT IN('success','partial','failed') THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:status' USING ERRCODE='22023'; END IF;
 IF p_summary IS NOT NULL AND jsonb_typeof(p_summary)<>'object' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:summary' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_scope FROM catalog.inventory_scope s WHERE s.id=v_run.scope_id;
 v_expected:=coalesce(cardinality(v_scope.warehouse_ids),0);
 SELECT count(DISTINCT b.warehouse_id)::integer INTO v_published
 FROM catalog.inventory_batch b
 WHERE b.run_id=p_run AND b.warehouse_id=ANY(coalesce(v_scope.warehouse_ids,'{}'::uuid[]));
 SELECT count(*)::integer INTO v_green
 FROM catalog.inventory_warehouse_state ws
 WHERE ws.account_id=v_run.account_id AND ws.warehouse_id=ANY(coalesce(v_scope.warehouse_ids,'{}'::uuid[]))
  AND ws.last_success_run_id=p_run;
 v_all:=(v_expected>0 AND v_green=v_expected);
 v_final:=CASE
  WHEN v_run.account_identity_status<>'verified' OR coalesce((v_run.file_validation->>'blocked')::boolean,false)
   THEN 'failed'
  WHEN p_status='failed' THEN 'failed'
  WHEN v_all THEN 'success'
  WHEN v_published>0 OR v_green>0 THEN 'partial'
  ELSE 'failed' END;
 UPDATE catalog.inventory_sync_run SET status=v_final,finished_at=now(),
  lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=now(),
  summary=summary||coalesce(p_summary,'{}'::jsonb),updated_at=now()
 WHERE id=p_run;
 v_obs:=v_run.export_finished_at;
 IF v_all AND v_obs IS NOT NULL THEN
  INSERT INTO catalog.inventory_scope_state(account_id,scope_id,last_all_success_at,last_all_success_run_id)
  VALUES(v_run.account_id,v_run.scope_id,v_obs,p_run)
  ON CONFLICT(account_id,scope_id) DO UPDATE SET
   last_all_success_at=greatest(coalesce(catalog.inventory_scope_state.last_all_success_at,v_obs),v_obs),
   last_all_success_run_id=CASE
     WHEN catalog.inventory_scope_state.last_all_success_at IS NULL
       OR v_obs>=catalog.inventory_scope_state.last_all_success_at THEN EXCLUDED.last_all_success_run_id
     ELSE catalog.inventory_scope_state.last_all_success_run_id END;
 END IF;
 v_result:=jsonb_build_object('ok',true,'status',v_final,'runId',p_run,
  'scopeAllSuccess',v_all,'publishedWarehouses',v_published,'greenWarehouses',v_green,
  'scopeWarehouseCount',v_expected,'observationAt',v_obs);
 PERFORM catalog.inventory_audit_write(NULL,'finish_inventory_run',p_run::text,v_result);
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION catalog.fail_inventory_run(p_run uuid,p_lease uuid,p_error_code text,
 p_error_detail text,p_needs_login boolean,p_outcome_unknown boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_status text; v_result jsonb;
BEGIN
 v_run:=catalog.inventory_require_lease(p_run,p_lease);
 IF v_run.status NOT IN('queued','running','downloading','parsing','publishing') THEN
  RAISE EXCEPTION 'INVENTORY_RUN_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
 IF coalesce(p_needs_login,false) AND coalesce(p_outcome_unknown,false) THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 v_status:=CASE WHEN coalesce(p_needs_login,false) THEN 'needs_login'
  WHEN coalesce(p_outcome_unknown,false) THEN 'outcome_unknown'
  ELSE 'failed' END;
 IF v_status='outcome_unknown' THEN
  UPDATE catalog.inventory_sync_run SET status='outcome_unknown',
   error_code=left(coalesce(p_error_code,'OUTCOME_UNKNOWN'),120),
   error_detail=left(coalesce(p_error_detail,''),2000),
   summary=summary||jsonb_build_object('outcomeUnknownAt',now()),
   heartbeat_at=now(),updated_at=now()
  WHERE id=p_run;
 ELSE
  UPDATE catalog.inventory_sync_run SET status=v_status,
   error_code=left(coalesce(p_error_code,'INVENTORY_SYNC_FAILED'),120),
   error_detail=left(coalesce(p_error_detail,''),2000),
   finished_at=now(),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
   heartbeat_at=now(),updated_at=now()
  WHERE id=p_run;
  IF v_status='needs_login' THEN
   UPDATE catalog.inventory_source_account SET status='needs_login',
    last_login_check_at=now(),updated_at=now()
   WHERE id=v_run.account_id;
  END IF;
 END IF;
 v_result:=jsonb_build_object('ok',true,'status',v_status,'runId',p_run,
  'errorCode',left(coalesce(p_error_code,''),120));
 PERFORM catalog.inventory_audit_write(NULL,'fail_inventory_run',p_run::text,v_result);
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION catalog.read_inventory_run_work(p_run uuid,p_lease uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_run catalog.inventory_sync_run; v_published jsonb; v_file jsonb;
BEGIN
 v_run:=catalog.inventory_require_lease(p_run,p_lease);
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseId',b.warehouse_id,
   'warehouseExternalId',w.external_warehouse_id,'batchId',b.id,'rowCount',b.row_count,
   'observationAt',b.observation_at,'publishedAt',b.published_at) ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_published
 FROM catalog.inventory_batch b
 JOIN catalog.inventory_warehouse w ON w.id=b.warehouse_id
 WHERE b.run_id=p_run;
 IF v_run.file_id IS NOT NULL THEN
  SELECT jsonb_build_object('fileId',f.id,'sha256',f.sha256,'sizeBytes',f.size_bytes,
   'storageRelpath',f.storage_relpath,'sheetName',f.sheet_name,'rowCount',f.row_count,
   'blankRowCount',f.blank_row_count,'downloadedAt',f.downloaded_at,
   'parserVersion',f.parser_version)
  INTO v_file FROM catalog.inventory_export_file f WHERE f.id=v_run.file_id;
 END IF;
 RETURN jsonb_build_object('runId',v_run.id,'status',v_run.status,
  'triggerKind',v_run.trigger_kind,'plannedFor',v_run.planned_for,
  'coveredSlots',to_jsonb(v_run.covered_slots),'attempt',v_run.attempt,
  'exportFinishedAt',v_run.export_finished_at,'observationAt',v_run.export_finished_at,
  'accountIdentityStatus',v_run.account_identity_status,
  'accountIdentityLabel',v_run.account_identity_label,
  'fileValidation',v_run.file_validation,
  'warehouseDiscovery',v_run.warehouse_discovery,
  'publishedWarehouses',v_published,'file',v_file,'exportMark',v_run.export_mark,
  'errorCode',v_run.error_code);
END $$;

CREATE OR REPLACE FUNCTION catalog.reconcile_inventory_request(p_request uuid,p_intent text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row catalog.inventory_request; v_actor uuid; v_pending catalog.inventory_pending_action;
 v_internal boolean;
BEGIN
 v_internal:=current_user='ice_p0_02_owner' AND session_user='ice_p0_02_sync_runner';
 IF v_internal THEN v_actor:=NULL; ELSE v_actor:=catalog.require_admin(); END IF;
 IF p_request IS NULL OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM catalog.inventory_request r WHERE r.request_id=p_request;
 IF v_row.request_id IS NULL THEN
  -- No business receipt yet. If someone else owns a pending request for this id, a different admin
  -- must not read it as their own "clear not found"; it is a busy/forbidden target.
  SELECT * INTO v_pending FROM catalog.inventory_pending_action p WHERE p.request_id=p_request;
  IF NOT v_internal AND v_pending.request_id IS NOT NULL AND v_pending.actor_id IS DISTINCT FROM v_actor THEN
   RAISE EXCEPTION 'INVENTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Reconcile is bound to the complete persisted intent too: a different intent must not be reported
  -- as a clear "not found" that the UI may retry as if it were the original request.
  IF NOT v_internal AND v_pending.request_id IS NOT NULL
   AND v_pending.intent_hash IS DISTINCT FROM p_intent THEN
   RAISE EXCEPTION 'INVENTORY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  -- A failed terminal is a real, repeatable outcome of the same original request. It is not a business
  -- receipt and must never be retried, but it does release the recovery lock (no business effect happened).
  IF v_pending.request_id IS NOT NULL AND v_pending.status='failed' THEN
   RETURN jsonb_build_object('found',false,'response',NULL::jsonb,'terminal','failed',
    'terminalErrorCode',v_pending.error_code,'action',v_pending.action,
    'actorId',v_pending.actor_id,'createdAt',v_pending.created_at,'updatedAt',v_pending.updated_at); END IF;
  RETURN jsonb_build_object('found',false,'response',NULL::jsonb);
 END IF;
 IF v_row.intent_hash<>p_intent THEN
  RAISE EXCEPTION 'INVENTORY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
 IF NOT v_internal AND v_row.actor_id IS NOT NULL AND v_row.actor_id IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'INVENTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('found',true,'response',v_row.response,'action',v_row.action,
  'runId',v_row.run_id,'actorId',v_row.actor_id,'createdAt',v_row.created_at);
END $$;

-- ---------------------------------------------------------------------------
-- privileges (functions are idempotent; table privileges live in the structure file)
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA catalog FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog TO ice_p0_02_app_runner,ice_p0_02_sync_runner;
GRANT EXECUTE ON FUNCTION
 catalog.read_inventory_sync_overview(),
 catalog.read_inventory_sync_run(uuid),
 catalog.update_inventory_sync_settings(uuid,text,boolean,integer,boolean,text[]),
 catalog.request_inventory_manual_sync(uuid,text),
 catalog.read_inventory_mapping_queue(text,integer,integer),
 catalog.confirm_inventory_mapping(uuid,text,jsonb),
 catalog.recheck_inventory_mapping(uuid,text,uuid,text,integer),
 catalog.disable_inventory_mapping(uuid,text,uuid,text,integer),
 catalog.read_inventory_list(text,text,text,integer,integer),
 catalog.read_inventory_item(uuid,text,text,boolean),
 catalog.read_inventory_catalog_sources(),
 catalog.search_inventory_items(text,integer),
 catalog.read_inventory_pending_actions(),
 catalog.begin_inventory_pending_action(uuid,text,text,jsonb),
 catalog.complete_inventory_pending_action(uuid,text,jsonb,text),
 catalog.settle_inventory_pending_action(uuid,text,text,jsonb,text),
 catalog.reconcile_inventory_request(uuid,text)
 TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION
 catalog.register_inventory_worker(text,text,integer,text),
 catalog.refresh_inventory_account_status(text,boolean,text),
 catalog.claim_inventory_run(text,integer),
 catalog.update_inventory_run_phase(uuid,uuid,text,jsonb),
 catalog.register_inventory_export(uuid,uuid,jsonb),
 catalog.publish_inventory_warehouse(uuid,uuid,jsonb,jsonb),
 catalog.finish_inventory_run(uuid,uuid,text,jsonb),
 catalog.fail_inventory_run(uuid,uuid,text,text,boolean,boolean),
 catalog.read_inventory_run_work(uuid,uuid),
 catalog.reconcile_inventory_request(uuid,text)
 TO ice_p0_02_sync_runner;

RESET ROLE;
