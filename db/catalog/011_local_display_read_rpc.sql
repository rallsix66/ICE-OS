SET ROLE ice_p0_02_owner;

CREATE FUNCTION catalog.read_bs_sample_inventory_rows() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE eid uuid;
BEGIN
 PERFORM catalog.require_admin();
 SELECT id INTO eid FROM catalog.bs_sample_export ORDER BY recorded_at DESC LIMIT 1;
 IF eid IS NULL THEN RETURN '[]'::jsonb; END IF;
 RETURN coalesce((
  SELECT jsonb_agg(jsonb_build_object(
    'itemId', r.selected_item_id,
    'excelRow', r.excel_row,
    'warehouse', r.warehouse,
    'sku', r.sku,
    'onHand', r.on_hand,
    'orderLocked', r.order_locked,
    'warehouseAvailable', r.warehouse_available,
    'activityReserved', r.activity_reserved,
    'inTransit', r.in_transit,
    'selectionState', r.selection_state,
    'observationId', r.observation_id,
    'formulaOk', r.formula_ok
  ) ORDER BY r.excel_row)
  FROM catalog.bs_sample_inventory_row r
  WHERE r.export_id = eid
 ), '[]'::jsonb);
END $$;

GRANT EXECUTE ON FUNCTION catalog.read_bs_sample_inventory_rows() TO ice_p0_02_app_runner;

RESET ROLE;
