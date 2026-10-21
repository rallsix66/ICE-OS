SET ROLE ice_p0_02_owner;

CREATE FUNCTION catalog.identity_json(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE r text; BEGIN
 IF jsonb_typeof(p)='array' THEN SELECT '['||coalesce(string_agg(catalog.identity_json(value),',' ORDER BY ordinal),'')||']' INTO r FROM jsonb_array_elements(p) WITH ORDINALITY x(value,ordinal);
 ELSIF jsonb_typeof(p)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||catalog.identity_json(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO r FROM jsonb_each(p);
 ELSE r:=p::text; END IF; RETURN r;
END $$;

CREATE FUNCTION catalog.identity_mutate(p_request uuid,p_scope uuid,p_action text,p_intent text,p jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid; prior catalog.source_identity_request; s catalog.source_scope; c catalog.source_identity_contract_revision;
 proof catalog.identity_evidence; o catalog.identity_observation; old catalog.source_record; current_record catalog.source_record;
 claim catalog.identity_claim; previous_link catalog.observation_record_link; key jsonb; x jsonb; f record; result jsonb;
 eid uuid; rid uuid; claim_id uuid; obs_ids uuid[]:='{}'; before_state jsonb; after_state jsonb; next_revision integer; previous_revision integer;
 origin_key text; frozen uuid; fresh uuid; target_id uuid; old_id uuid; link_revision integer; decisions uuid[]:='{}'; source_system text;
 actual_digest text; v_contract_id uuid; old_domain text; action_reason text; record_change boolean:=false; existing_match boolean:=false;
 frozen_scope jsonb; frozen_context_status text;
BEGIN
 actor:=catalog.identity_authorize(p_scope,'manage');
 IF p_request IS NULL OR p_action IS NULL OR p_action NOT IN('import_capture','register','revise','link') OR p_intent IS NULL OR p_intent !~ '^[a-f0-9]{64}$' OR p IS NULL OR jsonb_typeof(p)<>'object' THEN RAISE EXCEPTION 'IDENTITY_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF catalog.identity_hash(catalog.identity_json(jsonb_build_array('iceos-source-request-v1',actor::text,p_scope::text,p_action,p))) IS DISTINCT FROM p_intent THEN RAISE EXCEPTION 'IDENTITY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,300));
 SELECT * INTO prior FROM catalog.source_identity_request WHERE request_id=p_request;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.scope_id<>p_scope OR prior.action<>p_action OR prior.intent_sha256<>p_intent THEN RAISE EXCEPTION 'IDENTITY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN prior.result;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_scope::text,301));
 SELECT * INTO STRICT s FROM catalog.source_scope WHERE id=p_scope AND evidence_mode='fixture';
 IF p_action='import_capture' THEN
  IF p->'coverage'->>'singleScope' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'IDENTITY_MIXED_SCOPE_EVIDENCE' USING ERRCODE='22023'; END IF;
  IF catalog.identity_hash(catalog.identity_json(p->'observations')) IS DISTINCT FROM p->>'projectionSha256' THEN RAISE EXCEPTION 'CAPTURE_PROJECTION_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT c FROM catalog.source_identity_contract_revision WHERE contract_id=(p->>'contractId')::uuid AND scope_id=p_scope AND revision=(p->>'contractRevision')::integer;
  actual_digest:=catalog.identity_hash(catalog.identity_json(jsonb_build_array('iceos-identity-capture-v1',p->>'bytesSha256',p->>'parserId',p->>'parserVersion',c.contract_id::text,c.revision,p_scope::text,p->'coverage',p->>'projectionSha256')));
  IF actual_digest IS DISTINCT FROM p->>'adoptionDigest' THEN RAISE EXCEPTION 'CAPTURE_DIGEST_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO proof FROM catalog.identity_evidence WHERE scope_id=p_scope AND capture_key=p->>'captureKey';
  IF FOUND THEN
   IF proof.adoption_digest<>actual_digest THEN RAISE EXCEPTION 'CAPTURE_CONFLICT' USING ERRCODE='23505'; END IF;
   eid:=proof.id; SELECT coalesce(array_agg(id ORDER BY record_pointer),'{}') INTO obs_ids FROM catalog.identity_observation WHERE evidence_id=eid;
  ELSE
   eid:=(p->>'evidenceId')::uuid;
   INSERT INTO catalog.identity_evidence(id,scope_id,capture_key,manifest_id,bytes_sha256,size_bytes,format,parser_id,parser_version,contract_id,contract_revision,coverage,projection_sha256,adoption_digest,proof_semantics,actor_id)
   VALUES(eid,p_scope,p->>'captureKey',p->>'manifestId',p->>'bytesSha256',(p->>'size')::bigint,p->>'format',p->>'parserId',p->>'parserVersion',c.contract_id,c.revision,p->'coverage',p->>'projectionSha256',actual_digest,coalesce(p->'proofSemantics','{}'),actor);
   INSERT INTO catalog_private.identity_evidence_handle VALUES(eid,p->>'storageHandle');
   FOR x IN SELECT * FROM jsonb_array_elements(p->'observations') LOOP
    IF NOT coalesce(catalog.identity_context_valid(x->'marketContext'),false) OR NOT coalesce(catalog.identity_context_valid(x->'warehouseContext'),false) THEN RAISE EXCEPTION 'IDENTITY_CONTEXT_INVALID' USING ERRCODE='22023'; END IF;
    FOR f IN SELECT * FROM jsonb_each(x->'fields') LOOP
     IF f.key NOT IN('vendorRecordId','sku','name','barcode') OR NOT coalesce(catalog.identity_field_valid(f.value),false)
     THEN RAISE EXCEPTION 'IDENTITY_FIELD_INVALID' USING ERRCODE='22023'; END IF;
    END LOOP;
    INSERT INTO catalog.identity_observation(id,scope_id,evidence_id,record_pointer,fields,market_context,warehouse_context,position,payload_sha256,source_effective_at,source_availability)
    VALUES((x->>'observationId')::uuid,p_scope,eid,x->>'recordPointer',x->'fields',x->'marketContext',x->'warehouseContext',x->'position',x->>'payloadSha256',(x->>'sourceEffectiveAt')::timestamptz,coalesce(x->>'sourceAvailability','not_observed'));
    obs_ids:=array_append(obs_ids,(x->>'observationId')::uuid);
   END LOOP;
  END IF;
  result:=jsonb_build_object('requestId',p_request,'scopeId',p_scope,'action',p_action,'evidenceId',eid,'observationIds',to_jsonb(obs_ids),'verificationEnvironment','fixture','relationshipUsable',false);
  INSERT INTO catalog.source_identity_request(request_id,scope_id,actor_id,action,intent_sha256,result,proof_id,reason,recorded_at)
  VALUES(p_request,p_scope,actor,p_action,p_intent,result,eid,'fixed single-scope fixture capture',clock_timestamp()); RETURN result;
 END IF;
 action_reason:=p->>'reason'; IF action_reason IS NULL OR length(btrim(action_reason))=0 OR length(action_reason)>1000 THEN RAISE EXCEPTION 'IDENTITY_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT proof FROM catalog.identity_evidence WHERE id=(p->>'proofId')::uuid AND scope_id=p_scope;
 IF p_action IN('register','revise') THEN
  IF p_action='register' OR p->>'command'='reverify' THEN
   v_contract_id:=(p->>'contractId')::uuid; SELECT * INTO STRICT c FROM catalog.source_identity_contract_revision WHERE contract_id=v_contract_id AND scope_id=p_scope;
   -- Qualification comes from trusted scoped evidence, never a client verified flag.
   IF proof.proof_semantics->>'uniqueness' IS DISTINCT FROM 'true' OR proof.proof_semantics->>'stability' IS DISTINCT FROM 'true'
    OR proof.proof_semantics->>'keyChange' IS DISTINCT FROM 'true' OR proof.proof_semantics->>'reuse' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'IDENTITY_PROOF_INSUFFICIENT' USING ERRCODE='22023'; END IF;
   key:=catalog.identity_key(p_scope,c.contract_id,(p->>'observationId')::uuid);
   PERFORM pg_advisory_xact_lock(hashtextextended(key->>'domain',302));
   SELECT * INTO STRICT o FROM catalog.identity_observation WHERE id=(p->>'observationId')::uuid AND scope_id=p_scope;
   IF EXISTS(SELECT 1 FROM catalog.identity_observation duplicate WHERE duplicate.evidence_id=o.evidence_id AND duplicate.id<>o.id AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(c.key_fields) AS key_field(key_name) WHERE duplicate.fields->key_field.key_name->>'value' IS DISTINCT FROM o.fields->key_field.key_name->>'value')) THEN RAISE EXCEPTION 'IDENTITY_DUPLICATE_KEY' USING ERRCODE='23505'; END IF;
   IF EXISTS(SELECT 1 FROM catalog.identity_claim WHERE scope_id=p_scope AND ((key_sha256=key->>'sha256' AND canonical_key<>key->>'canonical') OR(domain_sha256=key->>'domainSha256' AND canonical_domain<>key->>'domain'))) THEN RAISE EXCEPTION 'IDENTITY_HASH_COLLISION' USING ERRCODE='23505'; END IF;
   IF (SELECT count(DISTINCT record_id) FROM catalog.identity_claim WHERE scope_id=p_scope AND canonical_domain=key->>'domain')>1 THEN RAISE EXCEPTION 'IDENTITY_TARGET_CONFLICT' USING ERRCODE='23505'; END IF;
   SELECT * INTO claim FROM catalog.identity_claim WHERE scope_id=p_scope AND canonical_domain=key->>'domain' ORDER BY (contract_id=c.contract_id) DESC,recorded_at DESC LIMIT 1;
   existing_match:=FOUND;
  END IF;
  IF p_action='register' THEN
   IF existing_match THEN
    rid:=claim.record_id; SELECT * INTO STRICT old FROM catalog.source_record WHERE id=rid AND scope_id=p_scope FOR UPDATE;
    IF p->'expectedMatch'->>'kind' IS DISTINCT FROM 'record' OR (p->'expectedMatch'->>'recordId')::uuid IS DISTINCT FROM old.id OR (p->'expectedMatch'->>'revision')::integer IS DISTINCT FROM old.revision THEN RAISE EXCEPTION 'IDENTITY_MATCH_CONFLICT' USING ERRCODE='40001'; END IF;
    IF old.current_contract_id<>c.contract_id THEN RAISE EXCEPTION 'CONTRACT_UPGRADE_CROSSWALK_REQUIRED' USING ERRCODE='23505'; END IF;
    IF old.state<>'active' OR old.active_claim_id<>claim.id THEN RAISE EXCEPTION 'IDENTITY_EXPLICIT_REVERIFY_REQUIRED' USING ERRCODE='23505'; END IF;
    result:=jsonb_build_object('requestId',p_request,'scopeId',p_scope,'action',p_action,'recordId',old.id,'revision',old.revision,'state',old.state,'claimId',old.active_claim_id,'created',false,'verificationEnvironment','fixture','relationshipUsable',false);
   ELSE
    IF p->'expectedMatch'->>'kind' IS DISTINCT FROM 'none' THEN RAISE EXCEPTION 'IDENTITY_MATCH_CONFLICT' USING ERRCODE='40001'; END IF;
    IF EXISTS(SELECT 1 FROM catalog.identity_claim WHERE scope_id=p_scope AND entity_kind=s.entity_kind AND contract_revision<>c.revision) AND proof.proof_semantics->>'disjointKeyDomain' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CONTRACT_UPGRADE_CROSSWALK_REQUIRED' USING ERRCODE='23505'; END IF;
    rid:=gen_random_uuid(); claim_id:=gen_random_uuid(); next_revision:=1; record_change:=true;
    INSERT INTO catalog.source_record VALUES(rid,p_scope,s.entity_kind,c.contract_id,1,'active',claim_id,c.contract_id,p_request);
    INSERT INTO catalog.identity_claim VALUES(claim_id,rid,p_scope,s.entity_kind,c.contract_id,c.revision,c.strategy,key->'fields',key->>'canonical',key->>'sha256',key->>'domain',key->>'domainSha256',proof.id,actor,now());
    after_state:=jsonb_build_object('state','active','activeClaimId',claim_id,'currentContractId',c.contract_id);
    result:=jsonb_build_object('requestId',p_request,'scopeId',p_scope,'action',p_action,'recordId',rid,'revision',1,'state','active','claimId',claim_id,'created',true,'verificationEnvironment','fixture','relationshipUsable',false);
   END IF;
  ELSE
   rid:=(p->>'recordId')::uuid; SELECT * INTO STRICT old FROM catalog.source_record WHERE id=rid AND scope_id=p_scope FOR UPDATE;
   IF (p->>'expectedRecordRevision')::integer IS NULL OR (p->>'expectedRecordRevision')::integer<>old.revision THEN RAISE EXCEPTION 'IDENTITY_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
   before_state:=jsonb_build_object('state',old.state,'activeClaimId',old.active_claim_id,'currentContractId',old.current_contract_id);
   current_record:=old; next_revision:=old.revision+1; previous_revision:=old.revision; record_change:=true;
   IF p->>'command'='reverify' THEN
    IF o.evidence_id IS DISTINCT FROM proof.id OR proof.contract_id IS DISTINCT FROM c.contract_id OR proof.contract_revision IS DISTINCT FROM c.revision
    THEN RAISE EXCEPTION 'IDENTITY_PROOF_COVERAGE_REQUIRED' USING ERRCODE='22023'; END IF;
    IF (p->>'expectedClaimId')::uuid IS DISTINCT FROM old.active_claim_id
    OR (SELECT min(collected_at) FROM catalog.identity_evidence WHERE scope_id=p_scope AND bytes_sha256=proof.bytes_sha256)
       <=(SELECT recorded_at FROM catalog.source_identity_request WHERE request_id=old.latest_request_id AND source_record_id=old.id)
    OR EXISTS(SELECT 1 FROM catalog.identity_evidence used WHERE used.scope_id=p_scope AND used.bytes_sha256=proof.bytes_sha256
      AND (EXISTS(SELECT 1 FROM catalog.identity_claim prior_claim WHERE prior_claim.record_id=old.id AND prior_claim.proof_id=used.id)
       OR EXISTS(SELECT 1 FROM catalog.source_identity_request prior_fact WHERE prior_fact.source_record_id=old.id AND prior_fact.proof_id=used.id)))
    THEN RAISE EXCEPTION 'IDENTITY_FRESH_PROOF_REQUIRED' USING ERRCODE='22023'; END IF;
    IF existing_match AND claim.record_id<>old.id THEN RAISE EXCEPTION 'IDENTITY_TARGET_CONFLICT' USING ERRCODE='23505'; END IF;
    SELECT canonical_domain INTO STRICT old_domain FROM catalog.identity_claim WHERE id=old.active_claim_id;
    IF (c.contract_id<>old.current_contract_id OR key->>'domain' IS DISTINCT FROM old_domain) AND proof.proof_semantics->>'migrationClaimId' IS DISTINCT FROM old.active_claim_id::text THEN RAISE EXCEPTION 'CONTRACT_UPGRADE_CROSSWALK_REQUIRED' USING ERRCODE='23505'; END IF;
    IF existing_match AND claim.contract_id=c.contract_id THEN claim_id:=claim.id; ELSE
     claim_id:=gen_random_uuid(); INSERT INTO catalog.identity_claim VALUES(claim_id,old.id,p_scope,s.entity_kind,c.contract_id,c.revision,c.strategy,key->'fields',key->>'canonical',key->>'sha256',key->>'domain',key->>'domainSha256',proof.id,actor,now()); END IF;
    current_record.state:='active'; current_record.active_claim_id:=claim_id; current_record.current_contract_id:=c.contract_id;
   ELSE
    IF p->>'command' IS NULL OR p->>'command' NOT IN('open_review','suspend','revoke') THEN RAISE EXCEPTION 'IDENTITY_COMMAND_INVALID' USING ERRCODE='22023'; END IF;
    current_record.state:=CASE p->>'command' WHEN 'open_review' THEN 'review_required' WHEN 'suspend' THEN 'suspended' ELSE 'revoked' END;
   END IF;
   after_state:=jsonb_build_object('state',current_record.state,'activeClaimId',current_record.active_claim_id,'currentContractId',current_record.current_contract_id);
   UPDATE catalog.source_record SET revision=next_revision,state=current_record.state,active_claim_id=current_record.active_claim_id,current_contract_id=current_record.current_contract_id,latest_request_id=p_request WHERE id=old.id;
   result:=jsonb_build_object('requestId',p_request,'scopeId',p_scope,'action',p_action,'recordId',old.id,'revision',next_revision,'state',current_record.state,'claimId',current_record.active_claim_id,'verificationEnvironment','fixture','relationshipUsable',false);
  END IF;
 ELSE
  IF p->>'operation' IS NULL OR p->>'operation' NOT IN('link','revoke') OR (p->>'expectedRecordRevision')::integer IS NULL OR (p->>'expectedLinkRevision')::integer IS NULL OR (p->>'expectedLinkRevision')::integer<0 THEN RAISE EXCEPTION 'IDENTITY_LINK_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  rid:=(p->>'recordId')::uuid; origin_key:=(p->'origin'->>'kind')||':'||((p->'origin'->>'id')::uuid)::text;
  -- Scope lock serializes all same-scope link changes; records are locked in UUID order before the observation.
  SELECT * INTO previous_link FROM catalog.observation_record_link WHERE observation_key=origin_key ORDER BY link_revision DESC LIMIT 1;
  old_id:=previous_link.record_id;
  PERFORM id FROM catalog.source_record WHERE id IN(rid,old_id) AND scope_id=p_scope ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT old FROM catalog.source_record WHERE id=rid AND scope_id=p_scope;
  IF old.revision<>(p->>'expectedRecordRevision')::integer OR(p->>'operation'='link' AND old.state<>'active') THEN RAISE EXCEPTION 'IDENTITY_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p->>'operation'='link' AND old_id IS NOT NULL AND old_id<>rid AND ((p->>'expectedPreviousRecordRevision')::integer IS NULL OR NOT EXISTS(SELECT 1 FROM catalog.source_record WHERE id=old_id AND revision=(p->>'expectedPreviousRecordRevision')::integer)) THEN RAISE EXCEPTION 'IDENTITY_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(origin_key,303));
  IF previous_link.scope_id IS NOT NULL AND previous_link.scope_id<>p_scope THEN RAISE EXCEPTION 'SCOPE_CROSSWALK_REQUIRED' USING ERRCODE='23505'; END IF;
  IF coalesce(previous_link.link_revision,0)<>(p->>'expectedLinkRevision')::integer THEN RAISE EXCEPTION 'IDENTITY_LINK_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p->>'operation'='revoke' AND(old_id IS NULL OR old_id<>rid OR previous_link.status<>'linked') THEN RAISE EXCEPTION 'IDENTITY_LINK_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p->>'operation'='revoke' THEN
   frozen:=previous_link.frozen_observation_id; fresh:=previous_link.identity_observation_id; decisions:=previous_link.frozen_decision_ids;
  ELSIF p->'origin'->>'kind'='identity' THEN
   fresh:=(p->'origin'->>'id')::uuid; SELECT * INTO STRICT o FROM catalog.identity_observation WHERE id=fresh AND scope_id=p_scope;
   key:=catalog.identity_key(p_scope,old.current_contract_id,fresh);
   IF NOT EXISTS(SELECT 1 FROM catalog.identity_claim WHERE id=old.active_claim_id AND canonical_domain=key->>'domain') THEN RAISE EXCEPTION 'IDENTITY_OBSERVATION_CONTRADICTION' USING ERRCODE='23505'; END IF;
  ELSIF p->'origin'->>'kind'='frozen' THEN
   frozen:=(p->'origin'->>'id')::uuid;
   SELECT n.system,fo.scope INTO STRICT source_system,frozen_scope FROM catalog.source_observation fo JOIN catalog.observation_batch b ON b.id=fo.batch_id JOIN catalog.source_dataset d ON d.id=b.dataset_id JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE fo.id=frozen;
   IF source_system<>s.system OR proof.proof_semantics->>'oldObservationCompatible' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'IDENTITY_OBSERVATION_CONTRADICTION' USING ERRCODE='23505'; END IF;
   frozen_context_status:=catalog.identity_scope_context_status(p_scope,frozen_scope->'market',frozen_scope->'warehouse');
   IF frozen_context_status='contradiction' THEN RAISE EXCEPTION 'IDENTITY_FROZEN_SCOPE_CONTRADICTION' USING ERRCODE='22023';
   ELSIF frozen_context_status<>'compatible' THEN RAISE EXCEPTION 'IDENTITY_SCOPE_UNPROVEN' USING ERRCODE='22023'; END IF;
   SELECT * INTO STRICT claim FROM catalog.identity_claim WHERE id=old.active_claim_id;
   IF NOT EXISTS(SELECT 1 FROM catalog.identity_observation support JOIN catalog.source_observation fo ON fo.id=frozen
    WHERE support.scope_id=p_scope AND catalog.identity_scope_context_status(p_scope,support.market_context,support.warehouse_context)='compatible'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(claim.original_key_fields) pair WHERE support.fields->(pair->>0)->>'value' IS DISTINCT FROM pair->>1)
    AND (fo.fields->'sku'->>'meaning' IS DISTINCT FROM 'value' OR support.fields->'sku'->>'value'=fo.fields->'sku'->>'raw')
    AND (fo.fields->'name'->>'meaning' IS DISTINCT FROM 'value' OR support.fields->'name'->>'value'=fo.fields->'name'->>'raw')
    AND (fo.fields->'barcode'->>'meaning' IS DISTINCT FROM 'value' OR support.fields->'barcode'->>'value'=fo.fields->'barcode'->>'raw')
   ) THEN RAISE EXCEPTION 'IDENTITY_OBSERVATION_CONTRADICTION' USING ERRCODE='23505'; END IF;
   IF EXISTS(SELECT 1 FROM catalog.source_observation fo CROSS JOIN jsonb_array_elements(claim.original_key_fields) pair WHERE fo.id=frozen AND pair->>0='sku' AND fo.fields->'sku'->>'state'='observed' AND fo.fields->'sku'->>'meaning'='value' AND fo.fields->'sku'->>'raw'<>pair->>1) THEN RAISE EXCEPTION 'IDENTITY_OBSERVATION_CONTRADICTION' USING ERRCODE='23505'; END IF;
   SELECT coalesce(array_agg(id),'{}') INTO decisions FROM catalog.decision_evidence WHERE observation_id=frozen AND entry_kind='candidate_snapshot';
  ELSE RAISE EXCEPTION 'IDENTITY_ORIGIN_INVALID' USING ERRCODE='22023'; END IF;
  link_revision:=coalesce(previous_link.link_revision,0)+1;
  BEGIN
   INSERT INTO catalog.observation_record_link VALUES(origin_key,link_revision,previous_link.link_revision,p_scope,CASE WHEN p->>'operation'='revoke' THEN previous_link.origin_kind ELSE p->'origin'->>'kind' END,frozen,fresh,rid,
    CASE WHEN p->>'operation'='revoke' THEN previous_link.contract_id ELSE old.current_contract_id END,
    CASE WHEN p->>'operation'='revoke' THEN previous_link.proof_id ELSE proof.id END,
    CASE WHEN p->>'operation'='link' THEN 'linked' ELSE 'revoked' END,decisions,action_reason,actor,now());
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'SCOPE_CROSSWALK_REQUIRED' USING ERRCODE='23505'; END;
  result:=jsonb_build_object('requestId',p_request,'scopeId',p_scope,'action',p_action,'recordId',rid,'observationKey',origin_key,'linkRevision',link_revision,'verificationEnvironment','fixture','relationshipUsable',false);
 END IF;
 INSERT INTO catalog.source_identity_request(request_id,scope_id,actor_id,action,intent_sha256,result,proof_id,reason,source_record_id,record_revision,previous_revision,before_state,after_state,recorded_at)
 VALUES(p_request,p_scope,actor,p_action,p_intent,result,proof.id,action_reason,CASE WHEN record_change THEN rid END,CASE WHEN record_change THEN next_revision END,CASE WHEN record_change THEN previous_revision END,before_state,after_state,clock_timestamp());
 RETURN result;
