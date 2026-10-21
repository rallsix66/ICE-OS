SET ROLE ice_p0_02_owner;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bs_sample_export','bs_sample_inventory_row'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog.%I FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION catalog.import_bs_sample_inventory(p_request uuid, p_intent text, p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; prior jsonb; r catalog.baseline_release; e catalog.bs_sample_export; x jsonb; obs uuid; sel uuid;
 result jsonb; confirmed_count integer := 0; unselected_count integer := 0;
BEGIN
 actor := catalog.require_admin();
 prior := catalog.existing_request(p_request, p_intent, 'import_bs_sample_inventory');
 IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF p->>'sourceXlsxSha256' <> '53d88779fb10f5269cde58204d262d724d8b2a821c24df6e3c72b0d11fc77020'
 OR p->>'rowCount' <> '530' OR jsonb_array_length(p->'rows') <> 530
 OR p->>'sheetName' <> '单个SKU'
 THEN RAISE EXCEPTION 'BS_SAMPLE_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT r FROM catalog.baseline_release WHERE published ORDER BY published_at DESC NULLS LAST LIMIT 1;
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'contentSha256', 924));
 SELECT * INTO e FROM catalog.bs_sample_export WHERE release_id = r.id;
 IF FOUND THEN
  IF e.adoption_sha256 <> p->>'contentSha256' THEN RAISE EXCEPTION 'BS_SAMPLE_CONFLICT' USING ERRCODE='23505'; END IF;
  result := jsonb_build_object('exportId', e.id, 'rowCount', e.row_count, 'confirmedRows', (SELECT count(*) FROM catalog.bs_sample_inventory_row WHERE export_id=e.id AND selection_state='confirmed'), 'unselectedRows', (SELECT count(*) FROM catalog.bs_sample_inventory_row WHERE export_id=e.id AND selection_state='unselected'));
  INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,release_id,result) VALUES (p_request,p_intent,actor,'import_bs_sample_inventory',r.id,result);
  RETURN result;
 END IF;
 INSERT INTO catalog.bs_sample_export(release_id,export_label,source_xlsx_sha256,sheet_name,row_count,basis_document_sha256,adoption_sha256)
 VALUES (r.id,p->>'exportLabel',p->>'sourceXlsxSha256',p->>'sheetName',530,p->>'basisDocumentSha256',p->>'contentSha256') RETURNING * INTO e;
 FOR x IN SELECT * FROM jsonb_array_elements(p->'rows') LOOP
  SELECT o.id INTO STRICT obs FROM catalog.source_observation o
   JOIN catalog.observation_batch b ON b.id=o.batch_id AND b.release_id=r.id
   WHERE o.position->>'sourceRowKey' = x->>'sourceRowKey';
  SELECT d.selected_item_id INTO sel FROM catalog.decision_evidence d
   WHERE d.release_id=r.id AND d.observation_id=obs AND d.entry_kind='candidate_snapshot' LIMIT 1;
  IF sel IS NOT NULL THEN confirmed_count := confirmed_count + 1; ELSE unselected_count := unselected_count + 1; END IF;
  INSERT INTO catalog.bs_sample_inventory_row(export_id,excel_row,source_row_key,observation_id,warehouse,sku,on_hand,order_locked,warehouse_available,activity_reserved,in_transit,formula_ok,selection_state,selected_item_id)
  VALUES (e.id,(x->>'excelRow')::int,x->>'sourceRowKey',obs,x->>'warehouse',x->>'sku',x->>'onHand',x->>'orderLocked',x->>'warehouseAvailable',x->>'activityReserved',x->>'inTransit',CASE WHEN x->>'formulaOk' IS NULL THEN NULL ELSE (x->>'formulaOk')::boolean END, CASE WHEN sel IS NULL THEN 'unselected' ELSE 'confirmed' END, sel);
 END LOOP;
 IF confirmed_count <> 430 OR unselected_count <> 100 THEN RAISE EXCEPTION 'BS_SAMPLE_SELECTION_COUNT_INVALID' USING ERRCODE='22023'; END IF;
 result := jsonb_build_object('exportId', e.id, 'rowCount', 530, 'confirmedRows', confirmed_count, 'unselectedRows', unselected_count);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,release_id,result) VALUES (p_request,p_intent,actor,'import_bs_sample_inventory',r.id,result);
 RETURN result;
END $$;

CREATE FUNCTION catalog.read_bs_sample_display_meta() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e catalog.bs_sample_export; BEGIN PERFORM catalog.require_admin();
 SELECT * INTO e FROM catalog.bs_sample_export ORDER BY recorded_at DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('exportId',e.id,'exportLabel',e.export_label,'sourceXlsxSha256',e.source_xlsx_sha256,'rowCount',e.row_count,'basisDocumentSha256',e.basis_document_sha256,'recordedAt',e.recorded_at);
END $$;

CREATE FUNCTION catalog.read_item_bs_sample_inventory(p_item uuid, p_warehouse text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE eid uuid; BEGIN PERFORM catalog.require_admin();
 SELECT export_id INTO eid FROM catalog.bs_sample_inventory_row WHERE selected_item_id=p_item LIMIT 1;
 IF eid IS NULL THEN
  SELECT id INTO eid FROM catalog.bs_sample_export ORDER BY recorded_at DESC LIMIT 1;
 END IF;
 IF eid IS NULL THEN RETURN '[]'::jsonb; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('excelRow',r.excel_row,'sourceRowKey',r.source_row_key,'observationId',r.observation_id,'warehouse',r.warehouse,'sku',r.sku,'onHand',r.on_hand,'orderLocked',r.order_locked,'warehouseAvailable',r.warehouse_available,'activityReserved',r.activity_reserved,'inTransit',r.in_transit,'formulaOk',r.formula_ok,'selectionState',r.selection_state) ORDER BY r.excel_row)
  FROM catalog.bs_sample_inventory_row r WHERE r.export_id=eid AND (p_item IS NULL OR r.selected_item_id=p_item) AND (p_warehouse IS NULL OR r.warehouse=p_warehouse)), '[]'::jsonb);
END $$;

CREATE FUNCTION catalog.read_bs_sample_item_aggregates() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE eid uuid; BEGIN PERFORM catalog.require_admin();
 SELECT id INTO eid FROM catalog.bs_sample_export ORDER BY recorded_at DESC LIMIT 1;
 IF eid IS NULL THEN RETURN '{}'::jsonb; END IF;
 RETURN coalesce((SELECT jsonb_object_agg(item_id, payload) FROM (
  SELECT selected_item_id AS item_id, jsonb_build_object(
    'confirmedLineCount', count(*) FILTER (WHERE selection_state='confirmed'),
    'onHandSum', coalesce(string_agg(on_hand, ','), ''),
    'warehouses', jsonb_agg(DISTINCT warehouse)
  ) AS payload
  FROM catalog.bs_sample_inventory_row WHERE export_id=eid AND selected_item_id IS NOT NULL GROUP BY selected_item_id
 ) s), '{}'::jsonb);
END $$;

GRANT EXECUTE ON FUNCTION catalog.import_bs_sample_inventory(uuid,text,jsonb),catalog.read_bs_sample_display_meta(),catalog.read_item_bs_sample_inventory(uuid,text),catalog.read_bs_sample_item_aggregates() TO ice_p0_02_app_runner;
RESET ROLE;
