-- ICE catalog 024: 详情内绑定编辑（UI-1 / UI-2 / DATA-1 绑定写入）所需的最小数据库增量。
--
-- 合同：docs/tasks/catalog-binding-inline-edit-v1.md §3 UI-1/UI-2/UI-3、§4 DATA-1、§5 实现重点。
--
-- 只做四件事，不建表、不改 00001-023、不改 inventory_schema_state.version：
--   1. catalog.read_item_binding_rows(p_item)
--        商品库详情“库存明细”内按仓列出现有 BS 绑定（当前 confirmed/recheck/disabled 的最新版本），
--        并返回参与仓清单（含未绑定仓）与采用状态（adopted/pending_adoption/inactive/unseen）；
--        已停用/历史映射行取该映射最后实际被采用的批次数量与观测时间（R4，不套用新归属最新批次）。
--   2. catalog.search_inventory_source_items(p_warehouse,p_search,p_limit)
--        在指定仓的“最后完整成功批次”全部来源行内搜索（已绑定/未绑定/零库存都返回），
--        带当前映射与绑定商品，供“固定商品 A、仓库 W，搜索 S2”使用；不按相似仓名/前缀猜。
--   3. catalog.read_inventory_source_binding(p_warehouse,p_external_sku)
--        固定来源（仓+SKU）读当前对应、最新来源行与采用状态，供库存仓库行详情显示“绑定的商品库商品”。
--   4. catalog.replace_inventory_mapping(...)
--        单事务完成 S1 退出 + 目标 S2 绑定到 A：旧关系立即 disabled（退出当前汇总），
--        新关系 confirmed 但库存等下一次完整成功批次采用；S2 已绑定 A 时只退出 S1、不重复建版本；
--        S2 已绑定 C 时按页面所见版本把 S2 转给 A；整笔失败不产生半次替换。
--        复用既有 inventory_request / pending / 审计 / 版本校验语义，不另建平台。
--   5. catalog.search_inventory_items_v2(p_search,p_limit)
--        目标商品搜索的只读扩展：在 016 同名语义上补充“规格”原文（无则 null），不伪造色号。
--
-- 安全模式与 016/022 一致：SET ROLE owner 建函数，SECURITY DEFINER + search_path=''，
-- 入口 PERFORM catalog.require_admin()（启用中的管理员 JWT），账号固定 inventory_bound_account_id()。
-- 只读函数是 STABLE，不写表；replace 写函数复用 016 的请求登记/锁/审计函数。

SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 商品库详情：该商品逐仓绑定（含未绑定仓清单与采用状态）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_item_binding_rows(p_item uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope_json jsonb; v_scope uuid[]:='{}'::uuid[];
 v_warehouses jsonb; v_bindings jsonb;
BEGIN
 PERFORM catalog.require_admin();
 IF p_item IS NULL THEN RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:itemId' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.catalog_item i WHERE i.id=p_item) THEN
  RAISE EXCEPTION 'INVENTORY_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('item',catalog.inventory_item_identity(p_item),
   'warehouses','[]'::jsonb,'bindings','[]'::jsonb); END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid
    AND w.id=ANY(ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(
      coalesce(v_scope_json->'warehouseIds','[]'::jsonb)) x))
    AND w.status='confirmed'
   ORDER BY w.external_warehouse_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseId',w.id,'externalId',w.external_warehouse_id,'name',w.external_name,
   'market',w.market,'lastSuccessAt',rs.last_success_at,'lastBatchId',rs.last_batch_id,
   'failed',coalesce(rs.failed,false),'stale',coalesce(rs.stale,false))
   ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_warehouses
 FROM catalog.inventory_warehouse w
 LEFT JOIN catalog.inventory_warehouse_read_state(v_aid,v_scope) rs ON rs.warehouse_id=w.id
 WHERE w.account_id=v_aid AND w.id=ANY(v_scope);

 -- 每个 (仓,SKU) 只取最新版本（不限状态），页面按状态决定是否可“更换绑定”。
 -- 事实来源（R4）：当前 confirmed 对应显示本仓最后完整成功批次的最新来源行（待采用语义）；
 -- 已停用/历史映射行显示该映射最后实际被采用的那条批次行（原数量/原观测时间），
 -- 不能按同仓同 SKU 套用新归属的最新批次，否则旧归属会串用新数量/新时间。
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseId',m.warehouse_id,
   'warehouseExternalId',w.external_warehouse_id,
   'warehouseName',w.external_name,
   'market',w.market,
   'externalSku',m.external_sku,
   'sourceName',nullif(btrim(coalesce(rr.product_name,'')),''),
   'gtin',br.gtin,
   'unit',m.unit,
   'mappingId',m.id,
   'mappingVersion',m.version,
   'mappingStatus',m.status,
   'onHand',CASE WHEN m.status='confirmed' THEN br.on_hand ELSE af.on_hand END,
   'observedAt',CASE WHEN m.status='confirmed'
     THEN coalesce(br.observation_at,b.observation_at)
     ELSE af.observed_at END,
   -- 与 022 权威口径一致：只有“本批采用时使用的对应版本”仍 confirmed 才算 adopted；
   -- 换绑后旧批次采用的是旧映射（已 disabled），显示为 inactive（保留原数量/原时间），
   -- 不能把旧批次数量改名成新商品或提前显示“已计入”。
   'adoption',CASE
     WHEN m.status='confirmed'
       AND af.batch_id IS NOT NULL AND af.batch_id=st.last_batch_id THEN 'adopted'
     WHEN m.status='confirmed' THEN 'pending_adoption'
     ELSE 'inactive' END)
   ORDER BY w.external_warehouse_id, m.external_sku),'[]'::jsonb)
 INTO v_bindings
 FROM (
   SELECT DISTINCT ON (mm.warehouse_id,mm.external_sku) mm.*
   FROM catalog.inventory_sku_mapping mm
   WHERE mm.account_id=v_aid AND mm.item_id=p_item AND mm.warehouse_id IS NOT NULL
   ORDER BY mm.warehouse_id, mm.external_sku, mm.version DESC, mm.created_at DESC
 ) m
 JOIN catalog.inventory_warehouse w ON w.id=m.warehouse_id AND w.account_id=v_aid
 LEFT JOIN catalog.inventory_warehouse_read_state(v_aid,v_scope) st ON st.warehouse_id=m.warehouse_id
 LEFT JOIN catalog.inventory_batch b ON b.id=st.last_batch_id
 LEFT JOIN catalog.inventory_batch_row br ON br.batch_id=b.id AND br.external_sku=m.external_sku
 -- 该映射最后实际被采用的批次行（跨批次取最新；历史事实只读，不回写旧批次）。
 LEFT JOIN LATERAL (
   SELECT br2.batch_id,br2.on_hand,coalesce(br2.observation_at,b2.observation_at) AS observed_at
   FROM catalog.inventory_batch_row br2
   JOIN catalog.inventory_batch b2 ON b2.id=br2.batch_id
   WHERE br2.mapping_id=m.id AND br2.status='adopted'
   ORDER BY b2.observation_at DESC,b2.published_at DESC,b2.id DESC
   LIMIT 1
 ) af ON true
 LEFT JOIN catalog.inventory_run_row rr ON rr.run_id=b.run_id AND rr.excel_row=br.excel_row;
 RETURN jsonb_build_object('item',catalog.inventory_item_identity(p_item),
  'warehouses',coalesce(v_warehouses,'[]'::jsonb),'bindings',coalesce(v_bindings,'[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 2. 指定仓来源搜索：最后完整成功批次的全部来源行（已绑定/未绑定/零库存）
--    p_search 匹配 来源 SKU / 来源原品名 / 69 编码 / 已绑定商品货号或名称。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.search_inventory_source_items(p_warehouse uuid,
 p_search text,p_limit integer DEFAULT 20) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope uuid[]:='{}'::uuid[]; v_wh catalog.inventory_warehouse;
 v_rs record; v_batch uuid; v_search text; v_limit integer; v_rows jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL OR p_warehouse IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
 v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid AND w.status='confirmed');
 IF NOT(p_warehouse=ANY(v_scope)) THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_wh FROM catalog.inventory_warehouse w WHERE w.id=p_warehouse;
 SELECT * INTO v_rs FROM catalog.inventory_warehouse_read_state(v_aid,v_scope) s
  WHERE s.warehouse_id=p_warehouse;
 v_batch:=v_rs.last_batch_id;
 -- 没有完整成功批次：返回空集（页面显示“该仓暂无完整来源批次”），不伪造来源。
 IF v_batch IS NULL THEN RETURN '[]'::jsonb; END IF;
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,20),50));
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'externalSku',x.external_sku,'sourceName',x.source_name,'onHand',x.on_hand,'unit',x.unit,
   'gtin',x.gtin,'excelRow',x.excel_row,'observedAt',x.observation_at,
   'mappingId',x.mapping_id,'mappingVersion',x.mapping_version,'mappingStatus',x.mapping_status,
   'boundItemId',x.bound_item_id,'boundIceCode',x.bound_ice_code,'boundNameCn',x.bound_name_cn)
   ORDER BY x.external_sku),'[]'::jsonb)
 INTO v_rows
 FROM (
  SELECT br.external_sku,
   nullif(btrim(coalesce(rr.product_name,'')),'') AS source_name,
   br.on_hand,br.unit,br.gtin,br.excel_row,b.observation_at,
   m.id AS mapping_id,m.version AS mapping_version,m.status AS mapping_status,
   bi.id AS bound_item_id,
   (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=bi.id) AS bound_ice_code,
   (SELECT r.name_cn FROM catalog.item_current ic
     JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
     WHERE ic.item_id=bi.id) AS bound_name_cn
  FROM catalog.inventory_batch_row br
  JOIN catalog.inventory_batch b ON b.id=br.batch_id
  LEFT JOIN catalog.inventory_run_row rr ON rr.run_id=b.run_id AND rr.excel_row=br.excel_row
  LEFT JOIN LATERAL (
    SELECT mm.* FROM catalog.inventory_sku_mapping mm
    WHERE mm.account_id=v_aid AND mm.warehouse_id=p_warehouse AND mm.external_sku=br.external_sku
    ORDER BY mm.version DESC, mm.created_at DESC LIMIT 1
  ) m ON true
  LEFT JOIN catalog.catalog_item bi ON bi.id=m.item_id
  WHERE br.batch_id=v_batch
   AND (v_search IS NULL
     OR br.external_sku ILIKE '%'||v_search||'%'
     OR coalesce(rr.product_name,'') ILIKE '%'||v_search||'%'
     OR coalesce(br.gtin,'') ILIKE '%'||v_search||'%'
     OR coalesce((SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=bi.id),'')
        ILIKE '%'||v_search||'%'
     OR coalesce((SELECT r2.name_cn FROM catalog.item_current ic2
        JOIN catalog.item_revision r2 ON r2.item_id=ic2.item_id AND r2.revision=ic2.revision
        WHERE ic2.item_id=bi.id),'') ILIKE '%'||v_search||'%')
  ORDER BY br.external_sku LIMIT v_limit
 ) x;
 RETURN coalesce(v_rows,'[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- 3. 固定来源（仓 + SKU）读当前对应、最新来源行与采用状态（库存仓库行详情用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_inventory_source_binding(p_warehouse uuid,
 p_external_sku text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope uuid[]:='{}'::uuid[]; v_wh catalog.inventory_warehouse;
 v_rs record; v_sku text; v_map catalog.inventory_sku_mapping; v_row record;
 v_item_ident jsonb; v_adoption text;
BEGIN
 PERFORM catalog.require_admin();
 v_sku:=nullif(btrim(coalesce(p_external_sku,'')),'');
 IF v_sku IS NULL THEN RAISE EXCEPTION 'INVENTORY_INVALID_INPUT:externalSku' USING ERRCODE='22023'; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RETURN NULL; END IF;
 v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid AND w.status='confirmed');
 IF p_warehouse IS NULL OR NOT(p_warehouse=ANY(v_scope)) THEN
  RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_wh FROM catalog.inventory_warehouse w WHERE w.id=p_warehouse;
 SELECT * INTO v_rs FROM catalog.inventory_warehouse_read_state(v_aid,v_scope) s
  WHERE s.warehouse_id=p_warehouse;
 SELECT br.on_hand,br.unit,br.gtin,br.excel_row,b.observation_at,
  br.status AS row_status,br.mapping_id AS row_mapping_id
 INTO v_row
 FROM catalog.inventory_batch_row br
 JOIN catalog.inventory_batch b ON b.id=br.batch_id
 WHERE br.batch_id=v_rs.last_batch_id AND br.external_sku=v_sku;
 SELECT * INTO v_map FROM catalog.inventory_sku_mapping m
 WHERE m.account_id=v_aid AND m.warehouse_id=p_warehouse AND m.external_sku=v_sku
 ORDER BY m.version DESC, m.created_at DESC LIMIT 1;
 IF v_map.id IS NOT NULL THEN v_item_ident:=catalog.inventory_item_identity(v_map.item_id); END IF;
 -- 采用状态按本仓最后完整批次的真实事实判断（不能对已采用行固定写“待采用”）：
 -- 本批采用的就是该映射且仍 confirmed → adopted；否则 confirmed 等待下一批 → pending_adoption；
 -- 映射已停用/重核（历史行）→ inactive，仍保留该行本批来源数量/时间。
 IF v_map.id IS NULL THEN v_adoption:=NULL;
 ELSIF v_map.status='confirmed' AND v_row.row_status='adopted' AND v_row.row_mapping_id=v_map.id
  THEN v_adoption:='adopted';
 ELSIF v_map.status='confirmed' THEN v_adoption:='pending_adoption';
 ELSE v_adoption:='inactive'; END IF;
 RETURN jsonb_build_object(
  'warehouseId',v_wh.id,'warehouseExternalId',v_wh.external_warehouse_id,
  'warehouseName',v_wh.external_name,'market',v_wh.market,
  'externalSku',v_sku,
  'unit',coalesce(v_map.unit,v_row.unit),
  'onHand',v_row.on_hand,
  'gtin',coalesce(v_row.gtin,NULL),
  'observedAt',v_row.observation_at,
  'adoption',v_adoption,
  'mapping',CASE WHEN v_map.id IS NULL THEN NULL ELSE jsonb_build_object(
    'mappingId',v_map.id,'version',v_map.version,'status',v_map.status,
    'itemId',v_map.item_id,'iceCode',v_item_ident->'iceCode','nameCn',v_item_ident->'nameCn') END);
