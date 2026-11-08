-- ICE catalog 033: 物流在途「拆票 / 合票复核」与人工分组覆盖（第十二轮）。
--
-- 合同：docs/tasks/shipment-in-transit-v1.md §18（第十二轮）。
-- 口径（不得违反）：
--   * 每次成功读取对照上一次成功读取的「商品分别在哪张票上」；疑似拆票/合票由服务端
--     检测并写入本文件的复核表，页面显示可点击的「待复核」数量；
--   * 人工决定与飞书不同时，把决定保存成 shipment_grouping_override；之后每次读取都按
--     同一口径解释（服务端分组解释哈希参与内容哈希），避免下一条普通更新把分组改回去；
--   * 同一处归属变化用 signature 去重：归属没再变化，后续同步不重复提醒；
--   * 「恢复按飞书判断」只停用覆盖，不改写历史复核记录；
--   * 复核期间其它票照常入库；本次来源的每条明细只属于一张票，不在新旧两票重复计入。
--
-- 安装约定：幂等（CREATE TABLE/INDEX IF NOT EXISTS、CREATE OR REPLACE FUNCTION、
-- 显式 REVOKE/GRANT）；必须在 026–032 之后重放。026–032 原文件不改。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 表
-- ---------------------------------------------------------------------------

-- 分组变化复核：一行 = 一次需要人工确认的拆票/合票。
CREATE TABLE IF NOT EXISTS catalog.shipment_grouping_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(btrim(source_key))<=100),
 -- 稳定签名：同样的票键 + 同样的商品分配只提醒一次。
 signature text NOT NULL CHECK(signature~'^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN('split','merge')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','resolved')),
 decision text CHECK(decision IN('split_confirmed','keep_one','merge_confirmed',
   'keep_separate','restored')),
 -- 对照数据：上次怎么分 / 本次怎么分（单号、商品、数量）。
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 from_snapshot_id uuid REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 to_snapshot_id uuid REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 resolution_note text,
 UNIQUE(source_key,signature),
 CHECK(status='pending' OR decision IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS shipment_grouping_review_pending
 ON catalog.shipment_grouping_review(source_key,status,created_at DESC,id DESC);

-- 人工分组覆盖：复核结论与飞书不同时生效，之后每次读取都按它解释。
CREATE TABLE IF NOT EXISTS catalog.shipment_grouping_override (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(btrim(source_key))<=100),
 review_id uuid NOT NULL REFERENCES catalog.shipment_grouping_review ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('split','merge')),
 signature text NOT NULL CHECK(signature~'^[a-f0-9]{64}$'),
 spec jsonb NOT NULL CHECK(jsonb_typeof(spec)='object'),
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 revoked_at timestamptz,
 revoked_by uuid REFERENCES public.profiles ON DELETE RESTRICT
);
-- 一次复核最多一条生效覆盖。
CREATE UNIQUE INDEX IF NOT EXISTS shipment_grouping_override_active_key
 ON catalog.shipment_grouping_override(source_key,review_id) WHERE active;
CREATE INDEX IF NOT EXISTS shipment_grouping_override_source
 ON catalog.shipment_grouping_override(source_key,active,created_at,id);

-- RLS：与 026–032 同一策略风格；表级权限全部收回，只允许经函数读写。
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['shipment_grouping_review','shipment_grouping_override'] LOOP
  EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS (
   SELECT 1 FROM pg_policies
   WHERE schemaname='catalog' AND tablename=t AND policyname='enabled_admin'
  ) THEN
   EXECUTE format(
    'CREATE POLICY enabled_admin ON catalog.%I FOR ALL '
    || 'USING (current_user <> ''ice_p0_02_owner'' AND catalog.is_admin()) '
    || 'WITH CHECK (current_user <> ''ice_p0_02_owner'' AND catalog.is_admin())',t);
  END IF;
  IF NOT EXISTS (
   SELECT 1 FROM pg_policies
   WHERE schemaname='catalog' AND tablename=t AND policyname='shipment_definer_owner'
  ) THEN
   EXECUTE format(
    'CREATE POLICY shipment_definer_owner ON catalog.%I FOR ALL '
    || 'USING (current_user=''ice_p0_02_owner'') '
    || 'WITH CHECK (current_user=''ice_p0_02_owner'')',t);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE catalog.shipment_grouping_review, catalog.shipment_grouping_override
 FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;

