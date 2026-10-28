-- ICE catalog increment 019: inventory sync repair v4 (R2 complete-content binding support; idempotent).
--
-- Applied by scripts/inventory/prepare-instance.mjs after 018 (fresh/v3 instance) or directly in
-- self-verification. Safe to apply repeatedly; never touches 00001-00052, 016 structure, 017 or 018.
--
-- Scope:
--  1) lookup indexes used by the R1 source-presence read model (latest registered run rows by
--     warehouse + source SKU) and by "known encodings" resolution (item/candidate);
--  2) schema_state version 4 handshake (prepare overwrites the real file hashes afterwards).
SET ROLE ice_p0_02_owner;

-- ---------------------------------------------------------------------------
-- 1. Read-model lookup indexes (idempotent)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS inventory_run_row_warehouse_sku
 ON catalog.inventory_run_row(run_id,warehouse_external_id,external_sku)
 WHERE parse_status='ok';
CREATE INDEX IF NOT EXISTS inventory_mapping_candidate_item
 ON catalog.inventory_mapping_candidate(account_id,suggested_item_id)
 WHERE status='pending';

-- ---------------------------------------------------------------------------
-- 2. Schema version 4 handshake (prepare-instance.mjs overwrites source/functions sha256)
-- ---------------------------------------------------------------------------
INSERT INTO catalog.inventory_schema_state(id,version,source_sha256,functions_sha256,applied_at,upgraded_from)
VALUES(true,4,'pending','pending',now(),NULL)
ON CONFLICT(id) DO UPDATE SET
 version=4,
 applied_at=now(),
 upgraded_from=coalesce(catalog.inventory_schema_state.upgraded_from,'v3');

RESET ROLE;
