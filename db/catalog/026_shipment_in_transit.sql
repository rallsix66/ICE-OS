-- ICE catalog 026: 货票与在途管理 v1（物流在途）。
--
-- 合同：docs/tasks/shipment-in-transit-v1.md §1.3（身份延续）/ §1.4（H 到货口径）/ §1.5（来源移除）
--       / §4（数据模型）/ §5（读取与失败恢复）/ §6（商品关联）。
-- 类型合同：src/features/shipment/types.ts（DTO 字段名即本文件 jsonb 输出的键名）。
--
-- 本文件只做三件事，不建通用平台、不改 00001-025、不改 inventory_schema_state.version：
--   1. 6 张表（catalog.shipment*），FORCE RLS + enabled_admin / owner 策略，表级权限全部收回，
--      只能经 SECURITY DEFINER 函数读写；同时幂等升级既有实例的列/约束（见 §1.1）。
--   2. 9 个函数：来源状态 / 列表 / 详情 / 商品相关货票 / 身份索引 / 商品搜索 / 快照摄取 /
--      失败登记 / 关联编辑。
--   3. 权限：REVOKE PUBLIC，GRANT EXECUTE 仅 ice_p0_02_app_runner（读写都走启用中管理员 JWT）。
--
-- 口径（不得违反）：
--   * 内部身份 = catalog.shipment.id（UUID），永不随采购单号/运单号变化：服务端先按 §1.3 匹配，
--     把 matchedShipmentId 传进来；能确认就沿用原票/明细 UUID、关联与修订链，不能确认则新建并标 pending。
--   * G「物流情况」= transport_text（运输进度，独立展示）；H「预计到货时间」= arrival_text
--     （到货/分批/上架说明）。到货判断只看 H，由解析层给出 statusClass/receivedBasis，库内不二次推断。
--   * 累计到货 received 由解析层给出：status_in_transit_zero/status_awaiting_shelving_zero→0、
--     status_arrived_full→发货量、pending→NULL、明细 sourceReceivedQuantity 非空→该值（source_quantity，
--     明细优先于票级）；不累加（同一累计值重复读取仍是同一值）。
--   * 剩余在途 remaining = 发货量 − 累计到货，只有两者都已知且未超收才出数字；未知/矛盾一律
--     NULL + state='pending'，不写 0、不算负数。
--   * 不写 inventory* / item_revision / inventory_sku_mapping / 国内快照，只写 shipment* 表。
--   * 「当前存在」= last_seen_snapshot_id = 该来源最近一次成功快照。本次来源未见 ≠ 已到货 ≠ 数量 0：
--     列表/计数/关键词/商品筛选/相关货票都不再命中，历史事实、原数量、原关联与最后出现时间保留。
--   * ingest 幂等：同内容不产生新票/明细/修订；票级字段变化才 revision+1 并追加历史；明细同理；
--     商品关联按 (shipment_id,item_key) 保留，不因再次读取丢失。
--
-- 安装约定：幂等（CREATE TABLE/INDEX IF NOT EXISTS、CREATE OR REPLACE FUNCTION、DO 块建策略/触发器/
-- 升级列与约束），必须在 024（search_inventory_items_v2）之后重放。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 表
-- ---------------------------------------------------------------------------

-- 每次读取（成功/失败）一行：来源身份 + 读取起止时间 + 内容哈希 + 原始证据。
CREATE TABLE IF NOT EXISTS catalog.shipment_source_snapshot (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(source_key)<=100),
 doc_token text,
 sheet_id text,
 revision bigint CHECK(revision IS NULL OR revision>=0),
 -- 来源文档最后编辑时间；与本次读取时间分开保存，不互相冒充。
 document_edited_at timestamptz,
 read_started_at timestamptz NOT NULL,
 read_finished_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('success','failed')),
 error_code text,
 error_message text,
 -- 原始值网格 + 合并区 + collection 元信息的内容哈希（含 parserVersion，不含读取时间）。
 content_hash text CHECK(content_hash IS NULL OR content_hash~'^[a-f0-9]{64}$'),
 ticket_count integer CHECK(ticket_count IS NULL OR ticket_count>=0),
 item_count integer CHECK(item_count IS NULL OR item_count>=0),
 -- 原始证据：值网格 / 合并区 / 来源 collection 元信息（只存库，不发布到页面）。
 raw jsonb CHECK(raw IS NULL OR jsonb_typeof(raw)='object'),
 read_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(read_finished_at>=read_started_at),
 CHECK(status='success' OR error_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS shipment_source_snapshot_read
 ON catalog.shipment_source_snapshot(source_key,read_finished_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS shipment_source_snapshot_status
 ON catalog.shipment_source_snapshot(status,read_finished_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS shipment_source_snapshot_hash
 ON catalog.shipment_source_snapshot(source_key,content_hash) WHERE status='success';

-- 当前投影：一票一行。ticket_key 只是“本次来源编号派生键”，内部身份是 id。
CREATE TABLE IF NOT EXISTS catalog.shipment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(source_key)<=100),
 ticket_key text NOT NULL CHECK(length(btrim(ticket_key))>0 AND length(ticket_key)<=300),
 ticket_no text NOT NULL CHECK(length(btrim(ticket_no))>0 AND length(ticket_no)<=300),
 market text,
 customs_method text,
 waybills_text text,
 purchase_order text,
 -- G 列「物流情况」原文：只表示运输进度，独立展示，不参与到货判断。
 transport_text text,
 -- H 列「预计到货时间」原文：到货/分批/上架说明，到货判断只看这一列。
 arrival_text text,
 vessel text,
 dispatched_text text,
 status_class text NOT NULL
  CHECK(status_class IN('in_transit','partial','arrived_pending_shelving','arrived','unknown')),
 received_basis text NOT NULL
  CHECK(received_basis IN('status_in_transit_zero','status_awaiting_shelving_zero',
   'status_arrived_full','source_quantity','pending')),
 -- 身份结论：confirmed=编号/内容能唯一对上原记录（或确实是新票）；pending=编号变化无法唯一确认。
 identity_status text NOT NULL DEFAULT 'confirmed'
  CHECK(identity_status IN('confirmed','pending')),
 identity_note text,
 source_row_start integer NOT NULL CHECK(source_row_start>0),
 source_row_end integer NOT NULL CHECK(source_row_end>=source_row_start),
 first_seen_snapshot_id uuid NOT NULL
  REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 last_seen_snapshot_id uuid NOT NULL
  REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_key,ticket_key)
);
CREATE INDEX IF NOT EXISTS shipment_market_status
 ON catalog.shipment(source_key,market,status_class);
CREATE INDEX IF NOT EXISTS shipment_last_seen
 ON catalog.shipment(source_key,last_seen_at DESC,id);

-- 当前投影：一条明细一行。received_quantity 可空（未知就是未知，不写 0）。
CREATE TABLE IF NOT EXISTS catalog.shipment_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 shipment_id uuid NOT NULL REFERENCES catalog.shipment ON DELETE RESTRICT,
 source_key text NOT NULL CHECK(length(btrim(source_key))>0 AND length(source_key)<=100),
 item_key text NOT NULL CHECK(length(btrim(item_key))>0 AND length(item_key)<=300),
 product_name_raw text NOT NULL CHECK(length(btrim(product_name_raw))>0),
 product_name_norm text NOT NULL CHECK(length(btrim(product_name_norm))>0),
 shipped_quantity integer NOT NULL CHECK(shipped_quantity>0),
 -- 累计到货：NULL=来源未提供/待核；负数拒绝；超收不在此拒绝，读函数返回 pending，不算负数。
 received_quantity integer CHECK(received_quantity IS NULL OR received_quantity>=0),
 receipt_basis text NOT NULL
  CHECK(receipt_basis IN('status_in_transit_zero','status_awaiting_shelving_zero',
   'status_arrived_full','source_quantity','pending')),
 source_note text,
 -- 来源没有单位/SKU 列：本版恒为 NULL，页面显示“来源未提供”，不换算。
 unit_text text,
 source_sku text,
 product_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 association_status text NOT NULL DEFAULT 'none'
  CHECK(association_status IN('auto','manual','none')),
 association_method text,
 associated_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 associated_at timestamptz,
 sort_index integer NOT NULL DEFAULT 0 CHECK(sort_index>=0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 -- 该明细最后一次出现在来源里的快照（本次未出现的明细保留旧行，不删除）。
 last_seen_snapshot_id uuid NOT NULL
  REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(shipment_id,item_key)
);
CREATE INDEX IF NOT EXISTS shipment_item_product
 ON catalog.shipment_item(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shipment_item_shipment
 ON catalog.shipment_item(shipment_id,sort_index,id);
CREATE INDEX IF NOT EXISTS shipment_item_last_seen
 ON catalog.shipment_item(source_key,last_seen_snapshot_id);

-- 不可变业务历史：票级 / 明细级字段快照；内容未变不追加。
CREATE TABLE IF NOT EXISTS catalog.shipment_revision (
 shipment_id uuid NOT NULL REFERENCES catalog.shipment ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 snapshot_id uuid NOT NULL REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='object'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 recorded_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 PRIMARY KEY(shipment_id,revision)
);
CREATE INDEX IF NOT EXISTS shipment_revision_recorded
 ON catalog.shipment_revision(shipment_id,recorded_at DESC);

CREATE TABLE IF NOT EXISTS catalog.shipment_item_revision (
 shipment_item_id uuid NOT NULL REFERENCES catalog.shipment_item ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 snapshot_id uuid NOT NULL REFERENCES catalog.shipment_source_snapshot ON DELETE RESTRICT,
 fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='object'),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 recorded_by uuid REFERENCES public.profiles ON DELETE RESTRICT,
 PRIMARY KEY(shipment_item_id,revision)
);
CREATE INDEX IF NOT EXISTS shipment_item_revision_recorded
 ON catalog.shipment_item_revision(shipment_item_id,recorded_at DESC);

