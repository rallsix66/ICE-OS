-- ICE catalog 042: 「操作记录」只读汇合查询（商品资料 / 库存对应 / 物流）。
--
-- 合同：docs/tasks/operations-log-v1.md
--   * 不建表、不写任何业务数据、不改 001-041；
--   * 只汇合各模块**已经保存**的人工处理记录：
--       商品资料：来源资料采用（按批次一条）、补货号、来源资料行选择/撤销、
--                 来源字段人工口径（暂不处理/人工解释/撤销）、商品资料修订（含首版）；
--       库存对应：确认/换绑（confirm_inventory_mapping 的 committed 版本）、
--                 重核、停用、原 SKU 替换、国内复核采用商品对应；
--       物流：人工关联/清除商品关联（同一时间同一次保存合并为一条）、
--             人工修正数量/状态、恢复按原表判断、分合票人工决定、撤销人工分组决定。
--   * 自动同步过程不进入本查询（库存/物流后台事件仍看各自同步结果入口）；
--     begin/complete_inventory_pending_action 等请求簿记不单独成条，避免同一次操作重复堆叠；
--   * 「前值」只用历史行本身（item_revision.previous_revision / mapping.supersedes_id /
--     人工修正历史行的 previous_* / 关联修订 previous_product_id），不用当前值反推；
--     历史行没有保存的字段在页面上显示「未保存」，由页面文案负责；
--   * 记录账号 = 记录行上的 actor_id（经 public.profiles 显示名）；不推断具体操作人；
--   * 关键词只按已保存的业务标识搜索（货号/来源 SKU/货票号/名称/批次号）；
--   * 时间倒序分页（p_limit 1-200），返回 total/offset/limit、分类计数与账号清单；
--   * SECURITY DEFINER + search_path='' + require_admin；app 角色只能 EXECUTE。
SET ROLE ice_p0_02_owner;

