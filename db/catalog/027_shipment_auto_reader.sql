-- ICE catalog 027: 物流在途「定时自动读取 + 已确认商品对应复用」。
--
-- 合同：docs/tasks/shipment-in-transit-v1.md §12（第六轮：定时读取与对应复用）。
-- 前置：026（货票在途）已应用；本文件只新增对象，不修改 00001-025，不改
-- inventory_schema_state.version、不写 inventory* 表。
--
-- 本文件做四件事（轻量，不建通用任务平台/规则平台）：
--   1. 两张表：
--      - catalog.shipment_product_mapping：本来源 + 规范化品名 + 适用市场 → 商品库商品，
--        保存确认依据/操作者/版本（唯一键 source_key + product_name_norm + market）。
--      - catalog.shipment_auto_reader：定时读取的单例状态（启用、间隔、下次计划、最近一次
--        结果/失败原因、读取租约、后台进程心跳）。租约同时用于「手动刷新」和「定时读取」，
--        同一来源同时只允许一轮读取。
--   2. 对应复用：保存勾选「后续沿用」时写对应表；采用时只处理本次来源仍在、尚未人工绑定/
--      人工清除的明细；「标准名称精确且唯一」自动匹配仍作为没有已确认对应时的兜底。
--      已确认对应优先于同名精确自动匹配（只覆盖 auto，不覆盖人工绑定/人工清除）。
--   3. 后台入口：只给受限运行角色 ice_p0_02_sync_runner 的包装函数（session_user 显式校验），
--      复用 026 的 core 函数，读取人/操作者为 NULL（不冒充管理员、不依赖浏览器登录）。
--   4. 页面读取：read_shipment_auto_reader_status() 走启用中管理员，返回自动读取状态。
--
-- 安装约定：幂等（CREATE TABLE/INDEX IF NOT EXISTS、CREATE OR REPLACE FUNCTION、DO 块建策略），
-- 必须在 026 之后重放。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 表
-- ---------------------------------------------------------------------------

-- 已确认的商品对应（复用范围）：一个来源 + 规范化品名 + 市场只允许一个商品。
CREATE TABLE IF NOT EXISTS catalog.shipment_product_mapping (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(source_key)<=100),
 -- 与 catalog.shipment_item.product_name_norm 同一规范化结果（解析层产出，库内不改写）。
 product_name_norm text NOT NULL CHECK(length(btrim(product_name_norm))>0),
 -- 适用市场（来源「国家」原值）；未知市场的明细不参与采用，保持未关联。
 market text NOT NULL CHECK(length(btrim(market))>0 AND length(market)<=100),
 product_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 -- 确认依据：用户决定编号/已通过的轮次说明，不存自由备注以外的技术内容。
 basis text NOT NULL CHECK(length(btrim(basis))>0 AND length(basis)<=500),
 created_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 UNIQUE(source_key,product_name_norm,market)
);
CREATE INDEX IF NOT EXISTS shipment_product_mapping_product
 ON catalog.shipment_product_mapping(product_id);

-- 定时读取的单例状态 + 读取租约（手动/定时共用，防止同一来源同时读两轮）。
CREATE TABLE IF NOT EXISTS catalog.shipment_auto_reader (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(source_key)<=100),
 enabled boolean NOT NULL DEFAULT true,
 interval_minutes integer NOT NULL DEFAULT 10 CHECK(interval_minutes BETWEEN 1 AND 1440),
 next_run_at timestamptz,
 read_lease_owner text,
 read_lease_until timestamptz,
 last_started_at timestamptz,
 last_finished_at timestamptz,
 last_result text CHECK(last_result IN('success','unchanged','failed')),
 last_snapshot_id uuid REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 last_read_at timestamptz,
 last_ticket_count integer CHECK(last_ticket_count IS NULL OR last_ticket_count>=0),
 last_item_count integer CHECK(last_item_count IS NULL OR last_item_count>=0),
 last_error_code text,
 last_error_message text,
 heartbeat_at timestamptz,
 runner_pid integer,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO catalog.shipment_auto_reader(source_key,enabled,interval_minutes,next_run_at)
