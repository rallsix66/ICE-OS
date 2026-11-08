-- ICE catalog 035: 拆合票「原始分组相邻读取」检测 + 人工确认后才沿用绑定（第十四轮 A）。
--
-- 合同：第十四轮用户口径（2026-11-07）：
--   1) 拆/合票检测必须对照「相邻两次成功读取的飞书原始分组」：上一成功读取的分组由 026
--      shipment_source_snapshot.raw 在服务端重新解析得到；人工分组覆盖只控制当前展示/计价，
--      不能遮住后续来源变化。→ 需要给后台读取进程（sync 角色）读最近成功快照原始网格的只读入口。
--   2) 普通同步不再自动沿用绑定；只有用户保存复核决定后，才按「这次复核涉及、能明确对应的原明细」
--      沿用商品绑定，并记录确认人与依据（actor=管理员、method=manual_selected、reason 含复核 id 与决定）。
--   3) 接受飞书原始分组（split_confirmed / merge_confirmed）时要停用本复核涉及票的生效人工覆盖。
--   4) 页面「已有人工决定」需要显示市场 / 票号 / 运单号（activeOverrides 补充字段）。
--
-- 本文件只新增/替换函数，不改 026–034 原文件、不改表结构（新增列留待后续轮次）：
--   * catalog.worker_read_shipment_latest_snapshot_raw()        （sync 角色）
--   * catalog.read_shipment_grouping_review(p_review_id uuid)   （app；含 evidence，任意状态）
--   * catalog.deactivate_shipment_grouping_overrides(p_review_id,p_ticket_keys)  （app）
--   * catalog.apply_shipment_item_association_carryover_manual(p_snapshot_id,p_plan,p_review_id,p_decision) （app）
--   * CREATE OR REPLACE catalog.read_shipment_grouping_reviews()（activeOverrides 增加 market/ticketNo/waybillsText）
--
-- 安装约定：幂等（CREATE OR REPLACE / 显式 REVOKE·GRANT），必须晚于 034 重放；末尾 RESET ROLE。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 最近成功快照原始网格：后台读取进程（sync 角色）只读入口
--    与 033 的 app 版本返回同一形状（snapshotId / values / merges / collection）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.worker_read_shipment_latest_snapshot_raw()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.read_shipment_latest_snapshot_raw_core();
END $$;

-- 核心实现（不授权）：与 033 的 app 版本共用同一口径，避免两份逻辑分叉。
CREATE OR REPLACE FUNCTION catalog.read_shipment_latest_snapshot_raw_core() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text; v_latest uuid; v_raw jsonb;
BEGIN
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 IF v_latest IS NULL THEN RETURN NULL; END IF;
 SELECT s.raw INTO v_raw FROM catalog.shipment_source_snapshot s WHERE s.id=v_latest;
 IF v_raw IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('snapshotId',v_latest,
  'values',coalesce(v_raw->'values','[]'::jsonb),
  'merges',coalesce(v_raw->'merges','[]'::jsonb),
  'collection',coalesce(v_raw->'collection','{}'::jsonb));
END $$;

-- 033 的 app 版本改为调用同一核心（签名/返回不变）。
CREATE OR REPLACE FUNCTION catalog.read_shipment_latest_snapshot_raw() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_admin();
 RETURN catalog.read_shipment_latest_snapshot_raw_core();
END $$;

