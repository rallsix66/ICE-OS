-- P0-02 sync runner RLS: scoped background access without bypassing RLS or faking user identity.

CREATE OR REPLACE FUNCTION p0_02_meta.is_sync_runner()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT current_user = 'ice_p0_02_sync_runner';
$$;

CREATE OR REPLACE FUNCTION p0_02_meta.sync_mode()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('p0_02.sync.mode', true), '');
$$;

CREATE OR REPLACE FUNCTION p0_02_meta.sync_warehouse_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('p0_02.sync.warehouse_id', true), '')::uuid;
$$;

REVOKE ALL ON FUNCTION p0_02_meta.is_sync_runner() FROM PUBLIC;
REVOKE ALL ON FUNCTION p0_02_meta.sync_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION p0_02_meta.sync_warehouse_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION p0_02_meta.is_sync_runner() TO ice_p0_02_app_runner, ice_p0_02_sync_runner;
GRANT EXECUTE ON FUNCTION p0_02_meta.sync_mode() TO ice_p0_02_app_runner, ice_p0_02_sync_runner;
GRANT EXECUTE ON FUNCTION p0_02_meta.sync_warehouse_id() TO ice_p0_02_app_runner, ice_p0_02_sync_runner;

-- Sync runner must EXECUTE role/scope helpers referenced by app-user RLS policies so those
-- policies evaluate to false instead of raising 42501 during permissive OR checks.
GRANT EXECUTE ON FUNCTION public.get_user_role() TO ice_p0_02_sync_runner;
GRANT EXECUTE ON FUNCTION public.get_assigned_warehouse_ids() TO ice_p0_02_sync_runner;

-- GoLucky cron / external tracking sync (global active refs, no end-user JWT).
DROP POLICY IF EXISTS sync_golucky_select_shipment_external_ref ON public.shipment_external_ref;
CREATE POLICY sync_golucky_select_shipment_external_ref ON public.shipment_external_ref
  FOR SELECT
  USING (p0_02_meta.is_sync_runner() AND p0_02_meta.sync_mode() = 'golucky');

DROP POLICY IF EXISTS sync_golucky_update_shipment_external_ref ON public.shipment_external_ref;
CREATE POLICY sync_golucky_update_shipment_external_ref ON public.shipment_external_ref
  FOR UPDATE
  USING (p0_02_meta.is_sync_runner() AND p0_02_meta.sync_mode() = 'golucky')
  WITH CHECK (p0_02_meta.is_sync_runner() AND p0_02_meta.sync_mode() = 'golucky');

DROP POLICY IF EXISTS sync_golucky_insert_tracking_event_external ON public.tracking_event_external;
CREATE POLICY sync_golucky_insert_tracking_event_external ON public.tracking_event_external
  FOR INSERT
  WITH CHECK (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'golucky'
    AND provider = 'golucky'
    AND EXISTS (
      SELECT 1
      FROM public.shipment_external_ref r
      WHERE r.id = external_ref_id
        AND r.provider = 'golucky'
    )
  );

DROP POLICY IF EXISTS sync_golucky_select_tracking_event_external ON public.tracking_event_external;
CREATE POLICY sync_golucky_select_tracking_event_external ON public.tracking_event_external
  FOR SELECT
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'golucky'
    AND provider = 'golucky'
    AND EXISTS (
      SELECT 1
      FROM public.shipment_external_ref r
      WHERE r.id = external_ref_id
        AND r.provider = 'golucky'
    )
  );

-- BigSeller / inventory sync: warehouse-scoped reads and writes.
DROP POLICY IF EXISTS sync_discover_select_warehouse ON public.warehouse;
CREATE POLICY sync_discover_select_warehouse ON public.warehouse
  FOR SELECT
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'discover'
    AND type = 'overseas'
    AND is_active = true
  );

DROP POLICY IF EXISTS sync_warehouse_select_warehouse ON public.warehouse;
CREATE POLICY sync_warehouse_select_warehouse ON public.warehouse
  FOR SELECT
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND id = p0_02_meta.sync_warehouse_id()
  );

DROP POLICY IF EXISTS sync_warehouse_select_product ON public.product;
CREATE POLICY sync_warehouse_select_product ON public.product
  FOR SELECT
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND p0_02_meta.sync_warehouse_id() IS NOT NULL
  );

DROP POLICY IF EXISTS sync_warehouse_select_product_variant ON public.product_variant;
CREATE POLICY sync_warehouse_select_product_variant ON public.product_variant
  FOR SELECT
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND EXISTS (
      SELECT 1
      FROM public.warehouse w
      WHERE w.id = p0_02_meta.sync_warehouse_id()
        AND w.country = product_variant.country
    )
  );

DROP POLICY IF EXISTS sync_warehouse_select_inventory ON public.inventory;
CREATE POLICY sync_warehouse_select_inventory ON public.inventory
  FOR SELECT
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND warehouse_id = p0_02_meta.sync_warehouse_id()
  );

DROP POLICY IF EXISTS sync_warehouse_update_inventory ON public.inventory;
CREATE POLICY sync_warehouse_update_inventory ON public.inventory
  FOR UPDATE
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND warehouse_id = p0_02_meta.sync_warehouse_id()
  )
  WITH CHECK (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND warehouse_id = p0_02_meta.sync_warehouse_id()
  );

-- sync_log INSERT/SELECT for execute_plan_v2 (RETURNING requires SELECT policy).
DROP POLICY IF EXISTS sync_warehouse_insert_sync_log ON public.sync_log;
CREATE POLICY sync_warehouse_insert_sync_log ON public.sync_log
  FOR INSERT
  WITH CHECK (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND warehouse_id = p0_02_meta.sync_warehouse_id()
  );

DROP POLICY IF EXISTS sync_warehouse_select_sync_log ON public.sync_log;
CREATE POLICY sync_warehouse_select_sync_log ON public.sync_log
  FOR SELECT
  USING (
    p0_02_meta.is_sync_runner()
    AND p0_02_meta.sync_mode() = 'warehouse'
    AND warehouse_id = p0_02_meta.sync_warehouse_id()
  );
