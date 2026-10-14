-- P0-02 incremental: sync admin read RPCs, auth directory boundary, RPC dependency grants.

-- SECURITY DEFINER owners read auth.users inside audited functions only.
GRANT USAGE ON SCHEMA auth TO ice_p0_02_owner;
GRANT SELECT ON auth.users TO ice_p0_02_owner;
GRANT EXECUTE ON FUNCTION auth.uid() TO ice_p0_02_owner;
GRANT EXECUTE ON FUNCTION public.get_user_role() TO ice_p0_02_owner;
GRANT EXECUTE ON FUNCTION public.get_assigned_warehouse_ids() TO ice_p0_02_owner;
GRANT SELECT ON public.profiles, public.role, public.sync_run, public.sync_log, public.warehouse TO ice_p0_02_owner;

-- ─── Auth directory: revoke blanket auth.users access ─────────────────
REVOKE SELECT ON auth.users FROM ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.p0_02_require_active_admin()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = '42501';
  END IF;
  IF public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '无权限' USING ERRCODE = '42501';
  END IF;
END;
$$;

ALTER FUNCTION public.p0_02_require_active_admin() OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.p0_02_require_active_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.p0_02_require_active_admin() TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.get_profile_emails_for_active_admin(p_profile_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.p0_02_require_active_admin();
  IF p_profile_ids IS NULL OR cardinality(p_profile_ids) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email) ORDER BY u.id)
      FROM auth.users u
      WHERE u.id = ANY (p_profile_ids)
    ),
    '[]'::jsonb
  );
END;
$$;

ALTER FUNCTION public.get_profile_emails_for_active_admin(uuid[]) OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_profile_emails_for_active_admin(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_profile_emails_for_active_admin(uuid[]) TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.get_profile_email_for_active_admin(p_profile_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM public.p0_02_require_active_admin();
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_profile_id LIMIT 1;
  RETURN COALESCE(v_email, '');
END;
$$;

ALTER FUNCTION public.get_profile_email_for_active_admin(uuid) OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_profile_email_for_active_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_profile_email_for_active_admin(uuid) TO ice_p0_02_app_runner;

-- ─── Nested RPC dependency (SECURITY INVOKER callers) ─────────────────
DO $$
DECLARE
  fn regprocedure;
  spec text := 'forecast_stockout(integer,numeric,integer,jsonb)';
BEGIN
  fn := to_regprocedure('public.' || spec);
  IF fn IS NULL THEN
    RAISE EXCEPTION 'P0-02 基线缺少 forecast_stockout';
  END IF;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, ice_p0_02_sync_runner',
    fn
  );
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_app_runner', fn);
END
$$;

DO $$
DECLARE
  fn regprocedure;
  spec text := 'batch_match_variants(uuid[],uuid)';
BEGIN
  fn := to_regprocedure('public.' || spec);
  IF fn IS NULL THEN
    RAISE EXCEPTION 'P0-02 基线缺少 batch_match_variants';
  END IF;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, ice_p0_02_sync_runner',
    fn
  );
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_app_runner', fn);
END
$$;

-- ─── Sync reads: app_runner RLS (no sync_runner blanket SELECT) ─────────

DROP POLICY IF EXISTS p0_02_app_admin_select_sync_run ON public.sync_run;
CREATE POLICY p0_02_app_admin_select_sync_run ON public.sync_run
  FOR SELECT
  USING (public.get_user_role() = 'admin');

DROP POLICY IF EXISTS p0_02_app_operator_select_sync_run ON public.sync_run;
CREATE POLICY p0_02_app_operator_select_sync_run ON public.sync_run
  FOR SELECT
  USING (
    public.get_user_role() = 'operator'
    AND sync_run.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
  );

DROP POLICY IF EXISTS p0_02_app_admin_select_sync_log ON public.sync_log;
CREATE POLICY p0_02_app_admin_select_sync_log ON public.sync_log
  FOR SELECT
  USING (public.get_user_role() = 'admin');

DROP POLICY IF EXISTS p0_02_app_operator_select_sync_log ON public.sync_log;
CREATE POLICY p0_02_app_operator_select_sync_log ON public.sync_log
  FOR SELECT
  USING (
    public.get_user_role() = 'operator'
    AND sync_log.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
  );

-- Legacy RPC definitions below are retained for grant stability but reads use RLS + app pool.

CREATE OR REPLACE FUNCTION public.get_sync_active_run_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.p0_02_require_active_admin();
  RETURN COALESCE(
    ARRAY(
      SELECT sr.id FROM public.sync_run sr WHERE sr.status = 'in_progress' ORDER BY sr.id
    ),
    ARRAY[]::uuid[]
  );
END;
$$;

ALTER FUNCTION public.get_sync_active_run_ids() OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_sync_active_run_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sync_active_run_ids() TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.get_sync_recently_completed_run_ids(p_since timestamptz)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.p0_02_require_active_admin();
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'p_since 不能为空' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(
    ARRAY(
      SELECT sr.id
      FROM public.sync_run sr
      WHERE sr.status = 'completed' AND sr.finished_at >= p_since
      ORDER BY sr.id
    ),
    ARRAY[]::uuid[]
  );
END;
$$;