-- ---------------------------------------------------------------------------
-- 2. 读取：上次成功读取的当前分组 + 生效覆盖 + 已提醒签名
--    服务端只在真正读来源成功后才用这个上下文；读取失败不产生复核。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_grouping_state_core() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text; v_latest uuid; v_tickets jsonb:='[]'::jsonb; v_overrides jsonb:='[]'::jsonb;
 v_signatures jsonb:='[]'::jsonb;
BEGIN
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 IF v_latest IS NULL THEN
  RETURN jsonb_build_object('snapshotId',NULL,'tickets','[]'::jsonb,'overrides','[]'::jsonb,
   'reviewSignatures','[]'::jsonb);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'shipmentId',t.shipment_id,
   'ticketKey',t.ticket_key,
   'ticketNo',t.ticket_no,
   'market',t.market,
   'waybillsText',t.waybills_text,
   'purchaseOrder',t.purchase_order,
   'sourceRowStart',t.source_row_start,
   'sourceRowEnd',t.source_row_end,
   'items',t.items)
  ORDER BY t.source_row_start,t.shipment_id),'[]'::jsonb)
 INTO v_tickets
 FROM (
  SELECT s.id shipment_id,s.ticket_key,s.ticket_no,s.market,s.waybills_text,
   s.purchase_order,s.source_row_start,s.source_row_end,
   (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'itemId',i.id,
      'productNameRaw',i.product_name_raw,
      'productNameNorm',i.product_name_norm,
      'shippedQuantity',i.shipped_quantity)
     ORDER BY i.sort_index,i.id),'[]'::jsonb)
    FROM catalog.shipment_item i
    WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=v_latest) AS items
  FROM catalog.shipment s
  WHERE s.source_key=v_source AND s.last_seen_snapshot_id=v_latest
 ) t;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id',o.id,'reviewId',o.review_id,'kind',o.kind,'signature',o.signature,
   'spec',o.spec,'active',o.active,'createdAt',o.created_at)
  ORDER BY o.created_at,o.id),'[]'::jsonb)
 INTO v_overrides
 FROM catalog.shipment_grouping_override o
 WHERE o.source_key=v_source AND o.active;
 SELECT coalesce(jsonb_agg(r.signature ORDER BY r.created_at,r.signature),'[]'::jsonb)
 INTO v_signatures
 FROM catalog.shipment_grouping_review r
 WHERE r.source_key=v_source;
 RETURN jsonb_build_object('snapshotId',v_latest,'tickets',v_tickets,
  'overrides',v_overrides,'reviewSignatures',v_signatures);
END $$;

-- 页面/动作入口：启用中的管理员。
CREATE OR REPLACE FUNCTION catalog.read_shipment_grouping_state() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_admin();
 RETURN catalog.read_shipment_grouping_state_core();
END $$;

-- 后台定时读取入口：受限 sync runner。
CREATE OR REPLACE FUNCTION catalog.worker_read_shipment_grouping_state() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.read_shipment_grouping_state_core();
END $$;

-- ---------------------------------------------------------------------------
-- 3. 写入：登记复核（服务端检测结论；同签名只记一次）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.record_shipment_grouping_reviews_core(
 p_reviews jsonb,p_actor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text; v_review jsonb; v_id uuid; v_ids jsonb:='[]'::jsonb;
 v_kind text; v_signature text; v_evidence jsonb;
BEGIN
 IF p_reviews IS NULL OR jsonb_typeof(p_reviews)<>'array' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviews' USING ERRCODE='22023'; END IF;
 v_source:=catalog.shipment_current_source_key();
 IF v_source IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:source' USING ERRCODE='22023'; END IF;
 FOR v_review IN SELECT value FROM jsonb_array_elements(p_reviews) LOOP
  v_kind:=coalesce(v_review->>'kind','');
  IF v_kind NOT IN('split','merge') THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviewKind' USING ERRCODE='22023'; END IF;
  v_signature:=lower(btrim(coalesce(v_review->>'signature','')));
  IF v_signature!~'^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviewSignature' USING ERRCODE='22023'; END IF;
  v_evidence:=v_review->'evidence';
  IF v_evidence IS NULL OR jsonb_typeof(v_evidence)<>'object' THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reviewEvidence' USING ERRCODE='22023'; END IF;
  INSERT INTO catalog.shipment_grouping_review(source_key,signature,kind,status,evidence,
   from_snapshot_id,to_snapshot_id)
  VALUES(v_source,v_signature,v_kind,'pending',v_evidence,
   CASE WHEN coalesce(v_review->>'fromSnapshotId','')~'^[0-9a-fA-F-]{36}$'
     THEN (v_review->>'fromSnapshotId')::uuid END,
   CASE WHEN coalesce(v_review->>'toSnapshotId','')~'^[0-9a-fA-F-]{36}$'
     THEN (v_review->>'toSnapshotId')::uuid END)
  ON CONFLICT (source_key,signature) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
   v_ids:=v_ids||jsonb_build_array(v_id);
   v_id:=NULL;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'created',jsonb_array_length(v_ids),'ids',v_ids);
