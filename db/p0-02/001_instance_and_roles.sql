-- P0-02 full-app bootstrap: instance marker and runtime roles (bootstrap superuser)

CREATE SCHEMA IF NOT EXISTS p0_02_meta;
CREATE SCHEMA IF NOT EXISTS p0_02_auth;

CREATE TABLE IF NOT EXISTS p0_02_meta.platform_instance (
  run_id text PRIMARY KEY,
  label text NOT NULL DEFAULT 'p0-02',
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ice_p0_02_owner') THEN
    CREATE ROLE ice_p0_02_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ice_p0_02_auth_runner') THEN
    CREATE ROLE ice_p0_02_auth_runner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ice_p0_02_app_runner') THEN
    CREATE ROLE ice_p0_02_app_runner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ice_p0_02_sync_runner') THEN
    CREATE ROLE ice_p0_02_sync_runner LOGIN;
  END IF;
END
$$;

ALTER ROLE ice_p0_02_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ice_p0_02_auth_runner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ice_p0_02_app_runner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ice_p0_02_sync_runner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

ALTER SCHEMA p0_02_auth OWNER TO ice_p0_02_owner;
ALTER SCHEMA p0_02_meta OWNER TO ice_p0_02_owner;

GRANT USAGE ON SCHEMA p0_02_meta TO ice_p0_02_app_runner, ice_p0_02_sync_runner;
GRANT SELECT ON p0_02_meta.platform_instance TO ice_p0_02_app_runner, ice_p0_02_sync_runner;

GRANT ice_p0_02_owner TO CURRENT_USER;