VALUES('feishu_logistics_sheet',true,10,now()+interval '10 minutes')
ON CONFLICT (id) DO NOTHING;

-- RLS：与 026 同款（enabled_admin 给启用中管理员；owner 策略给 definer 函数），FORCE RLS。
DO $$ DECLARE t text;
BEGIN
 FOR t IN SELECT unnest(ARRAY['shipment_product_mapping','shipment_auto_reader']) LOOP
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
   WHERE schemaname='catalog' AND tablename=t AND policyname='shipment_auto_owner'
  ) THEN
   EXECUTE format(
    'CREATE POLICY shipment_auto_owner ON catalog.%I FOR ALL '
    || 'USING (current_user=''ice_p0_02_owner'') '
    || 'WITH CHECK (current_user=''ice_p0_02_owner'')',t);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON TABLE catalog.shipment_product_mapping, catalog.shipment_auto_reader
 FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;

-- ---------------------------------------------------------------------------
-- 2. 内部辅助（不单独授权，只供下面的鉴权/后台包装调用）
-- ---------------------------------------------------------------------------

-- 后台运行身份：只认受限 sync runner；不认浏览器管理员 JWT。
CREATE OR REPLACE FUNCTION catalog.shipment_worker_role_allowed() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT session_user='ice_p0_02_sync_runner'
$$;

-- 某来源最近一次成功快照 id（“本次来源仍在”的判据，与 026 同口径）。
CREATE OR REPLACE FUNCTION catalog.shipment_latest_success_snapshot_id(p_source_key text)
 RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT s.id FROM catalog.shipment_source_snapshot s
 WHERE s.status='success' AND (p_source_key IS NULL OR s.source_key=p_source_key)
 ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
$$;

-- 按「来源 + 规范化品名 + 市场」取已确认对应；没有对应/市场未知返回 NULL。
CREATE OR REPLACE FUNCTION catalog.shipment_mapping_lookup(p_source_key text,
 p_name_norm text,p_market text) RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT m.product_id FROM catalog.shipment_product_mapping m
 WHERE m.source_key=p_source_key AND m.product_name_norm=p_name_norm
   AND m.market=p_market
 LIMIT 1
$$;

