-- Better Auth schema ownership and auth runner grants

ALTER SCHEMA p0_02_auth OWNER TO ice_p0_02_owner;

GRANT USAGE ON SCHEMA p0_02_auth TO ice_p0_02_auth_runner;
ALTER DEFAULT PRIVILEGES FOR ROLE ice_p0_02_owner IN SCHEMA p0_02_auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ice_p0_02_auth_runner;
ALTER DEFAULT PRIVILEGES FOR ROLE ice_p0_02_owner IN SCHEMA p0_02_auth
  GRANT USAGE, SELECT ON SEQUENCES TO ice_p0_02_auth_runner;
