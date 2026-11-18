-- 045 成员按授权物流市场查看物流在途 v1。
--
-- 本迁移做四件事：
--   1. 新增 catalog.account_access_market：账号的「物流市场」范围，与仓库范围（043 的
--      account_access_warehouse）各自独立授权；未勾选任何市场 = 没有物流在途权限。
--   2. 新增 catalog.access_member_markets() / catalog.require_shipment_read()：
--      物流读取入口守卫是「管理员，或启用中且至少获授一个物流市场的成员」。
--   3. 让货票列表 / 详情 / 人工修正索引 / 人工修正历史支持成员按授权市场取数：
--      管理员口径完全不变；成员只在被授予的市场内计数、搜索与打开详情。
--   4. 账号管理 RPC 读写物流市场；成员权限摘要补上 canViewShipment / shipmentMarkets。
--
-- 市场值沿用飞书物流情况表的「来源国家/市场」原值（现役为 泰国 / 菲律宾 / 越南 / 马来西亚），
-- 与库存仓库的 market 代码（VN 等）不是同一套；两处授权互不影响。
--
-- 货值、改票、商品绑定继续只走管理员入口：本迁移不改 028 货值汇总、029 修正/恢复、
-- 026 关联更新的 require_admin，不放开任何写函数。
--
-- 幂等：表用 IF NOT EXISTS；函数用 CREATE OR REPLACE；026/029 的中大函数用
-- pg_get_functiondef 取现行定义做精确文本替换，已替换过则跳过，替换次数不符整段报错。
-- 不改 001–044，不写业务数据行。

-- ---------------------------------------------------------------------------
-- 1. 物流市场授权表（RLS：只有管理员与属主策略；不授予任何运行角色直接表权限）
-- ---------------------------------------------------------------------------
SET ROLE ice_p0_02_owner;

CREATE TABLE IF NOT EXISTS catalog.account_access_market (
  profile_id uuid NOT NULL REFERENCES catalog.account_access(profile_id) ON DELETE CASCADE,
  market text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, market),
  CONSTRAINT account_access_market_market_check CHECK (length(btrim(market)) BETWEEN 1 AND 40)
);
CREATE INDEX IF NOT EXISTS account_access_market_market ON catalog.account_access_market (market);

ALTER TABLE catalog.account_access_market ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.account_access_market FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enabled_admin ON catalog.account_access_market;
CREATE POLICY enabled_admin ON catalog.account_access_market FOR ALL
  USING (current_user <> 'ice_p0_02_owner' AND catalog.is_admin())
  WITH CHECK (current_user <> 'ice_p0_02_owner' AND catalog.is_admin());
DROP POLICY IF EXISTS access_definer_owner ON catalog.account_access_market;
CREATE POLICY access_definer_owner ON catalog.account_access_market FOR ALL
  USING (current_user = 'ice_p0_02_owner') WITH CHECK (current_user = 'ice_p0_02_owner');

-- ---------------------------------------------------------------------------
-- 2. 成员物流读取身份与市场范围
-- ---------------------------------------------------------------------------

-- 当前登录成员被授予的物流市场（只认启用中的账号；管理员返回空数组，由调用方短路）。
CREATE OR REPLACE FUNCTION catalog.access_member_markets() RETURNS text[]
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(array_agg(DISTINCT m.market ORDER BY m.market),'{}'::text[])
 FROM catalog.account_access_market m
 JOIN public.profiles p ON p.id=m.profile_id AND p.is_active
 WHERE m.profile_id=catalog.access_profile_id()
$$;

-- 物流读取入口守卫：管理员，或启用中且至少被授予一个物流市场的成员。
CREATE OR REPLACE FUNCTION catalog.require_shipment_read() RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile uuid;
BEGIN
 v_profile:=catalog.access_profile_id();
 IF v_profile IS NULL THEN RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF catalog.is_admin() THEN RETURN v_profile; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_profile AND p.is_active) THEN
  RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF cardinality(catalog.access_member_markets())=0 THEN
  RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN v_profile;
END $$;

-- ---------------------------------------------------------------------------
-- 3. 成员权限摘要：现有字段不变，补物流在途可读标志与市场清单（导航/页面按此渲染）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_my_inventory_access() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile uuid; v_role jsonb; v_admin boolean; v_ids uuid[]; v_wh jsonb;
 v_markets text[];