-- 商品关联的追加历史（原目标/新目标/方式/人/时间/原因）。
CREATE TABLE IF NOT EXISTS catalog.shipment_item_association_revision (
 item_id uuid NOT NULL REFERENCES catalog.shipment_item ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 product_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 previous_product_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 method text NOT NULL CHECK(method IN('auto','manual_selected','manual_cleared')),
 actor_id uuid REFERENCES public.profiles ON DELETE RESTRICT,
 reason text,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(item_id,revision)
);

-- ---------------------------------------------------------------------------
-- 1.1 既有实例幂等升级（第一轮已上线 026 时执行；新实例上是空操作）
--     列改名 G/H：status_text→transport_text、eta_text→arrival_text（保留原值）；
--     新增身份列；状态 5 类、到货依据 5 值（约束名与 inline CHECK 的默认名一致）。
-- ---------------------------------------------------------------------------
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema='catalog' AND table_name='shipment' AND column_name='status_text')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema='catalog' AND table_name='shipment' AND column_name='transport_text') THEN
  ALTER TABLE catalog.shipment RENAME COLUMN status_text TO transport_text;
 END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema='catalog' AND table_name='shipment' AND column_name='eta_text')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema='catalog' AND table_name='shipment' AND column_name='arrival_text') THEN
  ALTER TABLE catalog.shipment RENAME COLUMN eta_text TO arrival_text;
 END IF;
END $$;

ALTER TABLE catalog.shipment
 ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'confirmed',
 ADD COLUMN IF NOT EXISTS identity_note text;

ALTER TABLE catalog.shipment DROP CONSTRAINT IF EXISTS shipment_status_class_check;
ALTER TABLE catalog.shipment ADD CONSTRAINT shipment_status_class_check
 CHECK(status_class IN('in_transit','partial','arrived_pending_shelving','arrived','unknown'));
ALTER TABLE catalog.shipment DROP CONSTRAINT IF EXISTS shipment_received_basis_check;
ALTER TABLE catalog.shipment ADD CONSTRAINT shipment_received_basis_check
 CHECK(received_basis IN('status_in_transit_zero','status_awaiting_shelving_zero',
  'status_arrived_full','source_quantity','pending'));
ALTER TABLE catalog.shipment DROP CONSTRAINT IF EXISTS shipment_identity_status_check;
ALTER TABLE catalog.shipment ADD CONSTRAINT shipment_identity_status_check
 CHECK(identity_status IN('confirmed','pending'));

ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_receipt_basis_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_receipt_basis_check
 CHECK(receipt_basis IN('status_in_transit_zero','status_awaiting_shelving_zero',
  'status_arrived_full','source_quantity','pending'));

-- 历史行不可改：复用 016 的同一拒绝函数（025 同款）。
DO $$ DECLARE t text;
BEGIN
 FOR t IN SELECT unnest(ARRAY['shipment_revision','shipment_item_revision',
   'shipment_item_association_revision']) LOOP
  IF NOT EXISTS (
   SELECT 1 FROM pg_trigger
   WHERE tgname='immutable_history' AND tgrelid=('catalog.'||t)::regclass
  ) THEN
   EXECUTE format(
    'CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog.%I '
    || 'FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()',t);
  END IF;
 END LOOP;
END $$;

-- RLS：与 016/025 同一策略风格。enabled_admin 供 app 角色（启用中管理员 JWT）；
-- owner 策略让 SECURITY DEFINER 函数（current_user=owner）能读写；FORCE 让 owner 也受策略约束。
DO $$ DECLARE t text;
BEGIN
 FOR t IN SELECT unnest(ARRAY['shipment_source_snapshot','shipment','shipment_item',
   'shipment_revision','shipment_item_revision','shipment_item_association_revision']) LOOP
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

-- 表级权限全部收回：只允许经函数读写（与 025 一致）。
REVOKE ALL ON TABLE
 catalog.shipment_source_snapshot, catalog.shipment, catalog.shipment_item,
 catalog.shipment_revision, catalog.shipment_item_revision,
 catalog.shipment_item_association_revision
 FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;

-- ---------------------------------------------------------------------------
-- 2. 只读辅助（不单独授权，仅供下面的 definer 函数内部调用）
-- ---------------------------------------------------------------------------

-- 某来源最近一次成功读取的快照 id：“当前存在”的唯一判据。
-- 排序用 (read_finished_at, created_at, id)：同一毫秒内有两次读取时，按服务端写入先后兜底。
CREATE OR REPLACE FUNCTION catalog.shipment_latest_success_snapshot(p_source_key text)
 RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT s.id FROM catalog.shipment_source_snapshot s
 WHERE s.status='success' AND (p_source_key IS NULL OR s.source_key=p_source_key)
 ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
$$;

-- 有快照的来源键（本包只有一个来源；取最近一条快照的 source_key）。
CREATE OR REPLACE FUNCTION catalog.shipment_current_source_key()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT s.source_key FROM catalog.shipment_source_snapshot s
 ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
$$;

