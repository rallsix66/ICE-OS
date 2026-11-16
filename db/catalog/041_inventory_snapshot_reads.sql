-- ICE catalog 041: 海外库存「历史快照」只读读取（批次分页 + 明确批次明细）。
--
-- 合同：docs/tasks/inventory-snapshot-v1.md
--   * 复用 catalog.inventory_batch / catalog.inventory_batch_row，不建表、不改 016-040；
--   * 历史归属只用批次保存的 item_id / mapping_id / item_revision 与 batch.mapping_snapshot，
--     不用当前 inventory_sku_mapping 重新解释历史；
--   * 未绑定 SKU（inventory_batch_row.item_id IS NULL）同样返回，数量原样保留；
--   * 真实 0 原样返回 0，缺失保持 null（页面显示「未提供」，不写 0）；
--   * 采集时间统一取 inventory_batch.observation_at；
--   * 批次列表按 observation_at DESC, published_at DESC, id DESC 分页（p_limit 1-200，offset 超出
--     末页时回退到最后一页），同时返回 batchTotal/offset，页面可翻到任意更早批次；
--   * 明细按 excel_row 升序分页（p_limit 1-200），搜索只按来源外部 SKU（ILIKE）；
--   * 明确批次（p_batch）独立读取，不依赖它是否落在当前批次列表页：
--       - p_warehouse 为空 = 不校验所属仓；非空时与批次实际仓库比对；
--       - 批次不存在/不在本账号 -> status='not_found'（不返回任何数量，也不退回最新批次）；
--       - 批次存在但不属于 p_warehouse -> status='warehouse_mismatch'（返回实际仓库供页面提示）；
--       - 成功时额外返回 batchRank（该批在本仓倒序中的位置）与 batchTotal，页面可定位列表页；
--   * 只读 SECURITY DEFINER + search_path='' + require_admin；app 角色只能 EXECUTE，不授予表权限。
SET ROLE ice_p0_02_owner;

-- 旧签名（单参数批次列表 / 无仓校验明细）已被分页与明确批次语义取代，先删除避免重载歧义。
DROP FUNCTION IF EXISTS catalog.read_inventory_snapshot_batches(uuid);
DROP FUNCTION IF EXISTS catalog.read_inventory_snapshot_rows(uuid,text,integer,integer);

-- ---------------------------------------------------------------------------
-- 1. 单仓已发布批次列表（按观测时间倒序分页）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_inventory_snapshot_batches(
  p_warehouse uuid,p_limit integer,p_offset integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_aid uuid; v_wh catalog.inventory_warehouse;
 v_total integer:=0; v_limit integer; v_offset integer;
 v_batches jsonb:='[]'::jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('warehouseId',NULL,'warehouseName',NULL,'market',NULL,
   'batches','[]'::jsonb,'batchTotal',0,'offset',0,'limit',0);
 END IF;
 IF p_warehouse IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_wh FROM catalog.inventory_warehouse w
  WHERE w.id=p_warehouse AND w.account_id=v_aid;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023';
 END IF;
 v_limit:=greatest(1,least(coalesce(p_limit,50),200));
 v_offset:=greatest(0,coalesce(p_offset,0));
 SELECT count(*)::integer INTO v_total
  FROM catalog.inventory_batch b WHERE b.warehouse_id=v_wh.id;
 -- 页码超出末页时回退到最后一页（页面页码与返回批次保持一致，不伪造空批次）。
 IF v_total>0 AND v_offset>=v_total THEN
  v_offset:=((v_total-1)/v_limit)*v_limit;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'batchId',b.id,
   'observationAt',b.observation_at,
   'publishedAt',b.published_at,
   'rowCount',b.row_count,
   'adoptedCount',b.adopted_count,
   'unmappedCount',b.unmapped_count)
   ORDER BY b.observation_at DESC,b.published_at DESC,b.id DESC),'[]'::jsonb)
 INTO v_batches
 FROM (SELECT b.* FROM catalog.inventory_batch b
   WHERE b.warehouse_id=v_wh.id
   ORDER BY b.observation_at DESC,b.published_at DESC,b.id DESC
   LIMIT v_limit OFFSET v_offset) b;
 RETURN jsonb_build_object(
  'warehouseId',v_wh.id,
  'warehouseName',v_wh.external_name,
  'market',v_wh.market,
  'batches',v_batches,
  'batchTotal',v_total,
  'offset',v_offset,
  'limit',v_limit);
END $$;

