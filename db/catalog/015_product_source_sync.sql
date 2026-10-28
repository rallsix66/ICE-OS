-- ICE catalog increment 015: Feishu (local-simulation) product source ingestion.
--
-- Scope: source profile / batch / raw rows / item bindings / adoption baseline /
-- per-item results / review issues / request receipts, plus SECURITY DEFINER
-- write and read functions. Everything money-like (worksheet columns I/J/Y) is
-- kept in catalog_private.product_source_row_amounts only; no read function of
-- this increment returns it and no public row column may store it.
--
-- Apply only to a guarded, freshly created catalog instance (same as 001/002).
-- Does not reference db/catalog/003/004/007/008 objects, so it is valid both on
-- the 001+002 preview chain and on the fuller catalogue instance.
--
-- JSON payload contracts are owned by src/features/catalog/product-source/
-- contract.ts (snapshot / plan) and server-types.ts (p_profile / p_batch /
-- p_plan / read projections). This file consumes them as-is:
--   p_profile = SourceProfileInput
--   p_batch   = SourceBatchInput  {snapshotKey,origin,capturedAt,sourceModifiedLabel,
--              collection,rowsSha256,adoptionSha256,parentBatchId,simulationNote,
--              artifacts[],rows[],amounts[]}
--   p_plan    = SourcePlanInput   {countsHint,results[],seenItemIds[],batchStatusHint}
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE catalog.product_source_profile (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_key text NOT NULL UNIQUE CHECK(length(btrim(profile_key))>0 AND profile_key=btrim(profile_key) AND length(profile_key)<=200),
 system text NOT NULL DEFAULT 'feishu' CHECK(system='feishu'),
 document_key text,
 spreadsheet_token text,
 sheet_id text,
 sheet_name text,
 display_name text,
 source_url text,
 acquisition_mode text NOT NULL DEFAULT 'local_snapshot' CHECK(acquisition_mode IN('local_snapshot','feishu_api')),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.product_source_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES catalog.product_source_profile ON DELETE RESTRICT,
 snapshot_key text NOT NULL CHECK(snapshot_key ~ '^[a-f0-9]{64}$'),
 origin text NOT NULL CHECK(origin IN('real_capture','local_simulation')),
 source_modified_label text,
 captured_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 collection jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(collection)='object'),
 rows_sha256 text NOT NULL CHECK(rows_sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'collected' CHECK(status IN('collected','validated','applied','partial','failed','rejected_stale')),
 counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(counts)='object'),
 parent_batch_id uuid REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 simulation_note text,
 request_id uuid,
 release_id uuid REFERENCES catalog.baseline_release ON DELETE RESTRICT,
 record_artifact_id uuid REFERENCES catalog.artifact ON DELETE RESTRICT,
 retry_of_batch_id uuid REFERENCES catalog.product_source_batch ON DELETE RESTRICT
);
-- One original batch per snapshot; explicit retries of a partial/failed batch are allowed
-- and keep their own row (retry_of_batch_id set).
CREATE UNIQUE INDEX product_source_batch_original_snapshot
 ON catalog.product_source_batch(profile_id,snapshot_key) WHERE retry_of_batch_id IS NULL;
CREATE INDEX product_source_batch_retry_of
 ON catalog.product_source_batch(retry_of_batch_id) WHERE retry_of_batch_id IS NOT NULL;

CREATE TABLE catalog.product_source_row (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 row_number integer NOT NULL CHECK(row_number>0),
 is_empty boolean NOT NULL DEFAULT false,
 ice_code_raw text,
 -- Restricted price columns are located by header text at write time, never by a fixed
 -- column letter, so a re-ordered sheet may legitimately use I/J/Y as normal text.
 cells jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(cells)='object'),
 fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(fields)='object'),
 row_sha256 text CHECK(row_sha256~'^[a-f0-9]{64}$'),
 UNIQUE(batch_id,row_number)
);

CREATE TABLE catalog_private.product_source_row_amounts (
 row_id uuid PRIMARY KEY REFERENCES catalog.product_source_row ON DELETE RESTRICT,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object')
);

CREATE TABLE catalog.product_source_binding (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES catalog.product_source_profile ON DELETE RESTRICT,
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 ice_code text CHECK(ice_code IS NULL OR(length(btrim(ice_code))>0 AND ice_code=btrim(ice_code) AND length(ice_code)<=50)),
 state text NOT NULL DEFAULT 'active' CHECK(state IN('active','missing')),
 created_batch_id uuid REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 last_seen_batch_id uuid REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(profile_id,item_id),
 UNIQUE(profile_id,ice_code)
);

CREATE TABLE catalog.product_source_adoption (
 profile_id uuid NOT NULL REFERENCES catalog.product_source_profile ON DELETE RESTRICT,
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 field_key text NOT NULL CHECK(length(field_key)>0 AND length(field_key)<=60),
 adopted_raw text,
 adopted_state text NOT NULL CHECK(adopted_state IN('observed','explicit_empty','no_text','not_read','parse_failed')),
 unit_state text CHECK(unit_state IS NULL OR unit_state IN('confirmed','unconfirmed','not_applicable')),
 adopted_batch_id uuid REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 adopted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(profile_id,item_id,field_key)
);

CREATE TABLE catalog.product_source_result (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(source_key)<=200),
 item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 ice_code text,
 classification text NOT NULL CHECK(classification IN('updated','created','unchanged','needs_review','missing','failed')),
 reason_code text,
 changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(changed_fields)='array'),
 item_revision integer CHECK(item_revision IS NULL OR item_revision>0),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object'),
 UNIQUE(batch_id,source_key)
);

CREATE TABLE catalog.product_source_issue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(source_key)<=200),
 issue_kind text NOT NULL CHECK(length(btrim(issue_kind))>0 AND length(issue_kind)<=100),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object'),
 item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 review_state text NOT NULL DEFAULT 'open' CHECK(review_state IN('open','resolved','ignored')),
 opened_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 resolution_note text,
 UNIQUE(batch_id,source_key,issue_kind)
);

CREATE TABLE catalog.product_source_request (
 request_id uuid PRIMARY KEY,
 profile_id uuid NOT NULL REFERENCES catalog.product_source_profile ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN('apply_product_source_batch','resolve_source_issue','assign_source_code')),
 intent_sha256 text NOT NULL CHECK(intent_sha256~'^[a-f0-9]{64}$'),
 batch_id uuid REFERENCES catalog.product_source_batch ON DELETE RESTRICT,
 result jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 request_xid bigint NOT NULL DEFAULT txid_current(),
 UNIQUE(request_id,profile_id)
);

-- Original submitted intent (draft) kept privately so a timed-out/unknown submission can be
-- verified by request id before any retry is generated. Never readable by the runtime role.
CREATE TABLE catalog_private.product_source_request_intent (
 request_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 action text NOT NULL CHECK(length(btrim(action))>0 AND length(action)<=100),
 intent_sha256 text NOT NULL CHECK(intent_sha256~'^[a-f0-9]{64}$'),
 profile_key text,
 snapshot_key text,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object'),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog_private.product_source_request_intent
 FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation();
ALTER TABLE catalog_private.product_source_request_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_private.product_source_request_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY enabled_admin ON catalog_private.product_source_request_intent
 FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin());

