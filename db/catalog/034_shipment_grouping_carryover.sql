-- ICE catalog 034: 物流在途「拆票 / 合票复核」收口（第十三轮）。
--
-- 合同：docs/tasks/shipment-in-transit-v1.md §19（第十三轮）。
-- 口径（不得违反）：
--   * 每次成功读取对照上一次成功读取的「商品分别在哪张票上」；归属一变就提醒，即使第二张票
--     以前出现过、同一种拆法以前确认过；连续同步同一种分组只提醒一次（相邻读取相同即无变化）。
--     → 复核签名去重范围从「同一个来源」改为「同一个来源 + 同一个上次成功快照」，
--       旧约束 (source_key,signature) 不能再把后续再次出现的同一拆法挡掉。
--   * 人工确认拆合关系后，只让能明确对应的原明细带原商品绑定；无关新票不按「品名+数量」猜。
--     → 绑定沿用改为服务端给出明确对应计划（当前票键 + 明细键 + 商品），SQL 只按计划补
--       从未人工处理过的未关联明细；旧的「全来源同品名同数量唯一即沿用」入口不再执行。
--   * 分组上下文额外返回每条原明细已绑定的 productId，供服务端构建对应计划。
--
-- 安装约定：幂等（DROP CONSTRAINT IF EXISTS / CREATE ... IF NOT EXISTS / CREATE OR REPLACE），
-- 必须在 033 之后重放；026–033 原文件不改。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 复核签名唯一范围：同一归属变化可以跨读取再次提醒
-- ---------------------------------------------------------------------------
ALTER TABLE catalog.shipment_grouping_review
 DROP CONSTRAINT IF EXISTS shipment_grouping_review_source_key_signature_key;
CREATE UNIQUE INDEX IF NOT EXISTS shipment_grouping_review_occurrence
 ON catalog.shipment_grouping_review(source_key,signature,from_snapshot_id);

-- ---------------------------------------------------------------------------
-- 2. 分组上下文：明细带 productId（只用于明确对应的原明细沿用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_grouping_state_core() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text; v_latest uuid; v_tickets jsonb:='[]'::jsonb; v_overrides jsonb:='[]'::jsonb;
 v_signatures jsonb:='[]'::jsonb;
BEGIN
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 IF v_latest IS NULL THEN
  RETURN jsonb_build_object('snapshotId',NULL,'tickets','[]'::jsonb,'overrides','[]'::jsonb,
   'reviewSignatures','[]'::jsonb);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'shipmentId',t.shipment_id,
   'ticketKey',t.ticket_key,
   'ticketNo',t.ticket_no,
   'market',t.market,
   'waybillsText',t.waybills_text,
   'purchaseOrder',t.purchase_order,
   'sourceRowStart',t.source_row_start,
   'sourceRowEnd',t.source_row_end,
   'items',t.items)
  ORDER BY t.source_row_start,t.shipment_id),'[]'::jsonb)
 INTO v_tickets
 FROM (
  SELECT s.id shipment_id,s.ticket_key,s.ticket_no,s.market,s.waybills_text,
   s.purchase_order,s.source_row_start,s.source_row_end,
   (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'itemId',i.id,
      'productId',i.product_id,
      'productNameRaw',i.product_name_raw,
      'productNameNorm',i.product_name_norm,
      'shippedQuantity',i.shipped_quantity)
     ORDER BY i.sort_index,i.id),'[]'::jsonb)
    FROM catalog.shipment_item i
    WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=v_latest) AS items
  FROM catalog.shipment s
  WHERE s.source_key=v_source AND s.last_seen_snapshot_id=v_latest
 ) t;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id',o.id,'reviewId',o.review_id,'kind',o.kind,'signature',o.signature,
   'spec',o.spec,'active',o.active,'createdAt',o.created_at)
  ORDER BY o.created_at,o.id),'[]'::jsonb)
 INTO v_overrides
 FROM catalog.shipment_grouping_override o
 WHERE o.source_key=v_source AND o.active;
 SELECT coalesce(jsonb_agg(r.signature ORDER BY r.created_at,r.signature),'[]'::jsonb)
 INTO v_signatures
 FROM catalog.shipment_grouping_review r
 WHERE r.source_key=v_source;
 RETURN jsonb_build_object('snapshotId',v_latest,'tickets',v_tickets,
  'overrides',v_overrides,'reviewSignatures',v_signatures);
END $$;

