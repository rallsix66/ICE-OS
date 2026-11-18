-- 044 权限设置 v1 首轮补修：
--   1. 恢复后台任务的范围读取：043 把「非管理员调用 inventory_scope_payload」都当成成员读取，
--      导致后台领取任务拿到空仓清单（SCOPE_EMPTY）。这里只在「确有登录成员身份」时收窄，
--      后台（无 request.jwt.claim.sub）继续按同步配置里的参与仓领取。
--   2. 成员商品详情不再下发绑定（mapping）与候选（candidates）资料；数量/历史仍按授权仓过滤。
--   3. 新增 catalog.read_member_item_amounts()：含金额权限的成员按「授权仓内商品 × 数量」取采用成本；
--      无金额权限时函数直接拒绝（服务端不会读到成本，更不会下发给成员）。
--   4. 新增 catalog.record_access_password_reset()：只允许普通成员，写操作者/目标/时间；
--      记录里不含密码或哈希（密码只经过 Better Auth，不进入业务库）。
--
-- 幂等：用 pg_get_functiondef 取现行定义做精确文本替换，已替换过则跳过；替换次数不符就整段报错。
-- 依赖 043（access_role / account_access / access_member_warehouse_ids / require_inventory_read）。

SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. 后台任务范围读取：只对「有登录成员身份」的调用收窄。
-- ---------------------------------------------------------------------------
DO $$
DECLARE d text; n integer;
  old_guard constant text:=' IF NOT catalog.is_admin() THEN';
  new_guard constant text:=' IF catalog.access_profile_id() IS NOT NULL AND NOT catalog.is_admin() THEN';
BEGIN
  d:=pg_get_functiondef('catalog.inventory_scope_payload(uuid)'::regprocedure);
  IF position('access_profile_id() IS NOT NULL' in d)=0 THEN
    n:=(length(d)-length(replace(d,old_guard,'')))/length(old_guard);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_SCOPE_GUARD_COUNT:%',n; END IF;
    EXECUTE replace(d,old_guard,new_guard);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. 成员商品详情：绑定与候选只属于管理员维护面，成员不下发。
--    批次历史、逐仓数量、合计已由 043 的 scope 收窄覆盖。
-- ---------------------------------------------------------------------------
DO $$
DECLARE d text; n integer;
  map_old constant text:=' WHERE m.account_id=v_aid AND m.item_id=p_item;';
  map_new constant text:=' WHERE catalog.is_admin() AND m.account_id=v_aid AND m.item_id=p_item;';
  cand_old constant text:=' WHERE c.account_id=v_aid AND c.suggested_item_id=p_item;';
  cand_new constant text:=' WHERE catalog.is_admin() AND c.account_id=v_aid AND c.suggested_item_id=p_item;';
BEGIN
  d:=pg_get_functiondef('catalog.read_inventory_item(uuid,text,text,boolean)'::regprocedure);
  IF position('catalog.is_admin() AND m.account_id=v_aid' in d)=0 THEN
    n:=(length(d)-length(replace(d,map_old,'')))/length(map_old);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_ITEM_MAPPING_COUNT:%',n; END IF;
    EXECUTE replace(d,map_old,map_new);
  END IF;
  d:=pg_get_functiondef('catalog.read_inventory_item(uuid,text,text,boolean)'::regprocedure);
  IF position('catalog.is_admin() AND c.account_id=v_aid' in d)=0 THEN
    n:=(length(d)-length(replace(d,cand_old,'')))/length(cand_old);
    IF n<>1 THEN RAISE EXCEPTION 'ACCESS_PATCH_ITEM_CANDIDATE_COUNT:%',n; END IF;
    EXECUTE replace(d,cand_old,cand_new);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. 成员金额：只返回「当前授权仓读模型里出现过的商品」的采用成本（与页面数量同一范围）。
--    金额仍由服务端按「采用单位成本 × 页面数量」计算；本函数不返回任何数量或货值。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.read_member_item_amounts() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_profile uuid; v_role jsonb; v_aid uuid; v_scope_json jsonb; v_scope uuid[];
 result jsonb;
BEGIN
 v_profile:=catalog.require_inventory_read();
 v_role:=catalog.access_role_payload(v_profile);
 IF v_role IS NULL OR NOT coalesce((v_role->>'canViewAmount')::boolean,false) THEN
  RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 v_aid:=catalog.inventory_bound_account_id();
 IF v_aid IS NULL THEN RETURN '{}'::jsonb; END IF;
 v_scope_json:=catalog.inventory_scope_payload(v_aid);
 v_scope:=ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(
  coalesce(v_scope_json->'warehouseIds','[]'::jsonb)) x);
 SELECT coalesce(jsonb_object_agg(c.item_id::text, f.payload), '{}'::jsonb)
 INTO result
 FROM catalog.item_current c
 JOIN catalog.catalog_item i ON i.id=c.item_id
 JOIN catalog_private.item_financial_revision f
  ON f.item_id=c.item_id AND f.financial_revision=c.financial_revision
 WHERE i.first_release_id IS NOT NULL AND c.financial_revision IS NOT NULL
  AND c.item_id IN (SELECT DISTINCT e.item_id
   FROM catalog.inventory_effective_rows(v_aid,v_scope) e
   WHERE e.item_id IS NOT NULL);
 RETURN result;
END $$;

-- 金额表在 catalog_private，原来只有 is_admin() 策略；成员金额函数以属主身份执行，
-- 需要一条仅属主的 SELECT 策略才能读到「采用价版本」（与 043 给成员读路径补属主策略同理）。
-- 只影响属主执行的 SECURITY DEFINER 函数；运行角色没有任何直接表权限。
DROP POLICY IF EXISTS member_amount_definer_owner ON catalog_private.item_financial_revision;
CREATE POLICY member_amount_definer_owner ON catalog_private.item_financial_revision FOR SELECT
 USING (current_user = 'ice_p0_02_owner');

-- ---------------------------------------------------------------------------
-- 4. 密码重置留痕：只接受普通成员；记录操作者（audit.actor_id）、目标与时间，不含密码/哈希。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.record_access_password_reset(p_profile uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_actor uuid; v_system text; v_name text;
BEGIN
 v_actor:=catalog.require_admin();
 IF p_profile IS NULL THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NOT_FOUND' USING ERRCODE='22023'; END IF;
 SELECT r.name,p.display_name INTO v_system,v_name
 FROM public.profiles p JOIN public.role r ON r.id=p.role_id WHERE p.id=p_profile;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCESS_ACCOUNT_NOT_FOUND' USING ERRCODE='22023'; END IF;
 IF v_system='admin' THEN RAISE EXCEPTION 'ACCESS_ADMIN_ACCOUNT_IMMUTABLE' USING ERRCODE='42501'; END IF;
 PERFORM catalog.inventory_audit_write(v_actor,'access_account_password_reset',
  'access_account:'||p_profile::text,
  jsonb_build_object('profileId',p_profile,'displayName',v_name,'action','password_reset'));
 RETURN jsonb_build_object('ok',true,'profileId',p_profile,'at',now());
END $$;

-- ---------------------------------------------------------------------------
-- 5. 权限：只给运行角色执行新读取/留痕函数；不放开表。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_member_item_amounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.record_access_password_reset(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_member_item_amounts() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.record_access_password_reset(uuid) TO ice_p0_02_app_runner;

RESET ROLE;
