-- 037: 飞书商品资料「按来源列解释」+ 候选关系补号闭环（幂等增量）
--
-- 背景（2026-11-10 用户决定）：
--   1) LS101501 退出固定 0.05 override，改为按指定来源列解释重量：
--      unitWeight=unit_weight_per_unit_fragment（取单个产品重量 O 列 0.05/件，忽略同格 24.45/箱）、
--      cartonWeight=confirmed_source_value（箱重取 T 列 24.15）。字段决定新增 action='interpret' + rule，
--      interpret 不写商品字段、不新增修订，只登记口径并关闭同类待办。
--   2) WM0131 关系确认后补号：assign_product_source_code 除关闭 item 级“货号待确认”外，
--      还要关闭 batch 级 missing_code / missing_code_candidate（source_key='code:'||新码
--      或 item_id=该商品 的 candidate），结果增加 closedCandidateIssues。
--
-- 本文件只新增/替换（不改 001–036 文件），重复执行幂等：
--   - product_source_field_decision 增加 rule 列 + action/rule 约束；
--   - product_source_request 动作白名单增加 interpret_source_field；
--   - 新函数 catalog.set_product_source_field_interpretation(...)；
--   - 替换 read_product_source_manual_decisions（fieldDecisions 增加 rule）；
--   - 替换 assign_product_source_code（沿用 036，追加 batch 级候选事项关闭计数）；
--   - 权限：新/替换入口 REVOKE PUBLIC、GRANT 给 app runner；表沿用 036 授权。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 字段决定：新增 rule（仅 interpret 使用），action 扩展为 defer/override/interpret
-- ---------------------------------------------------------------------------
ALTER TABLE catalog.product_source_field_decision
 ADD COLUMN IF NOT EXISTS rule text;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='product_source_field_decision_action_check'
   AND conrelid='catalog.product_source_field_decision'::regclass) THEN
  ALTER TABLE catalog.product_source_field_decision DROP CONSTRAINT product_source_field_decision_action_check;
 END IF;
 ALTER TABLE catalog.product_source_field_decision ADD CONSTRAINT product_source_field_decision_action_check
  CHECK(action IN('defer','override','interpret'));
END $$;

-- interpret 必须有 rule；defer/override 不允许带 rule。
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='product_source_field_decision_rule_consistency_check'
   AND conrelid='catalog.product_source_field_decision'::regclass) THEN
  ALTER TABLE catalog.product_source_field_decision DROP CONSTRAINT product_source_field_decision_rule_consistency_check;
 END IF;
 ALTER TABLE catalog.product_source_field_decision ADD CONSTRAINT product_source_field_decision_rule_consistency_check
  CHECK((action='interpret' AND rule IS NOT NULL) OR (action<>'interpret' AND rule IS NULL));
END $$;

-- rule 白名单与字段绑定：只允许两种已确认的“按来源列解释”口径。
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='product_source_field_decision_rule_allowed_check'
   AND conrelid='catalog.product_source_field_decision'::regclass) THEN
  ALTER TABLE catalog.product_source_field_decision DROP CONSTRAINT product_source_field_decision_rule_allowed_check;
 END IF;
 ALTER TABLE catalog.product_source_field_decision ADD CONSTRAINT product_source_field_decision_rule_allowed_check
  CHECK(rule IS NULL
   OR (field_key='unitWeight' AND rule='unit_weight_per_unit_fragment')
   OR (field_key='cartonWeight' AND rule='confirmed_source_value'));
END $$;

-- ---------------------------------------------------------------------------
-- 2. 请求动作白名单：增加 interpret_source_field
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='product_source_request_action_check'
   AND conrelid='catalog.product_source_request'::regclass) THEN
  ALTER TABLE catalog.product_source_request DROP CONSTRAINT product_source_request_action_check;
 END IF;
 ALTER TABLE catalog.product_source_request ADD CONSTRAINT product_source_request_action_check
  CHECK(action IN('apply_product_source_batch','resolve_source_issue','assign_source_code',
   'defer_source_field','override_source_field','restore_source_field',
   'decide_duplicate_source_row','restore_duplicate_source_decision','correct_test_source_code',
   'interpret_source_field'));
