-- 036: 飞书商品资料人工核对与持续采用流程（幂等增量）
--
-- 目标（2026-11-10 用户决定）：
--   1) 跨批待办去重：新批次应用后，已解决的事项自动退出当前待办；仍存在的只保留
--      一条 open（旧事项标 superseded 归并），历史行全部保留。
--   2) 字段级“暂不处理/人工口径”：按商品 + 字段登记，后续批次不再催办、保留现值，
--      可恢复（revoke 后下次读取重新提示）。不扩大到整商品或同类字段。
--   3) 同号多行人工选择：保存“以哪一来源行为准”的决定，按内容指纹（不含行号）沿用；
--      行号变化不失效；来源出现新的实质差异时重新提示。
--   4) 缺货号待确认：可挂在不依赖来源行的 item 级事项上，原表行删除后仍保留；
--      人工补正式货号后关闭；禁止 TEST- 测试码。
--   5) 受控纠正历史测试货号 TEST-PG-NEW122-0：保留商品 UUID、真实修订历史与在途关联，
--      删除测试码后恢复“货号待确认”，不新建商品。
--
-- 本文件只新增/替换函数与追加表/列，不改 015 原文件；重复执行幂等。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 事项表扩展：scope（batch=按批次评估 / item=商品级耐久）+ superseded 状态
-- ---------------------------------------------------------------------------
ALTER TABLE catalog.product_source_issue
 ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'batch',
 ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES catalog.product_source_issue ON DELETE RESTRICT,
 ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

UPDATE catalog.product_source_issue SET scope='batch' WHERE scope IS NULL;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='product_source_issue_scope_check'
   AND conrelid='catalog.product_source_issue'::regclass) THEN
  ALTER TABLE catalog.product_source_issue DROP CONSTRAINT product_source_issue_scope_check;
 END IF;
 ALTER TABLE catalog.product_source_issue ADD CONSTRAINT product_source_issue_scope_check
  CHECK(scope IN('batch','item'));
END $$;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='product_source_issue_review_state_check'
   AND conrelid='catalog.product_source_issue'::regclass) THEN
  ALTER TABLE catalog.product_source_issue DROP CONSTRAINT product_source_issue_review_state_check;
 END IF;
 ALTER TABLE catalog.product_source_issue ADD CONSTRAINT product_source_issue_review_state_check
  CHECK(review_state IN('open','resolved','ignored','superseded'));
END $$;

CREATE INDEX IF NOT EXISTS product_source_issue_scope_open
 ON catalog.product_source_issue(scope,opened_at DESC) WHERE review_state='open';

-- ---------------------------------------------------------------------------
-- 2. 字段级人工决定（暂不处理 / 人工口径采用）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog.product_source_field_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES catalog.product_source_profile ON DELETE RESTRICT,
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 ice_code text,
 field_key text NOT NULL CHECK(length(btrim(field_key))>0 AND length(field_key)<=60),
 action text NOT NULL CHECK(action IN('defer','override')),
 value_raw text CHECK(value_raw IS NULL OR length(value_raw)<=200),
 reason text NOT NULL CHECK(length(btrim(reason))>0 AND length(reason)<=500),
 note text CHECK(note IS NULL OR length(note)<=1000),
 state text NOT NULL DEFAULT 'active' CHECK(state IN('active','revoked','superseded')),
 source_issue_id uuid REFERENCES catalog.product_source_issue ON DELETE RESTRICT,
 request_id uuid,
 decided_by uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 decided_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoked_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 revoked_note text,
 superseded_at timestamptz,
 CHECK(action<>'override' OR value_raw IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_source_field_decision_active
 ON catalog.product_source_field_decision(profile_id,item_id,field_key) WHERE state='active';
CREATE INDEX IF NOT EXISTS product_source_field_decision_item
 ON catalog.product_source_field_decision(item_id,field_key);
ALTER TABLE catalog.product_source_field_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.product_source_field_decision FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='catalog'
   AND tablename='product_source_field_decision' AND policyname='enabled_admin') THEN
  CREATE POLICY enabled_admin ON catalog.product_source_field_decision
   FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin());
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. 同号多行人工选择（按来源内容指纹沿用，不按行号）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog.product_source_duplicate_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES catalog.product_source_profile ON DELETE RESTRICT,
 ice_code text NOT NULL CHECK(length(btrim(ice_code))>0 AND length(ice_code)<=50),
 item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 chosen_row_number integer CHECK(chosen_row_number IS NULL OR chosen_row_number>0),
 chosen_row_sha256 char(64) NOT NULL CHECK(chosen_row_sha256 ~ '^[a-f0-9]{64}$'),
 basis_sha256 char(64) NOT NULL CHECK(basis_sha256 ~ '^[a-f0-9]{64}$'),
 evidence_row_sha256 char(64) CHECK(evidence_row_sha256 IS NULL OR evidence_row_sha256 ~ '^[a-f0-9]{64}$'),
 chosen_fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(chosen_fields)='object'),
 comparison jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(comparison)='object'),
 state text NOT NULL DEFAULT 'active' CHECK(state IN('active','superseded')),
 source_issue_id uuid REFERENCES catalog.product_source_issue ON DELETE RESTRICT,
 request_id uuid,
 decided_by uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 decided_at timestamptz NOT NULL DEFAULT now(),
 note text CHECK(note IS NULL OR length(note)<=1000),
 superseded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS product_source_duplicate_decision_active
 ON catalog.product_source_duplicate_decision(profile_id,ice_code) WHERE state='active';
