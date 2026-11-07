-- ICE catalog 029: 第八轮「修正在途（人工）+ 逐商品到货口径」数据库增量。
--
-- 设计合同：.local/shipment-v1-r8-20261104/design.md §2（§2.1 列、§2.2 历史表、§2.3 有效状态、
-- §2.4 写入 RPC、§2.5 只读 RPC、§2.6 替换 ingest core）。
--
-- 只做本文件范围，不改 026/027/028 原文件、不改 00001–025、不改 inventory_schema_state.version：
--   1. catalog.shipment_item 增加「原表判断」与「人工修正」列（幂等回填）；
--   2. 人工修正追加历史表 catalog.shipment_item_manual_revision（FORCE RLS + 不可变）；
--   3. 有效货票状态函数 catalog.shipment_effective_status_class(uuid)；
--   4. 写入 RPC：apply_shipment_item_manual_correction / restore_shipment_item_source_judgement；
--   5. 只读 RPC：read_shipment_manual_index / read_shipment_manual_history；
--   6. CREATE OR REPLACE catalog.ingest_shipment_snapshot_core（签名/返回键不变）：
--      逐明细 source_* 写入、人工结果保留、原表 H/到货数量变化时置 manual_review_needed。
--
-- 口径（不得违反）：
--   * received_quantity 是「当前生效的累计到货」，026 读取/汇总/详情都用它算剩余；人工修正只改这一列
--     与 receipt_basis='manual_correction'，**不改** source_*、不改 item.revision、不改票 status_class；
--   * 原表判断另存 source_received_quantity / source_receipt_basis，「恢复按原表判断」用它；
--   * 未知一律 NULL（不写 0），累计已上架 0..发货量；
--   * 人工修正历史只追加、不可改删。
--
-- 安装约定：幂等（ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE /
-- DO 块查 pg_constraint·pg_policies·pg_trigger），必须晚于 026→027→028 重放；末尾 RESET ROLE。
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. shipment_item：原表判断 + 人工修正列（幂等）
-- ---------------------------------------------------------------------------
ALTER TABLE catalog.shipment_item
 ADD COLUMN IF NOT EXISTS source_received_quantity integer,
 ADD COLUMN IF NOT EXISTS source_receipt_basis text,
 ADD COLUMN IF NOT EXISTS manual_status text,
 ADD COLUMN IF NOT EXISTS manual_shelved_quantity integer,
 ADD COLUMN IF NOT EXISTS manual_actor_id uuid REFERENCES public.profiles ON DELETE RESTRICT,
 ADD COLUMN IF NOT EXISTS manual_actor_name text,
 ADD COLUMN IF NOT EXISTS manual_at timestamptz,
 ADD COLUMN IF NOT EXISTS manual_revision integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS manual_arrival_snapshot text,
 ADD COLUMN IF NOT EXISTS manual_review_needed boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS manual_review_note text;

-- 首次迁移回填：现有 received_quantity/receipt_basis 就是当时的“原表判断”。
UPDATE catalog.shipment_item
 SET source_received_quantity=received_quantity, source_receipt_basis=receipt_basis
 WHERE source_receipt_basis IS NULL;

DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='catalog' AND table_name='shipment_item'
    AND column_name='source_receipt_basis' AND is_nullable='YES'
 ) THEN
  ALTER TABLE catalog.shipment_item ALTER COLUMN source_receipt_basis SET NOT NULL;
 END IF;
END $$;

-- receipt_basis 增加 manual_correction（026 的约束名固定为 shipment_item_receipt_basis_check）。
ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_receipt_basis_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_receipt_basis_check
 CHECK(receipt_basis IN('status_in_transit_zero','status_awaiting_shelving_zero',
  'status_arrived_full','source_quantity','pending','manual_correction'));

ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_source_receipt_basis_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_source_receipt_basis_check
 CHECK(source_receipt_basis IN('status_in_transit_zero','status_awaiting_shelving_zero',
  'status_arrived_full','source_quantity','pending'));
ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_source_received_quantity_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_source_received_quantity_check
 CHECK(source_received_quantity IS NULL OR source_received_quantity>=0);

ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_manual_status_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_manual_status_check
 CHECK(manual_status IS NULL OR manual_status IN('in_transit','arrived_pending_shelving',
  'fully_shelved','partial_shelved','unknown'));

-- 无人工修正：人工字段全部为空/false（manual_revision 保留历史版本号，恢复后不清零）。
ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_manual_empty_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_manual_empty_check
 CHECK(manual_status IS NOT NULL OR (
  manual_shelved_quantity IS NULL AND manual_actor_id IS NULL AND manual_actor_name IS NULL
  AND manual_at IS NULL AND manual_arrival_snapshot IS NULL
  AND manual_review_needed=false AND manual_review_note IS NULL AND manual_revision>=0));

