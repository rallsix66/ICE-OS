-- Controlled read-only identity resolution (no runtime DML on mapping table).

CREATE OR REPLACE FUNCTION p0_02_meta.resolve_profile_user_id(p_auth_user_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.ice_user_id
  FROM p0_02_meta.ice_auth_user_map m
  WHERE m.auth_user_id = p_auth_user_id
  LIMIT 1;
$$;

ALTER FUNCTION p0_02_meta.resolve_profile_user_id(text) OWNER TO ice_p0_02_owner;
REVOKE ALL ON FUNCTION p0_02_meta.resolve_profile_user_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION p0_02_meta.resolve_profile_user_id(text) TO ice_p0_02_app_runner;

GRANT USAGE ON SCHEMA auth TO ice_p0_02_app_runner;
