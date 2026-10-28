-- ICE catalog 022: 商品库存双视图只读读模型（仓库明细 / 商品汇总 / 逐仓读取状态）。
--
-- 合同：docs/tasks/inventory-sync-ui-v1.md §4（数据读取与权限合同）、§5（最低验收），
-- 以及 .local/inventory-sync-ui-v1-20261027/ 下本包证据目录。
--
-- 只新建 3 个只读函数，不改 00001-021、不建表、不改 inventory_schema_state.version：
--   catalog.read_inventory_warehouse_states()                          -> jsonb[]（逐仓读取状态）
--   catalog.read_inventory_warehouse_rows(p_search,p_warehouse,p_market) -> jsonb（仓库明细全部匹配行）
--   catalog.read_inventory_product_summary(p_search,p_warehouse,p_market,p_limit,p_offset) -> jsonb（商品汇总）
--
-- 口径（与 016 的 effective-row / read-context 模型一致，不另写第二套库存判定）：
--  * 每仓底稿 = inventory_warehouse_state.last_batch_id 指向的最后完整成功批次的**全部**批次行
--    （status adopted/unmapped 都算来源事实；不用“当前是否可归集”过滤掉来源行）；
--  * 当前对应 = 该 account+warehouse+external_sku 的最新版本 inventory_sku_mapping（不限 status），
--    由 LATERAL 单行读取；历史采用关系不冒充当前对应；
--  * 行状态：adopted（本批已采用且当前对应 confirmed，计入合计）/
--    pending_adoption（本批未采用但当前对应 confirmed，保留来源原数量，不计入）/
--    inactive（本批当时已采用、当前对应重核/停用/无，保留原数量与原时间，不计入）/
--    unmapped（本批未对应且当前无 confirmed 对应，原样显示，不计入）；
--  * 当前 confirmed 对应、但该仓最后批次没有该 SKU 的批次行 → pending_adoption 且数量为 null；
--  * 来源原名/GTIN/原始数量文本取自同批 catalog.inventory_run_row（run_id=batch.run_id, excel_row 对齐）；
--  * 商品汇总复用 inventory_read_context + inventory_item_summary_core，与 read_inventory_list 完全同口径；
--    marketCells 只发布实物合计/来源编码种类/仓数/待核标记，不发布“整仓可用”合计（R3）；
--  * p_market='__unknown__'（哨兵）只收窄到 market IS NULL 的参与仓，不猜国家；其余市场值语义不变；
--  * 真实 0 原样返回，缺失保持 null，不转 0；批次缺失时行数为 0 且 lastBatchId=null（不是 0 库存）。
--
-- 安全模式与 016 一致：SET ROLE owner 建函数，SECURITY DEFINER + search_path=''，
-- 入口 PERFORM catalog.require_admin()（启用中的管理员 JWT），账号固定 inventory_bound_account_id()。
-- 只读函数是 STABLE，不写任何表/历史/业务事实。

SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 逐仓读取状态（同步页 / 仓库明细顶部共用；参与仓 = 同步范围 ∩ confirmed 仓库）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_inventory_warehouse_states() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope_json jsonb; v_scope uuid[]:='{}'::uuid[]; v_states jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RETURN '[]'::jsonb; END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 -- 参与仓：同步范围里属于本账号且仍为 confirmed 的仓库（弃用/未选择仓库不冒充参与仓）
 v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid
    AND w.id=ANY(ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(
      coalesce(v_scope_json->'warehouseIds','[]'::jsonb)) x))
    AND w.status='confirmed'
   ORDER BY w.external_warehouse_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'warehouseId',w.id,
   'externalId',w.external_warehouse_id,
   'name',w.external_name,
   'market',w.market,
   'warehouseStatus',w.status,
   'lastSuccessAt',rs.last_success_at,
   'lastBatchId',rs.last_batch_id,
   'batchRows',coalesce(cnt.batch_rows,0),
   'adoptedRows',coalesce(cnt.adopted_rows,0),
   'unmappedRows',coalesce(cnt.unmapped_rows,0),
   'observationAt',b.observation_at,
   'publishedAt',b.published_at,
   'failed',coalesce(rs.failed,false),
   'stale',coalesce(rs.stale,false),
   'lastErrorCode',rs.last_error_code,
   'latestRunStatus',rs.latest_run_status,
   'pendingMappingRows',coalesce(cnt.unmapped_rows,0))
   ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_states
 FROM catalog.inventory_warehouse w
 JOIN catalog.inventory_warehouse_read_state(v_aid,v_scope) rs ON rs.warehouse_id=w.id
 LEFT JOIN catalog.inventory_batch b ON b.id=rs.last_batch_id
 LEFT JOIN LATERAL (
   SELECT count(*)::integer AS batch_rows,
     count(*) FILTER (WHERE br.status='adopted')::integer AS adopted_rows,
     count(*) FILTER (WHERE br.status='unmapped')::integer AS unmapped_rows
   FROM catalog.inventory_batch_row br WHERE br.batch_id=rs.last_batch_id
 ) cnt ON rs.last_batch_id IS NOT NULL
 WHERE w.account_id=v_aid AND w.id=ANY(v_scope) AND w.status='confirmed';
 RETURN coalesce(v_states,'[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- 2. 仓库明细：每仓最后完整成功批次的**全部**批次行（adopted/unmapped 都是来源事实）为底稿，
--    用最新版本对应单独表达当前对应状态（adopted/pending_adoption/inactive/unmapped）；
--    另加“当前 confirmed 对应、但本批没有该 SKU 批次行”的 pending_adoption（数量 null）。
--    搜索/仓库/市场语义与 read_inventory_list 一致（名称/货号/条码/外部 SKU，另含来源原名）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_inventory_warehouse_rows(p_search text,p_warehouse text,p_market text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope_json jsonb; v_scope uuid[]:='{}'::uuid[];
 v_filter_wh uuid; v_search text; v_market_filter text;
 v_rows jsonb:='[]'::jsonb; v_states jsonb:='[]'::jsonb; v_market_options jsonb:='[]'::jsonb;
 v_total integer:=0; v_adopted integer:=0; v_unmapped integer:=0; v_pending integer:=0; v_inactive integer:=0;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_market_filter:=nullif(btrim(coalesce(p_market,'')),'');
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('total',0,'offset',0,'limit',0,'rows','[]'::jsonb,
   'scope',jsonb_build_object('warehouseCount',0,'empty',true,'lastAllSuccessAt',NULL::timestamptz),
   'marketOptions','[]'::jsonb,'warehouses','[]'::jsonb,
   'counts',jsonb_build_object('adopted',0,'unmapped',0,'pendingAdoption',0,'inactive',0)); END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid
    AND w.id=ANY(ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(
      coalesce(v_scope_json->'warehouseIds','[]'::jsonb)) x))
    AND w.status='confirmed'
   ORDER BY w.external_warehouse_id);
 IF p_warehouse IS NOT NULL AND length(btrim(p_warehouse))>0 THEN
  BEGIN
   v_filter_wh:=(btrim(p_warehouse))::uuid;
  EXCEPTION WHEN OTHERS THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023';
  END;
  IF NOT EXISTS(SELECT 1 FROM catalog.inventory_warehouse w WHERE w.id=v_filter_wh AND w.account_id=v_aid) THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_scope:=ARRAY(SELECT x FROM unnest(v_scope) x WHERE x=v_filter_wh);
 END IF;
 IF v_market_filter IS NOT NULL THEN
  -- '__unknown__' 哨兵：只匹配 market IS NULL 的参与仓，不按国家猜测归属。
  IF v_market_filter='__unknown__' THEN
   v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
    WHERE w.id=ANY(v_scope) AND w.market IS NULL);
  ELSE
   v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
    WHERE w.id=ANY(v_scope) AND w.market=v_market_filter);
  END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('market',x.market,
   'warehouseCount',x.warehouse_count,'warehouses',x.warehouses) ORDER BY x.market),'[]'::jsonb)
 INTO v_market_options FROM (
   SELECT m.market,count(*)::integer AS warehouse_count,
    jsonb_agg(jsonb_build_object('id',m.id,'externalId',m.external_warehouse_id,
      'name',m.external_name) ORDER BY m.external_warehouse_id) AS warehouses
   FROM (SELECT w.id,w.external_warehouse_id,w.external_name,w.market
     FROM catalog.inventory_warehouse w
     WHERE w.account_id=v_aid AND w.market IS NOT NULL AND w.id=ANY(v_scope)) m
   GROUP BY m.market) x;
 -- 逐仓状态与 read_inventory_warehouse_states() 同源，只保留当前筛选范围
 SELECT coalesce(jsonb_agg(s ORDER BY s->>'externalId'),'[]'::jsonb) INTO v_states
 FROM jsonb_array_elements(catalog.read_inventory_warehouse_states()) s
 WHERE (s->>'warehouseId')::uuid=ANY(v_scope);
 WITH ident AS (
  SELECT i.id AS item_id,
   (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.id) AS ice_code,
   (SELECT r.name_cn FROM catalog.item_current ic
     JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
     WHERE ic.item_id=i.id) AS name_cn
  FROM catalog.catalog_item i
 ), base AS (
  -- 来源事实底稿：每仓最后完整成功批次的全部批次行（adopted/unmapped 都保留，不按当前可归集过滤）
  SELECT w.id AS warehouse_id,w.external_warehouse_id,w.external_name AS warehouse_name,w.market,
   b.id AS batch_id,b.observation_at,
   br.external_sku,br.status AS batch_status,br.item_id AS batch_item_id,br.item_revision,
   br.mapping_id AS batch_mapping_id,bm.status AS batch_mapping_status,
   br.gtin AS br_gtin,br.unit AS br_unit,br.on_hand,br.order_locked,br.warehouse_available,
   br.activity_reserved,br.in_transit,br.excel_row,br.raw_on_hand,
   m.item_id AS mapping_item_id,m.unit AS mapping_unit,m.status AS mapping_status,
   rr.product_name AS source_name,rr.gtin AS run_gtin,rr.on_hand_text AS run_on_hand_text
  FROM catalog.inventory_warehouse_state ws
  JOIN catalog.inventory_warehouse w ON w.id=ws.warehouse_id
   AND w.account_id=v_aid AND w.id=ANY(v_scope) AND w.status='confirmed'
  JOIN catalog.inventory_batch b ON b.id=ws.last_batch_id AND b.warehouse_id=w.id
  JOIN catalog.inventory_batch_row br ON br.batch_id=b.id
  LEFT JOIN catalog.inventory_run_row rr ON rr.run_id=b.run_id AND rr.excel_row=br.excel_row
  -- 本批当时采用的对应版本（br.mapping_id）：只有这一条映射仍 confirmed 才算“已采用”（与权威
  -- inventory_effective_rows 同一判定）。换绑/同商品重确认会产生新版本并停用旧版本，不能提前算新商品。
  LEFT JOIN catalog.inventory_sku_mapping bm ON bm.id=br.mapping_id AND bm.account_id=v_aid
  LEFT JOIN LATERAL (
   SELECT mm.item_id,mm.unit,mm.status
   FROM catalog.inventory_sku_mapping mm
   WHERE mm.account_id=v_aid AND mm.warehouse_id=w.id AND mm.external_sku=br.external_sku
   ORDER BY mm.version DESC,mm.created_at DESC
   LIMIT 1
  ) m ON true
 ), rows AS (
  -- 本批已采用 + 本批当时使用的对应版本仍 confirmed：计入合计
  SELECT 'bigseller'::text AS source,
   'bigseller:'||x.warehouse_id::text||':'||x.external_sku AS row_key,
   x.warehouse_id AS warehouse_id,x.external_warehouse_id AS warehouse_external_id,x.warehouse_name AS warehouse_name,x.market AS market,
   'adopted'::text AS status,
   x.batch_item_id AS item_id,ident.ice_code,ident.name_cn AS item_name,
   x.source_name,x.external_sku,
   coalesce(x.run_gtin,x.br_gtin)::text AS gtin,
   coalesce(x.br_unit,x.mapping_unit)::text AS unit,
   x.on_hand,x.order_locked,x.warehouse_available,x.activity_reserved,x.in_transit,
   x.observation_at,x.batch_id,x.excel_row,
   'confirmed'::text AS mapping_status,x.item_revision,
   coalesce(x.run_on_hand_text,x.raw_on_hand) AS raw_on_hand,NULL::text AS note,
   NULL::integer AS last_known_qty,NULL::timestamptz AS last_known_at
  FROM base x LEFT JOIN ident ON ident.item_id=x.batch_item_id
  WHERE x.batch_status='adopted' AND x.batch_item_id IS NOT NULL
   AND x.batch_mapping_status='confirmed'
  UNION ALL
  -- 本批当时已采用、但本批使用的对应版本已重核/停用/无：保留原数量/原时间/当时归属，但不计入合计
  SELECT 'bigseller'::text,
   'bigseller:'||x.warehouse_id::text||':'||x.external_sku,
   x.warehouse_id,x.external_warehouse_id,x.warehouse_name,x.market,
   'inactive'::text,
   x.batch_item_id,ident.ice_code,ident.name_cn,
   x.source_name,x.external_sku,
   coalesce(x.run_gtin,x.br_gtin)::text,
   coalesce(x.br_unit,x.mapping_unit)::text,
   x.on_hand,x.order_locked,x.warehouse_available,x.activity_reserved,x.in_transit,
   x.observation_at,x.batch_id,x.excel_row,
   x.mapping_status,x.item_revision,
   coalesce(x.run_on_hand_text,x.raw_on_hand),
   '本批采用时的对应已停用/重核：保留当时数量与旧时间，不再计入合计'::text,
   NULL::integer,NULL::timestamptz
  FROM base x LEFT JOIN ident ON ident.item_id=x.batch_item_id
  WHERE x.batch_status='adopted'
   AND (x.batch_item_id IS NULL OR x.batch_mapping_status IS DISTINCT FROM 'confirmed')
  UNION ALL
  -- 本批未对应、但当前对应已 confirmed：保留来源原数量，等待下一完整批次采用，不计入合计
  SELECT 'bigseller'::text,
   'bigseller:'||x.warehouse_id::text||':'||x.external_sku,
   x.warehouse_id,x.external_warehouse_id,x.warehouse_name,x.market,
   'pending_adoption'::text,
   x.mapping_item_id,ident.ice_code,ident.name_cn,
   x.source_name,x.external_sku,
   coalesce(x.run_gtin,x.br_gtin)::text,
   coalesce(x.br_unit,x.mapping_unit)::text,
   x.on_hand,x.order_locked,x.warehouse_available,x.activity_reserved,x.in_transit,
   x.observation_at,x.batch_id,x.excel_row,
   'confirmed'::text,x.item_revision,
   coalesce(x.run_on_hand_text,x.raw_on_hand),
   '对应已确认，等待下一完整批次采用；本批未采用，不计入合计'::text,
   NULL::integer,NULL::timestamptz
  FROM base x LEFT JOIN ident ON ident.item_id=x.mapping_item_id
  WHERE x.batch_status='unmapped' AND x.mapping_status='confirmed'
  UNION ALL
  -- 本批未对应、当前也无 confirmed 对应：原样显示，不计入任何合计
  SELECT 'bigseller'::text,
   'bigseller:'||x.warehouse_id::text||':'||x.external_sku,
   x.warehouse_id,x.external_warehouse_id,x.warehouse_name,x.market,
   'unmapped'::text,
   NULL::uuid,NULL::text,NULL::text,
   x.source_name,x.external_sku,
   coalesce(x.run_gtin,x.br_gtin)::text,
   x.br_unit::text,
   x.on_hand,x.order_locked,x.warehouse_available,x.activity_reserved,x.in_transit,
   x.observation_at,x.batch_id,x.excel_row,
   NULL::text,NULL::integer,
   coalesce(x.run_on_hand_text,x.raw_on_hand),
   '来源未对应：不计入任何合计，请在商品库维护正式对应'::text,
   NULL::integer,NULL::timestamptz
  FROM base x
  WHERE x.batch_status='unmapped' AND x.mapping_status IS DISTINCT FROM 'confirmed'
  UNION ALL
  -- 对应已确认、等待下一完整批次采用：本批没有该 SKU 的任何批次行（不补数量、不计入合计）。
  -- 若历史批次里该商品/编码曾有采用数量，同时给出上次已知数量/时间（只展示，不当本次库存）。
  SELECT 'bigseller'::text,
   'bigseller:'||w.id::text||':'||m.external_sku,
   w.id,w.external_warehouse_id,w.external_name,w.market,
   'pending_adoption'::text,
   m.item_id,ident.ice_code,ident.name_cn,
   NULL::text,
   m.external_sku,NULL::text,m.unit,
   NULL::integer,NULL::integer,NULL::integer,NULL::integer,NULL::integer,
   NULL::timestamptz,ws.last_batch_id,NULL::integer,
   'confirmed'::text,NULL::integer,NULL::text,
   '对应已确认，等待下一次完整同步采用；本批未采用该 SKU，不计入合计'::text,
   lk.on_hand,lk.observation_at
  FROM catalog.inventory_warehouse w
  LEFT JOIN catalog.inventory_warehouse_state ws ON ws.account_id=v_aid AND ws.warehouse_id=w.id
  LEFT JOIN catalog.inventory_batch cb ON cb.id=ws.last_batch_id
  JOIN catalog.inventory_sku_mapping m ON m.account_id=v_aid AND m.warehouse_id=w.id AND m.status='confirmed'
  LEFT JOIN ident ON ident.item_id=m.item_id
  -- 本次未见时的上次已知值：沿用已有相邻批次读取，不补 0、不用旧 current 指针。
  LEFT JOIN LATERAL catalog.inventory_previous_batch_row(v_aid,w.id,m.external_sku,m.item_id,
   cb.observation_at,cb.published_at,cb.id) lk ON true
  WHERE w.account_id=v_aid AND w.id=ANY(v_scope) AND w.status='confirmed'
   AND (ws.last_batch_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM catalog.inventory_batch_row br
    WHERE br.batch_id=ws.last_batch_id AND br.external_sku=m.external_sku))
 )
 SELECT count(*)::integer,
  count(*) FILTER (WHERE status='adopted')::integer,
  count(*) FILTER (WHERE status='unmapped')::integer,
  count(*) FILTER (WHERE status='pending_adoption')::integer,
  count(*) FILTER (WHERE status='inactive')::integer,
  coalesce(jsonb_agg(jsonb_build_object(
   'source',source,'rowKey',row_key,
   'warehouseId',warehouse_id,'warehouseExternalId',warehouse_external_id,'warehouseName',warehouse_name,
   'market',market,'status',status,
   'itemId',item_id,'iceCode',ice_code,'itemName',item_name,'sourceName',source_name,
   'externalSku',external_sku,'gtin',gtin,'unit',unit,
   'onHand',on_hand,'orderLocked',order_locked,'warehouseAvailable',warehouse_available,
   'activityReserved',activity_reserved,'inTransit',in_transit,
   'observationAt',observation_at,'batchId',batch_id,'excelRow',excel_row,
   'mappingStatus',mapping_status,'itemRevision',item_revision,'rawOnHand',raw_on_hand,'note',note,
   'lastKnownQty',last_known_qty,'lastKnownAt',last_known_at,
   'fileDate',NULL::text,'fileName',NULL::text,'cloudAvailableText',NULL::text)
   ORDER BY warehouse_external_id,
    CASE status WHEN 'adopted' THEN 0 WHEN 'pending_adoption' THEN 1 WHEN 'inactive' THEN 2 ELSE 3 END,
    excel_row NULLS LAST,external_sku),'[]'::jsonb)
 INTO v_total,v_adopted,v_unmapped,v_pending,v_inactive,v_rows
 FROM rows
 WHERE v_search IS NULL
  OR coalesce(external_sku,'') ILIKE '%'||v_search||'%'
  OR coalesce(gtin,'') ILIKE '%'||v_search||'%'
  OR coalesce(source_name,'') ILIKE '%'||v_search||'%'
  OR coalesce(item_name,'') ILIKE '%'||v_search||'%'
  OR coalesce(ice_code,'') ILIKE '%'||v_search||'%';
 RETURN jsonb_build_object(
  'total',v_total,'offset',0,'limit',v_total,
  'rows',coalesce(v_rows,'[]'::jsonb),
  'scope',jsonb_build_object('warehouseCount',cardinality(v_scope),
   'empty',cardinality(v_scope)=0,'lastAllSuccessAt',v_scope_json->'lastAllSuccessAt'),
  'marketOptions',v_market_options,'warehouses',v_states,
  'counts',jsonb_build_object('adopted',v_adopted,'unmapped',v_unmapped,
   'pendingAdoption',v_pending,'inactive',v_inactive));