-- 有人工修正：修改人/时间必填。
ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_manual_actor_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_manual_actor_check
 CHECK(manual_status IS NULL OR (
  manual_actor_id IS NOT NULL AND manual_actor_name IS NOT NULL AND manual_at IS NOT NULL));

ALTER TABLE catalog.shipment_item DROP CONSTRAINT IF EXISTS shipment_item_manual_shelved_check;
ALTER TABLE catalog.shipment_item ADD CONSTRAINT shipment_item_manual_shelved_check
 CHECK(((manual_status='partial_shelved')=(manual_shelved_quantity IS NOT NULL))
  AND (manual_shelved_quantity IS NULL
   OR (manual_shelved_quantity>=0 AND manual_shelved_quantity<=shipped_quantity)));

CREATE INDEX IF NOT EXISTS shipment_item_manual_status
 ON catalog.shipment_item(source_key, manual_status) WHERE manual_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS shipment_item_manual_review
 ON catalog.shipment_item(source_key) WHERE manual_review_needed;

-- ---------------------------------------------------------------------------
-- 2. 人工修正追加历史（不可变，照抄 026 的 FORCE RLS + 不可变触发器写法）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog.shipment_item_manual_revision (
 item_id uuid NOT NULL REFERENCES catalog.shipment_item ON DELETE RESTRICT,
 revision integer NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN('apply','restore')),
 manual_status text,
 manual_shelved_quantity integer,
 previous_manual_status text,
 previous_manual_shelved_quantity integer,
 -- 本次生效的累计到货 / 剩余在途（未知为 NULL，不写 0）。
 received_quantity integer,
 remaining_quantity integer,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 actor_name text NOT NULL CHECK(length(btrim(actor_name))>0),
 note text,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(item_id,revision)
);
CREATE INDEX IF NOT EXISTS shipment_item_manual_revision_recorded
 ON catalog.shipment_item_manual_revision(item_id,recorded_at DESC);

DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgname='immutable_history'
    AND tgrelid='catalog.shipment_item_manual_revision'::regclass
 ) THEN
  CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE
   ON catalog.shipment_item_manual_revision
   FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation();
 END IF;
END $$;

ALTER TABLE catalog.shipment_item_manual_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.shipment_item_manual_revision FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname='catalog' AND tablename='shipment_item_manual_revision'
    AND policyname='enabled_admin'
 ) THEN
  CREATE POLICY enabled_admin ON catalog.shipment_item_manual_revision FOR ALL
   USING (current_user <> 'ice_p0_02_owner' AND catalog.is_admin())
   WITH CHECK (current_user <> 'ice_p0_02_owner' AND catalog.is_admin());
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname='catalog' AND tablename='shipment_item_manual_revision'
    AND policyname='shipment_definer_owner'
 ) THEN
  CREATE POLICY shipment_definer_owner ON catalog.shipment_item_manual_revision FOR ALL
   USING (current_user='ice_p0_02_owner')
   WITH CHECK (current_user='ice_p0_02_owner');
 END IF;
END $$;

REVOKE ALL ON TABLE catalog.shipment_item_manual_revision
 FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;

-- ---------------------------------------------------------------------------
-- 3. 有效货票状态：只看该票当前明细的生效累计到货（人工修正后自动跟随）
--    - 没有当前明细 → 原 status_class
--    - 全部已知：全部收到=arrived；全部未收到=原 arrived_pending_shelving 保持，否则 in_transit；
--      其它=partial
--    - 有未知：有任何一条已知=partial；全部未知=原 status_class
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.shipment_effective_status_class(p_shipment_id uuid)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_shipment catalog.shipment; v_total integer; v_known integer;
 v_all_full boolean; v_all_zero boolean;
BEGIN
 SELECT * INTO v_shipment FROM catalog.shipment s WHERE s.id=p_shipment_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT count(*),
  count(*) FILTER (WHERE i.received_quantity IS NOT NULL AND i.received_quantity<=i.shipped_quantity),
  coalesce(bool_and(i.received_quantity>=i.shipped_quantity)
   FILTER (WHERE i.received_quantity IS NOT NULL AND i.received_quantity<=i.shipped_quantity),false),
  coalesce(bool_and(i.received_quantity=0)
   FILTER (WHERE i.received_quantity IS NOT NULL AND i.received_quantity<=i.shipped_quantity),false)
 INTO v_total,v_known,v_all_full,v_all_zero
 FROM catalog.shipment_item i
 WHERE i.shipment_id=p_shipment_id
   AND i.last_seen_snapshot_id=v_shipment.last_seen_snapshot_id;
 IF v_total=0 OR v_known=0 THEN RETURN v_shipment.status_class; END IF;
 IF v_known<v_total THEN RETURN 'partial'; END IF;
 IF v_all_full THEN RETURN 'arrived'; END IF;
 IF v_all_zero THEN
  RETURN CASE WHEN v_shipment.status_class='arrived_pending_shelving'
   THEN v_shipment.status_class ELSE 'in_transit' END;
 END IF;
 RETURN 'partial';