-- ---------------------------------------------------------------------------
-- 2. 单条复核（含 evidence，任意状态）：人工决定/恢复时用于限定「本次复核涉及的票」
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_grouping_review(p_review_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_review catalog.shipment_grouping_review;
BEGIN
 PERFORM catalog.require_admin();
 IF p_review_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO v_review FROM catalog.shipment_grouping_review r WHERE r.id=p_review_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object(
  'id',v_review.id,'kind',v_review.kind,'status',v_review.status,
  'decision',v_review.decision,'signature',v_review.signature,'evidence',v_review.evidence,
  'createdAt',v_review.created_at,'resolvedAt',v_review.resolved_at,
  'resolutionNote',v_review.resolution_note);
END $$;

-- ---------------------------------------------------------------------------
-- 3. 接受飞书原始分组时：停用本复核涉及票的生效人工覆盖
--    涉及票 = 复核 evidence 的 previous/current 票键 ∪ 调用方显式传入的票键；
--    命中的覆盖：同一复核写入的，或 spec 里引用了这些票键的（合并 target/absorbed、拆分 source/groups）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.deactivate_shipment_grouping_overrides(p_review_id uuid,
 p_ticket_keys jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_source text; v_review catalog.shipment_grouping_review;
 v_keys text[]:='{}'::text[]; v_count integer:=0;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_review_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviewId' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_review FROM catalog.shipment_grouping_review r WHERE r.id=p_review_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:review' USING ERRCODE='22023'; END IF;
 v_source:=v_review.source_key;
 IF v_source IS NULL THEN RETURN jsonb_build_object('ok',true,'reviewId',p_review_id,'deactivated',0); END IF;
 -- evidence 两侧的票键 + 调用方传入的票键（去重、去空）。
 SELECT coalesce(array_agg(DISTINCT value),'{}'::text[]) INTO v_keys
 FROM (
  SELECT nullif(btrim(t->>'ticketKey'),'') AS value
  FROM jsonb_array_elements(coalesce(v_review.evidence->'previous'->'tickets','[]'::jsonb)) t
  UNION ALL
  SELECT nullif(btrim(t->>'ticketKey'),'') AS value
  FROM jsonb_array_elements(coalesce(v_review.evidence->'current'->'tickets','[]'::jsonb)) t
  UNION ALL
  SELECT nullif(btrim(t),'') AS value
  FROM jsonb_array_elements_text(
   CASE WHEN p_ticket_keys IS NULL OR jsonb_typeof(p_ticket_keys)<>'array'
     THEN '[]'::jsonb ELSE p_ticket_keys END) t
 ) k WHERE value IS NOT NULL;
 UPDATE catalog.shipment_grouping_override o SET active=false,revoked_at=now(),revoked_by=v_actor
 WHERE o.source_key=v_source AND o.active
  AND (
   o.review_id=p_review_id
   OR (o.spec->>'targetKey')=ANY(v_keys)
   OR (o.spec->>'sourceKey')=ANY(v_keys)
   OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(coalesce(o.spec->'absorbedKeys','[]'::jsonb)) a
    WHERE a=ANY(v_keys))
   OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(o.spec->'groups','[]'::jsonb)) g
    WHERE (g->>'ticketKey')=ANY(v_keys))
  );
 GET DIAGNOSTICS v_count=ROW_COUNT;
 RETURN jsonb_build_object('ok',true,'reviewId',p_review_id,'deactivated',v_count,
  'ticketKeys',to_jsonb(v_keys));
END $$;

