-- 043 权限设置 v1：角色（库存查看 / 库存金额查看）、账号数据范围（市场·仓库）、成员按范围读取海外库存。
--
-- 本迁移只做四件事：
--   1. 新增 catalog.access_role / catalog.account_access / catalog.account_access_warehouse 三张表（默认拒绝，仅管理员与属主可写）；
--   2. 新增管理员用的角色/账号读写 RPC（SECURITY DEFINER + require_admin + inventory_audit 留痕）；
--   3. 让既有只读函数支持「成员按授范围读取」：入口守卫从 require_admin() 换成
--      require_inventory_read()（管理员或已授予库存查看的启用成员），并在成员读取时
--      （有 request.jwt.claim.sub）把 scope 与成员被授予的仓库取交集；后台任务没有登录身份，
--      仍按同步配置的参与仓领取（044 进一步把这一条件写明确）。函数体本身不重写：用
--      pg_get_functiondef 取出
--      现行定义做精确文本替换后重新安装，替换次数必须等于预期，否则整段报错退出。
--   4. 给成员读路径真正引用到、却只有 is_admin() 策略的 catalog 表补一条「仅属主」SELECT 策略
--      （只读函数以属主身份执行；成员不是管理员，不补会读不到商品身份）。
--
-- 金额不在数据库层裁剪：读模型本来就只返回数量，估算货值由服务端按「采用进货价 × 数量」在
-- 应用层计算，无金额权限时服务端不读成本、不下发该列（见 src/features/inventory/server/reads.ts）。
--
-- 不改 001-042，不写任何业务数据行；唯一的数据写入是两条预置角色（负责人 / 运营）。

-- ---------------------------------------------------------------------------
-- 0. 属主需要写 public.profiles / auth.users / 读 p0_02_auth（建号与停用）。
--    public.profiles、auth.users 属 postgres，故在切到 owner 之前授予；只在缺权时授予。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT pg_catalog.has_table_privilege('ice_p0_02_owner','public.profiles','INSERT') THEN
    GRANT INSERT, UPDATE ON public.profiles TO ice_p0_02_owner;
  END IF;
  IF NOT pg_catalog.has_table_privilege('ice_p0_02_owner','auth.users','INSERT') THEN
    GRANT INSERT ON auth.users TO ice_p0_02_owner;
  END IF;
  IF NOT pg_catalog.has_table_privilege('ice_p0_02_owner','p0_02_auth.user','SELECT') THEN
    GRANT SELECT ON p0_02_auth.user TO ice_p0_02_owner;
  END IF;
END $$;

SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog.access_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  can_view_inventory boolean NOT NULL DEFAULT true,
  can_view_amount boolean NOT NULL DEFAULT false,
  preset_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT access_role_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 20),
  CONSTRAINT access_role_amount_requires_view CHECK ((NOT can_view_amount) OR can_view_inventory),
  CONSTRAINT access_role_name_not_reserved CHECK (lower(btrim(name)) NOT IN ('admin','管理员')),
  CONSTRAINT access_role_preset_key_check CHECK (preset_key IS NULL OR preset_key IN ('lead','ops'))
);
CREATE UNIQUE INDEX IF NOT EXISTS access_role_name_unique ON catalog.access_role (lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS access_role_preset_unique ON catalog.access_role (preset_key) WHERE preset_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS catalog.account_access (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  access_role_id uuid NOT NULL REFERENCES catalog.access_role(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS catalog.account_access_warehouse (
  profile_id uuid NOT NULL REFERENCES catalog.account_access(profile_id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES catalog.inventory_warehouse(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, warehouse_id)
);
CREATE INDEX IF NOT EXISTS account_access_warehouse_warehouse ON catalog.account_access_warehouse (warehouse_id);

ALTER TABLE catalog.access_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.access_role FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.account_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.account_access FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog.account_access_warehouse ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.account_access_warehouse FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enabled_admin ON catalog.access_role;
CREATE POLICY enabled_admin ON catalog.access_role FOR ALL
  USING (current_user <> 'ice_p0_02_owner' AND catalog.is_admin())
  WITH CHECK (current_user <> 'ice_p0_02_owner' AND catalog.is_admin());
DROP POLICY IF EXISTS access_definer_owner ON catalog.access_role;
CREATE POLICY access_definer_owner ON catalog.access_role FOR ALL
  USING (current_user = 'ice_p0_02_owner') WITH CHECK (current_user = 'ice_p0_02_owner');

DROP POLICY IF EXISTS enabled_admin ON catalog.account_access;
CREATE POLICY enabled_admin ON catalog.account_access FOR ALL
  USING (current_user <> 'ice_p0_02_owner' AND catalog.is_admin())
  WITH CHECK (current_user <> 'ice_p0_02_owner' AND catalog.is_admin());
DROP POLICY IF EXISTS access_definer_owner ON catalog.account_access;
CREATE POLICY access_definer_owner ON catalog.account_access FOR ALL
  USING (current_user = 'ice_p0_02_owner') WITH CHECK (current_user = 'ice_p0_02_owner');

DROP POLICY IF EXISTS enabled_admin ON catalog.account_access_warehouse;
CREATE POLICY enabled_admin ON catalog.account_access_warehouse FOR ALL
  USING (current_user <> 'ice_p0_02_owner' AND catalog.is_admin())
  WITH CHECK (current_user <> 'ice_p0_02_owner' AND catalog.is_admin());
DROP POLICY IF EXISTS access_definer_owner ON catalog.account_access_warehouse;
CREATE POLICY access_definer_owner ON catalog.account_access_warehouse FOR ALL
  USING (current_user = 'ice_p0_02_owner') WITH CHECK (current_user = 'ice_p0_02_owner');

-- ---------------------------------------------------------------------------
-- 2. 预置角色（负责人 / 运营）；已存在时不覆盖管理员后续的编辑。
-- ---------------------------------------------------------------------------
INSERT INTO catalog.access_role (name, description, can_view_inventory, can_view_amount, preset_key)
VALUES ('负责人', '按分配的市场与仓库查看库存，含数量与估算货值。', true, true, 'lead'),
       ('运营', '按分配的市场与仓库查看库存数量，不显示金额。', true, false, 'ops')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. 读取身份与范围（成员侧）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.access_profile_id() RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;

CREATE OR REPLACE FUNCTION catalog.access_role_payload(p_profile uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('roleId',r.id,'name',r.name,'description',r.description,
   'canViewInventory',r.can_view_inventory,'canViewAmount',r.can_view_amount,'presetKey',r.preset_key)
 FROM catalog.account_access a JOIN catalog.access_role r ON r.id=a.access_role_id
 WHERE a.profile_id=p_profile
$$;

-- 当前登录成员被授予的仓库（只认启用中的账号、参与中的仓；管理员返回空数组，由调用方短路）。
CREATE OR REPLACE FUNCTION catalog.access_member_warehouse_ids() RETURNS uuid[]
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(array_agg(DISTINCT w.id ORDER BY w.id),'{}'::uuid[])
 FROM catalog.account_access_warehouse aw
 JOIN catalog.inventory_warehouse w ON w.id=aw.warehouse_id AND w.status='confirmed'
 JOIN public.profiles p ON p.id=aw.profile_id AND p.is_active
 WHERE aw.profile_id=catalog.access_profile_id()
$$;

-- 只读入口守卫：管理员，或启用中且被授予「库存查看」的成员。
CREATE OR REPLACE FUNCTION catalog.require_inventory_read() RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile uuid; v_role jsonb;
BEGIN
 v_profile:=catalog.access_profile_id();
 IF v_profile IS NULL THEN RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF catalog.is_admin() THEN RETURN v_profile; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_profile AND p.is_active) THEN
  RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 v_role:=catalog.access_role_payload(v_profile);
 IF v_role IS NULL OR NOT coalesce((v_role->>'canViewInventory')::boolean,false) THEN
  RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN v_profile;
END $$;

-- 页面/导航用：当前登录用户的权限与可见仓（不返回成本、金额）。
CREATE OR REPLACE FUNCTION catalog.read_my_inventory_access() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile uuid; v_role jsonb; v_admin boolean; v_ids uuid[]; v_wh jsonb;
BEGIN
 v_profile:=catalog.access_profile_id();
 IF v_profile IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=v_profile AND p.is_active) THEN
  RETURN jsonb_build_object('signedIn',false,'isAdmin',false,'canViewInventory',false,
   'canViewAmount',false,'roleName',NULL,'warehouseCount',0,'scopeEmpty',true,'warehouses','[]'::jsonb);
 END IF;
 v_admin:=catalog.is_admin();
 v_role:=catalog.access_role_payload(v_profile);
 IF v_admin THEN
  v_ids:=ARRAY(SELECT w.id FROM catalog.inventory_warehouse w WHERE w.status='confirmed');
 ELSE
  v_ids:=catalog.access_member_warehouse_ids();
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'externalId',w.external_warehouse_id,
   'name',w.external_name,'market',w.market) ORDER BY w.external_warehouse_id),'[]'::jsonb)
 INTO v_wh FROM catalog.inventory_warehouse w WHERE w.id=ANY(v_ids);
 RETURN jsonb_build_object('signedIn',true,'isAdmin',v_admin,
  'roleName',CASE WHEN v_admin THEN 'admin' ELSE v_role->>'name' END,
  'canViewInventory',v_admin OR coalesce((v_role->>'canViewInventory')::boolean,false),
  'canViewAmount',v_admin OR coalesce((v_role->>'canViewAmount')::boolean,false),
  'warehouseCount',cardinality(v_ids),'scopeEmpty',cardinality(v_ids)=0,'warehouses',v_wh);
