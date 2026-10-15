-- P0-02: 发布 commit 结果 unknown 时持久化 summary 并阻止盲目重复 claim。

CREATE OR REPLACE FUNCTION public.assert_no_unreconciled_publish_unknown(p_warehouse_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.sync_run sr
    WHERE sr.warehouse_id = p_warehouse_id
      AND sr.mode = 'real_write'
      AND sr.status = 'failed'
      AND sr.exit_code = 2
      AND sr.result_summary IS NOT NULL
      AND sr.result_summary->>'commitOutcome' = 'unknown'
      AND COALESCE(sr.result_summary->>'publishUnknownReconciled', 'false') <> 'true'
  ) THEN
    RAISE EXCEPTION '存在未核对的发布结果未知运行，禁止新的 claim'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_sync_run_publish_unknown(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sync_run%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;
  IF public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM public.sync_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_run 不存在: %', p_run_id USING ERRCODE = 'P0001';
  END IF;

  IF v_row.status <> 'failed'
     OR v_row.exit_code <> 2
     OR v_row.result_summary IS NULL
     OR v_row.result_summary->>'commitOutcome' IS DISTINCT FROM 'unknown' THEN
    RAISE EXCEPTION '仅允许核对 publish unknown 的 failed/exit_code=2 运行'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sync_run
  SET result_summary = COALESCE(result_summary, '{}'::jsonb)
      || jsonb_build_object('publishUnknownReconciled', true)
  WHERE id = p_run_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_no_unreconciled_publish_unknown(uuid) TO ice_p0_02_owner;
GRANT EXECUTE ON FUNCTION public.reconcile_sync_run_publish_unknown(uuid) TO ice_p0_02_app_runner;

CREATE OR REPLACE FUNCTION public.claim_sync_run(p_warehouse_id uuid, p_mode text, p_run_id uuid, p_lease_duration integer, p_triggered_by uuid, p_triggered_from text, p_dry_run_run_id uuid DEFAULT NULL::uuid, p_input_artifact_hash text DEFAULT NULL::text, p_plan_artifact_hash text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_wh_type      text;
  v_wh_active    boolean;
  v_in_progress  uuid;
  v_locked_by    uuid;
  v_lease_exp    timestamptz;
  v_now          timestamptz;
  v_dr_mode      text;
  v_dr_status    text;
  v_dr_plan_chk  text;
  v_dr_finished  timestamptz;
  v_dr_input_h   text;
  v_dr_plan_h    text;
  v_dr_wh_id     uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;

  IF public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  IF p_triggered_by IS NULL OR p_triggered_by != auth.uid() THEN
    RAISE EXCEPTION 'triggered_by 必须为当前登录用户' USING ERRCODE = 'P0001';
  END IF;

  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION '无效的仓库 ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode NOT IN ('dry_run', 'real_write') THEN
    RAISE EXCEPTION '无效的同步模式: %', p_mode USING ERRCODE = 'P0001';
  END IF;

  IF p_run_id IS NULL THEN
    RAISE EXCEPTION '无效的运行 ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_lease_duration IS NULL OR p_lease_duration < 30 OR p_lease_duration > 900 THEN
    RAISE EXCEPTION 'lease_duration 必须在 [30, 900] 范围内，收到: %', p_lease_duration
      USING ERRCODE = 'P0001';
  END IF;

  IF p_triggered_from NOT IN ('web', 'cli') THEN
    RAISE EXCEPTION '无效的触发来源: %', p_triggered_from USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'real_write' AND p_dry_run_run_id IS NULL THEN
    RAISE EXCEPTION 'Real Write 模式必须提供 dry_run_run_id' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_run:' || p_warehouse_id));

  SELECT type, is_active
  INTO v_wh_type, v_wh_active
  FROM public.warehouse
  WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse 不存在: %', p_warehouse_id USING ERRCODE = 'P0001';
  END IF;

  IF v_wh_type != 'overseas' THEN
    RAISE EXCEPTION 'Warehouse 类型必须为 overseas，实际: %', v_wh_type
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_wh_active THEN
    RAISE EXCEPTION 'Warehouse 已停用: %', p_warehouse_id USING ERRCODE = 'P0001';
  END IF;

  SELECT swl.locked_by
  INTO v_locked_by
  FROM public.sync_warehouse_lock swl
  WHERE swl.warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_warehouse_lock 行不存在: %', p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, lease_expires_at
  INTO v_in_progress, v_lease_exp
  FROM public.sync_run
  WHERE warehouse_id = p_warehouse_id
    AND status = 'in_progress'
  FOR UPDATE;

  v_now := clock_timestamp();

  IF FOUND THEN
    IF v_lease_exp IS NOT NULL AND v_lease_exp < v_now THEN
      UPDATE public.sync_run
      SET status          = 'failed',
          exit_code       = 2,
          error_message   = '租约过期，自动清理（被新 claim 回收）',
          finished_at     = v_now
      WHERE id = v_in_progress;

      UPDATE public.sync_warehouse_lock
      SET locked_by = NULL, locked_at = NULL
      WHERE warehouse_id = p_warehouse_id
        AND locked_by = v_in_progress;
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.assert_no_unreconciled_publish_unknown(p_warehouse_id);

  IF p_mode = 'real_write' THEN
    SELECT mode, status, plan_drift_check, finished_at,
           input_artifact_hash, plan_artifact_hash, warehouse_id
    INTO v_dr_mode, v_dr_status, v_dr_plan_chk, v_dr_finished,
         v_dr_input_h, v_dr_plan_h, v_dr_wh_id
    FROM public.sync_run
    WHERE id = p_dry_run_run_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'dry_run_run_id 对应的运行不存在: %', p_dry_run_run_id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_dr_wh_id != p_warehouse_id THEN
      RAISE EXCEPTION 'Dry Run warehouse 不匹配: 期望 %, 实际 %',
        p_warehouse_id, v_dr_wh_id USING ERRCODE = 'P0001';
    END IF;

    IF v_dr_mode != 'dry_run' THEN
      RAISE EXCEPTION 'dry_run_run_id 对应运行 mode 不是 dry_run: %', v_dr_mode
        USING ERRCODE = 'P0001';
    END IF;

    IF v_dr_status != 'completed' THEN
      RAISE EXCEPTION 'Dry Run 状态必须是 completed，实际: %', v_dr_status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_dr_plan_chk != 'PASS' THEN
      RAISE EXCEPTION 'Dry Run plan_drift_check 必须是 PASS，实际: %', v_dr_plan_chk
        USING ERRCODE = 'P0001';
    END IF;

    IF v_dr_finished IS NULL OR v_dr_finished <= v_now - INTERVAL '60 minutes' THEN
      RAISE EXCEPTION 'Dry Run 已完成达到或超过 60 分钟，已过期 (finished_at: %)', v_dr_finished
        USING ERRCODE = 'P0001';
    END IF;

    IF p_input_artifact_hash IS NULL OR p_input_artifact_hash != v_dr_input_h THEN
      RAISE EXCEPTION 'input_artifact_hash 不匹配' USING ERRCODE = 'P0001';
    END IF;

    IF p_plan_artifact_hash IS NULL OR p_plan_artifact_hash != v_dr_plan_h THEN
      RAISE EXCEPTION 'plan_artifact_hash 不匹配' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.sync_run (
    id, warehouse_id, mode, status,
    triggered_by, triggered_from,
    started_at, heartbeat_at, created_at,
    dry_run_run_id,
    input_artifact_hash, plan_artifact_hash,
    locked_by, lease_expires_at
  ) VALUES (
    p_run_id, p_warehouse_id, p_mode, 'in_progress',
    p_triggered_by, p_triggered_from,
    v_now, v_now, v_now,
    p_dry_run_run_id,
    p_input_artifact_hash, p_plan_artifact_hash,
    p_run_id, v_now + (p_lease_duration || ' seconds')::interval
  );

  UPDATE public.sync_warehouse_lock
  SET locked_by = p_run_id, locked_at = v_now
  WHERE warehouse_id = p_warehouse_id;

  RETURN p_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_sync_run_system(p_warehouse_id uuid, p_mode text, p_run_id uuid, p_lease_duration integer, p_triggered_by uuid, p_triggered_from text, p_input_artifact_hash text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_wh_type      text;
  v_wh_active    boolean;
  v_in_progress  uuid;
  v_locked_by    uuid;
  v_lease_exp    timestamptz;
  v_now          timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.role r ON r.id = p.role_id
    WHERE p.id = p_triggered_by
      AND p.is_active = true
      AND r.name = 'admin'
  ) THEN
    RAISE EXCEPTION '系统触发用户无效：必须是存在的激活管理员 (id=%)', p_triggered_by
      USING ERRCODE = 'P0001';
  END IF;

  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION '无效的仓库 ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode != 'dry_run' THEN
    RAISE EXCEPTION '系统路径仅允许 dry_run 模式，实际: %', p_mode USING ERRCODE = 'P0001';
  END IF;

  IF p_run_id IS NULL THEN
    RAISE EXCEPTION '无效的运行 ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_lease_duration IS NULL OR p_lease_duration < 30 OR p_lease_duration > 900 THEN
    RAISE EXCEPTION 'lease_duration 必须在 [30, 900] 范围内，收到: %', p_lease_duration
      USING ERRCODE = 'P0001';
  END IF;

  IF p_triggered_from NOT IN ('web', 'cli') THEN
    RAISE EXCEPTION '无效的触发来源: %', p_triggered_from USING ERRCODE = 'P0001';
  END IF;

  SELECT type, is_active
  INTO v_wh_type, v_wh_active
  FROM public.warehouse
  WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse 不存在: %', p_warehouse_id USING ERRCODE = 'P0001';
  END IF;

  IF v_wh_type != 'overseas' THEN
    RAISE EXCEPTION 'Warehouse 类型必须为 overseas，实际: %', v_wh_type
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_wh_active THEN
    RAISE EXCEPTION 'Warehouse 已停用: %', p_warehouse_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sync_run:' || p_warehouse_id));

  SELECT swl.locked_by
  INTO v_locked_by
  FROM public.sync_warehouse_lock swl
  WHERE swl.warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_warehouse_lock 行不存在: %', p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, lease_expires_at
  INTO v_in_progress, v_lease_exp
  FROM public.sync_run
  WHERE warehouse_id = p_warehouse_id
    AND status = 'in_progress'
  FOR UPDATE;

  v_now := clock_timestamp();

  IF FOUND THEN
    IF v_lease_exp IS NOT NULL AND v_lease_exp < v_now THEN
      UPDATE public.sync_run
      SET status          = 'failed',
          exit_code       = 2,
          error_message   = '租约过期，自动清理（被新 claim 回收）',
          finished_at     = v_now
      WHERE id = v_in_progress;

      UPDATE public.sync_warehouse_lock
      SET locked_by = NULL, locked_at = NULL
      WHERE warehouse_id = p_warehouse_id
        AND locked_by = v_in_progress;
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  PERFORM public.assert_no_unreconciled_publish_unknown(p_warehouse_id);

  INSERT INTO public.sync_run (
    id, warehouse_id, mode, status,
    triggered_by, triggered_from,
    started_at, heartbeat_at, created_at,
    dry_run_run_id,
    input_artifact_hash, plan_artifact_hash,
    locked_by, lease_expires_at
  ) VALUES (
    p_run_id, p_warehouse_id, p_mode, 'in_progress',
    p_triggered_by, p_triggered_from,
    v_now, v_now, v_now,
    NULL,
    p_input_artifact_hash, NULL,
    p_run_id, v_now + (p_lease_duration || ' seconds')::interval
  );

  UPDATE public.sync_warehouse_lock
  SET locked_by = p_run_id, locked_at = v_now
  WHERE warehouse_id = p_warehouse_id;

  RETURN p_run_id;
END;
$$;