END $$;

-- ---------------------------------------------------------------------------
-- 4. 目标商品搜索 v2：016 search_inventory_items 语义 + 规格原文（可空）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.search_inventory_items_v2(p_search text,p_limit integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_search text; v_limit integer; v_items jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,20),50));
 SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',t.item_id,'iceCode',t.ice_code,
   'nameCn',t.name_cn,'gtin',t.gtin,'specification',t.specification,'unit',t.unit)
   ORDER BY t.ice_code NULLS LAST, t.item_id),'[]'::jsonb)
 INTO v_items FROM (
  SELECT i.id AS item_id,
   (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.id) AS ice_code,
   (SELECT r.name_cn FROM catalog.item_current ic JOIN catalog.item_revision r
     ON r.item_id=ic.item_id AND r.revision=ic.revision WHERE ic.item_id=i.id) AS name_cn,
   (SELECT br.gtin FROM catalog.inventory_batch_row br JOIN catalog.inventory_batch b ON b.id=br.batch_id
     WHERE br.item_id=i.id AND br.gtin IS NOT NULL
     ORDER BY b.published_at DESC, b.id DESC LIMIT 1) AS gtin,
   (SELECT nullif(btrim(coalesce(r.fields->'specification'->>'raw','')),'')
     FROM catalog.item_current ic JOIN catalog.item_revision r
       ON r.item_id=ic.item_id AND r.revision=ic.revision
     WHERE ic.item_id=i.id) AS specification,
    -- 该商品已确认的默认单位：绑定时直接沿用，避免“个/件”标签冲突让用户反复填单位。
    (SELECT v.unit FROM catalog.inventory_variant v
      WHERE v.item_id=i.id AND v.variant_key='default') AS unit
  FROM catalog.catalog_item i
  WHERE v_search IS NULL
   OR EXISTS(SELECT 1 FROM catalog.catalog_item_code c
     WHERE c.item_id=i.id AND c.ice_code ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.item_current ic JOIN catalog.item_revision r
     ON r.item_id=ic.item_id AND r.revision=ic.revision
     WHERE ic.item_id=i.id AND r.name_cn ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.inventory_batch_row br
     WHERE br.item_id=i.id AND coalesce(br.gtin,'') ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.inventory_sku_mapping m
     WHERE m.item_id=i.id AND m.external_sku ILIKE '%'||v_search||'%')
  ORDER BY ice_code NULLS LAST, i.id LIMIT v_limit) t;
 RETURN v_items;
