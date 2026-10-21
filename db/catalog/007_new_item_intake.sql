-- N1C; apply only through the guarded, newly-created A+C fixture instance.
SET ROLE ice_p0_02_owner;
ALTER TABLE catalog.source_scope_grant ADD COLUMN can_publish_catalog boolean NOT NULL DEFAULT false;
CREATE TABLE catalog.product_capture (
 id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,
 capture_key text NOT NULL,approved_fixture_id text NOT NULL,manifest_id text NOT NULL,fixture_manifest_sha256 text NOT NULL,
 bytes_sha256 text NOT NULL,projection_sha256 text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>=0),format text NOT NULL,
 parser_id text NOT NULL,parser_version text NOT NULL,schema_version text NOT NULL CHECK(schema_version='product-observation-v1'),
 adoption_digest text NOT NULL,association_proofs jsonb NOT NULL DEFAULT '[]',coverage jsonb NOT NULL,
 source_effective_at timestamptz(6),source_availability text NOT NULL CHECK(source_availability IN('known','not_observed')),
 document_modified_at timestamptz(6),document_availability text NOT NULL CHECK(document_availability IN('known','not_observed')),
 collected_at timestamptz(6) NOT NULL,actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,request_id uuid NOT NULL,
 UNIQUE(id,scope_id),UNIQUE(scope_id,capture_key),
 CHECK(fixture_manifest_sha256~'^[a-f0-9]{64}$' AND bytes_sha256~'^[a-f0-9]{64}$' AND projection_sha256~'^[a-f0-9]{64}$' AND adoption_digest~'^[a-f0-9]{64}$'),
 CHECK((source_availability='known')=(source_effective_at IS NOT NULL)),CHECK((document_availability='known')=(document_modified_at IS NOT NULL))
);
CREATE TABLE catalog_private.product_capture_handle (
 capture_id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,storage_handle text NOT NULL,
 FOREIGN KEY(capture_id,scope_id) REFERENCES catalog.product_capture(id,scope_id) ON DELETE RESTRICT
);
CREATE TABLE catalog.product_observation (
 id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,capture_id uuid NOT NULL,record_pointer text NOT NULL,
 position jsonb NOT NULL,fields jsonb NOT NULL,market_context jsonb NOT NULL,warehouse_context jsonb NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),raw_ref text NOT NULL,
 identity_observation_id uuid,source_record_id uuid,source_record_revision integer,source_claim_id uuid,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,scope_id),UNIQUE(capture_id,record_pointer),FOREIGN KEY(capture_id,scope_id) REFERENCES catalog.product_capture(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(identity_observation_id,scope_id) REFERENCES catalog.identity_observation(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_record_id,source_record_revision,scope_id) REFERENCES catalog.source_identity_request(source_record_id,record_revision,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_claim_id,source_record_id,scope_id) REFERENCES catalog.identity_claim(id,record_id,scope_id) ON DELETE RESTRICT,
 CHECK(num_nonnulls(source_record_id,source_record_revision,source_claim_id) IN(0,3)),CHECK(source_record_revision IS NULL OR source_record_revision>0)
);
CREATE TABLE catalog.intake_classification_revision (
 observation_id uuid NOT NULL,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,revision integer NOT NULL CHECK(revision>0),previous_revision integer,
 classification text NOT NULL CHECK(classification IN('new_item','item_update','external_sku','suspected_version')),review_state text NOT NULL CHECK(review_state IN('proposed','needs_review')),
 proposed_item_id uuid,expected_item_revision integer,proposed_field_keys text[] NOT NULL DEFAULT '{}',source_record_id uuid,source_record_revision integer,source_claim_id uuid,
 reason text NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(observation_id,revision),UNIQUE(observation_id,revision,scope_id),
 FOREIGN KEY(observation_id,scope_id) REFERENCES catalog.product_observation(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(observation_id,previous_revision,scope_id) REFERENCES catalog.intake_classification_revision(observation_id,revision,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(proposed_item_id,expected_item_revision) REFERENCES catalog.item_revision(item_id,revision) ON DELETE RESTRICT,
 FOREIGN KEY(source_record_id,source_record_revision,scope_id) REFERENCES catalog.source_identity_request(source_record_id,record_revision,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_claim_id,source_record_id,scope_id) REFERENCES catalog.identity_claim(id,record_id,scope_id) ON DELETE RESTRICT,
 CHECK(num_nonnulls(proposed_item_id,expected_item_revision) IN(0,2)),CHECK(num_nonnulls(source_record_id,source_record_revision,source_claim_id) IN(0,3)),
 CHECK((revision=1 AND previous_revision IS NULL) OR(revision>1 AND previous_revision=revision-1))
);
CREATE TABLE catalog.new_item_decision (
 id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,observation_id uuid NOT NULL UNIQUE,classification_revision integer NOT NULL,
 item_id uuid NOT NULL UNIQUE,initial_revision integer NOT NULL DEFAULT 1 CHECK(initial_revision=1),request_id uuid NOT NULL UNIQUE,publication_token uuid NOT NULL UNIQUE,
 adopted_field_keys text[] NOT NULL,adoption_sha256 text NOT NULL CHECK(adoption_sha256~'^[a-f0-9]{64}$'),creation_business_sha256 text NOT NULL CHECK(creation_business_sha256~'^[a-f0-9]{64}$'),
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,item_id),UNIQUE(id,item_id,scope_id),UNIQUE(id,item_id,scope_id,observation_id),
 FOREIGN KEY(observation_id,classification_revision,scope_id) REFERENCES catalog.intake_classification_revision(observation_id,revision,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(item_id,initial_revision) REFERENCES catalog.item_revision(item_id,revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE catalog.catalog_item ALTER COLUMN first_release_id DROP NOT NULL;
ALTER TABLE catalog.catalog_item ADD COLUMN creation_decision_id uuid;
ALTER TABLE catalog.catalog_item ADD CONSTRAINT catalog_item_origin_xor CHECK(num_nonnulls(first_release_id,creation_decision_id)=1);
ALTER TABLE catalog.catalog_item ADD CONSTRAINT catalog_item_creation_unique UNIQUE(creation_decision_id);
ALTER TABLE catalog.catalog_item ADD CONSTRAINT catalog_item_creation_pair UNIQUE(id,creation_decision_id);
ALTER TABLE catalog.catalog_item ADD CONSTRAINT catalog_item_creation_fk FOREIGN KEY(creation_decision_id,id) REFERENCES catalog.new_item_decision(id,item_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE catalog.new_item_decision ADD CONSTRAINT new_item_decision_item_fk FOREIGN KEY(item_id,id) REFERENCES catalog.catalog_item(id,creation_decision_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE catalog.item_observation_origin (
 id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,observation_id uuid NOT NULL,item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 origin_kind text NOT NULL CHECK(origin_kind IN('created','associated_existing','source_attached')),association_basis_kind text NOT NULL DEFAULT 'none' CHECK(association_basis_kind IN('none','catalog_proof','source_slot')),
 creation_decision_id uuid,creation_observation_id uuid,basis_origin_id uuid,basis_source_slot_record_id uuid,baseline_release_id uuid,baseline_artifact_id uuid,baseline_json_pointer text,
 association_capture_id uuid,association_proof_key text,coverage_identity_observation_id uuid,coverage_identity_link_key text,coverage_identity_link_revision integer,
 source_record_id uuid,source_record_revision integer,source_claim_id uuid,request_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,scope_id),UNIQUE(id,item_id,scope_id),UNIQUE(id,item_id,scope_id,observation_id),
 FOREIGN KEY(observation_id,scope_id) REFERENCES catalog.product_observation(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(creation_decision_id,item_id,scope_id,creation_observation_id) REFERENCES catalog.new_item_decision(id,item_id,scope_id,observation_id) ON DELETE RESTRICT,
 FOREIGN KEY(basis_origin_id,item_id,scope_id) REFERENCES catalog.item_observation_origin(id,item_id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(baseline_release_id,baseline_artifact_id,baseline_json_pointer) REFERENCES catalog.baseline_item_anchor(release_id,artifact_id,json_pointer) ON DELETE RESTRICT,
 FOREIGN KEY(association_capture_id,scope_id) REFERENCES catalog.product_capture(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_record_id,source_record_revision,scope_id) REFERENCES catalog.source_identity_request(source_record_id,record_revision,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_claim_id,source_record_id,scope_id) REFERENCES catalog.identity_claim(id,record_id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(coverage_identity_observation_id,scope_id) REFERENCES catalog.identity_observation(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(coverage_identity_link_key,coverage_identity_link_revision,scope_id) REFERENCES catalog.observation_record_link(observation_key,link_revision,scope_id) ON DELETE RESTRICT,
 CHECK(num_nonnulls(creation_decision_id,creation_observation_id) IN(0,2)),CHECK(num_nonnulls(baseline_release_id,baseline_artifact_id,baseline_json_pointer) IN(0,3)),
 CHECK(num_nonnulls(association_capture_id,association_proof_key) IN(0,2)),CHECK(num_nonnulls(source_record_id,source_record_revision,source_claim_id) IN(0,3)),
 CHECK((origin_kind='associated_existing')=(association_basis_kind<>'none')),
 CHECK((association_basis_kind='source_slot' AND num_nonnulls(basis_source_slot_record_id,creation_decision_id,creation_observation_id,basis_origin_id,source_record_id,source_record_revision,source_claim_id,coverage_identity_observation_id,coverage_identity_link_key,coverage_identity_link_revision)=10 AND basis_source_slot_record_id=source_record_id AND baseline_release_id IS NULL AND coverage_identity_link_key='identity:'||coverage_identity_observation_id::text AND coverage_identity_link_revision>0)
 OR(association_basis_kind<>'source_slot' AND num_nonnulls(basis_source_slot_record_id,coverage_identity_observation_id,coverage_identity_link_key,coverage_identity_link_revision)=0)),
 CHECK(origin_kind<>'created' OR(creation_decision_id IS NOT NULL AND creation_observation_id=observation_id AND basis_origin_id IS NULL AND baseline_release_id IS NULL)),
 CHECK(association_basis_kind<>'catalog_proof' OR(association_capture_id IS NOT NULL AND num_nonnulls(basis_origin_id,baseline_release_id)=1)),
 CHECK(origin_kind<>'source_attached' OR(basis_origin_id IS NOT NULL AND source_record_id IS NOT NULL))
);
CREATE UNIQUE INDEX new_item_observation_assignment ON catalog.item_observation_origin(observation_id) WHERE origin_kind IN('created','associated_existing');
CREATE UNIQUE INDEX new_item_source_attachment ON catalog.item_observation_origin(observation_id,source_record_id) WHERE origin_kind='source_attached';
CREATE TABLE catalog.new_item_source_claim (
 source_record_id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,creation_decision_id uuid NOT NULL,item_id uuid NOT NULL,origin_id uuid NOT NULL,
 source_record_revision integer NOT NULL CHECK(source_record_revision>0),source_claim_id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_record_id,item_id,scope_id,creation_decision_id,origin_id),
 FOREIGN KEY(source_record_id,scope_id) REFERENCES catalog.source_record(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_record_id,source_record_revision,scope_id) REFERENCES catalog.source_identity_request(source_record_id,record_revision,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(source_claim_id,source_record_id,scope_id) REFERENCES catalog.identity_claim(id,record_id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(creation_decision_id,item_id,scope_id) REFERENCES catalog.new_item_decision(id,item_id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(origin_id,item_id,scope_id) REFERENCES catalog.item_observation_origin(id,item_id,scope_id) ON DELETE RESTRICT
);
ALTER TABLE catalog.item_observation_origin ADD CONSTRAINT new_item_origin_slot_fk FOREIGN KEY(basis_source_slot_record_id,item_id,scope_id,creation_decision_id,basis_origin_id) REFERENCES catalog.new_item_source_claim(source_record_id,item_id,scope_id,creation_decision_id,origin_id) ON DELETE RESTRICT;
CREATE TABLE catalog.new_item_request (
 request_id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN('import_product_capture','classify_observation','confirm_new_item','associate_existing_item','attach_source_identity','assign_initial_code','append_nonprice_revision')),
 intent_sha256 text NOT NULL CHECK(intent_sha256~'^[a-f0-9]{64}$'),result jsonb NOT NULL,reason text NOT NULL,
 observation_id uuid,classification_revision integer,item_id uuid,item_revision integer,publication_token uuid UNIQUE,adopted_field_keys text[] NOT NULL DEFAULT '{}',
 private_field_evidence jsonb NOT NULL DEFAULT '{}',source_disposition_sha256 text,request_xid bigint NOT NULL DEFAULT txid_current(),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,scope_id),FOREIGN KEY(observation_id,scope_id) REFERENCES catalog.product_observation(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(item_id,item_revision) REFERENCES catalog.item_revision(item_id,revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK(num_nonnulls(item_id,item_revision) IN(0,2)),CHECK(source_disposition_sha256 IS NULL OR source_disposition_sha256~'^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX new_item_publication_revision ON catalog.new_item_request(item_id,item_revision) WHERE publication_token IS NOT NULL;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['product_capture','intake_classification_revision','new_item_decision','item_observation_origin','new_item_source_claim'] LOOP
 EXECUTE format('ALTER TABLE catalog.%I ADD FOREIGN KEY(request_id,scope_id) REFERENCES catalog.new_item_request(request_id,scope_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED',t);
 END LOOP; END $$;
CREATE INDEX product_observation_scope ON catalog.product_observation(scope_id,capture_id);
CREATE INDEX intake_classification_head ON catalog.intake_classification_revision(observation_id,revision DESC);
CREATE INDEX intake_origin_source ON catalog.item_observation_origin(source_record_id,scope_id);
CREATE INDEX intake_origin_item ON catalog.item_observation_origin(item_id,scope_id);
CREATE INDEX intake_request_actor ON catalog.new_item_request(scope_id,actor_id,request_id);
CREATE INDEX intake_classification_scope_source ON catalog.intake_classification_revision(scope_id,source_record_id,observation_id,revision DESC);
CREATE INDEX intake_decision_scope ON catalog.new_item_decision(scope_id,item_id);
CREATE INDEX intake_origin_scope ON catalog.item_observation_origin(scope_id,source_record_id,item_id);
CREATE INDEX intake_source_claim_scope ON catalog.new_item_source_claim(scope_id,source_record_id);
CREATE INDEX product_capture_handle_scope ON catalog_private.product_capture_handle(scope_id,capture_id);
RESET ROLE;