-- 单个字段值的展示文本：状态/依据/身份/关联状态走中文标签，关联商品显示 ICE 货号。
CREATE OR REPLACE FUNCTION catalog.shipment_display_value(p_key text,p_value jsonb) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE
  WHEN p_value IS NULL OR p_value='null'::jsonb THEN NULL
  WHEN p_key='status_class' THEN CASE p_value#>>'{}'
    WHEN 'in_transit' THEN '运输在途' WHEN 'partial' THEN '部分到货待核'
    WHEN 'arrived_pending_shelving' THEN '已到货待上架'
    WHEN 'arrived' THEN '已到货上架' WHEN 'unknown' THEN '状态未提供待核' END
  WHEN p_key='received_basis' THEN CASE p_value#>>'{}'
    WHEN 'status_in_transit_zero' THEN '运输在途未到货'
    WHEN 'status_awaiting_shelving_zero' THEN '已到货待上架（未结束在途）'
    WHEN 'status_arrived_full' THEN '整票已到货上架'
    WHEN 'source_quantity' THEN '来源到货数量'
    WHEN 'pending' THEN '待核' END
  WHEN p_key='identity_status' THEN CASE p_value#>>'{}'
    WHEN 'confirmed' THEN '身份已确认' WHEN 'pending' THEN '身份待核' END
  WHEN p_key='association_status' THEN CASE p_value#>>'{}'
    WHEN 'auto' THEN '自动关联' WHEN 'manual' THEN '人工关联' WHEN 'none' THEN '未关联' END
  WHEN p_key='product_id' THEN (
    SELECT coalesce(catalog.inventory_item_identity(x.v)->>'iceCode',
      catalog.inventory_item_identity(x.v)->>'nameCn','已关联商品')
    FROM (SELECT CASE WHEN coalesce(p_value#>>'{}','')
      ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (p_value#>>'{}')::uuid END AS v) x
    WHERE x.v IS NOT NULL)
  ELSE nullif(btrim(p_value#>>'{}'),'')
 END
$$;

-- 两次字段快照的差异 → 人类可读的变更条目（首次快照没有前值）。
-- 含第一轮遗留键名 status_text/eta_text（同一列改名），保证老修订历史仍能正确显示。
CREATE OR REPLACE FUNCTION catalog.shipment_field_change_labels(p_previous jsonb,p_current jsonb)
 RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH f(k,label,ord) AS (VALUES
   ('status_class','业务状态',1),('transport_text','运输进度（G）',2),
   ('arrival_text','到货与上架说明（H）',3),('status_text','运输进度（G）',2),
   ('eta_text','到货与上架说明（H）',3),
   ('market','目的市场',4),('customs_method','报关方式',5),('waybills_text','运单号',6),
   ('purchase_order','采购单号',7),('vessel','船名',8),('dispatched_text','发出时间',9),
   ('identity_status','身份状态',10),('identity_note','身份待核说明',11),
   ('source_row_start','来源起始行',12),('source_row_end','来源结束行',13),
   ('product_name_raw','来源商品名',14),('product_name_norm','规范化商品名',15),
   ('shipped_quantity','发货量',16),('received_quantity','累计到货',17),
   ('receipt_basis','到货依据',18),('source_note','来源备注',19),
   ('product_id','关联商品',20),('association_status','关联状态',21)
 ), d AS (
  SELECT f.label||'：'
    ||coalesce(catalog.shipment_display_value(f.k,p_previous->f.k),'未提供')||' → '
    ||coalesce(catalog.shipment_display_value(f.k,p_current->f.k),'未提供') AS label, f.ord
  FROM f
  WHERE p_previous IS NOT NULL
    AND coalesce(p_previous->f.k,'null'::jsonb) IS DISTINCT FROM coalesce(p_current->f.k,'null'::jsonb)
 )
 SELECT CASE WHEN p_previous IS NULL THEN ARRAY['首次读取保存']::text[]
   ELSE coalesce(array_agg(d.label ORDER BY d.ord),'{}'::text[]) END
 FROM d
$$;

-- ---------------------------------------------------------------------------
-- 3. 来源状态：最近成功读取 + 最近一次尝试（失败不覆盖成功）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_source_status() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_admin();
 RETURN (
  WITH last_success AS (
   SELECT * FROM catalog.shipment_source_snapshot s
   WHERE s.status='success'
   ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
  ), last_attempt AS (
   SELECT * FROM catalog.shipment_source_snapshot s
   ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
  ), meta AS (
   SELECT * FROM catalog.shipment_source_snapshot s
   WHERE s.raw->'collection' IS NOT NULL
   ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
  )
  SELECT jsonb_build_object(
   'sourceKey',coalesce((SELECT a.source_key FROM last_attempt a),
     (SELECT m.source_key FROM meta m),'feishu_logistics_sheet'),
   'docTitle',(SELECT m.raw->'collection'->>'docTitle' FROM meta m),
   'sheetTitle',(SELECT m.raw->'collection'->>'sheetTitle' FROM meta m),
   'lastSuccess',(SELECT jsonb_build_object(
     'snapshotId',ls.id,'readAt',ls.read_finished_at,'documentEditedAt',ls.document_edited_at,
     'revision',ls.revision,'ticketCount',coalesce(ls.ticket_count,0),
     'itemCount',coalesce(ls.item_count,0)) FROM last_success ls),
   'lastAttempt',(SELECT jsonb_build_object(
     'snapshotId',la.id,'readAt',la.read_finished_at,'status',la.status,
     'errorCode',la.error_code,'errorMessage',la.error_message) FROM last_attempt la)));
END $$;

-- ---------------------------------------------------------------------------
-- 4. 列表：分页 + 5 类状态计数 + 市场计数 + 当前/历史范围 + 本次来源未见计数
--    p_market: NULL/''/'all'=不筛；'__unknown__'=市场未提供（market IS NULL）；其它按原值。
--    p_status: NULL/''/'all'=不筛；其余必须落在 5 个分类内。
--    p_include_absent=false（默认）：只返回本次来源仍在的票；true：连历史行一起返回。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS catalog.read_shipment_list(text,text,text,uuid,integer,integer);
CREATE OR REPLACE FUNCTION catalog.read_shipment_list(p_market text,p_status text,p_search text,
 p_product uuid,p_include_absent boolean,p_limit integer,p_offset integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_market text; v_unknown_market boolean:=false; v_status text; v_search text;
 v_limit integer; v_offset integer; v_include_absent boolean:=coalesce(p_include_absent,false);
 v_source text; v_latest uuid; v_latest_at timestamptz;
BEGIN
 PERFORM catalog.require_admin();
 v_market:=nullif(btrim(coalesce(p_market,'')),'');
 IF v_market IN('all') THEN v_market:=NULL; END IF;
 IF v_market='__unknown__' THEN v_unknown_market:=true; v_market:=NULL; END IF;
 v_status:=nullif(btrim(coalesce(p_status,'')),'');
 IF v_status IN('all') THEN v_status:=NULL; END IF;
 IF v_status IS NOT NULL AND v_status NOT IN('in_transit','partial',
   'arrived_pending_shelving','arrived','unknown') THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:status' USING ERRCODE='22023'; END IF;
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,20),100));
 v_offset:=greatest(0,coalesce(p_offset,0));
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 SELECT sn.read_finished_at INTO v_latest_at FROM catalog.shipment_source_snapshot sn
 WHERE sn.id=v_latest;
 RETURN (
  WITH scoped AS (
   -- 当前/历史范围 + 关键词 + 商品筛选；明细一律按“该票自己的当前明细”判断。
   SELECT s.* FROM catalog.shipment s
   WHERE (v_include_absent OR v_latest IS NULL OR s.last_seen_snapshot_id=v_latest)
     AND (v_search IS NULL
      OR s.ticket_no ILIKE '%'||v_search||'%'
      OR coalesce(s.purchase_order,'') ILIKE '%'||v_search||'%'
      OR coalesce(s.waybills_text,'') ILIKE '%'||v_search||'%'
      OR EXISTS(SELECT 1 FROM catalog.shipment_item i
        WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
          AND (i.product_name_raw ILIKE '%'||v_search||'%'
            OR i.product_name_norm ILIKE '%'||lower(v_search)||'%')))
     AND (p_product IS NULL OR EXISTS(SELECT 1 FROM catalog.shipment_item i
        WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
          AND i.product_id=p_product))
  ), by_market AS (
   SELECT s.* FROM scoped s
   WHERE CASE WHEN v_unknown_market THEN s.market IS NULL
     ELSE (v_market IS NULL OR s.market=v_market) END
  ), current_page AS (
   SELECT s.* FROM by_market s
   WHERE v_status IS NULL OR s.status_class=v_status
   ORDER BY s.last_seen_at DESC,s.id
   LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
   'total',(SELECT count(*) FROM by_market s WHERE v_status IS NULL OR s.status_class=v_status),
   'offset',v_offset,
   'limit',v_limit,
   'includeAbsent',v_include_absent,
   'counts',(SELECT jsonb_build_object(
     'total',count(*),
     'inTransit',count(*) FILTER (WHERE s.status_class='in_transit'),
     'partial',count(*) FILTER (WHERE s.status_class='partial'),
     'arrivedPendingShelving',count(*) FILTER (WHERE s.status_class='arrived_pending_shelving'),
     'arrived',count(*) FILTER (WHERE s.status_class='arrived'),
     'unknown',count(*) FILTER (WHERE s.status_class='unknown')) FROM by_market s),
   'markets',(SELECT coalesce(jsonb_agg(jsonb_build_object('market',m.market,'count',m.c)
      ORDER BY m.market NULLS FIRST),'[]'::jsonb) FROM (
     SELECT s.market,count(*) AS c FROM scoped s
     WHERE v_status IS NULL OR s.status_class=v_status
     GROUP BY s.market) m),
   'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object(
      'shipmentId',r.id,
      'market',r.market,
      'purchaseOrder',r.purchase_order,
      'waybillsText',r.waybills_text,
      'ticketNo',r.ticket_no,
      -- 只算该票自己的当前明细；不同明细不求和，摘要只给名称，最多 3 条。
      'itemCount',(SELECT count(*) FROM catalog.shipment_item i
        WHERE i.shipment_id=r.id AND i.last_seen_snapshot_id=r.last_seen_snapshot_id),
      'productSummary',(SELECT coalesce(jsonb_agg(t.product_name_raw ORDER BY t.sort_index,t.id),'[]'::jsonb)
        FROM (SELECT i.product_name_raw,i.sort_index,i.id
          FROM catalog.shipment_item i
          WHERE i.shipment_id=r.id AND i.last_seen_snapshot_id=r.last_seen_snapshot_id
          ORDER BY i.sort_index,i.id LIMIT 3) t),
      'statusClass',r.status_class,
      'transportText',r.transport_text,
      'arrivalText',r.arrival_text,
      'quantityPending',EXISTS(SELECT 1 FROM catalog.shipment_item i
        WHERE i.shipment_id=r.id AND i.last_seen_snapshot_id=r.last_seen_snapshot_id
          AND (i.received_quantity IS NULL OR i.received_quantity>i.shipped_quantity)),
      'identityStatus',r.identity_status,
      'identityNote',r.identity_note,
      'presentInLatestRead',(v_latest IS NOT NULL AND r.last_seen_snapshot_id=v_latest),
      'lastSeenAt',r.last_seen_at) ORDER BY r.last_seen_at DESC,r.id),'[]'::jsonb)
     FROM current_page r),
   -- 本次来源未见计数：来源内全量，不受列表筛选影响。
   'absentTickets',(SELECT count(*) FROM catalog.shipment s
     WHERE v_latest IS NOT NULL AND s.last_seen_snapshot_id<>v_latest),
   'absentItems',(SELECT count(*) FROM catalog.shipment_item i
     WHERE v_latest IS NOT NULL AND i.last_seen_snapshot_id<>v_latest),
   'latestReadAt',v_latest_at,
   'sourceStatus',catalog.read_shipment_source_status()));
END $$;

