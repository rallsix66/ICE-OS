-- ICE catalog 025: 国内聚水潭人工复核决定（2026-10-28 review CSV）追加存储 + 读链接通。
--
-- 背景（合同 docs/tasks/catalog-binding-inline-edit-v1.md §4「国内复核与库存采用」）：
--   * 022/023 的国内读链读取的是早期冻结选择（catalog.source_observation + decision_evidence
--     entry_kind='candidate_snapshot'）。本轮用户提交的人工复核结果中，有 5 条聚水潭记录的旧决定与本次
--     目标不同（3 条 ignored、1 条 rejected、1 条 candidate），需要把「本次确认」接入现有国内详情与
--     商品汇总读链，同时保留原观察、原决定、原冻结文件与历史事实。
--   * 本文件只追加「最新已确认复核决定」结构，不改 023 原函数之外的任何历史行；数量与日期仍由服务端
--     从 SHA 固定的冻结 coverage/source-records.json 读取（023 注释所称“数量不在 DB”保持不变）。
--
-- 内容：
--   1. catalog.domestic_review_decision  追加式决定表（不可 UPDATE/DELETE，FORCE RLS，仅函数写）。
--   2. catalog.apply_domestic_review_decision(...) SECURITY DEFINER RPC：管理员身份 + 既有
--      inventory_request 回执/幂等 + inventory_audit 审计；与 confirm_inventory_mapping 同一套请求机制。
--   3. CREATE OR REPLACE catalog.read_inventory_domestic_links()：023 原逻辑上优先最新复核决定。
--
-- 安装约定：幂等（CREATE ... IF NOT EXISTS / CREATE OR REPLACE），0 表结构版本变更。
-- 必须晚于 022/023 重放；prepare-instance 接线顺序如未包含本文件，需要在其 023 之后追加
--   applied.push(await applySql(owner, 'db/catalog/025_domestic_review.sql'));
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 追加式复核决定表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog.domestic_review_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- 输入文件哈希（sha256(原 CSV)）：同一份文件 + 同一来源行只保存一条稳定决定。
 dataset_sha256 text NOT NULL CHECK(dataset_sha256~'^[a-f0-9]{64}$'),
 source_row_id text NOT NULL
  CHECK(length(btrim(source_row_id))>0 AND source_row_id=btrim(source_row_id) AND length(source_row_id)<=200),
 source_observation_id uuid NOT NULL REFERENCES catalog.source_observation ON DELETE RESTRICT,
 legacy_candidate_id text NOT NULL
  CHECK(length(btrim(legacy_candidate_id))>0 AND legacy_candidate_id=btrim(legacy_candidate_id)),
 -- 前值由服务端按当前库读取后写入，不接受客户端伪造。
 previous_review_state text,
 previous_item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 review_state text NOT NULL CHECK(review_state IN('manual_selected')),
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 source_file text NOT NULL CHECK(length(btrim(source_file))>0),
 source_sheet text,
 source_excel_row integer CHECK(source_excel_row IS NULL OR source_excel_row>0),
 source_sku text NOT NULL CHECK(length(btrim(source_sku))>0),
 -- 回执关联：同一事务内由 inventory_record_request 写入，故声明为可延迟外键。
 request_id uuid NOT NULL REFERENCES catalog.inventory_request(request_id)
  DEFERRABLE INITIALLY DEFERRED,
 actor_id uuid REFERENCES public.profiles ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(dataset_sha256,source_row_id)
);
CREATE INDEX IF NOT EXISTS domestic_review_decision_observation
 ON catalog.domestic_review_decision(source_observation_id,recorded_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS domestic_review_decision_candidate
 ON catalog.domestic_review_decision(legacy_candidate_id,recorded_at DESC,id DESC);

-- 历史/证据行不可改：复用 016 的同一拒绝函数。
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgname='immutable_history'
    AND tgrelid='catalog.domestic_review_decision'::regclass
 ) THEN
  EXECUTE 'CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog.domestic_review_decision '
   || 'FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()';
 END IF;
END $$;

-- RLS：与 016 表同一策略风格（管理员会话 / definer owner）；本表只经 SECURITY DEFINER 函数写。
ALTER TABLE catalog.domestic_review_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.domestic_review_decision FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname='catalog' AND tablename='domestic_review_decision' AND policyname='enabled_admin'
 ) THEN
  CREATE POLICY enabled_admin ON catalog.domestic_review_decision FOR ALL
   USING (current_user <> 'ice_p0_02_owner' AND catalog.is_admin())
   WITH CHECK (current_user <> 'ice_p0_02_owner' AND catalog.is_admin());
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname='catalog' AND tablename='domestic_review_decision' AND policyname='inventory_definer_owner'
 ) THEN
  CREATE POLICY inventory_definer_owner ON catalog.domestic_review_decision FOR ALL
   USING (current_user='ice_p0_02_owner')
   WITH CHECK (current_user='ice_p0_02_owner');
 END IF;