END $$;

-- ---------------------------------------------------------------------------
-- 3. 新 RPC：登记“按来源列解释”的字段口径（不写商品字段、不新增修订）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.set_product_source_field_interpretation(p_request uuid,p_intent text,
 p_item uuid,p_field text,p_rule text,p_reason text,p_note text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_item catalog.catalog_item;
 v_profile_id uuid; v_code text; v_field text; v_rule text; v_reason text; v_note text;
 v_decision catalog.product_source_field_decision; v_batch_id uuid; v_closed integer:=0; v_result jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_prior:=catalog.existing_request(p_request,p_intent,'interpret_source_field');
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 v_field:=nullif(btrim(coalesce(p_field,'')),'');
 v_rule:=nullif(btrim(coalesce(p_rule,'')),'');
 v_reason:=nullif(btrim(coalesce(p_reason,'')),'');
 v_note:=nullif(btrim(coalesce(p_note,'')),'');
 IF p_item IS NULL OR v_field IS NULL OR v_rule IS NULL THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 IF NOT(v_field=ANY(catalog.product_source_field_keys())) THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT((v_field='unitWeight' AND v_rule='unit_weight_per_unit_fragment')
   OR (v_field='cartonWeight' AND v_rule='confirmed_source_value')) THEN
  RAISE EXCEPTION 'CATALOG_SOURCE_FIELD_RULE_INVALID' USING ERRCODE='22023'; END IF;
 IF v_reason IS NULL OR length(v_reason)>500 OR (v_note IS NOT NULL AND length(v_note)>1000) THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_item FROM catalog.catalog_item WHERE id=p_item;
 IF NOT FOUND THEN RAISE EXCEPTION 'CATALOG_SOURCE_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT p.id INTO v_profile_id FROM catalog.product_source_profile p
  WHERE p.profile_key='feishu.ice-product-library.sheet1';
 IF v_profile_id IS NULL THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT:profile' USING ERRCODE='22023'; END IF;
 SELECT c.ice_code INTO v_code FROM catalog.catalog_item_code c WHERE c.item_id=p_item;
 -- 同一商品+字段同时只有一个生效决定。
 SELECT * INTO v_decision FROM catalog.product_source_field_decision d
  WHERE d.profile_id=v_profile_id AND d.item_id=p_item AND d.field_key=v_field AND d.state='active'
  FOR UPDATE;
 IF FOUND THEN
  UPDATE catalog.product_source_field_decision SET state='superseded',superseded_at=now()
   WHERE id=v_decision.id;
 END IF;
 INSERT INTO catalog.product_source_field_decision(profile_id,item_id,ice_code,field_key,action,
  value_raw,rule,reason,note,state,source_issue_id,request_id,decided_by)
 VALUES(v_profile_id,p_item,v_code,v_field,'interpret',NULL,v_rule,v_reason,v_note,'active',NULL,
  p_request,v_actor)
 RETURNING * INTO v_decision;
 -- 该商品+字段的 open 字段类事项按新口径关闭（不写商品字段）。
 UPDATE catalog.product_source_issue i SET
  review_state='ignored',resolved_at=now(),resolved_by=v_actor,
  resolution_note='已登记按来源列解释口径（'||v_rule||'），后续批次按该口径读取，不再催办'
  WHERE i.item_id=p_item AND i.review_state='open'
   AND i.issue_kind IN('invalid_value','formula_error','invalid_carton_quantity','unit_unconfirmed')
   AND i.batch_id IN(SELECT b.id FROM catalog.product_source_batch b WHERE b.profile_id=v_profile_id)
   AND coalesce(i.detail->>'fieldKey',
    CASE WHEN jsonb_typeof(i.detail->'fieldKeys')='array'
      AND jsonb_array_length(i.detail->'fieldKeys')=1
     THEN i.detail->'fieldKeys'->>0 END)=v_field;
 GET DIAGNOSTICS v_closed=ROW_COUNT;
 SELECT b.id INTO v_batch_id FROM catalog.product_source_batch b
  WHERE b.profile_id=v_profile_id AND b.status IN('applied','partial')
  ORDER BY b.captured_at DESC,b.received_at DESC LIMIT 1;
 v_result:=jsonb_build_object('decisionId',v_decision.id,'itemId',p_item,'fieldKey',v_field,
  'rule',v_rule,'state','active','closedIssues',v_closed);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'interpret_source_field',p_item,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'interpret_source_field',p_intent,v_batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 4. 读接口：fieldDecisions 增加 rule（其余口径不变）
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
    'rule',d.rule,
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
-- 5. 补号闭环：沿用 036 的 assign_product_source_code，追加 batch 级候选事项关闭
--    （item 级“货号待确认”仍由原逻辑关闭；UUID/历史/在途关联不变；TEST- 码仍禁止）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.assign_product_source_code(p_request uuid,p_intent text,p_item uuid,p_expected integer,
 p_code text,p_reason text,p_evidence text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_cur catalog.item_current; v_prev catalog.item_revision;
 v_profile_id uuid; v_batch_id uuid; v_row catalog.product_source_row; v_result jsonb; v_rev integer;
 v_closed integer:=0; v_closed_candidates integer:=0;
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
 IF EXISTS(SELECT 1 FROM catalog.product_source_binding b
   WHERE b.profile_id=v_profile_id AND b.ice_code=p_code AND b.item_id<>p_item) THEN
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
 -- item 级“货号待确认”闭环（036 行为）。
 UPDATE catalog.product_source_issue SET review_state='resolved',resolved_at=now(),
  resolved_by=v_actor,resolution_note='已人工补录正式货号 '||p_code
  WHERE item_id=p_item AND review_state='open' AND scope='item'
   AND issue_kind IN('missing_code','missing_code_candidate');
 GET DIAGNOSTICS v_closed=ROW_COUNT;
 -- 037 新增：batch 级候选关系闭环（同码缺码事项 + 该商品的 missing_code_candidate）。
 UPDATE catalog.product_source_issue i SET review_state='resolved',resolved_at=now(),
  resolved_by=v_actor,resolution_note='已人工确认候选关系并补录正式货号 '||p_code
  WHERE i.review_state='open' AND i.scope='batch'
   AND i.issue_kind IN('missing_code','missing_code_candidate')
   AND i.batch_id IN(SELECT b.id FROM catalog.product_source_batch b WHERE b.profile_id=v_profile_id)
   AND (i.source_key='code:'||p_code
    OR (i.issue_kind='missing_code_candidate' AND i.item_id=p_item));
 GET DIAGNOSTICS v_closed_candidates=ROW_COUNT;
 v_result:=jsonb_build_object('itemId',p_item,'revision',v_rev,'iceCode',p_code,
  'batchId',v_batch_id,'closedPendingIssues',v_closed,
  'closedCandidateIssues',v_closed_candidates);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
 VALUES(p_request,p_intent,v_actor,'assign_source_code',p_item,v_result);
 INSERT INTO catalog.product_source_request(request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
 VALUES(p_request,v_profile_id,'assign_source_code',p_intent,v_batch_id,v_result,v_actor)
 ON CONFLICT(request_id) DO NOTHING;
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 6. 权限：新/替换入口只给 app runner；PUBLIC 一律不可执行；表沿用 036 授权
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.set_product_source_field_interpretation(uuid,text,uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_product_source_manual_decisions(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.assign_product_source_code(uuid,text,uuid,integer,text,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION catalog.set_product_source_field_interpretation(uuid,text,uuid,text,text,text,text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_product_source_manual_decisions(text) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.assign_product_source_code(uuid,text,uuid,integer,text,text,text) TO ice_p0_02_app_runner;
-- 036 已授予 app SELECT 两张人工决定表（plan 加载需要），037 保持原授权。
GRANT SELECT ON TABLE catalog.product_source_field_decision,
 catalog.product_source_duplicate_decision TO ice_p0_02_app_runner;

RESET ROLE;