CREATE INDEX product_source_batch_profile_time ON catalog.product_source_batch(profile_id,captured_at DESC,received_at DESC);CREATE INDEX product_source_batch_status ON catalog.product_source_batch(profile_id,status);
CREATE INDEX product_source_row_batch ON catalog.product_source_row(batch_id,row_number);
CREATE INDEX product_source_row_code ON catalog.product_source_row(ice_code_raw) WHERE ice_code_raw IS NOT NULL;
CREATE INDEX product_source_binding_profile_state ON catalog.product_source_binding(profile_id,state);
CREATE INDEX product_source_binding_item ON catalog.product_source_binding(item_id);
CREATE INDEX product_source_adoption_item ON catalog.product_source_adoption(item_id);
CREATE INDEX product_source_result_batch ON catalog.product_source_result(batch_id);
CREATE INDEX product_source_result_item ON catalog.product_source_result(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX product_source_issue_batch ON catalog.product_source_issue(batch_id,review_state);
CREATE INDEX product_source_issue_open ON catalog.product_source_issue(opened_at DESC) WHERE review_state='open';
CREATE INDEX product_source_issue_item ON catalog.product_source_issue(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX product_source_request_profile ON catalog.product_source_request(profile_id,recorded_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Immutability: rows/results/request receipts/private amounts never change.
--    A batch may only advance status/counts/request_id (see guard below).
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['product_source_row','product_source_result','product_source_request'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog.%I FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()',t);
 END LOOP;
 EXECUTE 'CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog_private.product_source_row_amounts FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()';
END $$;

CREATE FUNCTION catalog.guard_product_source_batch_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CATALOG_IMMUTABLE' USING ERRCODE='42501'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
  OR NEW.snapshot_key IS DISTINCT FROM OLD.snapshot_key OR NEW.origin IS DISTINCT FROM OLD.origin
  OR NEW.source_modified_label IS DISTINCT FROM OLD.source_modified_label
  OR NEW.captured_at IS DISTINCT FROM OLD.captured_at OR NEW.received_at IS DISTINCT FROM OLD.received_at
  OR NEW.collection IS DISTINCT FROM OLD.collection OR NEW.rows_sha256 IS DISTINCT FROM OLD.rows_sha256
  OR NEW.parent_batch_id IS DISTINCT FROM OLD.parent_batch_id OR NEW.simulation_note IS DISTINCT FROM OLD.simulation_note
  OR NEW.release_id IS DISTINCT FROM OLD.release_id OR NEW.record_artifact_id IS DISTINCT FROM OLD.record_artifact_id
  OR NEW.retry_of_batch_id IS DISTINCT FROM OLD.retry_of_batch_id
 THEN RAISE EXCEPTION 'CATALOG_IMMUTABLE' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER batch_progress_only BEFORE UPDATE OR DELETE ON catalog.product_source_batch
 FOR EACH ROW EXECUTE FUNCTION catalog.guard_product_source_batch_mutation();

-- ---------------------------------------------------------------------------
-- 3. Row level security (admin-only; runtime role has no direct DML)
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['product_source_profile','product_source_batch','product_source_row','product_source_binding',
  'product_source_adoption','product_source_result','product_source_issue','product_source_request'] LOOP
  EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY enabled_admin ON catalog.%I FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin())',t);
 END LOOP;
 EXECUTE 'ALTER TABLE catalog_private.product_source_row_amounts ENABLE ROW LEVEL SECURITY';
 EXECUTE 'ALTER TABLE catalog_private.product_source_row_amounts FORCE ROW LEVEL SECURITY';
 EXECUTE 'CREATE POLICY enabled_admin ON catalog_private.product_source_row_amounts FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin())';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Internal helpers (not granted to any runtime role)
-- ---------------------------------------------------------------------------

-- The 23 stored product field keys (worksheet identity/price columns excluded).
CREATE FUNCTION catalog.product_source_field_keys() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT ARRAY['sourceDate','nameCn','specification','englishName','factory','imageRef','barcode',
  'length','width','height','unitWeight','cartonQuantity','cartonLength','cartonWidth','cartonHeight',
  'cartonWeight','liquid','shelfLifeDays','cartonVolume','unitVolume','factoryLeadDays','shippingDays','sourceNote']
$$;

-- Unit evidence state per field (only cm / kg / day / carton count are confirmed).
CREATE FUNCTION catalog.product_source_unit_state(p_field text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE p_field WHEN 'imageRef' THEN 'not_applicable'
  WHEN 'sourceDate' THEN 'not_applicable' WHEN 'nameCn' THEN 'not_applicable'
  WHEN 'specification' THEN 'not_applicable' WHEN 'englishName' THEN 'not_applicable'
  WHEN 'factory' THEN 'not_applicable' WHEN 'liquid' THEN 'not_applicable'
  WHEN 'sourceNote' THEN 'not_applicable'
  WHEN 'length' THEN 'confirmed' WHEN 'width' THEN 'confirmed' WHEN 'height' THEN 'confirmed'
  WHEN 'unitWeight' THEN 'confirmed' WHEN 'cartonQuantity' THEN 'confirmed'
  WHEN 'shelfLifeDays' THEN 'confirmed' WHEN 'factoryLeadDays' THEN 'confirmed' WHEN 'shippingDays' THEN 'confirmed'
  ELSE 'unconfirmed' END
$$;

-- Recursive key probe: ordinary plan/result payloads must not carry amount columns.
CREATE FUNCTION catalog.product_source_has_restricted_key(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 WITH RECURSIVE walk(value) AS (
  SELECT p WHERE jsonb_typeof(p) IN('object','array')
  UNION ALL
  SELECT child.value
  FROM walk w
  CROSS JOIN LATERAL (
   SELECT e.value FROM jsonb_each(CASE WHEN jsonb_typeof(w.value)='object' THEN w.value ELSE '{}'::jsonb END) e
   UNION ALL
   SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.value)='array' THEN w.value ELSE '[]'::jsonb END) a
  ) child
  WHERE jsonb_typeof(child.value) IN('object','array')
 )
 SELECT EXISTS(
  SELECT 1 FROM walk w
  CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(w.value)='object' THEN w.value ELSE '{}'::jsonb END) k(key)
  WHERE k.key IN('COST_PRICE','freight','costPrice','operatingPrice','shippingPrice','restrictedAmounts')
 );
$$;

-- Column letters of the restricted amount columns, located by header text only.
-- Headers are normalised (trim + internal whitespace collapsed) and matched against
-- the observed labels; no column letter is ever hardcoded, so a re-ordered sheet
-- (price labels on AB/AC/AD, I/J/Y holding ordinary text) still isolates correctly.
CREATE FUNCTION catalog.product_source_restricted_columns(p_headers jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(array_agg(e.key ORDER BY e.key),ARRAY[]::text[])
 FROM jsonb_each(CASE WHEN jsonb_typeof(p_headers)='object' THEN p_headers ELSE '{}'::jsonb END) e
 WHERE btrim(regexp_replace(btrim(coalesce(e.value #>> '{}','')),'\s+',' ','g'))
  IN('成本价格','运营价格','单品运费','单品运费（自由计算列）')
$$;

-- Public (non-price) worksheet cells: the restricted column letters are removed.
CREATE FUNCTION catalog.product_source_public_cells(p jsonb,p_restricted text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' THEN '{}'::jsonb ELSE coalesce((
  SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(p) e
  WHERE NOT(e.key=ANY(coalesce(p_restricted,ARRAY[]::text[])))
 ),'{}'::jsonb) END
$$;

-- Restricted raw amounts: semantic keys only (costPrice / operatingPrice / shippingPrice).
CREATE FUNCTION catalog.product_source_amount_payload(p jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' THEN '{}'::jsonb ELSE jsonb_strip_nulls(jsonb_build_object(
  'costPrice',CASE WHEN jsonb_typeof(p->'costPrice')='string' THEN p->>'costPrice' END,
  'operatingPrice',CASE WHEN jsonb_typeof(p->'operatingPrice')='string' THEN p->>'operatingPrice' END,
  'shippingPrice',CASE WHEN jsonb_typeof(p->'shippingPrice')='string' THEN p->>'shippingPrice' END)) END
$$;

-- SourceCell -> stored FieldObservation (catalog.valid_field compatible, adds evidenceRef).
CREATE FUNCTION catalog.product_source_field_observation(p_ref text,p_cell jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_state text; v_meaning text; v_raw text; v_out jsonb;
BEGIN
 IF p_cell IS NULL OR jsonb_typeof(p_cell)<>'object' THEN RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_INVALID' USING ERRCODE='22023'; END IF;
 v_state:=p_cell->>'state'; v_meaning:=p_cell->>'meaning';
 IF p_cell->'raw' IS NOT NULL AND jsonb_typeof(p_cell->'raw')<>'null' THEN
  IF jsonb_typeof(p_cell->'raw')<>'string' THEN RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_INVALID' USING ERRCODE='22023'; END IF;
  v_raw:=p_cell->>'raw';
 END IF;
 IF v_state='observed' AND v_raw IS NOT NULL THEN
  v_out:=jsonb_build_object('state','observed','raw',v_raw,
   'meaning',CASE WHEN v_raw='' OR v_meaning='explicit_empty' THEN 'explicit_empty' ELSE 'value' END,'evidenceRef',p_ref);
 ELSIF v_state='explicit_empty' THEN
  v_out:=jsonb_build_object('state','observed','raw','','meaning','explicit_empty','evidenceRef',p_ref);
 ELSIF v_state IN('not_read','parse_failed') OR (v_state='observed' AND v_raw IS NULL) THEN
  v_out:=jsonb_build_object('state',CASE WHEN v_state='observed' THEN 'not_read' ELSE v_state END,'raw',NULL,
   'reason',coalesce(nullif(p_cell->>'reason',''),'SOURCE_VALUE_NOT_READ'),'evidenceRef',p_ref);
 ELSE
  RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_INVALID' USING ERRCODE='22023';
 END IF;
 IF NOT catalog.valid_field(v_out) THEN RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_INVALID' USING ERRCODE='22023'; END IF;
 RETURN v_out;
END $$;

-- Normalise a nextFields map. Accepts stored FieldObservation values (contract type)
-- and bare SourceCell values (defensive); identity/price keys are never kept.
CREATE FUNCTION catalog.product_source_normalize_fields(p_snapshot text,p_source text,p_fields jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE e record; v_out jsonb:='{}'::jsonb; v_val jsonb;
BEGIN
 IF p_fields IS NULL OR jsonb_typeof(p_fields)<>'object' THEN RAISE EXCEPTION 'CATALOG_SOURCE_FIELDS_INVALID' USING ERRCODE='22023'; END IF;
 FOR e IN SELECT key,value FROM jsonb_each(p_fields) LOOP
  IF e.key='iceCode' THEN CONTINUE; END IF; -- identity lives in ice_code_snapshot, never in fields
  IF NOT e.key=ANY(catalog.product_source_field_keys()) THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_UNKNOWN:%',e.key USING ERRCODE='22023'; END IF;
  IF catalog.product_source_has_restricted_key(e.value) THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESTRICTED_FIELD' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(e.value)='object' AND jsonb_typeof(e.value->'evidenceRef')='string' THEN
   IF NOT catalog.valid_field(e.value) THEN RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_INVALID:%',e.key USING ERRCODE='22023'; END IF;
   v_val:=e.value;
  ELSE
   v_val:=catalog.product_source_field_observation('product-source:'||p_snapshot||'#'||p_source||'/'||e.key,e.value);
  END IF;
  v_out:=v_out||jsonb_build_object(e.key,v_val);
 END LOOP;
 RETURN v_out;
END $$;

-- Insert one snapshot's raw rows plus its private price evidence. Restricted columns are
-- located from the batch headers; private amounts come only from p_amounts.
CREATE FUNCTION catalog.insert_product_source_rows(p_batch uuid,p_rows jsonb,p_amounts jsonb,p_headers jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path='' AS $$
DECLARE e jsonb; v_a jsonb; v_row_id uuid; v_cells jsonb; v_fields jsonb; v_amt jsonb; v_k text;
 v_restricted text[]; v_total integer:=0; v_empty integer:=0; v_codes integer; v_amount_map jsonb:='{}'::jsonb;
BEGIN
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' THEN RAISE EXCEPTION 'CATALOG_SOURCE_ROWS_INVALID' USING ERRCODE='22023'; END IF;
 v_restricted:=catalog.product_source_restricted_columns(p_headers);
 IF p_amounts IS NOT NULL THEN
  IF jsonb_typeof(p_amounts)<>'array' THEN RAISE EXCEPTION 'CATALOG_SOURCE_AMOUNTS_INVALID' USING ERRCODE='22023'; END IF;
  FOR v_a IN SELECT a.value FROM jsonb_array_elements(p_amounts) a(value) LOOP
   IF jsonb_typeof(v_a)<>'object' OR jsonb_typeof(v_a->'rowNumber')<>'number' THEN
    RAISE EXCEPTION 'CATALOG_SOURCE_AMOUNTS_INVALID' USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(v_a->'payload')='object' THEN
    FOR v_k IN SELECT k.key FROM jsonb_object_keys(v_a->'payload') k(key) LOOP
     IF v_k NOT IN('costPrice','operatingPrice','shippingPrice') THEN
      RAISE EXCEPTION 'CATALOG_SOURCE_AMOUNTS_INVALID:%',v_k USING ERRCODE='22023'; END IF;
    END LOOP;
   END IF;
   v_amount_map:=v_amount_map||jsonb_build_object((v_a->>'rowNumber'),catalog.product_source_amount_payload(v_a->'payload'));
  END LOOP;
 END IF;
 FOR e IN SELECT r.value FROM jsonb_array_elements(p_rows) r(value) LOOP
  IF jsonb_typeof(e)<>'object' THEN RAISE EXCEPTION 'CATALOG_SOURCE_ROW_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(e->'rowNumber')<>'number' OR (e->>'rowNumber')::integer<=0 THEN RAISE EXCEPTION 'CATALOG_SOURCE_ROW_INVALID' USING ERRCODE='22023'; END IF;
  IF e->'isBusinessRow' IS NOT NULL AND jsonb_typeof(e->'isBusinessRow')<>'boolean' THEN RAISE EXCEPTION 'CATALOG_SOURCE_ROW_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(e->'rowSha256')='string' AND (e->>'rowSha256')!~'^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_ROW_INVALID:rowSha256' USING ERRCODE='22023'; END IF;
  v_cells:=catalog.product_source_public_cells(e->'cells',v_restricted);
  v_fields:=coalesce(e->'fields','{}'::jsonb);
  IF jsonb_typeof(v_fields)<>'object' OR catalog.product_source_has_restricted_key(v_fields) THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_RESTRICTED_FIELD' USING ERRCODE='22023'; END IF;
  v_amt:=coalesce(v_amount_map->(e->>'rowNumber'),'{}'::jsonb);
  INSERT INTO catalog.product_source_row(batch_id,row_number,is_empty,ice_code_raw,cells,fields,row_sha256)
  VALUES(p_batch,(e->>'rowNumber')::integer,NOT coalesce((e->>'isBusinessRow')::boolean,true),
   nullif(btrim(coalesce(e->>'iceCode','')),''),v_cells,v_fields,
   CASE WHEN jsonb_typeof(e->'rowSha256')='string' THEN e->>'rowSha256' END)
  RETURNING id INTO v_row_id;
  IF v_amt<>'{}'::jsonb THEN INSERT INTO catalog_private.product_source_row_amounts VALUES(v_row_id,v_amt); END IF;
  v_total:=v_total+1;
  IF NOT coalesce((e->>'isBusinessRow')::boolean,true) THEN v_empty:=v_empty+1; END IF;
 END LOOP;
 SELECT count(DISTINCT r.ice_code_raw)::integer INTO v_codes FROM catalog.product_source_row r
  WHERE r.batch_id=p_batch AND r.ice_code_raw IS NOT NULL;
 RETURN jsonb_build_object('rows',v_total,'emptyRows',v_empty,'businessRows',v_total-v_empty,'codes',coalesce(v_codes,0));
END $$;

-- Adoption baseline upsert from SourceAdoptionInput[] (fieldKey/raw/state/unitState).
CREATE FUNCTION catalog.upsert_product_source_adoptions(p_profile uuid,p_item uuid,p_batch uuid,p_adoptions jsonb) RETURNS void
 LANGUAGE plpgsql SET search_path='' AS $$
DECLARE e jsonb; v_raw text; v_state text; v_unit text;
BEGIN
 IF p_adoptions IS NULL OR jsonb_typeof(p_adoptions)<>'array' THEN RETURN; END IF;
 FOR e IN SELECT a.value FROM jsonb_array_elements(p_adoptions) a(value) LOOP
  IF jsonb_typeof(e)<>'object' OR nullif(e->>'fieldKey','') IS NULL THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_ADOPTION_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT (e->>'fieldKey')=ANY(catalog.product_source_field_keys()) THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_UNKNOWN:%',e->>'fieldKey' USING ERRCODE='22023'; END IF;
  v_raw:=CASE WHEN jsonb_typeof(e->'raw')='string' THEN e->>'raw' END;
  v_state:=coalesce(nullif(e->>'state',''),'observed');
  IF v_state NOT IN('observed','explicit_empty','no_text','not_read','parse_failed') THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_ADOPTION_INVALID' USING ERRCODE='22023'; END IF;
  v_unit:=coalesce(nullif(e->>'unitState',''),catalog.product_source_unit_state(e->>'fieldKey'));
  IF v_unit NOT IN('confirmed','unconfirmed','not_applicable') THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_ADOPTION_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO catalog.product_source_adoption(profile_id,item_id,field_key,adopted_raw,adopted_state,unit_state,adopted_batch_id,adopted_at)
  VALUES(p_profile,p_item,e->>'fieldKey',v_raw,v_state,v_unit,p_batch,now())
  ON CONFLICT(profile_id,item_id,field_key) DO UPDATE SET adopted_raw=EXCLUDED.adopted_raw,adopted_state=EXCLUDED.adopted_state,
   unit_state=EXCLUDED.unit_state,adopted_batch_id=EXCLUDED.adopted_batch_id,adopted_at=EXCLUDED.adopted_at;
 END LOOP;
END $$;

-- Adoption baseline implied by the fields a batch actually writes.
CREATE FUNCTION catalog.product_source_observations_from_fields(p_fields jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('fieldKey',e.key,'raw',e.value->>'raw','state',
   CASE WHEN e.value->>'meaning'='explicit_empty' THEN 'explicit_empty' ELSE 'observed' END,
   'unitState',catalog.product_source_unit_state(e.key)))
  FROM jsonb_each(CASE WHEN jsonb_typeof(p_fields)='object' THEN p_fields ELSE '{}'::jsonb END) e
  WHERE e.value->>'state'='observed'),'[]'::jsonb)
$$;

-- Stored results -> SourcePlanResult[] (shape used by read_product_source_overview
-- and by the write receipt; plan-only intermediate fields are omitted as null).
CREATE FUNCTION catalog.product_source_result_payload(p_batch uuid) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'sourceKey',r.source_key,
  'iceCode',r.ice_code,
  'itemId',r.item_id,
  'action',CASE r.classification WHEN 'updated' THEN 'update' WHEN 'created' THEN 'create'
    WHEN 'missing' THEN 'unchanged' ELSE r.classification END,
  'reasonCode',coalesce(r.reason_code,''),
  'reasonText',coalesce(r.detail->>'reasonText',''),
  'rowNumbers',coalesce(r.detail->'rowNumbers','[]'::jsonb),
  'expectedRevision',NULL::integer,
  'changes',r.changed_fields,
  'adoptions','[]'::jsonb,
  'nextFields',NULL::jsonb,
  'nameCn',coalesce(r.detail->>'nameCn',v.name_cn),
  'itemRevision',r.item_revision,
  'createCode',CASE WHEN r.classification='created' THEN r.ice_code END,
  'issues',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',i.issue_kind,'detail',i.detail) ORDER BY i.issue_kind)
    FROM catalog.product_source_issue i WHERE i.batch_id=r.batch_id AND i.source_key=r.source_key),'[]'::jsonb),
  'missing',r.classification='missing'
 ) ORDER BY r.source_key),'[]'::jsonb)
 FROM catalog.product_source_result r
 LEFT JOIN catalog.item_current ic ON ic.item_id=r.item_id
 LEFT JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision
 WHERE r.batch_id=p_batch
$$;

-- ---------------------------------------------------------------------------
-- 5. Apply one source batch
-- ---------------------------------------------------------------------------
CREATE FUNCTION catalog.apply_product_source_batch(p_request uuid,p_intent text,p_profile jsonb,p_batch jsonb,p_plan jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_actor uuid; v_prior jsonb; v_profile catalog.product_source_profile; v_batch catalog.product_source_batch;
 v_existing catalog.product_source_batch; v_rel catalog.baseline_release; v_snap_art uuid; v_art uuid;
 v_pkey text; v_snapshot text; v_rows_sha text; v_origin text; v_captured timestamptz; v_stale boolean;
 v_row_counts jsonb; v_created integer; v_updated integer; v_unchanged integer; v_review integer;
 v_failed integer; v_missing integer; v_issues integer; v_total_results integer; v_status text;
 v_result jsonb; v_results jsonb; v_counts jsonb;
 v_e jsonb; v_action text; v_class text; v_key text; v_reason text; v_reason_text text; v_code text;
 v_declared_item uuid; v_item uuid; v_cur catalog.item_current; v_prev catalog.item_revision; v_new_rev integer;
 v_next_fields jsonb; v_write_fields jsonb; v_name text; v_changes jsonb; v_detail jsonb; v_rows integer[];
 v_rows_json jsonb; v_expected integer; v_expected_before text; v_actual_before text; v_adopt jsonb;
 v_fe record; v_ch record; v_issue jsonb; v_issues_arr jsonb; v_evidence text; v_sqlstate text; v_msg text;
 v_reason_code text; v_seen_ids uuid[]; v_missing_flag boolean; v_failed_item uuid;
 v_retry_of uuid; v_retry_batch catalog.product_source_batch; v_headers jsonb;
 v_retry_keys text[]; v_bad_keys text[]; v_plan_result_count integer;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'apply_product_source_batch');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_profile IS NULL OR jsonb_typeof(p_profile)<>'object' OR p_batch IS NULL OR jsonb_typeof(p_batch)<>'object'
  OR p_plan IS NULL OR jsonb_typeof(p_plan)<>'object' THEN
  RAISE EXCEPTION 'CATALOG_INVALID_SOURCE_BATCH' USING ERRCODE='22023'; END IF;
 v_pkey:=nullif(p_profile->>'profileKey','');
 IF v_pkey IS NULL OR btrim(v_pkey)<>v_pkey OR length(v_pkey)>200
  OR coalesce(p_profile->>'acquisitionMode','local_snapshot') NOT IN('local_snapshot','feishu_api') THEN
  RAISE EXCEPTION 'CATALOG_INVALID_SOURCE_PROFILE' USING ERRCODE='22023'; END IF;
 v_snapshot:=p_batch->>'snapshotKey'; v_rows_sha:=p_batch->>'rowsSha256'; v_origin:=p_batch->>'origin';
 IF v_snapshot IS NULL OR v_snapshot!~'^[a-f0-9]{64}$' OR v_rows_sha IS NULL OR v_rows_sha!~'^[a-f0-9]{64}$'
  OR v_origin IS NULL OR v_origin NOT IN('real_capture','local_simulation') THEN
  RAISE EXCEPTION 'CATALOG_INVALID_SOURCE_BATCH' USING ERRCODE='22023'; END IF;
 BEGIN
  v_captured:=(p_batch->>'capturedAt')::timestamptz;
 EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'CATALOG_INVALID_SOURCE_BATCH:capturedAt' USING ERRCODE='22023';
 END;
 IF v_captured IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_SOURCE_BATCH:capturedAt' USING ERRCODE='22023'; END IF;
 IF catalog.product_source_has_restricted_key(p_plan) THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_RESTRICTED_IN_PLAN' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_batch->'collection')<>'object' THEN
  RAISE EXCEPTION 'CATALOG_INVALID_SOURCE_BATCH:collection' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_batch->'rows') NOT IN('array','null') THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_ROWS_INVALID' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_batch->'amounts') NOT IN('array','null') THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_AMOUNTS_INVALID' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_plan->'results') NOT IN('array','null') THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_PLAN_INVALID' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_plan->'seenItemIds')='array' THEN
  BEGIN
   SELECT array_agg(t.value::uuid) INTO v_seen_ids FROM jsonb_array_elements_text(p_plan->'seenItemIds') t(value);
  EXCEPTION WHEN OTHERS THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_PLAN_INVALID:seenItemIds' USING ERRCODE='22023';
  END;
 END IF;

 PERFORM pg_advisory_xact_lock(hashtextextended(v_pkey||':'||v_snapshot,925));

 INSERT INTO catalog.product_source_profile(profile_key,system,document_key,spreadsheet_token,sheet_id,sheet_name,display_name,source_url,acquisition_mode)
 VALUES(v_pkey,'feishu',p_profile->>'documentKey',p_profile->>'spreadsheetToken',p_profile->>'sheetId',p_profile->>'sheetName',
  p_profile->>'displayName',p_profile->>'sourceUrl',coalesce(p_profile->>'acquisitionMode','local_snapshot'))
 ON CONFLICT(profile_key) DO UPDATE SET document_key=coalesce(EXCLUDED.document_key,catalog.product_source_profile.document_key),
  spreadsheet_token=coalesce(EXCLUDED.spreadsheet_token,catalog.product_source_profile.spreadsheet_token),
  sheet_id=coalesce(EXCLUDED.sheet_id,catalog.product_source_profile.sheet_id),
  sheet_name=coalesce(EXCLUDED.sheet_name,catalog.product_source_profile.sheet_name),
  display_name=coalesce(EXCLUDED.display_name,catalog.product_source_profile.display_name),
  source_url=coalesce(EXCLUDED.source_url,catalog.product_source_profile.source_url),
  acquisition_mode=EXCLUDED.acquisition_mode
 RETURNING * INTO v_profile;

 -- Optional explicit retry of one earlier partial/failed batch that shares this snapshot.
 v_headers:=coalesce(p_batch->'collection'->'headers','{}'::jsonb);
 IF nullif(btrim(coalesce(p_batch->>'retryOfBatchId','')),'') IS NOT NULL THEN
  BEGIN
   v_retry_of:=(p_batch->>'retryOfBatchId')::uuid;
  EXCEPTION WHEN OTHERS THEN
   RAISE EXCEPTION 'CATALOG_INVALID_SOURCE_BATCH:retryOfBatchId' USING ERRCODE='22023';
  END;
  SELECT * INTO v_retry_batch FROM catalog.product_source_batch b
   WHERE b.id=v_retry_of AND b.profile_id=v_profile.id FOR SHARE;
  IF NOT FOUND OR v_retry_batch.snapshot_key<>v_snapshot
   OR v_retry_batch.status NOT IN('partial','failed') OR v_retry_batch.release_id IS NULL THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_RETRY_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(r.source_key),ARRAY[]::text[]) INTO v_retry_keys
   FROM catalog.product_source_result r WHERE r.batch_id=v_retry_of AND r.classification='failed';
  IF cardinality(v_retry_keys)=0 THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_RETRY_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  SELECT count(*)::integer INTO v_plan_result_count FROM jsonb_array_elements(
   CASE WHEN jsonb_typeof(p_plan->'results')='array' THEN p_plan->'results' ELSE '[]'::jsonb END) t(value);
  IF v_plan_result_count=0 THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_RETRY_NOT_ALLOWED' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(k.source_key),ARRAY[]::text[]) INTO v_bad_keys FROM (
   SELECT t.value->>'sourceKey' AS source_key FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p_plan->'results')='array' THEN p_plan->'results' ELSE '[]'::jsonb END) t(value)
  ) k WHERE NOT(coalesce(k.source_key,'')=ANY(v_retry_keys));
  IF cardinality(v_bad_keys)>0 THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_RETRY_NOT_FAILED:%',left(array_to_string(v_bad_keys,','),160) USING ERRCODE='22023'; END IF;
 END IF;

 -- Same snapshot already handled: reuse the stored outcome, never write products twice.
 SELECT * INTO v_existing FROM catalog.product_source_batch
  WHERE profile_id=v_profile.id AND snapshot_key=v_snapshot AND retry_of_batch_id IS NULL FOR UPDATE;
 -- A retry of this same snapshot is allowed to create its own batch; only an original
 -- batch of this snapshot short-circuits as a duplicate receipt.
 IF FOUND AND v_retry_of IS NULL THEN
  IF v_existing.status NOT IN('applied','partial','failed','rejected_stale') THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_SNAPSHOT_CONFLICT' USING ERRCODE='23505'; END IF;
  v_counts:=jsonb_build_object(
   'created',coalesce((v_existing.counts->>'created')::integer,0),
   'updated',coalesce((v_existing.counts->>'updated')::integer,0),
   'unchanged',coalesce((v_existing.counts->>'unchanged')::integer,0),
   'needsReview',coalesce((v_existing.counts->>'needsReview')::integer,0),
   'failed',coalesce((v_existing.counts->>'failed')::integer,0),
   'missing',coalesce((v_existing.counts->>'missing')::integer,0));
  v_result:=jsonb_build_object('status',CASE WHEN v_existing.status='rejected_stale' THEN 'rejected_stale' ELSE 'duplicate' END,
   'originalStatus',v_existing.status,'batchId',v_existing.id,'snapshotKey',v_existing.snapshot_key,
   'counts',v_counts,'results',catalog.product_source_result_payload(v_existing.id),
   'retryOfBatchId',NULL::uuid,
   'message',CASE WHEN v_existing.status='rejected_stale' THEN '来源快照早于最近批次，未应用' ELSE '该来源快照已应用，直接返回原结果' END);
  INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,release_id,result)
  VALUES(p_request,p_intent,v_actor,'apply_product_source_batch',v_existing.release_id,v_result);
  INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
  VALUES(p_request,v_profile.id,'apply_product_source_batch',p_intent,v_existing.id,v_result,v_actor)
  ON CONFLICT(request_id) DO NOTHING;
  RETURN v_result;
 END IF;

 -- An older captured_at than an already applied batch must never overwrite newer data.
 -- An explicit retry is deliberately exempt: it re-applies only the parent's failed
 -- source keys and every write is still guarded by the plan's expectedRevision.
 IF v_retry_of IS NULL THEN
  SELECT EXISTS(SELECT 1 FROM catalog.product_source_batch b
   WHERE b.profile_id=v_profile.id AND b.status IN('applied','partial') AND b.captured_at>v_captured) INTO v_stale;
 ELSE
  v_stale:=false;
 END IF;

 IF v_retry_of IS NOT NULL THEN
  -- Reuse the parent snapshot release/artifacts; never insert duplicate evidence rows.
  SELECT * INTO v_rel FROM catalog.baseline_release WHERE id=v_retry_batch.release_id;
  v_snap_art:=v_retry_batch.record_artifact_id;
  IF v_snap_art IS NULL THEN
   SELECT a.id INTO v_snap_art FROM catalog.artifact a WHERE a.release_id=v_rel.id
    ORDER BY (a.logical_name IN('source-snapshot.json','snapshot.json')) DESC,a.logical_name LIMIT 1;
  END IF;
 ELSIF NOT v_stale THEN
  SELECT * INTO v_rel FROM catalog.baseline_release
   WHERE release_key='product-source:'||v_pkey||':'||v_snapshot;
  IF FOUND THEN
   IF v_rel.bundle_sha256<>v_rows_sha OR v_rel.effective_csv_sha256<>v_snapshot
    OR v_rel.parser_version<>'feishu-product-source-v1' OR NOT v_rel.published THEN
    RAISE EXCEPTION 'CATALOG_SOURCE_RELEASE_CONFLICT' USING ERRCODE='23505'; END IF;
  ELSE
   INSERT INTO catalog.baseline_release(release_key,bundle_sha256,effective_csv_sha256,parser_version,adoption_sha256,manifest,published,published_at)
   VALUES('product-source:'||v_pkey||':'||v_snapshot,v_rows_sha,v_snapshot,'feishu-product-source-v1',
    coalesce(nullif(p_batch->>'adoptionSha256',''),v_snapshot),coalesce(p_batch->'manifest','{}'::jsonb),true,now())
   RETURNING * INTO v_rel;
  END IF;
  IF jsonb_typeof(p_batch->'artifacts')='array' THEN
   FOR v_e IN SELECT a.value FROM jsonb_array_elements(p_batch->'artifacts') a(value) LOOP
    IF jsonb_typeof(v_e)<>'object' OR nullif(v_e->>'logicalName','') IS NULL OR coalesce(v_e->>'sha256','')!~'^[a-f0-9]{64}$'
     OR coalesce(v_e->>'storageHandle','')='' OR jsonb_typeof(v_e->'size')<>'number' THEN
     RAISE EXCEPTION 'CATALOG_SOURCE_ARTIFACT_INVALID' USING ERRCODE='22023'; END IF;
    INSERT INTO catalog.artifact(release_id,logical_name,sha256,size_bytes,format,sensitivity)
    VALUES(v_rel.id,v_e->>'logicalName',v_e->>'sha256',(v_e->>'size')::bigint,coalesce(nullif(v_e->>'format',''),'json'),'restricted')
    RETURNING id INTO v_art;
    INSERT INTO catalog_private.artifact_handle VALUES(v_art,v_e->>'storageHandle');
    IF v_snap_art IS NULL AND v_e->>'role'='snapshot' THEN v_snap_art:=v_art; END IF;
   END LOOP;
  END IF;
  IF v_snap_art IS NULL THEN
   SELECT a.id INTO v_snap_art FROM catalog.artifact a WHERE a.release_id=v_rel.id
    ORDER BY (a.logical_name IN('source-snapshot.json','snapshot.json')) DESC,a.logical_name LIMIT 1;
  END IF;
 END IF;

 IF v_stale THEN
  INSERT INTO catalog.product_source_batch(profile_id,snapshot_key,origin,source_modified_label,captured_at,collection,rows_sha256,
   status,counts,parent_batch_id,simulation_note,request_id)
  VALUES(v_profile.id,v_snapshot,v_origin,p_batch->>'sourceModifiedLabel',v_captured,p_batch->'collection',
   v_rows_sha,'rejected_stale','{}'::jsonb,
   (SELECT b2.id FROM catalog.product_source_batch b2 WHERE b2.profile_id=v_profile.id AND b2.id=nullif(p_batch->>'parentBatchId','')::uuid),
   p_batch->>'simulationNote',p_request)
  RETURNING * INTO v_batch;
  v_row_counts:=catalog.insert_product_source_rows(v_batch.id,
   CASE WHEN jsonb_typeof(p_batch->'rows')='array' THEN p_batch->'rows' ELSE '[]'::jsonb END,
   CASE WHEN jsonb_typeof(p_batch->'amounts')='array' THEN p_batch->'amounts' END,
   v_headers);
  v_counts:=jsonb_build_object('created',0,'updated',0,'unchanged',0,'needsReview',0,'failed',0,'missing',0);
  UPDATE catalog.product_source_batch SET counts=(v_row_counts-'codes')||v_counts WHERE id=v_batch.id;
  v_result:=jsonb_build_object('status','rejected_stale','batchId',v_batch.id,'snapshotKey',v_snapshot,
   'counts',v_counts,'results','[]'::jsonb,'retryOfBatchId',NULL::uuid,'message','来源快照早于最近批次，未应用');
  INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,release_id,result)
  VALUES(p_request,p_intent,v_actor,'apply_product_source_batch',NULL,v_result);
  INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
  VALUES(p_request,v_profile.id,'apply_product_source_batch',p_intent,v_batch.id,v_result,v_actor)
  ON CONFLICT(request_id) DO NOTHING;
  RETURN v_result;
 END IF;

 INSERT INTO catalog.product_source_batch(profile_id,snapshot_key,origin,source_modified_label,captured_at,collection,rows_sha256,
  status,counts,parent_batch_id,simulation_note,request_id,release_id,record_artifact_id,retry_of_batch_id)
 VALUES(v_profile.id,v_snapshot,v_origin,p_batch->>'sourceModifiedLabel',v_captured,p_batch->'collection',
  v_rows_sha,'collected','{}'::jsonb,
  (SELECT b2.id FROM catalog.product_source_batch b2 WHERE b2.profile_id=v_profile.id AND b2.id=nullif(p_batch->>'parentBatchId','')::uuid),
  p_batch->>'simulationNote',p_request,v_rel.id,v_snap_art,v_retry_of)
 RETURNING * INTO v_batch;
 v_row_counts:=catalog.insert_product_source_rows(v_batch.id,
  CASE WHEN jsonb_typeof(p_batch->'rows')='array' THEN p_batch->'rows' ELSE '[]'::jsonb END,
  CASE WHEN jsonb_typeof(p_batch->'amounts')='array' THEN p_batch->'amounts' END,
  v_headers);

 -- Per-item application. Every item runs in its own subtransaction: a failed item is
 -- recorded as failed while the rest of the batch still commits.
 FOR v_e IN SELECT r.value FROM jsonb_array_elements(
   CASE WHEN jsonb_typeof(p_plan->'results')='array' THEN p_plan->'results' ELSE '[]'::jsonb END) r(value) LOOP
  v_key:=null; v_action:=null; v_code:=null; v_declared_item:=null; v_item:=null; v_reason_code:=null;
  BEGIN
   IF jsonb_typeof(v_e)<>'object' THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID' USING ERRCODE='22023'; END IF;
   v_key:=nullif(v_e->>'sourceKey','');
   v_action:=v_e->>'action';
   IF v_key IS NULL OR btrim(v_key)<>v_key OR length(v_key)>200 THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:sourceKey' USING ERRCODE='22023'; END IF;
   IF v_action IS NULL OR v_action NOT IN('update','create','unchanged','needs_review','failed') THEN
    RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:action' USING ERRCODE='22023'; END IF;
   IF EXISTS(SELECT 1 FROM catalog.product_source_result r WHERE r.batch_id=v_batch.id AND r.source_key=v_key) THEN
    RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_DUPLICATE' USING ERRCODE='23505'; END IF;
   v_reason:=nullif(v_e->>'reasonCode','');
   IF v_reason IS NOT NULL AND length(v_reason)>100 THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:reasonCode' USING ERRCODE='22023'; END IF;
   v_reason_text:=nullif(btrim(coalesce(v_e->>'reasonText','')),'');
   IF v_reason_text IS NOT NULL AND length(v_reason_text)>500 THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:reasonText' USING ERRCODE='22023'; END IF;
   IF nullif(v_e->>'itemId','') IS NOT NULL THEN v_declared_item:=(v_e->>'itemId')::uuid; END IF;
   IF nullif(v_e->>'iceCode','') IS NOT NULL THEN v_code:=btrim(v_e->>'iceCode'); END IF;
   v_missing_flag:=jsonb_typeof(v_e->'missing')='boolean' AND (v_e->>'missing')::boolean;
   IF jsonb_typeof(v_e->'changes') NOT IN('array','null') THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:changes' USING ERRCODE='22023'; END IF;
   v_changes:=CASE WHEN jsonb_typeof(v_e->'changes')='array' THEN v_e->'changes' ELSE '[]'::jsonb END;
   IF catalog.product_source_has_restricted_key(v_changes) THEN
    RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:changes' USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(v_e->'issues') NOT IN('array','null') THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:issues' USING ERRCODE='22023'; END IF;
   v_issues_arr:=CASE WHEN jsonb_typeof(v_e->'issues')='array' THEN v_e->'issues' ELSE '[]'::jsonb END;
   IF catalog.product_source_has_restricted_key(v_issues_arr) THEN
    RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:issues' USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(v_e->'rowNumbers') NOT IN('array','null') THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:rowNumbers' USING ERRCODE='22023'; END IF;
   v_rows_json:=CASE WHEN jsonb_typeof(v_e->'rowNumbers')='array' THEN v_e->'rowNumbers' ELSE '[]'::jsonb END;
   v_detail:=jsonb_build_object('reasonText',v_reason_text,'rowNumbers',v_rows_json,
    'nameCn',nullif(btrim(coalesce(v_e->>'nameCn','')),''));
   v_rows:=coalesce(ARRAY(SELECT (t.value)::integer FROM jsonb_array_elements_text(v_rows_json) t(value)),ARRAY[]::integer[]);
   v_evidence:='product-source:'||v_snapshot||'#'||v_key||CASE WHEN cardinality(v_rows)>0 THEN ' rows='||array_to_string(v_rows,',') ELSE '' END;

   IF v_action='create' THEN
    v_class:='created';
    IF v_declared_item IS NOT NULL THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:create' USING ERRCODE='22023'; END IF;
    v_code:=coalesce(nullif(btrim(coalesce(v_e->>'createCode','')),''),v_code);
    IF v_code IS NULL OR length(v_code)>50 THEN RAISE EXCEPTION 'CATALOG_SOURCE_CODE_INVALID' USING ERRCODE='22023'; END IF;
    v_write_fields:=catalog.product_source_normalize_fields(v_snapshot,v_key,v_e->'nextFields');
    IF v_write_fields='{}'::jsonb THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:nextFields' USING ERRCODE='22023'; END IF;
    v_name:=nullif(btrim(coalesce(v_e->>'nameCn','')),'');
    IF v_name IS NULL THEN v_name:=nullif(btrim(v_write_fields->'nameCn'->>'raw'),''); END IF;
    IF v_name IS NULL OR length(v_name)>500 THEN RAISE EXCEPTION 'CATALOG_NAME_REQUIRED' USING ERRCODE='22023'; END IF;
    INSERT INTO catalog.catalog_item(first_release_id,new_product_confirmed) VALUES(v_rel.id,false) RETURNING id INTO v_item;
    INSERT INTO catalog.catalog_item_code(item_id,ice_code,evidence_ref,request_id) VALUES(v_item,v_code,v_evidence,p_request);
    INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,artifact_id,evidence_ref,reason,actor_id)
    VALUES(v_item,1,NULL,v_code,v_name,v_write_fields,v_snap_art,v_evidence,
     coalesce(v_reason_text,'来源首轮基线'),v_actor);
    INSERT INTO catalog.item_current(item_id,revision,financial_revision) VALUES(v_item,1,NULL);
    INSERT INTO catalog.product_source_binding(profile_id,item_id,ice_code,state,created_batch_id,last_seen_batch_id)
    VALUES(v_profile.id,v_item,v_code,'active',v_batch.id,v_batch.id)
    ON CONFLICT(profile_id,item_id) DO UPDATE SET ice_code=EXCLUDED.ice_code,state='active',last_seen_batch_id=EXCLUDED.last_seen_batch_id;
    v_adopt:=CASE WHEN jsonb_typeof(v_e->'adoptions')='array' THEN v_e->'adoptions' ELSE '[]'::jsonb END;
    IF v_adopt='[]'::jsonb THEN v_adopt:=catalog.product_source_observations_from_fields(v_write_fields); END IF;
    PERFORM catalog.upsert_product_source_adoptions(v_profile.id,v_item,v_batch.id,v_adopt);
    INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
    VALUES(v_batch.id,v_key,v_item,v_code,'created',v_reason,v_changes,1,v_detail);
   ELSIF v_action='update' OR (v_action='needs_review' AND jsonb_typeof(v_e->'nextFields')='object') THEN
    -- Both write a product revision. needs_review still reports needs_review (blocked
    -- fields stayed local) while the non-conflicting handled fields are adopted.
    v_class:=CASE WHEN v_action='update' THEN 'updated' ELSE 'needs_review' END;
    IF v_declared_item IS NULL THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:itemId' USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(v_e->'expectedRevision')<>'number' OR (v_e->>'expectedRevision')::integer<=0 THEN
     RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:expectedRevision' USING ERRCODE='22023'; END IF;
    v_expected:=(v_e->>'expectedRevision')::integer;
    v_next_fields:=catalog.product_source_normalize_fields(v_snapshot,v_key,v_e->'nextFields');
    IF v_next_fields='{}'::jsonb THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:nextFields' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_cur FROM catalog.item_current WHERE item_id=v_declared_item FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
    IF v_cur.revision<>v_expected THEN RAISE EXCEPTION 'CATALOG_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
    SELECT * INTO v_prev FROM catalog.item_revision WHERE item_id=v_declared_item AND revision=v_cur.revision;
    -- Plan freshness: every declared beforeRaw must still be the current raw value.
    FOR v_ch IN SELECT k.key AS field_key,v2.value AS change
      FROM jsonb_array_elements(v_changes) WITH ORDINALITY AS v2(value,ord)
      CROSS JOIN LATERAL (SELECT v2.value->>'fieldKey' AS key) k LOOP
     IF v_ch.field_key IS NULL THEN RAISE EXCEPTION 'CATALOG_SOURCE_PLAN_INVALID:fieldKey' USING ERRCODE='22023'; END IF;
     IF v_ch.field_key='iceCode' THEN CONTINUE; END IF;
     IF NOT v_ch.field_key=ANY(catalog.product_source_field_keys()) THEN
      RAISE EXCEPTION 'CATALOG_SOURCE_PLAN_INVALID:fieldKey' USING ERRCODE='22023'; END IF;
     -- Explicit empty ('') and absent/null raw are the same observed state for freshness.
     v_expected_before:=nullif(CASE WHEN jsonb_typeof(v_ch.change->'beforeRaw')='string' THEN v_ch.change->>'beforeRaw' END,'');
     v_actual_before:=nullif(CASE WHEN (v_prev.fields?v_ch.field_key) AND jsonb_typeof(v_prev.fields->v_ch.field_key)='object'
       AND jsonb_typeof(v_prev.fields->v_ch.field_key->'raw')='string' THEN v_prev.fields->v_ch.field_key->>'raw' END,'');
     IF v_actual_before IS DISTINCT FROM v_expected_before THEN
      RAISE EXCEPTION 'CATALOG_PLAN_STALE' USING ERRCODE='40001'; END IF;
    END LOOP;
    v_item:=v_declared_item;
    v_write_fields:=coalesce(v_prev.fields,'{}'::jsonb)||v_next_fields;
    v_name:=nullif(btrim(coalesce(v_e->>'nameCn','')),'');
    IF v_name IS NULL THEN v_name:=nullif(btrim(v_write_fields->'nameCn'->>'raw'),''); END IF;
    IF v_name IS NULL THEN v_name:=v_prev.name_cn; END IF;
    IF v_name IS NULL OR length(v_name)=0 THEN RAISE EXCEPTION 'CATALOG_NAME_REQUIRED' USING ERRCODE='22023'; END IF;
    IF v_code IS NULL THEN v_code:=v_prev.ice_code_snapshot; END IF;
    IF v_code IS NULL THEN SELECT c.ice_code INTO v_code FROM catalog.catalog_item_code c WHERE c.item_id=v_item; END IF;
    v_new_rev:=v_cur.revision+1;
    INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,artifact_id,evidence_ref,reason,actor_id)
    VALUES(v_item,v_new_rev,v_cur.revision,v_code,v_name,v_write_fields,v_snap_art,v_evidence,
     coalesce(v_reason_text,CASE WHEN v_action='update' THEN '来源资料采用' ELSE '来源资料采用（部分字段待核对）' END),v_actor);
    UPDATE catalog.item_current SET revision=v_new_rev WHERE item_id=v_item;
    INSERT INTO catalog.product_source_binding(profile_id,item_id,ice_code,state,created_batch_id,last_seen_batch_id)
    VALUES(v_profile.id,v_item,v_code,'active',v_batch.id,v_batch.id)
    ON CONFLICT(profile_id,item_id) DO UPDATE SET ice_code=coalesce(EXCLUDED.ice_code,catalog.product_source_binding.ice_code),
     state='active',last_seen_batch_id=EXCLUDED.last_seen_batch_id;
    v_adopt:=CASE WHEN jsonb_typeof(v_e->'adoptions')='array' THEN v_e->'adoptions' ELSE '[]'::jsonb END;
    IF v_adopt='[]'::jsonb THEN v_adopt:=catalog.product_source_observations_from_fields(v_write_fields); END IF;
    PERFORM catalog.upsert_product_source_adoptions(v_profile.id,v_item,v_batch.id,v_adopt);
    INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
    VALUES(v_batch.id,v_key,v_item,v_code,v_class,v_reason,v_changes,v_new_rev,v_detail);
   ELSIF v_action='unchanged' AND v_missing_flag THEN
    v_class:='missing';
    IF v_declared_item IS NULL OR v_code IS NULL THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:missing' USING ERRCODE='22023'; END IF;
    INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
    VALUES(v_batch.id,v_key,v_declared_item,v_code,'missing',coalesce(v_reason,'SOURCE_ROW_MISSING'),v_changes,NULL,v_detail);
    UPDATE catalog.product_source_binding SET state='missing'
     WHERE profile_id=v_profile.id AND item_id=v_declared_item AND state='active';
   ELSIF v_action='unchanged' THEN
    v_class:='unchanged';
    IF v_declared_item IS NULL THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:unchanged' USING ERRCODE='22023'; END IF;
    v_item:=v_declared_item;
    IF NOT EXISTS(SELECT 1 FROM catalog.catalog_item i WHERE i.id=v_item) THEN
     RAISE EXCEPTION 'CATALOG_SOURCE_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
    IF v_code IS NULL THEN SELECT c.ice_code INTO v_code FROM catalog.catalog_item_code c WHERE c.item_id=v_item; END IF;
    INSERT INTO catalog.product_source_binding(profile_id,item_id,ice_code,state,created_batch_id,last_seen_batch_id)
    VALUES(v_profile.id,v_item,v_code,'active',v_batch.id,v_batch.id)
    ON CONFLICT(profile_id,item_id) DO UPDATE SET ice_code=coalesce(EXCLUDED.ice_code,catalog.product_source_binding.ice_code),
     state='active',last_seen_batch_id=EXCLUDED.last_seen_batch_id;
    PERFORM catalog.upsert_product_source_adoptions(v_profile.id,v_item,v_batch.id,
     CASE WHEN jsonb_typeof(v_e->'adoptions')='array' THEN v_e->'adoptions' ELSE '[]'::jsonb END);
    INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
    VALUES(v_batch.id,v_key,v_item,v_code,'unchanged',coalesce(v_reason,'SOURCE_UNCHANGED'),v_changes,NULL,v_detail);
   ELSIF v_action='needs_review' THEN
    v_class:='needs_review';
    INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
    VALUES(v_batch.id,v_key,v_declared_item,v_code,'needs_review',coalesce(v_reason,'SOURCE_REVIEW'),v_changes,NULL,v_detail);
   ELSE
    v_class:='failed';
    INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
    VALUES(v_batch.id,v_key,v_declared_item,v_code,'failed',coalesce(v_reason,'SOURCE_APPLY_FAILED'),v_changes,NULL,v_detail);
   END IF;
   -- One review issue per declared plan issue (kind kept verbatim; bounded length).
   FOR v_fe IN SELECT i.value AS issue FROM jsonb_array_elements(v_issues_arr) i(value) LOOP
    IF jsonb_typeof(v_fe.issue)<>'object' OR nullif(v_fe.issue->>'kind','') IS NULL THEN
     RAISE EXCEPTION 'CATALOG_SOURCE_RESULT_INVALID:issues' USING ERRCODE='22023'; END IF;
    v_issue:=CASE WHEN jsonb_typeof(v_fe.issue->'detail')='object' THEN v_fe.issue->'detail' ELSE '{}'::jsonb END;
    IF catalog.product_source_has_restricted_key(v_issue) THEN RAISE EXCEPTION 'CATALOG_SOURCE_RESTRICTED_FIELD' USING ERRCODE='22023'; END IF;
    INSERT INTO catalog.product_source_issue(batch_id,source_key,issue_kind,detail,item_id)
    VALUES(v_batch.id,v_key,left(v_fe.issue->>'kind',100),
     v_issue||jsonb_build_object('rowNumbers',v_rows_json),coalesce(v_declared_item,v_item))
    ON CONFLICT(batch_id,source_key,issue_kind) DO NOTHING;
   END LOOP;
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS v_sqlstate=RETURNED_SQLSTATE,v_msg=MESSAGE_TEXT;
   v_reason_code:=CASE
    WHEN v_sqlstate='40001' AND v_msg LIKE 'CATALOG_REVISION_CONFLICT%' THEN 'CATALOG_REVISION_CONFLICT'
    WHEN v_sqlstate='40001' AND v_msg LIKE 'CATALOG_PLAN_STALE%' THEN 'CATALOG_PLAN_STALE'
    WHEN v_msg LIKE 'CATALOG_%' THEN left(split_part(v_msg,':',1),100)
    ELSE 'SOURCE_APPLY_FAILED' END;
   v_failed_item:=CASE WHEN v_e?'itemId' THEN nullif(v_e->>'itemId','')::uuid END;
   IF v_failed_item IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM catalog.catalog_item i WHERE i.id=v_failed_item) THEN v_failed_item:=NULL; END IF;
   INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
   VALUES(v_batch.id,coalesce(v_key,'unknown'),v_failed_item,
    v_code,'failed',v_reason_code,'[]'::jsonb,NULL,
    jsonb_build_object('sqlstate',v_sqlstate,'code',left(v_msg,160),
     'reasonText',v_reason_text,'rowNumbers',
     CASE WHEN jsonb_typeof(v_e->'rowNumbers')='array' THEN v_e->'rowNumbers' ELSE '[]'::jsonb END,
     'nameCn',nullif(btrim(coalesce(v_e->>'nameCn','')),'')))
   ON CONFLICT(batch_id,source_key) DO NOTHING;
   INSERT INTO catalog.product_source_issue(batch_id,source_key,issue_kind,detail,item_id)
   VALUES(v_batch.id,coalesce(v_key,'unknown'),v_reason_code,
    jsonb_build_object('sqlstate',v_sqlstate,'code',left(v_msg,160),'rowNumbers',
     CASE WHEN jsonb_typeof(v_e->'rowNumbers')='array' THEN v_e->'rowNumbers' ELSE '[]'::jsonb END),v_failed_item)
   ON CONFLICT(batch_id,source_key,issue_kind) DO NOTHING;
  END;
 END LOOP;

 -- Safety net: bound items neither reported nor listed as seen are only marked missing
 -- (never deleted, unbound or zeroed). A batch-level invalid/failed result (sourceKey
 -- 'batch') means the snapshot was not applied at all, so nothing may be marked missing.
 -- An explicit retry never marks anything missing either: it only re-applies the
 -- parent's failed source keys.
 IF v_retry_of IS NULL AND NOT EXISTS(SELECT 1 FROM catalog.product_source_result r WHERE r.batch_id=v_batch.id AND r.source_key='batch') THEN
 INSERT INTO catalog.product_source_result(batch_id,source_key,item_id,ice_code,classification,reason_code,changed_fields,item_revision,detail)
 SELECT v_batch.id,'code:'||b.ice_code,b.item_id,b.ice_code,'missing','SOURCE_ROW_MISSING','[]'::jsonb,NULL,
   jsonb_build_object('binding','active','reasonText','本次来源快照未见该已绑定商品，仅标记','rowNumbers','[]'::jsonb)
 FROM catalog.product_source_binding b
 WHERE b.profile_id=v_profile.id AND b.state='active' AND b.ice_code IS NOT NULL
  AND NOT(coalesce(v_seen_ids,ARRAY[]::uuid[]) @> ARRAY[b.item_id])
  AND NOT EXISTS(SELECT 1 FROM catalog.product_source_result r WHERE r.batch_id=v_batch.id AND r.item_id=b.item_id)
  AND NOT EXISTS(SELECT 1 FROM catalog.product_source_result r WHERE r.batch_id=v_batch.id AND r.source_key='code:'||b.ice_code)
 ON CONFLICT(batch_id,source_key) DO NOTHING;
 UPDATE catalog.product_source_binding b SET state='missing'
  WHERE b.profile_id=v_profile.id AND b.state='active' AND b.ice_code IS NOT NULL
   AND NOT(coalesce(v_seen_ids,ARRAY[]::uuid[]) @> ARRAY[b.item_id])
   AND NOT EXISTS(SELECT 1 FROM catalog.product_source_result r WHERE r.batch_id=v_batch.id AND r.item_id=b.item_id);
 INSERT INTO catalog.product_source_issue(batch_id,source_key,issue_kind,detail,item_id)
 SELECT r.batch_id,r.source_key,'missing_row',r.detail,r.item_id
 FROM catalog.product_source_result r
 WHERE r.batch_id=v_batch.id AND r.classification='missing'
  AND NOT EXISTS(SELECT 1 FROM catalog.product_source_issue i WHERE i.batch_id=v_batch.id AND i.source_key=r.source_key)
 ON CONFLICT(batch_id,source_key,issue_kind) DO NOTHING;
 END IF;

 SELECT count(*) FILTER(WHERE classification='created')::integer,count(*) FILTER(WHERE classification='updated')::integer,
   count(*) FILTER(WHERE classification='unchanged')::integer,count(*) FILTER(WHERE classification='needs_review')::integer,
   count(*) FILTER(WHERE classification='failed')::integer,count(*) FILTER(WHERE classification='missing')::integer,
   count(*)::integer
  INTO v_created,v_updated,v_unchanged,v_review,v_failed,v_missing,v_total_results
 FROM catalog.product_source_result WHERE batch_id=v_batch.id;
 SELECT count(*)::integer INTO v_issues FROM catalog.product_source_issue WHERE batch_id=v_batch.id;
 -- Batch status comes from the stored results, never from the caller's hint.
 v_status:=CASE
  WHEN v_failed>0 AND v_failed=v_total_results THEN 'failed'
  WHEN v_failed>0 OR v_review>0 THEN 'partial'
  ELSE 'applied' END;
 v_counts:=jsonb_build_object('created',v_created,'updated',v_updated,'unchanged',v_unchanged,
  'needsReview',v_review,'failed',v_failed,'missing',v_missing);
 UPDATE catalog.product_source_batch SET status=v_status,
  counts=(v_row_counts-'codes')||v_counts||jsonb_build_object('issues',v_issues) WHERE id=v_batch.id;

 v_results:=catalog.product_source_result_payload(v_batch.id);
 v_result:=jsonb_build_object('status',v_status,'batchId',v_batch.id,'snapshotKey',v_snapshot,
  'counts',v_counts,'results',v_results,'retryOfBatchId',v_retry_of,'message',NULL::text);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,release_id,result)
 VALUES(p_request,p_intent,v_actor,'apply_product_source_batch',v_rel.id,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile.id,'apply_product_source_batch',p_intent,v_batch.id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Resolve one review issue (never touches product data)
-- ---------------------------------------------------------------------------
CREATE FUNCTION catalog.resolve_product_source_issue(p_request uuid,p_intent text,p_issue uuid,p_resolution text,p_note text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_issue catalog.product_source_issue; v_profile_id uuid; v_result jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'resolve_source_issue');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_issue IS NULL OR p_resolution IS NULL OR p_resolution NOT IN('resolved','ignored')
  OR (p_note IS NOT NULL AND length(p_note)>1000) THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_issue FROM catalog.product_source_issue WHERE id=p_issue FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_issue.review_state<>'open' THEN RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_OPEN' USING ERRCODE='22023'; END IF;
 SELECT b.profile_id INTO v_profile_id FROM catalog.product_source_batch b WHERE b.id=v_issue.batch_id;
 UPDATE catalog.product_source_issue SET review_state=p_resolution,resolved_at=now(),resolved_by=v_actor,resolution_note=p_note
  WHERE id=p_issue;
 v_result:=jsonb_build_object('issueId',v_issue.id,'sourceKey',v_issue.source_key,'issueKind',v_issue.issue_kind,
  'reviewState',p_resolution,'itemId',v_issue.item_id,'batchId',v_issue.batch_id);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'resolve_source_issue',v_issue.item_id,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'resolve_source_issue',p_intent,v_issue.batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Assign a source code to an existing (still code-less) item, keeping its UUID
-- ---------------------------------------------------------------------------
CREATE FUNCTION catalog.assign_product_source_code(p_request uuid,p_intent text,p_item uuid,p_expected integer,
 p_code text,p_reason text,p_evidence text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_cur catalog.item_current; v_prev catalog.item_revision;
 v_profile_id uuid; v_batch_id uuid; v_row catalog.product_source_row; v_result jsonb; v_rev integer;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'assign_source_code');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_item IS NULL OR p_expected IS NULL OR p_expected<=0 OR p_code IS NULL OR length(p_code)>50
  OR length(btrim(p_code))=0 OR btrim(p_code)<>p_code
  OR p_reason IS NULL OR length(btrim(p_reason))=0 OR length(p_reason)>1000
  OR p_evidence IS NULL OR length(btrim(p_evidence))=0 OR length(p_evidence)>500 THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_cur FROM catalog.item_current WHERE item_id=p_item FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_cur.revision<>p_expected THEN RAISE EXCEPTION 'CATALOG_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.catalog_item_code c WHERE c.item_id=p_item) THEN
  RAISE EXCEPTION 'CATALOG_CODE_IMMUTABLE' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.catalog_item_code c WHERE c.ice_code=p_code) THEN
  RAISE EXCEPTION 'CATALOG_CODE_CONFLICT' USING ERRCODE='23505'; END IF;
 SELECT p.id INTO v_profile_id FROM catalog.product_source_profile p
  WHERE p.profile_key='feishu.ice-product-library.sheet1';
 IF v_profile_id IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT:profile' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.product_source_binding b WHERE b.profile_id=v_profile_id AND b.ice_code=p_code AND b.item_id<>p_item) THEN
  RAISE EXCEPTION 'CATALOG_CODE_CONFLICT' USING ERRCODE='23505'; END IF;
 SELECT r.* INTO v_row
 FROM catalog.product_source_row r JOIN catalog.product_source_batch b ON b.id=r.batch_id
 WHERE b.profile_id=v_profile_id AND r.ice_code_raw=p_code AND r.is_empty=false
 ORDER BY b.captured_at DESC,b.received_at DESC,r.row_number LIMIT 1;
 IF FOUND THEN v_batch_id:=v_row.batch_id; END IF;
 SELECT * INTO v_prev FROM catalog.item_revision WHERE item_id=p_item AND revision=v_cur.revision;
 v_rev:=v_cur.revision+1;
 INSERT INTO catalog.catalog_item_code(item_id,ice_code,evidence_ref,request_id) VALUES(p_item,p_code,p_evidence,p_request);
 INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,artifact_id,evidence_ref,reason,actor_id)
 VALUES(p_item,v_rev,v_cur.revision,p_code,v_prev.name_cn,v_prev.fields,v_prev.artifact_id,p_evidence,
  '来源编号补录',v_actor);
 UPDATE catalog.item_current SET revision=v_rev WHERE item_id=p_item;
 INSERT INTO catalog.product_source_binding(profile_id,item_id,ice_code,state,created_batch_id,last_seen_batch_id)
 VALUES(v_profile_id,p_item,p_code,'active',v_batch_id,v_batch_id)
 ON CONFLICT(profile_id,item_id) DO UPDATE SET ice_code=EXCLUDED.ice_code,state='active',
  last_seen_batch_id=coalesce(EXCLUDED.last_seen_batch_id,catalog.product_source_binding.last_seen_batch_id);
 IF v_row.id IS NOT NULL AND jsonb_typeof(v_row.fields)='object' AND v_row.fields<>'{}'::jsonb THEN
  PERFORM catalog.upsert_product_source_adoptions(v_profile_id,p_item,v_batch_id,
   catalog.product_source_observations_from_fields(v_row.fields));
 END IF;
 v_result:=jsonb_build_object('itemId',p_item,'revision',v_rev,'iceCode',p_code,'batchId',v_batch_id);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'assign_source_code',p_item,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'assign_source_code',p_intent,v_batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 7b. Original request intent retention (unknown submission outcome verification)