END $$;

-- ---------------------------------------------------------------------------
-- 4. 写入 RPC：人工「修正在途」
--    校验：明细存在且属当前最近成功快照；status 5 值；partial_shelved 需 0..发货量累计；
--    版本冲突返回 ok:false（不抛错）。不改 source_*/item.revision/票 status_class。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.apply_shipment_item_manual_correction(p_item_id uuid,
 p_status text,p_cumulative_shelved integer,p_expected_manual_revision integer,p_actor_name text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_item catalog.shipment_item; v_shipment catalog.shipment;
 v_latest uuid; v_actor_name text; v_status text; v_cumulative integer;
 v_received integer; v_remaining integer; v_revision integer;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_item_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:itemId' USING ERRCODE='22023'; END IF;
 v_actor_name:=nullif(left(btrim(coalesce(p_actor_name,'')),200),'');
 IF v_actor_name IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:actorName' USING ERRCODE='22023'; END IF;
 v_status:=nullif(btrim(coalesce(p_status,'')),'');
 IF v_status IS NULL OR v_status NOT IN('in_transit','arrived_pending_shelving',
   'fully_shelved','partial_shelved','unknown') THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:status' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_item FROM catalog.shipment_item i WHERE i.id=p_item_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'itemId',p_item_id,'manualStatus',NULL,
   'manualShelvedQuantity',NULL,'receivedQuantity',NULL,'remainingQuantity',NULL,
   'receiptBasis','pending','manualRevision',0,'manualActorName',NULL,'manualAt',NULL,
   'reviewNeeded',false,'errorCode','SHIPMENT_ITEM_NOT_FOUND','errorMessage','货票明细不存在');
 END IF;
 SELECT * INTO v_shipment FROM catalog.shipment s WHERE s.id=v_item.shipment_id;
 v_latest:=catalog.shipment_latest_success_snapshot(v_item.source_key);
 IF v_latest IS NULL
  OR v_item.last_seen_snapshot_id IS DISTINCT FROM v_latest
  OR v_shipment.last_seen_snapshot_id IS DISTINCT FROM v_latest THEN
  RETURN jsonb_build_object('ok',false,'itemId',v_item.id,'manualStatus',v_item.manual_status,
   'manualShelvedQuantity',v_item.manual_shelved_quantity,
   'receivedQuantity',v_item.received_quantity,
   'remainingQuantity',CASE WHEN v_item.received_quantity IS NULL
     OR v_item.received_quantity>v_item.shipped_quantity THEN NULL
    ELSE v_item.shipped_quantity-v_item.received_quantity END,
   'receiptBasis',v_item.receipt_basis,'manualRevision',v_item.manual_revision,
   'manualActorName',v_item.manual_actor_name,'manualAt',v_item.manual_at,
   'reviewNeeded',v_item.manual_review_needed,
   'errorCode','SHIPMENT_ITEM_NOT_CURRENT',
   'errorMessage','该明细已不在当前来源结果里，不能修改');
 END IF;
 IF v_item.manual_revision IS DISTINCT FROM greatest(coalesce(p_expected_manual_revision,-1),0) THEN
  RETURN jsonb_build_object('ok',false,'itemId',v_item.id,'manualStatus',v_item.manual_status,
   'manualShelvedQuantity',v_item.manual_shelved_quantity,
   'receivedQuantity',v_item.received_quantity,
   'remainingQuantity',CASE WHEN v_item.received_quantity IS NULL
     OR v_item.received_quantity>v_item.shipped_quantity THEN NULL
    ELSE v_item.shipped_quantity-v_item.received_quantity END,
   'receiptBasis',v_item.receipt_basis,'manualRevision',v_item.manual_revision,
   'manualActorName',v_item.manual_actor_name,'manualAt',v_item.manual_at,
   'reviewNeeded',v_item.manual_review_needed,
   'errorCode','SHIPMENT_MANUAL_CONFLICT',
   'errorMessage','该明细的人工修正已被更新，请刷新后重试');
 END IF;
 v_cumulative:=CASE WHEN v_status='partial_shelved' THEN p_cumulative_shelved ELSE NULL END;
 IF v_status='partial_shelved' THEN
  IF v_cumulative IS NULL OR v_cumulative<0 OR v_cumulative>v_item.shipped_quantity THEN
   RETURN jsonb_build_object('ok',false,'itemId',v_item.id,'manualStatus',v_item.manual_status,
    'manualShelvedQuantity',v_item.manual_shelved_quantity,
    'receivedQuantity',v_item.received_quantity,
    'remainingQuantity',CASE WHEN v_item.received_quantity IS NULL
      OR v_item.received_quantity>v_item.shipped_quantity THEN NULL
     ELSE v_item.shipped_quantity-v_item.received_quantity END,
    'receiptBasis',v_item.receipt_basis,'manualRevision',v_item.manual_revision,
    'manualActorName',v_item.manual_actor_name,'manualAt',v_item.manual_at,
    'reviewNeeded',v_item.manual_review_needed,
    'errorCode','SHIPMENT_MANUAL_INVALID_QUANTITY',
    'errorMessage','累计已上架必须是 0 到发货量之间的整数');
  END IF;
 ELSIF p_cumulative_shelved IS NOT NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:cumulativeShelved' USING ERRCODE='22023'; END IF;
 v_received:=CASE v_status
  WHEN 'in_transit' THEN 0
  WHEN 'arrived_pending_shelving' THEN 0
  WHEN 'fully_shelved' THEN v_item.shipped_quantity
  WHEN 'partial_shelved' THEN v_cumulative
  ELSE NULL END;
 v_remaining:=CASE WHEN v_received IS NULL THEN NULL
  ELSE v_item.shipped_quantity-v_received END;
 v_revision:=v_item.manual_revision+1;
 UPDATE catalog.shipment_item SET
  received_quantity=v_received,
  receipt_basis='manual_correction',
  manual_status=v_status,
  manual_shelved_quantity=v_cumulative,
  manual_actor_id=v_actor,
  manual_actor_name=v_actor_name,
  manual_at=now(),
  manual_revision=v_revision,
  manual_arrival_snapshot=v_shipment.arrival_text,
  manual_review_needed=false,
  manual_review_note=NULL,
  updated_at=now()
 WHERE id=v_item.id;
 INSERT INTO catalog.shipment_item_manual_revision(item_id,revision,action,manual_status,
  manual_shelved_quantity,previous_manual_status,previous_manual_shelved_quantity,
  received_quantity,remaining_quantity,actor_id,actor_name,note)
 VALUES(v_item.id,v_revision,'apply',v_status,v_cumulative,
  v_item.manual_status,v_item.manual_shelved_quantity,
  v_received,v_remaining,v_actor,v_actor_name,NULL);
 RETURN jsonb_build_object('ok',true,'itemId',v_item.id,'manualStatus',v_status,
  'manualShelvedQuantity',v_cumulative,'receivedQuantity',v_received,
  'remainingQuantity',v_remaining,'receiptBasis','manual_correction',
  'manualRevision',v_revision,'manualActorName',v_actor_name,'manualAt',now(),
  'reviewNeeded',false,'errorCode',NULL,'errorMessage',NULL);