-- ---------------------------------------------------------------------------
-- 5. 详情：票级 + 当前明细 + 本次来源未见的历史明细 + 最近变更记录 + 来源状态
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_detail(p_shipment_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_shipment catalog.shipment; v_latest uuid; v_latest_at timestamptz;
BEGIN
 PERFORM catalog.require_admin();
 IF p_shipment_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:shipmentId' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_shipment FROM catalog.shipment s WHERE s.id=p_shipment_id;
 -- 票不存在：返回 NULL，由页面按空态处理，不伪造空票。
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- “当前”一律以最近一次成功快照为参照（与列表/搜索/相关货票同口径）：
 -- 整票本次来源未见时，items 为空、missingItems 是该票全部明细，itemCount=0。
 v_latest:=catalog.shipment_latest_success_snapshot(v_shipment.source_key);
 IF v_latest IS NOT NULL THEN
  SELECT sn.read_finished_at INTO v_latest_at FROM catalog.shipment_source_snapshot sn
  WHERE sn.id=v_latest;
 END IF;
 RETURN jsonb_build_object(
  'shipment',jsonb_build_object(
   'shipmentId',v_shipment.id,
   'ticketNo',v_shipment.ticket_no,
   'ticketKey',v_shipment.ticket_key,
   'market',v_shipment.market,
   'customsMethod',v_shipment.customs_method,
   'waybillsText',v_shipment.waybills_text,
   'purchaseOrder',v_shipment.purchase_order,
   'statusClass',v_shipment.status_class,
   'transportText',v_shipment.transport_text,
   'arrivalText',v_shipment.arrival_text,
   'vessel',v_shipment.vessel,
   'dispatchedText',v_shipment.dispatched_text,
   'itemCount',(SELECT count(*) FROM catalog.shipment_item i
     WHERE i.shipment_id=v_shipment.id AND i.last_seen_snapshot_id=v_latest),
   'quantityPending',EXISTS(SELECT 1 FROM catalog.shipment_item i
     WHERE i.shipment_id=v_shipment.id AND i.last_seen_snapshot_id=v_latest
       AND (i.received_quantity IS NULL OR i.received_quantity>i.shipped_quantity)),
   'identityStatus',v_shipment.identity_status,
   'identityNote',v_shipment.identity_note,
   'presentInLatestRead',(v_latest IS NOT NULL AND v_shipment.last_seen_snapshot_id=v_latest),
   'sourceRowStart',v_shipment.source_row_start,
   'sourceRowEnd',v_shipment.source_row_end,
   'firstSeenAt',v_shipment.first_seen_at,
   'lastSeenAt',v_shipment.last_seen_at,
   'revision',v_shipment.revision),
  'items',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'itemId',i.id,
     'itemKey',i.item_key,
     'productNameRaw',i.product_name_raw,
     'productNameNorm',i.product_name_norm,
     'shippedQuantity',i.shipped_quantity,
     'receivedQuantity',i.received_quantity,
     'receiptBasis',i.receipt_basis,
     -- 未知 / 超收矛盾不出数字，也不用 0 冒充；由 remainingState 标 pending。
     'remainingQuantity',CASE WHEN i.received_quantity IS NULL
        OR i.received_quantity>i.shipped_quantity THEN NULL
       ELSE i.shipped_quantity-i.received_quantity END,
     'remainingState',CASE WHEN i.received_quantity IS NULL
        OR i.received_quantity>i.shipped_quantity THEN 'pending' ELSE 'known' END,
     'unitText',i.unit_text,
     'sourceSku',i.source_sku,
     'sourceNote',i.source_note,
     'product',CASE WHEN i.product_id IS NULL THEN NULL
       ELSE catalog.inventory_item_identity(i.product_id) END,
     'associationStatus',i.association_status,
     'associationMethod',i.association_method,
     'associatedAt',i.associated_at,
     'revision',i.revision) ORDER BY i.sort_index,i.id),'[]'::jsonb)
   FROM catalog.shipment_item i
   WHERE i.shipment_id=v_shipment.id
     AND i.last_seen_snapshot_id=v_latest),
  -- 本次来源未见的历史明细（票整体退出时这里是该票全部明细）：只读，保留原数量/原关联/最后出现时间。
  'missingItems',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'itemId',i.id,
     'itemKey',i.item_key,
     'productNameRaw',i.product_name_raw,
     'shippedQuantity',i.shipped_quantity,
     'receivedQuantity',i.received_quantity,
     'receiptBasis',i.receipt_basis,
     'remainingQuantity',CASE WHEN i.received_quantity IS NULL
        OR i.received_quantity>i.shipped_quantity THEN NULL
       ELSE i.shipped_quantity-i.received_quantity END,
     'remainingState',CASE WHEN i.received_quantity IS NULL
        OR i.received_quantity>i.shipped_quantity THEN 'pending' ELSE 'known' END,
     'sourceNote',i.source_note,
     'product',CASE WHEN i.product_id IS NULL THEN NULL
       ELSE catalog.inventory_item_identity(i.product_id) END,
     'associationStatus',i.association_status,
     'lastSeenAt',i.last_seen_at) ORDER BY i.sort_index,i.id),'[]'::jsonb)
   FROM catalog.shipment_item i
   WHERE i.shipment_id=v_shipment.id
     AND (v_latest IS NULL OR i.last_seen_snapshot_id IS DISTINCT FROM v_latest)),
  -- 变更记录：票级 + 明细级（明细条目自带“明细「品名」”前缀）。
  'revisions',(SELECT coalesce(jsonb_agg(jsonb_build_object(
      'revision',x.revision,'recordedAt',x.recorded_at,
      'changedFields',x.changed_fields,'snapshotId',x.snapshot_id)
     ORDER BY x.recorded_at DESC,x.revision DESC),'[]'::jsonb)
   FROM (
    SELECT r.revision,r.recorded_at,r.snapshot_id,
     catalog.shipment_field_change_labels(p.fields,r.fields) AS changed_fields
    FROM catalog.shipment_revision r
    LEFT JOIN catalog.shipment_revision p
      ON p.shipment_id=r.shipment_id AND p.revision=r.revision-1
    WHERE r.shipment_id=v_shipment.id
    UNION ALL
    SELECT r.revision,r.recorded_at,r.snapshot_id,
     ARRAY(SELECT '明细「'||coalesce(i.product_name_raw,'')||'」'||lbl
       FROM unnest(catalog.shipment_field_change_labels(p.fields,r.fields)) AS lbl)
    FROM catalog.shipment_item_revision r
    JOIN catalog.shipment_item i ON i.id=r.shipment_item_id
    LEFT JOIN catalog.shipment_item_revision p
      ON p.shipment_item_id=r.shipment_item_id AND p.revision=r.revision-1
    WHERE i.shipment_id=v_shipment.id
    ORDER BY recorded_at DESC,revision DESC
    LIMIT 50) x),
  'latestReadAt',v_latest_at,
  'sourceStatus',catalog.read_shipment_source_status());
END $$;

-- ---------------------------------------------------------------------------
-- 6. 商品详情：该商品**当前**相关的货票（历史明细不再命中；同票同商品只取第一条明细）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_product_shipment_links(p_item_id uuid,p_limit integer)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_limit integer; v_source text; v_latest uuid;
BEGIN
 PERFORM catalog.require_admin();
 IF p_item_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:itemId' USING ERRCODE='22023'; END IF;
 v_limit:=greatest(1,least(coalesce(p_limit,20),50));
 v_source:=catalog.shipment_current_source_key();
 v_latest:=catalog.shipment_latest_success_snapshot(v_source);
 RETURN (
  WITH links AS (
   SELECT DISTINCT ON (s.id)
    s.id AS shipment_id, s.ticket_no, s.market, s.purchase_order, s.waybills_text,
    s.status_class, s.transport_text, s.arrival_text,
    i.shipped_quantity, i.received_quantity,
    (SELECT count(*) FROM catalog.shipment_item i2
      WHERE i2.shipment_id=s.id AND i2.last_seen_snapshot_id=s.last_seen_snapshot_id) AS item_count
   FROM catalog.shipment_item i
   JOIN catalog.shipment s ON s.id=i.shipment_id
   WHERE i.product_id=p_item_id
     -- 当前口径：票与明细都必须是最近一次成功快照里仍存在的那一条。
     AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
     AND s.last_seen_snapshot_id=v_latest
   ORDER BY s.id,i.sort_index,i.id
  )
  SELECT jsonb_build_object(
   'total',(SELECT count(*) FROM links),
   'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object(
      'shipmentId',l.shipment_id,'ticketNo',l.ticket_no,'market',l.market,
      'purchaseOrder',l.purchase_order,'waybillsText',l.waybills_text,
      'statusClass',l.status_class,'transportText',l.transport_text,
      'arrivalText',l.arrival_text,
      'shippedQuantity',l.shipped_quantity,
      'receivedQuantity',l.received_quantity,
      'remainingQuantity',CASE WHEN l.received_quantity IS NULL
        OR l.received_quantity>l.shipped_quantity THEN NULL
       ELSE l.shipped_quantity-l.received_quantity END,
      'remainingState',CASE WHEN l.received_quantity IS NULL
        OR l.received_quantity>l.shipped_quantity THEN 'pending' ELSE 'known' END,
      'itemCount',l.item_count) ORDER BY l.ticket_no),'[]'::jsonb)
    FROM (SELECT * FROM links ORDER BY ticket_no LIMIT v_limit) l)));