-- ---------------------------------------------------------------------------
CREATE FUNCTION catalog.record_product_source_request_intent(p_request uuid,p_intent text,p_action text,
 p_profile_key text,p_snapshot_key text,p_payload jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_existing catalog_private.product_source_request_intent; v_audit catalog.audit_event;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_request IS NULL OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$'
  OR p_action IS NULL OR length(btrim(p_action))=0 OR length(p_action)>100
  OR (p_payload IS NOT NULL AND jsonb_typeof(p_payload)<>'object') THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,926));
 SELECT * INTO v_existing FROM catalog_private.product_source_request_intent
  WHERE request_id=p_request FOR UPDATE;
 IF FOUND THEN
  IF v_existing.actor_id<>v_actor OR v_existing.action<>p_action OR v_existing.intent_sha256<>p_intent THEN
   RAISE EXCEPTION 'CATALOG_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('recorded',false,'requestId',p_request,'action',v_existing.action,
   'intentSha256',v_existing.intent_sha256,'profileKey',v_existing.profile_key,
   'snapshotKey',v_existing.snapshot_key,'recordedAt',v_existing.recorded_at);
 END IF;
 SELECT * INTO v_audit FROM catalog.audit_event WHERE request_id=p_request;
 IF FOUND THEN
  IF v_audit.actor_id<>v_actor OR v_audit.action<>p_action OR v_audit.intent_sha256<>p_intent THEN
   RAISE EXCEPTION 'CATALOG_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('recorded',false,'requestId',p_request,'action',v_audit.action,
   'intentSha256',v_audit.intent_sha256,'profileKey',p_profile_key,'snapshotKey',p_snapshot_key,
   'recordedAt',v_audit.recorded_at);
 END IF;
 INSERT INTO catalog_private.product_source_request_intent(request_id,actor_id,action,intent_sha256,profile_key,snapshot_key,payload)
 VALUES(p_request,v_actor,p_action,p_intent,p_profile_key,p_snapshot_key,coalesce(p_payload,'{}'::jsonb));
 RETURN jsonb_build_object('recorded',true,'requestId',p_request,'action',p_action,'intentSha256',p_intent,
  'profileKey',p_profile_key,'snapshotKey',p_snapshot_key);