ALTER FUNCTION public.get_sync_recently_completed_run_ids(timestamptz) OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_sync_recently_completed_run_ids(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sync_recently_completed_run_ids(timestamptz) TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.get_sync_referenced_dry_run_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.p0_02_require_active_admin();
  RETURN COALESCE(
    ARRAY(
      SELECT sr.dry_run_run_id
      FROM public.sync_run sr
      WHERE sr.dry_run_run_id IS NOT NULL
      ORDER BY sr.dry_run_run_id
    ),
    ARRAY[]::uuid[]
  );
END;
$$;

ALTER FUNCTION public.get_sync_referenced_dry_run_ids() OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_sync_referenced_dry_run_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sync_referenced_dry_run_ids() TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.get_sync_dry_run_binding_metadata(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row jsonb;
BEGIN
  PERFORM public.p0_02_require_active_admin();
  SELECT jsonb_build_object(
    'id', sr.id,
    'warehouse_id', sr.warehouse_id,
    'mode', sr.mode,
    'status', sr.status,
    'finished_at', sr.finished_at,
    'plan_drift_check', sr.plan_drift_check,
    'input_artifact_hash', sr.input_artifact_hash,
    'plan_artifact_hash', sr.plan_artifact_hash
  )
  INTO v_row
  FROM public.sync_run sr
  WHERE sr.id = p_run_id;
  RETURN v_row;
END;
$$;

ALTER FUNCTION public.get_sync_dry_run_binding_metadata(uuid) OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_sync_dry_run_binding_metadata(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sync_dry_run_binding_metadata(uuid) TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.get_sync_log_for_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_wh uuid;
  v_row jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_user_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION '无权限' USING ERRCODE = '42501';
  END IF;

  SELECT sl.warehouse_id INTO v_wh
  FROM public.sync_log sl
  WHERE sl.sync_run_id = p_run_id
  LIMIT 1;

  IF v_wh IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_role = 'admin' THEN
    NULL;
  ELSIF v_role = 'operator' THEN
    IF NOT (v_wh = ANY (public.get_assigned_warehouse_ids())) THEN
      RETURN NULL;
    END IF;
  ELSE
    RAISE EXCEPTION '无权限' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'id', sl.id,
    'sync_run_id', sl.sync_run_id,
    'warehouse_id', sl.warehouse_id,
    'status', sl.status,
    'new_variants_count', sl.new_variants_count,
    'error_message', sl.error_message,
    'started_at', sl.started_at,
    'finished_at', sl.finished_at
  )
  INTO v_row
  FROM public.sync_log sl
  WHERE sl.sync_run_id = p_run_id
  LIMIT 1;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.get_sync_log_for_run(uuid) OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_sync_log_for_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sync_log_for_run(uuid) TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.get_sync_warehouse_history_runs(p_warehouse_id uuid, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = '42501';
  END IF;
  v_role := public.get_user_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION '无权限' USING ERRCODE = '42501';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'p_limit 必须在 [1, 50]' USING ERRCODE = 'P0001';
  END IF;

  IF v_role = 'admin' THEN
    NULL;
  ELSIF v_role = 'operator' THEN
    IF NOT (p_warehouse_id = ANY (public.get_assigned_warehouse_ids())) THEN
      RETURN '[]'::jsonb;
    END IF;
  ELSE
    RAISE EXCEPTION '无权限' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'mode', t.mode,
          'status', t.status,
          'finished_at', t.finished_at,
          'result_summary', t.result_summary
        )
        ORDER BY t.started_at DESC
      )
      FROM (
        SELECT sr.id, sr.mode, sr.status, sr.finished_at, sr.result_summary, sr.started_at
        FROM public.sync_run sr
        WHERE sr.warehouse_id = p_warehouse_id
        ORDER BY sr.started_at DESC
        LIMIT p_limit
      ) t
    ),
    '[]'::jsonb
  );
END;
$$;

ALTER FUNCTION public.get_sync_warehouse_history_runs(uuid, integer) OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION public.get_sync_warehouse_history_runs(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sync_warehouse_history_runs(uuid, integer) TO ice_p0_02_app_runner;

DO $$
DECLARE
  fn regprocedure;
  spec text := 'update_user_warehouses(uuid,uuid[])';
BEGIN
  fn := to_regprocedure('public.' || spec);
  IF fn IS NULL THEN
    RAISE EXCEPTION 'P0-02 基线缺少 update_user_warehouses';
  END IF;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, ice_p0_02_sync_runner',
    fn
  );
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_app_runner', fn);
END
$$;

DO $$
DECLARE
  fn regprocedure;
  spec text := 'sync_warehouse_inventory(uuid,jsonb,jsonb,text)';
BEGIN
  fn := to_regprocedure('public.' || spec);
  IF fn IS NULL THEN
    RAISE EXCEPTION 'P0-02 基线缺少 sync_warehouse_inventory';
  END IF;
  EXECUTE format(
    'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, ice_p0_02_app_runner',
    fn
  );
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_sync_runner', fn);
END
$$;

DROP POLICY IF EXISTS sync_warehouse_update_warehouse ON public.warehouse;
CREATE POLICY sync_warehouse_update_warehouse ON public.warehouse
  FOR UPDATE
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND id = p0_02_meta.sync_warehouse_id()
  )
  WITH CHECK (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND id = p0_02_meta.sync_warehouse_id()
  );

GRANT UPDATE ON public.warehouse TO ice_p0_02_sync_runner;
