-- ICE catalog 023 domestic frozen snapshot: one read-only function (idempotent apply).
-- Contract: docs/tasks/inventory-sync-ui-v1.md §UI-04 / §4.
--
-- Purpose: expose the existing frozen Jushuitan (聚水潭) source observations plus their frozen
-- manual-selection link (decision_evidence.selected_item_id) and the current item identity, as the
-- DB half of the domestic table snapshot read model. The quantities themselves are NOT stored here:
-- they are read from the SHA-pinned frozen `coverage/source-records.json` by the server module.
--
-- Scope rules:
--  * stays read-only; no table, no schema-version change, no business write;
--  * frozen JST observations are identified by position.sourceRowKey 'jushuitan:%' (the frozen
--    bundle value); duplicates from a later re-import are collapsed newest-batch-first;
--  * review_state is returned as-is (manual_selected / pending / ignored / rejected / candidate);
--    only the UI decides which rows count toward the standard-product domestic total;
--  * item identity comes from the current item revision projection (read-only), never re-matched.
SET ROLE ice_p0_02_owner;

CREATE OR REPLACE FUNCTION catalog.read_inventory_domestic_links() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM catalog.require_admin();
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'legacyCandidateId', x.legacy_candidate_id,
   'reviewState', x.review_state,
   'sourceSku', x.source_sku,
   'sourceName', x.source_name,
   'sheet', x.sheet,
   'excelRow', x.excel_row,
   'itemId', x.item_id,
   'iceCode', x.ice_code,
   'itemNameCn', x.item_name_cn
 ) ORDER BY x.legacy_candidate_id),'[]'::jsonb) INTO result
 FROM (
  SELECT DISTINCT ON (o.legacy_candidate_id)
   o.legacy_candidate_id,
   o.review_state,
   o.fields->'sku'->>'raw' AS source_sku,
   o.fields->'name'->>'raw' AS source_name,
   o.position->>'sheet' AS sheet,
   CASE WHEN (o.position->>'row') ~ '^[0-9]+$' THEN (o.position->>'row')::integer END AS excel_row,
   d.selected_item_id AS item_id,
   v.ice_code_snapshot AS ice_code,
   v.name_cn AS item_name_cn
  FROM catalog.source_observation o
  JOIN catalog.observation_batch b ON b.id=o.batch_id
  LEFT JOIN catalog.decision_evidence d
   ON d.observation_id=o.id AND d.entry_kind='candidate_snapshot'
  LEFT JOIN catalog.item_current c ON c.item_id=d.selected_item_id
  LEFT JOIN catalog.item_revision v ON v.item_id=c.item_id AND v.revision=c.revision
  WHERE o.position->>'sourceRowKey' LIKE 'jushuitan:%'
   AND o.legacy_candidate_id IS NOT NULL
  ORDER BY o.legacy_candidate_id, b.recorded_at DESC, o.id
 ) x;
 RETURN result;
END $$;

-- ---------------------------------------------------------------------------
-- privileges (single function; PUBLIC keeps no EXECUTE, only the app read role does)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION catalog.read_inventory_domestic_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.read_inventory_domestic_links() TO ice_p0_02_app_runner;

RESET ROLE;