END $$;

-- 恢复按原表判断：received/receipt_basis 回到 source_*，人工字段全部清空（历史保留）。
CREATE OR REPLACE FUNCTION catalog.restore_shipment_item_source_judgement(p_item_id uuid,
 p_expected_manual_revision integer,p_actor_name text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_item catalog.shipment_item; v_actor_name text;
 v_received integer; v_remaining integer; v_revision integer;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_item_id IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:itemId' USING ERRCODE='22023'; END IF;
 v_actor_name:=nullif(left(btrim(coalesce(p_actor_name,'')),200),'');
 IF v_actor_name IS NULL THEN
  RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:actorName' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_item FROM catalog.shipment_item i WHERE i.id=p_item_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('ok',false,'itemId',p_item_id,'manualStatus',NULL,
   'manualShelvedQuantity',NULL,'receivedQuantity',NULL,'remainingQuantity',NULL,
   'receiptBasis','pending','manualRevision',0,'manualActorName',NULL,'manualAt',NULL,
   'reviewNeeded',false,'errorCode','SHIPMENT_ITEM_NOT_FOUND','errorMessage','货票明细不存在');
 END IF;
 IF v_item.manual_status IS NULL THEN
  RETURN jsonb_build_object('ok',false,'itemId',v_item.id,'manualStatus',NULL,
   'manualShelvedQuantity',NULL,'receivedQuantity',v_item.received_quantity,
   'remainingQuantity',CASE WHEN v_item.received_quantity IS NULL
     OR v_item.received_quantity>v_item.shipped_quantity THEN NULL
    ELSE v_item.shipped_quantity-v_item.received_quantity END,
   'receiptBasis',v_item.receipt_basis,'manualRevision',v_item.manual_revision,
   'manualActorName',v_item.manual_actor_name,'manualAt',v_item.manual_at,
   'reviewNeeded',v_item.manual_review_needed,
   'errorCode','SHIPMENT_MANUAL_NOT_APPLIED','errorMessage','该明细没有人工修正可恢复');
 END IF;
 IF v_item.manual_revision IS DISTINCT FROM greatest(coalesce(p_expected_manual_revision,-1),0) THEN
  RETURN jsonb_build_object('ok',false,'itemId',v_item.id,'manualStatus',v_item.manual_status,
   'manualShelvedQuantity',v_item.manual_shelved_quantity,
   'receivedQuantity',v_item.received_quantity,
   'remainingQuantity',CASE WHEN v_item.received_quantity IS NULL
     OR v_item.received_quantity>v_item.shipped_quantity THEN NULL
    ELSE v_item.shipped_quantity-v_item.received_quantity END,
   'receiptBasis',v_item.receipt_basis,'manualRevision',v_item.manual_revision,
   'manualActorName',v_item.manual_actor_name,'manualAt',v_item.manual_at,
   'reviewNeeded',v_item.manual_review_needed,
   'errorCode','SHIPMENT_MANUAL_CONFLICT',
   'errorMessage','该明细的人工修正已被更新，请刷新后重试');
 END IF;
 v_received:=v_item.source_received_quantity;
 v_remaining:=CASE WHEN v_received IS NULL THEN NULL
  ELSE v_item.shipped_quantity-v_received END;
 v_revision:=v_item.manual_revision+1;
 UPDATE catalog.shipment_item SET
  received_quantity=v_received,
  receipt_basis=v_item.source_receipt_basis,
  manual_status=NULL,
  manual_shelved_quantity=NULL,
  manual_actor_id=NULL,
  manual_actor_name=NULL,
  manual_at=NULL,
  manual_revision=v_revision,
  manual_arrival_snapshot=NULL,
  manual_review_needed=false,
  manual_review_note=NULL,
  updated_at=now()
 WHERE id=v_item.id;
 INSERT INTO catalog.shipment_item_manual_revision(item_id,revision,action,manual_status,
  manual_shelved_quantity,previous_manual_status,previous_manual_shelved_quantity,
  received_quantity,remaining_quantity,actor_id,actor_name,note)
 VALUES(v_item.id,v_revision,'restore',NULL,NULL,
  v_item.manual_status,v_item.manual_shelved_quantity,
  v_received,v_remaining,v_actor,v_actor_name,NULL);
 RETURN jsonb_build_object('ok',true,'itemId',v_item.id,'manualStatus',NULL,
  'manualShelvedQuantity',NULL,'receivedQuantity',v_received,
  'remainingQuantity',v_remaining,'receiptBasis',v_item.source_receipt_basis,
  'manualRevision',v_revision,'manualActorName',NULL,'manualAt',NULL,
  'reviewNeeded',false,'errorCode',NULL,'errorMessage',NULL);
