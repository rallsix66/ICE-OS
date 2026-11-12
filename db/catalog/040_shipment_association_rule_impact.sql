-- ICE catalog 040: 物流沿用规则「按所选商品」预告 + 保存回执「本条规则实际影响条数」。
--
-- 背景（2026-11-12 用户决定）：
-- 1) 「以后同市场同品名也沿用」的预告必须按用户**当前选中的商品**计算：
--    已经关联到所选商品的其他明细不需要改动，计 0 条；换选商品时页面刷新预告。
-- 2) 保存回执只写「这条规则」实际另外影响了几条，不能把同一次 apply 中其它规则
--    （其它品名/市场）产生的改动算进来。
--
-- 本增量：
--   A. 新增只读函数 read_shipment_association_rule_preview_for_product(item, product)：
--      与 027 apply_core 同一命中条件，但把「将改关联」限定为改到**所选商品**，
--      并排除当前已经关联到所选商品的明细；不写任何表、不新增表。
--   B. CREATE OR REPLACE 027 的 save_shipment_item_association_with_mapping（同签名）：
--      行为不变，只在返回 jsonb 里增加 ruleAdoptedCount（本条规则实际改动的明细条数）。
--      原 adoptedCount（本次 apply 全部规则合计）保留，便于诊断；页面只用 ruleAdoptedCount。
--
-- 权限：SECURITY DEFINER + require_admin；REVOKE PUBLIC / GRANT ice_p0_02_app_runner；
--       不授予任何表权限。幂等（CREATE OR REPLACE）。
SET ROLE ice_p0_02_owner;

/* A. 按所选商品的影响预告（只读） */
CREATE OR REPLACE FUNCTION catalog.read_shipment_association_rule_preview_for_product(
 p_item_id uuid, p_product_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item catalog.shipment_item; v_shipment catalog.shipment; v_latest uuid;
 v_market text; v_norm text; v_raw text;
 v_matching integer:=0; v_ticket integer:=0; v_unbound integer:=0; v_reassign integer:=0;
 v_samples jsonb:='[]'::jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_item_id IS NULL OR p_product_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:item/product' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_item FROM catalog.shipment_item i WHERE i.id=p_item_id;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'itemId',p_item_id,'market',NULL,'nameNorm',NULL,
   'productNameRaw',NULL,'selectedProductId',p_product_id,'matchingCount',0,'ticketCount',0,
   'sampleTickets','[]'::jsonb,'unboundCount',0,'reassignCount',0,'note','明细不存在');
 END IF;
 SELECT * INTO v_shipment FROM catalog.shipment s WHERE s.id=v_item.shipment_id;
 v_market:=v_shipment.market;
 v_norm:=v_item.product_name_norm;
 v_raw:=v_item.product_name_raw;
 IF v_market IS NULL THEN
  RETURN jsonb_build_object('ok',true,'itemId',p_item_id,'market',NULL,'nameNorm',v_norm,
   'productNameRaw',v_raw,'selectedProductId',p_product_id,'matchingCount',0,'ticketCount',0,
   'sampleTickets','[]'::jsonb,'unboundCount',0,'reassignCount',0,
   'note','市场未提供，不能保存沿用规则');
 END IF;
 v_latest:=catalog.shipment_latest_success_snapshot_id(v_item.source_key);
 IF v_latest IS NULL THEN
  RETURN jsonb_build_object('ok',true,'itemId',p_item_id,'market',v_market,'nameNorm',v_norm,
   'productNameRaw',v_raw,'selectedProductId',p_product_id,'matchingCount',0,'ticketCount',0,
   'sampleTickets','[]'::jsonb,'unboundCount',0,'reassignCount',0,
   'note','来源最近一次成功读取不存在，无法预告');
 END IF;
 -- 与 027 shipment_mapping_apply_core 相同口径，但：
 --   * 已关联到所选商品（product_id = p_product_id）的明细不改，计 0；
 --   * 「将改关联」只统计会改成所选商品的明细。
 WITH hits AS (
  SELECT i.id,i.product_id,i.association_method,s.ticket_no,
   (i.product_id IS NULL AND i.association_method IS NULL) AS is_unbound,
   (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
     AND i.product_id IS DISTINCT FROM p_product_id) AS is_reassign
  FROM catalog.shipment_item i
  JOIN catalog.shipment s ON s.id=i.shipment_id
  WHERE i.source_key=v_item.source_key
    AND i.product_name_norm=v_norm
    AND s.market=v_market
    AND i.last_seen_snapshot_id=v_latest
    AND i.id<>p_item_id
    AND i.product_id IS DISTINCT FROM p_product_id
    AND (
      (i.product_id IS NULL AND i.association_method IS NULL)
      OR (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
        AND i.product_id IS DISTINCT FROM p_product_id)
    )
 )
 SELECT count(*)::integer,
   count(DISTINCT h.ticket_no)::integer,
   count(*) FILTER (WHERE h.is_unbound)::integer,
   count(*) FILTER (WHERE h.is_reassign)::integer,
   (SELECT coalesce(jsonb_agg(t.ticket_no ORDER BY t.ticket_no),'[]'::jsonb)
    FROM (SELECT DISTINCT h2.ticket_no FROM hits h2 ORDER BY h2.ticket_no LIMIT 3) t)
 INTO v_matching,v_ticket,v_unbound,v_reassign,v_samples
 FROM hits h;
 RETURN jsonb_build_object('ok',true,'itemId',p_item_id,'market',v_market,'nameNorm',v_norm,
  'productNameRaw',v_raw,'selectedProductId',p_product_id,'matchingCount',v_matching,
  'ticketCount',v_ticket,'sampleTickets',v_samples,'unboundCount',v_unbound,
  'reassignCount',v_reassign,'note',NULL);
