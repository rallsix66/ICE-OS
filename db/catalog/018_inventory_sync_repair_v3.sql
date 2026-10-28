-- ICE catalog increment 018: inventory sync repair v3 (F2/F3 support; idempotent).
--
-- Applied by scripts/inventory/prepare-instance.mjs after 016 (fresh instance) or after 017
-- (existing v2 instance), or directly in self-verification. It must be safe to apply repeatedly.
--
-- Scope (task-9):
--  1) owner-only read policy on the old product tables so SECURITY DEFINER publish can read the
--     resolved item revision without relaxing RLS or granting runtime roles owner/superuser/BYPASSRLS;
--  2) indexes for the derived "previous successful observation" lookup (same account/warehouse/
--     source SKU/item, ordered by observation_at, published_at, batch_id);
--  3) schema_state version 3 handshake (prepare overwrites the real file hashes afterwards).
--
-- Does not touch 00001-00052 or 017.
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. Owner-only read policy on catalog.item_current / catalog.item_revision
--    (publication runs as the package owner via SECURITY DEFINER; app/sync runtime roles are not
--    owner and do not get this policy, so their direct reads keep only the existing admin path.)
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['item_current','item_revision'] LOOP
  IF to_regclass('catalog.'||t) IS NOT NULL THEN
   EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('DROP POLICY IF EXISTS inventory_definer_owner_read ON catalog.%I',t);
   EXECUTE format('CREATE POLICY inventory_definer_owner_read ON catalog.%I FOR SELECT USING (current_user=%L)',
    t,'ice_p0_02_owner');
  END IF;
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Derived predecessor indexes (F2 history / previous_batch_id)
--    batch_row already stores observation_at, so the adjacent-earlier-observation lookup can use
--    (item, source sku, observation_at) and the warehouse/observation index avoids batch scans.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS inventory_batch_row_prev_lookup
 ON catalog.inventory_batch_row(item_id,external_sku,observation_at DESC);
CREATE INDEX IF NOT EXISTS inventory_batch_warehouse_observation
 ON catalog.inventory_batch(warehouse_id,observation_at DESC,published_at DESC,id);

-- ---------------------------------------------------------------------------
-- 3. Schema version 3 handshake (prepare-instance.mjs overwrites source/functions sha256)
-- ---------------------------------------------------------------------------
INSERT INTO catalog.inventory_schema_state(id,version,source_sha256,functions_sha256,applied_at,upgraded_from)
VALUES(true,3,'pending','pending',now(),NULL)
ON CONFLICT(id) DO UPDATE SET
 version=3,
 applied_at=now(),
 upgraded_from=coalesce(catalog.inventory_schema_state.upgraded_from,'v2');

RESET ROLE;