END $$;

REVOKE ALL ON TABLE catalog.domestic_review_decision
 FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;

-- ---------------------------------------------------------------------------
-- 2. 应用一条复核决定（单行一请求，返回稳定回执）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.apply_domestic_review_decision(
 p_request uuid,p_intent text,p_decision jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_actor uuid; v_prior jsonb; v_result jsonb; v_applied integer:=0; v_existing boolean:=false;
 v_dataset text; v_row_id text; v_cand text; v_obs uuid; v_item uuid;
 v_file text; v_sheet text; v_row_text text; v_excel integer; v_sku text;
 v_obs_cand text; v_obs_state text; v_obs_row text; v_obs_sheet text; v_obs_sku text;
 v_prev_item uuid; v_existing_obs uuid; v_existing_item uuid;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_request IS NULL OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'DOMESTIC_REVIEW_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 v_prior:=catalog.inventory_request_prior(p_request,p_intent,'apply_domestic_review_decision',
  jsonb_build_object('decision',p_decision));
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_decision IS NULL OR jsonb_typeof(p_decision)<>'object' THEN
  RAISE EXCEPTION 'DOMESTIC_REVIEW_INVALID' USING ERRCODE='22023'; END IF;
 v_dataset:=btrim(coalesce(p_decision->>'datasetSha256',''));
 v_row_id:=btrim(coalesce(p_decision->>'sourceRowId',''));
 v_cand:=btrim(coalesce(p_decision->>'legacyCandidateId',''));
 v_file:=btrim(coalesce(p_decision->>'sourceFile',''));
 v_sheet:=nullif(btrim(coalesce(p_decision->>'sourceSheet','')),'');
 v_row_text:=nullif(btrim(coalesce(p_decision->>'sourceExcelRow','')),'');
 v_sku:=btrim(coalesce(p_decision->>'sourceSku',''));
 IF v_dataset!~'^[a-f0-9]{64}$' OR v_row_id='' OR v_cand='' OR v_file='' OR v_sku=''
  OR (v_row_text IS NOT NULL AND v_row_text!~'^[0-9]+$')
  OR lower(coalesce(p_decision->>'reviewState',''))<>'manual_selected' THEN
  RAISE EXCEPTION 'DOMESTIC_REVIEW_INVALID' USING ERRCODE='22023'; END IF;
 v_excel:=CASE WHEN v_row_text IS NULL THEN NULL ELSE v_row_text::integer END;
 BEGIN v_obs:=(p_decision->>'observationId')::uuid;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'DOMESTIC_REVIEW_INVALID:observationId' USING ERRCODE='22023'; END;
 BEGIN v_item:=(p_decision->>'itemId')::uuid;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'DOMESTIC_REVIEW_INVALID:itemId' USING ERRCODE='22023'; END;
 PERFORM pg_advisory_xact_lock(hashtextextended('domestic.review:'||v_dataset||':'||v_row_id,946));

 -- 来源身份按库内冻结观察核对：候选 ID / 工作表 / 原表行 / 原 SKU 必须一致，不能只信客户端。
 SELECT o.legacy_candidate_id,o.review_state,o.position->>'row',o.position->>'sheet',
  o.fields->'sku'->>'raw'
 INTO v_obs_cand,v_obs_state,v_obs_row,v_obs_sheet,v_obs_sku
 FROM catalog.source_observation o WHERE o.id=v_obs;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOMESTIC_REVIEW_OBSERVATION_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_obs_cand IS DISTINCT FROM v_cand
  OR v_obs_sku IS DISTINCT FROM v_sku
  OR (v_excel IS NOT NULL AND v_obs_row IS DISTINCT FROM v_excel::text)
  OR (v_sheet IS NOT NULL AND v_obs_sheet IS DISTINCT FROM v_sheet) THEN
  RAISE EXCEPTION 'DOMESTIC_REVIEW_SOURCE_MISMATCH' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.catalog_item i WHERE i.id=v_item) THEN
  RAISE EXCEPTION 'DOMESTIC_REVIEW_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;

 -- 前值取当前库（observation 状态 + 现行 candidate_snapshot 决定），由服务端记录，不覆盖旧历史行。
 SELECT d.selected_item_id INTO v_prev_item
 FROM catalog.decision_evidence d
 WHERE d.observation_id=v_obs AND d.entry_kind='candidate_snapshot'
 ORDER BY d.id LIMIT 1;

 INSERT INTO catalog.domestic_review_decision(dataset_sha256,source_row_id,source_observation_id,
  legacy_candidate_id,previous_review_state,previous_item_id,review_state,item_id,
  source_file,source_sheet,source_excel_row,source_sku,request_id,actor_id)
 VALUES(v_dataset,v_row_id,v_obs,v_cand,v_obs_state,v_prev_item,'manual_selected',v_item,
  v_file,v_sheet,v_excel,v_sku,p_request,v_actor)
 ON CONFLICT(dataset_sha256,source_row_id) DO NOTHING;
 GET DIAGNOSTICS v_applied = ROW_COUNT;
 IF v_applied=0 THEN
  -- 同一文件同一来源行重复提交：内容一致才算幂等，内容不同明确冲突，不写新版本。
  SELECT r.source_observation_id,r.item_id INTO v_existing_obs,v_existing_item
  FROM catalog.domestic_review_decision r
  WHERE r.dataset_sha256=v_dataset AND r.source_row_id=v_row_id;
  IF v_existing_obs IS DISTINCT FROM v_obs OR v_existing_item IS DISTINCT FROM v_item THEN
   RAISE EXCEPTION 'DOMESTIC_REVIEW_CONFLICT' USING ERRCODE='23505'; END IF;
  v_existing:=true;
 END IF;

 v_result:=jsonb_build_object(
  'ok',true,'applied',v_applied,'existing',v_existing,
  'datasetId',v_dataset,'sourceRowId',v_row_id,'observationId',v_obs,
  'legacyCandidateId',v_cand,'previousReviewState',v_obs_state,'previousItemId',v_prev_item,
  'reviewState','manual_selected','itemId',v_item,'effectiveAt','immediate');
 PERFORM catalog.inventory_audit_write(v_actor,'apply_domestic_review_decision',v_row_id,
  v_result - 'ok');
 PERFORM catalog.inventory_record_request(p_request,p_intent,'apply_domestic_review_decision',
  jsonb_build_object('decision',p_decision),NULL,v_result,v_actor);
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 3. 国内读链：023 之上优先最新复核决定（输出字段形状不变）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_inventory_domestic_links() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM catalog.require_admin();
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'legacyCandidateId', x.legacy_candidate_id,
   'reviewState', x.review_state,
   'sourceSku', x.source_sku,
   'sourceName', x.source_name,
   'sheet', x.sheet,
   'excelRow', x.excel_row,
   'itemId', x.item_id,
   'iceCode', x.ice_code,
   'itemNameCn', x.item_name_cn
  ) ORDER BY x.legacy_candidate_id),'[]'::jsonb) INTO result
 FROM (
  SELECT DISTINCT ON (o.legacy_candidate_id)
   o.legacy_candidate_id,
   coalesce(r.review_state,o.review_state) AS review_state,
   o.fields->'sku'->>'raw' AS source_sku,
   o.fields->'name'->>'raw' AS source_name,
   o.position->>'sheet' AS sheet,
   CASE WHEN (o.position->>'row') ~ '^[0-9]+$' THEN (o.position->>'row')::integer END AS excel_row,
   coalesce(r.item_id,d.selected_item_id) AS item_id,
   v.ice_code_snapshot AS ice_code,
   v.name_cn AS item_name_cn
  FROM catalog.source_observation o
  JOIN catalog.observation_batch b ON b.id=o.batch_id
  LEFT JOIN catalog.decision_evidence d
   ON d.observation_id=o.id AND d.entry_kind='candidate_snapshot'
  -- 最新一条本次复核决定优先；没有决定时完全沿用 023 的冻结选择。
  LEFT JOIN LATERAL (
   SELECT dr.id,dr.review_state,dr.item_id
   FROM catalog.domestic_review_decision dr
   WHERE dr.source_observation_id=o.id
   ORDER BY dr.recorded_at DESC,dr.id DESC
   LIMIT 1
  ) r ON true
  LEFT JOIN catalog.item_current c ON c.item_id=coalesce(r.item_id,d.selected_item_id)
  LEFT JOIN catalog.item_revision v ON v.item_id=c.item_id AND v.revision=c.revision
  WHERE o.position->>'sourceRowKey' LIKE 'jushuitan:%'
   AND o.legacy_candidate_id IS NOT NULL
  ORDER BY o.legacy_candidate_id, (r.id IS NOT NULL) DESC, b.recorded_at DESC, o.id
 ) x;
 RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- 4. 权限：仅函数可写；app runner 只能执行这两个函数
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.apply_domestic_review_decision(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.apply_domestic_review_decision(uuid,text,jsonb) TO ice_p0_02_app_runner;
REVOKE ALL ON FUNCTION catalog.read_inventory_domestic_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_inventory_domestic_links() TO ice_p0_02_app_runner;

RESET ROLE;
