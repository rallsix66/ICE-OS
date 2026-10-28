-- ICE catalog increment 021: BigSeller live intake v1 (idempotent).
--
-- Applied by scripts/inventory/prepare-instance.mjs after 020. The catalog-unified read model is a
-- function-only change replayed from db/catalog/016_inventory_sync_functions.sql; this increment only
-- records the schema version handshake. Never touches 00001-00052 or the 016 structure/017/018/019/020.
SET ROLE ice_p0_02_owner;

INSERT INTO catalog.inventory_schema_state(id,version,source_sha256,functions_sha256,applied_at,upgraded_from)
VALUES(true,6,'pending','pending',now(),NULL)
ON CONFLICT(id) DO UPDATE SET
 version=6,
 applied_at=now(),
 upgraded_from=coalesce(catalog.inventory_schema_state.upgraded_from,'v5');

RESET ROLE;