-- ---------------------------------------------------------------------------
-- 4. 人工确认后沿用绑定（只在保存复核决定后调用；记录管理员确认人与依据）
--    - 计划由服务端按「来源行范围重叠 + 品名/数量一致 + 商品唯一」生成；
--    - SQL 再按本次复核 evidence 的票键范围收窄，计划外的无关新票一律不碰；
--    - 只补从未人工/自动处理过的未关联明细；写入 manual_selected。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.apply_shipment_item_association_carryover_manual(
 p_snapshot_id uuid,p_plan jsonb,p_review_id uuid,p_decision text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_entry jsonb; v_ticket_key text; v_item_key text; v_product uuid;
 v_item catalog.shipment_item; v_source text; v_fields jsonb; v_new_revision integer;
 v_review catalog.shipment_grouping_review; v_keys text[]:='{}'::text[];
 v_allowed boolean; v_adopted integer:=0; v_skipped integer:=0;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_snapshot_id IS NULL OR p_plan IS NULL OR jsonb_typeof(p_plan)<>'array'
  OR p_review_id IS NULL THEN
  RETURN jsonb_build_object('adopted',0,'skipped',0,'reviewId',p_review_id,'decision',p_decision); END IF;
 IF coalesce(p_decision,'') NOT IN('split_confirmed','keep_one','merge_confirmed',
   'keep_separate','restored') THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:decision' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_review FROM catalog.shipment_grouping_review r WHERE r.id=p_review_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:review' USING ERRCODE='22023'; END IF;
 SELECT s.source_key INTO v_source FROM catalog.shipment_source_snapshot s WHERE s.id=p_snapshot_id;
 IF v_source IS NULL THEN
  RETURN jsonb_build_object('adopted',0,'skipped',0,'reviewId',p_review_id,'decision',p_decision); END IF;
 -- 本次复核 evidence 涉及的票键（previous ∪ current）。
 SELECT coalesce(array_agg(DISTINCT value),'{}'::text[]) INTO v_keys
 FROM (
  SELECT nullif(btrim(t->>'ticketKey'),'') AS value
  FROM jsonb_array_elements(coalesce(v_review.evidence->'previous'->'tickets','[]'::jsonb)) t
  UNION ALL
  SELECT nullif(btrim(t->>'ticketKey'),'') AS value
  FROM jsonb_array_elements(coalesce(v_review.evidence->'current'->'tickets','[]'::jsonb)) t
 ) k WHERE value IS NOT NULL;
 FOR v_entry IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
  v_ticket_key:=nullif(btrim(coalesce(v_entry->>'ticketKey','')),'');
  v_item_key:=nullif(btrim(coalesce(v_entry->>'itemKey','')),'');
  IF v_ticket_key IS NULL OR v_item_key IS NULL
   OR coalesce(v_entry->>'productId','')!~'^[0-9a-fA-F-]{36}$' THEN
   v_skipped:=v_skipped+1; CONTINUE; END IF;
  -- 计划之外的票（无关新票/无关旧票）不在本次复核范围，一律跳过。
  v_allowed:=(v_ticket_key=ANY(v_keys));
  IF NOT v_allowed THEN v_skipped:=v_skipped+1; CONTINUE; END IF;
  v_product:=(v_entry->>'productId')::uuid;
  SELECT i.* INTO v_item
  FROM catalog.shipment_item i
  JOIN catalog.shipment s ON s.id=i.shipment_id
  WHERE i.source_key=v_source AND s.source_key=v_source
   AND s.ticket_key=v_ticket_key AND s.last_seen_snapshot_id=p_snapshot_id
   AND i.item_key=v_item_key AND i.last_seen_snapshot_id=p_snapshot_id
  FOR UPDATE;
  IF NOT FOUND THEN v_skipped:=v_skipped+1; CONTINUE; END IF;
  -- 已有关联（人工或自动）不覆盖；只补从未处理过的未关联明细。
  IF v_item.product_id IS NOT NULL OR v_item.association_status<>'none'
   OR v_item.association_method IS NOT NULL THEN
   v_skipped:=v_skipped+1; CONTINUE; END IF;
  v_new_revision:=v_item.revision+1;
  UPDATE catalog.shipment_item SET product_id=v_product,association_status='manual',
   association_method='manual_selected',associated_by=v_actor,associated_at=now(),
   revision=v_new_revision,updated_at=now()
  WHERE id=v_item.id;
  v_fields:=jsonb_build_object(
   'product_name_raw',v_item.product_name_raw,'product_name_norm',v_item.product_name_norm,
   'shipped_quantity',v_item.shipped_quantity,'received_quantity',v_item.received_quantity,
   'receipt_basis',v_item.receipt_basis,'source_note',v_item.source_note,
   'unit_text',v_item.unit_text,'source_sku',v_item.source_sku,
   'product_id',v_product,'association_status','manual',
   'association_method','manual_selected');
  INSERT INTO catalog.shipment_item_association_revision(item_id,revision,product_id,
   previous_product_id,method,actor_id,reason,recorded_at)
  VALUES(v_item.id,v_new_revision,v_product,NULL,'manual_selected',v_actor,
   format('人工确认拆合关系（%s：%s）后按原明细沿用商品',p_review_id,p_decision),now());
  INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,fields,
   recorded_at,recorded_by)
  VALUES(v_item.id,v_new_revision,p_snapshot_id,v_fields,now(),v_actor);
  v_adopted:=v_adopted+1;
 END LOOP;
 RETURN jsonb_build_object('adopted',v_adopted,'skipped',v_skipped,'reviewId',p_review_id,
  'decision',p_decision);
