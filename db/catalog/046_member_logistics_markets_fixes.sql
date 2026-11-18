-- 046 成员物流在途 v1 补修：恢复 045 漏掉的冲突标记/原数量字段 + 账号启停审计前后值。
--
-- 045 为了给成员按市场收窄，重写了 read_shipment_manual_index()，但漏了 030 增加的
-- 数量冲突字段，导致：
--   * 票级 manualConflictCount 丢失（列表/详情不再提示冲突条数）；
--   * 明细 shippedQuantity / manualShippedQuantity / previousConfirmedShelvedQuantity /
--     manualConflict 丢失，服务端无法显示「原发货量 → 现发货量 / 已确认上架量」，
--     冲突明细也不会被排除在单票货值之外。
-- 本迁移只恢复这些字段，**保留 045 的授权市场过滤与成员守卫**。
--
-- 同时修正 update_access_account 的审计 before.isActive：045 取成了表单传入的新值，
-- 应取保存前的 public.profiles.is_active。其余字段（displayName/warehouseIds/logisticsMarkets）
-- 本来就是保存前值，不动。
--
-- 幂等：CREATE OR REPLACE FUNCTION；不改表、不写业务数据行。

SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 人工修正索引：030 的字段全集 + 045 的成员市场过滤
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_shipment_manual_index() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_markets text[];
BEGIN
 PERFORM catalog.require_shipment_read();
 IF catalog.is_admin() THEN v_markets:=NULL; ELSE v_markets:=catalog.access_member_markets(); END IF;
 RETURN jsonb_build_object(
  'shipments',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'shipmentId',s.id,
     'effectiveStatusClass',catalog.shipment_effective_status_class(s.id),
     'manualCorrectionCount',(SELECT count(*) FROM catalog.shipment_item i
       WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
         AND i.manual_status IS NOT NULL),
     'manualReviewCount',(SELECT count(*) FROM catalog.shipment_item i
       WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
         AND i.manual_review_needed),
     'manualConflictCount',(SELECT count(*) FROM catalog.shipment_item i
       WHERE i.shipment_id=s.id AND i.last_seen_snapshot_id=s.last_seen_snapshot_id
         AND catalog.shipment_manual_quantity_conflict(i.id))
    ) ORDER BY s.id),'[]'::jsonb)
   FROM catalog.shipment s
   WHERE v_markets IS NULL OR s.market=ANY(v_markets)),
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
      ELSE i.shipped_quantity-i.received_quantity END,
     -- 030：旧发货量（保存人工修正时）、当前发货量、之前确认的上架量、数量冲突。
     'shippedQuantity',i.shipped_quantity,
     'manualShippedQuantity',i.manual_shipped_quantity,
     'previousConfirmedShelvedQuantity',CASE i.manual_status
       WHEN 'fully_shelved' THEN i.manual_shipped_quantity
       WHEN 'partial_shelved' THEN i.manual_shelved_quantity
       WHEN 'in_transit' THEN 0
       WHEN 'arrived_pending_shelving' THEN 0
       ELSE NULL END,
     'manualConflict',catalog.shipment_manual_quantity_conflict(i.id)
    ) ORDER BY i.shipment_id,i.sort_index,i.id),'[]'::jsonb)
   FROM catalog.shipment_item i
   JOIN catalog.shipment s ON s.id=i.shipment_id
   WHERE (i.manual_status IS NOT NULL OR i.manual_review_needed OR i.manual_revision>0)
     AND (v_markets IS NULL OR s.market=ANY(v_markets))));
END $$;

