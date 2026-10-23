SET ROLE ice_p0_02_owner;

CREATE FUNCTION catalog.read_baseline_item_amounts_map() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM catalog.require_admin();
 SELECT coalesce(jsonb_object_agg(c.item_id::text, f.payload), '{}'::jsonb)
 INTO result
 FROM catalog.item_current c
 JOIN catalog.catalog_item i ON i.id = c.item_id
 JOIN catalog_private.item_financial_revision f ON f.item_id = c.item_id AND f.financial_revision = c.financial_revision
 WHERE i.first_release_id IS NOT NULL AND c.financial_revision IS NOT NULL;
 RETURN result;
END $$;

GRANT EXECUTE ON FUNCTION catalog.read_baseline_item_amounts_map() TO ice_p0_02_app_runner;

RESET ROLE;
