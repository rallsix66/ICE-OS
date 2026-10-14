--
-- PostgreSQL database dump
--

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: acquire_token_lease(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.acquire_token_lease(p_provider text, p_lease_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_row           record;
  v_now           timestamptz := now();
  v_needs_refresh boolean := false;
BEGIN
  -- 查现有缓存行并锁定
  SELECT * INTO v_row
  FROM public.provider_token_cache
  WHERE provider = p_provider
  FOR UPDATE;

  IF FOUND THEN
    -- 判断是否需要刷新：expires_at - 5min > now 且无他人活跃租约
    IF v_row.expires_at - interval '5 minutes' > v_now
       AND (v_row.lease_until IS NULL OR v_row.lease_until < v_now)
    THEN
      -- Token 仍有效且无活跃租约 → 直接返回
      RETURN jsonb_build_object(
        'access_token', v_row.access_token,
        'expires_at', v_row.expires_at,
        'action', 'reuse'
      );
    END IF;

    -- Token 需刷新 → 尝试抢租约
    IF v_row.lease_until IS NULL OR v_row.lease_until < v_now THEN
      UPDATE public.provider_token_cache
      SET lease_owner = p_lease_id,
          lease_until = v_now + interval '30 seconds',
          updated_at = v_now
      WHERE provider = p_provider;

      v_needs_refresh := true;
    END IF;

    RETURN jsonb_build_object(
      'access_token', CASE WHEN v_needs_refresh THEN v_row.access_token ELSE NULL END,
      'expires_at', v_row.expires_at,
      'action', CASE WHEN v_needs_refresh THEN 'refresh' ELSE 'lease_held_by_other' END
    );
  ELSE
    -- 无缓存行 → 首次写入：INSERT 占位行并获取租约
    -- 并发保护：ON CONFLICT DO NOTHING，仅一个调用方能成功
    INSERT INTO public.provider_token_cache (provider, access_token, expires_at, lease_owner, lease_until)
    VALUES (p_provider, '__LEASE_PLACEHOLDER__', v_now, p_lease_id, v_now + interval '30 seconds')
    ON CONFLICT (provider) DO NOTHING;

    -- 检查是否拿到租约
    SELECT * INTO v_row
    FROM public.provider_token_cache
    WHERE provider = p_provider
      AND lease_owner = p_lease_id;

    IF FOUND THEN
      -- 成功获取首次租约
      RETURN jsonb_build_object(
        'access_token', NULL,
        'expires_at', NULL,
        'action', 'first_time'
      );
    END IF;

    -- 并发失败方 → 重新读取他人状态
    SELECT * INTO v_row
    FROM public.provider_token_cache
    WHERE provider = p_provider
    FOR UPDATE;

    -- 他人持有活跃租约 → 等待
    IF v_row.lease_until IS NOT NULL AND v_row.lease_until >= v_now THEN
      RETURN jsonb_build_object(
        'access_token', NULL,
        'expires_at', v_row.expires_at,
        'action', 'lease_held_by_other'
      );
    END IF;

    -- 他人租约已过期（异常情况）→ 尝试重新获取
    UPDATE public.provider_token_cache
    SET lease_owner = p_lease_id,
        lease_until = v_now + interval '30 seconds',
        updated_at = v_now
    WHERE provider = p_provider;

    RETURN jsonb_build_object(
      'access_token', v_row.access_token,
      'expires_at', v_row.expires_at,
      'action', 'refresh'
    );
  END IF;
END;
$$;


--
-- Name: batch_match_variants(uuid[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.batch_match_variants(p_variant_ids uuid[], p_product_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_role           text;
  v_deduped_ids    uuid[];
  v_product_active boolean;
  v_expected_count integer;
  v_matched_count  integer;
BEGIN
  -- ============================================
  -- 权限校验：仅 admin 可执行
  -- ============================================
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role != 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 输入校验：拒绝 NULL、空数组、包含 NULL 元素的数组
  -- ============================================
  IF p_product_id IS NULL THEN
    RAISE EXCEPTION '无效的产品 ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_variant_ids IS NULL OR array_length(p_variant_ids, 1) IS NULL THEN
    RAISE EXCEPTION '请选择至少一个 SKU' USING ERRCODE = 'P0001';
  END IF;

  IF array_position(p_variant_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION '无效的 SKU ID' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 函数内部去重 — 不依赖调用方保证唯一性
  -- ============================================
  SELECT array_agg(DISTINCT id) INTO v_deduped_ids
  FROM unnest(p_variant_ids) AS t(id);

  v_expected_count := array_length(v_deduped_ids, 1);

  -- ============================================
  -- 锁定 Product 行，保证 is_active 在事务内稳定
  -- ============================================
  SELECT is_active INTO v_product_active
  FROM public.product
  WHERE id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '产品不存在' USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_product_active THEN
    RAISE EXCEPTION '产品已停用，无法匹配' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 确认全部去重后的 Variant ID 均存在
  -- ============================================
  IF EXISTS (
    SELECT 1
    FROM unnest(v_deduped_ids) AS req(id)
    LEFT JOIN public.product_variant pv ON pv.id = req.id
    WHERE pv.id IS NULL
  ) THEN
    RAISE EXCEPTION '部分 SKU 不存在' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 全部校验通过 → 单次批量更新
  -- ============================================
  WITH updated AS (
    UPDATE public.product_variant
    SET product_id = p_product_id, match_status = 'matched'
    WHERE id = ANY(v_deduped_ids)
    RETURNING id
  )
  SELECT COUNT(*) INTO v_matched_count FROM updated;

  -- 更新数量必须等于去重后 ID 数量，否则回滚
  IF v_matched_count != v_expected_count THEN
    RAISE EXCEPTION '批量匹配部分失败：期望 % 条，实际更新 % 条', v_expected_count, v_matched_count
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_matched_count;
END;
$$;


--
-- Name: bind_external_ref_to_shipment(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bind_external_ref_to_shipment(p_ref_id uuid, p_shipment_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_caller_id         uuid;
  v_caller_role       text;
  v_caller_is_active  boolean;
  v_ref               record;
  v_shipment          record;
BEGIN
  -- ── 身份校验 ──────────────────────────────────────────
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION '未登录，请先登录后再操作'
      USING HINT = 'AUTH_REQUIRED';
  END IF;

  SELECT p.is_active INTO v_caller_is_active
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION '账号已被禁用，无法执行操作'
      USING HINT = 'ACCOUNT_DISABLED';
  END IF;

  v_caller_role := public.get_user_role();

  -- ── 读取 external_ref（FOR UPDATE 行锁，防止并发绑定） ──
  SELECT * INTO v_ref
  FROM public.shipment_external_ref
  WHERE id = p_ref_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '外部物流记录不存在'
      USING HINT = 'NOT_FOUND';
  END IF;

  -- ── 读取 shipment ──────────────────────────────────────
  SELECT * INTO v_shipment
  FROM public.shipment
  WHERE id = p_shipment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment 不存在'
      USING HINT = 'SHIPMENT_NOT_FOUND';
  END IF;

  -- ── 权限校验 ───────────────────────────────────────────
  -- Admin 全量；Operator 仅限已分配仓库
  IF v_caller_role = 'operator' THEN
    IF v_ref.warehouse_id NOT IN (SELECT public.get_assigned_warehouse_ids()) THEN
      RAISE EXCEPTION '无权操作该外部物流记录'
        USING HINT = 'FORBIDDEN_WAREHOUSE';
    END IF;
  END IF;

  -- ── 业务规则校验 ───────────────────────────────────────
  -- 已绑定校验（在行锁保护下判断）
  IF v_ref.shipment_id IS NOT NULL THEN
    RAISE EXCEPTION '该外部物流记录已绑定 Shipment（%），请先解绑后再操作', v_ref.shipment_id
      USING HINT = 'ALREADY_BOUND';
  END IF;

  -- 仓库一致性
  IF v_ref.warehouse_id IS DISTINCT FROM v_shipment.warehouse_id THEN
    RAISE EXCEPTION '外部物流记录仓库与 Shipment 仓库不一致，无法绑定'
      USING HINT = 'WAREHOUSE_MISMATCH';
  END IF;

  -- 国家一致性
  IF v_ref.country IS DISTINCT FROM v_shipment.country THEN
    RAISE EXCEPTION '外部物流记录国家（%）与 Shipment 国家（%）不一致，无法绑定',
      v_ref.country, v_shipment.country
      USING HINT = 'COUNTRY_MISMATCH';
  END IF;

  -- ── 写入绑定（再次校验 shipment_id IS NULL，防止 TOCTOU） ──
  UPDATE public.shipment_external_ref
  SET shipment_id = p_shipment_id,
      warehouse_id = v_shipment.warehouse_id,
      updated_at   = now()
  WHERE id = p_ref_id
    AND shipment_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION '该外部物流记录已被其他操作绑定，无法重复绑定'
      USING HINT = 'CONCURRENT_BINDING';
  END IF;
END;
$$;


--
-- Name: change_shipment_status_transactional(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_shipment_status_transactional(p_shipment_id uuid, p_status text, p_description text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_role            text;
  v_current_status  text;
  v_updated         integer;
BEGIN
  -- ============================================
  -- 权限校验：仅已启用的 admin 可调用
  -- ============================================
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role != 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 业务边界：禁用 warehoused
  -- ============================================
  IF p_status = 'warehoused' THEN
    RAISE EXCEPTION '当前不支持手动推进到入仓状态' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 0. 读取当前状态用于流转校验
  -- ============================================
  SELECT status INTO v_current_status
  FROM public.shipment
  WHERE id = p_shipment_id;

  -- 记录不存在时后续 UPDATE 也会命中 0 行并报错，此处提前给出清晰消息
  IF v_current_status IS NULL THEN
    RAISE EXCEPTION '在途记录不存在或无权访问' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 1. 状态流转规则校验
  --    仅允许按顺序推进：booking→loading→departed→arrived→customs
  --    拒绝倒退（如 departed→loading）
  --    拒绝跳步（如 booking→departed）
  -- ============================================
  IF NOT (
    (v_current_status = 'booking'  AND p_status = 'loading')  OR
    (v_current_status = 'loading'  AND p_status = 'departed') OR
    (v_current_status = 'departed' AND p_status = 'arrived')  OR
    (v_current_status = 'arrived'  AND p_status = 'customs')
  ) THEN
    RAISE EXCEPTION '状态不可从 % 变更为 %：仅允许按顺序推进', v_current_status, p_status
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 2. 更新 shipment.status（RLS 保障仓库隔离）
  -- ============================================
  UPDATE public.shipment
  SET status = p_status
  WHERE id = p_shipment_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION '在途记录不存在或无权访问' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 3. 同一事务内插入 tracking_event（RLS 保障仓库隔离）
  -- ============================================
  INSERT INTO public.tracking_event (
    shipment_id, status, description, occurred_at, created_by
  ) VALUES (
    p_shipment_id, p_status, p_description, now(), auth.uid()
  );

  RETURN TRUE;
END;
$$;


--
-- Name: check_operator_profile_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_operator_profile_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF public.get_user_role() = 'operator' THEN
    IF NEW.role_id IS DISTINCT FROM OLD.role_id THEN
      RAISE EXCEPTION '不允许修改自己的角色';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION '不允许修改自己的启用状态';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: claim_sync_run(uuid, text, uuid, integer, uuid, text, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_sync_run(p_warehouse_id uuid, p_mode text, p_run_id uuid, p_lease_duration integer, p_triggered_by uuid, p_triggered_from text, p_dry_run_run_id uuid DEFAULT NULL::uuid, p_input_artifact_hash text DEFAULT NULL::text, p_plan_artifact_hash text DEFAULT NULL::text) RETURNS uuid
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
  -- Step 1: Auth check
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;

  IF public.get_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  IF p_triggered_by IS NULL OR p_triggered_by != auth.uid() THEN
    RAISE EXCEPTION 'triggered_by 必须为当前登录用户' USING ERRCODE = 'P0001';
  END IF;

  -- Step 2: Param validation
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

  -- Step 3 (V5.5.1): pg_advisory_xact_lock (Layer 1)
  -- 移到 warehouse 验证之前，关闭 is_active 检查 TOCTOU 窗口
  PERFORM pg_advisory_xact_lock(hashtext('sync_run:' || p_warehouse_id));

  -- Step 4: Validate warehouse（在 advisory lock 保护区内）
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

  -- Step 5: SELECT FOR UPDATE on sync_warehouse_lock (Layer 2)
  SELECT swl.locked_by
  INTO v_locked_by
  FROM public.sync_warehouse_lock swl
  WHERE swl.warehouse_id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_warehouse_lock 行不存在: %', p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Step 5.5 (V5.5): SELECT FOR UPDATE on in_progress sync_run
  SELECT id, lease_expires_at
  INTO v_in_progress, v_lease_exp
  FROM public.sync_run
  WHERE warehouse_id = p_warehouse_id
    AND status = 'in_progress'
  FOR UPDATE;

  -- Step 5.6: clock_timestamp after all locks
  v_now := clock_timestamp();

  -- Step 5.7: Lease judgment
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

  -- Step 6 (V5.5.1): real_write - atomic dry_run_run_id validation
  -- FOR UPDATE 锁定 dry_run 行，关闭 TOCTOU 窗口
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

  -- Step 7: INSERT
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

  -- Step 8: Update lock table
  UPDATE public.sync_warehouse_lock
  SET locked_by = p_run_id, locked_at = v_now
  WHERE warehouse_id = p_warehouse_id;

  RETURN p_run_id;
END;
$$;


--
-- Name: claim_sync_run_system(uuid, text, uuid, integer, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_sync_run_system(p_warehouse_id uuid, p_mode text, p_run_id uuid, p_lease_duration integer, p_triggered_by uuid, p_triggered_from text, p_input_artifact_hash text DEFAULT NULL::text) RETURNS uuid
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


--
-- Name: cleanup_expired_sync_runs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_expired_sync_runs() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_lock_row   record;
  v_count      integer;
  v_total      integer := 0;
BEGIN
  -- 仅遍历存在过期 in_progress 运行的 warehouse（禁止锁定全部仓库）
  FOR v_lock_row IN
    SELECT DISTINCT sr.warehouse_id
    FROM public.sync_run sr
    WHERE sr.status = 'in_progress'
      AND sr.lease_expires_at IS NOT NULL
      AND sr.lease_expires_at < now()
    ORDER BY sr.warehouse_id
  LOOP
    -- advisory lock
    PERFORM pg_advisory_xact_lock(hashtext('sync_run:' || v_lock_row.warehouse_id));

    -- SELECT FOR UPDATE on sync_warehouse_lock
    PERFORM 1
    FROM public.sync_warehouse_lock
    WHERE warehouse_id = v_lock_row.warehouse_id
    FOR UPDATE;

    -- CTE: 标记过期运行为 failed (exit_code=2) + 清除对应锁
    WITH expired AS (
      UPDATE public.sync_run
      SET status        = 'failed',
          exit_code     = 2,
          error_message = '租约过期，自动清理',
          finished_at   = now()
      WHERE warehouse_id = v_lock_row.warehouse_id
        AND status = 'in_progress'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
      RETURNING id
    ),
    cleared AS (
      UPDATE public.sync_warehouse_lock
      SET locked_by = NULL, locked_at = NULL
      WHERE warehouse_id = v_lock_row.warehouse_id
        AND locked_by IN (SELECT id FROM expired)
      RETURNING 1
    )
    SELECT count(*) INTO v_count FROM expired;

    v_total := v_total + v_count;
  END LOOP;

  RETURN v_total;
END;
$$;


--
-- Name: create_shipment_transactional(text, text, text, text, text, text, uuid, date, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_shipment_transactional(p_shipment_no text, p_vessel_name text, p_voyage_number text, p_origin_port text, p_destination_port text, p_country text, p_warehouse_id uuid, p_estimated_arrival date, p_note text, p_purchase_order_no text, p_items jsonb) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_role        text;
  v_shipment_id uuid;
  v_item        jsonb;
BEGIN
  -- 权限校验：仅已启用的 admin 可调用
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role != 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  -- 输入校验：shipment_no
  IF p_shipment_no IS NULL OR trim(p_shipment_no) = '' THEN
    RAISE EXCEPTION '单号不能为空' USING ERRCODE = 'P0001';
  END IF;

  -- 输入校验：items
  IF p_items IS NULL THEN
    RAISE EXCEPTION '明细数据不能为空' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(p_items) != 'array' THEN
    RAISE EXCEPTION '明细数据格式错误：期望数组' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '明细数据不能为空数组' USING ERRCODE = 'P0001';
  END IF;

  -- 1. 创建 shipment 主单
  INSERT INTO public.shipment (
    shipment_no, vessel_name, voyage_number, origin_port, destination_port,
    country, warehouse_id, estimated_arrival, created_by, note, purchase_order_no
  ) VALUES (
    p_shipment_no, p_vessel_name, p_voyage_number, p_origin_port, p_destination_port,
    p_country, p_warehouse_id, p_estimated_arrival, auth.uid(), p_note,
    NULLIF(TRIM(p_purchase_order_no), '')
  )
  RETURNING id INTO v_shipment_id;

  -- 2. 批量插入 shipment_item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.shipment_item (shipment_id, variant_id, quantity)
    VALUES (
      v_shipment_id,
      (v_item->>'variant_id')::uuid,
      (v_item->>'quantity')::integer
    );
  END LOOP;

  -- 3. 创建初始 tracking_event (booking)
  INSERT INTO public.tracking_event (shipment_id, status, description, occurred_at, created_by)
  VALUES (v_shipment_id, 'booking', '订舱', now(), auth.uid());

  RETURN v_shipment_id;
END;
$$;


--
-- Name: fn_shipment_external_ref_warehouse_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_shipment_external_ref_warehouse_lock() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.shipment_id IS NOT NULL
     AND NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
  THEN
    RAISE EXCEPTION
      '该外部物流记录已绑定 Shipment，不支持修改仓库';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_shipment_no_rewarehouse_if_bound(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_shipment_no_rewarehouse_if_bound() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.warehouse_id IS DISTINCT FROM NEW.warehouse_id
     AND EXISTS (
       SELECT 1 FROM public.shipment_external_ref
       WHERE shipment_id = NEW.id
     )
  THEN
    RAISE EXCEPTION
      '该 Shipment 已绑定外部物流记录，P0 不支持换仓';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_tracking_event_external_provider_consistent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_tracking_event_external_provider_consistent() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_ref_provider text;
BEGIN
  SELECT provider INTO v_ref_provider
  FROM public.shipment_external_ref
  WHERE id = NEW.external_ref_id;

  IF v_ref_provider IS NULL THEN
    RAISE EXCEPTION '外部物流记录不存在 (external_ref_id=%)', NEW.external_ref_id;
  END IF;

  IF NEW.provider IS DISTINCT FROM v_ref_provider THEN
    RAISE EXCEPTION
      'tracking_event_external.provider (%) 与父记录 provider (%) 不一致',
      NEW.provider, v_ref_provider;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: forecast_stockout(integer, numeric, integer, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.forecast_stockout(p_on_hand integer, p_daily_sales numeric, p_lead_time_days integer, p_inbound jsonb) RETURNS TABLE(est_stockout_date date, effective_inbound integer, ds_incomplete boolean, lead_incomplete boolean)
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_today date := CURRENT_DATE;
  v_cursor_date date := CURRENT_DATE;
  v_event record;
  v_event_date date;
  v_days integer;
  v_consume numeric;
  v_current numeric := GREATEST(COALESCE(p_on_hand, 0), 0);
  v_stockout date;
  v_inbound jsonb := COALESCE(p_inbound, '[]'::jsonb);
BEGIN
  ds_incomplete := p_daily_sales IS NULL OR p_daily_sales <= 0;
  lead_incomplete := p_lead_time_days IS NULL OR p_lead_time_days <= 0;
  effective_inbound := 0;
  est_stockout_date := NULL;

  IF jsonb_typeof(v_inbound) <> 'array' THEN
    RAISE EXCEPTION 'p_inbound 必须为 JSON 数组' USING ERRCODE = 'P0001';
  END IF;

  -- 无可靠日销时不制造虚假的断货日。
  IF ds_incomplete THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- 调用方通常已按 ETA 聚合；函数再次聚合，防止同 ETA 重复扣减销量。
  FOR v_event IN
    WITH parsed AS (
      SELECT
        (item->>'eta')::date AS eta,
        (item->>'remaining')::integer AS remaining
      FROM jsonb_array_elements(v_inbound) AS item
      WHERE item ? 'eta'
        AND item ? 'remaining'
        AND item->>'eta' IS NOT NULL
        AND item->>'eta' <> ''
        AND item->>'remaining' IS NOT NULL
        AND item->>'remaining' <> ''
    )
    SELECT eta, SUM(remaining)::integer AS total_remaining
    FROM parsed
    WHERE remaining > 0
    GROUP BY eta
    ORDER BY eta
  LOOP
    v_event_date := GREATEST(v_event.eta, v_today);
    v_days := v_event_date - v_cursor_date;

    IF v_days > 0 THEN
      v_consume := p_daily_sales * v_days;

      -- cur == consume 时先扣完再补入 ETA 当天到货；只有严格不足才提前断货。
      IF v_current < v_consume THEN
        v_stockout := v_cursor_date
          + CEIL(GREATEST(v_current, 0) / p_daily_sales)::integer;
        EXIT;
      END IF;

      v_current := v_current - v_consume;
    END IF;

    v_current := v_current + v_event.total_remaining;
    v_cursor_date := v_event_date;
  END LOOP;

  IF v_stockout IS NULL THEN
    v_stockout := v_cursor_date
      + CEIL(GREATEST(v_current, 0) / p_daily_sales)::integer;
  END IF;

  est_stockout_date := v_stockout;

  WITH parsed AS (
    SELECT
      (item->>'eta')::date AS eta,
      (item->>'remaining')::integer AS remaining
    FROM jsonb_array_elements(v_inbound) AS item
    WHERE item ? 'eta'
      AND item ? 'remaining'
      AND item->>'eta' IS NOT NULL
      AND item->>'eta' <> ''
      AND item->>'remaining' IS NOT NULL
      AND item->>'remaining' <> ''
  ), grouped AS (
    SELECT eta, SUM(remaining)::integer AS total_remaining
    FROM parsed
    WHERE remaining > 0
    GROUP BY eta
  )
  SELECT COALESCE(
    SUM(total_remaining) FILTER (WHERE eta <= v_stockout),
    0
  )::integer
  INTO effective_inbound
  FROM grouped;

  RETURN NEXT;
END;
$$;


--
-- Name: get_assigned_warehouse_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_assigned_warehouse_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT warehouse_id
  FROM public.user_warehouses
  WHERE user_id = auth.uid();
$$;


--
-- Name: get_in_transit_confirmed_aggregate(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_in_transit_confirmed_aggregate(p_user_id uuid, p_warehouse_ids uuid[] DEFAULT NULL::uuid[]) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- ═══════════════════════════════════════════
  -- 身份绑定
  -- ═══════════════════════════════════════════
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询在途与已确认到仓聚合' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id != auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  -- ═══════════════════════════════════════════
  -- 合并在途 + 已确认到仓聚合
  -- 一次扫描 shipment + shipment_item，两个聚合。
  -- ═══════════════════════════════════════════
  WITH
  -- 符合条件的 shipment（仓库隔离 + 可选仓库列表过滤）
  eligible_shipment AS (
    SELECT s.id, s.warehouse_id, s.status, s.bigseller_absorbed_at
    FROM public.shipment s
    WHERE s.warehouse_id IS NOT NULL
      -- 仓库隔离：admin 全量，operator 已分配
      AND (
        public.get_user_role() = 'admin'
        OR s.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
      )
      -- 可选：限定仓库列表
      AND (p_warehouse_ids IS NULL OR s.warehouse_id = ANY(p_warehouse_ids))
  ),
  -- 在途聚合：status != 'warehoused'
  in_transit_agg AS (
    SELECT
      es.warehouse_id,
      si.variant_id,
      SUM(si.quantity - si.warehoused_quantity)::integer AS in_transit_quantity
    FROM eligible_shipment es
    JOIN public.shipment_item si ON si.shipment_id = es.id
    WHERE es.status != 'warehoused'
    GROUP BY es.warehouse_id, si.variant_id
  ),
  -- 已确认到仓聚合：customs OR (warehoused + not absorbed)
  confirmed_agg AS (
    SELECT
      es.warehouse_id,
      si.variant_id,
      SUM(si.warehoused_quantity)::integer AS confirmed_quantity
    FROM eligible_shipment es
    JOIN public.shipment_item si ON si.shipment_id = es.id
    WHERE es.status = 'customs'
       OR (es.status = 'warehoused' AND es.bigseller_absorbed_at IS NULL)
    GROUP BY es.warehouse_id, si.variant_id
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'warehouse_id',        COALESCE(ita.warehouse_id, ca.warehouse_id),
        'variant_id',          COALESCE(ita.variant_id, ca.variant_id),
        'in_transit_quantity', COALESCE(ita.in_transit_quantity, 0),
        'confirmed_quantity',  COALESCE(ca.confirmed_quantity, 0)
      )
      ORDER BY
        COALESCE(ita.warehouse_id, ca.warehouse_id),
        COALESCE(ita.variant_id, ca.variant_id)
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM in_transit_agg ita
  FULL OUTER JOIN confirmed_agg ca
    ON ca.warehouse_id = ita.warehouse_id
    AND ca.variant_id = ita.variant_id;

  RETURN v_result;
END;
$$;


--
-- Name: get_in_transit_detail(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_in_transit_detail(p_user_id uuid, p_warehouse_id uuid DEFAULT NULL::uuid, p_variant_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询在途明细' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'shipment_id', s.id,
        'variant_id', si.variant_id,
        'warehouse_id', s.warehouse_id,
        'status', s.status,
        'estimated_arrival', s.estimated_arrival,
        'remaining_quantity', (si.quantity - si.warehoused_quantity),
        'is_planned', (s.status = 'booking')
      )
      ORDER BY s.estimated_arrival, s.id, si.variant_id
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM public.shipment s
  JOIN public.shipment_item si ON si.shipment_id = s.id
  JOIN public.warehouse w ON w.id = s.warehouse_id
  WHERE s.warehouse_id IS NOT NULL
    AND w.type = 'overseas'
    AND w.is_active = true
    AND s.cancelled_at IS NULL
    AND s.bigseller_absorbed_at IS NULL
    AND s.status IN ('booking', 'loading', 'departed', 'arrived', 'customs')
    AND s.estimated_arrival IS NOT NULL
    AND (si.quantity - si.warehoused_quantity) > 0
    AND (p_warehouse_id IS NULL OR s.warehouse_id = p_warehouse_id)
    AND (p_variant_id IS NULL OR si.variant_id = p_variant_id)
    AND (
      public.get_user_role() = 'admin'
      OR s.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
    );

  RETURN v_result;
END;
$$;


--
-- Name: get_low_stock(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_low_stock(p_user_id uuid, p_limit integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- ═══════════════════════════════════════════
  -- 身份绑定
  -- ═══════════════════════════════════════════
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询低库存' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id != auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  -- ═══════════════════════════════════════════
  -- 参数防御
  -- ═══════════════════════════════════════════
  p_limit := COALESCE(p_limit, 50);

  IF p_limit < 1 THEN
    p_limit := 1;
  END IF;

  IF p_limit > 200 THEN
    p_limit := 200;
  END IF;

  -- ═══════════════════════════════════════════
  -- 主查询：低库存过滤 + gap 排序 + limit
  -- ═══════════════════════════════════════════
  WITH filtered AS (
    SELECT
      i.id,
      i.variant_id,
      i.warehouse_id,
      i.quantity,
      i.last_sync_at,
      v.sku,
      v.country,
      v.match_status,
      v.name   AS variant_name,        -- ★ 新增：BigSeller 原始品名
      p.name   AS product_name,
      p.code   AS product_code,
      COALESCE(p.safety_stock, 0) AS safety_stock,
      w.name   AS warehouse_name,
      w.type   AS warehouse_type,
      false    AS is_favorited,
      -- 缺口 = 安全库存 - 当前库存（正数表示缺货程度）
      COALESCE(p.safety_stock, 0) - i.quantity AS gap
    FROM public.inventory i
    INNER JOIN public.product_variant v ON v.id = i.variant_id
    LEFT JOIN  public.product p ON p.id = v.product_id
    INNER JOIN public.warehouse w ON w.id = i.warehouse_id
    -- 归档排除：当前用户已归档的 variant 不显示
    LEFT JOIN  public.user_variant_preference uvp_arch
      ON uvp_arch.variant_id = i.variant_id
      AND uvp_arch.user_id = p_user_id
      AND uvp_arch.preference_type = 'archived'
    WHERE uvp_arch.variant_id IS NULL
      -- 仓库隔离：admin 看全部，operator 仅已分配仓库
      AND (
        public.get_user_role() = 'admin'
        OR i.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
      )
      -- 低库存定义：已匹配 + 正库存 + quantity <= safety_stock
      AND v.match_status = 'matched'
      AND i.quantity > 0
      AND i.quantity <= COALESCE(p.safety_stock, 0)
  )
  SELECT jsonb_build_object(
    'data', COALESCE(
      (SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT * FROM filtered
        ORDER BY gap DESC, quantity ASC
        LIMIT p_limit
      ) t),
      '[]'::jsonb
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: get_overseas_inventory(uuid, text, uuid, text, text, boolean, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_overseas_inventory(p_user_id uuid, p_country text DEFAULT NULL::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_stock_status text DEFAULT NULL::text, p_favorited_only boolean DEFAULT false, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_offset  integer;
  v_result  jsonb;
BEGIN
  -- ═══════════════════════════════════════════
  -- 身份绑定
  -- ═══════════════════════════════════════════
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询海外库存' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id != auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  -- ═══════════════════════════════════════════
  -- 参数防御
  -- ═══════════════════════════════════════════
  p_page := COALESCE(p_page, 1);
  p_page_size := COALESCE(p_page_size, 20);
  p_favorited_only := COALESCE(p_favorited_only, false);

  IF p_page < 1 THEN
    p_page := 1;
  END IF;

  IF p_page_size < 1 THEN
    p_page_size := 20;
  ELSIF p_page_size > 100 THEN
    p_page_size := 100;
  END IF;

  IF p_search IS NOT NULL AND p_search = '' THEN
    p_search := NULL;
  END IF;

  IF p_stock_status IS NOT NULL
     AND p_stock_status NOT IN ('out_of_stock', 'low', 'normal', 'in_transit') THEN
    RAISE EXCEPTION '无效的库存状态筛选值: %', p_stock_status USING ERRCODE = 'P0001';
  END IF;

  v_offset := (p_page - 1) * p_page_size;

  -- ═══════════════════════════════════════════
  -- 主查询：海外库存 + 过滤 + 排序 + 分页
  -- ═══════════════════════════════════════════
  WITH filtered AS (
    SELECT
      i.id,
      i.variant_id,
      i.warehouse_id,
      i.quantity,
      i.last_sync_at,
      v.sku,
      v.country,
      v.match_status,
      v.name   AS variant_name,        -- BigSeller 原始品名
      p.name   AS product_name,         -- DIS 标准产品名（保持兼容）
      p.code   AS product_code,         -- DIS 标准产品编码（保持兼容）
      COALESCE(p.safety_stock, 0) AS safety_stock,
      w.name   AS warehouse_name,
      w.type   AS warehouse_type,
      -- 关注标记：当前用户是否已关注此 variant
      CASE WHEN uvp_fav.variant_id IS NOT NULL THEN true ELSE false END AS is_favorited
    FROM public.inventory i
    INNER JOIN public.product_variant v ON v.id = i.variant_id
    LEFT JOIN  public.product p ON p.id = v.product_id
    INNER JOIN public.warehouse w ON w.id = i.warehouse_id AND w.type = 'overseas'
    -- 归档排除：当前用户已归档的 variant 不显示
    LEFT JOIN  public.user_variant_preference uvp_arch
      ON uvp_arch.variant_id = i.variant_id
      AND uvp_arch.user_id = p_user_id
      AND uvp_arch.preference_type = 'archived'
    -- 关注标记 join
    LEFT JOIN  public.user_variant_preference uvp_fav
      ON uvp_fav.variant_id = i.variant_id
      AND uvp_fav.user_id = p_user_id
      AND uvp_fav.preference_type = 'favorited'
    -- 排除已归档
    WHERE uvp_arch.variant_id IS NULL
      -- 仓库隔离：admin 看全部，operator 仅已分配仓库
      AND (
        public.get_user_role() = 'admin'
        OR i.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
      )
      -- country 筛选
      AND (p_country IS NULL OR v.country = p_country)
      -- warehouse 筛选
      AND (p_warehouse_id IS NULL OR i.warehouse_id = p_warehouse_id)
      -- ── 搜索：连续子串 + 分词 AND 语义 ──
      AND (
        p_search IS NULL
        -- 连续子串匹配（快速路径）
        OR v.sku ILIKE '%' || p_search || '%'
        OR v.name ILIKE '%' || p_search || '%'
        OR p.name ILIKE '%' || p_search || '%'
        OR p.code ILIKE '%' || p_search || '%'
        -- 分词匹配：所有 token 都必须命中至少一个字段
        OR NOT EXISTS (
          SELECT 1
          FROM unnest(
            regexp_split_to_array(
              lower(trim(p_search)),
              '[\s\-_/()（）,，]+'
            )
          ) AS token
          WHERE token <> ''
            AND NOT (
              lower(COALESCE(v.sku, '')) LIKE '%' || token || '%'
              OR lower(COALESCE(v.name, '')) LIKE '%' || token || '%'
              OR lower(COALESCE(p.name, '')) LIKE '%' || token || '%'
              OR lower(COALESCE(p.code, '')) LIKE '%' || token || '%'
            )
        )
      )
      -- 库存状态筛选
      AND (
        p_stock_status IS NULL
        OR (p_stock_status = 'out_of_stock' AND i.quantity = 0)
        OR (p_stock_status = 'low'    AND v.match_status = 'matched' AND i.quantity > 0 AND i.quantity <= COALESCE(p.safety_stock, 0))
        OR (p_stock_status = 'normal' AND v.match_status = 'matched' AND i.quantity > COALESCE(p.safety_stock, 0))
        -- ★ 00037: in_transit — 当前 inventory 行对 id (variant_id, warehouse_id) 存在非 warehoused 在途
        -- 口径与 get_in_transit_confirmed_aggregate 一致：
        --   shipment.status != 'warehoused' AND shipment_item.quantity - warehoused_quantity > 0
        OR (p_stock_status = 'in_transit'
            AND EXISTS (
              SELECT 1
              FROM public.shipment s
              JOIN public.shipment_item si ON si.shipment_id = s.id
              WHERE si.variant_id = i.variant_id
                AND s.warehouse_id = i.warehouse_id
                AND s.status != 'warehoused'
                AND si.quantity - si.warehoused_quantity > 0
            ))
      )
      -- 仅关注
      AND (p_favorited_only = false OR uvp_fav.variant_id IS NOT NULL)
  )
  SELECT jsonb_build_object(
    'data', COALESCE(
      (SELECT jsonb_agg(row_to_json(t)) FROM (
        SELECT * FROM filtered
        ORDER BY
          is_favorited DESC,
          quantity ASC
        LIMIT p_page_size OFFSET v_offset
      ) t),
      '[]'::jsonb
    ),
    'total', (SELECT COUNT(*) FROM filtered)
  ) INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: get_overseas_stats(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_overseas_stats(p_user_id uuid, p_country text DEFAULT NULL::text, p_warehouse_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- ═══════════════════════════════════════════
  -- 身份绑定
  -- ═══════════════════════════════════════════
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询海外库存统计' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id != auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  -- ═══════════════════════════════════════════
  -- 聚合查询
  -- ═══════════════════════════════════════════
  WITH base AS (
    SELECT
      i.variant_id,
      i.quantity,
      i.last_sync_at,
      v.match_status,
      p.safety_stock
    FROM public.inventory i
    INNER JOIN public.product_variant v ON v.id = i.variant_id
    LEFT JOIN  public.product p ON p.id = v.product_id
    INNER JOIN public.warehouse w ON w.id = i.warehouse_id AND w.type = 'overseas'
    -- 归档排除
    LEFT JOIN  public.user_variant_preference uvp_arch
      ON uvp_arch.variant_id = i.variant_id
      AND uvp_arch.user_id = p_user_id
      AND uvp_arch.preference_type = 'archived'
    WHERE uvp_arch.variant_id IS NULL
      -- 仓库隔离
      AND (
        public.get_user_role() = 'admin'
        OR i.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
      )
      -- country 筛选
      AND (p_country IS NULL OR v.country = p_country)
      -- warehouse 筛选
      AND (p_warehouse_id IS NULL OR i.warehouse_id = p_warehouse_id)
  )
  SELECT jsonb_build_object(
    'total_skus',        (SELECT COUNT(DISTINCT variant_id) FROM base),
    'total_quantity',    COALESCE((SELECT SUM(quantity) FROM base), 0),
    'low_stock_count',   COALESCE(
      (SELECT COUNT(DISTINCT variant_id) FROM base
       WHERE quantity > 0
         AND match_status = 'matched'
         AND quantity <= COALESCE(safety_stock, 0)),
      0
    ),
    'last_sync_at',      (SELECT MAX(last_sync_at) FROM base)
  ) INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: get_product_overview(uuid, integer, integer, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_product_overview(p_user_id uuid, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20, p_search text DEFAULT NULL::text, p_stockout_urgency text DEFAULT NULL::text, p_country text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_role text;
  v_offset integer;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询全球库存总览' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.name
  INTO v_role
  FROM public.profiles profile
  JOIN public.role r ON r.id = profile.role_id
  WHERE profile.id = auth.uid()
    AND profile.is_active = true;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'operator') THEN
    RAISE EXCEPTION '账户已停用或无权查询全球库存总览' USING ERRCODE = 'P0001';
  END IF;

  IF p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION '页码必须大于等于 1' USING ERRCODE = 'P0001';
  END IF;

  IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 100 THEN
    RAISE EXCEPTION '每页条数必须在 1 到 100 之间' USING ERRCODE = 'P0001';
  END IF;

  p_search := NULLIF(TRIM(p_search), '');
  p_stockout_urgency := NULLIF(TRIM(p_stockout_urgency), '');
  p_country := NULLIF(UPPER(TRIM(p_country)), '');

  IF p_stockout_urgency IS NOT NULL
     AND p_stockout_urgency NOT IN ('critical', 'warning', 'ok', 'data_incomplete') THEN
    RAISE EXCEPTION '无效的断货风险筛选值' USING ERRCODE = 'P0001';
  END IF;

  IF p_country IS NOT NULL AND p_country NOT IN ('TH', 'ID', 'MY', 'PH', 'VN', 'CN') THEN
    RAISE EXCEPTION '无效的国家筛选值' USING ERRCODE = 'P0001';
  END IF;

  v_offset := (p_page - 1) * p_page_size;

  WITH visible_scope AS (
    SELECT w.id, w.name, w.country, w.lead_time_days
    FROM public.warehouse w
    WHERE w.type = 'overseas'
      AND w.is_active = true
      AND (
        v_role = 'admin'
        OR (
          v_role = 'operator'
          AND w.id IN (SELECT public.get_assigned_warehouse_ids())
        )
      )
  ), warehouse_rows AS (
    SELECT
      variant.id AS variant_id,
      variant.product_id,
      variant.sku,
      variant.country AS variant_country,
      variant.name AS variant_name,
      variant.match_status,
      product.name AS product_name,
      product.safety_stock,
      warehouse.id AS warehouse_id,
      warehouse.name AS warehouse_name,
      warehouse.country AS warehouse_country,
      inventory.quantity AS on_hand,
      inventory.daily_sales,
      inbound.display_events AS inbound,
      inbound.visible_inbound_quantity,
      inbound.eta_missing_quantity,
      forecast.est_stockout_date,
      forecast.effective_inbound,
      forecast.ds_incomplete,
      CASE
        WHEN inventory.quantity = 0 THEN 'out_of_stock'
        WHEN variant.product_id IS NULL OR variant.match_status <> 'matched' THEN 'unmatched'
        WHEN inventory.quantity <= product.safety_stock THEN 'low'
        ELSE 'normal'
      END AS base_stock_status
    FROM public.inventory inventory
    JOIN visible_scope warehouse ON warehouse.id = inventory.warehouse_id
    JOIN public.product_variant variant ON variant.id = inventory.variant_id
    LEFT JOIN public.product product ON product.id = variant.product_id
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          jsonb_agg(
            jsonb_build_object('eta', grouped.eta, 'qty', grouped.remaining)
            ORDER BY grouped.eta NULLS LAST
          ),
          '[]'::jsonb
        ) AS display_events,
        COALESCE(
          jsonb_agg(
            jsonb_build_object('eta', grouped.eta, 'remaining', grouped.remaining)
            ORDER BY grouped.eta NULLS LAST
          ),
          '[]'::jsonb
        ) AS forecast_events,
        COALESCE(SUM(grouped.remaining), 0)::integer AS visible_inbound_quantity,
        COALESCE(SUM(grouped.remaining) FILTER (WHERE grouped.eta IS NULL), 0)::integer
          AS eta_missing_quantity
      FROM (
        SELECT
          shipment.estimated_arrival AS eta,
          SUM(item.quantity - item.warehoused_quantity)::integer AS remaining
        FROM public.shipment shipment
        JOIN public.shipment_item item ON item.shipment_id = shipment.id
        WHERE shipment.warehouse_id = inventory.warehouse_id
          AND item.variant_id = inventory.variant_id
          AND shipment.cancelled_at IS NULL
          AND shipment.bigseller_absorbed_at IS NULL
          AND shipment.status IN ('booking', 'loading', 'departed', 'arrived', 'customs')
          AND (item.quantity - item.warehoused_quantity) > 0
        GROUP BY shipment.estimated_arrival
      ) grouped
    ) inbound ON true
    CROSS JOIN LATERAL public.forecast_stockout(
      inventory.quantity,
      inventory.daily_sales,
      warehouse.lead_time_days,
      inbound.forecast_events
    ) forecast
    WHERE p_country IS NULL OR warehouse.country = p_country
  ), row_aggregated AS (
    SELECT
      variant_id,
      product_id,
      sku,
      variant_country,
      product_name,
      variant_name,
      jsonb_agg(
        jsonb_build_object(
          'warehouse_id', warehouse_id,
          'warehouse_name', warehouse_name,
          'country', warehouse_country,
          'q', on_hand,
          'daily_sales', daily_sales,
          'inb', inbound,
          'base_stock_status', base_stock_status
        )
        ORDER BY warehouse_country, warehouse_name, warehouse_id
      ) AS per_warehouse,
      SUM(on_hand)::bigint AS visible_on_hand,
      SUM(visible_inbound_quantity)::bigint AS visible_inbound_quantity,
      SUM(effective_inbound)::bigint AS effective_inbound,
      SUM(eta_missing_quantity)::bigint AS eta_missing_quantity,
      (SUM(on_hand) + SUM(visible_inbound_quantity))::bigint AS visible_total_quantity,
      CASE
        WHEN BOOL_OR(base_stock_status = 'out_of_stock') THEN 'out_of_stock'
        WHEN BOOL_OR(base_stock_status = 'low') THEN 'low'
        WHEN BOOL_OR(base_stock_status = 'normal') THEN 'normal'
        ELSE 'unmatched'
      END AS base_stock_status,
      MIN(est_stockout_date) FILTER (WHERE ds_incomplete = false) AS earliest_stockout,
      (
        COUNT(*) FILTER (WHERE ds_incomplete = false) > 0
        AND COUNT(*) FILTER (WHERE ds_incomplete = true) > 0
      ) AS partial_data
    FROM warehouse_rows
    GROUP BY variant_id, product_id, sku, variant_country, product_name, variant_name
  ), row_labeled AS (
    SELECT
      row_aggregated.*,
      CASE
        WHEN earliest_stockout IS NULL THEN 'data_incomplete'
        WHEN earliest_stockout < CURRENT_DATE + 3 THEN 'critical'
        WHEN earliest_stockout <= CURRENT_DATE + 7 THEN 'warning'
        ELSE 'ok'
      END AS stockout_urgency,
      'data_unavailable'::text AS domestic_status
    FROM row_aggregated
  ), base_cohort AS (
    SELECT *
    FROM row_labeled
    WHERE p_search IS NULL
      OR sku ILIKE '%' || p_search || '%'
      OR variant_name ILIKE '%' || p_search || '%'
      OR COALESCE(product_name, '') ILIKE '%' || p_search || '%'
  ), queue_counts AS (
    SELECT jsonb_build_object(
      'critical', COUNT(*) FILTER (WHERE stockout_urgency = 'critical'),
      'warning', COUNT(*) FILTER (WHERE stockout_urgency = 'warning'),
      'ok', COUNT(*) FILTER (WHERE stockout_urgency = 'ok'),
      'data_incomplete', COUNT(*) FILTER (WHERE stockout_urgency = 'data_incomplete')
    ) AS value
    FROM base_cohort
  ), filtered_cohort AS (
    SELECT *
    FROM base_cohort
    WHERE p_stockout_urgency IS NULL OR stockout_urgency = p_stockout_urgency
  ), total_count AS (
    SELECT COUNT(*) AS value FROM filtered_cohort
  ), items AS (
    SELECT *
    FROM filtered_cohort
    ORDER BY
      CASE stockout_urgency
        WHEN 'critical' THEN 1
        WHEN 'warning' THEN 2
        WHEN 'ok' THEN 3
        ELSE 4
      END,
      earliest_stockout NULLS LAST,
      variant_id
    LIMIT p_page_size OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'items', COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(items))
        FROM items
      ),
      '[]'::jsonb
    ),
    'total_count', (SELECT value FROM total_count),
    'queue_counts', (SELECT value FROM queue_counts)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: get_replenishment_suggestions(uuid, uuid, uuid, text, text, text, boolean, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_replenishment_suggestions(p_user_id uuid, p_variant_id uuid DEFAULT NULL::uuid, p_warehouse_id uuid DEFAULT NULL::uuid, p_country text DEFAULT NULL::text, p_urgency text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_include_zero boolean DEFAULT false, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_offset integer;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询补货建议' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  p_page := GREATEST(COALESCE(p_page, 1), 1);
  p_page_size := LEAST(GREATEST(COALESCE(p_page_size, 20), 1), 100);
  p_include_zero := COALESCE(p_include_zero, false);
  p_country := NULLIF(UPPER(TRIM(p_country)), '');
  p_urgency := NULLIF(TRIM(p_urgency), '');
  p_search := NULLIF(TRIM(p_search), '');

  IF p_country IS NOT NULL AND p_country NOT IN ('TH', 'ID', 'MY', 'PH', 'VN', 'CN') THEN
    RAISE EXCEPTION '无效的国家筛选值: %', p_country USING ERRCODE = 'P0001';
  END IF;

  IF p_urgency IS NOT NULL
     AND p_urgency NOT IN ('critical', 'warning', 'ok', 'data_incomplete') THEN
    RAISE EXCEPTION '无效的紧急度筛选值: %', p_urgency USING ERRCODE = 'P0001';
  END IF;

  v_offset := (p_page - 1) * p_page_size;

  WITH visible_inventory AS (
    SELECT
      i.variant_id,
      i.warehouse_id,
      i.quantity AS on_hand,
      i.daily_sales AS avg_daily_sales,
      v.sku,
      v.name AS variant_name,
      v.country,
      p.name AS product_name,
      p.code AS product_code,
      w.name AS warehouse_name,
      w.lead_time_days AS lead_time,
      w.buffer_ratio,
      w.target_cover_multiplier AS cover_mult
    FROM public.inventory i
    JOIN public.product_variant v ON v.id = i.variant_id
    LEFT JOIN public.product p ON p.id = v.product_id
    JOIN public.warehouse w
      ON w.id = i.warehouse_id
      AND w.type = 'overseas'
      AND w.is_active = true
    LEFT JOIN public.user_variant_preference uvp_arch
      ON uvp_arch.user_id = p_user_id
      AND uvp_arch.variant_id = i.variant_id
      AND uvp_arch.preference_type = 'archived'
    WHERE uvp_arch.variant_id IS NULL
      AND (
        public.get_user_role() = 'admin'
        OR i.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
      )
      AND (p_variant_id IS NULL OR i.variant_id = p_variant_id)
      AND (p_warehouse_id IS NULL OR i.warehouse_id = p_warehouse_id)
      AND (p_country IS NULL OR v.country = p_country)
      AND (
        p_search IS NULL
        OR v.sku ILIKE '%' || p_search || '%'
        OR v.name ILIKE '%' || p_search || '%'
        OR COALESCE(p.name, '') ILIKE '%' || p_search || '%'
        OR COALESCE(p.code, '') ILIKE '%' || p_search || '%'
        OR NOT EXISTS (
          SELECT 1
          FROM unnest(
            regexp_split_to_array(lower(p_search), '[\s\-_/()（）,，]+')
          ) AS token
          WHERE token <> ''
            AND NOT (
              lower(COALESCE(v.sku, '')) LIKE '%' || token || '%'
              OR lower(COALESCE(v.name, '')) LIKE '%' || token || '%'
              OR lower(COALESCE(p.name, '')) LIKE '%' || token || '%'
              OR lower(COALESCE(p.code, '')) LIKE '%' || token || '%'
            )
        )
      )
  ), forecasted AS (
    SELECT
      vi.*,
      forecast.est_stockout_date,
      forecast.effective_inbound,
      CASE
        WHEN vi.avg_daily_sales IS NULL OR vi.avg_daily_sales <= 0
          OR vi.lead_time IS NULL OR vi.lead_time <= 0
          THEN NULL
        ELSE ROUND(vi.avg_daily_sales * vi.lead_time * vi.buffer_ratio)::integer
      END AS safety_stock,
      CASE
        WHEN vi.avg_daily_sales IS NULL OR vi.avg_daily_sales <= 0
          OR vi.lead_time IS NULL OR vi.lead_time <= 0
          THEN NULL
        ELSE ROUND(vi.avg_daily_sales * vi.lead_time * vi.cover_mult)::integer
      END AS target_stock
    FROM visible_inventory vi
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object('eta', grouped.eta, 'remaining', grouped.remaining)
          ORDER BY grouped.eta
        ),
        '[]'::jsonb
      ) AS events
      FROM (
        SELECT
          s.estimated_arrival AS eta,
          SUM(si.quantity - si.warehoused_quantity)::integer AS remaining
        FROM public.shipment s
        JOIN public.shipment_item si ON si.shipment_id = s.id
        WHERE s.warehouse_id = vi.warehouse_id
          AND si.variant_id = vi.variant_id
          AND s.cancelled_at IS NULL
          AND s.bigseller_absorbed_at IS NULL
          AND s.status IN ('booking', 'loading', 'departed', 'arrived', 'customs')
          AND s.estimated_arrival IS NOT NULL
          AND (si.quantity - si.warehoused_quantity) > 0
        GROUP BY s.estimated_arrival
      ) grouped
    ) inbound ON true
    CROSS JOIN LATERAL public.forecast_stockout(
      vi.on_hand,
      vi.avg_daily_sales,
      vi.lead_time,
      inbound.events
    ) forecast
  ), calculated AS (
    SELECT
      f.*,
      CASE
        WHEN f.target_stock IS NULL THEN 0
        ELSE GREATEST(0, f.target_stock - (f.on_hand + f.effective_inbound))
      END::integer AS net_demand,
      CASE
        WHEN f.avg_daily_sales IS NULL OR f.avg_daily_sales <= 0
          OR f.lead_time IS NULL OR f.lead_time <= 0
          THEN NULL
        ELSE f.est_stockout_date - f.lead_time
      END AS latest_order_date
    FROM forecasted f
  ), labeled AS (
    SELECT
      c.*,
      c.net_demand AS suggest_qty,
      CASE
        WHEN c.avg_daily_sales IS NULL OR c.avg_daily_sales <= 0
          OR c.lead_time IS NULL OR c.lead_time <= 0
          THEN 'data_incomplete'
        WHEN c.latest_order_date <= CURRENT_DATE THEN 'critical'
        WHEN c.latest_order_date <= CURRENT_DATE + 3 THEN 'warning'
        ELSE 'ok'
      END AS urgency
    FROM calculated c
  ), filtered AS (
    SELECT *
    FROM labeled
    WHERE (p_include_zero OR net_demand > 0)
      AND (p_urgency IS NULL OR urgency = p_urgency)
  )
  SELECT jsonb_build_object(
    'data', COALESCE(
      (
        SELECT jsonb_agg(row_to_json(page_rows))
        FROM (
          SELECT
            variant_id,
            warehouse_id,
            sku,
            product_name,
            product_code,
            variant_name,
            country,
            warehouse_name,
            avg_daily_sales,
            lead_time,
            buffer_ratio,
            cover_mult,
            safety_stock,
            on_hand,
            effective_inbound,
            target_stock,
            net_demand,
            suggest_qty,
            est_stockout_date,
            latest_order_date,
            urgency
          FROM filtered
          ORDER BY
            CASE urgency
              WHEN 'critical' THEN 1
              WHEN 'warning' THEN 2
              WHEN 'ok' THEN 3
              ELSE 4
            END,
            net_demand DESC,
            sku,
            warehouse_name
          LIMIT p_page_size OFFSET v_offset
        ) page_rows
      ),
      '[]'::jsonb
    ),
    'total', (SELECT COUNT(*) FROM filtered)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: get_sync_run_detail(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_sync_run_detail(p_run_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_role   text;
  v_result jsonb;
  v_wh_id  uuid;
BEGIN
  -- 认证检查
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;

  v_role := public.get_user_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION '无权限' USING ERRCODE = 'P0001';
  END IF;

  -- admin 返回 display_name + warehouse_name + 完整业务字段
  IF v_role = 'admin' THEN
    SELECT jsonb_build_object(
      'id',                     sr.id,
      'warehouse_id',           sr.warehouse_id,
      'warehouse_name',         w.name,
      'mode',                   sr.mode,
      'status',                 sr.status,
      'display_name',           p.display_name,
      'triggered_from',         sr.triggered_from,
      'started_at',             sr.started_at,
      'finished_at',            sr.finished_at,
      'created_at',             sr.created_at,
      'exit_code',              sr.exit_code,
      'error_message',          sr.error_message,
      'result_summary',         sr.result_summary,
      'plan_drift_check',       sr.plan_drift_check,
      'plan_drift_count',       sr.plan_drift_count,
      'plan_drift_differences', sr.plan_drift_differences,
      'dry_run_run_id',         sr.dry_run_run_id
    ) INTO v_result
    FROM public.sync_run sr
    LEFT JOIN public.profiles p ON sr.triggered_by = p.id
    LEFT JOIN public.warehouse w ON sr.warehouse_id = w.id
    WHERE sr.id = p_run_id;

  ELSE
    -- operator: 脱敏版本 + assigned warehouse 过滤（P5-SY13A）
    -- 先读取该 run 的 warehouse_id，校验是否在已分配仓库中
    SELECT sr.warehouse_id INTO v_wh_id
    FROM public.sync_run sr
    WHERE sr.id = p_run_id;

    -- 不存在或未分配 → 返回 null（权限拒绝）
    IF v_wh_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.get_assigned_warehouse_ids() awid WHERE awid = v_wh_id
    ) THEN
      RETURN 'null'::jsonb;
    END IF;

    -- 脱敏版本（不含 plan_drift_differences）
    SELECT jsonb_build_object(
      'id',                    sr.id,
      'warehouse_id',          sr.warehouse_id,
      'warehouse_name',        w.name,
      'mode',                  sr.mode,
      'status',                sr.status,
      'triggered_by_email',    CASE
                                 WHEN u.email IS NULL THEN NULL
                                 ELSE regexp_replace(u.email, '^(.{1}).*(@.*)$', '\1***\2')
                               END,
      'triggered_from',        sr.triggered_from,
      'started_at',            sr.started_at,
      'finished_at',           sr.finished_at,
      'created_at',            sr.created_at,
      'plan_drift_check',      sr.plan_drift_check,
      'plan_drift_count',      sr.plan_drift_count,
      'result_summary',        CASE
                                 WHEN sr.result_summary IS NULL THEN NULL
                                 ELSE jsonb_build_object(
                                   'variantsCreated',  sr.result_summary->'variantsCreated',
                                   'inventoryUpdated', sr.result_summary->'inventoryUpdated'
                                 )
                               END,
      'failure_summary',       CASE
                                 WHEN sr.status = 'failed' THEN
                                   CASE
                                     WHEN sr.exit_code = 1 THEN '同步失败（业务错误）'
                                     WHEN sr.exit_code = 2 THEN '同步失败（系统清理）'
                                     ELSE '同步失败'
                                   END
                                 ELSE NULL
                               END
    ) INTO v_result
    FROM public.sync_run sr
    LEFT JOIN auth.users u ON sr.triggered_by = u.id
    LEFT JOIN public.warehouse w ON sr.warehouse_id = w.id
    WHERE sr.id = p_run_id;
  END IF;

  -- 不存在返回 null
  IF v_result IS NULL THEN
    RETURN 'null'::jsonb;
  END IF;

  RETURN v_result;
END;
$_$;


--
-- Name: get_sync_runs(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_sync_runs(p_warehouse_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_role   text;
  v_result jsonb;
BEGIN
  -- 认证检查
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;

  v_role := public.get_user_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION '无权限' USING ERRCODE = 'P0001';
  END IF;

  -- p_limit 显式拒绝 NULL / <1 / >100（不再静默钳制）
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit 必须在 [1, 100] 范围内，收到: %', p_limit
      USING ERRCODE = 'P0001';
  END IF;

  -- admin 返回 display_name + warehouse_name + 完整业务字段
  IF v_role = 'admin' THEN
    WITH limited AS (
      SELECT sr.id, sr.warehouse_id, sr.mode, sr.status,
             sr.triggered_from,
             sr.started_at, sr.finished_at, sr.created_at,
             sr.exit_code, sr.error_message,
             sr.result_summary,
             sr.plan_drift_check, sr.plan_drift_count,
             sr.dry_run_run_id,
             p.display_name,
             w.name AS warehouse_name
      FROM public.sync_run sr
      LEFT JOIN public.profiles p ON sr.triggered_by = p.id
      LEFT JOIN public.warehouse w ON sr.warehouse_id = w.id
      WHERE (p_warehouse_id IS NULL OR sr.warehouse_id = p_warehouse_id)
      ORDER BY sr.started_at DESC
      LIMIT p_limit
    )
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',                    limited.id,
        'warehouse_id',          limited.warehouse_id,
        'warehouse_name',        limited.warehouse_name,
        'mode',                  limited.mode,
        'status',                limited.status,
        'display_name',          limited.display_name,
        'triggered_from',        limited.triggered_from,
        'started_at',            limited.started_at,
        'finished_at',           limited.finished_at,
        'created_at',            limited.created_at,
        'exit_code',             limited.exit_code,
        'error_message',         limited.error_message,
        'result_summary',        limited.result_summary,
        'plan_drift_check',      limited.plan_drift_check,
        'plan_drift_count',      limited.plan_drift_count,
        'dry_run_run_id',        limited.dry_run_run_id
      )
      ORDER BY limited.started_at DESC
    ), '[]'::jsonb) INTO v_result
    FROM limited;

  ELSE
    -- operator: 脱敏版本 + assigned warehouse 过滤（P5-SY13A）
    --   禁止: exit_code, error_message, artifact hashes, dry_run_run_id,
    --     lease_expires_at, heartbeat_at, triggered_by UUID
    --   返回: 脱敏邮箱(auth.users.email), warehouse_name,
    --     controlled result_summary (仅 variantsCreated + inventoryUpdated),
    --     Chinese 失败摘要(代替原始error_message)
    --   仅返回已分配仓库的运行记录
    WITH limited AS (
      SELECT sr.id, sr.warehouse_id, sr.mode, sr.status,
             sr.triggered_from,
             sr.started_at, sr.finished_at, sr.created_at,
             sr.exit_code,
             sr.result_summary,
             sr.plan_drift_check, sr.plan_drift_count,
             u.email,
             w.name AS warehouse_name
      FROM public.sync_run sr
      LEFT JOIN auth.users u ON sr.triggered_by = u.id
      LEFT JOIN public.warehouse w ON sr.warehouse_id = w.id
      WHERE (p_warehouse_id IS NULL OR sr.warehouse_id = p_warehouse_id)
        -- P5-SY13A: operator 仅看到已分配仓库的运行
        AND sr.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
      ORDER BY sr.started_at DESC
      LIMIT p_limit
    )
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',                    limited.id,
        'warehouse_id',          limited.warehouse_id,
        'warehouse_name',        limited.warehouse_name,
        'mode',                  limited.mode,
        'status',                limited.status,
        'triggered_by_email',    CASE
                                   WHEN limited.email IS NULL THEN NULL
                                   ELSE regexp_replace(limited.email, '^(.{1}).*(@.*)$', '\1***\2')
                                 END,
        'triggered_from',        limited.triggered_from,
        'started_at',            limited.started_at,
        'finished_at',           limited.finished_at,
        'created_at',            limited.created_at,
        'plan_drift_check',      limited.plan_drift_check,
        'plan_drift_count',      limited.plan_drift_count,
        'result_summary',        CASE
                                   WHEN limited.result_summary IS NULL THEN NULL
                                   ELSE jsonb_build_object(
                                     'variantsCreated',  limited.result_summary->'variantsCreated',
                                     'inventoryUpdated', limited.result_summary->'inventoryUpdated'
                                   )
                                 END,
        'failure_summary',       CASE
                                   WHEN limited.status = 'failed' THEN
                                     CASE
                                       WHEN limited.exit_code = 1 THEN '同步失败（业务错误）'
                                       WHEN limited.exit_code = 2 THEN '同步失败（系统清理）'
                                       ELSE '同步失败'
                                     END
                                   ELSE NULL
                                 END
      )
      ORDER BY limited.started_at DESC
    ), '[]'::jsonb) INTO v_result
    FROM limited;
  END IF;

  RETURN v_result;
END;
$_$;


--
-- Name: get_sync_runs_paginated(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_sync_runs_paginated(p_warehouse_id uuid DEFAULT NULL::uuid, p_page integer DEFAULT 1, p_page_size integer DEFAULT 20) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_role     text;
  v_total    bigint;
  v_offset   bigint;
  v_result   jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;

  v_role := public.get_user_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION '无权限' USING ERRCODE = 'P0001';
  END IF;

  IF p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'p_page 必须 >= 1，收到: %', p_page USING ERRCODE = 'P0001';
  END IF;

  IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 100 THEN
    RAISE EXCEPTION 'p_page_size 必须在 [1, 100] 范围内，收到: %', p_page_size
      USING ERRCODE = 'P0001';
  END IF;

  v_offset := (p_page - 1) * p_page_size;

  IF v_role = 'admin' THEN
    SELECT count(*)
    INTO v_total
    FROM public.sync_run sr
    WHERE (p_warehouse_id IS NULL OR sr.warehouse_id = p_warehouse_id);

    WITH limited AS (
      SELECT sr.id, sr.warehouse_id, sr.mode, sr.status,
             sr.triggered_from,
             sr.started_at, sr.finished_at, sr.created_at,
             sr.exit_code, sr.error_message,
             sr.result_summary,
             sr.plan_drift_check, sr.plan_drift_count,
             sr.dry_run_run_id,
             p.display_name,
             w.name AS warehouse_name
      FROM public.sync_run sr
      LEFT JOIN public.profiles p ON sr.triggered_by = p.id
      LEFT JOIN public.warehouse w ON sr.warehouse_id = w.id
      WHERE (p_warehouse_id IS NULL OR sr.warehouse_id = p_warehouse_id)
      ORDER BY sr.started_at DESC
      OFFSET v_offset
      LIMIT p_page_size
    )
    SELECT jsonb_build_object(
      'rows', COALESCE(jsonb_agg(
        jsonb_build_object(
          'id',                    limited.id,
          'warehouse_id',          limited.warehouse_id,
          'warehouse_name',        limited.warehouse_name,
          'mode',                  limited.mode,
          'status',                limited.status,
          'display_name',          limited.display_name,
          'triggered_from',        limited.triggered_from,
          'started_at',            limited.started_at,
          'finished_at',           limited.finished_at,
          'created_at',            limited.created_at,
          'exit_code',             limited.exit_code,
          'error_message',         limited.error_message,
          'result_summary',        limited.result_summary,
          'plan_drift_check',      limited.plan_drift_check,
          'plan_drift_count',      limited.plan_drift_count,
          'dry_run_run_id',        limited.dry_run_run_id
        )
        ORDER BY limited.started_at DESC
      ), '[]'::jsonb),
      'total',    v_total,
      'page',     p_page,
      'pageSize', p_page_size
    ) INTO v_result
    FROM limited;

  ELSE
    -- Operator: 脱敏版本 + assigned warehouse 过滤（P5-SY13A）
    SELECT count(*)
    INTO v_total
    FROM public.sync_run sr
    WHERE (p_warehouse_id IS NULL OR sr.warehouse_id = p_warehouse_id)
      AND sr.warehouse_id IN (SELECT public.get_assigned_warehouse_ids());

    WITH limited AS (
      SELECT sr.id, sr.warehouse_id, sr.mode, sr.status,
             sr.triggered_from,
             sr.started_at, sr.finished_at, sr.created_at,
             sr.exit_code,
             sr.result_summary,
             sr.plan_drift_check, sr.plan_drift_count,
             u.email,
             w.name AS warehouse_name
      FROM public.sync_run sr
      LEFT JOIN auth.users u ON sr.triggered_by = u.id
      LEFT JOIN public.warehouse w ON sr.warehouse_id = w.id
      WHERE (p_warehouse_id IS NULL OR sr.warehouse_id = p_warehouse_id)
        AND sr.warehouse_id IN (SELECT public.get_assigned_warehouse_ids())
      ORDER BY sr.started_at DESC
      OFFSET v_offset
      LIMIT p_page_size
    )
    SELECT jsonb_build_object(
      'rows', COALESCE(jsonb_agg(
        jsonb_build_object(
          'id',                    limited.id,
          'warehouse_id',          limited.warehouse_id,
          'warehouse_name',        limited.warehouse_name,
          'mode',                  limited.mode,
          'status',                limited.status,
          'triggered_by_email',    CASE
                                     WHEN limited.email IS NULL THEN NULL
                                     ELSE regexp_replace(limited.email, '^(.{1}).*(@.*)$', '\1***\2')
                                   END,
          'triggered_from',        limited.triggered_from,
          'started_at',            limited.started_at,
          'finished_at',           limited.finished_at,
          'created_at',            limited.created_at,
          'plan_drift_check',      limited.plan_drift_check,
          'plan_drift_count',      limited.plan_drift_count,
          'result_summary',        CASE
                                     WHEN limited.result_summary IS NULL THEN NULL
                                     ELSE jsonb_build_object(
                                       'variantsCreated',  limited.result_summary->'variantsCreated',
                                       'inventoryUpdated', limited.result_summary->'inventoryUpdated'
                                     )
                                   END,
          'failure_summary',       CASE
                                     WHEN limited.status = 'failed' THEN
                                       CASE
                                         WHEN limited.exit_code = 1 THEN '同步失败（业务错误）'
                                         WHEN limited.exit_code = 2 THEN '同步失败（系统清理）'
                                         ELSE '同步失败'
                                       END
                                     ELSE NULL
                                   END
        )
        ORDER BY limited.started_at DESC
      ), '[]'::jsonb),
      'total',    v_total,
      'page',     p_page,
      'pageSize', p_page_size
    ) INTO v_result
    FROM limited;
  END IF;

  RETURN v_result;
END;
$_$;


--
-- Name: get_sync_warehouse_overview(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_sync_warehouse_overview() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_role text;
  v_result jsonb;
BEGIN
  -- ═══════════════════════════════════════════
  -- 身份绑定
  -- ═══════════════════════════════════════════
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录' USING ERRCODE = 'P0001';
  END IF;

  v_role := public.get_user_role();
  IF v_role IS NULL THEN
    RAISE EXCEPTION '无权限' USING ERRCODE = 'P0001';
  END IF;

  -- ═══════════════════════════════════════════
  -- Admin 分支：全部海外活跃仓
  -- ═══════════════════════════════════════════
  IF v_role = 'admin' THEN
    SELECT jsonb_agg(wh_data ORDER BY wh_data->>'country')
    INTO v_result
    FROM (
      SELECT jsonb_build_object(
        'warehouse_id', w.id,
        'warehouse_name', w.name,
        'country', w.country,
        'latest_dry_run', (
          SELECT jsonb_build_object(
            'status', sr.status,
            'run_id', sr.id,
            'time', sr.started_at
          )
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.mode = 'dry_run'
          ORDER BY sr.started_at DESC
          LIMIT 1
        ),
        'latest_real_write', (
          SELECT jsonb_build_object(
            'status', sr.status,
            'run_id', sr.id,
            'time', sr.started_at
          )
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.mode = 'real_write'
          ORDER BY sr.started_at DESC
          LIMIT 1
        ),
        'last_success_time', (
          SELECT sr.finished_at
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.status = 'completed'
          ORDER BY sr.finished_at DESC
          LIMIT 1
        ),
        'last_failure_reason', (
          SELECT sr.error_message
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.status = 'failed'
          ORDER BY sr.started_at DESC
          LIMIT 1
        )
      ) AS wh_data
      FROM public.warehouse w
      WHERE w.type = 'overseas' AND w.is_active = true
    ) sub;

  -- ═══════════════════════════════════════════
  -- Operator 分支：仅已分配仓库
  -- ═══════════════════════════════════════════
  ELSE
    SELECT jsonb_agg(wh_data ORDER BY wh_data->>'country')
    INTO v_result
    FROM (
      SELECT jsonb_build_object(
        'warehouse_id', w.id,
        'warehouse_name', w.name,
        'country', w.country,
        'latest_dry_run', (
          SELECT jsonb_build_object(
            'status', sr.status,
            'run_id', sr.id,
            'time', sr.started_at
          )
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.mode = 'dry_run'
          ORDER BY sr.started_at DESC
          LIMIT 1
        ),
        'latest_real_write', (
          SELECT jsonb_build_object(
            'status', sr.status,
            'run_id', sr.id,
            'time', sr.started_at
          )
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.mode = 'real_write'
          ORDER BY sr.started_at DESC
          LIMIT 1
        ),
        'last_success_time', (
          SELECT sr.finished_at
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.status = 'completed'
          ORDER BY sr.finished_at DESC
          LIMIT 1
        ),
        'last_failure_reason', (
          SELECT substring(sr.error_message, 1, 100)
          FROM public.sync_run sr
          WHERE sr.warehouse_id = w.id AND sr.status = 'failed'
          ORDER BY sr.started_at DESC
          LIMIT 1
        )
      ) AS wh_data
      FROM public.warehouse w
      INNER JOIN public.user_warehouses uw
        ON uw.warehouse_id = w.id AND uw.user_id = auth.uid()
      WHERE w.type = 'overseas' AND w.is_active = true
    ) sub;
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;


--
-- Name: get_user_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT r.name
  FROM public.profiles p
  JOIN public.role r ON r.id = p.role_id
  WHERE p.id = auth.uid()
    AND p.is_active = true;
$$;


--
-- Name: get_war_room_variant_detail(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_war_room_variant_detail(p_user_id uuid, p_variant_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_role text;
  v_warehouse_id uuid;
  v_visible_count integer := 0;
  v_p1_result jsonb;
  v_p1_row jsonb;
  v_p1_by_warehouse jsonb := '{}'::jsonb;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询产品详情' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  IF p_variant_id IS NULL THEN
    RAISE EXCEPTION '产品 SKU 参数无效' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.name
  INTO v_role
  FROM public.profiles profile
  JOIN public.role r ON r.id = profile.role_id
  WHERE profile.id = auth.uid()
    AND profile.is_active = true;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'operator') THEN
    RAISE EXCEPTION '账户已停用或无权查询产品详情' USING ERRCODE = 'P0001';
  END IF;

  FOR v_warehouse_id IN
    SELECT inventory.warehouse_id
    FROM public.inventory inventory
    JOIN public.warehouse warehouse ON warehouse.id = inventory.warehouse_id
    WHERE inventory.variant_id = p_variant_id
      AND warehouse.type = 'overseas'
      AND warehouse.is_active = true
      AND (
        v_role = 'admin'
        OR (
          v_role = 'operator'
          AND warehouse.id IN (SELECT public.get_assigned_warehouse_ids())
        )
      )
    ORDER BY inventory.warehouse_id
  LOOP
    v_visible_count := v_visible_count + 1;

    SELECT public.get_replenishment_suggestions(
      p_user_id := p_user_id,
      p_variant_id := p_variant_id,
      p_warehouse_id := v_warehouse_id,
      p_country := NULL,
      p_urgency := NULL,
      p_search := NULL,
      p_include_zero := true,
      p_page := 1,
      p_page_size := 1
    )
    INTO v_p1_result;

    IF jsonb_typeof(v_p1_result -> 'data') <> 'array'
       OR jsonb_array_length(v_p1_result -> 'data') <> 1 THEN
      RAISE EXCEPTION '补货建议数据契约异常' USING ERRCODE = 'P0001';
    END IF;

    v_p1_row := v_p1_result -> 'data' -> 0;
    IF v_p1_row ->> 'warehouse_id' <> v_warehouse_id::text
       OR v_p1_row ->> 'variant_id' <> p_variant_id::text THEN
      RAISE EXCEPTION '补货建议仓库映射异常' USING ERRCODE = 'P0001';
    END IF;

    v_p1_by_warehouse := v_p1_by_warehouse
      || jsonb_build_object(v_warehouse_id::text, v_p1_row);
  END LOOP;

  IF v_visible_count = 0 THEN
    RAISE EXCEPTION '无权访问该产品或产品数据不存在' USING ERRCODE = 'P0001';
  END IF;

  WITH visible_scope AS (
    SELECT w.id, w.name, w.country, w.lead_time_days
    FROM public.warehouse w
    WHERE w.type = 'overseas'
      AND w.is_active = true
      AND (
        v_role = 'admin'
        OR (
          v_role = 'operator'
          AND w.id IN (SELECT public.get_assigned_warehouse_ids())
        )
      )
  ), warehouse_rows AS (
    SELECT
      variant.id AS variant_id,
      variant.product_id,
      variant.sku,
      variant.country AS variant_country,
      variant.name AS variant_name,
      variant.match_status,
      product.name AS product_name,
      product.safety_stock AS product_safety_stock,
      warehouse.id AS warehouse_id,
      warehouse.name AS warehouse_name,
      warehouse.country AS warehouse_country,
      inventory.quantity AS on_hand,
      inventory.daily_sales,
      inbound.events AS inbound,
      inbound.visible_inbound_quantity,
      inbound.eta_missing_quantity,
      forecast.est_stockout_date,
      forecast.effective_inbound,
      forecast.ds_incomplete,
      CASE
        WHEN inventory.quantity = 0 THEN 'out_of_stock'
        WHEN variant.product_id IS NULL OR variant.match_status <> 'matched' THEN 'unmatched'
        WHEN inventory.quantity <= product.safety_stock THEN 'low'
        ELSE 'normal'
      END AS base_stock_status,
      v_p1_by_warehouse -> warehouse.id::text AS replenishment
    FROM public.inventory inventory
    JOIN visible_scope warehouse ON warehouse.id = inventory.warehouse_id
    JOIN public.product_variant variant ON variant.id = inventory.variant_id
    LEFT JOIN public.product product ON product.id = variant.product_id
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          jsonb_agg(
            jsonb_build_object('eta', grouped.eta, 'remaining', grouped.remaining)
            ORDER BY grouped.eta NULLS LAST
          ),
          '[]'::jsonb
        ) AS events,
        COALESCE(SUM(grouped.remaining), 0)::integer AS visible_inbound_quantity,
        COALESCE(SUM(grouped.remaining) FILTER (WHERE grouped.eta IS NULL), 0)::integer
          AS eta_missing_quantity
      FROM (
        SELECT
          shipment.estimated_arrival AS eta,
          SUM(item.quantity - item.warehoused_quantity)::integer AS remaining
        FROM public.shipment shipment
        JOIN public.shipment_item item ON item.shipment_id = shipment.id
        WHERE shipment.warehouse_id = inventory.warehouse_id
          AND item.variant_id = inventory.variant_id
          AND shipment.cancelled_at IS NULL
          AND shipment.bigseller_absorbed_at IS NULL
          AND shipment.status IN ('booking', 'loading', 'departed', 'arrived', 'customs')
          AND (item.quantity - item.warehoused_quantity) > 0
        GROUP BY shipment.estimated_arrival
      ) grouped
    ) inbound ON true
    CROSS JOIN LATERAL public.forecast_stockout(
      inventory.quantity,
      inventory.daily_sales,
      warehouse.lead_time_days,
      inbound.events
    ) forecast
    WHERE inventory.variant_id = p_variant_id
  ), row_aggregated AS (
    SELECT
      variant_id,
      product_id,
      sku,
      variant_country,
      product_name,
      variant_name,
      SUM(on_hand)::bigint AS visible_on_hand,
      SUM(visible_inbound_quantity)::bigint AS visible_inbound_quantity,
      SUM(effective_inbound)::bigint AS effective_inbound,
      SUM(eta_missing_quantity)::bigint AS eta_missing_quantity,
      (SUM(on_hand) + SUM(visible_inbound_quantity))::bigint AS visible_total_quantity,
      MIN(est_stockout_date) FILTER (WHERE ds_incomplete = false) AS earliest_stockout,
      (
        COUNT(*) FILTER (WHERE ds_incomplete = false) > 0
        AND COUNT(*) FILTER (WHERE ds_incomplete = true) > 0
      ) AS partial_data,
      jsonb_agg(
        jsonb_build_object(
          'warehouse_id', warehouse_id,
          'warehouse_name', warehouse_name,
          'country', warehouse_country,
          'on_hand', on_hand,
          'daily_sales', daily_sales,
          'inbound', inbound,
          'visible_inbound_quantity', visible_inbound_quantity,
          'eta_missing_quantity', eta_missing_quantity,
          'est_stockout_date', replenishment ->> 'est_stockout_date',
          'effective_inbound', COALESCE((replenishment ->> 'effective_inbound')::integer, 0),
          'base_stock_status', base_stock_status,
          'safety_stock', (replenishment ->> 'safety_stock')::integer,
          'target_stock', (replenishment ->> 'target_stock')::integer,
          'net_demand', COALESCE((replenishment ->> 'net_demand')::integer, 0),
          'suggest_qty', COALESCE((replenishment ->> 'suggest_qty')::integer, 0),
          'latest_order_date', replenishment ->> 'latest_order_date',
          'replenishment_urgency', replenishment ->> 'urgency'
        )
        ORDER BY warehouse_country, warehouse_name, warehouse_id
      ) AS assigned_warehouse_detail
    FROM warehouse_rows
    GROUP BY variant_id, product_id, sku, variant_country, product_name, variant_name
  ), country_agg AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'country', country_rows.warehouse_country,
        'on_hand', country_rows.on_hand,
        'daily_sales', country_rows.daily_sales,
        'visible_inbound_quantity', country_rows.visible_inbound_quantity,
        'eta_missing_quantity', country_rows.eta_missing_quantity,
        'earliest_stockout', country_rows.earliest_stockout
      )
      ORDER BY country_rows.warehouse_country
    ) AS value
    FROM (
      SELECT
        warehouse_country,
        SUM(on_hand)::bigint AS on_hand,
        CASE
          WHEN COUNT(*) FILTER (WHERE daily_sales IS NOT NULL AND daily_sales > 0) = 0
            THEN NULL
          ELSE SUM(daily_sales) FILTER (WHERE daily_sales IS NOT NULL AND daily_sales > 0)
        END AS daily_sales,
        SUM(visible_inbound_quantity)::bigint AS visible_inbound_quantity,
        SUM(eta_missing_quantity)::bigint AS eta_missing_quantity,
        MIN(est_stockout_date) FILTER (WHERE ds_incomplete = false) AS earliest_stockout
      FROM warehouse_rows
      GROUP BY warehouse_country
    ) country_rows
  )
  SELECT jsonb_build_object(
    'variant_id', aggregated.variant_id,
    'product_id', aggregated.product_id,
    'sku', aggregated.sku,
    'variant_country', aggregated.variant_country,
    'product_name', aggregated.product_name,
    'variant_name', aggregated.variant_name,
    'visible_on_hand', aggregated.visible_on_hand,
    'visible_inbound_quantity', aggregated.visible_inbound_quantity,
    'effective_inbound', aggregated.effective_inbound,
    'eta_missing_quantity', aggregated.eta_missing_quantity,
    'visible_total_quantity', aggregated.visible_total_quantity,
    'earliest_stockout', aggregated.earliest_stockout,
    'stockout_urgency', CASE
      WHEN aggregated.earliest_stockout IS NULL THEN 'data_incomplete'
      WHEN aggregated.earliest_stockout < CURRENT_DATE + 3 THEN 'critical'
      WHEN aggregated.earliest_stockout <= CURRENT_DATE + 7 THEN 'warning'
      ELSE 'ok'
    END,
    'partial_data', aggregated.partial_data,
    'domestic_status', 'data_unavailable',
    'assigned_warehouse_detail', aggregated.assigned_warehouse_detail,
    'country_agg', COALESCE((SELECT value FROM country_agg), '[]'::jsonb)
  )
  INTO v_result
  FROM row_aggregated aggregated;

  IF v_result IS NULL THEN
    RAISE EXCEPTION '无权访问该产品或产品数据不存在' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_result;
END;
$$;


--
-- Name: get_warehouse_health_overview(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_warehouse_health_overview(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
DECLARE
  v_role text;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，无法查询库存健康度' USING ERRCODE = 'P0001';
  END IF;

  IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN
    RAISE EXCEPTION '用户身份不匹配' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.name
  INTO v_role
  FROM public.profiles profile
  JOIN public.role r ON r.id = profile.role_id
  WHERE profile.id = auth.uid()
    AND profile.is_active = true;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'operator') THEN
    RAISE EXCEPTION '账户已停用或无权查询库存健康度' USING ERRCODE = 'P0001';
  END IF;

  WITH visible_scope AS (
    SELECT
      warehouse.id,
      warehouse.name,
      warehouse.country,
      warehouse.lead_time_days
    FROM public.warehouse warehouse
    WHERE warehouse.type = 'overseas'
      AND warehouse.is_active = true
      AND (
        v_role = 'admin'
        OR (
          v_role = 'operator'
          AND warehouse.id IN (SELECT public.get_assigned_warehouse_ids())
        )
      )
  ), inventory_positions AS (
    SELECT
      inventory.variant_id,
      inventory.warehouse_id,
      inventory.quantity,
      warehouse.name AS warehouse_name,
      warehouse.country,
      warehouse.lead_time_days,
      CASE
        WHEN inventory.quantity = 0 THEN 'out_of_stock'
        WHEN variant.product_id IS NULL OR variant.match_status <> 'matched' THEN 'unmatched'
        WHEN inventory.quantity <= product.safety_stock THEN 'low'
        ELSE 'normal'
      END AS health_status
    FROM public.inventory inventory
    JOIN visible_scope warehouse ON warehouse.id = inventory.warehouse_id
    JOIN public.product_variant variant ON variant.id = inventory.variant_id
    LEFT JOIN public.product product ON product.id = variant.product_id
    LEFT JOIN public.user_variant_preference uvp_arch
      ON uvp_arch.user_id = p_user_id
      AND uvp_arch.variant_id = inventory.variant_id
      AND uvp_arch.preference_type = 'archived'
    WHERE uvp_arch.variant_id IS NULL
  ), warehouse_rollup AS (
    SELECT
      warehouse_id,
      warehouse_name,
      country,
      lead_time_days,
      COUNT(*)::bigint AS total_position_count,
      COUNT(*) FILTER (WHERE health_status = 'normal')::bigint AS normal_count,
      COUNT(*) FILTER (WHERE health_status = 'low')::bigint AS low_stock_count,
      COUNT(*) FILTER (WHERE health_status = 'out_of_stock')::bigint AS out_of_stock_count,
      COUNT(*) FILTER (WHERE health_status = 'unmatched')::bigint AS unmatched_count
    FROM inventory_positions
    GROUP BY warehouse_id, warehouse_name, country, lead_time_days
  ), warehouse_labeled AS (
    SELECT
      warehouse_rollup.*,
      CASE
        WHEN normal_count + low_stock_count + out_of_stock_count = 0 THEN NULL
        ELSE ROUND(
          normal_count * 100.0 / (normal_count + low_stock_count + out_of_stock_count),
          1
        )
      END AS health_rate
    FROM warehouse_rollup
  ), summary AS (
    SELECT jsonb_build_object(
      'distinct_variant_count', COUNT(DISTINCT variant_id),
      'total_position_count', COUNT(*),
      'normal_count', COUNT(*) FILTER (WHERE health_status = 'normal'),
      'low_stock_count', COUNT(*) FILTER (WHERE health_status = 'low'),
      'out_of_stock_count', COUNT(*) FILTER (WHERE health_status = 'out_of_stock'),
      'unmatched_count', COUNT(*) FILTER (WHERE health_status = 'unmatched'),
      'health_rate', CASE
        WHEN COUNT(*) FILTER (
          WHERE health_status IN ('normal', 'low', 'out_of_stock')
        ) = 0 THEN NULL
        ELSE ROUND(
          COUNT(*) FILTER (WHERE health_status = 'normal') * 100.0
            / COUNT(*) FILTER (
              WHERE health_status IN ('normal', 'low', 'out_of_stock')
            ),
          1
        )
      END,
      'total_quantity', COALESCE(SUM(quantity), 0)
    ) AS value
    FROM inventory_positions
  ), warehouses AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'warehouse_id', warehouse_id,
          'warehouse_name', warehouse_name,
          'country', country,
          'total_position_count', total_position_count,
          'normal_count', normal_count,
          'low_stock_count', low_stock_count,
          'out_of_stock_count', out_of_stock_count,
          'unmatched_count', unmatched_count,
          'health_rate', health_rate,
          'lead_time_days', lead_time_days
        )
        ORDER BY
          (health_rate IS NULL),
          health_rate ASC,
          out_of_stock_count DESC,
          low_stock_count DESC,
          warehouse_name ASC
      ),
      '[]'::jsonb
    ) AS value
    FROM warehouse_labeled
  )
  SELECT jsonb_build_object(
    'summary', (SELECT value FROM summary),
    'warehouses', (SELECT value FROM warehouses)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  operator_role_id uuid;
BEGIN
  SELECT id INTO operator_role_id
  FROM public.role
  WHERE name = 'operator';

  INSERT INTO public.profiles (id, display_name, role_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(NEW.email, '@', 1)),
    operator_role_id
  );
  RETURN NEW;
END;
$$;


--
-- Name: heartbeat_sync_run(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.heartbeat_sync_run(p_run_id uuid, p_lease_duration integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_count integer;
  v_now   timestamptz;
BEGIN
  -- 参数校验
  IF p_lease_duration IS NULL OR p_lease_duration < 30 OR p_lease_duration > 900 THEN
    RAISE EXCEPTION 'lease_duration 必须在 [30, 900] 范围内，收到: %', p_lease_duration
      USING ERRCODE = 'P0001';
  END IF;

  -- 单次 clock_timestamp() 用于 heartbeat_at 和 lease_expires_at
  v_now := clock_timestamp();

  UPDATE public.sync_run
  SET lease_expires_at = v_now + (p_lease_duration || ' seconds')::interval,
      heartbeat_at     = v_now
  WHERE id = p_run_id
    AND status = 'in_progress';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'heartbeat 失败: sync_run 不存在或已非 in_progress 状态 (id=%)',
      p_run_id USING ERRCODE = 'P0001';
  END IF;
END;
$$;


--
-- Name: import_golucky_refs(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.import_golucky_refs(p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_caller_id       uuid;
  v_caller_role     text;
  v_caller_is_active boolean;
  v_item            jsonb;
  v_waybill_no      text;
  v_external_order_no text;
  v_country          text;
  v_warehouse_id    uuid;
  v_succeeded       integer := 0;
  v_duplicated      integer := 0;
  v_failed          jsonb := '[]'::jsonb;
  v_idx             integer;
  v_item_count      integer;
  v_seen_waybills   text[] := '{}'::text[];
  v_existing_count  integer;
  v_new_id          uuid;
  v_validation_errors jsonb := '[]'::jsonb;
BEGIN
  -- ── 身份校验 ──────────────────────────────────────────
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION '未登录，请先登录后再操作'
      USING HINT = 'AUTH_REQUIRED';
  END IF;

  SELECT p.is_active INTO v_caller_is_active
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION '账号已被禁用，无法执行操作'
      USING HINT = 'ACCOUNT_DISABLED';
  END IF;

  v_caller_role := public.get_user_role();

  -- ── 参数格式预检 ───────────────────────────────────────
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION '参数格式错误：p_items 必须为数组';
  END IF;

  v_item_count := jsonb_array_length(p_items);
  IF v_item_count = 0 THEN
    RETURN jsonb_build_object(
      'succeeded', 0,
      'duplicated', 0,
      'failed', '[]'::jsonb
    );
  END IF;

  -- ── 逐项预校验（在写入前完成全量校验） ───────────────────
  FOR v_idx IN 0 .. v_item_count - 1 LOOP
    v_item := p_items -> v_idx;

    -- 字段存在性校验
    IF v_item->>'waybill_no' IS NULL OR trim(v_item->>'waybill_no') = '' THEN
      v_validation_errors := v_validation_errors || jsonb_build_object(
        'index', v_idx,
        'waybill_no', v_item->>'waybill_no',
        'error', '运单号不能为空'
      );
      CONTINUE;
    END IF;

    IF v_item->>'warehouse_id' IS NULL THEN
      v_validation_errors := v_validation_errors || jsonb_build_object(
        'index', v_idx,
        'waybill_no', v_item->>'waybill_no',
        'error', '仓库 ID 不能为空'
      );
      CONTINUE;
    END IF;

    IF v_item->>'country' IS NULL OR trim(v_item->>'country') = '' THEN
      v_validation_errors := v_validation_errors || jsonb_build_object(
        'index', v_idx,
        'waybill_no', v_item->>'waybill_no',
        'error', '国家代码不能为空'
      );
      CONTINUE;
    END IF;

    -- UUID 格式校验
    BEGIN
      v_warehouse_id := (v_item->>'warehouse_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_validation_errors := v_validation_errors || jsonb_build_object(
        'index', v_idx,
        'waybill_no', v_item->>'waybill_no',
        'error', '仓库 ID 格式无效'
      );
      CONTINUE;
    END;

    -- 国家枚举校验
    IF NOT (v_item->>'country' IN ('TH', 'ID', 'MY', 'PH', 'VN', 'CN')) THEN
      v_validation_errors := v_validation_errors || jsonb_build_object(
        'index', v_idx,
        'waybill_no', v_item->>'waybill_no',
        'error', '无效的国家代码：' || (v_item->>'country')
      );
      CONTINUE;
    END IF;

    -- Operator 仓库授权校验
    IF v_caller_role = 'operator' THEN
      IF v_warehouse_id NOT IN (SELECT public.get_assigned_warehouse_ids()) THEN
        v_validation_errors := v_validation_errors || jsonb_build_object(
          'index', v_idx,
          'waybill_no', v_item->>'waybill_no',
          'error', '无权操作此仓库'
        );
        CONTINUE;
      END IF;
    END IF;
  END LOOP;

  -- 有格式/授权错误 → 整批回滚
  IF jsonb_array_length(v_validation_errors) > 0 THEN
    RETURN jsonb_build_object(
      'succeeded', 0,
      'duplicated', 0,
      'failed', v_validation_errors
    );
  END IF;

  -- ── 同批去重 + 写入 ───────────────────────────────────
  FOR v_idx IN 0 .. v_item_count - 1 LOOP
    v_item := p_items -> v_idx;
    v_waybill_no := trim(v_item->>'waybill_no');
    v_external_order_no := NULLIF(trim(v_item->>'external_order_no'), '');
    v_country := v_item->>'country';
    v_warehouse_id := (v_item->>'warehouse_id')::uuid;

    -- 同批内重复
    IF v_waybill_no = ANY(v_seen_waybills) THEN
      v_duplicated := v_duplicated + 1;
      CONTINUE;
    END IF;
    v_seen_waybills := array_append(v_seen_waybills, v_waybill_no);

    -- 写入（ON CONFLICT 处理库内重复）
    SELECT COUNT(*) INTO v_existing_count
    FROM public.shipment_external_ref
    WHERE provider = 'golucky'
      AND waybill_no = v_waybill_no;

    IF v_existing_count > 0 THEN
      -- 已存在：更新 raw_payload，重置异常状态
      UPDATE public.shipment_external_ref
      SET raw_payload = COALESCE(v_item->'raw_payload', '{}'::jsonb),
          sync_status = CASE
            WHEN sync_status IN ('error', 'stale') THEN 'active'
            ELSE sync_status
          END,
          updated_at = now()
      WHERE provider = 'golucky'
        AND waybill_no = v_waybill_no;

      v_duplicated := v_duplicated + 1;
    ELSE
      INSERT INTO public.shipment_external_ref (
        provider,
        external_order_no,
        waybill_no,
        country,
        warehouse_id,
        raw_payload,
        sync_status
      ) VALUES (
        'golucky',
        v_external_order_no,
        v_waybill_no,
        v_country,
        v_warehouse_id,
        COALESCE(v_item->'raw_payload', '{}'::jsonb),
        'active'
      )
      RETURNING id INTO v_new_id;

      v_succeeded := v_succeeded + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'succeeded', v_succeeded,
    'duplicated', v_duplicated,
    'failed', '[]'::jsonb
  );
END;
$$;


--
-- Name: partial_warehouse_shipment(uuid, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.partial_warehouse_shipment(p_shipment_id uuid, p_items jsonb, p_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
DECLARE
  v_role            text;
  v_shipment        record;
  v_item            record;
  v_request         record;
  v_remaining       integer;
  v_requested_qty   integer;
  v_items_updated   integer := 0;
  v_has_remaining   boolean;
  v_all_warehoused  boolean;
BEGIN
  -- ============================================
  -- 权限校验：仅已启用的 admin 可调用
  -- ============================================
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role != 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 1. 校验 p_items 类型与非空
  --    jsonb_typeof 预检，避免 PostgreSQL 原生 cast 泄漏英文错误
  -- ============================================
  IF p_items IS NULL OR jsonb_typeof(p_items) != 'array' THEN
    RAISE EXCEPTION '入仓明细格式错误：需要 JSON 数组' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '入仓明细不能为空' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 2. SELECT shipment FOR UPDATE — 排他锁定目标行
  -- ============================================
  SELECT id, warehouse_id, status
  INTO v_shipment
  FROM public.shipment
  WHERE id = p_shipment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '在途记录不存在或无权访问' USING ERRCODE = 'P0001';
  END IF;

  -- 禁止重复入仓
  IF v_shipment.status = 'warehoused' THEN
    RAISE EXCEPTION '该在途记录已完成入仓，不可重复操作' USING ERRCODE = 'P0001';
  END IF;

  -- 必须有仓库
  IF v_shipment.warehouse_id IS NULL THEN
    RAISE EXCEPTION '该在途记录未指定仓库，无法入仓' USING ERRCODE = 'P0001';
  END IF;

  -- 仅 customs 允许入仓
  IF v_shipment.status != 'customs' THEN
    RAISE EXCEPTION '当前状态为 %，仅清关后可确认入仓', v_shipment.status
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 3. 遍历 p_items JSONB 数组，逐行处理
  --    jsonb_typeof 预检 elem → 正则预检 variant_id / quantity → 安全 cast
  -- ============================================
  FOR v_request IN
    SELECT
      elem->>'variant_id' AS raw_variant_id,
      elem->>'quantity'   AS raw_quantity,
      elem                AS elem_json
    FROM jsonb_array_elements(p_items) AS elem
  LOOP
    -- 3a. 校验 elem 是 JSON 对象
    IF jsonb_typeof(v_request.elem_json) != 'object' THEN
      RAISE EXCEPTION '入仓明细每项必须是 JSON 对象' USING ERRCODE = 'P0001';
    END IF;

    -- 3b. 校验 variant_id 存在
    IF v_request.raw_variant_id IS NULL OR v_request.raw_variant_id = '' THEN
      RAISE EXCEPTION '入仓明细缺少 variant_id' USING ERRCODE = 'P0001';
    END IF;

    -- 3c. 校验 variant_id 是合法 UUID（正则预检，避免 PG cast 英文错误泄漏）
    IF v_request.raw_variant_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION '入仓明细 variant_id 格式无效: %', v_request.raw_variant_id
        USING ERRCODE = 'P0001';
    END IF;

    -- 3d. 校验 quantity 存在
    IF v_request.raw_quantity IS NULL OR v_request.raw_quantity = '' THEN
      RAISE EXCEPTION '入仓明细缺少 quantity，variant_id: %', v_request.raw_variant_id
        USING ERRCODE = 'P0001';
    END IF;

    -- 3e. 校验 quantity 是正整数（正则预检，避免 PG cast 英文错误泄漏）
    IF v_request.raw_quantity !~ '^[1-9]\d*$' THEN
      RAISE EXCEPTION '入仓明细 quantity 必须是正整数，当前值: %，variant_id: %',
        v_request.raw_quantity, v_request.raw_variant_id
        USING ERRCODE = 'P0001';
    END IF;

    -- 安全 cast（已通过上述预检）
    v_requested_qty := v_request.raw_quantity::integer;

    -- 3f. FOR UPDATE 锁定 shipment_item 行
    SELECT id, variant_id, quantity, warehoused_quantity
    INTO v_item
    FROM public.shipment_item
    WHERE shipment_id = p_shipment_id
      AND variant_id = v_request.raw_variant_id::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION '在途记录中未找到 variant_id: %', v_request.raw_variant_id
        USING ERRCODE = 'P0001';
    END IF;

    -- 3g. 超量保护
    v_remaining := v_item.quantity - v_item.warehoused_quantity;
    IF v_remaining < 0 THEN
      RAISE EXCEPTION '数据异常：产品明细 % 已入仓数量超过总数', v_item.id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_requested_qty > v_remaining THEN
      RAISE EXCEPTION '入仓数量 (%) 超过在途余量 (%)，variant_id: %',
        v_requested_qty, v_remaining, v_request.raw_variant_id
        USING ERRCODE = 'P0001';
    END IF;

    -- 3h. 更新 warehoused_quantity（原子累加）
    UPDATE public.shipment_item
    SET warehoused_quantity = warehoused_quantity + v_requested_qty
    WHERE id = v_item.id;

    v_items_updated := v_items_updated + 1;
  END LOOP;

  -- ============================================
  -- 4. 检查是否全部入仓
  -- ============================================
  SELECT EXISTS(
    SELECT 1 FROM public.shipment_item
    WHERE shipment_id = p_shipment_id
      AND warehoused_quantity < quantity
  ) INTO v_has_remaining;

  v_all_warehoused := NOT v_has_remaining;

  -- ============================================
  -- 5. 全部入仓时更新 shipment.status
  -- ============================================
  IF v_all_warehoused THEN
    UPDATE public.shipment
    SET status = 'warehoused'
    WHERE id = p_shipment_id;
  END IF;

  -- ============================================
  -- 6. 插入 tracking_event
  -- ============================================
  INSERT INTO public.tracking_event (
    shipment_id, status, description, occurred_at, created_by
  ) VALUES (
    p_shipment_id,
    CASE WHEN v_all_warehoused THEN 'warehoused' ELSE 'partial_warehoused' END,
    COALESCE(p_description,
      CASE WHEN v_all_warehoused THEN '确认入仓' ELSE '部分确认入仓' END),
    now(),
    auth.uid()
  );

  -- ============================================
  -- 7. 返回结果 JSONB
  -- ============================================
  RETURN jsonb_build_object(
    'success', true,
    'all_warehoused', v_all_warehoused,
    'items_updated', v_items_updated
  );
END;
$_$;


--
-- Name: reactivate_external_ref(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reactivate_external_ref(p_ref_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_caller_id         uuid;
  v_caller_role       text;
  v_caller_is_active  boolean;
  v_warehouse_id      uuid;
BEGIN
  -- ── 身份校验 ──────────────────────────────────────────
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION '未登录，请先登录后再操作'
      USING HINT = 'AUTH_REQUIRED';
  END IF;

  SELECT p.is_active INTO v_caller_is_active
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION '账号已被禁用，无法执行操作'
      USING HINT = 'ACCOUNT_DISABLED';
  END IF;

  v_caller_role := public.get_user_role();

  -- ── 存在性 + 仓库权限 ──────────────────────────────────
  SELECT warehouse_id INTO v_warehouse_id
  FROM public.shipment_external_ref
  WHERE id = p_ref_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '外部物流记录不存在'
      USING HINT = 'NOT_FOUND';
  END IF;

  IF v_caller_role = 'operator' THEN
    IF v_warehouse_id NOT IN (SELECT public.get_assigned_warehouse_ids()) THEN
      RAISE EXCEPTION '无权操作该外部物流记录'
        USING HINT = 'FORBIDDEN_WAREHOUSE';
    END IF;
  END IF;

  -- ── 重激活：sync_status error/stale → active ─────────────
  UPDATE public.shipment_external_ref
  SET sync_status = 'active',
      updated_at = now()
  WHERE id = p_ref_id
    AND sync_status IN ('error', 'stale');

  IF NOT FOUND THEN
    RAISE EXCEPTION '仅可重激活状态为 error 或 stale 的记录'
      USING HINT = 'INVALID_STATUS';
  END IF;
END;
$$;


--
-- Name: release_sync_run(uuid, text, integer, text, jsonb, text, integer, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_sync_run(p_run_id uuid, p_status text, p_exit_code integer, p_error_message text DEFAULT NULL::text, p_result_summary jsonb DEFAULT NULL::jsonb, p_plan_drift_check text DEFAULT NULL::text, p_plan_drift_count integer DEFAULT NULL::integer, p_plan_drift_differences jsonb DEFAULT NULL::jsonb, p_plan_artifact_hash text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_pre_wh_id     uuid;
  v_post_wh_id    uuid;
  v_mode          text;
  v_cur_status    text;
  v_lock_exists   boolean;
  v_now           timestamptz;
BEGIN
  -- ============================================
  -- Step 1: 读取 warehouse_id → v_pre_wh_id（用于 advisory lock key）
  -- ============================================
  SELECT warehouse_id
  INTO v_pre_wh_id
  FROM public.sync_run
  WHERE id = p_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_run 不存在: %', p_run_id USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- Step 2: pg_advisory_xact_lock（使用 v_pre_wh_id）
  -- ============================================
  PERFORM pg_advisory_xact_lock(hashtext('sync_run:' || v_pre_wh_id));

  -- ============================================
  -- Step 3: SELECT FOR UPDATE on sync_warehouse_lock + 行存在校验
  -- ============================================
  SELECT EXISTS (
    SELECT 1 FROM public.sync_warehouse_lock
    WHERE warehouse_id = v_pre_wh_id
    FOR UPDATE
  ) INTO v_lock_exists;

  IF NOT v_lock_exists THEN
    RAISE EXCEPTION 'sync_warehouse_lock 行不存在: %', v_pre_wh_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- Step 4: SELECT sync_run FOR UPDATE + 重新校验
  -- 禁止覆盖已进入终态（completed/failed）的运行
  -- 重新读取 warehouse_id → v_post_wh_id
  -- ============================================
  SELECT warehouse_id, mode, status
  INTO v_post_wh_id, v_mode, v_cur_status
  FROM public.sync_run
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync_run 在锁定后消失: %', p_run_id USING ERRCODE = 'P0001';
  END IF;

  -- 严格比较锁前/锁后 warehouse_id
  IF v_pre_wh_id IS DISTINCT FROM v_post_wh_id THEN
    RAISE EXCEPTION 'warehouse_id 在锁前/锁后不一致: 锁前=%, 锁后=%', v_pre_wh_id, v_post_wh_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_cur_status != 'in_progress' THEN
    RAISE EXCEPTION '只能从 in_progress 状态释放，当前已进入终态: %', v_cur_status
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- Step 4.5: 全部锁后单次获取临界区时间（V5.4.3 第四次聚焦返工）
  -- 同一 v_now 用于 completed 和 failed 的 finished_at
  -- ============================================
  v_now := clock_timestamp();

  -- ============================================
  -- Step 5: 按状态更新
  -- ============================================
  IF p_status = 'completed' THEN
    -- completed 全部必需字段校验
    IF p_plan_drift_check IS NULL OR p_plan_drift_check NOT IN ('PASS', 'DRIFT_DETECTED') THEN
      RAISE EXCEPTION 'completed 必须提供有效的 plan_drift_check (PASS 或 DRIFT_DETECTED)，收到: %',
        p_plan_drift_check USING ERRCODE = 'P0001';
    END IF;

    IF p_plan_drift_count IS NULL OR p_plan_drift_count < 0 THEN
      RAISE EXCEPTION 'completed 必须提供非负 plan_drift_count，收到: %',
        p_plan_drift_count USING ERRCODE = 'P0001';
    END IF;

    IF p_plan_drift_differences IS NULL THEN
      RAISE EXCEPTION 'completed 必须提供 plan_drift_differences' USING ERRCODE = 'P0001';
    END IF;

    IF jsonb_typeof(p_plan_drift_differences) != 'array' THEN
      RAISE EXCEPTION 'plan_drift_differences 必须是 JSON 数组' USING ERRCODE = 'P0001';
    END IF;

    IF jsonb_array_length(p_plan_drift_differences) != p_plan_drift_count THEN
      RAISE EXCEPTION 'plan_drift_differences 数组长度 (%) 不等于 plan_drift_count (%)',
        jsonb_array_length(p_plan_drift_differences), p_plan_drift_count
        USING ERRCODE = 'P0001';
    END IF;

    IF p_exit_code IS NULL OR p_exit_code != 0 THEN
      RAISE EXCEPTION 'completed 必须 exit_code=0，收到: %', p_exit_code
        USING ERRCODE = 'P0001';
    END IF;

    IF p_result_summary IS NULL THEN
      RAISE EXCEPTION 'completed 必须提供 result_summary' USING ERRCODE = 'P0001';
    END IF;

    -- Dry Run completed 强制 plan_artifact_hash
    IF v_mode = 'dry_run' AND p_plan_artifact_hash IS NULL THEN
      RAISE EXCEPTION 'Dry Run completed 必须提供 plan_artifact_hash'
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.sync_run
    SET status                = 'completed',
        exit_code             = 0,
        finished_at           = v_now,
        result_summary        = p_result_summary,
        plan_drift_check      = p_plan_drift_check,
        plan_drift_count      = p_plan_drift_count,
        plan_drift_differences = p_plan_drift_differences,
        plan_artifact_hash    = COALESCE(p_plan_artifact_hash, plan_artifact_hash),
        locked_by             = NULL,
        lease_expires_at      = NULL,
        heartbeat_at          = NULL
    WHERE id = p_run_id;

  ELSIF p_status = 'failed' THEN
    -- failed 必需字段校验
    IF p_error_message IS NULL THEN
      RAISE EXCEPTION 'failed 必须提供 error_message' USING ERRCODE = 'P0001';
    END IF;

    IF p_exit_code IS NULL OR p_exit_code NOT IN (1, 2) THEN
      RAISE EXCEPTION 'failed exit_code 必须为 1 或 2，收到: %', p_exit_code
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.sync_run
    SET status          = 'failed',
        exit_code       = p_exit_code,
        error_message   = p_error_message,
        result_summary  = p_result_summary,
        finished_at     = v_now,
        locked_by       = NULL,
        lease_expires_at = NULL,
        heartbeat_at    = NULL
    WHERE id = p_run_id;

  ELSE
    RAISE EXCEPTION '无效的状态: %（仅允许 completed 或 failed）', p_status
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- Step 6: 清除锁（仅当 locked_by = p_run_id，使用 v_post_wh_id）
  -- ============================================
  UPDATE public.sync_warehouse_lock
  SET locked_by = NULL, locked_at = NULL
  WHERE warehouse_id = v_post_wh_id
    AND locked_by = p_run_id;
END;
$$;


--
-- Name: release_token_lease(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_token_lease(p_provider text, p_lease_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.provider_token_cache
  SET lease_owner = NULL,
      lease_until = NULL,
      updated_at  = now()
  WHERE provider = p_provider
    AND lease_owner = p_lease_id;
END;
$$;


--
-- Name: store_token_with_lease(text, text, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.store_token_with_lease(p_provider text, p_access_token text, p_expires_at timestamp with time zone, p_lease_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.provider_token_cache
  SET access_token = p_access_token,
      expires_at   = p_expires_at,
      lease_owner  = NULL,
      lease_until  = NULL,
      updated_at   = now()
  WHERE provider = p_provider
    AND lease_owner = p_lease_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Token 写回失败：租约所有权校验不通过（provider=%，lease_id=%）',
      p_provider, p_lease_id
      USING HINT = 'LEASE_OWNERSHIP_LOST';
  END IF;
END;
$$;


--
-- Name: sync_warehouse_inventory(uuid, jsonb, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_warehouse_inventory(p_warehouse_id uuid, p_variants jsonb, p_inventory jsonb, p_warehouse_name text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_wh_country        text;
  v_wh_type           text;
  v_wh_is_active      boolean;
  v_wh_name           text;
  v_dup_keys          jsonb;
  v_variant_count     int;
  v_inv_input_count   int;
  v_item              jsonb;
  v_sku               text;
  v_country           text;
  v_variant_id        uuid;
  v_created           int := 0;
  v_received          int := 0;
  v_inserted          int := 0;
  v_updated           int := 0;
  v_unchanged         int := 0;
  v_current_qty       int;
  v_expected_qty      int;
  v_actual_qty        int;
  v_sync_at           timestamptz;
  v_actual_sync_at    timestamptz;
  v_item_sync_at      timestamptz;
  -- 动态告警字段
  v_daily_sales       numeric;
  v_estimated_days    numeric;
  -- Warehouse 写后核对变量
  v_wh_id_ck          uuid;
  v_wh_country_ck     text;
  v_wh_type_ck        text;
  v_wh_active_ck      boolean;
  v_wh_name_ck        text;
BEGIN
  -- ============================================
  -- 1. 锁定目标 Warehouse 行（串行化同仓并发同步）
  -- ============================================
  SELECT country, type, is_active, name
  INTO v_wh_country, v_wh_type, v_wh_is_active, v_wh_name
  FROM public.warehouse
  WHERE id = p_warehouse_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse 不存在: %', p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 2. 校验 Warehouse 属性
  -- ============================================
  IF v_wh_type != 'overseas' THEN
    RAISE EXCEPTION 'Warehouse 类型错误: 期望 overseas, 实际 % (id=%)',
      v_wh_type, p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_wh_is_active THEN
    RAISE EXCEPTION 'Warehouse 已停用: %', p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 当前名称必须非空（阻止意外写入未初始化仓库）
  IF v_wh_name IS NULL OR v_wh_name = '' THEN
    RAISE EXCEPTION 'Warehouse 名称不能为空: %', p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  -- p_warehouse_name 必须非空
  IF p_warehouse_name IS NULL OR p_warehouse_name = '' THEN
    RAISE EXCEPTION 'p_warehouse_name 不能为空' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 3. 输入类型校验
  -- ============================================
  IF p_variants IS NULL OR jsonb_typeof(p_variants) != 'array' THEN
    RAISE EXCEPTION 'p_variants 必须为 JSON 数组' USING ERRCODE = 'P0001';
  END IF;

  IF p_inventory IS NULL OR jsonb_typeof(p_inventory) != 'array' THEN
    RAISE EXCEPTION 'p_inventory 必须为 JSON 数组' USING ERRCODE = 'P0001';
  END IF;

  v_inv_input_count := jsonb_array_length(p_inventory);
  IF v_inv_input_count = 0 THEN
    RAISE EXCEPTION 'p_inventory 不能为空数组（抓取异常或输入错误，不得记录为成功同步）'
      USING ERRCODE = 'P0001';
  END IF;

  v_variant_count := jsonb_array_length(p_variants);

  -- ============================================
  -- 4. 业务键 (sku, country) 去重检测
  -- ============================================

  -- 4a. p_variants 按 (sku, country) 检测重复
  IF v_variant_count > 0 THEN
    WITH dup_check AS (
      SELECT
        value->>'sku' AS sku,
        value->>'country' AS country,
        COUNT(*) AS cnt
      FROM jsonb_array_elements(p_variants)
      GROUP BY 1, 2
      HAVING COUNT(*) > 1
    )
    SELECT jsonb_agg(jsonb_build_object(
      'sku', sku, 'country', country, 'count', cnt
    ))
    INTO v_dup_keys
    FROM dup_check;

    IF v_dup_keys IS NOT NULL THEN
      RAISE EXCEPTION 'p_variants 含重复 (sku,country) 业务键: %', v_dup_keys
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 4b. p_inventory 按 (sku, country) 检测重复
  WITH dup_check AS (
    SELECT
      value->>'sku' AS sku,
      value->>'country' AS country,
      COUNT(*) AS cnt
    FROM jsonb_array_elements(p_inventory)
    GROUP BY 1, 2
    HAVING COUNT(*) > 1
  )
  SELECT jsonb_agg(jsonb_build_object(
    'sku', sku, 'country', country, 'count', cnt
  ))
  INTO v_dup_keys
  FROM dup_check;

  IF v_dup_keys IS NOT NULL THEN
    RAISE EXCEPTION 'p_inventory 含重复 (sku,country) 业务键: %', v_dup_keys
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 4c. 新 Variant-Inventory 关联完整性校验
  -- ============================================
  IF v_variant_count > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_variants)
    LOOP
      v_sku := v_item->>'sku';
      v_country := v_item->>'country';

      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_inventory) AS inv
        WHERE inv->>'sku' = v_sku AND inv->>'country' = v_country
      ) THEN
        RAISE EXCEPTION '新 Variant 缺少对应 Inventory: sku=%, country=%',
          v_sku, v_country
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  -- ============================================
  -- 5. 逐项校验 country 与 Warehouse country 一致 + 字段非空
  -- ============================================

  -- 5a. p_variants: 逐项校验
  IF v_variant_count > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_variants)
    LOOP
      v_sku := v_item->>'sku';
      v_country := v_item->>'country';

      IF v_sku IS NULL OR v_sku = '' THEN
        RAISE EXCEPTION 'Variant SKU 不能为空' USING ERRCODE = 'P0001';
      END IF;

      IF v_country IS NULL OR v_country = '' THEN
        RAISE EXCEPTION 'Variant country 不能为空 (sku: %)', v_sku
          USING ERRCODE = 'P0001';
      END IF;

      IF v_country != v_wh_country THEN
        RAISE EXCEPTION 'Variant country 必须等于 Warehouse country: variant=%, warehouse=% (sku: %)',
          v_country, v_wh_country, v_sku
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  -- 5b. p_inventory: 逐项校验 sku, country, quantity, daily_sales, estimated_days
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_inventory)
  LOOP
    v_sku := v_item->>'sku';
    v_country := v_item->>'country';

    IF v_sku IS NULL OR v_sku = '' THEN
      RAISE EXCEPTION 'Inventory SKU 不能为空' USING ERRCODE = 'P0001';
    END IF;

    IF v_country IS NULL OR v_country = '' THEN
      RAISE EXCEPTION 'Inventory country 不能为空 (sku: %)', v_sku
        USING ERRCODE = 'P0001';
    END IF;

    IF v_country != v_wh_country THEN
      RAISE EXCEPTION 'Inventory country 必须等于 Warehouse country: inventory=%, warehouse=% (sku: %)',
        v_country, v_wh_country, v_sku
        USING ERRCODE = 'P0001';
    END IF;

    -- quantity 严格校验
    IF v_item->'quantity' IS NULL THEN
      RAISE EXCEPTION 'quantity 不能为 null: sku=%, country=%', v_sku, v_country
        USING ERRCODE = 'P0001';
    END IF;

    IF jsonb_typeof(v_item->'quantity') != 'number' THEN
      RAISE EXCEPTION 'quantity 必须为数字类型（拒绝 %）: sku=%, country=%',
        jsonb_typeof(v_item->'quantity'), v_sku, v_country
        USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      v_expected_qty := (v_item->>'quantity')::int;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'quantity 无法解析为严格整数（拒绝浮点/科学计数/超大值）: sku=%, country=%, 值=%',
        v_sku, v_country, v_item->>'quantity'
        USING ERRCODE = 'P0001';
    END;

    IF v_expected_qty < 0 THEN
      RAISE EXCEPTION 'quantity 不能为负数: sku=%, country=%, quantity=%',
        v_sku, v_country, v_expected_qty
        USING ERRCODE = 'P0001';
    END IF;

    -- ─── P5-SY12C: daily_sales 校验 ─────────────────────────────────
    -- 字段缺失 → 跳过（写入 NULL）
    -- JSON null → 允许（写入 NULL）
    -- 字符串 ''、'-'、'—' → 允许（写入 NULL）
    -- 数字 → 解析为 numeric，拒绝 NaN/Infinity/-Infinity
    -- 其它类型或非占位字符串 → 报中文错误
    IF v_item ? 'daily_sales' THEN
      CASE jsonb_typeof(v_item->'daily_sales')
        WHEN 'null' THEN
          -- JSON null → 写入 NULL，无需校验
          NULL;
        WHEN 'string' THEN
          -- 仅允许占位符字符串 ''、'-'、'—' → 写入 NULL
          IF v_item->>'daily_sales' NOT IN ('', '-', '—') THEN
            RAISE EXCEPTION 'daily_sales 不能为字符串: sku=%, country=%, 值=%',
              v_sku, v_country, v_item->>'daily_sales'
              USING ERRCODE = 'P0001';
          END IF;
        WHEN 'number' THEN
          BEGIN
            v_daily_sales := (v_item->>'daily_sales')::numeric;
          EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'daily_sales 无法解析为 numeric: sku=%, country=%, 值=%',
              v_sku, v_country, v_item->>'daily_sales'
              USING ERRCODE = 'P0001';
          END;

          -- 拒绝非有限值（NaN/Infinity/-Infinity）
          IF v_daily_sales = 'NaN'::numeric
             OR v_daily_sales = 'Infinity'::numeric
             OR v_daily_sales = '-Infinity'::numeric THEN
            RAISE EXCEPTION 'daily_sales 不能为非有限值（NaN/Infinity）: sku=%, country=%, 值=%',
              v_sku, v_country, v_daily_sales
              USING ERRCODE = 'P0001';
          END IF;
        ELSE
          RAISE EXCEPTION 'daily_sales 类型非法（期望数字/null/空字符串/占位符，拒绝 %）: sku=%, country=%',
            jsonb_typeof(v_item->'daily_sales'), v_sku, v_country
            USING ERRCODE = 'P0001';
      END CASE;
    END IF;

    v_daily_sales := NULL;

    -- ─── P5-SY12C: estimated_days 校验 ──────────────────────────────
    -- 规则与 daily_sales 完全一致：缺失/null/''/'-'/'—' → 写入 NULL
    IF v_item ? 'estimated_days' THEN
      CASE jsonb_typeof(v_item->'estimated_days')
        WHEN 'null' THEN
          -- JSON null → 写入 NULL，无需校验
          NULL;
        WHEN 'string' THEN
          -- 仅允许占位符字符串 ''、'-'、'—' → 写入 NULL
          IF v_item->>'estimated_days' NOT IN ('', '-', '—') THEN
            RAISE EXCEPTION 'estimated_days 不能为字符串: sku=%, country=%, 值=%',
              v_sku, v_country, v_item->>'estimated_days'
              USING ERRCODE = 'P0001';
          END IF;
        WHEN 'number' THEN
          BEGIN
            v_estimated_days := (v_item->>'estimated_days')::numeric;
          EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'estimated_days 无法解析为 numeric: sku=%, country=%, 值=%',
              v_sku, v_country, v_item->>'estimated_days'
              USING ERRCODE = 'P0001';
          END;

          -- 拒绝非有限值（NaN/Infinity/-Infinity）
          IF v_estimated_days = 'NaN'::numeric
             OR v_estimated_days = 'Infinity'::numeric
             OR v_estimated_days = '-Infinity'::numeric THEN
            RAISE EXCEPTION 'estimated_days 不能为非有限值（NaN/Infinity）: sku=%, country=%, 值=%',
              v_sku, v_country, v_estimated_days
              USING ERRCODE = 'P0001';
          END IF;
        ELSE
          RAISE EXCEPTION 'estimated_days 类型非法（期望数字/null/空字符串/占位符，拒绝 %）: sku=%, country=%',
            jsonb_typeof(v_item->'estimated_days'), v_sku, v_country
            USING ERRCODE = 'P0001';
      END CASE;
    END IF;

    v_estimated_days := NULL;
  END LOOP;

  -- ============================================
  -- 6a. 解析统一快照时间
  -- ============================================
  BEGIN
    SELECT (value->>'last_sync_at')::timestamptz
    INTO v_sync_at
    FROM jsonb_array_elements(p_inventory)
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '首条 last_sync_at 无法解析为 timestamptz: %',
      (SELECT value->>'last_sync_at' FROM jsonb_array_elements(p_inventory) LIMIT 1)
      USING ERRCODE = 'P0001';
  END;

  IF v_sync_at IS NULL THEN
    RAISE EXCEPTION '首条 last_sync_at 不能为空' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 6b. 强制统一快照时间
  -- ============================================
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_inventory)
  LOOP
    BEGIN
      IF v_item->>'last_sync_at' IS NULL OR v_item->>'last_sync_at' = '' THEN
        RAISE EXCEPTION 'last_sync_at 不能为空: sku=%, country=%',
          v_item->>'sku', v_item->>'country'
          USING ERRCODE = 'P0001';
      END IF;

      BEGIN
        v_item_sync_at := (v_item->>'last_sync_at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'last_sync_at 无法解析: sku=%, country=%, 值=%',
          v_item->>'sku', v_item->>'country', v_item->>'last_sync_at'
          USING ERRCODE = 'P0001';
      END;

      IF v_item_sync_at != v_sync_at THEN
        RAISE EXCEPTION '同一次快照内 last_sync_at 不一致: sku=%, country=%, 统一时间=%, 本条时间=%',
          v_item->>'sku', v_item->>'country', v_sync_at, v_item_sync_at
          USING ERRCODE = 'P0001';
      END IF;
    END;
  END LOOP;

  -- ============================================
  -- 7. Variant 创建或复用（幂等）
  -- ============================================
  IF v_variant_count > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_variants)
    LOOP
      INSERT INTO public.product_variant (sku, country, name, product_id, match_status)
      VALUES (
        v_item->>'sku',
        v_item->>'country',
        v_item->>'name',
        NULL,
        'unmatched'
      )
      ON CONFLICT (sku, country) DO NOTHING;

      IF FOUND THEN
        v_created := v_created + 1;
      END IF;
    END LOOP;
  END IF;

  -- ============================================
  -- 8. 逐 SKU 解析 variant_id + 三向分类写入
  --    P5-SY12C: INSERT/UPDATE/UNCHANGED 均写入 daily_sales / estimated_days
  -- ============================================
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_inventory)
  LOOP
    v_sku := v_item->>'sku';
    v_country := v_item->>'country';

    -- 事务内解析 variant_id
    SELECT id INTO v_variant_id
    FROM public.product_variant
    WHERE sku = v_sku AND country = v_country;

    IF NOT FOUND THEN
      RAISE EXCEPTION '无法解析 variant_id: sku=%, country=%', v_sku, v_country
        USING ERRCODE = 'P0001';
    END IF;

    v_expected_qty := (v_item->>'quantity')::int;

    -- ─── 解析 daily_sales / estimated_days ──────────────────────────
    -- 字段缺失 / JSON null / '' / '-' / '—' → NULL
    -- 已在步骤 5b 完成类型校验与非有限值拒绝，此处仅数字类型需 ::numeric
    v_daily_sales := NULL;
    IF v_item ? 'daily_sales' AND jsonb_typeof(v_item->'daily_sales') = 'number' THEN
      v_daily_sales := (v_item->>'daily_sales')::numeric;
    END IF;

    v_estimated_days := NULL;
    IF v_item ? 'estimated_days' AND jsonb_typeof(v_item->'estimated_days') = 'number' THEN
      v_estimated_days := (v_item->>'estimated_days')::numeric;
    END IF;

    -- 查询当前 quantity 以判断 INSERT / UPDATE / UNCHANGED
    SELECT quantity INTO v_current_qty
    FROM public.inventory
    WHERE variant_id = v_variant_id AND warehouse_id = p_warehouse_id;

    IF NOT FOUND THEN
      -- 新 Inventory 记录
      INSERT INTO public.inventory (
        variant_id, warehouse_id, quantity, last_sync_at,
        daily_sales, estimated_days
      )
      VALUES (
        v_variant_id, p_warehouse_id, v_expected_qty, v_sync_at,
        v_daily_sales, v_estimated_days
      );
      v_inserted := v_inserted + 1;
    ELSIF v_current_qty != v_expected_qty THEN
      -- quantity 变更，UPDATE quantity + last_sync_at + 动态告警字段
      UPDATE public.inventory
      SET quantity = v_expected_qty,
          last_sync_at = v_sync_at,
          daily_sales = v_daily_sales,
          estimated_days = v_estimated_days
      WHERE variant_id = v_variant_id AND warehouse_id = p_warehouse_id;
      v_updated := v_updated + 1;
    ELSE
      -- quantity 不变，metadata-only UPDATE 刷新 last_sync_at + 动态告警字段
      UPDATE public.inventory
      SET last_sync_at = v_sync_at,
          daily_sales = v_daily_sales,
          estimated_days = v_estimated_days
      WHERE variant_id = v_variant_id AND warehouse_id = p_warehouse_id;
      v_unchanged := v_unchanged + 1;
    END IF;

    v_received := v_received + 1;
  END LOOP;

  -- ============================================
  -- 9. 写入计数核对
  -- ============================================
  IF v_received != v_inv_input_count THEN
    RAISE EXCEPTION 'Inventory 接收数量不匹配: 期望 %, 实际 %',
      v_inv_input_count, v_received
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 10. 事务内写后核对
  -- ============================================
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_inventory)
  LOOP
    v_sku := v_item->>'sku';
    v_country := v_item->>'country';
    v_expected_qty := (v_item->>'quantity')::int;

    SELECT id INTO v_variant_id
    FROM public.product_variant
    WHERE sku = v_sku AND country = v_country;

    IF NOT FOUND THEN
      RAISE EXCEPTION '写后核对: 无法解析 variant_id: sku=%, country=%', v_sku, v_country
        USING ERRCODE = 'P0001';
    END IF;

    SELECT quantity, last_sync_at INTO v_actual_qty, v_actual_sync_at
    FROM public.inventory
    WHERE variant_id = v_variant_id AND warehouse_id = p_warehouse_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION '写后核对: 缺失 Inventory 记录: sku=%, country=%, variant_id=%',
        v_sku, v_country, v_variant_id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_actual_qty != v_expected_qty THEN
      RAISE EXCEPTION '写后核对: quantity 不一致: sku=%, country=%, 期望=%, 实际=%',
        v_sku, v_country, v_expected_qty, v_actual_qty
        USING ERRCODE = 'P0001';
    END IF;

    IF v_actual_sync_at IS NULL OR v_actual_sync_at != v_sync_at THEN
      RAISE EXCEPTION '写后核对: last_sync_at 不一致: sku=%, country=%, 期望=%, 实际=%',
        v_sku, v_country, v_sync_at, v_actual_sync_at
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- ============================================
  -- 11. Warehouse 改名（仅当名称不同）
  -- ============================================
  IF v_wh_name != p_warehouse_name THEN
    UPDATE public.warehouse
    SET name = p_warehouse_name
    WHERE id = p_warehouse_id;
  END IF;

  -- ============================================
  -- 12. Warehouse 写后核对
  -- ============================================
  SELECT id, country, type, is_active, name
  INTO v_wh_id_ck, v_wh_country_ck, v_wh_type_ck, v_wh_active_ck, v_wh_name_ck
  FROM public.warehouse
  WHERE id = p_warehouse_id;

  IF v_wh_id_ck IS NULL THEN
    RAISE EXCEPTION '写后核对: Warehouse 记录丢失: %', p_warehouse_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_wh_country_ck != v_wh_country THEN
    RAISE EXCEPTION '写后核对: Warehouse country 异常: 期望 %, 实际 %',
      v_wh_country, v_wh_country_ck
      USING ERRCODE = 'P0001';
  END IF;

  IF v_wh_type_ck != 'overseas' THEN
    RAISE EXCEPTION '写后核对: Warehouse type 异常: 期望 overseas, 实际 %', v_wh_type_ck
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT v_wh_active_ck THEN
    RAISE EXCEPTION '写后核对: Warehouse is_active 异常: 期望 true, 实际 false'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_wh_name_ck != p_warehouse_name THEN
    RAISE EXCEPTION '写后核对: Warehouse name 异常: 期望 %, 实际 %',
      p_warehouse_name, v_wh_name_ck
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 13. 返回摘要（含三向分类计数）
  -- ============================================
  RETURN jsonb_build_object(
    'variants_created', v_created,
    'inventory_received', v_received,
    'inventory_inserted', v_inserted,
    'inventory_updated', v_updated,
    'inventory_unchanged', v_unchanged,
    'warehouse_renamed', (v_wh_name != p_warehouse_name)
  );
END;
$$;


--
-- Name: toggle_user_active_protected(uuid, boolean, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_user_active_protected(p_target_user_id uuid, p_is_active boolean, p_operator_user_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_caller_role_name text;
  v_caller_is_active boolean;
  v_target_role_name text;
  v_admin_count bigint;
BEGIN
  -- ⑩ 调用者身份绑定：必须已登录
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，请先登录';
  END IF;

  -- ⑩ 调用者身份绑定：auth.uid() 必须与 p_operator_user_id 一致
  IF auth.uid() != p_operator_user_id THEN
    RAISE EXCEPTION '操作者身份校验失败';
  END IF;

  -- ⑩ 调用者必须是活跃 Admin
  SELECT r.name, p.is_active INTO v_caller_role_name, v_caller_is_active
  FROM public.profiles p
  JOIN public.role r ON r.id = p.role_id
  WHERE p.id = auth.uid();

  IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION '账号未启用或不存在，请联系管理员';
  END IF;

  IF v_caller_role_name != 'admin' THEN
    RAISE EXCEPTION '仅管理员可执行此操作';
  END IF;

  -- 序列化 Admin 写操作，消除 TOCTOU 竞态窗口
  PERFORM pg_advisory_xact_lock(987654321);

  -- ① 自禁用保护
  IF NOT p_is_active AND p_target_user_id = p_operator_user_id THEN
    RAISE EXCEPTION '不允许禁用自己的账号';
  END IF;

  -- ② 获取目标用户角色（锁定行防止并发修改）
  SELECT r.name INTO v_target_role_name
  FROM public.profiles p
  JOIN public.role r ON r.id = p.role_id
  WHERE p.id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在';
  END IF;

  -- ③ 最后管理员保护：仅当禁用管理员时检查
  IF NOT p_is_active AND v_target_role_name = 'admin' THEN
    SELECT count(*) INTO v_admin_count
    FROM public.profiles
    WHERE role_id = (SELECT id FROM public.role WHERE name = 'admin')
      AND is_active = true;

    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION '不允许禁用最后一个管理员';
    END IF;
  END IF;

  -- ④ 原子写入
  UPDATE public.profiles SET is_active = p_is_active WHERE id = p_target_user_id;
END;
$$;


--
-- Name: trg_sync_warehouse_lock_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_sync_warehouse_lock_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.sync_warehouse_lock (warehouse_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;


--
-- Name: update_shipment_external_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_shipment_external_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_user_role_protected(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_role_protected(p_target_user_id uuid, p_new_role_id uuid, p_operator_user_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_caller_role_name text;
  v_caller_is_active boolean;
  v_new_role_name text;
  v_old_role_name text;
  v_admin_count bigint;
BEGIN
  -- ⑩ 调用者身份绑定：必须已登录
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '未登录，请先登录';
  END IF;

  -- ⑩ 调用者身份绑定：auth.uid() 必须与 p_operator_user_id 一致
  IF auth.uid() != p_operator_user_id THEN
    RAISE EXCEPTION '操作者身份校验失败';
  END IF;

  -- ⑩ 调用者必须是活跃 Admin
  SELECT r.name, p.is_active INTO v_caller_role_name, v_caller_is_active
  FROM public.profiles p
  JOIN public.role r ON r.id = p.role_id
  WHERE p.id = auth.uid();

  IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION '账号未启用或不存在，请联系管理员';
  END IF;

  IF v_caller_role_name != 'admin' THEN
    RAISE EXCEPTION '仅管理员可执行此操作';
  END IF;

  -- 序列化 Admin 写操作，消除 TOCTOU 竞态窗口
  PERFORM pg_advisory_xact_lock(987654321);

  -- ① 校验新角色存在
  SELECT name INTO v_new_role_name FROM public.role WHERE id = p_new_role_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '所选角色不存在';
  END IF;

  -- ② 自降级保护：不允许将自己的角色改为非管理员
  IF p_target_user_id = p_operator_user_id AND v_new_role_name != 'admin' THEN
    RAISE EXCEPTION '不允许将自己的角色改为非管理员';
  END IF;

  -- ③ 获取目标用户当前角色（锁定行防止并发修改）
  SELECT r.name INTO v_old_role_name
  FROM public.profiles p
  JOIN public.role r ON r.id = p.role_id
  WHERE p.id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '用户不存在';
  END IF;

  -- ④ 最后管理员保护：仅当降级管理员时检查
  IF v_new_role_name != 'admin' AND v_old_role_name = 'admin' THEN
    SELECT count(*) INTO v_admin_count
    FROM public.profiles
    WHERE role_id = (SELECT id FROM public.role WHERE name = 'admin')
      AND is_active = true;

    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION '不允许移除最后一个管理员的角色';
    END IF;
  END IF;

  -- ⑤ 原子写入
  UPDATE public.profiles SET role_id = p_new_role_id WHERE id = p_target_user_id;
END;
$$;


--
-- Name: update_user_warehouses(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_warehouses(p_user_id uuid, p_warehouse_ids uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_caller_role  TEXT;
  v_target_role  TEXT;
  v_target_active BOOLEAN;
  v_invalid_count INTEGER;
  v_deduped_ids  UUID[];
BEGIN
  -- 1. 校验调用者是 admin
  v_caller_role := public.get_user_role();
  IF v_caller_role IS NULL OR v_caller_role != 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', '无权限：需要管理员角色');
  END IF;

  -- 2. 校验目标用户存在、启用、且为 operator
  SELECT r.name, p.is_active
    INTO v_target_role, v_target_active
  FROM public.profiles p
  JOIN public.role r ON r.id = p.role_id
  WHERE p.id = p_user_id;

  IF v_target_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', '用户不存在');
  END IF;

  IF v_target_role != 'operator' THEN
    RETURN jsonb_build_object('success', false, 'error', '只能为启用的操作员分配仓库');
  END IF;

  IF v_target_active IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', '只能为启用的操作员分配仓库');
  END IF;

  -- 3. 如果 warehouse_ids 非空：校验所有仓库都是活跃海外仓 + 去重
  IF p_warehouse_ids IS NOT NULL AND array_length(p_warehouse_ids, 1) > 0 THEN
    -- 去重
    SELECT array_agg(DISTINCT wid) INTO v_deduped_ids
    FROM unnest(p_warehouse_ids) AS wid;

    -- 校验
    SELECT count(*) INTO v_invalid_count
    FROM unnest(v_deduped_ids) AS wid
    WHERE NOT EXISTS (
      SELECT 1 FROM public.warehouse w
      WHERE w.id = wid AND w.type = 'overseas' AND w.is_active = true
    );

    IF v_invalid_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'error', '只能分配启用的海外仓库');
    END IF;
  END IF;

  -- 4. 事务性写入：先删后插（同一事务内）
  DELETE FROM public.user_warehouses WHERE user_id = p_user_id;

  IF v_deduped_ids IS NOT NULL AND array_length(v_deduped_ids, 1) > 0 THEN
    INSERT INTO public.user_warehouses (user_id, warehouse_id)
    SELECT p_user_id, unnest(v_deduped_ids);
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;


--
-- Name: warehouse_shipment_transactional(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.warehouse_shipment_transactional(p_shipment_id uuid, p_description text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_role            text;
  v_shipment        record;
  v_item            record;
  v_remaining       integer;
BEGIN
  -- ============================================
  -- 权限校验：仅已启用的 admin 可调用
  -- ============================================
  v_role := public.get_user_role();
  IF v_role IS NULL OR v_role != 'admin' THEN
    RAISE EXCEPTION '无权限：需要管理员角色' USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 1. SELECT shipment FOR UPDATE — 排他锁定目标行
  -- ============================================
  SELECT id, warehouse_id, status
  INTO v_shipment
  FROM public.shipment
  WHERE id = p_shipment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '在途记录不存在或无权访问' USING ERRCODE = 'P0001';
  END IF;

  -- 禁止重复入仓
  IF v_shipment.status = 'warehoused' THEN
    RAISE EXCEPTION '该在途记录已完成入仓，不可重复操作' USING ERRCODE = 'P0001';
  END IF;

  -- 必须有仓库（此时 v_shipment.warehouse_id 是独立字段，不会与 id/status 混淆）
  IF v_shipment.warehouse_id IS NULL THEN
    RAISE EXCEPTION '该在途记录未指定仓库，无法入仓' USING ERRCODE = 'P0001';
  END IF;

  -- 仅 customs 允许入仓（清关后货物可入库）
  IF v_shipment.status != 'customs' THEN
    RAISE EXCEPTION '当前状态为 %，仅清关后可确认入仓', v_shipment.status
      USING ERRCODE = 'P0001';
  END IF;

  -- ============================================
  -- 2. 遍历 shipment_item（FOR UPDATE 锁定明细行）
  -- ============================================
  FOR v_item IN
    SELECT id, variant_id, quantity, warehoused_quantity
    FROM public.shipment_item
    WHERE shipment_id = p_shipment_id
    FOR UPDATE
  LOOP
    -- 超量入仓保护：warehoused_quantity 永远不会 > quantity
    v_remaining := v_item.quantity - v_item.warehoused_quantity;
    IF v_remaining < 0 THEN
      -- 数据异常：warehoused_quantity > quantity（不应出现）
      RAISE EXCEPTION '数据异常：产品明细 % 已入仓数量超过总数', v_item.id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_remaining = 0 THEN
      -- 该项已全部入仓，跳过（幂等安全）
      CONTINUE;
    END IF;

    -- ============================================
    -- 3. 原子 UPSERT inventory（ON CONFLICT DO UPDATE，无 select-then-insert 窗口）
    --    FOR UPDATE 隐式由 ON CONFLICT 的行锁处理后确保并发安全
    -- ============================================
    INSERT INTO public.inventory (variant_id, warehouse_id, quantity, last_sync_at)
    VALUES (v_item.variant_id, v_shipment.warehouse_id, v_remaining, now())
    ON CONFLICT (variant_id, warehouse_id)
    DO UPDATE SET
      quantity = public.inventory.quantity + EXCLUDED.quantity,
      updated_at = now(),
      last_sync_at = now();

    -- ============================================
    -- 4. 更新 shipment_item.warehoused_quantity → quantity（全部入仓）
    -- ============================================
    UPDATE public.shipment_item
    SET warehoused_quantity = quantity
    WHERE id = v_item.id;

  END LOOP;

  -- ============================================
  -- 5. 更新 shipment.status → 'warehoused'
  -- ============================================
  UPDATE public.shipment
  SET status = 'warehoused'
  WHERE id = p_shipment_id;

  -- ============================================
  -- 6. 插入 tracking_event（warehoused 轨迹）
  -- ============================================
  INSERT INTO public.tracking_event (
    shipment_id, status, description, occurred_at, created_by
  ) VALUES (
    p_shipment_id,
    'warehoused',
    COALESCE(p_description, '确认入仓'),
    now(),
    auth.uid()
  );

  RETURN TRUE;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    variant_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    last_sync_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    daily_sales numeric,
    estimated_days numeric,
    CONSTRAINT inventory_quantity_check CHECK ((quantity >= 0))
);


--
-- Name: product; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    safety_stock integer DEFAULT 0 NOT NULL,
    category text,
    unit text DEFAULT '件'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_safety_stock_check CHECK ((safety_stock >= 0))
);


--
-- Name: product_variant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variant (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid,
    sku text NOT NULL,
    country text NOT NULL,
    name text NOT NULL,
    match_status text DEFAULT 'unmatched'::text NOT NULL,
    last_sync_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_variant_match_status_check CHECK ((match_status = ANY (ARRAY['matched'::text, 'unmatched'::text, 'pending'::text]))),
    CONSTRAINT variant_country_check CHECK ((country = ANY (ARRAY['TH'::text, 'ID'::text, 'MY'::text, 'PH'::text, 'VN'::text, 'CN'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text NOT NULL,
    role_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_token_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_token_cache (
    provider text NOT NULL,
    access_token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    lease_owner uuid,
    lease_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE provider_token_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.provider_token_cache IS '第三方 API Token 缓存。仅 service_role / SECURITY DEFINER 可读写；普通用户无访问权限。';


--
-- Name: COLUMN provider_token_cache.lease_owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.provider_token_cache.lease_owner IS '当前租约持有者 ID（UUID），用于防止并发刷新竞态。获取 token 前抢租约，写回时校验所有权。';


--
-- Name: COLUMN provider_token_cache.lease_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.provider_token_cache.lease_until IS '租约过期时间。持有者应在租约有效期内完成外部 API 调用并写回新 token。';


--
-- Name: role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_name_check CHECK ((name = ANY (ARRAY['admin'::text, 'operator'::text])))
);


--
-- Name: shipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_name text,
    voyage_number text,
    origin_port text,
    destination_port text,
    country text NOT NULL,
    warehouse_id uuid,
    status text DEFAULT 'booking'::text NOT NULL,
    estimated_arrival date,
    created_by uuid NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shipment_no text NOT NULL,
    purchase_order_no text,
    bigseller_absorbed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    CONSTRAINT shipment_country_check CHECK ((country = ANY (ARRAY['TH'::text, 'ID'::text, 'MY'::text, 'PH'::text, 'VN'::text, 'CN'::text]))),
    CONSTRAINT shipment_status_check CHECK ((status = ANY (ARRAY['booking'::text, 'loading'::text, 'departed'::text, 'arrived'::text, 'customs'::text, 'warehoused'::text])))
);


--
-- Name: COLUMN shipment.purchase_order_no; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shipment.purchase_order_no IS '采购单号（可选，不唯一，不影响历史数据）';


--
-- Name: COLUMN shipment.bigseller_absorbed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shipment.bigseller_absorbed_at IS 'Admin 手动确认 BigSeller 已吸收该在途记录货物的时间。NULL=未确认。';


--
-- Name: shipment_external_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_external_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    external_ref_id uuid NOT NULL,
    external_sku text NOT NULL,
    external_product_name text,
    quantity integer NOT NULL,
    matched_variant_id uuid,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shipment_external_item_quantity_check CHECK ((quantity >= 1))
);


--
-- Name: shipment_external_ref; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_external_ref (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    external_order_no text,
    waybill_no text,
    country text NOT NULL,
    warehouse_id uuid,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    sync_status text DEFAULT 'active'::text NOT NULL,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shipment_id uuid,
    CONSTRAINT shipment_external_ref_country_check CHECK ((country = ANY (ARRAY['TH'::text, 'ID'::text, 'MY'::text, 'PH'::text, 'VN'::text, 'CN'::text]))),
    CONSTRAINT shipment_external_ref_provider_check CHECK ((provider = ANY (ARRAY['best'::text, 'golucky'::text]))),
    CONSTRAINT shipment_external_ref_sync_status_check CHECK ((sync_status = ANY (ARRAY['active'::text, 'stale'::text, 'error'::text])))
);


--
-- Name: shipment_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shipment_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    quantity integer NOT NULL,
    warehoused_quantity integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shipment_item_quantity_check CHECK ((quantity >= 1)),
    CONSTRAINT shipment_item_warehoused_check CHECK ((warehoused_quantity <= quantity)),
    CONSTRAINT shipment_item_warehoused_quantity_check CHECK ((warehoused_quantity >= 0))
);


--
-- Name: sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    warehouse_id uuid NOT NULL,
    status text NOT NULL,
    new_variants_count integer DEFAULT 0 NOT NULL,
    error_message text,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    sync_run_id uuid,
    triggered_by uuid,
    triggered_from text DEFAULT 'cli'::text NOT NULL,
    mode text DEFAULT 'real_write'::text NOT NULL,
    exit_code integer,
    CONSTRAINT sync_log_exit_code_check CHECK (((exit_code IS NULL) OR (exit_code = ANY (ARRAY[0, 1, 2])))),
    CONSTRAINT sync_log_mode_check CHECK ((mode = 'real_write'::text)),
    CONSTRAINT sync_log_new_variants_count_check CHECK ((new_variants_count >= 0)),
    CONSTRAINT sync_log_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text]))),
    CONSTRAINT sync_log_time_check CHECK ((finished_at >= started_at)),
    CONSTRAINT sync_log_triggered_from_check CHECK ((triggered_from = ANY (ARRAY['web'::text, 'cli'::text])))
);


--
-- Name: sync_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_run (
    id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    mode text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    triggered_by uuid NOT NULL,
    triggered_from text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    exit_code integer,
    error_message text,
    result_summary jsonb,
    plan_drift_check text,
    plan_drift_count integer,
    plan_drift_differences jsonb,
    dry_run_run_id uuid,
    input_artifact_hash text,
    plan_artifact_hash text,
    locked_by uuid,
    lease_expires_at timestamp with time zone,
    CONSTRAINT completed_dry_run_requires_plan_artifact CHECK (((NOT ((status = 'completed'::text) AND (mode = 'dry_run'::text))) OR (plan_artifact_hash IS NOT NULL))),
    CONSTRAINT completed_exit_code_zero CHECK (((status <> 'completed'::text) OR (exit_code = 0))),
    CONSTRAINT completed_requires_fields CHECK (((status <> 'completed'::text) OR ((finished_at IS NOT NULL) AND (exit_code IS NOT NULL) AND (result_summary IS NOT NULL) AND (plan_drift_check IS NOT NULL) AND (plan_drift_count IS NOT NULL) AND (plan_drift_differences IS NOT NULL)))),
    CONSTRAINT dry_run_requires_input_artifact CHECK (((mode <> 'dry_run'::text) OR (input_artifact_hash IS NOT NULL))),
    CONSTRAINT failed_requires_fields CHECK (((status <> 'failed'::text) OR ((finished_at IS NOT NULL) AND (error_message IS NOT NULL) AND (exit_code = ANY (ARRAY[1, 2]))))),
    CONSTRAINT plan_drift_check_enum CHECK (((plan_drift_check IS NULL) OR (plan_drift_check = ANY (ARRAY['PASS'::text, 'DRIFT_DETECTED'::text])))),
    CONSTRAINT plan_drift_count_non_negative CHECK (((plan_drift_count IS NULL) OR (plan_drift_count >= 0))),
    CONSTRAINT plan_drift_differences_length CHECK (((plan_drift_differences IS NULL) OR (plan_drift_count IS NULL) OR (jsonb_array_length(plan_drift_differences) = plan_drift_count))),
    CONSTRAINT real_write_requires_artifacts CHECK (((mode <> 'real_write'::text) OR ((input_artifact_hash IS NOT NULL) AND (plan_artifact_hash IS NOT NULL)))),
    CONSTRAINT real_write_requires_dry_run CHECK (((mode <> 'real_write'::text) OR (dry_run_run_id IS NOT NULL))),
    CONSTRAINT sync_run_mode_check CHECK ((mode = ANY (ARRAY['dry_run'::text, 'real_write'::text]))),
    CONSTRAINT sync_run_plan_drift_check_check CHECK ((plan_drift_check = ANY (ARRAY['PASS'::text, 'DRIFT_DETECTED'::text]))),
    CONSTRAINT sync_run_plan_drift_count_check CHECK ((plan_drift_count >= 0)),
    CONSTRAINT sync_run_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT sync_run_time_check CHECK (((finished_at IS NULL) OR (started_at IS NULL) OR (finished_at >= started_at))),
    CONSTRAINT sync_run_triggered_from_check CHECK ((triggered_from = ANY (ARRAY['web'::text, 'cli'::text])))
);


--
-- Name: sync_warehouse_lock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_warehouse_lock (
    warehouse_id uuid NOT NULL,
    locked_by uuid,
    locked_at timestamp with time zone
);


--
-- Name: tracking_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracking_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shipment_id uuid NOT NULL,
    status text NOT NULL,
    description text,
    occurred_at timestamp with time zone NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tracking_event_status_check CHECK ((status = ANY (ARRAY['booking'::text, 'loading'::text, 'departed'::text, 'arrived'::text, 'customs'::text, 'warehoused'::text])))
);


--
-- Name: tracking_event_external; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracking_event_external (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    external_ref_id uuid NOT NULL,
    provider text NOT NULL,
    external_event_id text NOT NULL,
    status text,
    description text,
    occurred_at timestamp with time zone,
    location text,
    raw_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    external_category text DEFAULT 'unknown'::text NOT NULL,
    CONSTRAINT tracking_event_external_category_check CHECK ((external_category = ANY (ARRAY['created'::text, 'loaded'::text, 'in_transit'::text, 'customs'::text, 'delivered'::text, 'exception'::text, 'unknown'::text]))),
    CONSTRAINT tracking_event_external_provider_check CHECK ((provider = ANY (ARRAY['best'::text, 'golucky'::text])))
);


--
-- Name: user_variant_preference; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_variant_preference (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    variant_id uuid NOT NULL,
    preference_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_variant_preference_preference_type_check CHECK ((preference_type = ANY (ARRAY['archived'::text, 'favorited'::text])))
);


--
-- Name: user_warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_warehouses (
    user_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: warehouse; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    country text NOT NULL,
    type text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sync_url text,
    last_sync_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lead_time_days integer,
    buffer_ratio numeric DEFAULT 0.25 NOT NULL,
    target_cover_multiplier numeric DEFAULT 1.5 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT warehouse_buffer_ratio_check CHECK ((buffer_ratio >= (0)::numeric)),
    CONSTRAINT warehouse_cover_mult_check CHECK ((target_cover_multiplier > (0)::numeric)),
    CONSTRAINT warehouse_type_check CHECK ((type = ANY (ARRAY['domestic'::text, 'overseas'::text])))
);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: inventory inventory_variant_warehouse_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_variant_warehouse_unique UNIQUE (variant_id, warehouse_id);


--
-- Name: product product_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product
    ADD CONSTRAINT product_code_unique UNIQUE (code);


--
-- Name: product product_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product
    ADD CONSTRAINT product_pkey PRIMARY KEY (id);


--
-- Name: product_variant product_variant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variant
    ADD CONSTRAINT product_variant_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: provider_token_cache provider_token_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_token_cache
    ADD CONSTRAINT provider_token_cache_pkey PRIMARY KEY (provider);


--
-- Name: role role_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT role_name_unique UNIQUE (name);


--
-- Name: role role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT role_pkey PRIMARY KEY (id);


--
-- Name: shipment_external_item shipment_external_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_external_item
    ADD CONSTRAINT shipment_external_item_pkey PRIMARY KEY (id);


--
-- Name: shipment_external_ref shipment_external_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_external_ref
    ADD CONSTRAINT shipment_external_ref_pkey PRIMARY KEY (id);


--
-- Name: shipment_item shipment_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_item
    ADD CONSTRAINT shipment_item_pkey PRIMARY KEY (id);


--
-- Name: shipment shipment_no_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_no_unique UNIQUE (shipment_no);


--
-- Name: shipment shipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_pkey PRIMARY KEY (id);


--
-- Name: sync_log sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_log
    ADD CONSTRAINT sync_log_pkey PRIMARY KEY (id);


--
-- Name: sync_run sync_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_run
    ADD CONSTRAINT sync_run_pkey PRIMARY KEY (id);


--
-- Name: sync_warehouse_lock sync_warehouse_lock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_warehouse_lock
    ADD CONSTRAINT sync_warehouse_lock_pkey PRIMARY KEY (warehouse_id);


--
-- Name: tracking_event_external tracking_event_external_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracking_event_external
    ADD CONSTRAINT tracking_event_external_pkey PRIMARY KEY (id);


--
-- Name: tracking_event tracking_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracking_event
    ADD CONSTRAINT tracking_event_pkey PRIMARY KEY (id);


--
-- Name: user_variant_preference user_variant_preference_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_variant_preference
    ADD CONSTRAINT user_variant_preference_pkey PRIMARY KEY (id);


--
-- Name: user_variant_preference user_variant_preference_user_id_variant_id_preference_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_variant_preference
    ADD CONSTRAINT user_variant_preference_user_id_variant_id_preference_type_key UNIQUE (user_id, variant_id, preference_type);


--
-- Name: user_warehouses user_warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_warehouses
    ADD CONSTRAINT user_warehouses_pkey PRIMARY KEY (user_id, warehouse_id);


--
-- Name: product_variant variant_sku_country_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variant
    ADD CONSTRAINT variant_sku_country_unique UNIQUE (sku, country);


--
-- Name: warehouse warehouse_name_country_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse
    ADD CONSTRAINT warehouse_name_country_unique UNIQUE (name, country);


--
-- Name: warehouse warehouse_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse
    ADD CONSTRAINT warehouse_pkey PRIMARY KEY (id);


--
-- Name: idx_inventory_warehouse_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_warehouse_id ON public.inventory USING btree (warehouse_id);


--
-- Name: idx_product_code_lower_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_code_lower_trgm ON public.product USING gin (lower(COALESCE(code, ''::text)) public.gin_trgm_ops);


--
-- Name: idx_product_code_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_code_trgm ON public.product USING gin (code public.gin_trgm_ops);


--
-- Name: idx_product_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_is_active ON public.product USING btree (is_active);


--
-- Name: idx_product_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_name ON public.product USING btree (name);


--
-- Name: idx_product_name_lower_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_name_lower_trgm ON public.product USING gin (lower(COALESCE(name, ''::text)) public.gin_trgm_ops);


--
-- Name: idx_product_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_name_trgm ON public.product USING gin (name public.gin_trgm_ops);


--
-- Name: idx_profiles_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_is_active ON public.profiles USING btree (is_active);


--
-- Name: idx_profiles_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_role_id ON public.profiles USING btree (role_id);


--
-- Name: idx_shipment_active_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_active_created ON public.shipment USING btree (created_at DESC) WHERE (status <> 'warehoused'::text);


--
-- Name: idx_shipment_cancelled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_cancelled_at ON public.shipment USING btree (cancelled_at);


--
-- Name: idx_shipment_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_country ON public.shipment USING btree (country);


--
-- Name: idx_shipment_estimated_arrival; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_estimated_arrival ON public.shipment USING btree (estimated_arrival);


--
-- Name: idx_shipment_ext_item_ref_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_ext_item_ref_id ON public.shipment_external_item USING btree (external_ref_id);


--
-- Name: idx_shipment_ext_item_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_ext_item_sku ON public.shipment_external_item USING btree (external_sku);


--
-- Name: idx_shipment_ext_item_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_ext_item_variant ON public.shipment_external_item USING btree (matched_variant_id);


--
-- Name: idx_shipment_external_ref_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_external_ref_country ON public.shipment_external_ref USING btree (country);


--
-- Name: idx_shipment_external_ref_provider_waybill; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_shipment_external_ref_provider_waybill ON public.shipment_external_ref USING btree (provider, waybill_no) WHERE (waybill_no IS NOT NULL);


--
-- Name: idx_shipment_external_ref_shipment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_external_ref_shipment_id ON public.shipment_external_ref USING btree (shipment_id);


--
-- Name: idx_shipment_external_ref_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_external_ref_status ON public.shipment_external_ref USING btree (sync_status);


--
-- Name: idx_shipment_external_ref_warehouse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_external_ref_warehouse ON public.shipment_external_ref USING btree (warehouse_id);


--
-- Name: idx_shipment_item_shipment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_item_shipment_id ON public.shipment_item USING btree (shipment_id);


--
-- Name: idx_shipment_item_shipment_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_item_shipment_variant ON public.shipment_item USING btree (shipment_id, variant_id);


--
-- Name: idx_shipment_item_variant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_item_variant_id ON public.shipment_item USING btree (variant_id);


--
-- Name: idx_shipment_replenishment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_replenishment_active ON public.shipment USING btree (warehouse_id, estimated_arrival, id) WHERE ((cancelled_at IS NULL) AND (bigseller_absorbed_at IS NULL) AND (estimated_arrival IS NOT NULL) AND (status = ANY (ARRAY['booking'::text, 'loading'::text, 'departed'::text, 'arrived'::text, 'customs'::text])));


--
-- Name: idx_shipment_shipment_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_shipment_no ON public.shipment USING btree (shipment_no);


--
-- Name: idx_shipment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_status ON public.shipment USING btree (status);


--
-- Name: idx_shipment_warehouse_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_warehouse_id ON public.shipment USING btree (warehouse_id);


--
-- Name: idx_shipment_warehouse_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_warehouse_status ON public.shipment USING btree (warehouse_id, status);


--
-- Name: idx_sync_log_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_log_started_at ON public.sync_log USING btree (started_at);


--
-- Name: idx_sync_log_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_log_status ON public.sync_log USING btree (status);


--
-- Name: idx_sync_log_sync_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_log_sync_run_id ON public.sync_log USING btree (sync_run_id);


--
-- Name: idx_sync_log_warehouse_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_log_warehouse_id ON public.sync_log USING btree (warehouse_id);


--
-- Name: idx_sync_run_dry_run_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_dry_run_ref ON public.sync_run USING btree (dry_run_run_id) WHERE (dry_run_run_id IS NOT NULL);


--
-- Name: idx_sync_run_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_mode ON public.sync_run USING btree (mode);


--
-- Name: idx_sync_run_one_in_progress; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_sync_run_one_in_progress ON public.sync_run USING btree (warehouse_id) WHERE (status = 'in_progress'::text);


--
-- Name: idx_sync_run_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_started_at ON public.sync_run USING btree (started_at);


--
-- Name: idx_sync_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_status ON public.sync_run USING btree (status);


--
-- Name: idx_sync_run_status_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_status_lease ON public.sync_run USING btree (status, lease_expires_at);


--
-- Name: idx_sync_run_triggered_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_triggered_by ON public.sync_run USING btree (triggered_by);


--
-- Name: idx_sync_run_warehouse_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_warehouse_id ON public.sync_run USING btree (warehouse_id);


--
-- Name: idx_sync_run_warehouse_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_run_warehouse_started ON public.sync_run USING btree (warehouse_id, started_at DESC);


--
-- Name: idx_tracking_event_external_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tracking_event_external_dedup ON public.tracking_event_external USING btree (external_ref_id, external_event_id);


--
-- Name: idx_tracking_event_shipment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tracking_event_shipment_id ON public.tracking_event USING btree (shipment_id);


--
-- Name: idx_tracking_event_shipment_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tracking_event_shipment_occurred ON public.tracking_event USING btree (shipment_id, occurred_at);


--
-- Name: idx_tracking_event_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tracking_event_status ON public.tracking_event USING btree (status);


--
-- Name: idx_tracking_ext_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tracking_ext_occurred_at ON public.tracking_event_external USING btree (occurred_at);


--
-- Name: idx_tracking_ext_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tracking_ext_provider ON public.tracking_event_external USING btree (provider);


--
-- Name: idx_tracking_ext_ref_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tracking_ext_ref_id ON public.tracking_event_external USING btree (external_ref_id);


--
-- Name: idx_user_warehouses_warehouse_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_warehouses_warehouse_id ON public.user_warehouses USING btree (warehouse_id);


--
-- Name: idx_uvp_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uvp_user_type ON public.user_variant_preference USING btree (user_id, preference_type);


--
-- Name: idx_uvp_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uvp_variant ON public.user_variant_preference USING btree (variant_id, preference_type);


--
-- Name: idx_uvp_variant_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uvp_variant_user_type ON public.user_variant_preference USING btree (variant_id, user_id, preference_type);


--
-- Name: idx_variant_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_country ON public.product_variant USING btree (country);


--
-- Name: idx_variant_match_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_match_status ON public.product_variant USING btree (match_status);


--
-- Name: idx_variant_name_lower_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_name_lower_trgm ON public.product_variant USING gin (lower(COALESCE(name, ''::text)) public.gin_trgm_ops);


--
-- Name: idx_variant_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_name_trgm ON public.product_variant USING gin (name public.gin_trgm_ops);


--
-- Name: idx_variant_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_product_id ON public.product_variant USING btree (product_id);


--
-- Name: idx_variant_product_id_null; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_product_id_null ON public.product_variant USING btree (product_id) WHERE (product_id IS NULL);


--
-- Name: idx_variant_sku_lower_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_sku_lower_trgm ON public.product_variant USING gin (lower(COALESCE(sku, ''::text)) public.gin_trgm_ops);


--
-- Name: idx_variant_sku_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_sku_trgm ON public.product_variant USING gin (sku public.gin_trgm_ops);


--
-- Name: idx_warehouse_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warehouse_country ON public.warehouse USING btree (country);


--
-- Name: idx_warehouse_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warehouse_type ON public.warehouse USING btree (type);


--
-- Name: shipment_external_item tg_shipment_external_item_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_shipment_external_item_updated_at BEFORE UPDATE ON public.shipment_external_item FOR EACH ROW EXECUTE FUNCTION public.update_shipment_external_updated_at();


--
-- Name: shipment_external_ref tg_shipment_external_ref_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_shipment_external_ref_updated_at BEFORE UPDATE ON public.shipment_external_ref FOR EACH ROW EXECUTE FUNCTION public.update_shipment_external_updated_at();


--
-- Name: shipment_external_ref tg_shipment_external_ref_warehouse_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_shipment_external_ref_warehouse_lock BEFORE UPDATE ON public.shipment_external_ref FOR EACH ROW EXECUTE FUNCTION public.fn_shipment_external_ref_warehouse_lock();


--
-- Name: shipment tg_shipment_no_rewarehouse_if_bound; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_shipment_no_rewarehouse_if_bound BEFORE UPDATE OF warehouse_id ON public.shipment FOR EACH ROW EXECUTE FUNCTION public.fn_shipment_no_rewarehouse_if_bound();


--
-- Name: tracking_event_external tg_tracking_event_external_provider_consistent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_tracking_event_external_provider_consistent BEFORE INSERT OR UPDATE ON public.tracking_event_external FOR EACH ROW EXECUTE FUNCTION public.fn_tracking_event_external_provider_consistent();


--
-- Name: profiles trg_check_operator_profile_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_check_operator_profile_update BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.check_operator_profile_update();


--
-- Name: inventory trg_inventory_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_inventory_updated_at BEFORE UPDATE ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: product trg_product_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_product_updated_at BEFORE UPDATE ON public.product FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: product_variant trg_product_variant_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_product_variant_updated_at BEFORE UPDATE ON public.product_variant FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: profiles trg_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: shipment trg_shipment_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_shipment_updated_at BEFORE UPDATE ON public.shipment FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: warehouse trg_warehouse_create_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_warehouse_create_lock AFTER INSERT ON public.warehouse FOR EACH ROW EXECUTE FUNCTION public.trg_sync_warehouse_lock_insert();


--
-- Name: warehouse trg_warehouse_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_warehouse_updated_at BEFORE UPDATE ON public.warehouse FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: inventory inventory_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variant(id) ON DELETE CASCADE;


--
-- Name: inventory inventory_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouse(id) ON DELETE CASCADE;


--
-- Name: product_variant product_variant_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variant
    ADD CONSTRAINT product_variant_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.role(id);


--
-- Name: shipment shipment_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: shipment_external_item shipment_external_item_external_ref_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_external_item
    ADD CONSTRAINT shipment_external_item_external_ref_id_fkey FOREIGN KEY (external_ref_id) REFERENCES public.shipment_external_ref(id) ON DELETE CASCADE;


--
-- Name: shipment_external_item shipment_external_item_matched_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_external_item
    ADD CONSTRAINT shipment_external_item_matched_variant_id_fkey FOREIGN KEY (matched_variant_id) REFERENCES public.product_variant(id) ON DELETE SET NULL;


--
-- Name: shipment_external_ref shipment_external_ref_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_external_ref
    ADD CONSTRAINT shipment_external_ref_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipment(id) ON DELETE SET NULL;


--
-- Name: shipment_external_ref shipment_external_ref_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_external_ref
    ADD CONSTRAINT shipment_external_ref_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouse(id) ON DELETE SET NULL;


--
-- Name: shipment_item shipment_item_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_item
    ADD CONSTRAINT shipment_item_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipment(id) ON DELETE CASCADE;


--
-- Name: shipment_item shipment_item_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_item
    ADD CONSTRAINT shipment_item_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variant(id) ON DELETE RESTRICT;


--
-- Name: shipment shipment_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment
    ADD CONSTRAINT shipment_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouse(id) ON DELETE SET NULL;


--
-- Name: sync_log sync_log_sync_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_log
    ADD CONSTRAINT sync_log_sync_run_id_fkey FOREIGN KEY (sync_run_id) REFERENCES public.sync_run(id) ON DELETE SET NULL;


--
-- Name: sync_log sync_log_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_log
    ADD CONSTRAINT sync_log_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.profiles(id);


--
-- Name: sync_log sync_log_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_log
    ADD CONSTRAINT sync_log_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouse(id) ON DELETE CASCADE;


--
-- Name: sync_run sync_run_dry_run_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_run
    ADD CONSTRAINT sync_run_dry_run_run_id_fkey FOREIGN KEY (dry_run_run_id) REFERENCES public.sync_run(id);


--
-- Name: sync_run sync_run_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_run
    ADD CONSTRAINT sync_run_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.profiles(id);


--
-- Name: sync_run sync_run_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_run
    ADD CONSTRAINT sync_run_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouse(id) ON DELETE CASCADE;


--
-- Name: sync_warehouse_lock sync_warehouse_lock_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_warehouse_lock
    ADD CONSTRAINT sync_warehouse_lock_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.sync_run(id) ON DELETE SET NULL;


--
-- Name: sync_warehouse_lock sync_warehouse_lock_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_warehouse_lock
    ADD CONSTRAINT sync_warehouse_lock_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouse(id) ON DELETE CASCADE;


--
-- Name: tracking_event tracking_event_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracking_event
    ADD CONSTRAINT tracking_event_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: tracking_event_external tracking_event_external_external_ref_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracking_event_external
    ADD CONSTRAINT tracking_event_external_external_ref_id_fkey FOREIGN KEY (external_ref_id) REFERENCES public.shipment_external_ref(id) ON DELETE CASCADE;


--
-- Name: tracking_event tracking_event_shipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracking_event
    ADD CONSTRAINT tracking_event_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES public.shipment(id) ON DELETE CASCADE;


--
-- Name: user_variant_preference user_variant_preference_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_variant_preference
    ADD CONSTRAINT user_variant_preference_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_variant_preference user_variant_preference_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_variant_preference
    ADD CONSTRAINT user_variant_preference_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variant(id) ON DELETE CASCADE;


--
-- Name: user_warehouses user_warehouses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_warehouses
    ADD CONSTRAINT user_warehouses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_warehouses user_warehouses_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_warehouses
    ADD CONSTRAINT user_warehouses_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.warehouse(id) ON DELETE CASCADE;


--
-- Name: inventory admin_all_inventory; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_inventory ON public.inventory USING ((public.get_user_role() = 'admin'::text));


--
-- Name: user_variant_preference admin_all_preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_preferences ON public.user_variant_preference USING ((public.get_user_role() = 'admin'::text));


--
-- Name: profiles admin_all_profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_profiles ON public.profiles USING ((public.get_user_role() = 'admin'::text));


--
-- Name: shipment admin_all_shipment; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_shipment ON public.shipment USING ((public.get_user_role() = 'admin'::text));


--
-- Name: shipment_external_item admin_all_shipment_external_item; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_shipment_external_item ON public.shipment_external_item USING ((public.get_user_role() = 'admin'::text));


--
-- Name: shipment_external_ref admin_all_shipment_external_ref; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_shipment_external_ref ON public.shipment_external_ref USING ((public.get_user_role() = 'admin'::text));


--
-- Name: shipment_item admin_all_shipment_item; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_shipment_item ON public.shipment_item USING ((public.get_user_role() = 'admin'::text));


--
-- Name: sync_log admin_all_sync_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_sync_log ON public.sync_log USING ((public.get_user_role() = 'admin'::text));


--
-- Name: tracking_event admin_all_tracking_event; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_tracking_event ON public.tracking_event USING ((public.get_user_role() = 'admin'::text));


--
-- Name: tracking_event_external admin_all_tracking_event_external; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_tracking_event_external ON public.tracking_event_external USING ((public.get_user_role() = 'admin'::text));


--
-- Name: user_warehouses admin_all_user_warehouses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_user_warehouses ON public.user_warehouses USING ((public.get_user_role() = 'admin'::text));


--
-- Name: product_variant admin_all_variant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_variant ON public.product_variant USING ((public.get_user_role() = 'admin'::text));


--
-- Name: warehouse admin_all_warehouse; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_all_warehouse ON public.warehouse USING ((public.get_user_role() = 'admin'::text));


--
-- Name: inventory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment operator_insert_shipment; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_insert_shipment ON public.shipment FOR INSERT WITH CHECK (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))));


--
-- Name: shipment_item operator_insert_shipment_item; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_insert_shipment_item ON public.shipment_item FOR INSERT WITH CHECK (((public.get_user_role() = 'operator'::text) AND (EXISTS ( SELECT 1
   FROM public.shipment s
  WHERE ((s.id = shipment_item.shipment_id) AND (s.warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))))));


--
-- Name: tracking_event operator_insert_tracking_event; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_insert_tracking_event ON public.tracking_event FOR INSERT WITH CHECK (((public.get_user_role() = 'operator'::text) AND (EXISTS ( SELECT 1
   FROM public.shipment s
  WHERE ((s.id = tracking_event.shipment_id) AND (s.warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))))));


--
-- Name: inventory operator_select_inventory; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_inventory ON public.inventory FOR SELECT USING (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))));


--
-- Name: user_warehouses operator_select_own_user_warehouses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_own_user_warehouses ON public.user_warehouses FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: shipment_external_item operator_select_own_warehouse_shipment_external_item; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_own_warehouse_shipment_external_item ON public.shipment_external_item FOR SELECT USING (((public.get_user_role() = 'admin'::text) OR ((public.get_user_role() = 'operator'::text) AND (external_ref_id IN ( SELECT r.id
   FROM public.shipment_external_ref r
  WHERE ((r.warehouse_id IS NOT NULL) AND (r.warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))))))));


--
-- Name: shipment_external_ref operator_select_own_warehouse_shipment_external_ref; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_own_warehouse_shipment_external_ref ON public.shipment_external_ref FOR SELECT USING (((public.get_user_role() = 'admin'::text) OR ((public.get_user_role() = 'operator'::text) AND (warehouse_id IS NOT NULL) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))));


--
-- Name: tracking_event_external operator_select_own_warehouse_tracking_event_external; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_own_warehouse_tracking_event_external ON public.tracking_event_external FOR SELECT USING (((public.get_user_role() = 'admin'::text) OR ((public.get_user_role() = 'operator'::text) AND (external_ref_id IN ( SELECT r.id
   FROM public.shipment_external_ref r
  WHERE ((r.warehouse_id IS NOT NULL) AND (r.warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))))))));


--
-- Name: profiles operator_select_profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_profiles ON public.profiles FOR SELECT USING ((public.get_user_role() = 'operator'::text));


--
-- Name: shipment operator_select_shipment; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_shipment ON public.shipment FOR SELECT USING (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))));


--
-- Name: shipment_item operator_select_shipment_item; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_shipment_item ON public.shipment_item FOR SELECT USING (((public.get_user_role() = 'operator'::text) AND (EXISTS ( SELECT 1
   FROM public.shipment s
  WHERE ((s.id = shipment_item.shipment_id) AND (s.warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))))));


--
-- Name: sync_log operator_select_sync_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_sync_log ON public.sync_log FOR SELECT USING (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))));


--
-- Name: tracking_event operator_select_tracking_event; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_tracking_event ON public.tracking_event FOR SELECT USING (((public.get_user_role() = 'operator'::text) AND (EXISTS ( SELECT 1
   FROM public.shipment s
  WHERE ((s.id = tracking_event.shipment_id) AND (s.warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))))));


--
-- Name: product_variant operator_select_variant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_variant ON public.product_variant FOR SELECT USING (((public.get_user_role() = 'operator'::text) AND (EXISTS ( SELECT 1
   FROM public.inventory i
  WHERE ((i.variant_id = product_variant.id) AND (i.warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))))));


--
-- Name: warehouse operator_select_warehouse; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_select_warehouse ON public.warehouse FOR SELECT USING (((public.get_user_role() = 'operator'::text) AND (id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))));


--
-- Name: inventory operator_update_inventory_quantity; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_update_inventory_quantity ON public.inventory FOR UPDATE USING (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))) WITH CHECK (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))));


--
-- Name: profiles operator_update_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_update_own_profile ON public.profiles FOR UPDATE USING (((( SELECT auth.uid() AS uid) = id) AND (public.get_user_role() = 'operator'::text))) WITH CHECK (((( SELECT auth.uid() AS uid) = id) AND (public.get_user_role() = 'operator'::text)));


--
-- Name: shipment operator_update_shipment; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY operator_update_shipment ON public.shipment FOR UPDATE USING (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids)))) WITH CHECK (((public.get_user_role() = 'operator'::text) AND (warehouse_id IN ( SELECT public.get_assigned_warehouse_ids() AS get_assigned_warehouse_ids))));


