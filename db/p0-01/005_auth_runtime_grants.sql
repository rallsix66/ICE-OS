-- P0-01 post-migrate grants for Better Auth tables in p0_01_auth

GRANT USAGE ON SCHEMA p0_01_auth TO ice_p0_01_auth_runner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA p0_01_auth TO ice_p0_01_auth_runner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA p0_01_auth TO ice_p0_01_auth_runner;

REVOKE ALL ON ALL TABLES IN SCHEMA p0_01_auth FROM ice_p0_01_app_runner;
REVOKE ALL ON ALL TABLES IN SCHEMA p0_01_auth FROM PUBLIC;
