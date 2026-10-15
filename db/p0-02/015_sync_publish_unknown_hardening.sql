-- P0-02: 核对结论 NULL/空白拒绝；expire 须管理员身份且与 claim/release 同锁序；收紧 EXECUTE。

CREATE OR REPLACE FUNCTION public.reconcile_sync_run_publish_unknown(
  p_run_id uuid,
  p_conclusion text,
  p_basis text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sync_run%ROWTYPE;
  v_has_success boolean;
  v_basis text;
  v_conclusion text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;
  IF public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  v_conclusion := NULLIF(trim(COALESCE(p_conclusion, '')), '');
  IF v_conclusion IS NULL THEN
    RAISE EXCEPTION '无效的核对结论: 不能为空' USING ERRCODE = 'P0001';
  END IF;
  IF v_conclusion NOT IN ('confirmed_committed', 'confirmed_not_committed') THEN
    RAISE EXCEPTION '无效的核对结论: %', p_conclusion USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM public.sync_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_run 不存在: %', p_run_id USING ERRCODE = 'P0001';
  END IF;

  IF v_row.status <> 'failed'
     OR v_row.exit_code <> 2
     OR (
       v_row.result_summary IS NULL
       AND COALESCE(v_row.error_message, '') NOT LIKE '%租约过期%'
     )
     OR (
       v_row.result_summary IS NOT NULL
       AND v_row.result_summary->>'commitOutcome' IS DISTINCT FROM 'unknown'
       AND COALESCE(v_row.result_summary->>'leaseExpiredWithoutFinalRelease', 'false') <> 'true'
     ) THEN
    RAISE EXCEPTION '仅允许核对 publish unknown 或租约过期未 release 的 failed/exit_code=2 运行'
      USING ERRCODE = 'P0001';
  END IF;

  v_has_success := public.sync_run_has_publish_success_log(p_run_id);
  v_basis := NULLIF(trim(COALESCE(p_basis, '')), '');

  IF v_conclusion = 'confirmed_committed' THEN
    IF NOT v_has_success THEN
      RAISE EXCEPTION '缺少该运行的 success sync_log，不能确认为已提交'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_basis IS NULL THEN
      v_basis := 'auto:success sync_log present for run';
    END IF;
  ELSIF v_conclusion = 'confirmed_not_committed' THEN
    IF v_has_success THEN
      RAISE EXCEPTION '存在 success sync_log，不能确认为未提交'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_basis IS NULL OR length(v_basis) < 8 THEN
      RAISE EXCEPTION '确认为未提交必须提供不少于 8 字符的核对依据'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.sync_run
  SET result_summary = COALESCE(result_summary, '{}'::jsonb)
      || jsonb_build_object(
        'commitOutcome', 'unknown',
        'publishUnknownReconciled', true,
        'publishUnknownReconcileConclusion', v_conclusion,
        'publishUnknownReconcileBasis', v_basis,
        'publishUnknownReconciledBy', auth.uid()::text,
        'publishUnknownReconciledAt', to_jsonb(clock_timestamp())
      )
  WHERE id = p_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_stale_sync_runs_for_warehouse(p_warehouse_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_in_progress uuid;
  v_in_progress_mode text;
  v_lease_exp timestamptz;
  v_locked_by uuid;
  v_now timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;

  IF public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION '无效的仓库 ID' USING ERRCODE = 'P0001';
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

  v_now := clock_timestamp();

  SELECT id, lease_expires_at, mode
  INTO v_in_progress, v_lease_exp, v_in_progress_mode
  FROM public.sync_run
  WHERE warehouse_id = p_warehouse_id
    AND status = 'in_progress'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_lease_exp IS NULL OR v_lease_exp >= v_now THEN
    RETURN;
  END IF;

  UPDATE public.sync_run
  SET status          = 'failed',
      exit_code       = 2,
      error_message   = '租约过期，自动清理（被新 claim 回收）',
      finished_at     = v_now,
      result_summary  = CASE
        WHEN v_in_progress_mode = 'real_write' THEN
          COALESCE(result_summary, '{}'::jsonb)
          || jsonb_build_object(
            'commitOutcome', 'unknown',
            'publishUnknownReconciled', false,
            'leaseExpiredWithoutFinalRelease', true
          )
        ELSE result_summary
      END
  WHERE id = v_in_progress;

  UPDATE public.sync_warehouse_lock
  SET locked_by = NULL, locked_at = NULL
  WHERE warehouse_id = p_warehouse_id
    AND locked_by = v_in_progress;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.expire_stale_sync_runs_for_warehouse(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_stale_sync_runs_for_warehouse(uuid) TO ice_p0_02_app_runner;

REVOKE EXECUTE ON FUNCTION public.reconcile_sync_run_publish_unknown(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_sync_run_publish_unknown(uuid, text, text) TO ice_p0_02_app_runner;

REVOKE EXECUTE ON FUNCTION public.sync_run_has_publish_success_log(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_run_has_publish_success_log(uuid) TO ice_p0_02_owner;