END $$;

CREATE OR REPLACE FUNCTION catalog.record_shipment_grouping_reviews(p_reviews jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 RETURN catalog.record_shipment_grouping_reviews_core(p_reviews,v_actor);
END $$;

CREATE OR REPLACE FUNCTION catalog.worker_record_shipment_grouping_reviews(p_reviews jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.record_shipment_grouping_reviews_core(p_reviews,NULL);
END $$;

-- ---------------------------------------------------------------------------
-- 4. 页面读取：待复核 + 生效中的人工分组（恢复按飞书判断的入口）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_grouping_reviews() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text;
BEGIN
 PERFORM catalog.require_admin();
 v_source:=catalog.shipment_current_source_key();
 IF v_source IS NULL THEN RETURN jsonb_build_object('pending','[]'::jsonb,'activeOverrides','[]'::jsonb); END IF;
 RETURN jsonb_build_object(
  'pending',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'id',r.id,'kind',r.kind,'status',r.status,'decision',r.decision,
     'signature',r.signature,'evidence',r.evidence,
     'createdAt',r.created_at,'resolvedAt',r.resolved_at,
     'resolutionNote',r.resolution_note)
    ORDER BY r.created_at DESC,r.id DESC),'[]'::jsonb)
   FROM catalog.shipment_grouping_review r
   WHERE r.source_key=v_source AND r.status='pending'),
  'activeOverrides',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'id',o.id,'reviewId',o.review_id,'kind',o.kind,'signature',o.signature,
     'reviewKind',r.kind,'decision',r.decision,'createdAt',o.created_at)
    ORDER BY o.created_at DESC,o.id DESC),'[]'::jsonb)
   FROM catalog.shipment_grouping_override o
   JOIN catalog.shipment_grouping_review r ON r.id=o.review_id
   WHERE o.source_key=v_source AND o.active));
END $$;

-- ---------------------------------------------------------------------------
-- 5. 人工决定：接受飞书分组 / 保存覆盖 / 恢复按飞书判断
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.resolve_shipment_grouping_review(p_review_id uuid,
 p_decision text,p_override jsonb,p_note text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_review catalog.shipment_grouping_review; v_note text;
 v_override_kind text; v_spec jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_review_id IS NULL THEN
  RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',NULL,
   'errorCode','SHIPMENT_INVALID_INPUT','errorMessage','复核参数不完整'); END IF;
 SELECT * INTO v_review FROM catalog.shipment_grouping_review r
 WHERE r.id=p_review_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',NULL,
   'errorCode','SHIPMENT_REVIEW_NOT_FOUND','errorMessage','复核记录不存在'); END IF;
 IF v_review.status<>'pending' THEN
  RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',v_review.decision,
   'errorCode','SHIPMENT_REVIEW_RESOLVED','errorMessage','这条复核已经处理'); END IF;
 IF NOT (
   (v_review.kind='split' AND p_decision IN('split_confirmed','keep_one'))
   OR (v_review.kind='merge' AND p_decision IN('merge_confirmed','keep_separate'))
 ) THEN
  RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',NULL,
   'errorCode','SHIPMENT_INVALID_INPUT','errorMessage','复核结论与拆票/合票类型不匹配'); END IF;
 v_note:=nullif(left(btrim(coalesce(p_note,'')),500),'');
 IF p_override IS NOT NULL AND jsonb_typeof(p_override)='object' THEN
  v_override_kind:=coalesce(p_override->>'kind','');
  v_spec:=p_override->'spec';
  IF v_override_kind NOT IN('split','merge') OR v_spec IS NULL
   OR jsonb_typeof(v_spec)<>'object' THEN
   RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',NULL,
    'errorCode','SHIPMENT_INVALID_INPUT','errorMessage','分组覆盖参数无效'); END IF;
  INSERT INTO catalog.shipment_grouping_override(source_key,review_id,kind,signature,spec,
   active,created_by)
  VALUES(v_review.source_key,v_review.id,v_override_kind,v_review.signature,v_spec,true,v_actor)
  ON CONFLICT (source_key,review_id) WHERE active DO NOTHING;
 END IF;
 UPDATE catalog.shipment_grouping_review SET status='resolved',decision=p_decision,
  resolved_at=now(),resolved_by=v_actor,resolution_note=v_note
 WHERE id=v_review.id;
 RETURN jsonb_build_object('ok',true,'reviewId',v_review.id,'decision',p_decision,
  'kind',v_review.kind,'errorCode',NULL,'errorMessage',NULL);