BEGIN
 v_profile:=catalog.access_profile_id();
 IF v_profile IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_profile AND p.is_active) THEN
  RETURN jsonb_build_object('signedIn',false,'isAdmin',false,'canViewInventory',false,
   'canViewAmount',false,'roleName',NULL,'warehouseCount',0,'scopeEmpty',true,'warehouses','[]'::jsonb,
   'canViewShipment',false,'shipmentMarkets','[]'::jsonb);
 END IF;
 v_admin:=catalog.is_admin();
 v_role:=catalog.access_role_payload(v_profile);
 IF v_admin THEN
  v_ids:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w WHERE w.status='confirmed');
  v_markets:=ARRAY(SELECT DISTINCT s.market FROM catalog.shipment s
   WHERE s.market IS NOT NULL AND btrim(s.market)<>'' ORDER BY s.market);
 ELSE
  v_ids:=catalog.access_member_warehouse_ids();
  v_markets:=catalog.access_member_markets();
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'externalId',w.external_warehouse_id,
   'name',w.external_name,'market',w.market) ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_wh FROM catalog.inventory_warehouse w WHERE w.id=ANY(v_ids);
 RETURN jsonb_build_object('signedIn',true,'isAdmin',v_admin,
  'roleName',CASE WHEN v_admin THEN 'admin' ELSE v_role->>'name' END,
  'canViewInventory',v_admin OR coalesce((v_role->>'canViewInventory')::boolean,false),
  'canViewAmount',v_admin OR coalesce((v_role->>'canViewAmount')::boolean,false),
  'warehouseCount',cardinality(v_ids),'scopeEmpty',cardinality(v_ids)=0,'warehouses',v_wh,
  'canViewShipment',v_admin OR cardinality(v_markets)>0,
  'shipmentMarkets',to_jsonb(v_markets));
END $$;

-- ---------------------------------------------------------------------------
-- 4. 管理员：物流市场选项 + 账号读写带市场
-- ---------------------------------------------------------------------------
-- 选项 = 飞书物流表里真实出现过的市场（现役 4 个），附当前票数供管理员判断。
CREATE OR REPLACE FUNCTION catalog.read_access_market_options() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_rows jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 SELECT coalesce(jsonb_agg(jsonb_build_object('market',x.market,'ticketCount',x.c)
   ORDER BY x.market),'[]'::jsonb) INTO v_rows
 FROM (SELECT s.market,count(*) AS c FROM catalog.shipment s
   WHERE s.market IS NOT NULL AND btrim(s.market)<>'' GROUP BY s.market) x;
 RETURN jsonb_build_object('markets',v_rows);
END $$;

