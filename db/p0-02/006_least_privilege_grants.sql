-- P0-02 effective runtime ACL: strip PUBLIC/legacy role grants, apply audited whitelist.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

REVOKE ALL ON SCHEMA public FROM ice_p0_02_app_runner, ice_p0_02_sync_runner;
GRANT USAGE ON SCHEMA public TO ice_p0_02_app_runner, ice_p0_02_sync_runner;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ice_p0_02_app_runner, ice_p0_02_sync_runner;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ice_p0_02_app_runner, ice_p0_02_sync_runner;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM ice_p0_02_app_runner, ice_p0_02_sync_runner;

-- App: business tables under RLS (explicit list; no token cache)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.role,
  public.profiles,
  public.product,
  public.product_variant,
  public.inventory,
  public.warehouse,
  public.shipment,
  public.shipment_item,
  public.shipment_external_ref,
  public.shipment_external_item,
  public.tracking_event,
  public.tracking_event_external,
  public.user_variant_preference,
  public.user_warehouses,
  public.sync_run,
  public.sync_log
TO ice_p0_02_app_runner;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ice_p0_02_app_runner;

-- Sync: narrower write surface
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sync_run, public.sync_log TO ice_p0_02_sync_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory, public.product_variant TO ice_p0_02_sync_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipment_external_ref, public.tracking_event_external TO ice_p0_02_sync_runner;
GRANT SELECT, UPDATE ON public.warehouse, public.product TO ice_p0_02_sync_runner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ice_p0_02_sync_runner;

DO $$
DECLARE
  fn regprocedure;
  spec text;
  app_required text[] := ARRAY[
    'get_user_role()',
    'get_assigned_warehouse_ids()',
    'update_user_role_protected(uuid,uuid,uuid)',
    'toggle_user_active_protected(uuid,boolean,uuid)',
    'claim_sync_run(uuid,text,uuid,integer,uuid,text,uuid,text,text)',
    'get_overseas_inventory(uuid,text,uuid,text,text,boolean,integer,integer)',
    'get_overseas_stats(uuid,text,uuid)',
    'get_low_stock(uuid,integer)',
    'get_warehouse_health_overview(uuid)',
    'get_in_transit_confirmed_aggregate(uuid,uuid[])',
    'get_product_overview(uuid,integer,integer,text,text,text)',
    'get_war_room_variant_detail(uuid,uuid)',
    'get_replenishment_suggestions(uuid,uuid,uuid,text,text,text,boolean,integer,integer)',
    'get_in_transit_detail(uuid,uuid,uuid)',
    'get_sync_warehouse_overview()',
    'get_sync_runs(uuid,integer)',
    'get_sync_runs_paginated(uuid,integer,integer)',
    'get_sync_run_detail(uuid)',
    'create_shipment_transactional(text,text,text,text,text,text,uuid,date,text,text,jsonb)',
    'change_shipment_status_transactional(uuid,text,text)',
    'import_golucky_refs(jsonb)',
    'bind_external_ref_to_shipment(uuid,uuid)',
    'reactivate_external_ref(uuid)',
    'batch_match_variants(uuid[],uuid)',
    'partial_warehouse_shipment(uuid,jsonb,text)'
  ];
  sync_required text[] := ARRAY[
    'claim_sync_run_system(uuid,text,uuid,integer,uuid,text,text)',
    'release_sync_run(uuid,text,integer,text,jsonb,text,integer,jsonb,text)',
    'heartbeat_sync_run(uuid,integer)',
    'acquire_token_lease(text,uuid)',
    'store_token_with_lease(text,text,timestamp with time zone,uuid)',
    'release_token_lease(text,uuid)'
  ];
  sealed text[] := ARRAY[
    'warehouse_shipment_transactional(uuid,text)'
  ];
  system_only text[] := ARRAY[
    'claim_sync_run_system(uuid,text,uuid,integer,uuid,text,text)',
    'acquire_token_lease(text,uuid)',
    'store_token_with_lease(text,text,timestamp with time zone,uuid)',
    'release_token_lease(text,uuid)'
  ];
BEGIN
  FOREACH spec IN ARRAY app_required
  LOOP
    fn := to_regprocedure('public.' || spec);
    IF fn IS NULL THEN
      RAISE EXCEPTION 'P0-02 基线缺少必需 app 函数: %', spec;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_app_runner', fn);
  END LOOP;

  FOREACH spec IN ARRAY sync_required
  LOOP
    fn := to_regprocedure('public.' || spec);
    IF fn IS NULL THEN
      RAISE EXCEPTION 'P0-02 基线缺少必需 sync 函数: %', spec;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_sync_runner', fn);
  END LOOP;

  FOREACH spec IN ARRAY sealed
  LOOP
    fn := to_regprocedure('public.' || spec);
    IF fn IS NULL THEN
      RAISE EXCEPTION 'P0-02 基线缺少封存函数(应拒绝): %', spec;
    END IF;
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, ice_p0_02_app_runner, ice_p0_02_sync_runner',
      fn
    );
  END LOOP;

  FOREACH spec IN ARRAY system_only
  LOOP
    fn := to_regprocedure('public.' || spec);
    IF fn IS NULL THEN
      RAISE EXCEPTION 'P0-02 基线缺少 system 函数: %', spec;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM ice_p0_02_app_runner', fn);
  END LOOP;

  -- Remaining public functions: deny runtime roles (SECURITY DEFINER included unless whitelisted above)
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM ice_p0_02_app_runner, ice_p0_02_sync_runner, PUBLIC, anon, authenticated, service_role',
      fn
    );
  END LOOP;

  -- Re-apply whitelist grants after blanket revoke
  FOREACH spec IN ARRAY app_required
  LOOP
    fn := to_regprocedure('public.' || spec);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_app_runner', fn);
  END LOOP;

  FOREACH spec IN ARRAY sync_required
  LOOP
    fn := to_regprocedure('public.' || spec);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_sync_runner', fn);
  END LOOP;
END
$$;
