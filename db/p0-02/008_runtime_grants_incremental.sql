-- Incremental runtime grants (idempotent). Applied after 007 on every prepare.
-- auth.users: see 009_sync_reads_auth_rpc_deps.sql (admin-only audited functions).

DO $$
DECLARE
  fn regprocedure;
BEGIN
  fn := to_regprocedure('public.cleanup_expired_sync_runs()');
  IF fn IS NULL THEN
    RAISE EXCEPTION 'P0-02 基线缺少 cleanup_expired_sync_runs()';
  END IF;
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, ice_p0_02_app_runner', fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ice_p0_02_sync_runner', fn);
END
$$;
