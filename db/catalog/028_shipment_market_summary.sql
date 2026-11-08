-- ICE catalog 028: 物流在途「在途汇总」只读投影。
--
-- 合同：docs/tasks/shipment-in-transit-v1.md §13（第七轮：在途汇总）。
-- 口径（不得违反）：
--   * 范围 = 所选市场 + 最近一次成功读取的当前明细：已从来源移除的明细退出汇总；
--     整票已上架（remaining=0）仍属于当前明细，按 0 计入，不当作“未知”。
--   * 数量 = 026 已算好的「剩余在途」：只有累计到货已知且未超收才出数字；未知保留 NULL
--     + remainingState='pending'（页面列为「数量待核」），不写 0。
--   * 本函数只返回明细与票级事实，不做跨明细合计、不读价格；合计、商品分组与货值由服务端
--     读取层用商品库现有「采用进货价」口径计算（同 026/商品库列表，金额权限不新开通道）。
--   * 分页无关：一次返回该市场全部当前明细，页面翻页不改变汇总。
--   * 只读 SECURITY DEFINER + require_admin；app 角色只能 EXECUTE，不授予表权限。
--
-- 安装约定：幂等（CREATE OR REPLACE FUNCTION + 显式 REVOKE/GRANT），必须在 026/027 之后重放。
SET ROLE ice_p0_02_owner;

CREATE OR REPLACE FUNCTION catalog.read_shipment_market_summary(p_market text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_market text; v_unknown_market boolean:=false; v_source text; v_latest uuid; v_latest_at timestamptz;
BEGIN
 PERFORM catalog.require_admin();
 v_market:=nullif(btrim(coalesce(p_market,'')),'');
 IF v_market IN('all') THEN v_market:=NULL; END IF;
 IF v_market='__unknown__' THEN v_unknown_market:=true; v_market:=NULL; END IF;
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 IF v_latest IS NOT NULL THEN
  SELECT sn.read_finished_at INTO v_latest_at
  FROM catalog.shipment_source_snapshot sn WHERE sn.id=v_latest;
 END IF;
 RETURN (
  WITH scoped AS (
   -- 当前明细：票与明细都必须属于最近一次成功快照；市场按来源国家原值（未提供用哨兵）。
   SELECT s.id AS shipment_id,s.ticket_no,s.purchase_order,s.waybills_text,s.market,s.status_class,
    i.id AS item_id,i.product_name_raw,i.shipped_quantity,i.received_quantity,i.receipt_basis,
    i.product_id,i.association_status,i.sort_index
   FROM catalog.shipment s
   JOIN catalog.shipment_item i
     ON i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
   WHERE (v_latest IS NULL OR s.last_seen_snapshot_id=v_latest)
    AND CASE WHEN v_unknown_market THEN s.market IS NULL
      ELSE (v_market IS NULL OR s.market=v_market) END
  )
  SELECT jsonb_build_object(
   'market',v_market,
   'unknownMarket',v_unknown_market,
   'latestReadAt',v_latest_at,
   'snapshotId',v_latest,
   'ticketCount',(SELECT count(DISTINCT x.shipment_id) FROM scoped x),
   'itemCount',(SELECT count(*) FROM scoped x),
   'items',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'itemId',x.item_id,
     'shipmentId',x.shipment_id,
     'ticketNo',x.ticket_no,
     'purchaseOrder',x.purchase_order,
     'waybillsText',x.waybills_text,
     'market',x.market,
     'statusClass',x.status_class,
     'productId',x.product_id,
     'productNameRaw',x.product_name_raw,
     'associationStatus',x.association_status,
     'shippedQuantity',x.shipped_quantity,
     'receivedQuantity',x.received_quantity,
     'receiptBasis',x.receipt_basis,
     'remainingQuantity',CASE WHEN x.received_quantity IS NULL
        OR x.received_quantity>x.shipped_quantity THEN NULL
       ELSE x.shipped_quantity-x.received_quantity END,
     'remainingState',CASE WHEN x.received_quantity IS NULL
        OR x.received_quantity>x.shipped_quantity THEN 'pending' ELSE 'known' END)
     ORDER BY x.product_id NULLS LAST,x.ticket_no,x.sort_index,x.item_id),'[]'::jsonb)
    FROM scoped x)
  ));
END $$;

REVOKE ALL ON FUNCTION catalog.read_shipment_market_summary(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_shipment_market_summary(text) TO ice_p0_02_app_runner;

RESET ROLE;