-- 写/更新一条已确认对应（同一键只保留一个商品；重复保存只更新依据与操作者）。
-- 商品是否存在由 product_id 的外键约束保证（catalog_item 只对启用中管理员可见，
-- 后台 definer 函数不依赖它的 RLS 可见性）。
CREATE OR REPLACE FUNCTION catalog.shipment_mapping_upsert(p_source_key text,
 p_name_norm text,p_market text,p_product_id uuid,p_basis text,p_actor uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
 IF p_product_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:product' USING ERRCODE='22023'; END IF;
 INSERT INTO catalog.shipment_product_mapping(source_key,product_name_norm,market,product_id,
  basis,created_by,updated_by)
 VALUES(p_source_key,p_name_norm,p_market,p_product_id,p_basis,p_actor,p_actor)
 ON CONFLICT (source_key,product_name_norm,market) DO UPDATE
  SET product_id=excluded.product_id,basis=excluded.basis,updated_by=excluded.updated_by,
   updated_at=now(),revision=catalog.shipment_product_mapping.revision+1
 RETURNING id INTO v_id;
 RETURN v_id;
END $$;

-- 采用已确认对应：只处理该来源「最近一次成功读取」里仍在的明细。
--   a) 从未绑定过的未关联明细（product_id 为空且 association_method 为空）→ 采用；
--   b) 早先靠「标准名称精确且唯一」自动匹配的明细，若已确认对应指向不同商品 → 改采用对应；
--   人工绑定（manual_selected）与人工清除（manual_cleared）一律不动；市场未知不采用。
-- 每条改动都追加明细修订与关联历史（依据=confirmed_mapping）。返回本次改动条数。
CREATE OR REPLACE FUNCTION catalog.shipment_mapping_apply_core(p_source_key text,p_actor uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item catalog.shipment_item; v_shipment catalog.shipment;
 v_product uuid; v_fields jsonb; v_new_revision integer;
 v_adopted integer:=0; v_items jsonb:='[]'::jsonb; v_latest uuid;
BEGIN
 v_latest:=catalog.shipment_latest_success_snapshot_id(p_source_key);
 IF v_latest IS NULL THEN
  RETURN jsonb_build_object('adopted',0,'items','[]'::jsonb); END IF;
 FOR v_item IN
  SELECT i.* FROM catalog.shipment_item i
  JOIN catalog.shipment s ON s.id=i.shipment_id
  WHERE i.source_key=p_source_key AND i.last_seen_snapshot_id=v_latest
    AND s.market IS NOT NULL
    AND (
      (i.product_id IS NULL AND i.association_method IS NULL)
      OR (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
        AND catalog.shipment_mapping_lookup(i.source_key,i.product_name_norm,s.market)
          IS DISTINCT FROM i.product_id)
    )
  ORDER BY i.shipment_id,i.sort_index,i.id
  FOR UPDATE OF i
 LOOP
  SELECT * INTO v_shipment FROM catalog.shipment s WHERE s.id=v_item.shipment_id;
  v_product:=catalog.shipment_mapping_lookup(v_item.source_key,v_item.product_name_norm,
   v_shipment.market);
  CONTINUE WHEN v_product IS NULL;
  v_new_revision:=v_item.revision+1;
  UPDATE catalog.shipment_item SET product_id=v_product,association_status='auto',
   association_method='confirmed_mapping',associated_by=p_actor,associated_at=now(),
   revision=v_new_revision,updated_at=now()
  WHERE id=v_item.id;
  v_fields:=jsonb_build_object(
   'product_name_raw',v_item.product_name_raw,'product_name_norm',v_item.product_name_norm,
   'shipped_quantity',v_item.shipped_quantity,'received_quantity',v_item.received_quantity,
   'receipt_basis',v_item.receipt_basis,'source_note',v_item.source_note,
   'unit_text',v_item.unit_text,'source_sku',v_item.source_sku,
   'product_id',v_product,'association_status','auto',
   'association_method','confirmed_mapping');
  INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,fields,
   recorded_at,recorded_by)
  VALUES(v_item.id,v_new_revision,v_item.last_seen_snapshot_id,v_fields,now(),p_actor);
  INSERT INTO catalog.shipment_item_association_revision(item_id,revision,product_id,
   previous_product_id,method,actor_id,reason,recorded_at)
  VALUES(v_item.id,v_new_revision,v_product,v_item.product_id,'auto',
   p_actor,'已确认对应（confirmed_mapping）',now());
  v_adopted:=v_adopted+1;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('itemId',v_item.id,
   'previousProductId',v_item.product_id,'productId',v_product));
 END LOOP;
 RETURN jsonb_build_object('adopted',v_adopted,'items',v_items);
END $$;

-- 读取当前来源键（本包只有一个来源）。
CREATE OR REPLACE FUNCTION catalog.shipment_auto_reader_source_key() RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT source_key FROM catalog.shipment_auto_reader WHERE id),
  'feishu_logistics_sheet')
$$;