CREATE OR REPLACE FUNCTION catalog.access_account_rows(p_search text,p_role uuid,p_status text,
 p_limit integer,p_offset integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_search text; v_status text; v_limit integer; v_offset integer;
 v_total integer:=0; v_rows jsonb:='[]'::jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 v_search:=nullif(btrim(coalesce(p_search,'')),'');
 v_status:=nullif(btrim(coalesce(p_status,'')),'');
 v_limit:=greatest(1,least(coalesce(p_limit,50),200));
 v_offset:=greatest(0,coalesce(p_offset,0));
 WITH base AS (
  SELECT p.id AS profile_id,p.display_name,p.is_active,r.name AS system_role,
   coalesce(u.email,lu.email) AS email,
   a.access_role_id,ar.name AS access_role_name,
   ar.can_view_inventory,ar.can_view_amount
  FROM public.profiles p
  JOIN public.role r ON r.id=p.role_id
  LEFT JOIN p0_02_meta.ice_auth_user_map m ON m.ice_user_id=p.id
  LEFT JOIN p0_02_auth.user u ON u.id=m.auth_user_id
  LEFT JOIN auth.users lu ON lu.id=p.id
  LEFT JOIN catalog.account_access a ON a.profile_id=p.id
  LEFT JOIN catalog.access_role ar ON ar.id=a.access_role_id
 ), filtered AS (
  SELECT * FROM base b
  WHERE (v_search IS NULL OR b.display_name ILIKE '%'||v_search||'%'
      OR coalesce(b.email,'') ILIKE '%'||v_search||'%')
   AND (p_role IS NULL OR b.access_role_id=p_role)
   AND (v_status IS NULL OR (b.is_active=(v_status='active')))
 ), page AS (
  SELECT * FROM filtered ORDER BY is_active DESC,display_name,profile_id
   LIMIT v_limit OFFSET v_offset
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'profileId',f.profile_id,'displayName',f.display_name,'email',f.email,
  'isActive',f.is_active,'isSystemAdmin',f.system_role='admin',
  'roleId',f.access_role_id,'roleName',CASE WHEN f.system_role='admin' THEN '管理员' ELSE f.access_role_name END,
  'canViewInventory',f.system_role='admin' OR coalesce(f.can_view_inventory,false),
  'canViewAmount',f.system_role='admin' OR coalesce(f.can_view_amount,false),
  'markets',(SELECT coalesce(jsonb_agg(DISTINCT coalesce(w.market,'__unknown__')),'[]'::jsonb)
    FROM catalog.account_access_warehouse aw JOIN catalog.inventory_warehouse w ON w.id=aw.warehouse_id
    WHERE aw.profile_id=f.profile_id),
  'logisticsMarkets',(SELECT coalesce(jsonb_agg(m.market ORDER BY m.market),'[]'::jsonb)
    FROM catalog.account_access_market m WHERE m.profile_id=f.profile_id),
  'warehouseCount',(SELECT count(*) FROM catalog.account_access_warehouse aw WHERE aw.profile_id=f.profile_id))
  ORDER BY f.is_active DESC,f.display_name,f.profile_id),'[]'::jsonb),
  (SELECT count(*)::integer FROM filtered)
 INTO v_rows,v_total FROM page f;
 RETURN jsonb_build_object('total',v_total,'limit',v_limit,'offset',v_offset,'accounts',v_rows);
END $$;

CREATE OR REPLACE FUNCTION catalog.read_access_account(p_profile uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_row jsonb; v_wh jsonb; v_mk jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 SELECT jsonb_build_object('profileId',p.id,'displayName',p.display_name,
  'email',coalesce(u.email,lu.email),
  'authUserId',m.auth_user_id,
  'isActive',p.is_active,'isSystemAdmin',r.name='admin',
  'roleId',a.access_role_id,'roleName',ar.name,
  'canViewInventory',coalesce(ar.can_view_inventory,false),
  'canViewAmount',coalesce(ar.can_view_amount,false),
  'updatedAt',a.updated_at)
 INTO v_row
 FROM public.profiles p JOIN public.role r ON r.id=p.role_id
 LEFT JOIN p0_02_meta.ice_auth_user_map m ON m.ice_user_id=p.id
 LEFT JOIN p0_02_auth.user u ON u.id=m.auth_user_id
 LEFT JOIN auth.users lu ON lu.id=p.id
 LEFT JOIN catalog.account_access a ON a.profile_id=p.id
 LEFT JOIN catalog.access_role ar ON ar.id=a.access_role_id
 WHERE p.id=p_profile;
 IF v_row IS NULL THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseId',w.id,'externalId',w.external_warehouse_id,
   'name',w.external_name,'market',w.market) ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_wh FROM catalog.account_access_warehouse aw JOIN catalog.inventory_warehouse w ON w.id=aw.warehouse_id
 WHERE aw.profile_id=p_profile;
 SELECT coalesce(jsonb_agg(m.market ORDER BY m.market),'[]'::jsonb)
 INTO v_mk FROM catalog.account_access_market m WHERE m.profile_id=p_profile;
 RETURN v_row||jsonb_build_object('warehouses',v_wh,'logisticsMarkets',v_mk);
END $$;

-- 只保留「物流表里真实存在的市场」，去空白、去重；空数组=不授权。
CREATE OR REPLACE FUNCTION catalog.access_market_list(p_markets text[]) RETURNS text[]
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(array_agg(DISTINCT btrim(x) ORDER BY btrim(x)),'{}'::text[])
 FROM unnest(coalesce(p_markets,'{}'::text[])) x
 WHERE nullif(btrim(x),'') IS NOT NULL
   AND EXISTS(SELECT 1 FROM catalog.shipment s WHERE s.market=btrim(x))
$$;