END $$;
CREATE FUNCTION catalog.identity_hash(p text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT encode(sha256(convert_to(p,'UTF8')),'hex') $$;
CREATE FUNCTION catalog.identity_opaque(p text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT p IS NOT NULL AND length(p)>0 AND p !~ '^[[:space:]]|[[:space:]]$' AND length(p)<=500 $$;
CREATE FUNCTION catalog.identity_scope_canonical(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v text; x jsonb; BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' OR p->>'system' IS NULL OR p->>'entityKind' IS NULL OR p->>'accountKind' IS NULL OR p->>'resourceKind' IS NULL OR p->>'marketRole' IS NULL OR p->>'warehouseRole' IS NULL
 OR p->'accountParts' IS NULL OR p->'resourceParts' IS NULL OR p->>'system' NOT IN('bigseller','jushuitan','feishu') OR p->>'entityKind' NOT IN('product_record','sku_record')
 OR p->>'accountKind' NOT IN('account','tenant_account','fixture_account') OR p->>'resourceKind' NOT IN('sheet_tab','api_collection','fixture_dataset')
 OR jsonb_typeof(p->'accountParts')<>'array' OR jsonb_typeof(p->'resourceParts')<>'array'
 OR jsonb_array_length(p->'accountParts')<>(CASE WHEN p->>'accountKind'='tenant_account' THEN 2 ELSE 1 END)
 OR jsonb_array_length(p->'resourceParts')<>(CASE WHEN p->>'resourceKind'='sheet_tab' THEN 2 ELSE 1 END)
 OR p->>'marketRole' NOT IN('identity','context') OR p->>'warehouseRole' NOT IN('identity','context')
 THEN RAISE EXCEPTION 'IDENTITY_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 FOR x IN SELECT * FROM jsonb_array_elements((p->'accountParts')||(p->'resourceParts')) LOOP
  IF jsonb_typeof(x)<>'string' OR NOT catalog.identity_opaque(x#>>'{}') THEN RAISE EXCEPTION 'IDENTITY_SCOPE_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (p->>'marketRole'='identity' AND NOT catalog.identity_opaque(p->>'marketIdentity')) OR(p->>'marketRole'='context' AND p->>'marketIdentity' IS NOT NULL)
 OR(p->>'warehouseRole'='identity' AND NOT catalog.identity_opaque(p->>'warehouseIdentity')) OR(p->>'warehouseRole'='context' AND p->>'warehouseIdentity' IS NOT NULL)
 THEN RAISE EXCEPTION 'SCOPE_CROSSWALK_REQUIRED' USING ERRCODE='22023'; END IF;
 v:=catalog.identity_json(jsonb_build_array('iceos-source-scope-v1',p->>'system',p->>'entityKind',jsonb_build_array('account',p->>'accountKind',p->'accountParts'),
 jsonb_build_array('resource',p->>'resourceKind',p->'resourceParts'),jsonb_build_array('market',p->>'marketRole',p->'marketIdentity'),jsonb_build_array('warehouse',p->>'warehouseRole',p->'warehouseIdentity')));
 IF octet_length(v)>1800 THEN RAISE EXCEPTION 'SCOPE_KEY_TOO_LONG' USING ERRCODE='22023'; END IF; RETURN v;
END $$;

CREATE FUNCTION catalog.identity_scope_allowed(p_scope uuid,p_cap text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT catalog.is_admin() AND EXISTS(SELECT 1 FROM catalog.source_scope_grant g WHERE g.scope_id=p_scope
 AND g.profile_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid AND g.enabled AND g.can_read
 AND CASE p_cap WHEN 'read' THEN true WHEN 'manage' THEN g.can_manage WHEN 'evidence' THEN g.can_evidence WHEN 'amount' THEN g.can_amount ELSE false END)
$$;
CREATE FUNCTION catalog.identity_authorize(p_scope uuid,p_cap text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN IF NOT catalog.identity_scope_allowed(p_scope,p_cap) THEN RAISE EXCEPTION 'IDENTITY_DENIED' USING ERRCODE='42501'; END IF;
 RETURN nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; END $$;
CREATE FUNCTION catalog.identity_no_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'IDENTITY_IMMUTABLE' USING ERRCODE='42501'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['source_scope','identity_evidence','source_identity_contract_revision','identity_claim','identity_observation','observation_record_link','source_identity_request'] LOOP
 EXECUTE format('CREATE TRIGGER identity_immutable BEFORE UPDATE OR DELETE ON catalog.%I FOR EACH ROW EXECUTE FUNCTION catalog.identity_no_mutation()',t); END LOOP;
 CREATE TRIGGER identity_handle_immutable BEFORE UPDATE OR DELETE ON catalog_private.identity_evidence_handle FOR EACH ROW EXECUTE FUNCTION catalog.identity_no_mutation();
 FOREACH t IN ARRAY ARRAY['source_scope','identity_evidence','source_identity_contract_revision','source_record','identity_claim','identity_observation','observation_record_link','source_identity_request'] LOOP
 EXECUTE format('ALTER TABLE catalog.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE catalog.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY identity_scope_read ON catalog.%I FOR SELECT USING(catalog.identity_scope_allowed(%s,''read''))',t,CASE WHEN t='source_scope' THEN 'id' ELSE 'scope_id' END);
 EXECUTE format('CREATE POLICY identity_scope_write ON catalog.%I FOR ALL USING(catalog.identity_scope_allowed(%s,''manage'')) WITH CHECK(catalog.identity_scope_allowed(%s,''manage''))',t,CASE WHEN t='source_scope' THEN 'id' ELSE 'scope_id' END,CASE WHEN t='source_scope' THEN 'id' ELSE 'scope_id' END);
 END LOOP;
END $$;
ALTER TABLE catalog.source_scope_grant ENABLE ROW LEVEL SECURITY; ALTER TABLE catalog.source_scope_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_own_grant ON catalog.source_scope_grant FOR SELECT USING(profile_id=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid AND catalog.is_admin());
ALTER TABLE catalog_private.identity_evidence_handle ENABLE ROW LEVEL SECURITY; ALTER TABLE catalog_private.identity_evidence_handle FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_handle_access ON catalog_private.identity_evidence_handle USING(EXISTS(SELECT 1 FROM catalog.identity_evidence e WHERE e.id=evidence_id AND catalog.identity_scope_allowed(e.scope_id,'read') AND catalog.identity_scope_allowed(e.scope_id,'evidence') AND catalog.identity_scope_allowed(e.scope_id,'amount')))
 WITH CHECK(EXISTS(SELECT 1 FROM catalog.identity_evidence e WHERE e.id=evidence_id AND catalog.identity_scope_allowed(e.scope_id,'manage')));

CREATE FUNCTION catalog.identity_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE q catalog.source_identity_request; cl catalog.identity_claim; previous catalog.source_identity_request; BEGIN
 SELECT * INTO STRICT q FROM catalog.source_identity_request WHERE request_id=NEW.latest_request_id;
 SELECT * INTO STRICT cl FROM catalog.identity_claim WHERE id=NEW.active_claim_id;
 IF (TG_OP='INSERT' AND NEW.revision<>1) OR(TG_OP='UPDATE' AND (NEW.revision<>OLD.revision+1 OR NEW.id<>OLD.id OR NEW.scope_id<>OLD.scope_id OR NEW.entity_kind<>OLD.entity_kind OR NEW.first_contract_id<>OLD.first_contract_id))
 OR q.source_record_id<>NEW.id OR q.scope_id<>NEW.scope_id OR q.record_revision<>NEW.revision OR q.request_xid<>txid_current()
 OR q.after_state<>jsonb_build_object('state',NEW.state,'activeClaimId',NEW.active_claim_id,'currentContractId',NEW.current_contract_id)
 OR cl.record_id<>NEW.id OR cl.scope_id<>NEW.scope_id OR cl.contract_id<>NEW.current_contract_id THEN RAISE EXCEPTION 'IDENTITY_HEAD_FACT_MISMATCH' USING ERRCODE='23514'; END IF;
 IF NEW.revision>1 THEN SELECT * INTO STRICT previous FROM catalog.source_identity_request WHERE source_record_id=NEW.id AND record_revision=NEW.revision-1;
 IF q.previous_revision<>NEW.revision-1 OR q.before_state<>previous.after_state THEN RAISE EXCEPTION 'IDENTITY_REVISION_CHAIN_INVALID' USING ERRCODE='23514'; END IF; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER identity_head_fact AFTER INSERT OR UPDATE ON catalog.source_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.identity_head_guard();

CREATE FUNCTION catalog.identity_contract_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s catalog.source_scope; expected jsonb; BEGIN
 SELECT * INTO STRICT s FROM catalog.source_scope WHERE id=NEW.scope_id;
 expected:=jsonb_build_array('account','resource')||CASE WHEN s.identity_policy->>'marketRole'='identity' THEN '["market"]' ELSE '[]' END::jsonb||CASE WHEN s.identity_policy->>'warehouseRole'='identity' THEN '["warehouse"]' ELSE '[]' END::jsonb;
 IF NEW.identity_dimensions<>jsonb_build_object('market',s.identity_policy->>'marketRole','warehouse',s.identity_policy->>'warehouseRole') OR NEW.required_scope<>expected
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.key_fields))<>jsonb_array_length(NEW.key_fields)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.key_fields) f WHERE jsonb_typeof(f)<>'string' OR f#>>'{}' NOT IN('vendorRecordId','sku'))
 OR (NEW.strategy='vendor_stable_id' AND NEW.key_fields<>'["vendorRecordId"]') THEN RAISE EXCEPTION 'IDENTITY_CONTRACT_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_contract_shape BEFORE INSERT ON catalog.source_identity_contract_revision FOR EACH ROW EXECUTE FUNCTION catalog.identity_contract_guard();
CREATE FUNCTION catalog.identity_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE previous catalog.source_identity_request; head catalog.source_record; BEGIN
 IF NEW.source_record_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT head FROM catalog.source_record WHERE id=NEW.source_record_id AND scope_id=NEW.scope_id;
 IF NEW.record_revision>head.revision THEN RAISE EXCEPTION 'IDENTITY_REQUEST_WITHOUT_HEAD' USING ERRCODE='23514'; END IF;
 IF NEW.record_revision>1 THEN
 SELECT * INTO STRICT previous FROM catalog.source_identity_request WHERE source_record_id=NEW.source_record_id AND record_revision=NEW.record_revision-1 AND scope_id=NEW.scope_id;
 IF NEW.before_state IS DISTINCT FROM previous.after_state THEN RAISE EXCEPTION 'IDENTITY_REVISION_CHAIN_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER identity_request_fact AFTER INSERT ON catalog.source_identity_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.identity_request_guard();

CREATE FUNCTION catalog.identity_context_valid(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN jsonb_typeof(p)<>'object' THEN false WHEN p->>'state'='known' THEN catalog.identity_opaque(p->>'raw') AND catalog.identity_opaque(p->>'canonical') AND catalog.identity_opaque(p->>'evidenceRef') AND (SELECT count(*)=4 FROM jsonb_object_keys(p))
 WHEN p->>'state'='unknown' THEN p->'raw'='null'::jsonb AND catalog.identity_opaque(p->>'reason') AND (SELECT count(*)=3 FROM jsonb_object_keys(p))
 WHEN p->>'state'='not_applicable' THEN p->'raw'='null'::jsonb AND catalog.identity_opaque(p->>'evidenceRef') AND (SELECT count(*)=3 FROM jsonb_object_keys(p)) ELSE false END $$;
CREATE FUNCTION catalog.identity_field_valid(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN jsonb_typeof(p)<>'object' OR NOT catalog.identity_opaque(p->>'evidenceRef') THEN false
 WHEN p->>'state'='value' THEN jsonb_typeof(p->'value')='string' AND catalog.identity_opaque(p->>'value') AND (SELECT count(*)=3 FROM jsonb_object_keys(p))
 WHEN p->>'state'='empty' THEN p->'value'='null'::jsonb AND (SELECT count(*)=3 FROM jsonb_object_keys(p))
 WHEN p->>'state' IN('not_observed','parse_failed') THEN p->'value'='null'::jsonb AND catalog.identity_opaque(p->>'reason') AND (SELECT count(*)=4 FROM jsonb_object_keys(p)) ELSE false END $$;
CREATE FUNCTION catalog.identity_scope_context_status(p_scope uuid,p_market jsonb,p_warehouse jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s catalog.source_scope; BEGIN
 SELECT * INTO STRICT s FROM catalog.source_scope WHERE id=p_scope;
 IF (s.identity_policy->>'marketRole'='identity' AND p_market->>'state'='known'
     AND (p_market->>'canonical' IS DISTINCT FROM s.identity_policy->>'marketIdentity' OR p_market->>'raw' IS DISTINCT FROM s.identity_policy->>'marketIdentity'))
 OR (s.identity_policy->>'warehouseRole'='identity' AND p_warehouse->>'state'='known'
     AND (p_warehouse->>'canonical' IS DISTINCT FROM s.identity_policy->>'warehouseIdentity' OR p_warehouse->>'raw' IS DISTINCT FROM s.identity_policy->>'warehouseIdentity'))
 THEN RETURN 'contradiction'; END IF;
 IF (s.identity_policy->>'marketRole'='identity' AND coalesce(p_market->>'state','unknown') IN('unknown','not_applicable'))
 OR (s.identity_policy->>'warehouseRole'='identity' AND coalesce(p_warehouse->>'state','unknown') IN('unknown','not_applicable')) THEN
  IF s.scope_state<>'identity_ready' OR s.canonical_scope IS NULL OR NOT EXISTS(SELECT 1 FROM catalog.identity_evidence e WHERE e.id=s.initial_proof_id AND e.scope_id=s.id
    AND e.coverage->>'singleScope'='true' AND e.proof_semantics->>'uniqueness'='true' AND e.proof_semantics->>'stability'='true') THEN RETURN 'unproven'; END IF;
 END IF;
 RETURN 'compatible';
END $$;
CREATE FUNCTION catalog.identity_key(p_scope uuid,p_contract uuid,p_observation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c catalog.source_identity_contract_revision; o catalog.identity_observation; s catalog.source_scope; f jsonb; k text; fields jsonb:='[]'; canonical text; domain text; context_status text; BEGIN
 PERFORM catalog.identity_authorize(p_scope,'manage'); SELECT * INTO STRICT s FROM catalog.source_scope WHERE id=p_scope;
 IF s.scope_state<>'identity_ready' THEN RAISE EXCEPTION 'IDENTITY_SCOPE_UNRESOLVED' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT c FROM catalog.source_identity_contract_revision WHERE contract_id=p_contract AND scope_id=p_scope;
 SELECT * INTO STRICT o FROM catalog.identity_observation WHERE id=p_observation AND scope_id=p_scope;
 context_status:=catalog.identity_scope_context_status(p_scope,o.market_context,o.warehouse_context);
 IF context_status='contradiction' THEN RAISE EXCEPTION 'IDENTITY_SCOPE_CONTRADICTION' USING ERRCODE='22023';
 ELSIF context_status<>'compatible' THEN RAISE EXCEPTION 'IDENTITY_SCOPE_UNPROVEN' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT jsonb_array_elements_text(c.key_fields) LOOP
  f:=o.fields->k; IF f->>'state'<>'value' OR NOT catalog.identity_opaque(f->>'value') THEN RAISE EXCEPTION 'KEY_FIELD_NOT_OBSERVED' USING ERRCODE='22023'; END IF;
  fields:=fields||jsonb_build_array(jsonb_build_array(k,f->>'value'));
 END LOOP;
 canonical:=catalog.identity_json(jsonb_build_array(p_scope::text,s.entity_kind,c.revision,c.strategy,fields));
 SELECT catalog.identity_json(jsonb_build_array(p_scope::text,s.entity_kind,c.strategy,jsonb_agg(value ORDER BY (value->>0) COLLATE "C"))) INTO domain FROM jsonb_array_elements(fields);
 IF octet_length(canonical)>1800 THEN RAISE EXCEPTION 'IDENTITY_KEY_TOO_LONG' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('canonical',canonical,'sha256',catalog.identity_hash(canonical),'domain',domain,'domainSha256',catalog.identity_hash(domain),'fields',fields);
END $$;

CREATE FUNCTION catalog.identity_fixture_bootstrap(p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE sid uuid:=(p->>'scopeId')::uuid; pid uuid:=(p->>'proofId')::uuid; cid uuid:=(p->>'contractId')::uuid; actor uuid; canonical text; g jsonb; rev integer; dimensions jsonb; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'IDENTITY_BOOTSTRAP_DENIED' USING ERRCODE='42501'; END IF;
 actor:=coalesce((p->>'actorId')::uuid,'11111111-1111-4111-8111-111111111101'::uuid);
 dimensions:=jsonb_build_object('market',p->>'marketRole','warehouse',p->>'warehouseRole');
 IF coalesce(p->>'scopeState','identity_ready')='identity_ready' THEN canonical:=catalog.identity_scope_canonical(p); END IF;
 IF EXISTS(SELECT 1 FROM catalog.source_scope WHERE id=sid) THEN
  IF NOT EXISTS(SELECT 1 FROM catalog.source_scope WHERE id=sid AND canonical_scope IS NOT DISTINCT FROM canonical AND identity_policy=p-ARRAY['proofId','proofCaptureKey','proofSha256','proofSize','proofHandle','contractId','strategy','keyFields','displayName','grants','actorId','contractRevision','proofSemantics']) THEN
   -- Scope policy is compared through canonical plus the fixed dimensions below;
   -- metadata/proof/contract revisions cannot create a different identity.
   IF NOT EXISTS(SELECT 1 FROM catalog.source_scope WHERE id=sid AND canonical_scope IS NOT DISTINCT FROM canonical AND identity_policy->>'marketRole'=p->>'marketRole' AND identity_policy->>'warehouseRole'=p->>'warehouseRole') THEN RAISE EXCEPTION 'SCOPE_CROSSWALK_REQUIRED' USING ERRCODE='22023'; END IF;
  END IF;
 ELSE INSERT INTO catalog.source_scope VALUES(sid,p->>'system',p->>'entityKind',coalesce(p->>'scopeState','identity_ready'),'fixture',p->>'displayName',p-ARRAY['proofId','proofCaptureKey','proofSha256','proofSize','proofHandle','contractId','strategy','keyFields','displayName','grants','actorId','contractRevision','proofSemantics'],canonical,CASE WHEN canonical IS NOT NULL THEN catalog.identity_hash(canonical) END,pid,actor,now()); END IF;
 rev:=coalesce((p->>'contractRevision')::integer,1);
 INSERT INTO catalog.identity_evidence(id,scope_id,capture_key,manifest_id,bytes_sha256,size_bytes,format,parser_id,parser_version,contract_id,contract_revision,coverage,projection_sha256,adoption_digest,proof_semantics,actor_id)
 VALUES(pid,sid,p->>'proofCaptureKey','fixture-bootstrap',p->>'proofSha256',(p->>'proofSize')::bigint,'json','fixture-proof','v1',cid,rev,'{"complete":true,"singleScope":true}',p->>'proofSha256',catalog.identity_hash((p->>'proofSha256')||cid::text),coalesce(p->'proofSemantics','{"uniqueness":true,"stability":true,"keyChange":true,"reuse":true,"oldObservationCompatible":true}'),actor);
 INSERT INTO catalog_private.identity_evidence_handle VALUES(pid,p->>'proofHandle');
 INSERT INTO catalog.source_identity_contract_revision VALUES(sid,rev,CASE WHEN rev>1 THEN rev-1 END,cid,p->>'entityKind',p->>'strategy',p->'keyFields',jsonb_build_array('account','resource')||CASE WHEN p->>'marketRole'='identity' THEN '["market"]' ELSE '[]' END::jsonb||CASE WHEN p->>'warehouseRole'='identity' THEN '["warehouse"]' ELSE '[]' END::jsonb,dimensions,'opaque-exact-v1','{"uniqueness":true,"stability":true,"keyChange":true,"reuse":true}',pid,'trusted isolated fixture profile',actor,now());
 FOR g IN SELECT * FROM jsonb_array_elements(coalesce(p->'grants','[]')) LOOP
 INSERT INTO catalog.source_scope_grant VALUES(sid,(g->>'profileId')::uuid,(g->>'read')::boolean,(g->>'manage')::boolean,(g->>'evidence')::boolean,(g->>'amount')::boolean,coalesce((g->>'enabled')::boolean,true),1,'trusted fixture bootstrap only'); END LOOP;
 RETURN sid;
END $$;

CREATE FUNCTION catalog.identity_require_scope(p_scope uuid,p_cap text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM catalog.identity_authorize(p_scope,CASE WHEN p_cap='raw' THEN 'read' ELSE p_cap END);
 IF p_cap='raw' THEN PERFORM catalog.identity_authorize(p_scope,'evidence'); PERFORM catalog.identity_authorize(p_scope,'amount'); END IF;
 RETURN nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
END $$;
CREATE FUNCTION catalog.identity_scopes() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN PERFORM catalog.require_admin();
 SELECT coalesce(jsonb_agg(jsonb_build_object('scopeId',id,'displayName',display_name,'system',system,'entityKind',entity_kind,'scopeState',scope_state,'verificationEnvironment','fixture') ORDER BY id),'[]') INTO result
 FROM catalog.source_scope WHERE catalog.identity_scope_allowed(id,'read'); RETURN result; END $$;
CREATE FUNCTION catalog.identity_read(p_scope uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; BEGIN PERFORM catalog.identity_authorize(p_scope,'read');
 SELECT jsonb_build_object('scope',jsonb_build_object('scopeId',s.id,'displayName',s.display_name,'system',s.system,'entityKind',s.entity_kind,'scopeState',s.scope_state,'verificationEnvironment','fixture'),
 'permissions',jsonb_build_object('read',true,'manage',catalog.identity_scope_allowed(p_scope,'manage'),'evidence',catalog.identity_scope_allowed(p_scope,'evidence'),'amount',catalog.identity_scope_allowed(p_scope,'amount')),
 'contracts',(SELECT coalesce(jsonb_agg(jsonb_build_object('contractId',contract_id,'revision',revision,'strategy',strategy,'keyFields',key_fields,'proofId',proof_id) ORDER BY revision),'[]') FROM catalog.source_identity_contract_revision WHERE scope_id=p_scope),
 'proofs',(SELECT coalesce(jsonb_agg(jsonb_build_object('evidenceId',id,'scopeId',scope_id,'captureKey',capture_key,'sha256',bytes_sha256,'format',format,'parserId',parser_id,'parserVersion',parser_version,'coverage',coverage,'collectedAt',collected_at,'sourceEffectiveAt',source_effective_at,'sourceAvailability',source_availability) ORDER BY collected_at,id),'[]') FROM catalog.identity_evidence WHERE scope_id=p_scope),
 'observations',(SELECT coalesce(jsonb_agg(jsonb_build_object('observationId',id,'evidenceId',evidence_id,'recordPointer',record_pointer,'fields',fields,'marketContext',market_context,'warehouseContext',warehouse_context,'position',position) ORDER BY collected_at,id),'[]') FROM catalog.identity_observation WHERE scope_id=p_scope),
 'records',(SELECT coalesce(jsonb_agg(jsonb_build_object('recordId',id,'scopeId',scope_id,'entityKind',entity_kind,'revision',revision,'state',state,'activeClaimId',active_claim_id,'currentContractId',current_contract_id,'verificationEnvironment','fixture','relationshipUsable',false) ORDER BY id),'[]') FROM catalog.source_record WHERE scope_id=p_scope),
 'links',(SELECT coalesce(jsonb_agg(jsonb_build_object('observationKey',observation_key,'linkRevision',link_revision,'originKind',origin_kind,'originId',coalesce(frozen_observation_id,identity_observation_id),'recordId',record_id,'contractId',contract_id,'actorId',actor_id,'status',status,'proofId',proof_id,'reason',reason,'recordedAt',recorded_at) ORDER BY observation_key,link_revision),'[]') FROM catalog.observation_record_link WHERE scope_id=p_scope),
 'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'scopeId',scope_id,'action',action,'recordId',source_record_id,'revision',record_revision,'beforeState',before_state,'afterState',after_state,'reason',reason,'actorId',actor_id,'recordedAt',recorded_at,'sourceEffectiveAt',NULL,'sourceAvailability','not_observed') ORDER BY recorded_at,request_id),'[]') FROM catalog.source_identity_request WHERE scope_id=p_scope),
 'frozenHumanChoice',(WITH frozen_namespaces AS MATERIALIZED (SELECT id FROM catalog.source_namespace WHERE system=s.system),
 frozen_datasets AS MATERIALIZED (SELECT fd.id FROM catalog.source_dataset fd JOIN frozen_namespaces fn ON fn.id=fd.namespace_id),
 frozen_batches AS MATERIALIZED (SELECT fb.id FROM catalog.observation_batch fb JOIN frozen_datasets fd ON fd.id=fb.dataset_id),
 frozen_observations AS MATERIALIZED (SELECT fo.id FROM catalog.source_observation fo JOIN frozen_batches fb ON fb.id=fo.batch_id),
 frozen_candidates AS MATERIALIZED (SELECT id,observation_id,selected_item_id,selected_jushuitan_ref,review_state FROM catalog.decision_evidence WHERE entry_kind='candidate_snapshot')
 SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('decisionId',d.id,'observationId',d.observation_id,'selectedItemId',d.selected_item_id,'selectedJushuitanRef',d.selected_jushuitan_ref,'reviewState',d.review_state)),'[]')
 FROM frozen_candidates d JOIN frozen_observations fo ON fo.id=d.observation_id),
 'verificationEnvironment','fixture','catalogTargetDecision','not_implemented','formalRelationship',jsonb_build_object('usable',false,'reason','N2_NOT_IMPLEMENTED')) INTO result
 FROM catalog.source_scope s WHERE s.id=p_scope;
 RETURN result;
END $$;
CREATE FUNCTION catalog.identity_receipt(p_request uuid,p_scope uuid,p_action text,p_intent text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE q catalog.source_identity_request; actor uuid; BEGIN
 actor:=catalog.identity_authorize(p_scope,'manage'); SELECT * INTO q FROM catalog.source_identity_request WHERE request_id=p_request;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF q.scope_id<>p_scope OR q.actor_id<>actor OR q.action<>p_action OR q.intent_sha256<>p_intent THEN RAISE EXCEPTION 'IDENTITY_REQUEST_CONFLICT' USING ERRCODE='23505'; END IF;
 RETURN q.result;
END $$;
CREATE FUNCTION catalog.identity_read_evidence(p_evidence uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE e catalog.identity_evidence; handle text; BEGIN
 SELECT * INTO e FROM catalog.identity_evidence WHERE id=p_evidence;
 IF NOT FOUND THEN RAISE EXCEPTION 'IDENTITY_DENIED' USING ERRCODE='42501'; END IF;
 PERFORM catalog.identity_require_scope(e.scope_id,'raw'); SELECT storage_handle INTO STRICT handle FROM catalog_private.identity_evidence_handle WHERE evidence_id=e.id;
 RETURN jsonb_build_object('evidenceId',e.id,'scopeId',e.scope_id,'sha256',e.bytes_sha256,'size',e.size_bytes,'format',e.format,'storageHandle',handle);
END $$;
CREATE FUNCTION catalog.identity_evidence_export(p_evidence uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE e catalog.identity_evidence; workspace jsonb; BEGIN
 SELECT * INTO e FROM catalog.identity_evidence WHERE id=p_evidence;
 IF NOT FOUND THEN RAISE EXCEPTION 'IDENTITY_DENIED' USING ERRCODE='42501'; END IF;
 PERFORM catalog.identity_authorize(e.scope_id,'read'); workspace:=catalog.identity_read(e.scope_id);
 RETURN jsonb_build_object('evidence',(SELECT value FROM jsonb_array_elements(workspace->'proofs') WHERE value->>'evidenceId'=p_evidence::text),
 'observations',(SELECT coalesce(jsonb_agg(value),'[]') FROM jsonb_array_elements(workspace->'observations') WHERE value->>'evidenceId'=p_evidence::text),'verificationEnvironment','fixture','relationshipUsable',false);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA catalog_private FROM ice_p0_02_app_runner,ice_p0_02_auth_runner,ice_p0_02_sync_runner;
REVOKE ALL ON catalog.source_scope,catalog.source_scope_grant,catalog.identity_evidence,catalog.source_identity_contract_revision,catalog.source_record,catalog.identity_claim,catalog.identity_observation,catalog.observation_record_link,catalog.source_identity_request FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_auth_runner,ice_p0_02_sync_runner;
GRANT SELECT ON catalog.source_scope,catalog.source_scope_grant,catalog.identity_evidence,catalog.source_identity_contract_revision,catalog.source_record,catalog.identity_claim,catalog.identity_observation,catalog.observation_record_link,catalog.source_identity_request TO ice_p0_02_app_runner;
DO $$ DECLARE f record; BEGIN FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='catalog' AND p.proname LIKE 'identity_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,ice_p0_02_app_runner,ice_p0_02_auth_runner,ice_p0_02_sync_runner',f.sig); END LOOP; END $$;
GRANT EXECUTE ON FUNCTION catalog.identity_scope_allowed(uuid,text),catalog.identity_authorize(uuid,text),catalog.identity_require_scope(uuid,text),
 catalog.identity_scopes(),catalog.identity_read(uuid),catalog.identity_mutate(uuid,uuid,text,text,jsonb),catalog.identity_receipt(uuid,uuid,text,text),catalog.identity_read_evidence(uuid),catalog.identity_evidence_export(uuid) TO ice_p0_02_app_runner;
RESET ROLE;