-- 读取自动读取状态（页面用；内部函数，鉴权包装见 §4.1）。
CREATE OR REPLACE FUNCTION catalog.shipment_auto_reader_state_json() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s catalog.shipment_auto_reader;
BEGIN
 SELECT * INTO s FROM catalog.shipment_auto_reader WHERE id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object(
  'enabled',s.enabled,
  'intervalMinutes',s.interval_minutes,
  'nextRunAt',s.next_run_at,
  'lastStartedAt',s.last_started_at,
  'lastFinishedAt',s.last_finished_at,
  'lastResult',s.last_result,
  'lastReadAt',s.last_read_at,
  'lastTicketCount',s.last_ticket_count,
  'lastItemCount',s.last_item_count,
  'lastErrorCode',s.last_error_code,
  'lastErrorMessage',s.last_error_message,
  'heartbeatAt',s.heartbeat_at,
  'runnerPid',s.runner_pid,
  'workerOnline',(s.heartbeat_at IS NOT NULL AND now()-s.heartbeat_at<interval '90 seconds'),
  'running',(s.read_lease_until IS NOT NULL AND s.read_lease_until>now()),
  'leaseOwner',CASE WHEN s.read_lease_until IS NOT NULL AND s.read_lease_until>now()
   THEN s.read_lease_owner ELSE NULL END);
END $$;

-- ---------------------------------------------------------------------------
-- 3. 后台入口（只给受限运行身份 ice_p0_02_sync_runner）
-- ---------------------------------------------------------------------------

