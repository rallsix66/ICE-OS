-- P0-02 session identity (replaces Supabase auth.uid() binding; not a Supabase bootstrap).

CREATE SCHEMA IF NOT EXISTS auth;

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Legacy FK target only; identity comes from Better Auth + ice_auth_user_map.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid() TO ice_p0_02_app_runner, ice_p0_02_sync_runner;

-- Business profile UUID mapping (Better Auth user id -> profiles.id). Writes only via bootstrap/seed owner.
CREATE TABLE IF NOT EXISTS p0_02_meta.ice_auth_user_map (
  auth_user_id text PRIMARY KEY,
  ice_user_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE p0_02_meta.ice_auth_user_map OWNER TO ice_p0_02_owner;
REVOKE ALL ON p0_02_meta.ice_auth_user_map FROM PUBLIC;
REVOKE ALL ON p0_02_meta.ice_auth_user_map FROM ice_p0_02_app_runner, ice_p0_02_sync_runner, ice_p0_02_auth_runner;