CREATE OR REPLACE FUNCTION catalog.create_access_account(p_auth_user_id text,p_email text,
 p_display_name text,p_role uuid,p_warehouse_ids uuid[],p_is_active boolean,
 p_markets text[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_name text; v_profile uuid:=gen_random_uuid(); v_system_role uuid;
 v_ids uuid[]; v_markets text[];
BEGIN
 v_actor:=catalog.require_admin();
 v_name:=nullif(btrim(coalesce(p_display_name,'')),'');
 IF v_name IS NULL THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NAME_REQUIRED' USING ERRCODE='22023'; END IF;
 IF length(v_name)>60 THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NAME_TOO_LONG' USING ERRCODE='22023'; END IF;
 IF p_auth_user_id IS NULL OR length(btrim(p_auth_user_id))=0 THEN
  RAISE EXCEPTION 'ACCESS_ACCOUNT_AUTH_USER_REQUIRED' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.access_role r WHERE r.id=p_role) THEN
  RAISE EXCEPTION 'ACCESS_ROLE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT r.id INTO v_system_role FROM public.role r WHERE r.name='operator';
 IF v_system_role IS NULL THEN RAISE EXCEPTION 'ACCESS_SYSTEM_ROLE_MISSING' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM p0_02_meta.ice_auth_user_map m WHERE m.auth_user_id=p_auth_user_id) THEN
  RAISE EXCEPTION 'ACCESS_ACCOUNT_AUTH_USER_TAKEN' USING ERRCODE='22023'; END IF;
 v_ids:=ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_warehouse_ids,'{}'::uuid[])) x
  JOIN catalog.inventory_warehouse w ON w.id=x AND w.status='confirmed');
 v_markets:=catalog.access_market_list(p_markets);
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(v_profile,coalesce(p_email,''),'{}'::jsonb);
 INSERT INTO public.profiles(id,display_name,role_id,is_active)
  VALUES(v_profile,v_name,v_system_role,coalesce(p_is_active,true));
 INSERT INTO p0_02_meta.ice_auth_user_map(auth_user_id,ice_user_id) VALUES(p_auth_user_id,v_profile);
 INSERT INTO catalog.account_access(profile_id,access_role_id,created_by,updated_by)
  VALUES(v_profile,p_role,v_actor,v_actor);
 INSERT INTO catalog.account_access_warehouse(profile_id,warehouse_id)
  SELECT v_profile,x FROM unnest(v_ids) x;
 INSERT INTO catalog.account_access_market(profile_id,market)
  SELECT v_profile,x FROM unnest(v_markets) x;
 PERFORM catalog.inventory_audit_write(v_actor,'access_account_created','access_account:'||v_profile::text,
  jsonb_build_object('profileId',v_profile,'displayName',v_name,'email',p_email,'roleId',p_role,
   'isActive',coalesce(p_is_active,true),'warehouseIds',to_jsonb(v_ids),'logisticsMarkets',to_jsonb(v_markets)));
 RETURN jsonb_build_object('ok',true,'profileId',v_profile);