END $$;

-- ---------------------------------------------------------------------------
-- 4. 管理员：角色管理
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_access_roles() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_roles jsonb;
BEGIN
 PERFORM catalog.require_admin();
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'roleId',r.id,'name',r.name,'description',r.description,
  'canViewInventory',r.can_view_inventory,'canViewAmount',r.can_view_amount,
  'presetKey',r.preset_key,'updatedAt',r.updated_at,
  'accountCount',(SELECT count(*) FROM catalog.account_access a WHERE a.access_role_id=r.id))
  ORDER BY r.created_at,r.name),'[]'::jsonb) INTO v_roles
 FROM catalog.access_role r;
 RETURN jsonb_build_object('roles',v_roles);
END $$;

CREATE OR REPLACE FUNCTION catalog.save_access_role(p_role uuid,p_name text,p_description text,
 p_can_view_inventory boolean,p_can_view_amount boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_name text; v_desc text; v_row catalog.access_role;
BEGIN
 v_actor:=catalog.require_admin();
 v_name:=nullif(btrim(coalesce(p_name,'')),'');
 v_desc:=nullif(btrim(coalesce(p_description,'')),'');
 IF v_name IS NULL THEN RAISE EXCEPTION 'ACCESS_ROLE_NAME_REQUIRED' USING ERRCODE='22023'; END IF;
 IF length(v_name)>20 THEN RAISE EXCEPTION 'ACCESS_ROLE_NAME_TOO_LONG' USING ERRCODE='22023'; END IF;
 IF v_desc IS NOT NULL AND length(v_desc)>200 THEN RAISE EXCEPTION 'ACCESS_ROLE_DESCRIPTION_TOO_LONG' USING ERRCODE='22023'; END IF;
 IF lower(v_name) IN ('admin','管理员') THEN RAISE EXCEPTION 'ACCESS_ROLE_NAME_RESERVED' USING ERRCODE='22023'; END IF;
 IF coalesce(p_can_view_amount,false) AND NOT coalesce(p_can_view_inventory,false) THEN
  RAISE EXCEPTION 'ACCESS_ROLE_AMOUNT_REQUIRES_VIEW' USING ERRCODE='22023'; END IF;
 IF p_role IS NULL THEN
  INSERT INTO catalog.access_role(name,description,can_view_inventory,can_view_amount,created_by)
  VALUES(v_name,v_desc,coalesce(p_can_view_inventory,true),coalesce(p_can_view_amount,false),v_actor)
  RETURNING * INTO v_row;
 ELSE
  UPDATE catalog.access_role r SET name=v_name,description=v_desc,
   can_view_inventory=coalesce(p_can_view_inventory,true),
   can_view_amount=coalesce(p_can_view_amount,false),updated_at=now()
  WHERE r.id=p_role RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCESS_ROLE_NOT_FOUND' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM catalog.inventory_audit_write(v_actor,
  CASE WHEN p_role IS NULL THEN 'access_role_created' ELSE 'access_role_updated' END,
  'access_role:'||v_row.id::text,
  jsonb_build_object('roleId',v_row.id,'name',v_row.name,'description',v_row.description,
   'canViewInventory',v_row.can_view_inventory,'canViewAmount',v_row.can_view_amount,
   'presetKey',v_row.preset_key,'created',p_role IS NULL));
 RETURN jsonb_build_object('ok',true,'role',jsonb_build_object(
  'roleId',v_row.id,'name',v_row.name,'description',v_row.description,
  'canViewInventory',v_row.can_view_inventory,'canViewAmount',v_row.can_view_amount,
  'presetKey',v_row.preset_key,'updatedAt',v_row.updated_at));
