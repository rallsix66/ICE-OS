-- ICE catalog 032: 商品在途 RPC 改为「逐条明细」返回（第十轮收尾补修，R11）。
--
-- 背景：031 按票把同商品多条明细先 sum 再判断，只要一条 received_quantity 为 NULL/冲突，
-- 整票该商品就变成「待核」，已知的另一条剩余被漏算。R11 要求：先逐条计算已知剩余/待核/
-- 数量冲突，再按票合成一行；已知的照常计入，只排除未知或冲突的那条。
--
-- 本增量只 CREATE OR REPLACE 同一个只读函数（不改 026–031 文件）：
--   * 逐票返回票级信息 + items[]（每条当前商品明细：itemId、发货量、采用累计已上架、
--     manualConflict、manualCorrected）；剩余/待核/合计由应用层 product-transit.ts 按条计算。
--   * 票与明细的当前范围、排序、权限与 031 完全一致：
--       i.last_seen_snapshot_id = s.last_seen_snapshot_id = 最近一次成功快照；
--       i.product_id = p_item_id；只取 app 角色可执行、require_admin 通过。
--   * 没有成功快照时 tickets=[]、latestReadAt/snapshotId 为 NULL（不伪造）。
--
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
   'ticketItemCount',x.ticket_item_count,
   'items',x.items
  ) ORDER BY x.ticket_no),'[]'::jsonb)
 INTO v_tickets
 FROM (
  SELECT s.id AS shipment_id,
   s.ticket_no,s.purchase_order,s.market,s.waybills_text,s.status_class,
   catalog.shipment_effective_status_class(s.id) AS effective_status_class,
   s.transport_text,s.arrival_text,
   (SELECT count(*)::int FROM catalog.shipment_item t
    WHERE t.shipment_id=s.id AND t.last_seen_snapshot_id=v_latest) AS ticket_item_count,
   -- 同票同商品全部当前明细逐条返回；剩余与待核由应用层按条计算后再合成一行。
   (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'itemId',i.id,
      'shippedQuantity',i.shipped_quantity,
      'receivedQuantity',i.received_quantity,
      'manualConflict',catalog.shipment_manual_quantity_conflict(i.id),
      'manualCorrected',i.manual_status IS NOT NULL
     ) ORDER BY i.sort_index,i.id),'[]'::jsonb)
    FROM catalog.shipment_item i
    WHERE i.shipment_id=s.id AND i.product_id=p_item_id
     AND i.last_seen_snapshot_id=v_latest) AS items
  FROM catalog.shipment s
  WHERE s.last_seen_snapshot_id=v_latest
   AND s.source_key=v_source
   AND EXISTS (SELECT 1 FROM catalog.shipment_item i
    WHERE i.shipment_id=s.id AND i.product_id=p_item_id
     AND i.last_seen_snapshot_id=v_latest)
 ) x;
 RETURN jsonb_build_object('productId',p_item_id,'latestReadAt',v_latest_at,
  'snapshotId',v_latest,'tickets',v_tickets);
END $$;

REVOKE ALL ON FUNCTION catalog.read_product_shipment_in_transit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_product_shipment_in_transit(uuid)
 TO ice_p0_02_app_runner;

RESET ROLE;