END $$;

-- ---------------------------------------------------------------------------
-- 5. 只读 RPC：人工修正索引 + 单票人工修正历史
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_manual_index() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_admin();
 RETURN jsonb_build_object(
  'shipments',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'shipmentId',s.id,
     'effectiveStatusClass',catalog.shipment_effective_status_class(s.id),
     'manualCorrectionCount',(SELECT count(*) FROM catalog.shipment_item i
       WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
         AND i.manual_status IS NOT NULL),
     'manualReviewCount',(SELECT count(*) FROM catalog.shipment_item i
       WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
         AND i.manual_review_needed))
    ORDER BY s.id),'[]'::jsonb)
   FROM catalog.shipment s),
  'items',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'itemId',i.id,'shipmentId',i.shipment_id,
     'manualStatus',i.manual_status,
     'manualShelvedQuantity',i.manual_shelved_quantity,
     'manualActorName',i.manual_actor_name,
     'manualAt',i.manual_at,
     'manualRevision',i.manual_revision,
     'manualReviewNeeded',i.manual_review_needed,
     'manualReviewNote',i.manual_review_note,
     'sourceReceivedQuantity',i.source_received_quantity,
     'sourceReceiptBasis',i.source_receipt_basis,
     'effectiveReceivedQuantity',i.received_quantity,
     'effectiveRemainingQuantity',CASE WHEN i.received_quantity IS NULL
       OR i.received_quantity>i.shipped_quantity THEN NULL
      ELSE i.shipped_quantity-i.received_quantity END)
    ORDER BY i.shipment_id,i.sort_index,i.id),'[]'::jsonb)
   FROM catalog.shipment_item i
   -- 生效人工修正 / 需要复核 / 曾经人工修正过（恢复后 manual_revision>0，页面仍需拿到版本号做乐观并发）。
   WHERE i.manual_status IS NOT NULL OR i.manual_review_needed OR i.manual_revision>0));
END $$;