END $$;

-- ---------------------------------------------------------------------------
-- 3. 商品汇总：一标准商品 × 各市场格。
--    合计/缺口复用 inventory_read_context + inventory_item_summary_core（与 read_inventory_list
--    完全同口径，不自己重新加总）；marketCells 由同一请求内的 effective rows 按 market 分组。
--    R3：marketCells 只发布实物合计/来源编码种类/仓数/待核标记，不发布“整仓可用”合计；
--    p_market='__unknown__' 只收窄到 market IS NULL 的参与仓（不猜国家）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_inventory_product_summary(p_search text,p_warehouse text,
 p_market text,p_limit integer,p_offset integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_aid uuid; v_scope_json jsonb; v_scope uuid[]:='{}'::uuid[];
 v_filter_wh uuid; v_search text; v_market_filter text; v_limit integer; v_offset integer;
 v_total integer:=0; v_page jsonb; v_page_items jsonb:='[]'::jsonb; v_identities jsonb:='{}'::jsonb;
 v_ctx jsonb; v_items jsonb:='[]'::jsonb; v_core jsonb; v_item_id uuid; v_identity jsonb;
 v_item_ctx jsonb; v_eff_rows jsonb; v_cells jsonb; v_sku_count integer:=0;
 v_states jsonb:='[]'::jsonb; v_market_options jsonb:='[]'::jsonb; v_unmapped integer:=0;
 v_i integer; v_len integer;
BEGIN
 PERFORM catalog.require_admin();
 v_aid:=catalog.inventory_bound_account_id();
 v_limit:=greatest(1,least(coalesce(p_limit,50),200));
 v_offset:=greatest(0,coalesce(p_offset,0));
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_market_filter:=nullif(btrim(coalesce(p_market,'')),'');
 IF v_aid IS NULL THEN
  RETURN jsonb_build_object('total',0,'offset',v_offset,'limit',v_limit,'rows','[]'::jsonb,
   'scope',jsonb_build_object('warehouseCount',0,'empty',true,'lastAllSuccessAt',NULL::timestamptz,
    'marketFilter',v_market_filter,'warehouseFilter',p_warehouse),
   'marketOptions','[]'::jsonb,'warehouses','[]'::jsonb,'unmappedOverseasRows',0,
   'unmappedDomesticRows',0,'domesticAvailable',false,'domesticReason',NULL::text); END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
   WHERE w.account_id=v_aid
    AND w.id=ANY(ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(
      coalesce(v_scope_json->'warehouseIds','[]'::jsonb)) x))
    AND w.status='confirmed'
   ORDER BY w.external_warehouse_id);
 IF p_warehouse IS NOT NULL AND length(btrim(p_warehouse))>0 THEN
  BEGIN
   v_filter_wh:=(btrim(p_warehouse))::uuid;
  EXCEPTION WHEN OTHERS THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023';
  END;
  IF NOT EXISTS(SELECT 1 FROM catalog.inventory_warehouse w WHERE w.id=v_filter_wh AND w.account_id=v_aid) THEN
   RAISE EXCEPTION 'INVENTORY_WAREHOUSE_UNKNOWN' USING ERRCODE='22023'; END IF;
  v_scope:=ARRAY(SELECT x FROM unnest(v_scope) x WHERE x=v_filter_wh);
 END IF;
 IF v_market_filter IS NOT NULL THEN
  -- '__unknown__' 哨兵：只匹配 market IS NULL 的参与仓，不按国家猜测归属。
  IF v_market_filter='__unknown__' THEN
   v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
    WHERE w.id=ANY(v_scope) AND w.market IS NULL);
  ELSE
   v_scope:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w
    WHERE w.id=ANY(v_scope) AND w.market=v_market_filter);
  END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('market',x.market,
   'warehouseCount',x.warehouse_count,'warehouses',x.warehouses) ORDER BY x.market),'[]'::jsonb)
 INTO v_market_options FROM (
   SELECT m.market,count(*)::integer AS warehouse_count,
    jsonb_agg(jsonb_build_object('id',m.id,'externalId',m.external_warehouse_id,
      'name',m.external_name) ORDER BY m.external_warehouse_id) AS warehouses
   FROM (SELECT w.id,w.external_warehouse_id,w.external_name,w.market
     FROM catalog.inventory_warehouse w
     WHERE w.account_id=v_aid AND w.market IS NOT NULL AND w.id=ANY(v_scope)) m
   GROUP BY m.market) x;
 SELECT coalesce(jsonb_agg(s ORDER BY s->>'externalId'),'[]'::jsonb) INTO v_states
 FROM jsonb_array_elements(catalog.read_inventory_warehouse_states()) s
 WHERE (s->>'warehouseId')::uuid=ANY(v_scope);
 -- 当前范围（搜索/仓/市场）内、当前对应仍不是 confirmed 的“来源未对应”行数：
 -- 与仓库明细 rows 的 unmapped 状态同一口径（本批未对应 + 最新对应非 confirmed），供页面提示定位。
 -- 应用搜索条件，避免把全局 220 说成当前商品/范围的待处理数量。
 SELECT count(*)::integer INTO v_unmapped
 FROM catalog.inventory_warehouse_state ws
 JOIN catalog.inventory_warehouse w ON w.id=ws.warehouse_id
  AND w.account_id=v_aid AND w.id=ANY(v_scope) AND w.status='confirmed'
 JOIN catalog.inventory_batch b ON b.id=ws.last_batch_id AND b.warehouse_id=w.id
 JOIN catalog.inventory_batch_row br ON br.batch_id=b.id AND br.status='unmapped'
 LEFT JOIN catalog.inventory_run_row rr ON rr.run_id=b.run_id AND rr.excel_row=br.excel_row
 LEFT JOIN LATERAL (
  SELECT mm.status FROM catalog.inventory_sku_mapping mm
  WHERE mm.account_id=v_aid AND mm.warehouse_id=w.id AND mm.external_sku=br.external_sku
  ORDER BY mm.version DESC,mm.created_at DESC
  LIMIT 1
 ) lm ON true
 WHERE coalesce(lm.status,'') IS DISTINCT FROM 'confirmed'
  AND (v_search IS NULL
   OR coalesce(br.external_sku,'') ILIKE '%'||v_search||'%'
   OR coalesce(coalesce(rr.gtin,br.gtin),'') ILIKE '%'||v_search||'%'
   OR coalesce(rr.product_name,'') ILIKE '%'||v_search||'%'
   OR EXISTS(SELECT 1 FROM catalog.item_current icu
     JOIN catalog.item_revision ir ON ir.item_id=icu.item_id AND ir.revision=icu.revision
     WHERE icu.item_id=br.item_id AND ir.name_cn ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.catalog_item_code c
     WHERE c.item_id=br.item_id AND c.ice_code ILIKE '%'||v_search||'%'));
 -- 与 read_inventory_list 同一请求级上下文：一次批量读取 effective rows/状态/对应/候选/来源行
 v_ctx:=catalog.inventory_read_context(v_aid,v_scope,NULL);
 WITH refs AS (
  SELECT m."itemId" item_id,m."warehouseId" warehouse_id
  FROM jsonb_to_recordset(v_ctx->'mappings') AS m("itemId" uuid,"warehouseId" uuid,status text)
  WHERE m.status='confirmed' AND m."warehouseId"=ANY(v_scope)
  UNION
  SELECT m."itemId",m."warehouseId"
  FROM jsonb_to_recordset(v_ctx->'mappings') AS m("itemId" uuid,"warehouseId" uuid,status text)
  WHERE m.status IN('recheck','disabled') AND m."warehouseId"=ANY(v_scope)
  UNION
  SELECT c."suggestedItemId",c."warehouseId"
  FROM jsonb_to_recordset(v_ctx->'candidates') AS c("warehouseId" uuid,"externalSku" text,
    "suggestedItemId" uuid,status text)
  WHERE c.status='pending' AND c."suggestedItemId" IS NOT NULL AND c."warehouseId"=ANY(v_scope)
  UNION
  SELECT e."itemId",e."warehouseId"
  FROM jsonb_to_recordset(v_ctx->'effectiveRows') AS e("itemId" uuid,"warehouseId" uuid,
    "externalSku" text,gtin text)
  WHERE e."warehouseId"=ANY(v_scope)
 ), item_ids AS (SELECT DISTINCT item_id FROM refs WHERE item_id IS NOT NULL),
 matched AS (
  SELECT i.item_id,
   (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.item_id) AS ice_code
  FROM item_ids i
  WHERE v_search IS NULL
   OR EXISTS(SELECT 1 FROM catalog.catalog_item_code c WHERE c.item_id=i.item_id AND c.ice_code ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM catalog.item_current ic JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
     WHERE ic.item_id=i.item_id AND r.name_cn ILIKE '%'||v_search||'%')
   OR EXISTS(SELECT 1 FROM jsonb_to_recordset(v_ctx->'effectiveRows') AS e("itemId" uuid,
      "externalSku" text,gtin text)
     WHERE e."itemId"=i.item_id AND (coalesce(e."externalSku",'') ILIKE '%'||v_search||'%'
       OR coalesce(e.gtin,'') ILIKE '%'||v_search||'%'))
 )
 SELECT jsonb_build_object('total',(SELECT count(*)::integer FROM matched),
  'page',coalesce((SELECT jsonb_agg(jsonb_build_object('itemId',p.item_id,'iceCode',p.ice_code))
   FROM (SELECT * FROM matched ORDER BY ice_code NULLS LAST,item_id
     LIMIT v_limit OFFSET v_offset) p),'[]'::jsonb))
 INTO v_page;
 v_total:=(v_page->>'total')::integer;
 v_page_items:=v_page->'page';
 IF jsonb_array_length(v_page_items)>0 THEN
  SELECT coalesce(jsonb_object_agg(i.id::text,jsonb_build_object('itemId',i.id,
    'iceCode',(SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=i.id),
    'nameCn',(SELECT r.name_cn FROM catalog.item_current ic
      JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
      WHERE ic.item_id=i.id))),'{}'::jsonb)
  INTO v_identities FROM catalog.catalog_item i
  WHERE i.id=ANY(ARRAY(SELECT (x->>'itemId')::uuid FROM jsonb_array_elements(v_page_items) x));
 END IF;
 v_len:=jsonb_array_length(v_page_items);
 FOR v_i IN 0..v_len-1 LOOP
  v_item_id:=(v_page_items->v_i->>'itemId')::uuid;
  v_identity:=v_identities->(v_item_id::text);
  v_item_ctx:=coalesce(v_ctx->'items'->(v_item_id::text),'{}'::jsonb)
   ||jsonb_build_object('readStates',v_ctx->'readStates','warehouses',v_ctx->'warehouses',
     'latestRunId',v_ctx->'latestRunId');
  v_core:=catalog.inventory_item_summary_core(v_aid,v_item_id,v_scope,v_item_ctx,v_identity);
  IF v_core IS NULL THEN CONTINUE; END IF;
  v_eff_rows:=coalesce(v_ctx->'items'->(v_item_id::text)->'effectiveRows','[]'::jsonb);
  WITH e AS (
   SELECT x.* FROM jsonb_to_recordset(v_eff_rows) AS x("itemId" uuid,"warehouseId" uuid,
    "warehouseExternalId" text,"warehouseName" text,market text,"externalSku" text,
    "mappingId" uuid,"mappingVersion" integer,"variantId" uuid,unit text,"onHand" integer,
    "orderLocked" integer,"warehouseAvailable" integer,"activityReserved" integer,"inTransit" integer,
    gtin text,"observedAt" timestamptz,"batchId" uuid,"excelRow" integer,"itemRevision" integer)
   WHERE x."itemId"=v_item_id AND x."warehouseId"=ANY(v_scope)
  ), pending_wh AS (
   SELECT "warehouseId" FROM e GROUP BY "warehouseId",unit HAVING count(*)>1
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'market',g.market,
    'onHand',g.on_hand,
    'skuCount',g.sku_count,
    'warehouseCount',g.wh_count,
    'hasPendingTotal',g.has_pending) ORDER BY g.market NULLS LAST),'[]'::jsonb)
  INTO v_cells FROM (
   SELECT e.market,
    CASE WHEN count(*) FILTER (WHERE e."onHand" IS NULL)=0
      AND count(DISTINCT e.unit) FILTER (WHERE e.unit IS NOT NULL)<=1
      AND NOT bool_or(e."warehouseId" IN (SELECT "warehouseId" FROM pending_wh))
     THEN sum(e."onHand") ELSE NULL END AS on_hand,
    count(DISTINCT e."externalSku")::integer AS sku_count,
    count(DISTINCT e."warehouseId")::integer AS wh_count,
    bool_or(e."warehouseId" IN (SELECT "warehouseId" FROM pending_wh)) AS has_pending
   FROM e GROUP BY e.market) g;
  SELECT count(DISTINCT x->>'externalSku')::integer INTO v_sku_count
  FROM jsonb_array_elements(v_eff_rows) x;
  v_items:=v_items||jsonb_build_array(v_core||jsonb_build_object(
   'marketCells',coalesce(v_cells,'[]'::jsonb),
   'overseasOnHand',v_core->'knownSubtotal',
   'overseasSkuCount',coalesce(v_sku_count,0),
   'domestic',NULL::jsonb));
 END LOOP;
 RETURN jsonb_build_object('total',v_total,'offset',v_offset,'limit',v_limit,
  'rows',v_items,
  'scope',jsonb_build_object('warehouseCount',cardinality(v_scope),
   'empty',cardinality(v_scope)=0,'lastAllSuccessAt',v_scope_json->'lastAllSuccessAt',
   'marketFilter',v_market_filter,'warehouseFilter',p_warehouse),
  'marketOptions',v_market_options,'warehouses',v_states,
  -- 国内表格快照由服务端来源层（冻结文件）单独读取后由页面层合并；本函数不读私有文件、不伪造 0。
  'unmappedOverseasRows',v_unmapped,'unmappedDomesticRows',0,
  'domesticAvailable',false,'domesticReason',NULL::text);
END $$;

-- ---------------------------------------------------------------------------
-- 4. privileges：只给普通 app 角色（读模型沿用启用中管理员 JWT），不给 sync runner
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_inventory_warehouse_states() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_inventory_warehouse_rows(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_inventory_product_summary(text,text,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 catalog.read_inventory_warehouse_states(),
 catalog.read_inventory_warehouse_rows(text,text,text),
 catalog.read_inventory_product_summary(text,text,text,integer,integer)
 TO ice_p0_02_app_runner;

RESET ROLE;
