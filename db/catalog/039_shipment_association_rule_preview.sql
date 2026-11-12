-- ICE catalog 039: 物流关联「规则命中预告」只读投影。
--
-- 背景（2026-11-10 用户决定）：在货票详情/货值汇总选择「以后同市场同品名也沿用」之前，
-- 用户需要知道这条规则**现在**会影响哪些明细，以及以后新到的同市场同品名明细也会自动匹配。
-- 本函数只是 027 catalog.shipment_mapping_apply_core 的只读预告：不写任何表、不新增表、
-- 不改 026/027/028 已发布内容。
--
-- 口径（必须与 027 apply_core 精确一致）：
--   * 同 source_key；
--   * 同 product_name_norm（目标明细的规范化品名）；
--   * 票市场 s.market = 目标明细所在票的市场（市场为空不预告、也不能保存规则）；
--   * 明细仍在最近一次成功读取里（i.last_seen_snapshot_id = 最近成功快照 id）；
--   * 排除目标明细本身；
--   * 命中条件与 apply_core 相同：
--       (product_id IS NULL AND association_method IS NULL)                                     -- 未关联
--     OR (product_id IS NOT NULL AND association_method='normalized_name_exact'
--         AND catalog.shipment_mapping_lookup(source_key,product_name_norm,s.market)
--             IS DISTINCT FROM product_id)                                                      -- 将按规则改关联
--
-- 返回：{ ok, itemId, market, nameNorm, productNameRaw, matchingCount, ticketCount,
--         sampleTickets:[票号…最多3], unboundCount, reassignCount, note }
--   matchingCount = unboundCount + reassignCount（两个分支互斥，与 apply_core 一一对应）。
-- 权限：SECURITY DEFINER + require_admin；REVOKE PUBLIC / GRANT ice_p0_02_app_runner；
--       不授予任何表权限。幂等（CREATE OR REPLACE）。
SET ROLE ice_p0_02_owner;

CREATE OR REPLACE FUNCTION catalog.read_shipment_association_rule_preview(p_item_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item catalog.shipment_item; v_shipment catalog.shipment; v_latest uuid;
 v_market text; v_norm text; v_raw text;
 v_matching integer:=0; v_ticket integer:=0; v_unbound integer:=0; v_reassign integer:=0;
 v_samples jsonb:='[]'::jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_item_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:item' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_item FROM catalog.shipment_item i WHERE i.id=p_item_id;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'itemId',p_item_id,'market',NULL,'nameNorm',NULL,
   'productNameRaw',NULL,'matchingCount',0,'ticketCount',0,'sampleTickets','[]'::jsonb,
   'unboundCount',0,'reassignCount',0,'note','明细不存在');
 END IF;
 SELECT * INTO v_shipment FROM catalog.shipment s WHERE s.id=v_item.shipment_id;
 v_market:=v_shipment.market;
 v_norm:=v_item.product_name_norm;
 v_raw:=v_item.product_name_raw;
 IF v_market IS NULL THEN
  -- 市场未提供：027 不采用对应，也不能保存沿用规则。
  RETURN jsonb_build_object('ok',true,'itemId',p_item_id,'market',NULL,'nameNorm',v_norm,
   'productNameRaw',v_raw,'matchingCount',0,'ticketCount',0,'sampleTickets','[]'::jsonb,
   'unboundCount',0,'reassignCount',0,'note','市场未提供，不能保存沿用规则');
 END IF;
 v_latest:=catalog.shipment_latest_success_snapshot_id(v_item.source_key);
 IF v_latest IS NULL THEN
  RETURN jsonb_build_object('ok',true,'itemId',p_item_id,'market',v_market,'nameNorm',v_norm,
   'productNameRaw',v_raw,'matchingCount',0,'ticketCount',0,'sampleTickets','[]'::jsonb,
   'unboundCount',0,'reassignCount',0,'note','来源最近一次成功读取不存在，无法预告');
 END IF;
 -- 与 027 shipment_mapping_apply_core 相同的命中集合（只读，不加行锁）。
 WITH hits AS (
  SELECT i.id,i.product_id,i.association_method,s.ticket_no,
   (i.product_id IS NULL AND i.association_method IS NULL) AS is_unbound,
   (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
     AND catalog.shipment_mapping_lookup(i.source_key,i.product_name_norm,s.market)
       IS DISTINCT FROM i.product_id) AS is_reassign
  FROM catalog.shipment_item i
  JOIN catalog.shipment s ON s.id=i.shipment_id
  WHERE i.source_key=v_item.source_key
    AND i.product_name_norm=v_norm
    AND s.market=v_market
    AND i.last_seen_snapshot_id=v_latest
    AND i.id<>p_item_id
    AND (
      (i.product_id IS NULL AND i.association_method IS NULL)
      OR (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
        AND catalog.shipment_mapping_lookup(i.source_key,i.product_name_norm,s.market)
          IS DISTINCT FROM i.product_id)
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
  'productNameRaw',v_raw,'matchingCount',v_matching,'ticketCount',v_ticket,
  'sampleTickets',v_samples,'unboundCount',v_unbound,'reassignCount',v_reassign,'note',NULL);
END $$;

REVOKE ALL ON FUNCTION catalog.read_shipment_association_rule_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_shipment_association_rule_preview(uuid) TO ice_p0_02_app_runner;

RESET ROLE;