-- ---------------------------------------------------------------------------
-- 2. 账号保存审计：before.isActive 取保存前的数据库值（不是表单新值）
--    其余 before 字段与 after 结构保持 045 原样；物流市场与仓库范围仍按原逻辑保存。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.update_access_account(p_profile uuid,p_display_name text,
 p_role uuid,p_is_active boolean,p_warehouse_ids uuid[],p_markets text[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_name text; v_ids uuid[]; v_markets text[]; v_before jsonb; v_system text;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_profile IS NULL THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT r.name INTO v_system FROM public.profiles p JOIN public.role r ON r.id=p.role_id WHERE p.id=p_profile;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_system='admin' THEN RAISE EXCEPTION 'ACCESS_ADMIN_ACCOUNT_IMMUTABLE' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.access_role r WHERE r.id=p_role) THEN
  RAISE EXCEPTION 'ACCESS_ROLE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 v_name:=nullif(btrim(coalesce(p_display_name,'')),'');
 IF v_name IS NULL THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NAME_REQUIRED' USING ERRCODE='22023'; END IF;
 IF length(v_name)>60 THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NAME_TOO_LONG' USING ERRCODE='22023'; END IF;
 v_ids:=ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_warehouse_ids,'{}'::uuid[])) x
  JOIN catalog.inventory_warehouse w ON w.id=x AND w.status='confirmed');
 v_markets:=catalog.access_market_list(p_markets);
 -- before 必须是保存前的数据库值：isActive 用 p.is_active，displayName 用 p.display_name。
 SELECT jsonb_build_object('displayName',p.display_name,'isActive',p.is_active,
   'warehouseIds',(SELECT coalesce(jsonb_agg(aw.warehouse_id ORDER BY aw.warehouse_id),'[]'::jsonb)
     FROM catalog.account_access_warehouse aw WHERE aw.profile_id=p.id),
   'logisticsMarkets',(SELECT coalesce(jsonb_agg(m.market ORDER BY m.market),'[]'::jsonb)
     FROM catalog.account_access_market m WHERE m.profile_id=p.id))
 INTO v_before FROM public.profiles p WHERE p.id=p_profile;
 UPDATE public.profiles p SET display_name=v_name,is_active=coalesce(p_is_active,p.is_active),
   updated_at=now() WHERE p.id=p_profile;
 UPDATE catalog.account_access a SET access_role_id=p_role,updated_at=now(),updated_by=v_actor
   WHERE a.profile_id=p_profile;
 IF NOT FOUND THEN
  INSERT INTO catalog.account_access(profile_id,access_role_id,created_by,updated_by)
   VALUES(p_profile,p_role,v_actor,v_actor);
 END IF;
 DELETE FROM catalog.account_access_warehouse aw WHERE aw.profile_id=p_profile AND NOT (aw.warehouse_id=ANY(v_ids));
 INSERT INTO catalog.account_access_warehouse(profile_id,warehouse_id)
  SELECT p_profile,x FROM unnest(v_ids) x
  ON CONFLICT (profile_id,warehouse_id) DO NOTHING;
 DELETE FROM catalog.account_access_market m WHERE m.profile_id=p_profile AND NOT (m.market=ANY(v_markets));
 INSERT INTO catalog.account_access_market(profile_id,market)
  SELECT p_profile,x FROM unnest(v_markets) x
  ON CONFLICT (profile_id,market) DO NOTHING;
 PERFORM catalog.inventory_audit_write(v_actor,'access_account_updated','access_account:'||p_profile::text,
  jsonb_build_object('profileId',p_profile,'before',v_before,'after',
   jsonb_build_object('displayName',v_name,'isActive',coalesce(p_is_active,true),'roleId',p_role,
    'warehouseIds',to_jsonb(v_ids),'logisticsMarkets',to_jsonb(v_markets))));
 RETURN jsonb_build_object('ok',true,'profileId',p_profile);
END $$;

-- ---------------------------------------------------------------------------
-- 3. 权限：CREATE OR REPLACE 保留原有 ACL；这里只显式重申 app 可执行、public 不可执行。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_shipment_manual_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.update_access_account(uuid,text,uuid,boolean,uuid[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_shipment_manual_index() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.update_access_account(uuid,text,uuid,boolean,uuid[],text[]) TO ice_p0_02_app_runner;

RESET ROLE;
