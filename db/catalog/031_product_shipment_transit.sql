-- ICE catalog 031: 商品详情「关联货票」在途数据层（第十轮）。
--
-- 合同：.local/shipment-v1-r10-20261105/（Lead R10 任务；本轮只加一个只读 RPC，不改 026–030）。
--
-- 范围与口径：
--   * 只取「最近一次成功读取」还在的票与明细：i.last_seen_snapshot_id = s.last_seen_snapshot_id
--     = catalog.shipment_latest_success_snapshot(当前来源)。已从来源移除的票/明细不进入。
--   * 只取 i.product_id = p_item_id 的明细（同票其它商品一律不参与，不混入合计）。
--   * 按 shipment 聚合成一票一行：
--       shippedQuantity  = sum(该票该商品明细的 shipped_quantity)
--       receivedQuantity = 任一明细 received_quantity 为 NULL → NULL（待核），否则 sum（人工修正后的生效值）
--       manualConflict   = bool_or(catalog.shipment_manual_quantity_conflict(i.id))
--       manualCorrected  = bool_or(manual_status IS NOT NULL)
--       itemCount        = 该票该商品的明细条数
--       ticketItemCount  = 该票当前明细总条数（含其它商品，用于页面说明“同票 N 条”）
--       effectiveStatusClass = catalog.shipment_effective_status_class(s.id)（030：人工状态优先）
--   * 返回 {productId, latestReadAt, snapshotId, tickets:[...] 按 ticket_no 排序}；
--     没有成功快照时 tickets=[]、latestReadAt/snapshotId 为 NULL（不是 0 或假数据）。
--
-- 安全模式与 026–030 一致：owner 建函数、SECURITY DEFINER + search_path=''、
-- 先 PERFORM catalog.require_admin()；只读（STABLE），只给 app 角色 EXECUTE。
-- 安装约定：幂等（CREATE OR REPLACE / 显式 REVOKE·GRANT），末尾 RESET ROLE。
SET ROLE ice_p0_02_owner;

CREATE OR REPLACE FUNCTION catalog.read_product_shipment_in_transit(p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_source text; v_latest uuid; v_latest_at timestamptz; v_tickets jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_item_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:itemId' USING ERRCODE='22023'; END IF;
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 -- 没有成功读取：如实返回空（页面显示“还没有读取过来源”），不伪造时间与票。
 IF v_latest IS NULL THEN
  RETURN jsonb_build_object('productId',p_item_id,'latestReadAt',NULL,
   'snapshotId',NULL,'tickets','[]'::jsonb);
 END IF;
 SELECT sn.read_finished_at INTO v_latest_at
 FROM catalog.shipment_source_snapshot sn WHERE sn.id=v_latest;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'shipmentId',x.shipment_id,
   'ticketNo',x.ticket_no,
   'purchaseOrder',x.purchase_order,
   'market',x.market,
   'waybillsText',x.waybills_text,
   'statusClass',x.status_class,
   'effectiveStatusClass',x.effective_status_class,
   'transportText',x.transport_text,
   'arrivalText',x.arrival_text,
   'shippedQuantity',x.shipped_quantity,
   'receivedQuantity',x.received_quantity,
   'manualConflict',x.manual_conflict,
   'manualCorrected',x.manual_corrected,
   'itemCount',x.item_count,
   'ticketItemCount',x.ticket_item_count
  ) ORDER BY x.ticket_no),'[]'::jsonb)
 INTO v_tickets
 FROM (
  SELECT s.id AS shipment_id,
   s.ticket_no,s.purchase_order,s.market,s.waybills_text,s.status_class,
   catalog.shipment_effective_status_class(s.id) AS effective_status_class,
   s.transport_text,s.arrival_text,
   sum(i.shipped_quantity) AS shipped_quantity,
   -- 任一明细未知 → 整票该商品合计未知（不把部分已知当合计，也不写 0）
   CASE WHEN count(*) FILTER (WHERE i.received_quantity IS NULL)>0 THEN NULL
    ELSE sum(i.received_quantity) END AS received_quantity,
   coalesce(bool_or(catalog.shipment_manual_quantity_conflict(i.id)),false) AS manual_conflict,
   coalesce(bool_or(i.manual_status IS NOT NULL),false) AS manual_corrected,
   count(*)::int AS item_count,
   (SELECT count(*)::int FROM catalog.shipment_item t
    WHERE t.shipment_id=s.id AND t.last_seen_snapshot_id=v_latest) AS ticket_item_count
  FROM catalog.shipment_item i
  JOIN catalog.shipment s ON s.id=i.shipment_id
  WHERE i.product_id=p_item_id
   AND i.last_seen_snapshot_id=v_latest
   AND s.last_seen_snapshot_id=v_latest
   AND s.source_key=v_source
  GROUP BY s.id
 ) x;
 RETURN jsonb_build_object('productId',p_item_id,'latestReadAt',v_latest_at,
  'snapshotId',v_latest,'tickets',v_tickets);
END $$;

REVOKE ALL ON FUNCTION catalog.read_product_shipment_in_transit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_product_shipment_in_transit(uuid)
 TO ice_p0_02_app_runner;

RESET ROLE;
