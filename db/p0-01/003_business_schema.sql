-- P0-01 business entities (owner: ice_p0_01_owner)

SET search_path = p0_01_biz, public;

CREATE TABLE IF NOT EXISTS ice_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'operator')),
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ice_auth_user_map (
  auth_user_id text PRIMARY KEY,
  ice_user_id uuid NOT NULL UNIQUE REFERENCES ice_users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS markets (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouses (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES markets (id),
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS user_market_grants (
  user_id uuid NOT NULL REFERENCES ice_users (id) ON DELETE CASCADE,
  market_id uuid NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, market_id)
);

CREATE TABLE IF NOT EXISTS user_warehouse_grants (
  user_id uuid NOT NULL REFERENCES ice_users (id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS user_amount_grants (
  user_id uuid NOT NULL REFERENCES ice_users (id) ON DELETE CASCADE,
  market_id uuid NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, market_id)
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  ice_code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku_label text NOT NULL,
  UNIQUE (product_id, sku_label)
);

CREATE TABLE IF NOT EXISTS inventory (
  id uuid PRIMARY KEY,
  product_variant_id uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  UNIQUE (product_variant_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS inventory_unit_costs (
  product_variant_id uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
  unit_cost_excl_freight numeric(12, 4) NOT NULL CHECK (unit_cost_excl_freight >= 0),
  currency text NOT NULL DEFAULT 'CNY',
  PRIMARY KEY (product_variant_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_warehouse ON inventory (warehouse_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_market ON warehouses (market_id);

ALTER TABLE ice_users OWNER TO ice_p0_01_owner;
ALTER TABLE ice_auth_user_map OWNER TO ice_p0_01_owner;
ALTER TABLE markets OWNER TO ice_p0_01_owner;
ALTER TABLE warehouses OWNER TO ice_p0_01_owner;
ALTER TABLE user_market_grants OWNER TO ice_p0_01_owner;
ALTER TABLE user_warehouse_grants OWNER TO ice_p0_01_owner;
ALTER TABLE user_amount_grants OWNER TO ice_p0_01_owner;
ALTER TABLE products OWNER TO ice_p0_01_owner;
ALTER TABLE product_variants OWNER TO ice_p0_01_owner;
ALTER TABLE inventory OWNER TO ice_p0_01_owner;
ALTER TABLE inventory_unit_costs OWNER TO ice_p0_01_owner;

REVOKE ALL ON ALL TABLES IN SCHEMA p0_01_biz FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA p0_01_biz FROM ice_p0_01_auth_runner;

GRANT USAGE ON SCHEMA p0_01_biz TO ice_p0_01_app_runner;
GRANT SELECT ON ALL TABLES IN SCHEMA p0_01_biz TO ice_p0_01_app_runner;

GRANT USAGE ON SCHEMA p0_01_biz TO ice_p0_01_auth_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ice_auth_user_map TO ice_p0_01_auth_runner;
GRANT SELECT ON ice_users TO ice_p0_01_auth_runner;

ALTER TABLE ice_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ice_auth_user_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_market_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_warehouse_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_amount_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_unit_costs ENABLE ROW LEVEL SECURITY;