END $$;

-- ---------------------------------------------------------------------------
-- 7. 身份索引：现有票的编号/市场/品名集合/身份状态（服务端匹配用，只读；含历史行）
--    身份状态随行返回：匹配到 pending 记录自身只代表继续更新这一行，不能据此解除待核。
-- ---------------------------------------------------------------------------
-- 内部核心：不做身份检查（只由下面的鉴权包装与 027 的后台包装调用，不单独授权）。
CREATE OR REPLACE FUNCTION catalog.read_shipment_identity_index_core() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 RETURN (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
   'shipmentId',s.id,
   'ticketKey',s.ticket_key,
   'purchaseOrder',s.purchase_order,
   'waybillsText',s.waybills_text,
   'market',s.market,
   'customsMethod',s.customs_method,
   'identityStatus',s.identity_status,
   'identityNote',s.identity_note,
   'productNameNorms',(SELECT coalesce(jsonb_agg(DISTINCT i.product_name_norm),'[]'::jsonb)
     FROM catalog.shipment_item i
     WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id))
   ORDER BY s.source_key,s.ticket_key),'[]'::jsonb)
  FROM catalog.shipment s);
END $$;

-- 鉴权包装：页面/动作只经这里读（启用中的管理员）。
CREATE OR REPLACE FUNCTION catalog.read_shipment_identity_index() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_admin();
 RETURN catalog.read_shipment_identity_index_core();
END $$;

-- ---------------------------------------------------------------------------
-- 8. 关联编辑用的商品搜索：复用 024 的目标商品搜索（货号/名称/条码/SKU），补条码清单与规格原文
--    规格 = 商品库独立规格列原文（可空）；候选显示按「独立规格优先、名称补充」解析，不在 SQL 里猜。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.search_products_for_shipment(p_search text,p_limit integer)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_search text; v_limit integer; v_rows jsonb;
BEGIN
 PERFORM catalog.require_admin();
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,10),20));
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'itemId',x.item_id,'iceCode',x.ice_code,'nameCn',x.name_cn,
   'specification',x.specification,'identifiers',x.identifiers) ORDER BY x.ice_code NULLS LAST,x.item_id),'[]'::jsonb)
 INTO v_rows
 FROM (
  SELECT (t->>'itemId')::uuid AS item_id,
   t->>'iceCode' AS ice_code,
   t->>'nameCn' AS name_cn,
   t->>'specification' AS specification,
   (SELECT coalesce(jsonb_agg(g.gtin),'[]'::jsonb) FROM (
     SELECT DISTINCT br.gtin FROM catalog.inventory_batch_row br
     WHERE br.item_id=(t->>'itemId')::uuid AND br.gtin IS NOT NULL) g) AS identifiers
  FROM jsonb_array_elements(catalog.search_inventory_items_v2(v_search,v_limit)) t
 ) x;
 RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- 9. 快照摄取（单事务；失败整体回滚）