-- ---------------------------------------------------------------------------
-- 2. 单批明细（历史商品归属 + 当时数量；未绑定 SKU 也返回）
--
-- p_warehouse 为空：只校验批次属于当前绑定账号，不校验仓库（页面尚未选仓的直链）。
-- p_warehouse 非空：批次必须属于该仓，否则返回 warehouse_mismatch 且不返回行/数量。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_inventory_snapshot_rows(
  p_warehouse uuid,p_batch uuid,p_search text,p_limit integer,p_offset integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_aid uuid; v_batch catalog.inventory_batch; v_wh catalog.inventory_warehouse;
 v_req catalog.inventory_warehouse;
 v_search text; v_limit integer; v_offset integer;
 v_total integer:=0; v_matched integer:=0; v_batch_total integer:=0;
 v_newer integer:=0; v_rank integer:=0; v_rows jsonb:='[]'::jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('ok',false,'status','no_account','reason','NO_BOUND_ACCOUNT');
 END IF;
 IF p_batch IS NULL THEN
  RETURN jsonb_build_object('ok',false,'status','not_found','reason','BATCH_NOT_FOUND');
 END IF;
 SELECT * INTO v_batch FROM catalog.inventory_batch b WHERE b.id=p_batch;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'status','not_found','reason','BATCH_NOT_FOUND');
 END IF;
 SELECT * INTO v_wh FROM catalog.inventory_warehouse w
  WHERE w.id=v_batch.warehouse_id AND w.account_id=v_aid;
 IF NOT FOUND THEN
  -- 其他账号的批次按不存在处理，不暴露其存在性。
  RETURN jsonb_build_object('ok',false,'status','not_found','reason','BATCH_NOT_FOUND');
 END IF;
 IF p_warehouse IS NOT NULL THEN
  SELECT * INTO v_req FROM catalog.inventory_warehouse w
   WHERE w.id=p_warehouse AND w.account_id=v_aid;
  IF NOT FOUND THEN
   RETURN jsonb_build_object('ok',false,'status','warehouse_mismatch',
    'reason','REQUESTED_WAREHOUSE_UNKNOWN',
    'requestedWarehouseId',p_warehouse,
    'batchWarehouseId',v_wh.id,
    'batchWarehouseName',v_wh.external_name,
    'batchObservationAt',v_batch.observation_at);
  END IF;
  IF v_req.id<>v_wh.id THEN
   RETURN jsonb_build_object('ok',false,'status','warehouse_mismatch',
    'reason','BATCH_WAREHOUSE_MISMATCH',
    'requestedWarehouseId',v_req.id,
    'batchWarehouseId',v_wh.id,
    'batchWarehouseName',v_wh.external_name,
    'batchObservationAt',v_batch.observation_at);
  END IF;
 END IF;
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,50),200));
 v_offset:=greatest(0,coalesce(p_offset,0));
 -- 该批在本仓倒序列表中的位置：页面据此把批次列表翻到同一页，直链与页面选择显示同一批。
 SELECT count(*)::integer INTO v_batch_total
  FROM catalog.inventory_batch b WHERE b.warehouse_id=v_wh.id;
 SELECT count(*)::integer INTO v_newer
  FROM catalog.inventory_batch b WHERE b.warehouse_id=v_wh.id
   AND (b.observation_at,b.published_at,b.id)>
       (v_batch.observation_at,v_batch.published_at,v_batch.id);
 v_rank:=v_newer+1;
 SELECT count(*)::integer INTO v_total
  FROM catalog.inventory_batch_row br WHERE br.batch_id=v_batch.id;
 SELECT count(*)::integer INTO v_matched
  FROM catalog.inventory_batch_row br
  WHERE br.batch_id=v_batch.id
    AND (v_search IS NULL OR br.external_sku ILIKE '%'||v_search||'%');
 -- 页码超出末页时回退到最后一页（页面页码与返回行保持一致，不伪造「本批未见」）。
 IF v_matched>0 AND v_offset>=v_matched THEN
  v_offset:=((v_matched-1)/v_limit)*v_limit;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'externalSku',x.external_sku,
   'gtin',x.gtin,
   'excelRow',x.excel_row,
   'status',x.status,
   'itemId',x.item_id,
   'iceCode',x.ice_code,
   'nameCn',x.name_cn,
   'itemRevision',x.item_revision,
   'mappingId',x.mapping_id,
   'mappingVersion',x.mapping_version,
   'unit',x.unit,
   'onHand',x.on_hand,
   'orderLocked',x.order_locked,
   'warehouseAvailable',x.warehouse_available,
   'observationAt',x.observation_at)
   ORDER BY x.excel_row),'[]'::jsonb)
 INTO v_rows
 FROM (
  SELECT br.external_sku,br.gtin,br.excel_row,br.status,br.item_id,
    (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=br.item_id) AS ice_code,
    coalesce(
      (SELECT r.name_cn FROM catalog.item_revision r
        WHERE r.item_id=br.item_id AND r.revision=br.item_revision),
      (SELECT r.name_cn FROM catalog.item_current ic
        JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
        WHERE ic.item_id=br.item_id)) AS name_cn,
    br.item_revision,br.mapping_id,
    (SELECT CASE WHEN m->>'version' ~ '^[0-9]+$' THEN (m->>'version')::integer END
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(v_batch.mapping_snapshot->'mappings')='array'
          THEN v_batch.mapping_snapshot->'mappings' ELSE '[]'::jsonb END) m
      WHERE m->>'mappingId'=br.mapping_id::text
      LIMIT 1) AS mapping_version,
    br.unit,br.on_hand,br.order_locked,br.warehouse_available,br.observation_at
  FROM catalog.inventory_batch_row br
  WHERE br.batch_id=v_batch.id
    AND (v_search IS NULL OR br.external_sku ILIKE '%'||v_search||'%')
  ORDER BY br.excel_row
  LIMIT v_limit OFFSET v_offset
 ) x;
 RETURN jsonb_build_object(
  'ok',true,
  'status','ok',
  'batch',jsonb_build_object(
    'batchId',v_batch.id,
    'warehouseId',v_wh.id,
    'warehouseName',v_wh.external_name,
    'market',v_wh.market,
    'observationAt',v_batch.observation_at,
    'publishedAt',v_batch.published_at,
    'rowCount',v_batch.row_count,
    'adoptedCount',v_batch.adopted_count,
    'unmappedCount',v_batch.unmapped_count),
  'batchRank',v_rank,
  'batchTotal',v_batch_total,
  'search',v_search,
  'total',v_total,
  'matched',v_matched,
  'offset',v_offset,
  'limit',v_limit,
  'rows',v_rows);
END $$;

REVOKE ALL ON FUNCTION catalog.read_inventory_snapshot_batches(uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_inventory_snapshot_rows(uuid,uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 catalog.read_inventory_snapshot_batches(uuid,integer,integer),
 catalog.read_inventory_snapshot_rows(uuid,uuid,text,integer,integer)
 TO ice_p0_02_app_runner;

RESET ROLE;