CREATE INDEX IF NOT EXISTS product_source_duplicate_decision_item
 ON catalog.product_source_duplicate_decision(item_id);
ALTER TABLE catalog.product_source_duplicate_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.product_source_duplicate_decision FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='catalog'
   AND tablename='product_source_duplicate_decision' AND policyname='enabled_admin') THEN
  CREATE POLICY enabled_admin ON catalog.product_source_duplicate_decision
   FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin());
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. 受控测试货号纠正证据（私有，只读凭据留痕）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_private.item_code_correction (
 request_id uuid PRIMARY KEY,
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 old_code text NOT NULL,
 reason text NOT NULL,
 note text,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE catalog_private.item_code_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_private.item_code_correction FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='catalog_private'
   AND tablename='item_code_correction' AND policyname='enabled_admin') THEN
  CREATE POLICY enabled_admin ON catalog_private.item_code_correction
   FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin());
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='immutable_history'
   AND tgrelid='catalog_private.item_code_correction'::regclass) THEN
  CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog_private.item_code_correction
   FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation();
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. 请求动作白名单扩展
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='product_source_request_action_check'
   AND conrelid='catalog.product_source_request'::regclass) THEN
  ALTER TABLE catalog.product_source_request DROP CONSTRAINT product_source_request_action_check;
 END IF;
 ALTER TABLE catalog.product_source_request ADD CONSTRAINT product_source_request_action_check
  CHECK(action IN('apply_product_source_batch','resolve_source_issue','assign_source_code',
   'defer_source_field','override_source_field','restore_source_field',
   'decide_duplicate_source_row','restore_duplicate_source_decision','correct_test_source_code'));
END $$;

