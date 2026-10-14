-- P0-01 experimental bootstrap: roles and instance marker (run as bootstrap superuser)

CREATE SCHEMA IF NOT EXISTS p0_01_meta;
CREATE SCHEMA IF NOT EXISTS p0_01_auth;
CREATE SCHEMA IF NOT EXISTS p0_01_biz;

CREATE TABLE IF NOT EXISTS p0_01_meta.platform_instance (
  run_id text PRIMARY KEY,
  label text NOT NULL DEFAULT 'p0-01',
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ice_p0_01_owner') THEN
    CREATE ROLE ice_p0_01_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ice_p0_01_auth_runner') THEN
    CREATE ROLE ice_p0_01_auth_runner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ice_p0_01_app_runner') THEN
    CREATE ROLE ice_p0_01_app_runner LOGIN;
  END IF;
END
$$;

ALTER ROLE ice_p0_01_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ice_p0_01_auth_runner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ice_p0_01_app_runner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON SCHEMA public FROM ice_p0_01_auth_runner, ice_p0_01_app_runner;
GRANT USAGE ON SCHEMA p0_01_meta TO ice_p0_01_app_runner;
GRANT SELECT ON p0_01_meta.platform_instance TO ice_p0_01_app_runner;

ALTER SCHEMA p0_01_auth OWNER TO ice_p0_01_owner;
ALTER SCHEMA p0_01_biz OWNER TO ice_p0_01_owner;
ALTER SCHEMA p0_01_meta OWNER TO ice_p0_01_owner;

GRANT ice_p0_01_owner TO CURRENT_USER;
