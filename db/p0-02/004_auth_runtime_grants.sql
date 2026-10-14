-- Post–Better Auth migrate: auth runner table grants (idempotent)

GRANT USAGE ON SCHEMA p0_02_auth TO ice_p0_02_auth_runner;

DO $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'p0_02_auth'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON p0_02_auth.%I TO ice_p0_02_auth_runner', tbl.tablename);
  END LOOP;
END
$$;

DO $$
DECLARE
  seq record;
BEGIN
  FOR seq IN
    SELECT sequencename
    FROM pg_sequences
    WHERE schemaname = 'p0_02_auth'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE p0_02_auth.%I TO ice_p0_02_auth_runner', seq.sequencename);
  END LOOP;
END
$$;
