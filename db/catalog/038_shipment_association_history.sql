-- ICE catalog 038: 物流在途「旧票人工选择」只读投影。
--
-- 合同：物流在途货值汇总的「未计入明细 → 关联商品」建议必须来自真实的人工选择记录，
-- 而不是猜测。当前 028 只返回最近一次成功快照里的明细；同一品名在**旧票**上人工确认过的
-- 商品（例如新票 POKNZX027667 的四个唇膏色号 ← 旧票 POKNZX027378 的人工选择）不在其中，
-- 因此新增本只读函数，按「市场 + 规范化品名」取历史人工确认（association_method='manual_selected'）。
--
-- 口径（不得违反）：
--   * 只返回人工选择记录（manual_selected），自动匹配不进入「人工确认过」建议；
--   * 只返回商品身份（货号/品名）与来源票号、确认时间，不返回任何价格/数量/受限字段；
--   * 每个 (市场, 品名) 最多 3 款商品，按最近人工确认排序；同一款商品合并为一条并给确认次数；
--   * 只读 SECURITY DEFINER + require_admin；app 角色只能 EXECUTE，不授予表权限；
--   * 幂等（CREATE OR REPLACE），不改 026/027/028 已发布内容。
SET ROLE ice_p0_02_owner;

CREATE OR REPLACE FUNCTION catalog.read_shipment_association_history(p_pairs jsonb) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_pairs jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_pairs IS NULL OR jsonb_typeof(p_pairs)<>'array' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:pairs' USING ERRCODE='22023';
 END IF;
 -- 只接受有界输入（页面最多传未关联明细的 市场+品名 组合）。
 v_pairs:=(SELECT coalesce(jsonb_agg(p),'[]'::jsonb) FROM
   (SELECT p FROM jsonb_array_elements(p_pairs) p LIMIT 400) s(p));
 RETURN coalesce((
  WITH req AS (
   SELECT DISTINCT
     nullif(btrim(coalesce(p->>'market','')),'') AS market,
     nullif(btrim(coalesce(p->>'nameNorm','')),'') AS name_norm
   FROM jsonb_array_elements(v_pairs) p
   WHERE jsonb_typeof(p)='object'
  ), req_ok AS (
   SELECT r.market,r.name_norm FROM req r WHERE r.market IS NOT NULL AND r.name_norm IS NOT NULL
  ), hist AS (
   -- 历史明细：来源行仍在票的当前明细里（last_seen 与票一致），且是人工选择。
   SELECT s.market,i.product_name_norm AS name_norm,i.product_id,
     count(*)::integer AS confirmations,
     (array_agg(s.ticket_no ORDER BY i.associated_at DESC NULLS LAST))[1] AS ticket_no,
     max(i.associated_at) AS recorded_at
   FROM catalog.shipment s
   JOIN catalog.shipment_item i ON i.shipment_id=s.id
   WHERE i.product_id IS NOT NULL
     AND i.association_method='manual_selected'
     AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
   GROUP BY s.market,i.product_name_norm,i.product_id
  ), joined AS (
   SELECT h.market,h.name_norm,h.product_id,h.confirmations,h.ticket_no,h.recorded_at,
     c.ice_code,r.name_cn,
     row_number() OVER (PARTITION BY h.market,h.name_norm
       ORDER BY h.recorded_at DESC NULLS LAST,h.product_id) AS rn
   FROM hist h
   JOIN req_ok q ON q.market=h.market AND q.name_norm=h.name_norm
   LEFT JOIN catalog.catalog_item_code c ON c.item_id=h.product_id
   LEFT JOIN catalog.item_current ic ON ic.item_id=h.product_id
   LEFT JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
  )
  SELECT jsonb_agg(jsonb_build_object(
    'market',j.market,
    'nameNorm',j.name_norm,
    'productId',j.product_id,
    'iceCode',j.ice_code,
    'nameCn',j.name_cn,
    'ticketNo',j.ticket_no,
    'manual',true,
    'confirmations',j.confirmations,
    'recordedAt',j.recorded_at)
   ORDER BY j.market,j.name_norm,j.rn)
  FROM joined j WHERE j.rn<=3
 ), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION catalog.read_shipment_association_history(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_shipment_association_history(jsonb) TO ice_p0_02_app_runner;

RESET ROLE;