END $$;

-- ---------------------------------------------------------------------------
-- 5. 单事务替换绑定：S1 退出 + S2 绑定到 A（固定商品/仓库，来源版本校验）
--    - 旧关系 S1 立即 disabled（退出当前汇总，历史批次保留原事实）；
--    - S2 若无对应：新建 confirmed v1；若对应已存在（其他商品/停用/待重核）：按页面所见版本 supersede；
--    - S2 已 confirmed 到同一商品 A：只退出 S1，保持 S2 现有关系与版本（不报错、不重复建）；
--    - 任一校验失败整笔回滚，不会产生半次替换；
--    - 复用 inventory_request 幂等回执、pending 写锁、inventory_audit 审计。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.replace_inventory_mapping(p_request uuid,p_intent text,
 p_old_mapping_id uuid,p_old_expected_version integer,p_item uuid,p_new_sku text,
 p_unit text,p_reason text,p_note text,p_new_expected_version integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_prior jsonb; v_aid uuid; v_old catalog.inventory_sku_mapping;
 v_wh uuid; v_sku text; v_unit text; v_reason text; v_note text; v_payload jsonb;
 v_variant uuid; v_variant_key text:='default';
 v_new catalog.inventory_sku_mapping; v_new_id uuid; v_new_version integer:=NULL; v_supersedes uuid;
 v_released_only boolean:=false; v_result jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_payload:=jsonb_build_object(
  'oldMappingId',p_old_mapping_id,'expectedOldVersion',p_old_expected_version,
  'itemId',p_item,'newExternalSku',p_new_sku,'expectedNewVersion',p_new_expected_version,
  'unit',p_unit,'reason',p_reason,'note',p_note);
 v_prior:=catalog.inventory_request_prior(p_request,p_intent,'replace_inventory_mapping',v_payload);
 IF v_prior IS NOT NULL THEN RETURN v_prior; END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RAISE EXCEPTION 'INVENTORY_ACCOUNT_MISSING' USING ERRCODE='22023'; END IF;
 PERFORM catalog.inventory_block_if_pending(v_aid,p_request,v_actor,'replace_inventory_mapping',
  p_intent,v_payload);
 v_sku:=nullif(btrim(coalesce(p_new_sku,'')),'');
 v_unit:=nullif(btrim(coalesce(p_unit,'')),'');
 v_reason:=nullif(btrim(coalesce(p_reason,'')),'');
 v_note:=nullif(btrim(coalesce(p_note,'')),'');
 IF p_request IS NULL OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$'
  OR p_old_mapping_id IS NULL OR p_old_expected_version IS NULL OR p_old_expected_version<=0
  OR p_item IS NULL OR v_sku IS NULL OR v_unit IS NULL OR v_reason IS NULL
  OR length(v_sku)>200 OR length(v_unit)>20 OR length(v_reason)>500
  OR length(coalesce(v_note,''))>500 THEN
  RAISE EXCEPTION 'INVENTORY_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.catalog_item i WHERE i.id=p_item) THEN
  RAISE EXCEPTION 'INVENTORY_ITEM_NOT_FOUND' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory.mapping:'||v_aid::text,944));
 SELECT * INTO v_old FROM catalog.inventory_sku_mapping m WHERE m.id=p_old_mapping_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVENTORY_MAPPING_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_old.account_id<>v_aid OR v_old.warehouse_id IS NULL THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_old.version<>p_old_expected_version THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF v_old.status<>'confirmed' THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_NOT_CONFIRMED' USING ERRCODE='22023'; END IF;
 IF v_old.item_id<>p_item THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_ITEM_MISMATCH' USING ERRCODE='22023'; END IF;
 v_wh:=v_old.warehouse_id;
 IF v_old.external_sku=v_sku THEN
  RAISE EXCEPTION 'INVENTORY_MAPPING_UNCHANGED' USING ERRCODE='22023'; END IF;
 -- 目标 SKU 必须是该仓最后完整成功批次里的真实来源行，不接受任意字符串。
 IF NOT EXISTS(
   SELECT 1 FROM catalog.inventory_warehouse_read_state(v_aid,ARRAY[v_wh]) st
   JOIN catalog.inventory_batch_row br ON br.batch_id=st.last_batch_id AND br.external_sku=v_sku
   WHERE st.warehouse_id=v_wh) THEN
  RAISE EXCEPTION 'INVENTORY_SOURCE_UNKNOWN' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_new FROM catalog.inventory_sku_mapping m
  WHERE m.account_id=v_aid AND m.warehouse_id=v_wh AND m.external_sku=v_sku
  ORDER BY m.version DESC, m.created_at DESC LIMIT 1 FOR UPDATE;
 IF v_new.id IS NOT NULL THEN
  IF p_new_expected_version IS NULL OR p_new_expected_version<>v_new.version THEN
   RAISE EXCEPTION 'INVENTORY_MAPPING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF v_new.status='confirmed' AND v_new.item_id=p_item THEN
   -- 目标已经就是 A：只退出 S1，保持 S2 现有关系与版本。
   v_released_only:=true;
  ELSE
   v_supersedes:=v_new.id; v_new_version:=v_new.version+1;
   IF v_new.status='confirmed' THEN
    UPDATE catalog.inventory_sku_mapping SET status='disabled' WHERE id=v_new.id; END IF;
  END IF;
 ELSE
  IF p_new_expected_version IS NOT NULL THEN
   RAISE EXCEPTION 'INVENTORY_MAPPING_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  v_new_version:=1; v_supersedes:=NULL;
 END IF;
 IF NOT v_released_only THEN
  SELECT v.id INTO v_variant FROM catalog.inventory_variant v
   WHERE v.item_id=p_item AND v.variant_key=v_variant_key;
  IF v_variant IS NULL THEN
   INSERT INTO catalog.inventory_variant(item_id,variant_key,unit)
   VALUES(p_item,v_variant_key,v_unit) RETURNING id INTO v_variant;
  ELSE
   IF (SELECT v.unit FROM catalog.inventory_variant v WHERE v.id=v_variant) IS NOT NULL
    AND (SELECT v.unit FROM catalog.inventory_variant v WHERE v.id=v_variant)<>v_unit THEN
    RAISE EXCEPTION 'INVENTORY_MAPPING_UNIT_CONFLICT' USING ERRCODE='22023'; END IF;
   UPDATE catalog.inventory_variant SET unit=v_unit WHERE id=v_variant AND unit IS NULL;
  END IF;
  INSERT INTO catalog.inventory_sku_mapping(account_id,warehouse_id,external_sku,item_id,
   variant_id,unit,status,version,supersedes_id,evidence,note,actor_id)
  VALUES(v_aid,v_wh,v_sku,p_item,v_variant,v_unit,'confirmed',v_new_version,v_supersedes,
   jsonb_build_object('source','inline_binding_edit','actorId',v_actor,'reason',v_reason,
    'variantKey',v_variant_key,'unitConfirmed',true,
    'replacedMappingId',v_old.id,'replacedExternalSku',v_old.external_sku),
   v_reason,v_actor) RETURNING id INTO v_new_id;
  UPDATE catalog.inventory_mapping_candidate c
  SET status='confirmed',resolved_at=now(),resolved_mapping_id=v_new_id
  WHERE c.account_id=v_aid AND c.warehouse_id=v_wh AND c.external_sku=v_sku;
 END IF;
 UPDATE catalog.inventory_sku_mapping SET status='disabled',
  note=coalesce(v_note,note)
 WHERE id=v_old.id;
 v_result:=jsonb_build_object('ok',true,'applied',1,
  'releasedOnly',v_released_only,
  'oldMappingId',v_old.id,'oldExternalSku',v_old.external_sku,
  'newMappingId',coalesce(v_new_id,v_new.id),'newExternalSku',v_sku,
  'itemId',p_item,'warehouseId',v_wh,
  'newVersion',CASE WHEN v_released_only THEN v_new.version ELSE v_new_version END,
  'effectiveAt','next_batch');
 PERFORM catalog.inventory_record_request(p_request,p_intent,'replace_inventory_mapping',
  v_payload,NULL,v_result,v_actor);
 PERFORM catalog.inventory_audit_write(v_actor,'replace_inventory_mapping',v_wh::text,v_result);
 RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 6. 原请求“完整载荷”比较与 intent 编码同口径：空备注 '' 与 NULL 视为同一内容。
--    否则浏览器登记 payload（note:''）与动作内部 payload（note:null）会被误判为
--    同一 requestId 换内容，导致确定失败后结案/恢复被拒绝（INVENTORY_REQUEST_CONFLICT）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.inventory_payload_key(p_action text,p_payload jsonb) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE p_action
  WHEN 'update_inventory_sync_settings' THEN jsonb_build_object(
    'enabled',coalesce(lower(coalesce(p_payload->>'enabled','false'))='true',false),
    'intervalMinutes',CASE WHEN coalesce(p_payload->>'intervalMinutes','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'intervalMinutes')::integer ELSE NULL END,
    'scopeProvided',coalesce(lower(coalesce(p_payload->>'scopeProvided','false'))='true',false),
    'warehouseIds',coalesce((SELECT jsonb_agg(s.value ORDER BY s.value) FROM (
      SELECT DISTINCT value FROM jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(p_payload->'warehouseIds')='array' THEN p_payload->'warehouseIds'
        ELSE '[]'::jsonb END)) s),'[]'::jsonb)
   )::text
  WHEN 'request_inventory_manual_sync' THEN '{}'
  WHEN 'confirm_inventory_mapping' THEN coalesce((SELECT jsonb_agg(x ORDER BY x::text)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'mappings')='array'
     THEN p_payload->'mappings' ELSE '[]'::jsonb END) AS x),'[]'::jsonb)::text
  WHEN 'replace_inventory_mapping' THEN jsonb_build_object(
    'oldMappingId',coalesce(p_payload->>'oldMappingId',''),
    'expectedOldVersion',CASE WHEN coalesce(p_payload->>'expectedOldVersion','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'expectedOldVersion')::integer ELSE NULL END,
    'itemId',coalesce(p_payload->>'itemId',''),
    'newExternalSku',coalesce(p_payload->>'newExternalSku',''),
    'expectedNewVersion',CASE WHEN coalesce(p_payload->>'expectedNewVersion','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'expectedNewVersion')::integer ELSE NULL END,
    'unit',coalesce(p_payload->>'unit',''),
    'reason',coalesce(p_payload->>'reason',''),
    'note',coalesce(nullif(btrim(coalesce(p_payload->>'note','')),''),'')
   )::text
  WHEN 'recheck_inventory_mapping' THEN jsonb_build_object(
    'mappingId',coalesce(p_payload->>'mappingId',''),
    'expectedVersion',CASE WHEN coalesce(p_payload->>'expectedVersion','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'expectedVersion')::integer ELSE NULL END,
    'reason',coalesce(p_payload->>'reason',p_payload->>'note','')
   )::text
  WHEN 'disable_inventory_mapping' THEN jsonb_build_object(
    'mappingId',coalesce(p_payload->>'mappingId',''),
    'expectedVersion',CASE WHEN coalesce(p_payload->>'expectedVersion','') ~ '^-?[0-9]+$'
      THEN (p_payload->>'expectedVersion')::integer ELSE NULL END,
    'reason',coalesce(p_payload->>'reason',p_payload->>'note','')
   )::text
  ELSE coalesce(p_payload,'{}'::jsonb)::text END
$$;

-- ---------------------------------------------------------------------------
-- 7. privileges：只给普通 app 角色（读写都沿用启用中管理员 JWT），sync runner 不给
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_item_binding_rows(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.search_inventory_source_items(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_inventory_source_binding(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.search_inventory_items_v2(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.replace_inventory_mapping(uuid,text,uuid,integer,uuid,text,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 catalog.read_item_binding_rows(uuid),
 catalog.search_inventory_source_items(uuid,text,integer),
 catalog.read_inventory_source_binding(uuid,text),
 catalog.search_inventory_items_v2(text,integer),
 catalog.replace_inventory_mapping(uuid,text,uuid,integer,uuid,text,text,text,text,integer)
 TO ice_p0_02_app_runner;

RESET ROLE;