CREATE OR REPLACE FUNCTION catalog.read_shipment_manual_history(p_shipment_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_admin();
 IF p_shipment_id IS NULL THEN RETURN '[]'::jsonb; END IF;
 RETURN (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
   'itemId',x.item_id,'productNameRaw',x.product_name_raw,'revision',x.revision,
   'action',x.action,'manualStatus',x.manual_status,
   'manualShelvedQuantity',x.manual_shelved_quantity,
   'previousManualStatus',x.previous_manual_status,
   'previousManualShelvedQuantity',x.previous_manual_shelved_quantity,
   'receivedQuantity',x.received_quantity,'remainingQuantity',x.remaining_quantity,
   'actorName',x.actor_name,'note',x.note,'recordedAt',x.recorded_at)
   ORDER BY x.recorded_at DESC,x.revision DESC),'[]'::jsonb)
  FROM (
   SELECT r.item_id,i.product_name_raw,r.revision,r.action,r.manual_status,
    r.manual_shelved_quantity,r.previous_manual_status,r.previous_manual_shelved_quantity,
    r.received_quantity,r.remaining_quantity,r.actor_name,r.note,r.recorded_at
   FROM catalog.shipment_item_manual_revision r
   JOIN catalog.shipment_item i ON i.id=r.item_id
   WHERE i.shipment_id=p_shipment_id
   ORDER BY r.recorded_at DESC,r.revision DESC
   LIMIT 30) x);
END $$;