END $$;

-- ---------------------------------------------------------------------------
-- 5. 管理员：账号管理
-- 账号行口径：profiles（姓名/启用）+ 认证邮箱 + 访问角色 + 仓库范围。
-- 管理员账号（public.role.name='admin'）只读展示，不可编辑、不可停用。
-- ---------------------------------------------------------------------------
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
  'warehouseCount',(SELECT count(*) FROM catalog.account_access_warehouse aw WHERE aw.profile_id=f.profile_id))
  ORDER BY f.is_active DESC,f.display_name,f.profile_id),'[]'::jsonb),
  (SELECT count(*)::integer FROM filtered)
 INTO v_rows,v_total FROM page f;
 RETURN jsonb_build_object('total',v_total,'limit',v_limit,'offset',v_offset,'accounts',v_rows);
END $$;

CREATE OR REPLACE FUNCTION catalog.read_access_account(p_profile uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_row jsonb; v_wh jsonb;
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
 RETURN v_row||jsonb_build_object('warehouses',v_wh);
END $$;

-- 账号配置里的市场/仓库选择项：只列现役参与仓（confirmed），excluded 不出现。
CREATE OR REPLACE FUNCTION catalog.read_access_warehouse_options() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_rows jsonb;
BEGIN
 v_actor:=catalog.require_admin();
 SELECT coalesce(jsonb_agg(jsonb_build_object('warehouseId',w.id,'externalId',w.external_warehouse_id,
   'name',w.external_name,'market',w.market,'marketKey',coalesce(w.market,'__unknown__'))
   ORDER BY coalesce(w.market,'__unknown__'),w.external_warehouse_id),'[]'::jsonb) INTO v_rows
 FROM catalog.inventory_warehouse w WHERE w.status='confirmed';
 RETURN jsonb_build_object('warehouses',v_rows);
END $$;

-- 建号：认证账号由服务端用 Better Auth 建好后，这里一次性落 profiles / 映射 / 角色 / 仓库范围。
CREATE OR REPLACE FUNCTION catalog.create_access_account(p_auth_user_id text,p_email text,
 p_display_name text,p_role uuid,p_warehouse_ids uuid[],p_is_active boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_name text; v_profile uuid:=gen_random_uuid(); v_system_role uuid; v_ids uuid[];
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
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(v_profile,coalesce(p_email,''),'{}'::jsonb);
 INSERT INTO public.profiles(id,display_name,role_id,is_active)
  VALUES(v_profile,v_name,v_system_role,coalesce(p_is_active,true));
 INSERT INTO p0_02_meta.ice_auth_user_map(auth_user_id,ice_user_id) VALUES(p_auth_user_id,v_profile);
 INSERT INTO catalog.account_access(profile_id,access_role_id,created_by,updated_by)
  VALUES(v_profile,p_role,v_actor,v_actor);
 INSERT INTO catalog.account_access_warehouse(profile_id,warehouse_id)
  SELECT v_profile,x FROM unnest(v_ids) x;
 PERFORM catalog.inventory_audit_write(v_actor,'access_account_created','access_account:'||v_profile::text,
  jsonb_build_object('profileId',v_profile,'displayName',v_name,'email',p_email,'roleId',p_role,
   'isActive',coalesce(p_is_active,true),'warehouseIds',to_jsonb(v_ids)));
 RETURN jsonb_build_object('ok',true,'profileId',v_profile);
END $$;

CREATE OR REPLACE FUNCTION catalog.update_access_account(p_profile uuid,p_display_name text,
 p_role uuid,p_is_active boolean,p_warehouse_ids uuid[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_name text; v_ids uuid[]; v_before jsonb; v_system text;
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
 SELECT jsonb_build_object('displayName',p.display_name,'isActive',p.is_active,
   'warehouseIds',(SELECT coalesce(jsonb_agg(aw.warehouse_id ORDER BY aw.warehouse_id),'[]'::jsonb)
     FROM catalog.account_access_warehouse aw WHERE aw.profile_id=p.id))
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
 PERFORM catalog.inventory_audit_write(v_actor,'access_account_updated','access_account:'||p_profile::text,
  jsonb_build_object('profileId',p_profile,'before',v_before,'after',
   jsonb_build_object('displayName',v_name,'isActive',coalesce(p_is_active,true),'roleId',p_role,
    'warehouseIds',to_jsonb(v_ids))));
 RETURN jsonb_build_object('ok',true,'profileId',p_profile);
END $$;

CREATE OR REPLACE FUNCTION catalog.set_access_account_active(p_profile uuid,p_is_active boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_system text; v_before boolean;
BEGIN
 v_actor:=catalog.require_admin();
 SELECT r.name,p.is_active INTO v_system,v_before FROM public.profiles p
  JOIN public.role r ON r.id=p.role_id WHERE p.id=p_profile;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_system='admin' THEN RAISE EXCEPTION 'ACCESS_ADMIN_ACCOUNT_IMMUTABLE' USING ERRCODE='42501'; END IF;
 UPDATE public.profiles p SET is_active=coalesce(p_is_active,p.is_active),updated_at=now() WHERE p.id=p_profile;
 PERFORM catalog.inventory_audit_write(v_actor,
  CASE WHEN coalesce(p_is_active,false) THEN 'access_account_enabled' ELSE 'access_account_disabled' END,
  'access_account:'||p_profile::text,
  jsonb_build_object('profileId',p_profile,'before',v_before,'after',coalesce(p_is_active,false)));
 RETURN jsonb_build_object('ok',true,'profileId',p_profile,'isActive',coalesce(p_is_active,false));
END $$;

-- ---------------------------------------------------------------------------
-- 6. 既有只读函数：入口守卫换成 require_inventory_read()，范围交集成员被授予的仓库。
--    逐个取现行定义做精确文本替换，替换次数必须等于预期，否则整段报错（不会留下半安装）。
--    幂等：已经替换过（目标片段已在函数体里）时跳过，重复安装不报错。
-- ---------------------------------------------------------------------------
DO $$
DECLARE d text; n integer;
  guard constant text:='PERFORM catalog.require_admin();';
  guard_new constant text:='PERFORM catalog.require_inventory_read();';
  wh_check constant text:='IF NOT EXISTS(SELECT 1 FROM catalog.inventory_warehouse w WHERE w.id=v_filter_wh AND w.account_id=v_aid) THEN';
  wh_check_new constant text:='IF NOT EXISTS(SELECT 1 FROM catalog.inventory_warehouse w WHERE w.id=v_filter_wh AND w.account_id=v_aid'
    ||E'\n     AND (catalog.is_admin() OR w.id=ANY(catalog.access_member_warehouse_ids()))) THEN';
  scope_anchor constant text:=' SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',w.id,''externalId'',w.external_warehouse_id,';
  scope_anchor_new constant text:=E' IF catalog.access_profile_id() IS NOT NULL AND NOT catalog.is_admin() THEN\n'
    ||E'  v_scope.warehouse_ids:=ARRAY(SELECT x FROM unnest(v_scope.warehouse_ids) x\n'
    ||E'   WHERE x=ANY(catalog.access_member_warehouse_ids()));\n'
    ||E' END IF;\n'
    ||E' SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',w.id,''externalId'',w.external_warehouse_id,';
BEGIN
  -- 6.1 逐仓读取状态
  d:=pg_get_functiondef('catalog.read_inventory_warehouse_states()'::regprocedure);
  IF position(guard_new in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_GUARD_COUNT:read_inventory_warehouse_states:%',n; END IF;
    EXECUTE replace(d,guard,guard_new);
  END IF;

  -- 6.2 仓库明细
  d:=pg_get_functiondef('catalog.read_inventory_warehouse_rows(text,text,text)'::regprocedure);
  IF position(guard_new in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_GUARD_COUNT:read_inventory_warehouse_rows:%',n; END IF;
    d:=replace(d,guard,guard_new);
    n:=(length(d)-length(replace(d,wh_check,'')))/length(wh_check);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_WH_COUNT:read_inventory_warehouse_rows:%',n; END IF;
    EXECUTE replace(d,wh_check,wh_check_new);
  END IF;

  -- 6.3 商品汇总
  d:=pg_get_functiondef('catalog.read_inventory_product_summary(text,text,text,integer,integer)'::regprocedure);
  IF position(guard_new in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_GUARD_COUNT:read_inventory_product_summary:%',n; END IF;
    d:=replace(d,guard,guard_new);
    n:=(length(d)-length(replace(d,wh_check,'')))/length(wh_check);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_WH_COUNT:read_inventory_product_summary:%',n; END IF;
    EXECUTE replace(d,wh_check,wh_check_new);
  END IF;

  -- 6.4 商品详情（allWarehouses 只对管理员成立，成员仍限于被授予的仓）
  d:=pg_get_functiondef('catalog.read_inventory_item(uuid,text,text,boolean)'::regprocedure);
  IF position(guard_new in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_GUARD_COUNT:read_inventory_item:%',n; END IF;
    d:=replace(d,guard,guard_new);
    n:=(length(d)-length(replace(d,wh_check,'')))/length(wh_check);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_WH_COUNT:read_inventory_item:%',n; END IF;
    d:=replace(d,wh_check,wh_check_new);
    IF position('IF v_all THEN' in d)=0 THEN
      RAISE EXCEPTION 'ACCESS_PATCH_ALL_WAREHOUSES_MISSING:read_inventory_item'; END IF;
    EXECUTE replace(d,'IF v_all THEN','IF v_all AND catalog.is_admin() THEN');
  END IF;

  -- 6.5 历史快照：批次列表
  d:=pg_get_functiondef('catalog.read_inventory_snapshot_batches(uuid,integer,integer)'::regprocedure);
  IF position(guard_new in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_GUARD_COUNT:read_inventory_snapshot_batches:%',n; END IF;
    d:=replace(d,guard,guard_new);
    n:=(length(d)-length(replace(d,'WHERE w.id=p_warehouse AND w.account_id=v_aid;','')))/length('WHERE w.id=p_warehouse AND w.account_id=v_aid;');
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_SNAPSHOT_WH:read_inventory_snapshot_batches:%',n; END IF;
    EXECUTE replace(d,'WHERE w.id=p_warehouse AND w.account_id=v_aid;',
      E'WHERE w.id=p_warehouse AND w.account_id=v_aid\n   AND (catalog.is_admin() OR w.id=ANY(catalog.access_member_warehouse_ids()));');
  END IF;

  -- 6.6 历史快照：单批明细（批次仓与请求仓都要在被授予范围内；否则按不存在处理，不暴露存在性）
  d:=pg_get_functiondef('catalog.read_inventory_snapshot_rows(uuid,uuid,text,integer,integer)'::regprocedure);
  IF position(guard_new in d)=0 THEN
    n:=(length(d)-length(replace(d,guard,'')))/length(guard);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_GUARD_COUNT:read_inventory_snapshot_rows:%',n; END IF;
    d:=replace(d,guard,guard_new);
    n:=(length(d)-length(replace(d,'WHERE w.id=v_batch.warehouse_id AND w.account_id=v_aid;','')))/length('WHERE w.id=v_batch.warehouse_id AND w.account_id=v_aid;');
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_SNAPSHOT_BATCH_WH:read_inventory_snapshot_rows:%',n; END IF;
    d:=replace(d,'WHERE w.id=v_batch.warehouse_id AND w.account_id=v_aid;',
      E'WHERE w.id=v_batch.warehouse_id AND w.account_id=v_aid\n   AND (catalog.is_admin() OR w.id=ANY(catalog.access_member_warehouse_ids()));');
    n:=(length(d)-length(replace(d,'WHERE w.id=p_warehouse AND w.account_id=v_aid;','')))/length('WHERE w.id=p_warehouse AND w.account_id=v_aid;');
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_SNAPSHOT_REQ_WH:read_inventory_snapshot_rows:%',n; END IF;
    EXECUTE replace(d,'WHERE w.id=p_warehouse AND w.account_id=v_aid;',
      E'WHERE w.id=p_warehouse AND w.account_id=v_aid\n   AND (catalog.is_admin() OR w.id=ANY(catalog.access_member_warehouse_ids()));');
  END IF;

  -- 6.7 账号范围收窄：成员看到的是「账号 scope ∩ 被授予仓库」，其余口径不变
  d:=pg_get_functiondef('catalog.inventory_scope_payload(uuid)'::regprocedure);
  IF position('access_member_warehouse_ids' in d)=0 THEN
    IF position(scope_anchor in d)=0 THEN
      RAISE EXCEPTION 'ACCESS_PATCH_SCOPE_ANCHOR_MISSING:inventory_scope_payload'; END IF;
    EXECUTE replace(d,scope_anchor,scope_anchor_new);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6.8 成员读路径的 RLS：这些只读函数是 SECURITY DEFINER（以属主身份执行），
--     而 catalog 核心表原来只有「is_admin()」策略——成员不是管理员，属主读不到行，
--     表现就是商品身份为空、详情报 ITEM_NOT_FOUND。这里为「成员读路径真正引用到的
--     catalog 表」补一条仅对属主生效的 SELECT 策略（不影响 app 角色，也不放宽给成员直连）。
--     表集合由函数文本的实际引用递归算出，已存在属主策略的表自动跳过。
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    WITH RECURSIVE f(name) AS (
      SELECT unnest(ARRAY['read_inventory_warehouse_states','read_inventory_warehouse_rows',
        'read_inventory_product_summary','read_inventory_item',
        'read_inventory_snapshot_batches','read_inventory_snapshot_rows',
        'inventory_scope_payload','read_my_inventory_access']::text[]) COLLATE "C"
      UNION
      SELECT DISTINCT (m[1])::text COLLATE "C"
      FROM f
      JOIN pg_proc p ON p.proname=f.name
      JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='catalog'
      CROSS JOIN LATERAL regexp_matches(p.prosrc,'catalog\.([a-z_][a-z0-9_]*)\(','g') AS m
      WHERE m[1] IN (SELECT pp.proname FROM pg_proc pp
        JOIN pg_namespace nn ON nn.oid=pp.pronamespace WHERE nn.nspname='catalog')
    ), bodies AS (
      SELECT p.prosrc FROM f JOIN pg_proc p ON p.proname=f.name
      JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='catalog'
    ), t AS (
      SELECT DISTINCT c.oid AS reloid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='catalog' AND c.relkind='r'
        AND EXISTS (SELECT 1 FROM bodies b WHERE position('catalog.'||c.relname in b.prosrc)>0)
    )
    SELECT t.reloid::regclass AS rel FROM t
    WHERE NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid=t.reloid
      AND pg_get_expr(pol.polqual,pol.polrelid) LIKE '%ice_p0_02_owner%')
  LOOP
    EXECUTE format('CREATE POLICY member_read_definer_owner ON %s FOR SELECT USING (current_user = %L)',
      r.rel,'ice_p0_02_owner');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 7. 权限：新表不授予任何运行角色，只通过上面的 SECURITY DEFINER 函数访问。
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE catalog.access_role FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;
REVOKE ALL ON TABLE catalog.account_access FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;
REVOKE ALL ON TABLE catalog.account_access_warehouse FROM PUBLIC, ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;

REVOKE ALL ON FUNCTION catalog.access_profile_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.access_role_payload(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.access_member_warehouse_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.require_inventory_read() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_my_inventory_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_access_roles() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.save_access_role(uuid,text,text,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.access_account_rows(text,uuid,text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_access_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.read_access_warehouse_options() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.create_access_account(text,text,text,uuid,uuid[],boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.update_access_account(uuid,text,uuid,boolean,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.set_access_account_active(uuid,boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION catalog.access_profile_id() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.access_role_payload(uuid) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.access_member_warehouse_ids() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.require_inventory_read() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_my_inventory_access() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_access_roles() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.save_access_role(uuid,text,text,boolean,boolean) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.access_account_rows(text,uuid,text,integer,integer) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_access_account(uuid) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.read_access_warehouse_options() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.create_access_account(text,text,text,uuid,uuid[],boolean) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.update_access_account(uuid,text,uuid,boolean,uuid[]) TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.set_access_account_active(uuid,boolean) TO ice_p0_02_app_runner;

RESET ROLE;