-- 心跳：后台进程每轮上报；页面据此显示“自动读取是否运行”。
CREATE OR REPLACE FUNCTION catalog.worker_shipment_heartbeat(p_pid integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 UPDATE catalog.shipment_auto_reader
  SET heartbeat_at=now(),runner_pid=p_pid,updated_at=now()
  WHERE id;
 RETURN catalog.shipment_auto_reader_state_json();
END $$;

-- 抢占一次定时读取：到点 + 无进行中的读取租约才返回 claimed=true。
-- 抢占时即把 next_run_at 推到下一个周期（读取失败也会按周期重试，不堆叠）。
CREATE OR REPLACE FUNCTION catalog.worker_claim_shipment_read(p_owner text,p_pid integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s catalog.shipment_auto_reader; v_owner text;
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 v_owner:=nullif(btrim(coalesce(p_owner,'')),'');
 IF v_owner IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:owner' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM catalog.shipment_auto_reader WHERE id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'enabled',false); END IF;
 UPDATE catalog.shipment_auto_reader SET heartbeat_at=now(),runner_pid=p_pid,updated_at=now()
  WHERE id;
 IF NOT s.enabled THEN
  RETURN jsonb_build_object('claimed',false,'enabled',false,'nextRunAt',s.next_run_at); END IF;
 IF s.read_lease_until IS NOT NULL AND s.read_lease_until>now() THEN
  RETURN jsonb_build_object('claimed',false,'enabled',true,'busy',true,
   'leaseOwner',s.read_lease_owner,'leaseUntil',s.read_lease_until,
   'nextRunAt',s.next_run_at); END IF;
 IF s.next_run_at IS NOT NULL AND s.next_run_at>now() THEN
  RETURN jsonb_build_object('claimed',false,'enabled',true,'due',false,
   'nextRunAt',s.next_run_at); END IF;
 UPDATE catalog.shipment_auto_reader SET
  read_lease_owner=v_owner,
  read_lease_until=now()+interval '15 minutes',
  last_started_at=now(),
  next_run_at=now()+make_interval(mins=>s.interval_minutes),
  updated_at=now()
  WHERE id;
 RETURN jsonb_build_object('claimed',true,'enabled',true,'sourceKey',s.source_key,
  'intervalMinutes',s.interval_minutes,'startedAt',now(),
  'nextRunAt',now()+make_interval(mins=>s.interval_minutes));
END $$;

-- 结束一次读取：释放租约并记录结果（失败保留上次成功数据，只写最近失败原因）。
CREATE OR REPLACE FUNCTION catalog.worker_finish_shipment_read(p_owner text,p_result jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s catalog.shipment_auto_reader; v_owner text; v_status text;
 v_snapshot uuid; v_read_at timestamptz; v_tickets integer; v_items integer;
 v_code text; v_message text;
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 v_owner:=nullif(btrim(coalesce(p_owner,'')),'');
 SELECT * INTO s FROM catalog.shipment_auto_reader WHERE id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','NO_STATE'); END IF;
 IF s.read_lease_owner IS DISTINCT FROM v_owner THEN
  RETURN jsonb_build_object('ok',false,'error','LEASE_NOT_OWNED'); END IF;
 v_status:=coalesce(p_result->>'status','failed');
 IF v_status NOT IN('success','unchanged','failed') THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:status' USING ERRCODE='22023'; END IF;
 IF coalesce(p_result->>'snapshotId','') ~
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
  v_snapshot:=(p_result->>'snapshotId')::uuid; END IF;
 IF coalesce(p_result->>'readAt','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
  v_read_at:=(p_result->>'readAt')::timestamptz; ELSE v_read_at:=now(); END IF;
 v_tickets:=CASE WHEN coalesce(p_result->>'ticketCount','') ~ '^[0-9]+$'
  THEN (p_result->>'ticketCount')::integer END;
 v_items:=CASE WHEN coalesce(p_result->>'itemCount','') ~ '^[0-9]+$'
  THEN (p_result->>'itemCount')::integer END;
 v_code:=nullif(btrim(coalesce(p_result->>'errorCode','')),'');
 v_message:=left(nullif(btrim(coalesce(p_result->>'errorMessage','')),''),1000);
 UPDATE catalog.shipment_auto_reader SET
  read_lease_owner=NULL,read_lease_until=NULL,
  last_finished_at=now(),last_result=v_status,last_snapshot_id=v_snapshot,
  last_read_at=v_read_at,last_ticket_count=v_tickets,last_item_count=v_items,
  last_error_code=CASE WHEN v_status='failed' THEN v_code ELSE NULL END,
  last_error_message=CASE WHEN v_status='failed' THEN v_message ELSE NULL END,
  next_run_at=now()+make_interval(mins=>s.interval_minutes),
  updated_at=now()
  WHERE id;
 RETURN jsonb_build_object('ok',true)||catalog.shipment_auto_reader_state_json();
END $$;

-- 后台摄取：复用 026 core（操作者 NULL）并在同一事务里采用已确认对应。
CREATE OR REPLACE FUNCTION catalog.worker_ingest_shipment_snapshot(p_snapshot jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb; v_applied jsonb;
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 v_result:=catalog.ingest_shipment_snapshot_core(p_snapshot,NULL);
 v_applied:=catalog.shipment_mapping_apply_core(
  catalog.shipment_auto_reader_source_key(),NULL);
 RETURN v_result||jsonb_build_object('adoptedAssociations',
  coalesce((v_applied->>'adopted')::integer,0));
END $$;

CREATE OR REPLACE FUNCTION catalog.worker_record_shipment_read_failure(p_error jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.record_shipment_read_failure_core(p_error,NULL);
END $$;

CREATE OR REPLACE FUNCTION catalog.worker_read_shipment_identity_index() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.read_shipment_identity_index_core();
END $$;

CREATE OR REPLACE FUNCTION catalog.worker_apply_shipment_product_mappings() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.shipment_worker_role_allowed() THEN
  RAISE EXCEPTION 'SHIPMENT_WORKER_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN catalog.shipment_mapping_apply_core(
  catalog.shipment_auto_reader_source_key(),NULL);
END $$;

-- ---------------------------------------------------------------------------
-- 4. 页面/动作入口（启用中管理员；走 ice_p0_02_app_runner + JWT）
-- ---------------------------------------------------------------------------

-- 4.1 自动读取状态（状态条显示：是否运行、间隔、最近成功/失败、下次计划）。
CREATE OR REPLACE FUNCTION catalog.read_shipment_auto_reader_status() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_admin();
 RETURN catalog.shipment_auto_reader_state_json();
END $$;

-- 4.2 采用已确认对应（刷新/保存后调用；即使来源内容没变也能补上适用的未关联明细）。
CREATE OR REPLACE FUNCTION catalog.apply_shipment_product_mappings() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 RETURN catalog.shipment_mapping_apply_core(catalog.shipment_auto_reader_source_key(),
  v_actor);
END $$;

-- 4.2b 手动刷新入库：复用 026 core 并在同一事务里采用已确认对应（管理员为操作者）。
CREATE OR REPLACE FUNCTION catalog.ingest_shipment_snapshot_with_mappings(p_snapshot jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_result jsonb; v_applied jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_result:=catalog.ingest_shipment_snapshot_core(p_snapshot,v_actor);
 v_applied:=catalog.shipment_mapping_apply_core(
  catalog.shipment_auto_reader_source_key(),v_actor);
 RETURN v_result||jsonb_build_object('adoptedAssociations',
  coalesce((v_applied->>'adopted')::integer,0));
END $$;

-- 4.3 手动刷新租约：与定时读取共用同一把锁；已有读取在进行时返回 busy（不并发读同一来源）。
CREATE OR REPLACE FUNCTION catalog.begin_shipment_manual_refresh(p_owner text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s catalog.shipment_auto_reader; v_owner text;
BEGIN
 PERFORM catalog.require_admin();
 v_owner:=nullif(btrim(coalesce(p_owner,'')),'');
 IF v_owner IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:owner' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM catalog.shipment_auto_reader WHERE id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('claimed',true,'owner',v_owner); END IF;
 IF s.read_lease_until IS NOT NULL AND s.read_lease_until>now() THEN
  RETURN jsonb_build_object('claimed',false,'busy',true,
   'leaseOwner',s.read_lease_owner,'leaseUntil',s.read_lease_until); END IF;
 UPDATE catalog.shipment_auto_reader SET read_lease_owner=v_owner,
  read_lease_until=now()+interval '15 minutes',updated_at=now()
  WHERE id;
 RETURN jsonb_build_object('claimed',true,'owner',v_owner);
END $$;

CREATE OR REPLACE FUNCTION catalog.end_shipment_manual_refresh(p_owner text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s catalog.shipment_auto_reader; v_owner text;
BEGIN
 PERFORM catalog.require_admin();
 v_owner:=nullif(btrim(coalesce(p_owner,'')),'');
 SELECT * INTO s FROM catalog.shipment_auto_reader WHERE id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'released',false); END IF;
 IF s.read_lease_owner IS DISTINCT FROM v_owner THEN
  RETURN jsonb_build_object('ok',true,'released',false); END IF;
 UPDATE catalog.shipment_auto_reader SET read_lease_owner=NULL,read_lease_until=NULL,
  updated_at=now() WHERE id;
 RETURN jsonb_build_object('ok',true,'released',true);
END $$;

-- 4.4 保存关联；勾选「后续沿用」时同一条事务里保存已确认对应，并立即采用到其他适用明细。
CREATE OR REPLACE FUNCTION catalog.save_shipment_item_association_with_mapping(p_item_id uuid,
 p_product_id uuid,p_expected_revision integer,p_reason text,p_remember boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_item catalog.shipment_item; v_market text;
 v_result jsonb; v_mapping_saved boolean:=false; v_applied jsonb:=jsonb_build_object('adopted',0);
 v_basis text;
BEGIN
 v_actor:=catalog.require_admin();
 v_result:=catalog.update_shipment_item_association_core(p_item_id,p_product_id,
  p_expected_revision,p_reason,v_actor);
 IF p_remember IS NOT TRUE OR v_result->>'ok'<>'true' OR p_product_id IS NULL THEN
  RETURN v_result||jsonb_build_object('mappingSaved',false,'adoptedCount',0); END IF;
 SELECT * INTO v_item FROM catalog.shipment_item i WHERE i.id=p_item_id;
 SELECT s.market INTO v_market FROM catalog.shipment s WHERE s.id=v_item.shipment_id;
 IF v_market IS NULL THEN
  RETURN v_result||jsonb_build_object('mappingSaved',false,'adoptedCount',0,
   'mappingNote','市场未提供，未保存通用对应'); END IF;
 v_basis:=left(coalesce(nullif(btrim(coalesce(p_reason,'')),''),
  '人工确认：同来源、同品名、同市场沿用'),500);
 PERFORM catalog.shipment_mapping_upsert(v_item.source_key,v_item.product_name_norm,
  v_market,p_product_id,v_basis,v_actor);
 v_mapping_saved:=true;
 v_applied:=catalog.shipment_mapping_apply_core(v_item.source_key,v_actor);
 RETURN v_result||jsonb_build_object('mappingSaved',v_mapping_saved,
  'adoptedCount',coalesce((v_applied->>'adopted')::integer,0),
  'market',v_market);
END $$;

-- 4.5 定时读取设置（运维入口，不放页面；默认 10 分钟）。
CREATE OR REPLACE FUNCTION catalog.update_shipment_auto_reader_settings(p_enabled boolean,
 p_interval_minutes integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s catalog.shipment_auto_reader;
BEGIN
 PERFORM catalog.require_admin();
 IF p_enabled IS NULL OR p_interval_minutes IS NULL
  OR p_interval_minutes<1 OR p_interval_minutes>1440 THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:settings' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM catalog.shipment_auto_reader WHERE id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SHIPMENT_AUTO_READER_MISSING' USING ERRCODE='55000'; END IF;
 UPDATE catalog.shipment_auto_reader SET enabled=p_enabled,
  interval_minutes=p_interval_minutes,
  next_run_at=CASE WHEN p_enabled THEN now()+make_interval(mins=>p_interval_minutes)
   ELSE next_run_at END,
  updated_at=now()
  WHERE id;
 RETURN catalog.shipment_auto_reader_state_json();
END $$;

-- ---------------------------------------------------------------------------
-- 5. 权限：页面/动作只给 app 角色；后台只给受限 sync 角色；内部 core 不授权。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.shipment_worker_role_allowed() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_latest_success_snapshot_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_mapping_lookup(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_mapping_upsert(text,text,text,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_mapping_apply_core(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_auto_reader_source_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_auto_reader_state_json() FROM PUBLIC;

REVOKE ALL ON FUNCTION catalog.worker_shipment_heartbeat(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_claim_shipment_read(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_finish_shipment_read(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_ingest_shipment_snapshot(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_record_shipment_read_failure(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_read_shipment_identity_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.worker_apply_shipment_product_mappings() FROM PUBLIC;

REVOKE ALL ON FUNCTION catalog.read_shipment_auto_reader_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.apply_shipment_product_mappings() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.ingest_shipment_snapshot_with_mappings(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.begin_shipment_manual_refresh(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.end_shipment_manual_refresh(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.save_shipment_item_association_with_mapping(uuid,uuid,integer,text,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.update_shipment_auto_reader_settings(boolean,integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
 catalog.read_shipment_auto_reader_status(),
 catalog.apply_shipment_product_mappings(),
 catalog.ingest_shipment_snapshot_with_mappings(jsonb),
 catalog.begin_shipment_manual_refresh(text),
 catalog.end_shipment_manual_refresh(text),
 catalog.save_shipment_item_association_with_mapping(uuid,uuid,integer,text,boolean),
 catalog.update_shipment_auto_reader_settings(boolean,integer)
 TO ice_p0_02_app_runner;

GRANT EXECUTE ON FUNCTION
 catalog.worker_shipment_heartbeat(integer),
 catalog.worker_claim_shipment_read(text,integer),
 catalog.worker_finish_shipment_read(text,jsonb),
 catalog.worker_ingest_shipment_snapshot(jsonb),
 catalog.worker_record_shipment_read_failure(jsonb),
 catalog.worker_read_shipment_identity_index(),
 catalog.worker_apply_shipment_product_mappings()
 TO ice_p0_02_sync_runner;

RESET ROLE;
