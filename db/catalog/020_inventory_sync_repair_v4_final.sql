-- ICE catalog increment 020: inventory sync repair v4 final (A/B closeout; idempotent).
--
-- Applied by scripts/inventory/prepare-instance.mjs after 019 (v4 instance) or directly in
-- self-verification. Safe to apply repeatedly; never touches 00001-00052, 016 structure, 017/018/019.
--
-- Scope:
--  1) schema_state version 5 handshake. The A/B fixes are function/read-model changes replayed from
--     db/catalog/016_inventory_sync_functions.sql; no table/column change is needed.
SET ROLE ice_p0_02_owner;

INSERT INTO catalog.inventory_schema_state(id,version,source_sha256,functions_sha256,applied_at,upgraded_from)
VALUES(true,5,'pending','pending',now(),NULL)
ON CONFLICT(id) DO UPDATE SET
 version=5,
 applied_at=now(),
 upgraded_from=coalesce(catalog.inventory_schema_state.upgraded_from,'v4');

RESET ROLE;