END $$;

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
 SELECT jsonb_build_object('displayName',p.display_name,'isActive',p_is_active,
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

-- 旧签名（无市场参数）：043 建立；045 起由带市场参数的版本取代，避免两套入口并存。
DROP FUNCTION IF EXISTS catalog.create_access_account(text,text,text,uuid,uuid[],boolean);
DROP FUNCTION IF EXISTS catalog.update_access_account(uuid,text,uuid,boolean,uuid[]);

-- ---------------------------------------------------------------------------
-- 5. 货票读取：入口守卫换成 require_shipment_read()，成员按授权市场收窄。
--    - read_shipment_list：计数/市场列表/分页行/本次来源未见到只统计授权市场；
--    - read_shipment_detail：未授权市场的票按「不存在」返回 NULL（不暴露存在性）；
--    - read_shipment_manual_index：只回授权市场票的人工修正（有效状态/数量口径不变）；
--    - read_shipment_manual_history：未授权市场的票返回空数组。
-- ---------------------------------------------------------------------------
DO $$
DECLARE d text; n integer;
  guard constant text:='PERFORM catalog.require_admin();';
  guard_new constant text:='PERFORM catalog.require_shipment_read();';
BEGIN
  -- 5.1 列表
  d:=pg_get_functiondef('catalog.read_shipment_list(text,text,text,uuid,boolean,integer,integer)'::regprocedure);
  IF position('v_markets' in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_GUARD_COUNT:read_shipment_list:%',n; END IF;
    d:=replace(d,guard,guard_new
      ||E'\n IF catalog.is_admin() THEN v_markets:=NULL; ELSE v_markets:=catalog.access_member_markets(); END IF;');
    n:=(length(d)-length(replace(d, E' v_source text; v_latest uuid; v_latest_at timestamptz;',
      '')))/length(E' v_source text; v_latest uuid; v_latest_at timestamptz;');
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_DECLARE_COUNT:read_shipment_list:%',n; END IF;
    d:=replace(d,E' v_source text; v_latest uuid; v_latest_at timestamptz;',
      E' v_source text; v_latest uuid; v_latest_at timestamptz; v_markets text[];');
    n:=(length(d)-length(replace(d,
      'WHERE (v_include_absent OR v_latest IS NULL OR s.last_seen_snapshot_id=v_latest)','')))/length(
      'WHERE (v_include_absent OR v_latest IS NULL OR s.last_seen_snapshot_id=v_latest)');
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_SCOPE_COUNT:read_shipment_list:%',n; END IF;
    d:=replace(d,'WHERE (v_include_absent OR v_latest IS NULL OR s.last_seen_snapshot_id=v_latest)',
      E'WHERE (v_include_absent OR v_latest IS NULL OR s.last_seen_snapshot_id=v_latest)\n     AND (v_markets IS NULL OR s.market=ANY(v_markets))');
    n:=(length(d)-length(replace(d,E'''absentTickets'',(SELECT count(*) FROM catalog.shipment s\n     WHERE v_latest IS NOT NULL AND s.last_seen_snapshot_id<>v_latest),','')))/length(
      E'''absentTickets'',(SELECT count(*) FROM catalog.shipment s\n     WHERE v_latest IS NOT NULL AND s.last_seen_snapshot_id<>v_latest),');
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_ABSENT_TICKETS_COUNT:read_shipment_list:%',n; END IF;
    d:=replace(d,E'''absentTickets'',(SELECT count(*) FROM catalog.shipment s\n     WHERE v_latest IS NOT NULL AND s.last_seen_snapshot_id<>v_latest),',
      E'''absentTickets'',(SELECT count(*) FROM catalog.shipment s\n     WHERE v_latest IS NOT NULL AND s.last_seen_snapshot_id<>v_latest\n       AND (v_markets IS NULL OR s.market=ANY(v_markets))),');
    n:=(length(d)-length(replace(d,E'''absentItems'',(SELECT count(*) FROM catalog.shipment_item i\n     WHERE v_latest IS NOT NULL AND i.last_seen_snapshot_id<>v_latest),','')))/length(
      E'''absentItems'',(SELECT count(*) FROM catalog.shipment_item i\n     WHERE v_latest IS NOT NULL AND i.last_seen_snapshot_id<>v_latest),');
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_ABSENT_ITEMS_COUNT:read_shipment_list:%',n; END IF;
    d:=replace(d,E'''absentItems'',(SELECT count(*) FROM catalog.shipment_item i\n     WHERE v_latest IS NOT NULL AND i.last_seen_snapshot_id<>v_latest),',
      E'''absentItems'',(SELECT count(*) FROM catalog.shipment_item i\n     JOIN catalog.shipment si ON si.id=i.shipment_id\n     WHERE v_latest IS NOT NULL AND i.last_seen_snapshot_id<>v_latest\n       AND (v_markets IS NULL OR si.market=ANY(v_markets))),');
    EXECUTE d;
  END IF;

  -- 5.2 详情
  d:=pg_get_functiondef('catalog.read_shipment_detail(uuid)'::regprocedure);
  IF position('access_member_markets()' in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_GUARD_COUNT:read_shipment_detail:%',n; END IF;
    d:=replace(d,guard,guard_new);
    n:=(length(d)-length(replace(d,'IF NOT FOUND THEN RETURN NULL; END IF;','')))/length('IF NOT FOUND THEN RETURN NULL; END IF;');
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_MISSING_COUNT:read_shipment_detail:%',n; END IF;
    d:=replace(d,'IF NOT FOUND THEN RETURN NULL; END IF;',
      E'IF NOT FOUND THEN RETURN NULL; END IF;\n'
      ||E' -- 成员只能看被授予的物流市场；其它市场的票按不存在处理，不暴露存在性。\n'
      ||E' IF NOT catalog.is_admin() AND (v_shipment.market IS NULL\n'
      ||E'   OR NOT v_shipment.market=ANY(catalog.access_member_markets())) THEN RETURN NULL; END IF;');
    EXECUTE d;
  END IF;

  -- 5.3 人工修正历史
  d:=pg_get_functiondef('catalog.read_shipment_manual_history(uuid)'::regprocedure);
  IF position('access_member_markets()' in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_GUARD_COUNT:read_shipment_manual_history:%',n; END IF;
    d:=replace(d,guard,guard_new);
    n:=(length(d)-length(replace(d,E' IF p_shipment_id IS NULL THEN RETURN ''[]''::jsonb; END IF;','')))/length(
      E' IF p_shipment_id IS NULL THEN RETURN ''[]''::jsonb; END IF;');
    IF n<>1 THEN RAISE EXCEPTION 'MEMBER_SHIPMENT_NULL_COUNT:read_shipment_manual_history:%',n; END IF;
    d:=replace(d,E' IF p_shipment_id IS NULL THEN RETURN ''[]''::jsonb; END IF;',
      E' IF p_shipment_id IS NULL THEN RETURN ''[]''::jsonb; END IF;\n'
      ||E' IF NOT catalog.is_admin() AND NOT EXISTS(SELECT 1 FROM catalog.shipment s\n'
      ||E'   WHERE s.id=p_shipment_id AND s.market=ANY(catalog.access_member_markets())) THEN RETURN ''[]''::jsonb; END IF;');
    EXECUTE d;
  END IF;
END $$;

-- 5.4 人工修正索引：成员只拿到授权市场票的人工状态/数量（与列表同一范围）。
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
         AND i.manual_review_needed))
    ORDER BY s.id),'[]'::jsonb)
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
      ELSE i.shipped_quantity-i.received_quantity END)
    ORDER BY i.shipment_id,i.sort_index,i.id),'[]'::jsonb)
   FROM catalog.shipment_item i
   JOIN catalog.shipment s ON s.id=i.shipment_id
   WHERE (i.manual_status IS NOT NULL OR i.manual_review_needed OR i.manual_revision>0)
     AND (v_markets IS NULL OR s.market=ANY(v_markets))));
END $$;

-- 5.5 读取状态：成员只拿「是否有上次成功读取 / 最近尝试时间与状态」，不返回跨市场票数。
CREATE OR REPLACE FUNCTION catalog.read_shipment_source_status() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.require_shipment_read();
 IF NOT catalog.is_admin() THEN
  RETURN (
   WITH last_success AS (
    SELECT * FROM catalog.shipment_source_snapshot s
    WHERE s.status='success'
    ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
   ), last_attempt AS (
    SELECT * FROM catalog.shipment_source_snapshot s
    ORDER BY s.read_finished_at DESC,s.created_at DESC,s.id DESC LIMIT 1
   )
   SELECT jsonb_build_object(
    'sourceKey',coalesce((SELECT a.source_key FROM last_attempt a),'feishu_logistics_sheet'),
    'lastSuccess',(SELECT jsonb_build_object(
      'snapshotId',ls.id,'readAt',ls.read_finished_at,'revision',ls.revision) FROM last_success ls),
    'lastAttempt',(SELECT jsonb_build_object(
      'snapshotId',la.id,'readAt',la.read_finished_at,'status',la.status) FROM last_attempt la)));
 END IF;
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

-- 028 货值汇总仍限管理员（成员没有货值视图）：不需要改动。

-- ---------------------------------------------------------------------------
-- 6. 权限：新表不授予运行角色；新函数只给 app 角色 EXECUTE。
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE catalog.account_access_market FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;

REVOKE ALL ON FUNCTION catalog.access_member_markets() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.require_shipment_read() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_access_market_options() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.access_market_list(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.create_access_account(text,text,text,uuid,uuid[],boolean,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.update_access_account(uuid,text,uuid,boolean,uuid[],text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION catalog.access_member_markets() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.require_shipment_read() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_access_market_options() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.access_market_list(text[]) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.create_access_account(text,text,text,uuid,uuid[],boolean,text[]) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.update_access_account(uuid,text,uuid,boolean,uuid[],text[]) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_my_inventory_access() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.access_account_rows(text,uuid,text,integer,integer) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_access_account(uuid) TO ice_p0_02_app_runner;

RESET ROLE;