-- ---------------------------------------------------------------------------
-- 6. 事项稳定键（跨批去重；行号不参与）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.product_source_issue_key(p_kind text,p_source_key text,
 p_item_id uuid,p_detail jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE
  WHEN coalesce(p_detail,'{}'::jsonb) ? 'fieldKey' AND p_item_id IS NOT NULL
   THEN 'field:'||p_item_id::text||':'||(p_detail->>'fieldKey')
  WHEN p_kind IN('missing_code','missing_code_candidate') AND p_item_id IS NOT NULL
   THEN 'missing-item:'||p_item_id::text
  WHEN p_kind IN('missing_code','missing_code_candidate')
   THEN 'missing-name:'||lower(btrim(coalesce(p_detail->>'nameCn','')))
  WHEN p_kind IN('duplicate_code_inconsistent','suspected_code_change')
   THEN 'code:'||coalesce(nullif(p_detail->>'code',''),nullif(p_source_key,''),'')
  ELSE coalesce(p_source_key,'')
 END
$$;

-- ---------------------------------------------------------------------------
-- 7. 跨批事项对账：历史保留；同一问题只保留一个新批次 open
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.reconcile_product_source_issues(p_profile uuid,p_batch uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_batch catalog.product_source_batch; v_retry boolean; v_new_ignored integer:=0;
 v_superseded integer:=0; v_ignored integer:=0; v_resolved integer:=0; v_kept integer:=0;
 v_new_id uuid; v_key text; v_has_result boolean; v_def catalog.product_source_field_decision;
 v_dup catalog.product_source_duplicate_decision; r record;
BEGIN
 IF p_profile IS NULL OR p_batch IS NULL THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_batch FROM catalog.product_source_batch WHERE id=p_batch AND profile_id=p_profile;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('skipped',true,'reason','BATCH_NOT_FOUND');
 END IF;
 -- 整批读取/校验失败时，不把无法判断的旧事项当成已解决。
 IF EXISTS(SELECT 1 FROM catalog.product_source_result res
   WHERE res.batch_id=p_batch AND res.source_key='batch' AND res.classification='failed') THEN
  RETURN jsonb_build_object('skipped',true,'reason','BATCH_FAILED');
 END IF;
 v_retry:=v_batch.retry_of_batch_id IS NOT NULL;

 -- 7.1 新批次事项若命中已登记的人工决定，直接按决定落位（防御性；计划层通常已抑制）。
 FOR r IN SELECT i.* FROM catalog.product_source_issue i
   WHERE i.batch_id=p_batch AND i.review_state='open' AND i.scope='batch' LOOP
  IF r.item_id IS NOT NULL AND (r.detail ? 'fieldKey') THEN
   SELECT * INTO v_def FROM catalog.product_source_field_decision d
    WHERE d.profile_id=p_profile AND d.item_id=r.item_id
     AND d.field_key=(r.detail->>'fieldKey') AND d.action='defer' AND d.state='active';
   IF FOUND THEN
    UPDATE catalog.product_source_issue SET review_state='ignored',resolved_at=now(),
     resolution_note='已登记暂不处理该字段，后续批次不再催办'
     WHERE id=r.id;
    v_new_ignored:=v_new_ignored+1;
    CONTINUE;
   END IF;
  END IF;
 END LOOP;

 -- 7.2 旧批次 open 事项：仍存在→归并到新事项；已解决→自动退出；无法判断→保留。
 FOR r IN SELECT i.* FROM catalog.product_source_issue i
   JOIN catalog.product_source_batch b ON b.id=i.batch_id
   WHERE b.profile_id=p_profile AND i.batch_id<>p_batch
    AND i.review_state='open' AND i.scope='batch'
   ORDER BY i.opened_at,i.id LOOP
  -- 字段级人工决定优先。
  IF r.item_id IS NOT NULL AND (r.detail ? 'fieldKey') THEN
   SELECT * INTO v_def FROM catalog.product_source_field_decision d
    WHERE d.profile_id=p_profile AND d.item_id=r.item_id
     AND d.field_key=(r.detail->>'fieldKey') AND d.action='defer' AND d.state='active';
   IF FOUND THEN
    UPDATE catalog.product_source_issue SET review_state='ignored',resolved_at=now(),
     resolution_note='已登记暂不处理该字段，后续批次不再催办' WHERE id=r.id;
    v_ignored:=v_ignored+1;
    CONTINUE;
   END IF;
  END IF;
  -- 同号多行人工选择优先。
  IF r.issue_kind='duplicate_code_inconsistent' AND r.source_key LIKE 'code:%' THEN
   SELECT * INTO v_dup FROM catalog.product_source_duplicate_decision d
    WHERE d.profile_id=p_profile AND d.ice_code=split_part(r.source_key,':',2) AND d.state='active';
   IF FOUND THEN
    UPDATE catalog.product_source_issue SET review_state='resolved',resolved_at=now(),
     resolution_note='已按人工选择以指定来源行为准' WHERE id=r.id;
    v_resolved:=v_resolved+1;
    CONTINUE;
   END IF;
  END IF;

  v_key:=catalog.product_source_issue_key(r.issue_kind,r.source_key,r.item_id,r.detail);
  SELECT i.id INTO v_new_id FROM catalog.product_source_issue i
   WHERE i.batch_id=p_batch AND i.review_state='open' AND i.scope='batch'
    AND catalog.product_source_issue_key(i.issue_kind,i.source_key,i.item_id,i.detail)=v_key
   ORDER BY i.opened_at LIMIT 1;
  IF v_new_id IS NOT NULL THEN
   UPDATE catalog.product_source_issue SET review_state='superseded',superseded_by=v_new_id,
    superseded_at=now(),resolution_note='新批次仍存在同一问题，已归并到新批次事项（历史保留）'
    WHERE id=r.id;
   v_superseded:=v_superseded+1;
   CONTINUE;
  END IF;

  SELECT EXISTS(SELECT 1 FROM catalog.product_source_result res
    WHERE res.batch_id=p_batch AND res.classification<>'failed'
     AND (res.source_key=r.source_key
      OR (r.item_id IS NOT NULL AND res.item_id=r.item_id))) INTO v_has_result;
  IF v_has_result THEN
   UPDATE catalog.product_source_issue SET review_state='superseded',superseded_at=now(),
    resolution_note='新批次未再出现该问题，已自动退出当前待办（历史保留）' WHERE id=r.id;
   v_superseded:=v_superseded+1;
  ELSIF NOT v_retry AND r.source_key LIKE 'row:%' AND r.item_id IS NULL THEN
   -- 缺码来源行已不存在；商品级“货号待确认”事项由 item 级事项继续承载。
   UPDATE catalog.product_source_issue SET review_state='superseded',superseded_at=now(),
    resolution_note='来源行已不存在，已自动退出当前待办（历史保留）' WHERE id=r.id;
   v_superseded:=v_superseded+1;
  ELSE
   v_kept:=v_kept+1;
  END IF;
 END LOOP;

 RETURN jsonb_build_object('skipped',false,'superseded',v_superseded,'ignored',v_ignored,
  'resolved',v_resolved,'newIgnored',v_new_ignored,'kept',v_kept);
END $$;

-- ---------------------------------------------------------------------------
-- 8. 应用本批 v2：先执行原应用，再对账事项（同一事务）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.apply_product_source_batch_v2(p_request uuid,p_intent text,
 p_profile jsonb,p_batch jsonb,p_plan jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb; v_batch_id uuid; v_profile_id uuid; v_reconcile jsonb;
BEGIN
 v_result:=catalog.apply_product_source_batch(p_request,p_intent,p_profile,p_batch,p_plan);
 IF v_result ? 'batchId' AND (v_result->>'status') IN('applied','partial') THEN
  v_batch_id:=(v_result->>'batchId')::uuid;
  SELECT b.profile_id INTO v_profile_id FROM catalog.product_source_batch b WHERE b.id=v_batch_id;
  IF v_profile_id IS NOT NULL THEN
   v_reconcile:=catalog.reconcile_product_source_issues(v_profile_id,v_batch_id);
   v_result:=v_result||jsonb_build_object('reconciled',v_reconcile);
  END IF;
 END IF;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 9. 字段级人工决定：登记（defer / override，登记后关闭当前同类事项）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.set_product_source_field_decision(p_request uuid,p_intent text,
 p_issue uuid,p_action text,p_value text,p_reason text,p_note text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_issue catalog.product_source_issue; v_profile_id uuid;
 v_field text; v_code text; v_decision catalog.product_source_field_decision; v_closed integer:=0;
 v_result jsonb; v_reason text; v_note text;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,
  CASE WHEN p_action='defer' THEN 'defer_source_field' ELSE 'override_source_field' END);
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_issue IS NULL OR p_action IS NULL OR p_action NOT IN('defer','override') THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 v_reason:=nullif(btrim(coalesce(p_reason,'')),'');
 v_note:=nullif(btrim(coalesce(p_note,'')),'');
 IF v_reason IS NULL OR length(v_reason)>500 OR (v_note IS NOT NULL AND length(v_note)>1000) THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_issue FROM catalog.product_source_issue WHERE id=p_issue FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_issue.review_state<>'open' THEN RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_OPEN' USING ERRCODE='22023'; END IF;
 IF v_issue.item_id IS NULL THEN RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_ITEM' USING ERRCODE='22023'; END IF;
 v_field:=nullif(v_issue.detail->>'fieldKey','');
 IF v_field IS NULL AND jsonb_typeof(v_issue.detail->'fieldKeys')='array'
  AND jsonb_array_length(v_issue.detail->'fieldKeys')=1 THEN
  v_field:=v_issue.detail->'fieldKeys'->>0;
 END IF;
 IF v_field IS NULL OR NOT(v_field=ANY(catalog.product_source_field_keys())) THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_INVALID' USING ERRCODE='22023'; END IF;
 IF p_action='override' THEN
  IF p_value IS NULL OR length(btrim(p_value))=0 OR length(p_value)>200 THEN
   RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_VALUE_INVALID' USING ERRCODE='22023'; END IF;
 ELSE
  p_value:=NULL;
 END IF;
 SELECT b.profile_id INTO v_profile_id FROM catalog.product_source_batch b WHERE b.id=v_issue.batch_id;
 IF v_profile_id IS NULL THEN RAISE EXCEPTION 'CATALOG_SOURCE_PROFILE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT c.ice_code INTO v_code FROM catalog.catalog_item_code c WHERE c.item_id=v_issue.item_id;
 -- 一个商品+字段同时只有一个生效决定。
 SELECT * INTO v_decision FROM catalog.product_source_field_decision d
  WHERE d.profile_id=v_profile_id AND d.item_id=v_issue.item_id AND d.field_key=v_field
   AND d.state='active' FOR UPDATE;
 IF FOUND THEN
  UPDATE catalog.product_source_field_decision SET state='superseded',superseded_at=now()
   WHERE id=v_decision.id;
 END IF;
 INSERT INTO catalog.product_source_field_decision(profile_id,item_id,ice_code,field_key,action,
  value_raw,reason,note,state,source_issue_id,request_id,decided_by)
 VALUES(v_profile_id,v_issue.item_id,v_code,v_field,p_action,
  CASE WHEN p_action='override' THEN btrim(p_value) ELSE NULL END,
  v_reason,v_note,'active',v_issue.id,p_request,v_actor)
 RETURNING * INTO v_decision;
 UPDATE catalog.product_source_issue i SET
  review_state=CASE WHEN p_action='defer' THEN 'ignored' ELSE 'resolved' END,
  resolved_at=now(),resolved_by=v_actor,
  resolution_note=CASE WHEN p_action='defer'
   THEN '已登记暂不处理该字段，后续批次不再催办'
   ELSE '已登记人工口径并关闭本条事项' END
  WHERE i.item_id=v_issue.item_id AND i.review_state='open'
   AND i.issue_kind IN('invalid_value','formula_error','invalid_carton_quantity','unit_unconfirmed')
   AND i.batch_id IN(SELECT b.id FROM catalog.product_source_batch b WHERE b.profile_id=v_profile_id)
   AND coalesce(i.detail->>'fieldKey',
    CASE WHEN jsonb_typeof(i.detail->'fieldKeys')='array'
      AND jsonb_array_length(i.detail->'fieldKeys')=1
     THEN i.detail->'fieldKeys'->>0 END)=v_field;
 GET DIAGNOSTICS v_closed=ROW_COUNT;
 v_result:=jsonb_build_object('decisionId',v_decision.id,'action',v_decision.action,
  'itemId',v_decision.item_id,'fieldKey',v_decision.field_key,'valueRaw',v_decision.value_raw,
  'state','active','closedIssues',v_closed);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,
  CASE WHEN p_action='defer' THEN 'defer_source_field' ELSE 'override_source_field' END,
  v_issue.item_id,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,
  CASE WHEN p_action='defer' THEN 'defer_source_field' ELSE 'override_source_field' END,
  p_intent,v_issue.batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION catalog.revoke_product_source_field_decision(p_request uuid,p_intent text,
 p_decision uuid,p_note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_decision catalog.product_source_field_decision;
 v_profile_id uuid; v_batch_id uuid; v_result jsonb; v_note text;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'restore_source_field');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_decision IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 v_note:=nullif(btrim(coalesce(p_note,'')),'');
 IF v_note IS NOT NULL AND length(v_note)>1000 THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_decision FROM catalog.product_source_field_decision WHERE id=p_decision FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_DECISION_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_decision.state<>'active' THEN RAISE EXCEPTION 'CATALOG_SOURCE_DECISION_NOT_ACTIVE' USING ERRCODE='22023'; END IF;
 UPDATE catalog.product_source_field_decision SET state='revoked',revoked_at=now(),
  revoked_by=v_actor,revoked_note=v_note WHERE id=p_decision;
 v_profile_id:=v_decision.profile_id;
 SELECT b.id INTO v_batch_id FROM catalog.product_source_batch b
  WHERE b.profile_id=v_profile_id AND b.status IN('applied','partial')
  ORDER BY b.captured_at DESC,b.received_at DESC LIMIT 1;
 v_result:=jsonb_build_object('decisionId',v_decision.id,'action',v_decision.action,
  'itemId',v_decision.item_id,'fieldKey',v_decision.field_key,'state','revoked');
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'restore_source_field',v_decision.item_id,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'restore_source_field',p_intent,v_batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 10. 同号多行人工选择：保存选择并关闭当前事项
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.decide_product_source_duplicate_row(p_request uuid,p_intent text,
 p_issue uuid,p_chosen_row_number integer,p_chosen_row_sha256 text,p_basis_sha256 text,
 p_evidence_row_sha256 text,p_note text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_issue catalog.product_source_issue;
 v_row catalog.product_source_row; v_profile_id uuid; v_code text; v_decision catalog.product_source_duplicate_decision;
 v_result jsonb; v_note text; v_exists boolean;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'decide_duplicate_source_row');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_issue IS NULL OR p_chosen_row_number IS NULL OR p_chosen_row_number<=0
  OR coalesce(p_chosen_row_sha256,'')!~'^[a-f0-9]{64}$'
  OR coalesce(p_basis_sha256,'')!~'^[a-f0-9]{64}$'
  OR (p_evidence_row_sha256 IS NOT NULL AND p_evidence_row_sha256!~'^[a-f0-9]{64}$') THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 v_note:=nullif(btrim(coalesce(p_note,'')),'');
 IF v_note IS NOT NULL AND length(v_note)>1000 THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_issue FROM catalog.product_source_issue WHERE id=p_issue FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_issue.review_state<>'open' THEN RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_OPEN' USING ERRCODE='22023'; END IF;
 IF v_issue.issue_kind<>'duplicate_code_inconsistent' OR v_issue.source_key NOT LIKE 'code:%' THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_DUPLICATE' USING ERRCODE='22023'; END IF;
 v_code:=split_part(v_issue.source_key,':',2);
 IF v_code IS NULL OR length(btrim(v_code))=0 THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_ISSUE_NOT_DUPLICATE' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM catalog.product_source_row r
  WHERE r.batch_id=v_issue.batch_id AND r.row_number=p_chosen_row_number
   AND r.is_empty=false AND r.ice_code_raw=v_code;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_ROW_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF p_evidence_row_sha256 IS NOT NULL AND v_row.row_sha256 IS NOT NULL
  AND p_evidence_row_sha256<>v_row.row_sha256 THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_ROW_CHANGED' USING ERRCODE='40001'; END IF;
 SELECT b.profile_id INTO v_profile_id FROM catalog.product_source_batch b WHERE b.id=v_issue.batch_id;
 SELECT EXISTS(SELECT 1 FROM catalog.product_source_duplicate_decision d
  WHERE d.profile_id=v_profile_id AND d.ice_code=v_code AND d.state='active') INTO v_exists;
 IF v_exists THEN
  UPDATE catalog.product_source_duplicate_decision SET state='superseded',superseded_at=now()
   WHERE profile_id=v_profile_id AND ice_code=v_code AND state='active';
 END IF;
 INSERT INTO catalog.product_source_duplicate_decision(profile_id,ice_code,item_id,
  chosen_row_number,chosen_row_sha256,basis_sha256,evidence_row_sha256,chosen_fields,comparison,
  state,source_issue_id,request_id,decided_by,note)
 VALUES(v_profile_id,v_code,v_issue.item_id,p_chosen_row_number,p_chosen_row_sha256,p_basis_sha256,
  p_evidence_row_sha256,coalesce(v_row.fields,'{}'::jsonb),coalesce(v_issue.detail,'{}'::jsonb),
  'active',v_issue.id,p_request,v_actor,v_note)
 RETURNING * INTO v_decision;
 UPDATE catalog.product_source_issue SET review_state='resolved',resolved_at=now(),
  resolved_by=v_actor,resolution_note='已人工选择以来源第 '||p_chosen_row_number||' 行为准'
  WHERE id=v_issue.id;
 v_result:=jsonb_build_object('decisionId',v_decision.id,'iceCode',v_code,
  'itemId',v_issue.item_id,'chosenRowNumber',p_chosen_row_number,'state','active');
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'decide_duplicate_source_row',v_issue.item_id,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'decide_duplicate_source_row',p_intent,v_issue.batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION catalog.revoke_product_source_duplicate_decision(p_request uuid,p_intent text,
 p_decision uuid,p_note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_decision catalog.product_source_duplicate_decision;
 v_batch_id uuid; v_result jsonb; v_note text;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'restore_duplicate_source_decision');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_decision IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 v_note:=nullif(btrim(coalesce(p_note,'')),'');
 IF v_note IS NOT NULL AND length(v_note)>1000 THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_decision FROM catalog.product_source_duplicate_decision WHERE id=p_decision FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_DECISION_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_decision.state<>'active' THEN RAISE EXCEPTION 'CATALOG_SOURCE_DECISION_NOT_ACTIVE' USING ERRCODE='22023'; END IF;
 UPDATE catalog.product_source_duplicate_decision SET state='superseded',superseded_at=now(),
  note=coalesce(v_note,note) WHERE id=p_decision;
 SELECT b.id INTO v_batch_id FROM catalog.product_source_batch b
  WHERE b.profile_id=v_decision.profile_id AND b.status IN('applied','partial')
  ORDER BY b.captured_at DESC,b.received_at DESC LIMIT 1;
 v_result:=jsonb_build_object('decisionId',v_decision.id,'iceCode',v_decision.ice_code,
  'itemId',v_decision.item_id,'state','superseded');
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'restore_duplicate_source_decision',v_decision.item_id,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_decision.profile_id,'restore_duplicate_source_decision',p_intent,v_batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 11. 人工补正式货号：关闭 item 级“货号待确认”事项；禁止 TEST- 测试码
--     （完整替换 015 的同签名函数，其余行为保持一致）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.assign_product_source_code(p_request uuid,p_intent text,p_item uuid,p_expected integer,
 p_code text,p_reason text,p_evidence text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_cur catalog.item_current; v_prev catalog.item_revision;
 v_profile_id uuid; v_batch_id uuid; v_row catalog.product_source_row; v_result jsonb; v_rev integer;
 v_closed integer:=0;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'assign_source_code');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_item IS NULL OR p_expected IS NULL OR p_expected<=0 OR p_code IS NULL OR length(p_code)>50
  OR length(btrim(p_code))=0 OR btrim(p_code)<>p_code
  OR p_reason IS NULL OR length(btrim(p_reason))=0 OR length(p_reason)>1000
  OR p_evidence IS NULL OR length(btrim(p_evidence))=0 OR length(p_evidence)>500 THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 IF upper(p_code) LIKE 'TEST-%' THEN
  RAISE EXCEPTION 'CATALOG_CODE_INVALID' USING ERRCODE='22023'; END IF;
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
 UPDATE catalog.product_source_issue SET review_state='resolved',resolved_at=now(),
  resolved_by=v_actor,resolution_note='已人工补录正式货号 '||p_code
  WHERE item_id=p_item AND review_state='open' AND scope='item'
   AND issue_kind IN('missing_code','missing_code_candidate');
 GET DIAGNOSTICS v_closed=ROW_COUNT;
 v_result:=jsonb_build_object('itemId',p_item,'revision',v_rev,'iceCode',p_code,
  'batchId',v_batch_id,'closedPendingIssues',v_closed);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'assign_source_code',p_item,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'assign_source_code',p_intent,v_batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 12. 受控纠正历史测试货号（只用于已核清的测试修订；保留 UUID/历史/在途）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.correct_test_product_code(p_request uuid,p_intent text,
 p_item uuid,p_test_code text,p_note text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_code catalog.catalog_item_code; v_cur catalog.item_current;
 v_prev catalog.item_revision; v_profile_id uuid; v_batch catalog.product_source_batch;
 v_rev integer; v_issue_id uuid; v_result jsonb; v_note text;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'correct_test_source_code');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 IF p_item IS NULL OR p_test_code IS NULL OR length(btrim(p_test_code))=0
  OR length(p_test_code)>50 OR p_test_code<>btrim(p_test_code) THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 IF upper(p_test_code) NOT LIKE 'TEST-%' THEN
  RAISE EXCEPTION 'CATALOG_CODE_NOT_TEST' USING ERRCODE='22023'; END IF;
 v_note:=nullif(btrim(coalesce(p_note,'')),'');
 IF v_note IS NOT NULL AND length(v_note)>1000 THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_code FROM catalog.catalog_item_code WHERE item_id=p_item AND ice_code=p_test_code;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_CODE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_cur FROM catalog.item_current WHERE item_id=p_item FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_prev FROM catalog.item_revision WHERE item_id=p_item AND revision=v_cur.revision;
 SELECT p.id INTO v_profile_id FROM catalog.product_source_profile p
  WHERE p.profile_key='feishu.ice-product-library.sheet1';
 IF v_profile_id IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT:profile' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_batch FROM catalog.product_source_batch b
  WHERE b.profile_id=v_profile_id AND b.status IN('applied','partial')
  ORDER BY b.captured_at DESC,b.received_at DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_BATCH_NOT_FOUND' USING ERRCODE='22023'; END IF;
 -- 历史修订不重写；只移除当前测试码并追加一条“货号待确认”修订。
 LOCK TABLE catalog.catalog_item_code IN ACCESS EXCLUSIVE MODE;
 ALTER TABLE catalog.catalog_item_code DISABLE TRIGGER immutable_history;
 DELETE FROM catalog.catalog_item_code WHERE item_id=p_item AND ice_code=p_test_code;
 ALTER TABLE catalog.catalog_item_code ENABLE TRIGGER immutable_history;
 INSERT INTO catalog_private.item_code_correction(request_id,item_id,old_code,reason,note,actor_id)
 VALUES(p_request,p_item,p_test_code,'TEST_CODE_RETIRED',v_note,v_actor);
 v_rev:=v_cur.revision+1;
 INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,artifact_id,evidence_ref,reason,actor_id)
 VALUES(p_item,v_rev,v_cur.revision,NULL,v_prev.name_cn,v_prev.fields,v_prev.artifact_id,
  'correction:test-code:'||p_request::text,'定向纠正测试货号，恢复货号待确认',v_actor);
 UPDATE catalog.item_current SET revision=v_rev WHERE item_id=p_item;
 UPDATE catalog.product_source_binding SET ice_code=NULL
  WHERE profile_id=v_profile_id AND item_id=p_item;
 INSERT INTO catalog.product_source_issue(batch_id,source_key,issue_kind,detail,item_id,scope)
 VALUES(v_batch.id,'item:'||p_item::text,'missing_code',
  jsonb_build_object('rows','[]'::jsonb,'rowNumbers','[]'::jsonb,
   'nameCn',v_prev.name_cn,'fieldKeys',jsonb_build_array('iceCode'),
   'pendingCode',true,'reason','TEST_CODE_RETIRED'),
  p_item,'item')
 ON CONFLICT(batch_id,source_key,issue_kind) DO UPDATE SET review_state='open',
  detail=EXCLUDED.detail,scope='item',resolved_at=NULL,resolved_by=NULL,resolution_note=NULL
 RETURNING id INTO v_issue_id;
 v_result:=jsonb_build_object('itemId',p_item,'revision',v_rev,'removedCode',p_test_code,
  'pendingCode',true,'issueId',v_issue_id,'batchId',v_batch.id);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'correct_test_source_code',p_item,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'correct_test_source_code',p_intent,v_batch.id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 13. 只读：当前人工决定（暂不处理 / 人工口径 / 同号选择）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_product_source_manual_decisions(p_profile_key text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile catalog.product_source_profile; v_result jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_profile_key IS NULL OR length(btrim(p_profile_key))=0
  OR p_profile_key<>btrim(p_profile_key) OR length(p_profile_key)>200 THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_profile FROM catalog.product_source_profile WHERE profile_key=p_profile_key;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('fieldDecisions','[]'::jsonb,'duplicateDecisions','[]'::jsonb);
 END IF;
 SELECT jsonb_build_object(
  'fieldDecisions',coalesce((
   SELECT jsonb_agg(jsonb_build_object(
    'decisionId',d.id,'itemId',d.item_id,'iceCode',coalesce(d.ice_code,c.ice_code),
    'nameCn',v.name_cn,'fieldKey',d.field_key,'action',d.action,'valueRaw',d.value_raw,
    'reason',d.reason,'note',d.note,'state',d.state,'decidedAt',d.decided_at,
    'sourceIssueId',d.source_issue_id) ORDER BY d.decided_at DESC)
   FROM catalog.product_source_field_decision d
   LEFT JOIN catalog.catalog_item_code c ON c.item_id=d.item_id
   LEFT JOIN catalog.item_current ic ON ic.item_id=d.item_id
   LEFT JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision
   WHERE d.profile_id=v_profile.id AND d.state='active'),'[]'::jsonb),
  'duplicateDecisions',coalesce((
   SELECT jsonb_agg(jsonb_build_object(
    'decisionId',d.id,'iceCode',d.ice_code,'itemId',d.item_id,
    'nameCn',v.name_cn,'chosenRowNumber',d.chosen_row_number,
    'chosenFields',d.chosen_fields,'comparison',d.comparison,
    'state',d.state,'decidedAt',d.decided_at,'note',d.note)
    ORDER BY d.decided_at DESC)
   FROM catalog.product_source_duplicate_decision d
   LEFT JOIN catalog.item_current ic ON ic.item_id=d.item_id
   LEFT JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision
   WHERE d.profile_id=v_profile.id AND d.state='active'),'[]'::jsonb)
 ) INTO v_result;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 14. 读投影：事项增加 scope / itemRevision / itemId（其余口径不变）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_product_source_overview(p_profile_key text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile catalog.product_source_profile; v_latest catalog.product_source_batch; v_result jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_profile_key IS NULL OR length(btrim(p_profile_key))=0 OR p_profile_key<>btrim(p_profile_key) OR length(p_profile_key)>200 THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_profile FROM catalog.product_source_profile WHERE profile_key=p_profile_key;
 IF NOT FOUND THEN
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
     'kind',i.issue_kind,'detail',i.detail,'reviewState',i.review_state,'scope',i.scope,
     'itemId',i.item_id,'itemRevision',ic.revision,
     'rows',coalesce(i.detail->'rowNumbers','[]'::jsonb)) AS obj,
     i.review_state,i.opened_at
    FROM catalog.product_source_issue i
    JOIN catalog.product_source_batch b ON b.id=i.batch_id
    LEFT JOIN catalog.catalog_item_code c ON c.item_id=i.item_id
    LEFT JOIN catalog.item_current ic ON ic.item_id=i.item_id
    LEFT JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision
    WHERE b.profile_id=v_profile.id
    ORDER BY (i.review_state<>'open'),i.opened_at DESC LIMIT 80) t),'[]'::jsonb),
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