--    输入 = IngestShipmentSnapshot（types.ts）：解析结果 + 服务端身份匹配结论。
--    只写 shipment* 表；不写 inventory* / item_revision / inventory_sku_mapping 等任何其它表。
-- ---------------------------------------------------------------------------
-- 内部核心：不做身份检查（p_actor 由鉴权包装传入；后台包装传 NULL 表示无人工操作者）。
-- 只由下面的鉴权包装与 027 的后台包装调用，不单独授权。
CREATE OR REPLACE FUNCTION catalog.ingest_shipment_snapshot_core(p_snapshot jsonb,p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_actor uuid; v_source text; v_collection jsonb; v_tickets jsonb;
 v_hash text; v_prev_hash text; v_prev_snapshot uuid; v_doc_token text; v_sheet_id text;
 v_revision bigint; v_edited timestamptz; v_started timestamptz; v_finished timestamptz;
 v_read_by uuid; v_snapshot_id uuid; v_uuid_re text:=
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
 v_ticket_count integer; v_item_count integer;
 v_ticket jsonb; v_item jsonb;
 v_ticket_key text; v_effective_key text; v_ticket_no text; v_status_class text;
 v_received_basis text; v_identity_status text; v_identity_note text; v_matched_id uuid;
 v_market text; v_customs text; v_waybills text; v_po text; v_transport text;
 v_arrival text; v_vessel text; v_dispatched text; v_row_start integer; v_row_end integer;
 v_shipment_id uuid; v_shipment catalog.shipment;
 v_fields jsonb; v_prev_fields jsonb; v_new_revision integer;
 v_item_key text; v_name_raw text; v_name_norm text; v_shipped integer; v_received integer;
 v_item_basis text; v_note text; v_sort integer;
 v_item_row catalog.shipment_item;
 v_match_count integer; v_match_text text; v_product uuid;
 v_created_tickets integer:=0; v_updated_tickets integer:=0; v_unchanged_tickets integer:=0;
 v_created_items integer:=0; v_updated_items integer:=0;
 v_revisions integer:=0; v_preserved integer:=0;
 v_absent_tickets integer:=0; v_absent_items integer:=0;
BEGIN
 v_actor:=p_actor;
 IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot)<>'object' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:snapshot' USING ERRCODE='22023'; END IF;
 v_source:=nullif(btrim(coalesce(p_snapshot->>'sourceKey','')),'');
 IF v_source IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:sourceKey' USING ERRCODE='22023'; END IF;
 v_collection:=p_snapshot->'collection';
 IF v_collection IS NULL OR jsonb_typeof(v_collection)<>'object' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:collection' USING ERRCODE='22023'; END IF;
 v_tickets:=p_snapshot->'tickets';
 IF v_tickets IS NULL OR jsonb_typeof(v_tickets)<>'array' OR jsonb_array_length(v_tickets)=0 THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:tickets' USING ERRCODE='22023'; END IF;
 -- 内容哈希（解析层对值网格+合并区+parserVersion 算的 sha256）：只用于判断“内容是否变化”。
 v_hash:=lower(btrim(coalesce(v_collection->>'rawContentHash','')));
 IF v_hash!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:contentHash' USING ERRCODE='22023'; END IF;
 v_doc_token:=nullif(btrim(coalesce(v_collection->>'docToken','')),'');
 v_sheet_id:=nullif(btrim(coalesce(v_collection->>'sheetId','')),'');
 IF coalesce(v_collection->>'revision','')~'^[0-9]+$' THEN
  v_revision:=(v_collection->>'revision')::bigint; END IF;
 IF coalesce(v_collection->>'documentEditedAt','')~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
  v_edited:=(v_collection->>'documentEditedAt')::timestamptz; END IF;
 IF coalesce(v_collection->>'readStartedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:readStartedAt' USING ERRCODE='22023'; END IF;
 IF coalesce(v_collection->>'readFinishedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:readFinishedAt' USING ERRCODE='22023'; END IF;
 v_started:=(v_collection->>'readStartedAt')::timestamptz;
 v_finished:=(v_collection->>'readFinishedAt')::timestamptz;
 IF coalesce(v_collection->>'readBy','') ~ v_uuid_re THEN
  v_read_by:=(v_collection->>'readBy')::uuid;
 ELSE
  v_read_by:=v_actor;
 END IF;

 -- 本次读到的票/明细数（由解析结果原样统计，不从库内旧行推）。
 SELECT count(*),coalesce(sum(jsonb_array_length(coalesce(t->'items','[]'::jsonb))),0)
 INTO v_ticket_count,v_item_count
 FROM jsonb_array_elements(v_tickets) AS t;
 IF v_ticket_count=0 OR v_item_count=0 THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:empty' USING ERRCODE='22023'; END IF;

 -- 关联保留计数：本次仍出现（按 matchedShipmentId 或 ticket_key 命中）、且此前已关联的明细。
 SELECT count(*) INTO v_preserved
 FROM jsonb_array_elements(v_tickets) AS t(ticket)
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(ticket->'items','[]'::jsonb)) AS it(item)
 JOIN catalog.shipment s ON s.source_key=v_source
   AND (s.id=(CASE WHEN coalesce(ticket->>'matchedShipmentId','') ~ v_uuid_re
          THEN (ticket->>'matchedShipmentId')::uuid END)
     OR s.ticket_key=(ticket->>'ticketKey'))
 JOIN catalog.shipment_item i ON i.shipment_id=s.id AND i.item_key=(item->>'itemKey')
 WHERE i.product_id IS NOT NULL;

 -- 新快照（读取证据）：成功的读取也落一行，用于“最近成功读取时间”。
 INSERT INTO catalog.shipment_source_snapshot(source_key,doc_token,sheet_id,revision,
  document_edited_at,read_started_at,read_finished_at,status,content_hash,ticket_count,item_count,
  raw,read_by)
 VALUES(v_source,v_doc_token,v_sheet_id,v_revision,v_edited,v_started,v_finished,'success',v_hash,
  v_ticket_count,v_item_count,
  jsonb_build_object(
   'values',coalesce(p_snapshot->'raw'->'values','[]'::jsonb),
   'merges',coalesce(p_snapshot->'raw'->'merges','[]'::jsonb),
   'collection',v_collection),
  v_read_by)
 RETURNING id INTO v_snapshot_id;

 -- 幂等：与“最近一次成功读取”内容哈希相同 → 不新建票/明细/修订。
 SELECT s.id,s.content_hash INTO v_prev_snapshot,v_prev_hash
 FROM catalog.shipment_source_snapshot s
 WHERE s.source_key=v_source AND s.status='success' AND s.id<>v_snapshot_id
 ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1;
 IF v_prev_hash IS NOT DISTINCT FROM v_hash THEN
  -- 内容没变 = 这批票/明细本次也仍在来源里：把“当前”推到本次快照（不写修订）。
  UPDATE catalog.shipment SET last_seen_snapshot_id=v_snapshot_id,last_seen_at=now()
  WHERE source_key=v_source AND last_seen_snapshot_id=v_prev_snapshot;
  UPDATE catalog.shipment_item SET last_seen_snapshot_id=v_snapshot_id,last_seen_at=now()
  WHERE source_key=v_source AND last_seen_snapshot_id=v_prev_snapshot;
  SELECT count(*) INTO v_absent_tickets FROM catalog.shipment s
  WHERE s.source_key=v_source AND s.last_seen_snapshot_id<>v_snapshot_id;
  SELECT count(*) INTO v_absent_items FROM catalog.shipment_item i
  WHERE i.source_key=v_source AND i.last_seen_snapshot_id<>v_snapshot_id;
  RETURN jsonb_build_object('ok',true,'unchanged',true,'snapshotId',v_snapshot_id,
   'readAt',v_finished,'ticketCount',v_ticket_count,'itemCount',v_item_count,
   'createdTickets',0,'updatedTickets',0,'unchangedTickets',v_ticket_count,
   'createdItems',0,'updatedItems',0,'revisionsAdded',0,
   'associationsPreserved',v_preserved,
   'absentTickets',v_absent_tickets,'absentItems',v_absent_items,
   'errorCode',NULL,'errorMessage',NULL);
 END IF;

 FOR v_ticket IN SELECT value FROM jsonb_array_elements(v_tickets) LOOP
  v_ticket_key:=nullif(btrim(coalesce(v_ticket->>'ticketKey','')),'');
  IF v_ticket_key IS NULL THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:ticketKey' USING ERRCODE='22023'; END IF;
  v_ticket_no:=nullif(btrim(coalesce(v_ticket->>'ticketNo','')),'');
  IF v_ticket_no IS NULL THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:ticketNo:%',v_ticket_key USING ERRCODE='22023'; END IF;
  v_status_class:=coalesce(v_ticket->>'statusClass','');
  IF v_status_class NOT IN('in_transit','partial','arrived_pending_shelving','arrived','unknown') THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:statusClass:%',v_ticket_key USING ERRCODE='22023'; END IF;
  v_received_basis:=coalesce(v_ticket->>'receivedBasis','');
  IF v_received_basis NOT IN('status_in_transit_zero','status_awaiting_shelving_zero',
    'status_arrived_full','source_quantity','pending') THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:receivedBasis:%',v_ticket_key USING ERRCODE='22023'; END IF;
  -- 身份匹配结论（服务端按 §1.3 算好传入；库内不做模糊匹配）。
  v_identity_status:=coalesce(nullif(btrim(v_ticket->>'identityStatus'),''),'confirmed');
  IF v_identity_status NOT IN('confirmed','pending') THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:identityStatus:%',v_ticket_key USING ERRCODE='22023'; END IF;
  v_identity_note:=nullif(left(btrim(coalesce(v_ticket->>'identityNote','')),500),'');
  v_matched_id:=CASE WHEN coalesce(v_ticket->>'matchedShipmentId','') ~ v_uuid_re
   THEN (v_ticket->>'matchedShipmentId')::uuid END;
  IF coalesce(v_ticket->>'sourceRowStart','')!~'^[0-9]+$'
   OR coalesce(v_ticket->>'sourceRowEnd','')!~'^[0-9]+$' THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:sourceRow:%',v_ticket_key USING ERRCODE='22023'; END IF;
  v_row_start:=(v_ticket->>'sourceRowStart')::integer;
  v_row_end:=(v_ticket->>'sourceRowEnd')::integer;
  IF v_row_start<=0 OR v_row_end<v_row_start THEN
   RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:sourceRow:%',v_ticket_key USING ERRCODE='22023'; END IF;
  v_market:=nullif(btrim(v_ticket->>'market'),'');
  v_customs:=nullif(btrim(v_ticket->>'customsMethod'),'');
  v_waybills:=nullif(btrim(v_ticket->>'waybillsText'),'');
  v_po:=nullif(btrim(v_ticket->>'purchaseOrder'),'');
  v_transport:=nullif(btrim(v_ticket->>'transportText'),'');
  v_arrival:=nullif(btrim(v_ticket->>'arrivalText'),'');
  v_vessel:=nullif(btrim(v_ticket->>'vessel'),'');
  v_dispatched:=nullif(btrim(v_ticket->>'dispatchedText'),'');

  -- 身份解析顺序：matchedShipmentId（服务端匹配结论）→ 兜底按 ticket_key（同一编号未变时）。
  v_shipment:=NULL;
  IF v_matched_id IS NOT NULL THEN
   SELECT * INTO v_shipment FROM catalog.shipment s
   WHERE s.id=v_matched_id FOR UPDATE;
   IF NOT FOUND OR v_shipment.source_key<>v_source THEN
    v_shipment:=NULL; -- 匹配目标不存在/不属于该来源 → 按新票处理
   END IF;
  END IF;
  IF v_shipment.id IS NULL THEN
   SELECT * INTO v_shipment FROM catalog.shipment s
   WHERE s.source_key=v_source AND s.ticket_key=v_ticket_key FOR UPDATE;
   IF NOT FOUND THEN v_shipment:=NULL; END IF;
  END IF;

  -- 编号变化时更新 ticket_key；若新 key 已被别的行占用，则保留旧 key（不报错、不合并）。
  v_effective_key:=v_ticket_key;
  IF v_shipment.id IS NOT NULL AND v_shipment.ticket_key<>v_ticket_key THEN
   IF EXISTS(SELECT 1 FROM catalog.shipment s
     WHERE s.source_key=v_source AND s.ticket_key=v_ticket_key AND s.id<>v_shipment.id) THEN
    v_effective_key:=v_shipment.ticket_key;
   END IF;
  END IF;

  -- 票级字段快照：与最近一条修订比较，只有真变了才 +1 并追加历史。
  v_fields:=jsonb_build_object(
   'ticket_no',v_ticket_no,'market',v_market,'customs_method',v_customs,
   'waybills_text',v_waybills,'purchase_order',v_po,
   'transport_text',v_transport,'arrival_text',v_arrival,
   'vessel',v_vessel,'dispatched_text',v_dispatched,
   'status_class',v_status_class,'received_basis',v_received_basis,
   'identity_status',v_identity_status,'identity_note',v_identity_note,
   'source_row_start',v_row_start,'source_row_end',v_row_end);

  IF v_shipment.id IS NOT NULL THEN
   v_shipment_id:=v_shipment.id;
   SELECT r.fields INTO v_prev_fields FROM catalog.shipment_revision r
   WHERE r.shipment_id=v_shipment_id AND r.revision=v_shipment.revision;
   -- 第一轮遗留键名（status_text/eta_text）归一化到新键，避免升级后产生假修订；
   -- 第一轮没有的身份字段按“已确认/无说明”补齐，同样避免假修订。
   IF v_prev_fields IS NOT NULL THEN
    v_prev_fields:=jsonb_build_object(
     'transport_text',coalesce(v_prev_fields->'transport_text',v_prev_fields->'status_text'),
     'arrival_text',coalesce(v_prev_fields->'arrival_text',v_prev_fields->'eta_text'),
     'identity_status',coalesce(v_prev_fields->'identity_status','"confirmed"'::jsonb),
     'identity_note',coalesce(v_prev_fields->'identity_note','null'::jsonb))
    || (v_prev_fields - 'transport_text' - 'arrival_text' - 'status_text' - 'eta_text'
        - 'identity_status' - 'identity_note');
   END IF;
   IF v_prev_fields IS DISTINCT FROM v_fields THEN
    v_new_revision:=v_shipment.revision+1;
    UPDATE catalog.shipment SET
     ticket_key=v_effective_key,ticket_no=v_ticket_no,market=v_market,customs_method=v_customs,
     waybills_text=v_waybills,purchase_order=v_po,
     transport_text=v_transport,arrival_text=v_arrival,
     vessel=v_vessel,dispatched_text=v_dispatched,
     status_class=v_status_class,received_basis=v_received_basis,
     identity_status=v_identity_status,identity_note=v_identity_note,
     source_row_start=v_row_start,source_row_end=v_row_end,
     last_seen_snapshot_id=v_snapshot_id,last_seen_at=now(),
     revision=v_new_revision,updated_at=now()
    WHERE id=v_shipment_id;
    INSERT INTO catalog.shipment_revision(shipment_id,revision,snapshot_id,fields,
     recorded_at,recorded_by)
    VALUES(v_shipment_id,v_new_revision,v_snapshot_id,v_fields,now(),v_actor);
    v_updated_tickets:=v_updated_tickets+1;
    v_revisions:=v_revisions+1;
   ELSE
    UPDATE catalog.shipment SET last_seen_snapshot_id=v_snapshot_id,last_seen_at=now()
    WHERE id=v_shipment_id;
    v_unchanged_tickets:=v_unchanged_tickets+1;
   END IF;
  ELSE
   INSERT INTO catalog.shipment(source_key,ticket_key,ticket_no,market,customs_method,
    waybills_text,purchase_order,transport_text,arrival_text,vessel,dispatched_text,
    status_class,received_basis,identity_status,identity_note,
    source_row_start,source_row_end,
    first_seen_snapshot_id,last_seen_snapshot_id,first_seen_at,last_seen_at,revision)
   VALUES(v_source,v_ticket_key,v_ticket_no,v_market,v_customs,v_waybills,v_po,
    v_transport,v_arrival,v_vessel,v_dispatched,v_status_class,v_received_basis,
    v_identity_status,v_identity_note,v_row_start,v_row_end,
    v_snapshot_id,v_snapshot_id,now(),now(),1)
   RETURNING id INTO v_shipment_id;
   INSERT INTO catalog.shipment_revision(shipment_id,revision,snapshot_id,fields,
    recorded_at,recorded_by)
   VALUES(v_shipment_id,1,v_snapshot_id,v_fields,now(),v_actor);
   v_created_tickets:=v_created_tickets+1;
   v_revisions:=v_revisions+1;
  END IF;

  -- 逐明细：按 (shipment_id,item_key) 更新同一条，不因再次读取重复生成；关联保留。
  v_sort:=0;
  FOR v_item IN SELECT value FROM jsonb_array_elements(coalesce(v_ticket->'items','[]'::jsonb))
  LOOP
   v_sort:=v_sort+1;
   v_item_key:=nullif(btrim(coalesce(v_item->>'itemKey','')),'');
   IF v_item_key IS NULL THEN
    RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:itemKey:%',v_ticket_key USING ERRCODE='22023'; END IF;
   v_name_raw:=nullif(btrim(coalesce(v_item->>'productNameRaw','')),'');
   v_name_norm:=nullif(btrim(coalesce(v_item->>'productNameNorm','')),'');
   IF v_name_raw IS NULL OR v_name_norm IS NULL THEN
    RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:productName:%/%',v_ticket_key,v_item_key
     USING ERRCODE='22023'; END IF;
   IF coalesce(v_item->>'shippedQuantity','')!~'^[0-9]+$' THEN
    RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:shippedQuantity:%/%',v_ticket_key,v_item_key
     USING ERRCODE='22023'; END IF;
   v_shipped:=(v_item->>'shippedQuantity')::integer;
   IF v_shipped<=0 THEN
    RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:shippedQuantity:%/%',v_ticket_key,v_item_key
     USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(v_item->'sourceReceivedQuantity')='number' THEN
    IF (v_item->>'sourceReceivedQuantity')!~'^[0-9]+$' THEN
     RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:receivedQuantity:%/%',v_ticket_key,v_item_key
      USING ERRCODE='22023'; END IF;
    -- 明细级来源到货数量优先于票级依据；同一值重复读取仍是同一值，不做加法。
    v_received:=(v_item->>'sourceReceivedQuantity')::integer;
    v_item_basis:='source_quantity';
   ELSE
    v_received:=CASE v_received_basis
     WHEN 'status_in_transit_zero' THEN 0
     WHEN 'status_awaiting_shelving_zero' THEN 0
     WHEN 'status_arrived_full' THEN v_shipped
     ELSE NULL END;
    v_item_basis:=v_received_basis;
   END IF;
   v_note:=nullif(btrim(v_item->>'sourceNote'),'');

   SELECT * INTO v_item_row FROM catalog.shipment_item i
   WHERE i.shipment_id=v_shipment_id AND i.item_key=v_item_key FOR UPDATE;
   IF FOUND THEN
    -- 关联不参与来源比较，也不因再次读取被覆盖。
    v_fields:=jsonb_build_object(
     'product_name_raw',v_name_raw,'product_name_norm',v_name_norm,
     'shipped_quantity',v_shipped,'received_quantity',v_received,
     'receipt_basis',v_item_basis,'source_note',v_note,
     'unit_text',v_item_row.unit_text,'source_sku',v_item_row.source_sku,
     'product_id',v_item_row.product_id,
     'association_status',v_item_row.association_status,
     'association_method',v_item_row.association_method);
    SELECT r.fields INTO v_prev_fields FROM catalog.shipment_item_revision r
    WHERE r.shipment_item_id=v_item_row.id AND r.revision=v_item_row.revision;
    IF v_prev_fields IS DISTINCT FROM v_fields THEN
     v_new_revision:=v_item_row.revision+1;
     UPDATE catalog.shipment_item SET
      product_name_raw=v_name_raw,product_name_norm=v_name_norm,
      shipped_quantity=v_shipped,received_quantity=v_received,
      receipt_basis=v_item_basis,source_note=v_note,sort_index=v_sort,
      last_seen_snapshot_id=v_snapshot_id,last_seen_at=now(),
      revision=v_new_revision,updated_at=now()
     WHERE id=v_item_row.id;
     INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,
      fields,recorded_at,recorded_by)
     VALUES(v_item_row.id,v_new_revision,v_snapshot_id,v_fields,now(),v_actor);
     v_updated_items:=v_updated_items+1;
     v_revisions:=v_revisions+1;
    ELSE
     UPDATE catalog.shipment_item SET sort_index=v_sort,
      last_seen_snapshot_id=v_snapshot_id,last_seen_at=now()
     WHERE id=v_item_row.id;
    END IF;
   ELSE
    -- 新明细：自动关联只在“从没关联过”时做（product_id/association_method 都为空），
    -- 规范化品名与商品库标准名完全一致且唯一命中 1 个商品才标记 auto，否则保持 none。
    v_product:=NULL;
    v_match_count:=0;
    v_match_text:=NULL;
    SELECT count(*),max(m.item_id::text) INTO v_match_count,v_match_text
    FROM (SELECT DISTINCT ic.item_id
      FROM catalog.item_current ic
      JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision
      WHERE lower(regexp_replace(normalize(coalesce(r.name_cn,''),NFKC),'\s+','','g'))=v_name_norm
     ) m;
    IF v_match_count=1 THEN v_product:=v_match_text::uuid; END IF;
    INSERT INTO catalog.shipment_item(shipment_id,source_key,item_key,product_name_raw,
     product_name_norm,shipped_quantity,received_quantity,receipt_basis,source_note,
     unit_text,source_sku,product_id,association_status,association_method,
     sort_index,revision,last_seen_snapshot_id,last_seen_at)
    VALUES(v_shipment_id,v_source,v_item_key,v_name_raw,v_name_norm,v_shipped,v_received,
     v_item_basis,v_note,NULL,NULL,v_product,
     CASE WHEN v_product IS NULL THEN 'none' ELSE 'auto' END,
     CASE WHEN v_product IS NULL THEN NULL ELSE 'normalized_name_exact' END,
     v_sort,1,v_snapshot_id,now())
    RETURNING * INTO v_item_row;
    INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,
     fields,recorded_at,recorded_by)
    VALUES(v_item_row.id,1,v_snapshot_id,jsonb_build_object(
     'product_name_raw',v_name_raw,'product_name_norm',v_name_norm,
     'shipped_quantity',v_shipped,'received_quantity',v_received,
     'receipt_basis',v_item_basis,'source_note',v_note,
     'unit_text',NULL,'source_sku',NULL,
     'product_id',v_product,
     'association_status',v_item_row.association_status,
     'association_method',v_item_row.association_method),now(),v_actor);
    IF v_product IS NOT NULL THEN
     INSERT INTO catalog.shipment_item_association_revision(item_id,revision,product_id,
      previous_product_id,method,actor_id,reason,recorded_at)
     VALUES(v_item_row.id,1,v_product,NULL,'auto',v_actor,NULL,now());
    END IF;
    v_created_items:=v_created_items+1;
    v_revisions:=v_revisions+1;
   END IF;
  END LOOP;
 END LOOP;

 -- 本次来源未见：票/明细的最后见到快照不是本次（保留旧行、旧数量、旧关联）。
 SELECT count(*) INTO v_absent_tickets FROM catalog.shipment s
 WHERE s.source_key=v_source AND s.last_seen_snapshot_id<>v_snapshot_id;
 SELECT count(*) INTO v_absent_items FROM catalog.shipment_item i
 WHERE i.source_key=v_source AND i.last_seen_snapshot_id<>v_snapshot_id;

 RETURN jsonb_build_object('ok',true,'unchanged',false,'snapshotId',v_snapshot_id,
  'readAt',v_finished,'ticketCount',v_ticket_count,'itemCount',v_item_count,
  'createdTickets',v_created_tickets,'updatedTickets',v_updated_tickets,
  'unchangedTickets',v_unchanged_tickets,
  'createdItems',v_created_items,'updatedItems',v_updated_items,
  'revisionsAdded',v_revisions,'associationsPreserved',v_preserved,
  'absentTickets',v_absent_tickets,'absentItems',v_absent_items,
  'errorCode',NULL,'errorMessage',NULL);