--
-- Name: product; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product ENABLE ROW LEVEL SECURITY;

--
-- Name: product product_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_delete_admin ON public.product FOR DELETE USING ((public.get_user_role() = 'admin'::text));


--
-- Name: product product_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_insert_admin ON public.product FOR INSERT WITH CHECK ((public.get_user_role() = 'admin'::text));


--
-- Name: product product_select_admin_or_operator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_select_admin_or_operator ON public.product FOR SELECT USING (((public.get_user_role() = 'admin'::text) OR (public.get_user_role() = 'operator'::text)));


--
-- Name: product product_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY product_update_admin ON public.product FOR UPDATE USING ((public.get_user_role() = 'admin'::text)) WITH CHECK ((public.get_user_role() = 'admin'::text));


--
-- Name: product_variant; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_variant ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_token_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_token_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: role; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role ENABLE ROW LEVEL SECURITY;

--
-- Name: role role_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY role_delete_admin ON public.role FOR DELETE USING ((public.get_user_role() = 'admin'::text));


--
-- Name: role role_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY role_insert_admin ON public.role FOR INSERT WITH CHECK ((public.get_user_role() = 'admin'::text));


--
-- Name: role role_select_admin_or_operator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY role_select_admin_or_operator ON public.role FOR SELECT USING (((public.get_user_role() = 'admin'::text) OR (public.get_user_role() = 'operator'::text)));