CREATE OR REPLACE FUNCTION catalog.read_operation_records(
  p_category text,
  p_actor uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_search text,
  p_limit integer,
  p_offset integer
) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_category text; v_search text; v_limit integer; v_offset integer;
 v_rows jsonb:='[]'::jsonb; v_total integer:=0; v_actors jsonb:='[]'::jsonb;
 v_category_counts jsonb:='{}'::jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_category:=CASE WHEN p_category IN ('catalog','inventory','shipment') THEN p_category ELSE 'all' END;
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,50),200));
 v_offset:=greatest(0,coalesce(p_offset,0));
 WITH item_identity AS (
  -- 一次取齐当前货号/名称（126 款），记录行再按 item_id 关联，避免逐条重复子查询。
  SELECT i.id AS item_id,
    (SELECT cc.ice_code FROM catalog.catalog_item_code cc WHERE cc.item_id=i.id LIMIT 1) AS ice_code,
    (SELECT r.name_cn FROM catalog.item_revision r
      JOIN catalog.item_current ic ON ic.item_id=r.item_id AND ic.revision=r.revision
      WHERE r.item_id=i.id) AS name_cn
  FROM catalog.catalog_item i
 ),
 warehouse_identity AS (
  SELECT w.external_warehouse_id, w.external_name FROM catalog.inventory_warehouse w
 ),
 records AS (
  -- 1) 商品资料 · 来源资料采用（一次采用 = 一条批次结果，不按商品/字段重复堆叠）
  SELECT
   ('src_batch:'||b.id::text)::text AS id,
   coalesce(a.recorded_at,b.received_at,b.captured_at)::timestamptz AS at,
   'catalog'::text AS category,
   'source_batch_applied'::text AS action,
   a.actor_id,
   '商品资料'::text AS object_kind,
   '来源资料批次'::text AS object_title,
   b.id::text AS object_ref,
   NULL::uuid AS item_id,
   NULL::uuid AS ticket_id,
   b.id AS batch_id,
   NULL::text AS ice_code,
   NULL::text AS external_sku,
   NULL::text AS ticket_no,
   NULL::text AS market,
   jsonb_build_object(
    'batchId',b.id,
    'snapshotKey',b.snapshot_key,
    'status',coalesce(a.result->>'status',b.status),
    'message',a.result->>'message',
    'counts',coalesce(a.result->'counts',b.counts),
    'capturedAt',b.captured_at,
    'receivedAt',b.received_at,
    'origin',b.origin,
    -- 明细只保留本批真正写入/失败的商品行；无变化与仅提示的行走 counts，不重复堆叠。
    'results',z.results) AS detail,
   concat_ws(' ','来源资料采用',b.snapshot_key,b.id::text,z.search_text)::text AS search_text
  FROM catalog.product_source_batch b
  LEFT JOIN LATERAL (
    SELECT a2.* FROM catalog.audit_event a2
    WHERE a2.action='apply_product_source_batch' AND a2.result->>'batchId'=b.id::text
    ORDER BY a2.recorded_at DESC LIMIT 1) a ON true
  LEFT JOIN LATERAL (
    SELECT
      coalesce(jsonb_agg(x ORDER BY x->>'iceCode'),'[]'::jsonb) AS results,
      concat_ws(' ',string_agg(DISTINCT x->>'iceCode',' '),string_agg(DISTINCT x->>'nameCn',' ')) AS search_text
    FROM jsonb_array_elements(coalesce(a.result->'results','[]'::jsonb)) x
    WHERE coalesce(x->>'itemRevision','')<>'' OR x->>'action'='failed') z ON true
  WHERE b.status IN ('applied','partial')

  UNION ALL
  -- 2) 商品资料 · 补货号（补录/初始补号/纠正测试货号/关闭缺货号事项）
  SELECT
   ('audit:'||a.id::text)::text,
   a.recorded_at,
   'catalog',
   (CASE a.action
      WHEN 'assign_source_code' THEN 'assign_source_code'
      WHEN 'assign_initial_code' THEN 'assign_initial_code'
      WHEN 'correct_test_source_code' THEN 'correct_test_source_code'
      ELSE 'resolve_source_issue' END)::text,
   a.actor_id,
   '商品'::text,
   coalesce(cur.name_cn,'来源事项')::text,
   coalesce(code.ice_code,a.result->>'removedCode')::text,
   a.item_id,
   NULL::uuid,
   NULL::uuid,
   coalesce(code.ice_code,a.result->>'removedCode')::text,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'action',a.action,
    'result',a.result,
    'requestId',a.request_id,
    'currentCode',code.ice_code,
    'itemName',cur.name_cn),
   concat_ws(' ',a.action,code.ice_code,cur.name_cn,a.result->>'removedCode',
     a.result->>'sourceKey',a.result->>'issueKind',a.item_id::text)::text
  FROM catalog.audit_event a
  LEFT JOIN item_identity cur ON cur.item_id=a.item_id
  LEFT JOIN LATERAL (
    SELECT cc.ice_code FROM catalog.catalog_item_code cc WHERE cc.item_id=a.item_id LIMIT 1) code ON true
  WHERE a.action IN ('assign_source_code','assign_initial_code','correct_test_source_code','resolve_source_issue')
    AND (a.action<>'resolve_source_issue' OR coalesce(a.result->>'issueKind','') LIKE 'missing%')

  UNION ALL
  -- 3) 商品资料 · 来源资料行选择（含撤销：state/superseded_at 都是历史行本身）
  SELECT
   ('dup:'||d.id::text)::text,
   d.decided_at,
   'catalog',
   'duplicate_source_decision'::text,
   d.decided_by,
   '商品'::text,
   coalesce(cur.name_cn,d.ice_code,'来源资料')::text,
   d.ice_code,
   d.item_id,
   NULL::uuid,
   NULL::uuid,
   d.ice_code,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'state',d.state,
    'chosenRowNumber',d.chosen_row_number,
    'chosenRowName',d.chosen_fields->'nameCn'->>'raw',
    'chosenRowBarcode',d.chosen_fields->'barcode'->>'raw',
    'rows',coalesce(d.comparison->'rowNumbers','[]'::jsonb),
    'fieldDifferences',coalesce(d.comparison->'fields','[]'::jsonb),
    'note',d.note,
    'supersededAt',d.superseded_at),
   concat_ws(' ',d.ice_code,cur.name_cn,d.note,d.item_id::text)::text
  FROM catalog.product_source_duplicate_decision d
  LEFT JOIN item_identity cur ON cur.item_id=d.item_id

  UNION ALL
  -- 4) 商品资料 · 来源字段人工口径（暂不处理/人工解释/人工覆盖/撤销）
  SELECT
   ('fd:'||f.id::text)::text,
   f.decided_at,
   'catalog',
   'field_decision'::text,
   f.decided_by,
   '商品'::text,
   coalesce(cur.name_cn,f.ice_code,'商品资料')::text,
   f.ice_code,
   f.item_id,
   NULL::uuid,
   NULL::uuid,
   f.ice_code,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'action',f.action,
    'state',f.state,
    'fieldKey',f.field_key,
    'reason',f.reason,
    'rule',f.rule,
    'valueRaw',f.value_raw,
    'note',f.note,
    'revokedAt',f.revoked_at,
    'supersededAt',f.superseded_at),
   concat_ws(' ',f.ice_code,cur.name_cn,f.field_key,f.reason,f.note)::text
  FROM catalog.product_source_field_decision f
  LEFT JOIN item_identity cur ON cur.item_id=f.item_id

  UNION ALL
  -- 5) 商品资料 · 商品资料修订（未被来源批次/补货号动作覆盖的历史修订；含首版）
  SELECT
   ('rev:'||r.item_id::text||':'||r.revision::text)::text,
   r.recorded_at,
   'catalog',
   (CASE WHEN r.previous_revision IS NULL THEN 'item_baseline' ELSE 'item_revision' END)::text,
   r.actor_id,
   '商品'::text,
   coalesce(r.name_cn,'商品资料')::text,
   r.ice_code_snapshot,
   r.item_id,
   NULL::uuid,
   NULL::uuid,
   r.ice_code_snapshot,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'revision',r.revision,
    'previousRevision',r.previous_revision,
    'reason',r.reason,
    'evidenceRef',r.evidence_ref,
    'barcode',r.fields->'barcode'->>'raw',
    'changes',(
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'fieldKey',k,'beforeRaw',pv.fields->k->>'raw','afterRaw',r.fields->k->>'raw') ORDER BY k),'[]'::jsonb)
      FROM jsonb_object_keys(coalesce(r.fields,'{}'::jsonb)) AS k
      WHERE pv.item_id IS NOT NULL
        AND coalesce(pv.fields->k->>'raw','')<>coalesce(r.fields->k->>'raw',''))),
   concat_ws(' ',r.ice_code_snapshot,r.name_cn,r.fields->'barcode'->>'raw',r.reason)::text
  FROM catalog.item_revision r
  LEFT JOIN LATERAL (
    SELECT p.* FROM catalog.item_revision p
    WHERE p.item_id=r.item_id AND p.revision=r.previous_revision) pv ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM catalog.product_source_batch b2
    WHERE b2.snapshot_key IS NOT NULL
      AND r.evidence_ref LIKE 'product-source:'||b2.snapshot_key||'%')
    AND NOT EXISTS (
    SELECT 1 FROM catalog.audit_event a3
    WHERE a3.item_id=r.item_id
      AND a3.action IN ('assign_source_code','assign_initial_code','correct_test_source_code')
      AND (a3.result->>'revision') ~ '^[0-9]+$'
      AND (a3.result->>'revision')::integer=r.revision)

  UNION ALL
  -- 6) 库存对应 · 确认 / 换绑（committed 版本>1 即换了商品；前值取被替代的对应行）
  SELECT
   ('invaudit:'||a.id::text)::text,
   a.at,
   'inventory',
   (CASE WHEN x.rebind THEN 'inventory_rebind' ELSE 'inventory_confirm' END)::text,
   a.actor_id,
   '库存对应'::text,
   coalesce(x.warehouse_names,'库存对应')::text,
   (x.item_count::text||' 条来源 SKU')::text,
   NULL::uuid,
   NULL::uuid,
   NULL::uuid,
   NULL::text,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'applied',a.detail->'applied',
    'skipped',coalesce(a.detail->'skipped','[]'::jsonb),
    'items',coalesce(x.items,'[]'::jsonb)),
   x.search_text::text
  FROM catalog.inventory_audit a
  LEFT JOIN LATERAL (
    SELECT
      count(*)::integer AS item_count,
      bool_or(coalesce(c->>'version','0') ~ '^[0-9]+$' AND (c->>'version')::integer>1) AS rebind,
      string_agg(DISTINCT wi.external_name,'、') AS warehouse_names,
      concat_ws(' ',
        string_agg(DISTINCT wi.external_name,' '),
        string_agg(DISTINCT c->>'externalSku',' '),
        string_agg(DISTINCT ii.ice_code,' '),
        string_agg(DISTINCT ii.name_cn,' '),
        string_agg(DISTINCT pii.ice_code,' '),
        string_agg(DISTINCT pii.name_cn,' ')) AS search_text,
      jsonb_agg(jsonb_build_object(
        'externalSku',c->>'externalSku',
        'unit',c->>'unit',
        'version',CASE WHEN coalesce(c->>'version','') ~ '^[0-9]+$' THEN (c->>'version')::integer END,
        'mappingId',c->>'mappingId',
        'effectiveAt',c->>'effectiveAt',
        'warehouseExternalId',c->>'warehouseExternalId',
        'warehouseName',wi.external_name,
        'itemId',c->>'itemId',
        'iceCode',ii.ice_code,
        'nameCn',ii.name_cn,
        'previousItemId',pm.item_id,
        'previousIceCode',pii.ice_code,
        'previousNameCn',pii.name_cn) ORDER BY c->>'externalSku') AS items
    FROM jsonb_array_elements(coalesce(a.detail->'committed','[]'::jsonb)) c
    LEFT JOIN catalog.inventory_sku_mapping m ON m.id::text=c->>'mappingId'
    LEFT JOIN catalog.inventory_sku_mapping pm ON pm.id=m.supersedes_id
    LEFT JOIN warehouse_identity wi ON wi.external_warehouse_id=c->>'warehouseExternalId'
    LEFT JOIN item_identity ii ON ii.item_id::text=c->>'itemId'
    LEFT JOIN item_identity pii ON pii.item_id=pm.item_id) x ON true
  WHERE a.action='confirm_inventory_mapping'

  UNION ALL
  -- 7) 库存对应 · 重核 / 停用 / 原 SKU 替换（本机现役库当前没有记录，出现即显示）
  SELECT
   ('invaudit:'||a.id::text)::text,
   a.at,
   'inventory',
   a.action,
   a.actor_id,
   '库存对应'::text,
   coalesce(mw.external_name,m.external_sku,'库存对应')::text,
   m.external_sku,
   m.item_id,
   NULL::uuid,
   NULL::uuid,
   ii.ice_code,
   m.external_sku,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'action',a.action,
    'detail',a.detail,
    'mappingId',m.id,
    'mappingVersion',m.version,
    'mappingStatus',m.status,
    'externalSku',m.external_sku,
    'itemId',m.item_id,
    'unit',m.unit,
    'note',m.note,
    'mappingCreatedAt',m.created_at),
   concat_ws(' ',a.action,m.external_sku,a.detail->>'externalSku',ii.ice_code,ii.name_cn)::text
  FROM catalog.inventory_audit a
  LEFT JOIN catalog.inventory_sku_mapping m ON m.id::text=a.entity_ref
  LEFT JOIN warehouse_identity mw ON mw.external_warehouse_id=coalesce(
    (SELECT w3.external_warehouse_id FROM catalog.inventory_warehouse w3 WHERE w3.id=m.warehouse_id),
    CASE WHEN a.entity_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT w4.external_warehouse_id FROM catalog.inventory_warehouse w4 WHERE w4.id=a.entity_ref::uuid) END)
  LEFT JOIN item_identity ii ON ii.item_id=m.item_id
  WHERE a.action IN ('recheck_inventory_mapping','disable_inventory_mapping','replace_inventory_mapping')

  UNION ALL
  -- 8) 库存对应 · 国内复核采用商品对应（人工复核决定；不改写历史批次数量）
  SELECT
   ('invaudit:'||a.id::text)::text,
   a.at,
   'inventory',
   'domestic_review_decision'::text,
   a.actor_id,
   '库存商品'::text,
   coalesce(cur.name_cn,'国内复核事项')::text,
   code.ice_code,
   CASE WHEN a.detail->>'itemId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (a.detail->>'itemId')::uuid END,
   NULL::uuid,
   NULL::uuid,
   code.ice_code,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'reviewState',a.detail->>'reviewState',
    'previousReviewState',a.detail->>'previousReviewState',
    'effectiveAt',a.detail->>'effectiveAt',
    'sourceRowId',a.detail->>'sourceRowId',
    'observationId',a.detail->>'observationId',
    'datasetId',a.detail->>'datasetId',
    'previousItemId',a.detail->>'previousItemId',
    'applied',a.detail->'applied'),
   concat_ws(' ',code.ice_code,cur.name_cn,a.detail->>'sourceRowId')::text
  FROM catalog.inventory_audit a
  LEFT JOIN item_identity cur ON cur.item_id::text=CASE
    WHEN a.detail->>'itemId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN a.detail->>'itemId' END
  LEFT JOIN LATERAL (
    SELECT cc.ice_code FROM catalog.catalog_item_code cc
    WHERE cc.item_id::text=CASE WHEN a.detail->>'itemId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN a.detail->>'itemId' END LIMIT 1) code ON true
  WHERE a.action='apply_domestic_review_decision'

  UNION ALL
  -- 9) 物流 · 人工关联 / 清除商品关联（同一次保存的同一票同一方法合并成一条）
  SELECT
   ('sar:'||min(r.item_id::text)||':'||min(r.revision)::text||':'||count(*)::text||':'
     ||to_char(r.recorded_at,'YYYYMMDDHH24MISSUS'))::text,
   r.recorded_at,
   'shipment',
   (CASE WHEN r.method='manual_cleared' THEN 'shipment_association_cleared'
         ELSE 'shipment_association_manual' END)::text,
   r.actor_id,
   '货票'::text,
   coalesce(s.ticket_no,'货票')::text,
   s.market,
   NULL::uuid,
   s.id,
   NULL::uuid,
   NULL::text,
   NULL::text,
   s.ticket_no,
   s.market,
   jsonb_build_object(
    'method',r.method,
    'reason',min(r.reason),
    'items',jsonb_agg(jsonb_build_object(
      'itemId',i.id,
      'revision',r.revision,
      'productId',r.product_id,
      'previousProductId',r.previous_product_id,
      'productNameRaw',i.product_name_raw,
      'sourceSku',i.source_sku,
      'associationStatus',i.association_status,
      'iceCode',ii.ice_code,
      'nameCn',ii.name_cn,
      'previousIceCode',pii.ice_code,
      'previousNameCn',pii.name_cn) ORDER BY i.product_name_raw)),
   concat_ws(' ',s.ticket_no,s.market,min(r.reason),min(i.product_name_raw),
     min(ii.ice_code),min(ii.name_cn))::text
  FROM catalog.shipment_item_association_revision r
  JOIN catalog.shipment_item i ON i.id=r.item_id
  JOIN catalog.shipment s ON s.id=i.shipment_id
  LEFT JOIN item_identity ii ON ii.item_id=r.product_id
  LEFT JOIN item_identity pii ON pii.item_id=r.previous_product_id
  WHERE r.method IN ('manual_selected','manual_cleared')
  GROUP BY r.recorded_at,r.actor_id,r.method,s.id,s.ticket_no,s.market

  UNION ALL
  -- 10) 物流 · 人工修正数量/状态 + 恢复按原表判断
  SELECT
   ('sman:'||m.item_id::text||':'||m.revision::text)::text,
   m.recorded_at,
   'shipment',
   (CASE WHEN m.action='restore' THEN 'shipment_manual_restore'
         ELSE 'shipment_manual_correction' END)::text,
   m.actor_id,
   '货票'::text,
   coalesce(s.ticket_no,'货票')::text,
   s.market,
   i.product_id,
   s.id,
   NULL::uuid,
   ii.ice_code,
   NULL::text,
   s.ticket_no,
   s.market,
   jsonb_build_object(
    'action',m.action,
    'revision',m.revision,
    'manualStatus',m.manual_status,
    'manualShelvedQuantity',m.manual_shelved_quantity,
    'previousManualStatus',m.previous_manual_status,
    'previousManualShelvedQuantity',m.previous_manual_shelved_quantity,
    'receivedQuantity',m.received_quantity,
    'remainingQuantity',m.remaining_quantity,
    'note',m.note,
    'actorName',m.actor_name,
    'itemId',i.id,
    'productNameRaw',i.product_name_raw,
    'nameCn',ii.name_cn),
   concat_ws(' ',s.ticket_no,i.product_name_raw,ii.ice_code,ii.name_cn,m.actor_name)::text
  FROM catalog.shipment_item_manual_revision m
  JOIN catalog.shipment_item i ON i.id=m.item_id
  JOIN catalog.shipment s ON s.id=i.shipment_id
  LEFT JOIN item_identity ii ON ii.item_id=i.product_id

  UNION ALL
  -- 11) 物流 · 分合票人工决定
  SELECT
   ('grp:'||g.id::text)::text,
   coalesce(g.resolved_at,g.created_at),
   'shipment',
   'shipment_grouping_decision'::text,
   g.resolved_by,
   '货票'::text,
   coalesce(
    (SELECT string_agg(DISTINCT t->>'ticketNo','、')
     FROM jsonb_array_elements(coalesce(g.evidence->'current'->'tickets','[]'::jsonb)) t),
    '分合票复核')::text,
   (SELECT string_agg(DISTINCT t2->>'market','、')
    FROM jsonb_array_elements(coalesce(g.evidence->'current'->'tickets','[]'::jsonb)) t2),
   NULL::uuid,
   NULL::uuid,
   NULL::uuid,
   NULL::text,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'kind',g.kind,
    'decision',g.decision,
    'status',g.status,
    'resolutionNote',g.resolution_note,
    'fromSnapshotId',g.from_snapshot_id,
    'toSnapshotId',g.to_snapshot_id,
    'tickets',(
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'ticketNo',t3->>'ticketNo',
        'market',t3->>'market',
        'purchaseOrder',t3->>'purchaseOrder',
        'waybillsText',t3->>'waybillsText',
        'itemCount',jsonb_array_length(coalesce(t3->'items','[]'::jsonb)),
        'sourceRowStart',t3->>'sourceRowStart',
        'sourceRowEnd',t3->>'sourceRowEnd')),'[]'::jsonb)
      FROM jsonb_array_elements(coalesce(g.evidence->'current'->'tickets','[]'::jsonb)) t3),
    'affectedProducts',coalesce(g.evidence->'affectedProducts','[]'::jsonb)),
   concat_ws(' ',g.kind,g.decision,
     (SELECT string_agg(DISTINCT t4->>'ticketNo',' ')
      FROM jsonb_array_elements(coalesce(g.evidence->'current'->'tickets','[]'::jsonb)) t4),
     (SELECT string_agg(DISTINCT p,' ')
      FROM jsonb_array_elements_text(coalesce(g.evidence->'affectedProducts','[]'::jsonb)) p))::text
  FROM catalog.shipment_grouping_review g

  UNION ALL
  -- 12) 物流 · 撤销人工分组决定（恢复按飞书判断；active=false 且已记录撤销）
  SELECT
   ('gov:'||o.id::text)::text,
   o.revoked_at,
   'shipment',
   'shipment_grouping_revoked'::text,
   o.revoked_by,
   '货票'::text,
   coalesce(
    (SELECT string_agg(DISTINCT grp->>'ticketNo','、')
     FROM jsonb_array_elements(coalesce(o.spec->'groups','[]'::jsonb)) grp),
    '人工分组')::text,
   NULL::text,
   NULL::uuid,
   NULL::uuid,
   NULL::uuid,
   NULL::text,
   NULL::text,
   NULL::text,
   NULL::text,
   jsonb_build_object(
    'reviewId',o.review_id,
    'kind',o.kind,
    'active',o.active,
    'createdAt',o.created_at,
    'revokedAt',o.revoked_at,
    'tickets',(
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'ticketNo',grp2->>'ticketNo',
        'market',grp2->>'market',
        'purchaseOrder',grp2->>'purchaseOrder',
        'waybillsText',grp2->>'waybillsText')),'[]'::jsonb)
      FROM jsonb_array_elements(coalesce(o.spec->'groups','[]'::jsonb)) grp2)),
   concat_ws(' ',o.kind,
     (SELECT string_agg(DISTINCT grp3->>'ticketNo',' ')
      FROM jsonb_array_elements(coalesce(o.spec->'groups','[]'::jsonb)) grp3))::text
  FROM catalog.shipment_grouping_override o
  WHERE o.active=false AND o.revoked_at IS NOT NULL
 ),
 scoped AS (
  SELECT r.* FROM records r
  WHERE (p_actor IS NULL OR r.actor_id=p_actor)
    AND (p_from IS NULL OR r.at>=p_from)
    AND (p_to IS NULL OR r.at<p_to)
    AND (v_search IS NULL OR r.search_text ILIKE '%'||v_search||'%')
 ),
 filtered AS (
  SELECT sc.*, count(*) OVER () AS filtered_total
  FROM scoped sc
  WHERE v_category='all' OR sc.category=v_category
 ),
 paged AS (
  SELECT * FROM filtered ORDER BY at DESC, id ASC LIMIT v_limit OFFSET v_offset
 )
 SELECT
  coalesce((SELECT max(filtered_total) FROM filtered),0),
  coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',p.id,
    'at',p.at,
    'category',p.category,
    'action',p.action,
    'actorId',p.actor_id,
    'actorName',(SELECT pf.display_name FROM public.profiles pf WHERE pf.id=p.actor_id),
    'objectKind',p.object_kind,
    'objectTitle',p.object_title,
    'objectRef',p.object_ref,
    'itemId',p.item_id,
    'ticketId',p.ticket_id,
    'batchId',p.batch_id,
    'iceCode',p.ice_code,
    'externalSku',p.external_sku,
    'ticketNo',p.ticket_no,
    'market',p.market,
    'detail',p.detail) ORDER BY p.at DESC,p.id ASC) FROM paged p),'[]'::jsonb),
  coalesce((SELECT jsonb_agg(jsonb_build_object(
     'actorId',s.actor_id,
     'name',coalesce(s.display_name,'未记录账号'),
     'count',s.c) ORDER BY s.c DESC,s.display_name NULLS LAST) FROM (
      SELECT r.actor_id,max(pf.display_name) AS display_name,count(*)::integer AS c
      FROM records r
      LEFT JOIN public.profiles pf ON pf.id=r.actor_id
      GROUP BY r.actor_id) s),'[]'::jsonb),
  coalesce((SELECT jsonb_object_agg(s.category,s.c) FROM (
     SELECT sc.category,count(*)::integer AS c FROM scoped sc GROUP BY sc.category) s),'{}'::jsonb)
 INTO v_total,v_rows,v_actors,v_category_counts;
 RETURN jsonb_build_object(
  'ok',true,
  'total',v_total,
  'offset',v_offset,
  'limit',v_limit,
  'category',v_category,
  'search',v_search,
  'rows',v_rows,
  'actors',v_actors,
  'categoryCounts',v_category_counts,
  'readAt',now());
END $$;

REVOKE ALL ON FUNCTION catalog.read_operation_records(text,uuid,timestamptz,timestamptz,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_operation_records(text,uuid,timestamptz,timestamptz,text,integer,integer) TO ice_p0_02_app_runner;

RESET ROLE;