END $$;

REVOKE ALL ON FUNCTION catalog.read_shipment_association_rule_preview_for_product(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_shipment_association_rule_preview_for_product(uuid,uuid)
 TO ice_p0_02_app_runner;

/* B. 保存关联 + 沿用规则：返回本条规则实际影响条数（行为不变） */
CREATE OR REPLACE FUNCTION catalog.save_shipment_item_association_with_mapping(p_item_id uuid,
 p_product_id uuid,p_expected_revision integer,p_reason text,p_remember boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_item catalog.shipment_item; v_market text;
 v_result jsonb; v_mapping_saved boolean:=false; v_applied jsonb:=jsonb_build_object('adopted',0);
 v_rule_adopted integer:=0; v_basis text;
BEGIN
 v_actor:=catalog.require_admin();
 v_result:=catalog.update_shipment_item_association_core(p_item_id,p_product_id,
  p_expected_revision,p_reason,v_actor);
 IF p_remember IS NOT TRUE OR v_result->>'ok'<>'true' OR p_product_id IS NULL THEN
  RETURN v_result||jsonb_build_object('mappingSaved',false,'adoptedCount',0,'ruleAdoptedCount',0); END IF;
 SELECT * INTO v_item FROM catalog.shipment_item i WHERE i.id=p_item_id;
 SELECT s.market INTO v_market FROM catalog.shipment s WHERE s.id=v_item.shipment_id;
 IF v_market IS NULL THEN
  RETURN v_result||jsonb_build_object('mappingSaved',false,'adoptedCount',0,'ruleAdoptedCount',0,
   'mappingNote','市场未提供，未保存通用对应'); END IF;
 v_basis:=left(coalesce(nullif(btrim(coalesce(p_reason,'')),''),
  '人工确认：同来源、同品名、同市场沿用'),500);
 PERFORM catalog.shipment_mapping_upsert(v_item.source_key,v_item.product_name_norm,
  v_market,p_product_id,v_basis,v_actor);
 v_mapping_saved:=true;
 v_applied:=catalog.shipment_mapping_apply_core(v_item.source_key,v_actor);
 -- 只统计本规则（同来源 + 同规范品名 + 同市场 + 所选商品）在这次 apply 中实际改动的明细。
 SELECT count(*)::integer INTO v_rule_adopted
 FROM catalog.shipment_item i
 JOIN catalog.shipment s ON s.id=i.shipment_id
 WHERE i.id IN (
   SELECT (e->>'itemId')::uuid FROM jsonb_array_elements(v_applied->'items') e
  )
  AND i.product_name_norm=v_item.product_name_norm
  AND s.market=v_market
  AND i.product_id=p_product_id;
 RETURN v_result||jsonb_build_object('mappingSaved',v_mapping_saved,
  'adoptedCount',coalesce((v_applied->>'adopted')::integer,0),
  'ruleAdoptedCount',v_rule_adopted,
  'market',v_market);
END $$;

REVOKE ALL ON FUNCTION catalog.save_shipment_item_association_with_mapping(uuid,uuid,integer,text,boolean)
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.save_shipment_item_association_with_mapping(uuid,uuid,integer,text,boolean)
 TO ice_p0_02_app_runner;

RESET ROLE;
