-- P0-01 RLS policies (transaction-local identity via set_config 'ice.user_id')

SET search_path = p0_01_biz, public;

CREATE OR REPLACE FUNCTION p0_01_biz.current_ice_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('ice.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION p0_01_biz.current_user_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = p0_01_biz, public
AS $$
  SELECT COALESCE(
    (
      SELECT u.is_enabled
      FROM p0_01_biz.ice_users u
      WHERE u.id = p0_01_biz.current_ice_user_id()
    ),
    false
  );
$$;

ALTER FUNCTION p0_01_biz.current_ice_user_id() OWNER TO ice_p0_01_owner;
ALTER FUNCTION p0_01_biz.current_user_enabled() OWNER TO ice_p0_01_owner;

GRANT EXECUTE ON FUNCTION p0_01_biz.current_ice_user_id() TO ice_p0_01_app_runner;
GRANT EXECUTE ON FUNCTION p0_01_biz.current_user_enabled() TO ice_p0_01_app_runner;

CREATE OR REPLACE FUNCTION p0_01_biz.resolve_ice_user_id(p_auth_user_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = p0_01_biz, public
AS $$
  SELECT m.ice_user_id
  FROM p0_01_biz.ice_auth_user_map m
  WHERE m.auth_user_id = p_auth_user_id
  LIMIT 1;
$$;

ALTER FUNCTION p0_01_biz.resolve_ice_user_id(text) OWNER TO ice_p0_01_owner;
GRANT EXECUTE ON FUNCTION p0_01_biz.resolve_ice_user_id(text) TO ice_p0_01_app_runner;

CREATE OR REPLACE FUNCTION p0_01_biz.load_ice_user_for_session(p_ice_user_id uuid)
RETURNS TABLE (
  id uuid,
  email text,
  display_name text,
  role text,
  is_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = p0_01_biz, public
AS $$
  SELECT u.id, u.email, u.display_name, u.role, u.is_enabled
  FROM p0_01_biz.ice_users u
  WHERE u.id = p_ice_user_id;
$$;

ALTER FUNCTION p0_01_biz.load_ice_user_for_session(uuid) OWNER TO ice_p0_01_owner;
GRANT EXECUTE ON FUNCTION p0_01_biz.load_ice_user_for_session(uuid) TO ice_p0_01_app_runner;

DROP POLICY IF EXISTS ice_users_self_read ON ice_users;
DROP POLICY IF EXISTS grants_market_read ON user_market_grants;
DROP POLICY IF EXISTS grants_warehouse_read ON user_warehouse_grants;
DROP POLICY IF EXISTS grants_amount_read ON user_amount_grants;
DROP POLICY IF EXISTS markets_read ON markets;
DROP POLICY IF EXISTS warehouses_read ON warehouses;
DROP POLICY IF EXISTS products_read ON products;
DROP POLICY IF EXISTS variants_read ON product_variants;
DROP POLICY IF EXISTS inventory_read ON inventory;
DROP POLICY IF EXISTS inventory_costs_read ON inventory_unit_costs;
DROP POLICY IF EXISTS ice_auth_map_deny_app ON ice_auth_user_map;

CREATE POLICY ice_users_self_read ON ice_users
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (id = p0_01_biz.current_ice_user_id() AND p0_01_biz.current_user_enabled());

CREATE POLICY grants_market_read ON user_market_grants
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (user_id = p0_01_biz.current_ice_user_id() AND p0_01_biz.current_user_enabled());

CREATE POLICY grants_warehouse_read ON user_warehouse_grants
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (user_id = p0_01_biz.current_ice_user_id() AND p0_01_biz.current_user_enabled());

CREATE POLICY grants_amount_read ON user_amount_grants
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (user_id = p0_01_biz.current_ice_user_id() AND p0_01_biz.current_user_enabled());

CREATE POLICY markets_read ON markets
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (
    p0_01_biz.current_user_enabled()
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_market_grants mg
      WHERE mg.user_id = p0_01_biz.current_ice_user_id()
        AND mg.market_id = markets.id
    )
  );

CREATE POLICY warehouses_read ON warehouses
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (
    p0_01_biz.current_user_enabled()
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_warehouse_grants wg
      WHERE wg.user_id = p0_01_biz.current_ice_user_id()
        AND wg.warehouse_id = warehouses.id
    )
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_market_grants mg
      WHERE mg.user_id = p0_01_biz.current_ice_user_id()
        AND mg.market_id = warehouses.market_id
    )
  );

CREATE POLICY products_read ON products
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (p0_01_biz.current_user_enabled());

CREATE POLICY variants_read ON product_variants
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (p0_01_biz.current_user_enabled());

CREATE POLICY inventory_read ON inventory
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (
    p0_01_biz.current_user_enabled()
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_warehouse_grants wg
      WHERE wg.user_id = p0_01_biz.current_ice_user_id()
        AND wg.warehouse_id = inventory.warehouse_id
    )
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_market_grants mg
      INNER JOIN p0_01_biz.warehouses w
        ON w.market_id = mg.market_id
       AND w.id = inventory.warehouse_id
      WHERE mg.user_id = p0_01_biz.current_ice_user_id()
    )
  );

CREATE POLICY inventory_costs_read ON inventory_unit_costs
  FOR SELECT
  TO ice_p0_01_app_runner
  USING (
    p0_01_biz.current_user_enabled()
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_amount_grants ag
      INNER JOIN p0_01_biz.warehouses w
        ON w.market_id = ag.market_id
       AND w.id = inventory_unit_costs.warehouse_id
      WHERE ag.user_id = p0_01_biz.current_ice_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_warehouse_grants wg
      WHERE wg.user_id = p0_01_biz.current_ice_user_id()
        AND wg.warehouse_id = inventory_unit_costs.warehouse_id
    )
    AND EXISTS (
      SELECT 1
      FROM p0_01_biz.user_market_grants mg
      INNER JOIN p0_01_biz.warehouses w
        ON w.market_id = mg.market_id
       AND w.id = inventory_unit_costs.warehouse_id
      WHERE mg.user_id = p0_01_biz.current_ice_user_id()
    )
  );

CREATE POLICY ice_auth_map_deny_app ON ice_auth_user_map
  FOR ALL
  TO ice_p0_01_app_runner
  USING (false)
  WITH CHECK (false);

DROP FUNCTION IF EXISTS p0_01_biz.can_access_warehouse(uuid);
DROP FUNCTION IF EXISTS p0_01_biz.can_read_amount_for_warehouse(uuid);