END $$;

CREATE FUNCTION catalog.read_product_source_request_intent(p_request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_row catalog_private.product_source_request_intent;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_request IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM catalog_private.product_source_request_intent
  WHERE request_id=p_request AND actor_id=v_actor;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('requestId',v_row.request_id,'action',v_row.action,'intentSha256',v_row.intent_sha256,
  'profileKey',v_row.profile_key,'snapshotKey',v_row.snapshot_key,'payload',v_row.payload,'recordedAt',v_row.recorded_at);
END $$;

-- ---------------------------------------------------------------------------
-- 8. Read-only projections (SourceOverviewRaw / SourceItemStateRaw; never prices)
-- ---------------------------------------------------------------------------
CREATE FUNCTION catalog.read_product_source_overview(p_profile_key text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile catalog.product_source_profile; v_latest catalog.product_source_batch; v_result jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_profile_key IS NULL OR length(btrim(p_profile_key))=0 OR p_profile_key<>btrim(p_profile_key) OR length(p_profile_key)>200 THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_profile FROM catalog.product_source_profile WHERE profile_key=p_profile_key;
 IF NOT FOUND THEN
  -- Not registered yet (no batch applied): a well-formed empty projection, not an error.
  RETURN jsonb_build_object(
   'source',jsonb_build_object('profileKey',p_profile_key,'displayName',NULL::text,'documentKey',NULL::text,
    'sheetName',NULL::text,'acquisitionMode','local_snapshot'),
   'latest',NULL::jsonb,'results','[]'::jsonb,'issues','[]'::jsonb,'batches','[]'::jsonb,'bindingCount',0);
 END IF;
 SELECT * INTO v_latest FROM catalog.product_source_batch b WHERE b.profile_id=v_profile.id
  ORDER BY b.captured_at DESC,b.received_at DESC LIMIT 1;
 SELECT jsonb_build_object(
  'source',jsonb_build_object('profileKey',v_profile.profile_key,'displayName',v_profile.display_name,
   'documentKey',v_profile.document_key,'sheetName',v_profile.sheet_name,'acquisitionMode',v_profile.acquisition_mode),
  'latest',CASE WHEN v_latest.id IS NULL THEN NULL ELSE jsonb_build_object(
    'batchId',v_latest.id,'snapshotKey',v_latest.snapshot_key,'origin',v_latest.origin,
    'capturedAt',v_latest.captured_at,'sourceModifiedLabel',v_latest.source_modified_label,
    'status',v_latest.status,
    'counts',jsonb_build_object(
     'created',coalesce((v_latest.counts->>'created')::integer,0),
     'updated',coalesce((v_latest.counts->>'updated')::integer,0),
     'unchanged',coalesce((v_latest.counts->>'unchanged')::integer,0),
     'needsReview',coalesce((v_latest.counts->>'needsReview')::integer,0),
     'failed',coalesce((v_latest.counts->>'failed')::integer,0),
     'missing',coalesce((v_latest.counts->>'missing')::integer,0)),
    'message',CASE v_latest.status
     WHEN 'rejected_stale' THEN '来源快照早于最近批次，未应用'
     WHEN 'failed' THEN '该来源批次未应用，保留上次成功数据'
     WHEN 'partial' THEN '部分项目需人工核对，其余已应用'
     WHEN 'applied' THEN '本批已应用'
     WHEN 'validated' THEN '已校验，尚未应用'
     ELSE '已采集，尚未应用' END,
    'collection',v_latest.collection) END,
  'results',CASE WHEN v_latest.id IS NULL THEN '[]'::jsonb ELSE catalog.product_source_result_payload(v_latest.id) END,
  'issues',coalesce((SELECT jsonb_agg(t.obj) FROM (
    SELECT jsonb_build_object('issueKey',i.id,'sourceKey',i.source_key,'iceCode',c.ice_code,'nameCn',v.name_cn,
     'kind',i.issue_kind,'detail',i.detail,'reviewState',i.review_state,
     'rows',coalesce(i.detail->'rowNumbers','[]'::jsonb)) AS obj,
     i.review_state,i.opened_at
    FROM catalog.product_source_issue i
    JOIN catalog.product_source_batch b ON b.id=i.batch_id
    LEFT JOIN catalog.catalog_item_code c ON c.item_id=i.item_id
    LEFT JOIN catalog.item_current ic ON ic.item_id=i.item_id
    LEFT JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision
    WHERE b.profile_id=v_profile.id
    ORDER BY (i.review_state<>'open'),i.opened_at DESC LIMIT 50) t),'[]'::jsonb),
  'batches',coalesce((SELECT jsonb_agg(t.obj) FROM (
    SELECT jsonb_build_object('batchId',b.id,'snapshotKey',b.snapshot_key,'origin',b.origin,
     'capturedAt',b.captured_at,'status',b.status,
     'counts',jsonb_build_object(
      'created',coalesce((b.counts->>'created')::integer,0),
      'updated',coalesce((b.counts->>'updated')::integer,0),
      'unchanged',coalesce((b.counts->>'unchanged')::integer,0),
      'needsReview',coalesce((b.counts->>'needsReview')::integer,0),
      'failed',coalesce((b.counts->>'failed')::integer,0),
      'missing',coalesce((b.counts->>'missing')::integer,0)),
     'parentBatchId',b.parent_batch_id) AS obj, b.captured_at,b.received_at
    FROM catalog.product_source_batch b WHERE b.profile_id=v_profile.id
    ORDER BY b.captured_at DESC,b.received_at DESC LIMIT 10) t),'[]'::jsonb),
  'bindingCount',(SELECT count(*) FROM catalog.product_source_binding b WHERE b.profile_id=v_profile.id)
 ) INTO v_result;
 RETURN v_result;
END $$;

CREATE FUNCTION catalog.read_product_source_item_state(p_item uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb; v_profile_id uuid; v_binding catalog.product_source_binding;
BEGIN
 PERFORM catalog.require_admin();
 IF p_item IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT b.* INTO v_binding FROM catalog.product_source_binding b
  WHERE b.item_id=p_item ORDER BY b.created_at DESC LIMIT 1;
 IF FOUND THEN v_profile_id:=v_binding.profile_id; END IF;
 SELECT jsonb_build_object(
  'itemId',p_item,
  'iceCode',(SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=p_item),
  'binding',CASE WHEN v_binding.id IS NULL THEN NULL::jsonb ELSE jsonb_build_object(
    'iceCode',v_binding.ice_code,'state',v_binding.state) END,
  'adoptions',coalesce((
    SELECT jsonb_object_agg(a.field_key,jsonb_build_object('raw',a.adopted_raw,'unitState',a.unit_state))
    FROM catalog.product_source_adoption a
    WHERE a.item_id=p_item AND (v_profile_id IS NULL OR a.profile_id=v_profile_id)),'{}'::jsonb),
  'latestResult',(SELECT jsonb_build_object(
    'classification',CASE r.classification WHEN 'updated' THEN 'update' WHEN 'created' THEN 'create' ELSE r.classification END,
    'reasonCode',coalesce(r.reason_code,''),'capturedAt',b.captured_at,'origin',b.origin)
   FROM catalog.product_source_result r JOIN catalog.product_source_batch b ON b.id=r.batch_id
   WHERE r.item_id=p_item AND (v_profile_id IS NULL OR b.profile_id=v_profile_id)
   ORDER BY b.captured_at DESC,b.received_at DESC LIMIT 1)
 ) INTO v_result;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Privileges: runtime role keeps SELECT on the public tables and EXECUTE on the
--    five functions only; no DML, no private schema access, no PUBLIC execute.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE catalog.product_source_profile,catalog.product_source_batch,catalog.product_source_row,
 catalog.product_source_binding,catalog.product_source_adoption,catalog.product_source_result,
 catalog.product_source_issue,catalog.product_source_request
 FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;
REVOKE ALL ON TABLE catalog_private.product_source_row_amounts FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;
REVOKE ALL ON TABLE catalog_private.product_source_request_intent FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA catalog FROM PUBLIC;

GRANT USAGE ON SCHEMA catalog TO ice_p0_02_app_runner;
GRANT SELECT ON TABLE catalog.product_source_profile,catalog.product_source_batch,catalog.product_source_row,
 catalog.product_source_binding,catalog.product_source_adoption,catalog.product_source_result,
 catalog.product_source_issue,catalog.product_source_request TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.apply_product_source_batch(uuid,text,jsonb,jsonb,jsonb) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.resolve_product_source_issue(uuid,text,uuid,text,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.assign_product_source_code(uuid,text,uuid,integer,text,text,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_product_source_overview(text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_product_source_item_state(uuid) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.record_product_source_request_intent(uuid,text,text,text,text,jsonb) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_product_source_request_intent(uuid) TO ice_p0_02_app_runner;

RESET ROLE;