--
-- Name: role role_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY role_update_admin ON public.role FOR UPDATE USING ((public.get_user_role() = 'admin'::text)) WITH CHECK ((public.get_user_role() = 'admin'::text));


--
-- Name: sync_log service_role_all_sync_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all_sync_log ON public.sync_log TO service_role USING (true);


--
-- Name: sync_run service_role_all_sync_run; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all_sync_run ON public.sync_run TO service_role USING (true);


--
-- Name: sync_warehouse_lock service_role_all_sync_warehouse_lock; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all_sync_warehouse_lock ON public.sync_warehouse_lock TO service_role USING (true);


--
-- Name: shipment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment_external_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment_external_item ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment_external_ref; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment_external_ref ENABLE ROW LEVEL SECURITY;

--
-- Name: shipment_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment_item ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_run; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_run ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_warehouse_lock; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_warehouse_lock ENABLE ROW LEVEL SECURITY;

--
-- Name: tracking_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tracking_event ENABLE ROW LEVEL SECURITY;

--
-- Name: tracking_event_external; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tracking_event_external ENABLE ROW LEVEL SECURITY;

--
-- Name: user_variant_preference user_delete_own_preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_delete_own_preferences ON public.user_variant_preference FOR DELETE USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_variant_preference user_insert_own_preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_insert_own_preferences ON public.user_variant_preference FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: profiles user_read_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_read_own_profile ON public.profiles FOR SELECT USING ((( SELECT auth.uid() AS uid) = id));


--
-- Name: user_variant_preference user_select_own_preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_select_own_preferences ON public.user_variant_preference FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_variant_preference; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_variant_preference ENABLE ROW LEVEL SECURITY;

--
-- Name: user_warehouses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_warehouses ENABLE ROW LEVEL SECURITY;

--
-- Name: warehouse; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.warehouse ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