END $$;

-- 鉴权包装：页面/动作只经这里写（启用中的管理员作为读取人/操作者）。
CREATE OR REPLACE FUNCTION catalog.ingest_shipment_snapshot(p_snapshot jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 RETURN catalog.ingest_shipment_snapshot_core(p_snapshot,v_actor);
END $$;

-- ---------------------------------------------------------------------------
-- 10. 读取失败：只写一条 failed 快照，不写业务表、不更新“最近成功读取”。
-- ---------------------------------------------------------------------------
-- 内部核心：不做身份检查（p_actor 由鉴权包装传入；后台读失败传 NULL）。
CREATE OR REPLACE FUNCTION catalog.record_shipment_read_failure_core(p_error jsonb,p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_source text; v_code text; v_message text; v_at timestamptz;
 v_doc_token text; v_sheet_id text; v_snapshot_id uuid;
BEGIN
 v_actor:=p_actor;
 IF p_error IS NULL OR jsonb_typeof(p_error)<>'object' THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:error' USING ERRCODE='22023'; END IF;
 v_source:=nullif(btrim(coalesce(p_error->>'sourceKey','')),'');
 IF v_source IS NULL THEN v_source:='feishu_logistics_sheet'; END IF;
 v_code:=nullif(btrim(coalesce(p_error->>'errorCode','')),'');
 IF v_code IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:errorCode' USING ERRCODE='22023'; END IF;
 v_message:=left(coalesce(nullif(btrim(coalesce(p_error->>'errorMessage','')),''),v_code),1000);
 v_doc_token:=nullif(btrim(coalesce(p_error->>'docToken','')),'');
 v_sheet_id:=nullif(btrim(coalesce(p_error->>'sheetId','')),'');
 IF coalesce(p_error->>'readAt','')~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
  v_at:=(p_error->>'readAt')::timestamptz; ELSE v_at:=now(); END IF;
 INSERT INTO catalog.shipment_source_snapshot(source_key,doc_token,sheet_id,
  read_started_at,read_finished_at,status,error_code,error_message,read_by)
 VALUES(v_source,v_doc_token,v_sheet_id,v_at,v_at,'failed',v_code,v_message,v_actor)
 RETURNING id INTO v_snapshot_id;
 RETURN jsonb_build_object('ok',true,'snapshotId',v_snapshot_id,'readAt',v_at,
  'status','failed','errorCode',v_code);
END $$;

-- 鉴权包装：页面/动作只经这里登记失败（启用中的管理员作为读取人）。
CREATE OR REPLACE FUNCTION catalog.record_shipment_read_failure(p_error jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 RETURN catalog.record_shipment_read_failure_core(p_error,v_actor);
END $$;

-- ---------------------------------------------------------------------------
-- 11. 商品关联编辑：版本校验 + 追加关联历史与明细修订；业务拒绝返回结构化 errorCode
-- ---------------------------------------------------------------------------
-- 内部核心：不做身份检查（p_actor 由鉴权包装传入）。
CREATE OR REPLACE FUNCTION catalog.update_shipment_item_association_core(p_item_id uuid,
 p_product_id uuid,p_expected_revision integer,p_reason text,p_actor uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_item catalog.shipment_item; v_reason text;
 v_revision integer; v_status text; v_method text; v_fields jsonb;
BEGIN
 v_actor:=p_actor;
 IF p_item_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<=0 THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:item' USING ERRCODE='22023'; END IF;
 v_reason:=nullif(btrim(coalesce(p_reason,'')),'');
 IF length(coalesce(v_reason,''))>500 THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:reason' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_item FROM catalog.shipment_item i WHERE i.id=p_item_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'itemId',p_item_id,'productId',p_product_id,
   'associationStatus','none','revision',0,
   'errorCode','SHIPMENT_ITEM_NOT_FOUND','errorMessage','货票明细不存在'); END IF;
 IF v_item.revision<>p_expected_revision THEN
  RETURN jsonb_build_object('ok',false,'itemId',v_item.id,'productId',v_item.product_id,
   'associationStatus',v_item.association_status,'revision',v_item.revision,
   'errorCode','SHIPMENT_REVISION_CONFLICT','errorMessage','明细已被更新，请刷新后重试'); END IF;
 IF p_product_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM catalog.catalog_item c WHERE c.id=p_product_id) THEN
  RETURN jsonb_build_object('ok',false,'itemId',v_item.id,'productId',v_item.product_id,
   'associationStatus',v_item.association_status,'revision',v_item.revision,
   'errorCode','SHIPMENT_PRODUCT_NOT_FOUND','errorMessage','商品库中不存在该商品'); END IF;
 -- 目标未变化：幂等返回，不追加历史。
 IF v_item.product_id IS NOT DISTINCT FROM p_product_id THEN
  RETURN jsonb_build_object('ok',true,'itemId',v_item.id,'productId',v_item.product_id,
   'associationStatus',v_item.association_status,'revision',v_item.revision,
   'errorCode',NULL,'errorMessage',NULL); END IF;
 v_revision:=v_item.revision+1;
 v_status:=CASE WHEN p_product_id IS NULL THEN 'none' ELSE 'manual' END;
 v_method:=CASE WHEN p_product_id IS NULL THEN 'manual_cleared' ELSE 'manual_selected' END;
 UPDATE catalog.shipment_item SET product_id=p_product_id,association_status=v_status,
  association_method=v_method,associated_by=v_actor,associated_at=now(),
  revision=v_revision,updated_at=now()
 WHERE id=v_item.id;
 v_fields:=jsonb_build_object(
  'product_name_raw',v_item.product_name_raw,'product_name_norm',v_item.product_name_norm,
  'shipped_quantity',v_item.shipped_quantity,'received_quantity',v_item.received_quantity,
  'receipt_basis',v_item.receipt_basis,'source_note',v_item.source_note,
  'unit_text',v_item.unit_text,'source_sku',v_item.source_sku,
  'product_id',p_product_id,'association_status',v_status,'association_method',v_method);
 INSERT INTO catalog.shipment_item_association_revision(item_id,revision,product_id,
  previous_product_id,method,actor_id,reason,recorded_at)
 VALUES(v_item.id,v_revision,p_product_id,v_item.product_id,v_method,v_actor,v_reason,now());
 INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,fields,
  recorded_at,recorded_by)
 VALUES(v_item.id,v_revision,v_item.last_seen_snapshot_id,v_fields,now(),v_actor);
 RETURN jsonb_build_object('ok',true,'itemId',v_item.id,'productId',p_product_id,
  'associationStatus',v_status,'revision',v_revision,
  'previousProductId',v_item.product_id,'errorCode',NULL,'errorMessage',NULL);
END $$;

-- 鉴权包装：页面/动作只经这里改绑（启用中的管理员作为操作者）。
CREATE OR REPLACE FUNCTION catalog.update_shipment_item_association(p_item_id uuid,
 p_product_id uuid,p_expected_revision integer,p_reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid;
BEGIN
 v_actor:=catalog.require_admin();
 RETURN catalog.update_shipment_item_association_core(p_item_id,p_product_id,
  p_expected_revision,p_reason,v_actor);
END $$;

-- ---------------------------------------------------------------------------
-- 12. 权限：只给普通 app 角色（读写都走启用中管理员 JWT），sync/auth runner 不给
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_shipment_source_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_list(text,text,text,uuid,boolean,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_detail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_product_shipment_links(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_identity_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.search_products_for_shipment(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.ingest_shipment_snapshot(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.record_shipment_read_failure(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.update_shipment_item_association(uuid,uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_latest_success_snapshot(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_current_source_key() FROM PUBLIC;
-- 内部核心函数只给同库 SECURITY DEFINER 包装调用（含 027 的后台包装），不向任何运行角色授权。
REVOKE ALL ON FUNCTION catalog.read_shipment_identity_index_core() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.ingest_shipment_snapshot_core(jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.record_shipment_read_failure_core(jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.update_shipment_item_association_core(uuid,uuid,integer,text,uuid)
 FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_display_value(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_field_change_labels(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 catalog.read_shipment_source_status(),
 catalog.read_shipment_list(text,text,text,uuid,boolean,integer,integer),
 catalog.read_shipment_detail(uuid),
 catalog.read_product_shipment_links(uuid,integer),
 catalog.read_shipment_identity_index(),
 catalog.search_products_for_shipment(text,integer),
 catalog.ingest_shipment_snapshot(jsonb),
 catalog.record_shipment_read_failure(jsonb),
 catalog.update_shipment_item_association(uuid,uuid,integer,text)
 TO ice_p0_02_app_runner;

RESET ROLE;