-- ---------------------------------------------------------------------------
-- 6. 变更记录展示：补 source_*/manual_* 字段标签（026 的两个辅助函数只加分支）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.shipment_display_value(p_key text,p_value jsonb) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE
  WHEN p_value IS NULL OR p_value='null'::jsonb THEN NULL
  WHEN p_key='status_class' THEN CASE p_value#>>'{}'
    WHEN 'in_transit' THEN '运输在途' WHEN 'partial' THEN '部分到货待核'
    WHEN 'arrived_pending_shelving' THEN '已到货待上架'
    WHEN 'arrived' THEN '已到货上架' WHEN 'unknown' THEN '状态未提供待核' END
  WHEN p_key='manual_status' THEN CASE p_value#>>'{}'
    WHEN 'in_transit' THEN '人工：运输中'
    WHEN 'arrived_pending_shelving' THEN '人工：已到货待上架'
    WHEN 'fully_shelved' THEN '人工：全部已上架'
    WHEN 'partial_shelved' THEN '人工：分批上架'
    WHEN 'unknown' THEN '人工：状态未知' END
  WHEN p_key IN('receipt_basis','source_receipt_basis') THEN CASE p_value#>>'{}'
    WHEN 'status_in_transit_zero' THEN '运输在途未到货'
    WHEN 'status_awaiting_shelving_zero' THEN '已到货待上架（未结束在途）'
    WHEN 'status_arrived_full' THEN '整票已到货上架'
    WHEN 'source_quantity' THEN '来源到货数量'
    WHEN 'manual_correction' THEN '人工修正（不按原表）'
    WHEN 'pending' THEN '待核' END
  WHEN p_key='identity_status' THEN CASE p_value#>>'{}'
    WHEN 'confirmed' THEN '身份已确认' WHEN 'pending' THEN '身份待核' END
  WHEN p_key='association_status' THEN CASE p_value#>>'{}'
    WHEN 'auto' THEN '自动关联' WHEN 'manual' THEN '人工关联' WHEN 'none' THEN '未关联' END
  WHEN p_key='manual_review_needed' THEN CASE WHEN p_value='true'::jsonb THEN '需要复核' ELSE '无需复核' END
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
   ('source_received_quantity','原表累计到货',18),('receipt_basis','到货依据',19),
   ('source_receipt_basis','原表到货依据',20),('source_note','来源备注',21),
   ('product_id','关联商品',22),('association_status','关联状态',23),
   ('manual_status','人工修正状态',24),('manual_shelved_quantity','人工累计已上架',25),
   ('manual_actor_name','人工修改人',26),('manual_at','人工修改时间',27),
   ('manual_review_needed','人工修正待复核',28)
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
-- 7. 替换 ingest core（签名/返回键不变）：逐明细 source_* + 人工结果保留 + 复核提示
-- ---------------------------------------------------------------------------
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
 v_item_key text; v_name_raw text; v_name_norm text; v_shipped integer;
 v_source_received integer; v_source_basis text; v_item_basis text;
 v_effective_received integer; v_effective_basis text;
 v_review boolean; v_review_note text; v_prev_state jsonb;
 v_note text; v_sort integer;
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

 -- 幂等：同内容不新建票/明细/修订，也不触发人工复核（原表没有新信息）。
 SELECT s.id,s.content_hash INTO v_prev_snapshot,v_prev_hash
 FROM catalog.shipment_source_snapshot s
 WHERE s.source_key=v_source AND s.status='success' AND s.id<>v_snapshot_id
 ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1;
 IF v_prev_hash IS NOT DISTINCT FROM v_hash THEN
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

  v_shipment:=NULL;
  IF v_matched_id IS NOT NULL THEN
   SELECT * INTO v_shipment FROM catalog.shipment s
   WHERE s.id=v_matched_id FOR UPDATE;
   IF NOT FOUND OR v_shipment.source_key<>v_source THEN
    v_shipment:=NULL;
   END IF;
  END IF;
  IF v_shipment.id IS NULL THEN
   SELECT * INTO v_shipment FROM catalog.shipment s
   WHERE s.source_key=v_source AND s.ticket_key=v_ticket_key FOR UPDATE;
   IF NOT FOUND THEN v_shipment:=NULL; END IF;
  END IF;

  v_effective_key:=v_ticket_key;
  IF v_shipment.id IS NOT NULL AND v_shipment.ticket_key<>v_ticket_key THEN
   IF EXISTS(SELECT 1 FROM catalog.shipment s
     WHERE s.source_key=v_source AND s.ticket_key=v_ticket_key AND s.id<>v_shipment.id) THEN
    v_effective_key:=v_shipment.ticket_key;
   END IF;
  END IF;

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

  -- 逐明细：原表判断（source_*）与生效值（received_quantity/receipt_basis）分开写。
  -- 有 manual 时保留人工生效值，原表出现新信息只置复核标记，不覆盖人工结果。
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

   -- 原表判断优先级：明细 sourceReceiptBasis（逐商品点名）→ sourceReceivedQuantity → 票级 basis。
   v_source_basis:=nullif(btrim(coalesce(v_item->>'sourceReceiptBasis','')),'');
   IF v_source_basis IS NOT NULL THEN
    IF v_source_basis NOT IN('status_in_transit_zero','status_awaiting_shelving_zero',
      'status_arrived_full','source_quantity','pending') THEN
     RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:sourceReceiptBasis:%/%',v_ticket_key,v_item_key
      USING ERRCODE='22023'; END IF;
    v_source_received:=CASE v_source_basis
     WHEN 'status_in_transit_zero' THEN 0
     WHEN 'status_awaiting_shelving_zero' THEN 0
     WHEN 'status_arrived_full' THEN v_shipped
     ELSE NULL END;
   ELSIF jsonb_typeof(v_item->'sourceReceivedQuantity')='number' THEN
    IF (v_item->>'sourceReceivedQuantity')!~'^[0-9]+$' THEN
     RAISE EXCEPTION 'SHIPMENT_INVALID_INPUT:receivedQuantity:%/%',v_ticket_key,v_item_key
      USING ERRCODE='22023'; END IF;
    v_source_received:=(v_item->>'sourceReceivedQuantity')::integer;
    v_source_basis:='source_quantity';
   ELSE
    v_source_basis:=v_received_basis;
    v_source_received:=CASE v_received_basis
     WHEN 'status_in_transit_zero' THEN 0
     WHEN 'status_awaiting_shelving_zero' THEN 0
     WHEN 'status_arrived_full' THEN v_shipped
     ELSE NULL END;
   END IF;
   v_note:=nullif(btrim(v_item->>'sourceNote'),'');

   SELECT * INTO v_item_row FROM catalog.shipment_item i
   WHERE i.shipment_id=v_shipment_id AND i.item_key=v_item_key FOR UPDATE;
   IF FOUND THEN
    IF v_item_row.manual_status IS NOT NULL THEN
     v_effective_received:=v_item_row.received_quantity;
     v_effective_basis:=v_item_row.receipt_basis;
     -- 原表到货数量/依据变化，或 H 原文变化 → 提示复核（人工结果仍生效、不自动清除）。
     IF (v_source_received IS DISTINCT FROM v_item_row.source_received_quantity)
      OR (v_source_basis IS DISTINCT FROM v_item_row.source_receipt_basis)
      OR (coalesce(v_arrival,'') IS DISTINCT FROM coalesce(v_item_row.manual_arrival_snapshot,'')) THEN
      v_review:=true;
      v_review_note:='原表到货说明/数量已更新，请复核人工修正';
     ELSE
      v_review:=v_item_row.manual_review_needed;
      v_review_note:=v_item_row.manual_review_note;
     END IF;
    ELSE
     v_effective_received:=v_source_received;
     v_effective_basis:=v_source_basis;
     v_review:=false;
     v_review_note:=NULL;
    END IF;
    -- 与“当前行”比较（不是与上一条修订）：人工修正不改 item.revision，
    -- 这样同一人工结果重复读取不会产生假修订，原表真有变化时照常追加修订。
    v_prev_state:=jsonb_build_object(
     'product_name_raw',v_item_row.product_name_raw,'product_name_norm',v_item_row.product_name_norm,
     'shipped_quantity',v_item_row.shipped_quantity,
     'received_quantity',v_item_row.received_quantity,'receipt_basis',v_item_row.receipt_basis,
     'source_received_quantity',v_item_row.source_received_quantity,
     'source_receipt_basis',v_item_row.source_receipt_basis,
     'manual_status',v_item_row.manual_status,
     'manual_shelved_quantity',v_item_row.manual_shelved_quantity,
     'manual_actor_name',v_item_row.manual_actor_name,'manual_at',v_item_row.manual_at,
     'manual_review_needed',v_item_row.manual_review_needed,
     'source_note',v_item_row.source_note,
     'unit_text',v_item_row.unit_text,'source_sku',v_item_row.source_sku,
     'product_id',v_item_row.product_id,
     'association_status',v_item_row.association_status,
     'association_method',v_item_row.association_method);
    v_fields:=jsonb_build_object(
     'product_name_raw',v_name_raw,'product_name_norm',v_name_norm,
     'shipped_quantity',v_shipped,
     'received_quantity',v_effective_received,'receipt_basis',v_effective_basis,
     'source_received_quantity',v_source_received,
     'source_receipt_basis',v_source_basis,
     'manual_status',v_item_row.manual_status,
     'manual_shelved_quantity',v_item_row.manual_shelved_quantity,
     'manual_actor_name',v_item_row.manual_actor_name,'manual_at',v_item_row.manual_at,
     'manual_review_needed',v_review,
     'source_note',v_note,
     'unit_text',v_item_row.unit_text,'source_sku',v_item_row.source_sku,
     'product_id',v_item_row.product_id,
     'association_status',v_item_row.association_status,
     'association_method',v_item_row.association_method);
    IF v_prev_state IS DISTINCT FROM v_fields THEN
     v_new_revision:=v_item_row.revision+1;
     UPDATE catalog.shipment_item SET
      product_name_raw=v_name_raw,product_name_norm=v_name_norm,
      shipped_quantity=v_shipped,
      received_quantity=v_effective_received,receipt_basis=v_effective_basis,
      source_received_quantity=v_source_received,source_receipt_basis=v_source_basis,
      source_note=v_note,sort_index=v_sort,
      manual_review_needed=v_review,manual_review_note=v_review_note,
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
    -- 新明细：自动关联只在“从没关联过”时做（与 026 一致）。
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
     product_name_norm,shipped_quantity,received_quantity,receipt_basis,
     source_received_quantity,source_receipt_basis,source_note,
     unit_text,source_sku,product_id,association_status,association_method,
     sort_index,revision,last_seen_snapshot_id,last_seen_at)
    VALUES(v_shipment_id,v_source,v_item_key,v_name_raw,v_name_norm,v_shipped,
     v_source_received,v_source_basis,v_source_received,v_source_basis,v_note,
     NULL,NULL,v_product,
     CASE WHEN v_product IS NULL THEN 'none' ELSE 'auto' END,
     CASE WHEN v_product IS NULL THEN NULL ELSE 'normalized_name_exact' END,
     v_sort,1,v_snapshot_id,now())
    RETURNING * INTO v_item_row;
    INSERT INTO catalog.shipment_item_revision(shipment_item_id,revision,snapshot_id,
     fields,recorded_at,recorded_by)
    VALUES(v_item_row.id,1,v_snapshot_id,jsonb_build_object(
     'product_name_raw',v_name_raw,'product_name_norm',v_name_norm,
     'shipped_quantity',v_shipped,
     'received_quantity',v_source_received,'receipt_basis',v_source_basis,
     'source_received_quantity',v_source_received,'source_receipt_basis',v_source_basis,
     'manual_status',NULL,'manual_shelved_quantity',NULL,
     'manual_actor_name',NULL,'manual_at',NULL,'manual_review_needed',false,
     'source_note',v_note,'unit_text',NULL,'source_sku',NULL,
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

-- ---------------------------------------------------------------------------
-- 8. 权限：写入/只读 RPC 只给 app 角色；核心函数与内部辅助不授权
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.apply_shipment_item_manual_correction(uuid,text,integer,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.restore_shipment_item_source_judgement(uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_manual_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_shipment_manual_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_effective_status_class(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.ingest_shipment_snapshot_core(jsonb,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_display_value(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.shipment_field_change_labels(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
 catalog.apply_shipment_item_manual_correction(uuid,text,integer,integer,text),
 catalog.restore_shipment_item_source_judgement(uuid,integer,text),
 catalog.read_shipment_manual_index(),
 catalog.read_shipment_manual_history(uuid)
 TO ice_p0_02_app_runner;

RESET ROLE;