END $$;

-- 恢复按飞书判断：停用该次复核写入的覆盖（历史复核与覆盖行保留）。
CREATE OR REPLACE FUNCTION catalog.restore_shipment_grouping_judgement(p_review_id uuid,
 p_note text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_review catalog.shipment_grouping_review; v_note text; v_count integer:=0;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_review_id IS NULL THEN
  RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',NULL,
   'errorCode','SHIPMENT_INVALID_INPUT','errorMessage','复核参数不完整'); END IF;
 SELECT * INTO v_review FROM catalog.shipment_grouping_review r
 WHERE r.id=p_review_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',NULL,
   'errorCode','SHIPMENT_REVIEW_NOT_FOUND','errorMessage','复核记录不存在'); END IF;
 v_note:=nullif(left(btrim(coalesce(p_note,'')),500),'');
 UPDATE catalog.shipment_grouping_override SET active=false,revoked_at=now(),revoked_by=v_actor
 WHERE review_id=v_review.id AND active;
 GET DIAGNOSTICS v_count=ROW_COUNT;
 IF v_count=0 THEN
  RETURN jsonb_build_object('ok',false,'reviewId',p_review_id,'decision',v_review.decision,
   'errorCode','SHIPMENT_OVERRIDE_NOT_ACTIVE','errorMessage','没有生效中的人工分组'); END IF;
 UPDATE catalog.shipment_grouping_review SET status='resolved',decision='restored',
  resolved_at=now(),resolved_by=v_actor,resolution_note=v_note
 WHERE id=v_review.id;
 RETURN jsonb_build_object('ok',true,'reviewId',v_review.id,'decision','restored',
  'errorCode',NULL,'errorMessage',NULL);
END $$;

