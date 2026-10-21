-- BS sample display tables were created after catalog-wide RLS bootstrap; enforce admin-only RLS and revoke direct app DML/SELECT.
SET ROLE ice_p0_02_owner;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bs_sample_export', 'bs_sample_inventory_row'] LOOP
  EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS enabled_admin ON catalog.%I', t);
  EXECUTE format('CREATE POLICY enabled_admin ON catalog.%I FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin())', t);
 END LOOP;
END $$;

REVOKE ALL ON TABLE catalog.bs_sample_export, catalog.bs_sample_inventory_row FROM ice_p0_02_app_runner;

RESET ROLE;