-- ---------------------------------------------------------------------------
-- 3. 登记复核：同一来源 + 同一次「上次成功读取」+ 同一签名只记一次
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.record_shipment_grouping_reviews_core(
 p_reviews jsonb,p_actor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text; v_review jsonb; v_id uuid; v_ids jsonb:='[]'::jsonb;
 v_kind text; v_signature text; v_evidence jsonb; v_from uuid;
BEGIN
 IF p_reviews IS NULL OR jsonb_typeof(p_reviews)<>'array' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviews' USING ERRCODE='22023'; END IF;
 v_source:=catalog.shipment_current_source_key();
 IF v_source IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:source' USING ERRCODE='22023'; END IF;
 FOR v_review IN SELECT value FROM jsonb_array_elements(p_reviews) LOOP
  v_kind:=coalesce(v_review->>'kind','');
  IF v_kind NOT IN('split','merge') THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviewKind' USING ERRCODE='22023'; END IF;
  v_signature:=lower(btrim(coalesce(v_review->>'signature','')));
  IF v_signature!~'^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviewSignature' USING ERRCODE='22023'; END IF;
  v_evidence:=v_review->'evidence';
  IF v_evidence IS NULL OR jsonb_typeof(v_evidence)<>'object' THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviewEvidence' USING ERRCODE='22023'; END IF;
  v_from:=CASE WHEN coalesce(v_review->>'fromSnapshotId','')~'^[0-9a-fA-F-]{36}$'
    THEN (v_review->>'fromSnapshotId')::uuid END;
  INSERT INTO catalog.shipment_grouping_review(source_key,signature,kind,status,evidence,
   from_snapshot_id,to_snapshot_id)
  VALUES(v_source,v_signature,v_kind,'pending',v_evidence,v_from,
   CASE WHEN coalesce(v_review->>'toSnapshotId','')~'^[0-9a-fA-F-]{36}$'
     THEN (v_review->>'toSnapshotId')::uuid END)
  ON CONFLICT (source_key,signature,from_snapshot_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
   v_ids:=v_ids||jsonb_build_array(v_id);
   v_id:=NULL;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'created',jsonb_array_length(v_ids),'ids',v_ids);
END $$;

-- ---------------------------------------------------------------------------
-- 4. 绑定沿用：按服务端明确的「当前票键 + 明细键 → 商品」计划补绑定
--    只补本次快照里从未人工/自动处理过的未关联明细；计划外的新票一律不碰。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.apply_shipment_item_association_carryover_core(
 p_snapshot_id uuid,p_plan jsonb,p_actor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_entry jsonb; v_ticket_key text; v_item_key text; v_product uuid;
 v_item catalog.shipment_item; v_source text; v_fields jsonb; v_new_revision integer;
 v_adopted integer:=0; v_skipped integer:=0;
BEGIN
 IF p_snapshot_id IS NULL OR p_plan IS NULL OR jsonb_typeof(p_plan)<>'array' THEN
  RETURN jsonb_build_object('adopted',0,'skipped',0,'deprecated',false); END IF;
 SELECT s.source_key INTO v_source FROM catalog.shipment_source_snapshot s WHERE s.id=p_snapshot_id;
 IF v_source IS NULL THEN RETURN jsonb_build_object('adopted',0,'skipped',0); END IF;
 FOR v_entry IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
  v_ticket_key:=nullif(btrim(coalesce(v_entry->>'ticketKey','')),'');
  v_item_key:=nullif(btrim(coalesce(v_entry->>'itemKey','')),'');
  IF v_ticket_key IS NULL OR v_item_key IS NULL
   OR coalesce(v_entry->>'productId','')!~'^[0-9a-fA-F-]{36}$' THEN
   v_skipped:=v_skipped+1; CONTINUE; END IF;
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
  UPDATE catalog.shipment_item SET product_id=v_product,association_status='auto',
   association_method='auto',associated_at=now(),
   revision=v_new_revision,updated_at=now()
  WHERE id=v_item.id;
  v_fields:=jsonb_build_object(
   'product_name_raw',v_item.product_name_raw,'product_name_norm',v_item.product_name_norm,
   'shipped_quantity',v_item.shipped_quantity,'received_quantity',v_item.received_quantity,
   'receipt_basis',v_item.receipt_basis,'source_note',v_item.source_note,
   'unit_text',v_item.unit_text,'source_sku',v_item.source_sku,
   'product_id',v_product,'association_status','auto','association_method','auto');
  INSERT INTO catalog.shipment_item_association_revision(item_id,revision,product_id,
   previous_product_id,method,actor_id,reason,recorded_at)
  VALUES(v_item.id,v_new_revision,v_product,NULL,'auto',p_actor,
   '分组变化后按原明细沿用商品',now());
  INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,fields,
   recorded_at,recorded_by)
  VALUES(v_item.id,v_new_revision,p_snapshot_id,v_fields,now(),p_actor);
  v_adopted:=v_adopted+1;
 END LOOP;
 RETURN jsonb_build_object('adopted',v_adopted,'skipped',v_skipped);
END $$;

CREATE OR REPLACE FUNCTION catalog.apply_shipment_item_association_carryover(
 p_snapshot_id uuid,p_plan jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 RETURN catalog.apply_shipment_item_association_carryover_core(p_snapshot_id,p_plan,v_actor);
END $$;

CREATE OR REPLACE FUNCTION catalog.worker_apply_shipment_item_association_carryover(
 p_snapshot_id uuid,p_plan jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.apply_shipment_item_association_carryover_core(p_snapshot_id,p_plan,NULL);
END $$;

-- 旧入口保留签名但不再执行「全来源同品名同数量」沿用：避免旧进程/旧动作绕开明确对应。
CREATE OR REPLACE FUNCTION catalog.adopt_shipment_item_associations_core(
 p_snapshot_id uuid,p_actor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 RETURN jsonb_build_object('adopted',0,'skipped',0,'deprecated',true);
END $$;

-- ---------------------------------------------------------------------------
-- 5. 权限：新入口 app / sync 分开授权；core 不授权
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.apply_shipment_item_association_carryover_core(uuid,jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.apply_shipment_item_association_carryover(uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_apply_shipment_item_association_carryover(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.apply_shipment_item_association_carryover(uuid,jsonb)
 TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.worker_apply_shipment_item_association_carryover(uuid,jsonb)
 TO ice_p0_02_sync_runner;

RESET ROLE;
