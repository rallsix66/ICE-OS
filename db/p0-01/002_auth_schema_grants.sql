-- P0-01 auth schema defaults (before Better Auth migrate)

GRANT USAGE ON SCHEMA p0_01_auth TO ice_p0_01_auth_runner;
ALTER DEFAULT PRIVILEGES FOR ROLE ice_p0_01_owner IN SCHEMA p0_01_auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ice_p0_01_auth_runner;

REVOKE ALL ON SCHEMA p0_01_auth FROM ice_p0_01_app_runner;
REVOKE ALL ON SCHEMA p0_01_auth FROM PUBLIC;