-- ---------------------------------------------------------------------------
-- 15. 权限：只授权新入口给 app runner；PUBLIC 一律不可执行
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.product_source_issue_key(text,text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.reconcile_product_source_issues(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.apply_product_source_batch_v2(uuid,text,jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.set_product_source_field_decision(uuid,text,uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.revoke_product_source_field_decision(uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.decide_product_source_duplicate_row(uuid,text,uuid,integer,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.revoke_product_source_duplicate_decision(uuid,text,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.correct_test_product_code(uuid,text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_product_source_manual_decisions(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION catalog.apply_product_source_batch_v2(uuid,text,jsonb,jsonb,jsonb) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.set_product_source_field_decision(uuid,text,uuid,text,text,text,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.revoke_product_source_field_decision(uuid,text,uuid,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.decide_product_source_duplicate_row(uuid,text,uuid,integer,text,text,text,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.revoke_product_source_duplicate_decision(uuid,text,uuid,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.correct_test_product_code(uuid,text,uuid,text,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_product_source_manual_decisions(text) TO ice_p0_02_app_runner;
-- Plan loading reads the active decisions directly (same admin-only RLS path as 015 tables);
-- the read RPC alone does not return the content fingerprints needed by buildPlan.
GRANT SELECT ON TABLE catalog.product_source_field_decision,
 catalog.product_source_duplicate_decision TO ice_p0_02_app_runner;

RESET ROLE;