-- ---------------------------------------------------------------------------
-- 6. 重新入库：最新成功快照的原始网格（人工决定后按当前覆盖重新解释一次）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_latest_snapshot_raw() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_source text; v_latest uuid; v_raw jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 IF v_latest IS NULL THEN RETURN NULL; END IF;
 SELECT s.raw INTO v_raw FROM catalog.shipment_source_snapshot s WHERE s.id=v_latest;
 IF v_raw IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('snapshotId',v_latest,
  'values',coalesce(v_raw->'values','[]'::jsonb),
  'merges',coalesce(v_raw->'merges','[]'::jsonb),
  'collection',coalesce(v_raw->'collection','{}'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 7. 分组变化后的商品绑定延续：同一来源里能对上的原明细商品直接沿用，
--    不需要用户重新选一次货号（只补从未人工处理过的未关联明细）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.adopt_shipment_item_associations_core(p_snapshot_id uuid,
 p_actor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item catalog.shipment_item; v_product uuid; v_product_text text;
 v_status text; v_method text;
 v_source text; v_fields jsonb; v_new_revision integer; v_adopted integer:=0;
 v_candidate_count integer; v_product_count integer;
BEGIN
 IF p_snapshot_id IS NULL THEN RETURN jsonb_build_object('adopted',0); END IF;
 SELECT s.source_key INTO v_source FROM catalog.shipment_source_snapshot s WHERE s.id=p_snapshot_id;
 IF v_source IS NULL THEN RETURN jsonb_build_object('adopted',0); END IF;
 FOR v_item IN
  SELECT i.* FROM catalog.shipment_item i
  WHERE i.source_key=v_source AND i.last_seen_snapshot_id=p_snapshot_id
   AND i.product_id IS NULL AND i.association_status='none' AND i.association_method IS NULL
  ORDER BY i.shipment_id,i.sort_index,i.id
  FOR UPDATE
 LOOP
  SELECT count(*),count(DISTINCT o.product_id),max(o.product_id::text)
  INTO v_candidate_count,v_product_count,v_product_text
  FROM catalog.shipment_item o
  WHERE o.source_key=v_item.source_key
   AND o.id<>v_item.id
   AND o.product_name_norm=v_item.product_name_norm
   AND o.shipped_quantity=v_item.shipped_quantity
   AND o.product_id IS NOT NULL
   AND o.last_seen_snapshot_id<>p_snapshot_id;
  -- 只有唯一商品、且确有旧明细可对时才沿用；多条不同商品视为歧义，不猜。
  IF v_candidate_count=0 OR v_product_count<>1 THEN CONTINUE; END IF;
  v_product:=v_product_text::uuid;
  SELECT o.association_status,coalesce(o.association_method,'carried_previous_read')
  INTO v_status,v_method
  FROM catalog.shipment_item o
  WHERE o.source_key=v_item.source_key AND o.product_name_norm=v_item.product_name_norm
   AND o.shipped_quantity=v_item.shipped_quantity AND o.product_id=v_product
   AND o.last_seen_snapshot_id<>p_snapshot_id
  ORDER BY o.last_seen_at DESC,o.id LIMIT 1;
  v_status:=CASE WHEN v_status IN('auto','manual') THEN v_status ELSE 'auto' END;
  v_new_revision:=v_item.revision+1;
  UPDATE catalog.shipment_item SET product_id=v_product,association_status=v_status,
   association_method=v_method,associated_at=now(),
   revision=v_new_revision,updated_at=now()
  WHERE id=v_item.id;
  v_fields:=jsonb_build_object(
   'product_name_raw',v_item.product_name_raw,'product_name_norm',v_item.product_name_norm,
   'shipped_quantity',v_item.shipped_quantity,'received_quantity',v_item.received_quantity,
   'receipt_basis',v_item.receipt_basis,'source_note',v_item.source_note,
   'unit_text',v_item.unit_text,'source_sku',v_item.source_sku,
   'product_id',v_product,'association_status',v_status,'association_method',v_method);
  INSERT INTO catalog.shipment_item_association_revision(item_id,revision,product_id,
   previous_product_id,method,actor_id,reason,recorded_at)
  VALUES(v_item.id,v_new_revision,v_product,NULL,v_method,p_actor,
   '分组变化后沿用原明细商品',now());
  INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,fields,
   recorded_at,recorded_by)
  VALUES(v_item.id,v_new_revision,p_snapshot_id,v_fields,now(),p_actor);
  v_adopted:=v_adopted+1;
 END LOOP;
 RETURN jsonb_build_object('adopted',v_adopted);
END $$;

CREATE OR REPLACE FUNCTION catalog.adopt_shipment_item_associations(p_snapshot_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 RETURN catalog.adopt_shipment_item_associations_core(p_snapshot_id,v_actor);
END $$;

CREATE OR REPLACE FUNCTION catalog.worker_adopt_shipment_item_associations(p_snapshot_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.adopt_shipment_item_associations_core(p_snapshot_id,NULL);
END $$;

-- ---------------------------------------------------------------------------
-- 8. 权限：页面/动作只给 app 角色；后台只给受限 sync 角色；core 不授权。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_shipment_grouping_state_core() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_grouping_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_read_shipment_grouping_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.record_shipment_grouping_reviews_core(jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.record_shipment_grouping_reviews(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_record_shipment_grouping_reviews(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_grouping_reviews() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.resolve_shipment_grouping_review(uuid,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.restore_shipment_grouping_judgement(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_latest_snapshot_raw() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.adopt_shipment_item_associations_core(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.adopt_shipment_item_associations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_adopt_shipment_item_associations(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
 catalog.read_shipment_grouping_state(),
 catalog.record_shipment_grouping_reviews(jsonb),
 catalog.read_shipment_grouping_reviews(),
 catalog.resolve_shipment_grouping_review(uuid,text,jsonb,text),
 catalog.restore_shipment_grouping_judgement(uuid,text),
 catalog.read_shipment_latest_snapshot_raw(),
 catalog.adopt_shipment_item_associations(uuid)
 TO ice_p0_02_app_runner;

GRANT EXECUTE ON FUNCTION
 catalog.worker_read_shipment_grouping_state(),
 catalog.worker_record_shipment_grouping_reviews(jsonb),
 catalog.worker_adopt_shipment_item_associations(uuid)
 TO ice_p0_02_sync_runner;

RESET ROLE;