END $$;

-- ---------------------------------------------------------------------------
-- 5. 页面「已有人工决定」：补充市场 / 票号 / 运单号（从复核 evidence 当前票取，退回上次票）
--    其余字段与 033 一致。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_grouping_reviews() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text;
BEGIN
 PERFORM catalog.require_admin();
 v_source:=catalog.shipment_current_source_key();
 IF v_source IS NULL THEN RETURN jsonb_build_object('pending','[]'::jsonb,'activeOverrides','[]'::jsonb); END IF;
 RETURN jsonb_build_object(
  'pending',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'id',r.id,'kind',r.kind,'status',r.status,'decision',r.decision,
     'signature',r.signature,'evidence',r.evidence,
     'createdAt',r.created_at,'resolvedAt',r.resolved_at,
     'resolutionNote',r.resolution_note)
    ORDER BY r.created_at DESC,r.id DESC),'[]'::jsonb)
   FROM catalog.shipment_grouping_review r
   WHERE r.source_key=v_source AND r.status='pending'),
  'activeOverrides',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'id',o.id,'reviewId',o.review_id,'kind',o.kind,'signature',o.signature,
     'reviewKind',r.kind,'decision',r.decision,'createdAt',o.created_at,
     'market',coalesce(c.ticket->>'market',p.ticket->>'market'),
     'ticketNo',coalesce(
       nullif(c.ticket->>'ticketNo',''),
       nullif(c.ticket->>'purchaseOrder',''),
       nullif(c.ticket->>'ticketKey',''),
       nullif(p.ticket->>'ticketNo',''),
       nullif(p.ticket->>'purchaseOrder',''),
       nullif(p.ticket->>'ticketKey','')),
     'waybillsText',coalesce(nullif(c.ticket->>'waybillsText',''),
       nullif(p.ticket->>'waybillsText','')))
    ORDER BY o.created_at DESC,o.id DESC),'[]'::jsonb)
   FROM catalog.shipment_grouping_override o
   JOIN catalog.shipment_grouping_review r ON r.id=o.review_id
   CROSS JOIN LATERAL (SELECT r.evidence->'current'->'tickets'->0 AS ticket) c
   CROSS JOIN LATERAL (SELECT r.evidence->'previous'->'tickets'->0 AS ticket) p
   WHERE o.source_key=v_source AND o.active));
END $$;

-- ---------------------------------------------------------------------------
-- 6. 权限：app 用复核/沿用入口；sync 只多一个「读最近原始快照」；核心函数不授权
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_shipment_latest_snapshot_raw_core() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_read_shipment_latest_snapshot_raw() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_latest_snapshot_raw() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_grouping_review(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.deactivate_shipment_grouping_overrides(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.apply_shipment_item_association_carryover_manual(uuid,jsonb,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_grouping_reviews() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 catalog.read_shipment_latest_snapshot_raw(),
 catalog.read_shipment_grouping_review(uuid),
 catalog.deactivate_shipment_grouping_overrides(uuid,jsonb),
 catalog.apply_shipment_item_association_carryover_manual(uuid,jsonb,uuid,text),
 catalog.read_shipment_grouping_reviews()
 TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.worker_read_shipment_latest_snapshot_raw()
 TO ice_p0_02_sync_runner;

RESET ROLE;
