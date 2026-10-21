SET ROLE ice_p0_02_owner;

CREATE FUNCTION catalog.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p JOIN public.role r ON r.id=p.role_id
  WHERE p.id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid AND p.is_active AND r.name='admin')
$$;
CREATE FUNCTION catalog.require_admin() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT catalog.is_admin() THEN RAISE EXCEPTION 'CATALOG_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
END $$;

-- Immutable histories stay immutable even if a future grant accidentally adds DML.
CREATE FUNCTION catalog.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'CATALOG_IMMUTABLE' USING ERRCODE='42501'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['artifact','catalog_item','catalog_item_code','baseline_item_anchor','item_revision',
 'source_namespace','source_dataset','observation_batch','source_observation','decision_evidence','audit_event'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog.%I FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['artifact_handle','item_financial_revision','observation_amounts'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON catalog_private.%I FOR EACH ROW EXECUTE FUNCTION catalog.reject_history_mutation()',t);
 END LOOP;
END $$;

DO $$ DECLARE s text; t text; BEGIN
 FOREACH s IN ARRAY ARRAY['catalog','catalog_private'] LOOP
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname=s LOOP
 EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',s,t);
 EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',s,t);
 EXECUTE format('CREATE POLICY enabled_admin ON %I.%I FOR ALL USING (catalog.is_admin()) WITH CHECK (catalog.is_admin())',s,t);
 END LOOP; END LOOP;
END $$;

CREATE FUNCTION catalog.existing_request(p_request uuid,p_intent text,p_action text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a catalog.audit_event;
BEGIN
 PERFORM catalog.require_admin();
 IF p_request IS NULL OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p_action IS NULL THEN
  RAISE EXCEPTION 'CATALOG_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text, 922));
 SELECT * INTO a FROM catalog.audit_event WHERE request_id=p_request;
 IF FOUND THEN
  IF a.intent_sha256<>p_intent OR a.actor_id<>catalog.require_admin() OR a.action<>p_action THEN RAISE EXCEPTION 'CATALOG_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN a.result;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION catalog.publish_baseline(p_request uuid,p_intent text,p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; prior jsonb; r catalog.baseline_release; a jsonb; x jsonb;
 art uuid; bundle_art uuid; csv_art uuid; item uuid; ns uuid; ds uuid; batch uuid; obs uuid; target uuid;
 target_row integer; target_code text; system_name text; result jsonb;
BEGIN
 actor:=catalog.require_admin(); prior:=catalog.existing_request(p_request,p_intent,'publish_baseline'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF p->>'bundleSha256'<>'28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae'
 OR p->>'effectiveCsvSha256'<>'4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14'
 OR jsonb_array_length(p->'items')<>126 OR jsonb_array_length(p->'observations')<>1417
 OR jsonb_array_length(p->'fullManifest')<>147 OR jsonb_array_length(p->'subsetManifest')<>129
 OR (SELECT count(*) FROM jsonb_array_elements(p->'items') i WHERE i->>'iceCode' IS NOT NULL)<>125
 OR (SELECT count(*) FROM jsonb_array_elements(p->'decisions') d WHERE d->>'entryKind'='effective_csv_record')<>3160
 OR (SELECT count(*) FROM jsonb_array_elements(p->'decisions') d WHERE d->>'entryKind'='candidate_snapshot' AND d->>'selectedItemAnchor' IS NOT NULL)<>548
 THEN RAISE EXCEPTION 'CATALOG_INVALID_BASELINE' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'bundleSha256',923));
 SELECT * INTO r FROM catalog.baseline_release WHERE bundle_sha256=p->>'bundleSha256' AND effective_csv_sha256=p->>'effectiveCsvSha256';
 IF FOUND THEN
  IF r.release_key<>p->>'releaseKey' OR r.parser_version<>p->>'parserVersion' OR r.adoption_sha256<>p->>'contentSha256' OR NOT r.published THEN
   RAISE EXCEPTION 'CATALOG_BASELINE_CONFLICT' USING ERRCODE='23505';
  END IF;
 ELSE
  INSERT INTO catalog.baseline_release(release_key,bundle_sha256,effective_csv_sha256,parser_version,adoption_sha256,manifest)
  VALUES(p->>'releaseKey',p->>'bundleSha256',p->>'effectiveCsvSha256',p->>'parserVersion',p->>'contentSha256',p->'counts') RETURNING * INTO r;
  FOR a IN SELECT * FROM jsonb_array_elements(p->'artifacts') LOOP
   INSERT INTO catalog.artifact(release_id,logical_name,sha256,size_bytes,format,sensitivity)
   VALUES(r.id,a->>'logicalName',a->>'sha256',(a->>'size')::bigint,a->>'format','restricted') RETURNING id INTO art;
   INSERT INTO catalog_private.artifact_handle VALUES(art,a->>'storageHandle');
  END LOOP;
  SELECT id INTO STRICT bundle_art FROM catalog.artifact WHERE release_id=r.id AND logical_name='match-bundle.json';
  SELECT id INTO STRICT csv_art FROM catalog.artifact WHERE release_id=r.id AND logical_name='manual-decisions.effective.csv';
  FOR x IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
   INSERT INTO catalog.catalog_item(first_release_id,new_product_confirmed,confirmation_ref)
   VALUES(r.id,(x->>'newProductConfirmed')::boolean,CASE WHEN (x->>'newProductConfirmed')::boolean THEN 'user-confirmed-new-product:master-row-122' ELSE NULL END) RETURNING id INTO item;
   INSERT INTO catalog.baseline_item_anchor VALUES(r.id,bundle_art,x->>'anchorPointer',item,(x->>'rowPosition')::integer,x->>'payloadSha256');
   IF x->>'iceCode' IS NOT NULL THEN
    INSERT INTO catalog.catalog_item_code(item_id,ice_code,evidence_ref) VALUES(item,x->>'iceCode',x->>'rawRef');
   END IF;
   INSERT INTO catalog.item_revision(item_id,revision,name_cn,ice_code_snapshot,fields,artifact_id,evidence_ref,reason,actor_id)
   VALUES(item,1,x->>'nameCn',x->>'iceCode',x->'fields',bundle_art,x->>'rawRef','accepted frozen baseline',actor);
   INSERT INTO catalog_private.item_financial_revision VALUES(item,1,x->'financial');
   INSERT INTO catalog.item_current VALUES(item,1,CASE WHEN
    (x->'financial'->'cost'->>'state'='observed' AND x->'financial'->'cost'->>'meaning'='value') OR
    (x->'financial'->'operatingPrice'->>'state'='observed' AND x->'financial'->'operatingPrice'->>'meaning'='value')
    THEN 1 ELSE NULL END);
  END LOOP;
  FOREACH system_name IN ARRAY ARRAY['bigseller','jushuitan'] LOOP
   INSERT INTO catalog.source_namespace(system,local_key,account_scope)
   VALUES(system_name,'p003-final-v2:'||system_name,'{"state":"unknown","raw":null,"reason":"Frozen source account not verified"}') RETURNING id INTO ns;
   INSERT INTO catalog.source_dataset(namespace_id,local_dataset_key,resource_identity,key_contract)
   VALUES(ns,'p003-final-v2','{"state":"unknown","reason":"Frozen final-bundle derivative; not a vendor account"}',
    '{"mode":"observe_only","version":"catalog-identity-v1","sourceIdentityVerified":false}') RETURNING id INTO ds;
   INSERT INTO catalog.observation_batch(dataset_id,release_id,artifact_id,snapshot_key,content_sha256,coverage)
   VALUES(ds,r.id,bundle_art,p->>'bundleSha256',p->>'bundleSha256','{"complete":true,"meaning":"complete frozen bundle candidates, not complete live vendor account"}') RETURNING id INTO batch;
   FOR x IN SELECT * FROM jsonb_array_elements(p->'observations') o WHERE o->>'system'=system_name LOOP
    INSERT INTO catalog.source_observation(batch_id,artifact_id,entry_key,legacy_candidate_id,position,scope,fields,review_state,raw_ref,payload_sha256)
    VALUES(batch,bundle_art,x->>'entryKey',x->>'legacyCandidateId',x->'position',x->'scope',x->'fields',x->>'reviewState',x->>'rawRef',x->>'payloadSha256') RETURNING id INTO obs;
    INSERT INTO catalog_private.observation_amounts VALUES(obs,x->'amounts');
   END LOOP;
  END LOOP;
  FOR x IN SELECT * FROM jsonb_array_elements(p->'decisions') LOOP
   target:=NULL; obs:=NULL;
   IF x->>'entryKind'='candidate_snapshot' THEN
    -- A nested JST payload pointer is evidence in this fixed artifact, not a
    -- long-term source identity. Its target must nevertheless be traceable to
    -- exactly one saved JST observation in this release before publishing.
    IF x->>'selectedJushuitanRef' IS NULL THEN
     IF x->>'selectedJushuitanSha256' IS NOT NULL OR x->'summary'->>'selectedJushuitanCandidateId' IS NOT NULL THEN
      RAISE EXCEPTION 'CATALOG_JST_REFERENCE_INVALID' USING ERRCODE='22023';
     END IF;
    ELSE
     IF x->>'selectedJushuitanRef' <> 'match-bundle.json#'||(x->>'entryKey')||'/selected_jushuitan'
     OR x->>'selectedJushuitanSha256' IS NULL OR x->>'selectedJushuitanSha256' !~ '^[a-f0-9]{64}$'
     OR x->'summary'->>'selectedJushuitanCandidateId' IS NULL
     OR (SELECT count(*) FROM catalog.source_observation jo
      JOIN catalog.observation_batch jb ON jb.id=jo.batch_id
      JOIN catalog.source_dataset jd ON jd.id=jb.dataset_id
      JOIN catalog.source_namespace jn ON jn.id=jd.namespace_id
      WHERE jb.release_id=r.id AND jn.system='jushuitan'
      AND jo.legacy_candidate_id=x->'summary'->>'selectedJushuitanCandidateId') <> 1 THEN
      RAISE EXCEPTION 'CATALOG_JST_REFERENCE_INVALID' USING ERRCODE='22023';
     END IF;
    END IF;
   END IF;
   IF x->>'selectedItemAnchor' IS NOT NULL THEN
    SELECT a.item_id,a.row_position,v.ice_code_snapshot INTO STRICT target,target_row,target_code
    FROM catalog.baseline_item_anchor a JOIN catalog.item_revision v ON v.item_id=a.item_id AND v.revision=1
    WHERE a.release_id=r.id AND a.json_pointer=x->>'selectedItemAnchor';
   END IF;
   IF x->>'entryKind'='candidate_snapshot' THEN
    -- This only validates the frozen selection against its original baseline
    -- target. A different existing anchor must not contradict the preserved
    -- summary; current codes or later revisions are not the baseline authority.
    IF target IS NOT NULL THEN
     IF jsonb_typeof(x->'summary'->'selectedMasterRow') IS DISTINCT FROM 'number'
     OR jsonb_typeof(x->'summary'->'selectedMasterCode') IS DISTINCT FROM 'string'
     OR x->'summary'->'selectedMasterRow' IS DISTINCT FROM to_jsonb(target_row)
     OR target_code IS NULL OR length(target_code)=0
     OR x->'summary'->>'selectedMasterCode' IS DISTINCT FROM target_code THEN
      RAISE EXCEPTION 'CATALOG_BASELINE_TARGET_INVALID' USING ERRCODE='22023';
     END IF;
    ELSIF x->'summary'->>'selectedMasterRow' IS NOT NULL OR x->'summary'->>'selectedMasterCode' IS NOT NULL THEN
     RAISE EXCEPTION 'CATALOG_BASELINE_TARGET_INVALID' USING ERRCODE='22023';
    END IF;
   END IF;
   IF x->>'observationEntryKey' IS NOT NULL THEN
    SELECT o.id INTO STRICT obs FROM catalog.source_observation o JOIN catalog.observation_batch b ON b.id=o.batch_id
    WHERE b.release_id=r.id AND o.entry_key=x->>'observationEntryKey';
   END IF;
   art:=CASE WHEN x->>'entryKind'='effective_csv_record' THEN csv_art ELSE bundle_art END;
   INSERT INTO catalog.decision_evidence(release_id,artifact_id,entry_kind,entry_key,observation_id,selected_item_id,selected_jushuitan_ref,selected_jushuitan_sha256,review_state,payload_sha256,raw_ref,summary)
   VALUES(r.id,art,x->>'entryKind',x->>'entryKey',obs,target,x->>'selectedJushuitanRef',x->>'selectedJushuitanSha256',x->>'reviewState',x->>'payloadSha256',x->>'rawRef',x->'summary');
  END LOOP;
  UPDATE catalog.baseline_release SET published=true,published_at=now() WHERE id=r.id;
 END IF;
 result:=jsonb_build_object('releaseId',r.id,'published',true,'itemCount',126,'observationCount',1417,'selectedCount',548);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,release_id,result) VALUES(p_request,p_intent,actor,'publish_baseline',r.id,result);
 RETURN result;
END $$;

CREATE FUNCTION catalog.assign_initial_code(p_request uuid,p_intent text,p_item uuid,p_expected integer,p_code text,p_reason text,p_evidence text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; prior jsonb; c catalog.item_current; v catalog.item_revision; result jsonb;
BEGIN
 actor:=catalog.require_admin(); prior:=catalog.existing_request(p_request,p_intent,'assign_initial_code'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF p_item IS NULL OR p_expected IS NULL OR p_expected<=0 OR p_code IS NULL OR length(p_code)>50 OR length(btrim(p_code))=0 OR btrim(p_code)<>p_code
 OR p_code ~ '^[[:space:]]|[[:space:]]$' OR p_reason IS NULL OR length(btrim(p_reason))=0 OR length(p_reason)>1000
 OR p_evidence IS NULL OR length(btrim(p_evidence))=0 OR length(p_evidence)>500 THEN
  RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT c FROM catalog.item_current WHERE item_id=p_item FOR UPDATE;
 IF c.revision<>p_expected THEN RAISE EXCEPTION 'CATALOG_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM catalog.catalog_item_code WHERE item_id=p_item) THEN RAISE EXCEPTION 'CATALOG_CODE_IMMUTABLE' USING ERRCODE='23505'; END IF;
 SELECT * INTO STRICT v FROM catalog.item_revision WHERE item_id=p_item AND revision=c.revision;
 INSERT INTO catalog.catalog_item_code(item_id,ice_code,evidence_ref,request_id) VALUES(p_item,p_code,p_evidence,p_request);
 INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,evidence_ref,reason,actor_id)
 VALUES(p_item,c.revision+1,c.revision,p_code,v.name_cn,v.fields,p_evidence,p_reason,actor);
 UPDATE catalog.item_current SET revision=c.revision+1 WHERE item_id=p_item;
 result:=jsonb_build_object('itemId',p_item,'revision',c.revision+1,'iceCode',p_code);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result) VALUES(p_request,p_intent,actor,'assign_initial_code',p_item,result);
 RETURN result;
END $$;

CREATE FUNCTION catalog.valid_field(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN jsonb_typeof(p)<>'object' OR jsonb_typeof(p->'evidenceRef')<>'string' OR coalesce(p->>'evidenceRef','')='' THEN false
 WHEN p->>'state'='observed' THEN
  (SELECT count(*)=4 FROM jsonb_object_keys(p)) AND CASE p->>'meaning'
   WHEN 'value' THEN jsonb_typeof(p->'raw')='string' AND length(p->>'raw')>0
   WHEN 'explicit_empty' THEN p->'raw'='""'::jsonb
   WHEN 'explicit_null' THEN p->'raw'='null'::jsonb ELSE false END
 WHEN p->>'state'='no_text' THEN (SELECT count(*)=3 FROM jsonb_object_keys(p)) AND p->'raw'='null'::jsonb
 WHEN p->>'state' IN ('not_read','parse_failed') THEN (SELECT count(*)=4 FROM jsonb_object_keys(p)) AND p->'raw'='null'::jsonb AND jsonb_typeof(p->'reason')='string' AND length(p->>'reason')>0
 ELSE false END
$$;
CREATE FUNCTION catalog.append_nonprice_revision(p_request uuid,p_intent text,p_item uuid,p_expected integer,p_fields jsonb,p_reason text,p_evidence text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; prior jsonb; c catalog.item_current; v catalog.item_revision; result jsonb; e record; new_name text;
BEGIN
 actor:=catalog.require_admin(); prior:=catalog.existing_request(p_request,p_intent,'append_nonprice_revision'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF p_item IS NULL OR p_expected IS NULL OR p_expected<=0 OR p_fields IS NULL OR jsonb_typeof(p_fields)<>'object' OR p_fields='{}'::jsonb
 OR p_reason IS NULL OR length(btrim(p_reason))=0 OR length(p_reason)>1000 OR p_evidence IS NULL OR length(btrim(p_evidence))=0 OR length(p_evidence)>500
 THEN RAISE EXCEPTION 'CATALOG_INVALID_INPUT' USING ERRCODE='22023'; END IF;
 FOR e IN SELECT * FROM jsonb_each(p_fields) LOOP
  IF NOT e.key=ANY(ARRAY['nameCn','specification','factory','imageRef','barcode','packaging','cartonQuantity','englishName']) OR NOT coalesce(catalog.valid_field(e.value),false) THEN
   RAISE EXCEPTION 'CATALOG_INVALID_NONPRICE_FIELD' USING ERRCODE='22023'; END IF;
 END LOOP;
 SELECT * INTO STRICT c FROM catalog.item_current WHERE item_id=p_item FOR UPDATE;
 IF c.revision<>p_expected THEN RAISE EXCEPTION 'CATALOG_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
 SELECT * INTO STRICT v FROM catalog.item_revision WHERE item_id=p_item AND revision=c.revision;
 new_name:=CASE WHEN p_fields?'nameCn' THEN p_fields->'nameCn'->>'raw' ELSE v.name_cn END;
 IF new_name IS NULL OR length(new_name)=0 THEN RAISE EXCEPTION 'CATALOG_NAME_REQUIRED' USING ERRCODE='22023'; END IF;
 INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,evidence_ref,reason,actor_id)
 VALUES(p_item,c.revision+1,c.revision,v.ice_code_snapshot,new_name,v.fields||p_fields,p_evidence,p_reason,actor);
 UPDATE catalog.item_current SET revision=c.revision+1 WHERE item_id=p_item;
 result:=jsonb_build_object('itemId',p_item,'revision',c.revision+1,'iceCode',v.ice_code_snapshot);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result) VALUES(p_request,p_intent,actor,'append_nonprice_revision',p_item,result);
 RETURN result;
END $$;

CREATE FUNCTION catalog.import_frozen_observations(p_request uuid,p_intent text,p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; prior jsonb; r uuid; art uuid; snapshot_art uuid; ns uuid; ds uuid; batch uuid; old_hash text; x jsonb; a jsonb; obs uuid; result jsonb;
BEGIN
 actor:=catalog.require_admin(); prior:=catalog.existing_request(p_request,p_intent,'import_frozen_observations'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF p->>'approvedSnapshotId'<>'feishu-partial-20261020-v2' OR jsonb_array_length(p->'observations')<>159 OR (p->'coverage'->>'complete')::boolean IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'CATALOG_INVALID_FROZEN_OBSERVATION' USING ERRCODE='22023'; END IF;
 SELECT id INTO STRICT r FROM catalog.baseline_release WHERE published;
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'snapshotKey',924));
 SELECT b.id,b.content_sha256 INTO batch,old_hash FROM catalog.observation_batch b JOIN catalog.source_dataset d ON d.id=b.dataset_id
 JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE n.local_key='feishu-partial-20261020-v2' AND b.snapshot_key=p->>'snapshotKey';
 IF FOUND THEN
  IF old_hash<>p->>'contentSha256' THEN RAISE EXCEPTION 'CATALOG_SNAPSHOT_CONFLICT' USING ERRCODE='23505'; END IF;
 ELSE
  FOR a IN SELECT * FROM jsonb_array_elements(p->'artifacts') LOOP
   INSERT INTO catalog.artifact(release_id,logical_name,sha256,size_bytes,format,sensitivity)
   VALUES(r,a->>'logicalName',a->>'sha256',(a->>'size')::bigint,a->>'format','restricted') RETURNING id INTO art;
   INSERT INTO catalog_private.artifact_handle VALUES(art,a->>'storageHandle');
   IF a->>'logicalName'='feishu-observations.parsed.v2.json' THEN snapshot_art:=art; END IF;
  END LOOP;
  IF snapshot_art IS NULL THEN RAISE EXCEPTION 'CATALOG_SNAPSHOT_ARTIFACT_MISSING' USING ERRCODE='22023'; END IF;
  INSERT INTO catalog.source_namespace(system,local_key,account_scope)
  VALUES('feishu','feishu-partial-20261020-v2','{"state":"unknown","raw":null,"reason":"Shared wiki only; technical account unverified"}') RETURNING id INTO ns;
  INSERT INTO catalog.source_dataset(namespace_id,local_dataset_key,resource_identity,key_contract)
  VALUES(ns,'feishu-partial-20261020-v2',p->'coverage','{"mode":"observe_only","version":"catalog-identity-v1","sourceIdentityVerified":false}') RETURNING id INTO ds;
  INSERT INTO catalog.observation_batch(dataset_id,release_id,artifact_id,snapshot_key,content_sha256,coverage)
  VALUES(ds,r,snapshot_art,p->>'snapshotKey',p->>'contentSha256',p->'coverage') RETURNING id INTO batch;
  FOR x IN SELECT * FROM jsonb_array_elements(p->'observations') LOOP
   INSERT INTO catalog.source_observation(batch_id,artifact_id,entry_key,legacy_candidate_id,position,scope,fields,review_state,raw_ref,payload_sha256)
   VALUES(batch,snapshot_art,x->>'entryKey',x->>'legacyCandidateId',x->'position',x->'scope',x->'fields',x->>'reviewState',x->>'rawRef',x->>'payloadSha256') RETURNING id INTO obs;
   INSERT INTO catalog_private.observation_amounts VALUES(obs,x->'amounts');
  END LOOP;
 END IF;
 result:=jsonb_build_object('batchId',batch,'observationCount',159);
 INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,release_id,result) VALUES(p_request,p_intent,actor,'import_frozen_observations',r,result);
 RETURN result;
END $$;

CREATE FUNCTION catalog.read_item_amounts(p_item uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN PERFORM catalog.require_admin();
 SELECT f.payload INTO result FROM catalog.item_current c JOIN catalog_private.item_financial_revision f USING(item_id,financial_revision) WHERE c.item_id=p_item;
 RETURN result; END $$;
CREATE FUNCTION catalog.read_observation_amounts(p_observation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN PERFORM catalog.require_admin(); SELECT payload INTO result FROM catalog_private.observation_amounts WHERE observation_id=p_observation; RETURN result; END $$;
CREATE FUNCTION catalog.read_artifact(p_artifact uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN PERFORM catalog.require_admin();
 SELECT jsonb_build_object('artifactId',a.id,'logicalName',a.logical_name,'sha256',a.sha256,'size',a.size_bytes,'storageHandle',h.storage_handle)
 INTO result FROM catalog.artifact a JOIN catalog_private.artifact_handle h ON h.artifact_id=a.id WHERE a.id=p_artifact;
 RETURN result; END $$;

REVOKE ALL ON SCHEMA catalog,catalog_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA catalog,catalog_private FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_sync_runner,ice_p0_02_auth_runner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA catalog FROM PUBLIC;
GRANT USAGE ON SCHEMA catalog TO ice_p0_02_app_runner;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.is_admin(),catalog.require_admin() TO ice_p0_02_app_runner;
GRANT EXECUTE ON FUNCTION catalog.publish_baseline(uuid,text,jsonb),catalog.assign_initial_code(uuid,text,uuid,integer,text,text,text),
 catalog.append_nonprice_revision(uuid,text,uuid,integer,jsonb,text,text),catalog.import_frozen_observations(uuid,text,jsonb),
 catalog.read_item_amounts(uuid),catalog.read_observation_amounts(uuid),catalog.read_artifact(uuid) TO ice_p0_02_app_runner;
RESET ROLE;
