-- N1A: exactly ten new tables. Only the guarded fresh-instance prepare applies this file.
SET ROLE ice_p0_02_owner;
CREATE TABLE catalog.source_scope (
 id uuid PRIMARY KEY, system text NOT NULL CHECK(system IN('bigseller','jushuitan','feishu')),
 entity_kind text NOT NULL CHECK(entity_kind IN('product_record','sku_record')),
 scope_state text NOT NULL CHECK(scope_state IN('identity_ready','unresolved')),
 evidence_mode text NOT NULL CHECK(evidence_mode='fixture'), display_name text NOT NULL,
 identity_policy jsonb NOT NULL, canonical_scope text UNIQUE, scope_sha256 text,
 initial_proof_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,entity_kind),
 CHECK((scope_state='identity_ready' AND canonical_scope IS NOT NULL AND scope_sha256 ~ '^[a-f0-9]{64}$' AND octet_length(canonical_scope)<=1800)
 OR(scope_state='unresolved' AND canonical_scope IS NULL AND scope_sha256 IS NULL))
);
CREATE TABLE catalog.source_scope_grant (
 scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT, profile_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 can_read boolean NOT NULL, can_manage boolean NOT NULL, can_evidence boolean NOT NULL, can_amount boolean NOT NULL,
 enabled boolean NOT NULL DEFAULT true, grant_revision integer NOT NULL CHECK(grant_revision>0), authorization_ref text NOT NULL,
 PRIMARY KEY(scope_id,profile_id)
);
CREATE INDEX identity_grant_profile ON catalog.source_scope_grant(profile_id,scope_id);
CREATE TABLE catalog.identity_evidence (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 capture_key text NOT NULL, manifest_id text NOT NULL, bytes_sha256 text NOT NULL CHECK(bytes_sha256 ~ '^[a-f0-9]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0), format text NOT NULL, parser_id text NOT NULL, parser_version text NOT NULL,
 contract_id uuid NOT NULL, contract_revision integer NOT NULL, coverage jsonb NOT NULL, projection_sha256 text NOT NULL,
 adoption_digest text NOT NULL CHECK(adoption_digest ~ '^[a-f0-9]{64}$'), proof_semantics jsonb NOT NULL,
 source_effective_at timestamptz, source_availability text NOT NULL DEFAULT 'not_observed' CHECK(source_availability IN('known','not_observed')),
 document_modified_at timestamptz, document_availability text NOT NULL DEFAULT 'not_observed' CHECK(document_availability IN('known','not_observed')),
 collected_at timestamptz NOT NULL DEFAULT now(), actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 UNIQUE(id,scope_id), UNIQUE(scope_id,capture_key),
 CHECK((source_availability='known')=(source_effective_at IS NOT NULL)), CHECK((document_availability='known')=(document_modified_at IS NOT NULL))
);
CREATE TABLE catalog_private.identity_evidence_handle (
 evidence_id uuid PRIMARY KEY REFERENCES catalog.identity_evidence ON DELETE RESTRICT, storage_handle text NOT NULL
);
CREATE TABLE catalog.source_identity_contract_revision (
 scope_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), previous_revision integer,
 contract_id uuid NOT NULL UNIQUE, entity_kind text NOT NULL, strategy text NOT NULL CHECK(strategy IN('vendor_stable_id','scoped_business_key')),
 key_fields jsonb NOT NULL CHECK(jsonb_typeof(key_fields)='array' AND jsonb_array_length(key_fields)>0),
 required_scope jsonb NOT NULL, identity_dimensions jsonb NOT NULL, normalization text NOT NULL CHECK(normalization='opaque-exact-v1'),
 semantics jsonb NOT NULL, proof_id uuid NOT NULL, reason text NOT NULL, actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,revision),
 UNIQUE(contract_id,scope_id), UNIQUE(contract_id,scope_id,entity_kind), UNIQUE(contract_id,scope_id,entity_kind,revision),
 FOREIGN KEY(scope_id,entity_kind) REFERENCES catalog.source_scope(id,entity_kind) ON DELETE RESTRICT,
 FOREIGN KEY(scope_id,previous_revision) REFERENCES catalog.source_identity_contract_revision(scope_id,revision) ON DELETE RESTRICT,
 FOREIGN KEY(proof_id,scope_id) REFERENCES catalog.identity_evidence(id,scope_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((revision=1 AND previous_revision IS NULL) OR(revision>1 AND previous_revision=revision-1))
);
ALTER TABLE catalog.source_scope ADD CONSTRAINT identity_initial_proof_fk FOREIGN KEY(initial_proof_id,id)
 REFERENCES catalog.identity_evidence(id,scope_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE catalog.source_record (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL, entity_kind text NOT NULL, first_contract_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), state text NOT NULL CHECK(state IN('active','review_required','suspended','revoked')),
 active_claim_id uuid NOT NULL, current_contract_id uuid NOT NULL, latest_request_id uuid NOT NULL,
 UNIQUE(id,scope_id), UNIQUE(id,scope_id,entity_kind),
 FOREIGN KEY(scope_id,entity_kind) REFERENCES catalog.source_scope(id,entity_kind) ON DELETE RESTRICT,
 FOREIGN KEY(first_contract_id,scope_id,entity_kind) REFERENCES catalog.source_identity_contract_revision(contract_id,scope_id,entity_kind) ON DELETE RESTRICT,
 FOREIGN KEY(current_contract_id,scope_id,entity_kind) REFERENCES catalog.source_identity_contract_revision(contract_id,scope_id,entity_kind) ON DELETE RESTRICT
);
CREATE TABLE catalog.identity_claim (
 id uuid PRIMARY KEY, record_id uuid NOT NULL, scope_id uuid NOT NULL, entity_kind text NOT NULL,
 contract_id uuid NOT NULL, contract_revision integer NOT NULL, strategy text NOT NULL CHECK(strategy IN('vendor_stable_id','scoped_business_key')),
 original_key_fields jsonb NOT NULL, canonical_key text NOT NULL CHECK(octet_length(canonical_key)<=1800), key_sha256 text NOT NULL,
 canonical_domain text NOT NULL, domain_sha256 text NOT NULL, proof_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,record_id,scope_id), UNIQUE(scope_id,entity_kind,strategy,contract_revision,canonical_key),
 FOREIGN KEY(record_id,scope_id,entity_kind) REFERENCES catalog.source_record(id,scope_id,entity_kind) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(contract_id,scope_id,entity_kind,contract_revision) REFERENCES catalog.source_identity_contract_revision(contract_id,scope_id,entity_kind,revision) ON DELETE RESTRICT,
 FOREIGN KEY(proof_id,scope_id) REFERENCES catalog.identity_evidence(id,scope_id) ON DELETE RESTRICT
);
CREATE INDEX identity_claim_lookup ON catalog.identity_claim(scope_id,entity_kind,key_sha256);
CREATE INDEX identity_claim_domain ON catalog.identity_claim(scope_id,entity_kind,domain_sha256);
ALTER TABLE catalog.source_record ADD CONSTRAINT identity_head_claim_fk FOREIGN KEY(active_claim_id,id,scope_id)
 REFERENCES catalog.identity_claim(id,record_id,scope_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE catalog.identity_observation (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL, evidence_id uuid NOT NULL, record_pointer text NOT NULL,
 fields jsonb NOT NULL, market_context jsonb NOT NULL, warehouse_context jsonb NOT NULL, position jsonb NOT NULL,
 payload_sha256 text NOT NULL, source_effective_at timestamptz, source_availability text NOT NULL CHECK(source_availability IN('known','not_observed')),
 collected_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,scope_id), UNIQUE(evidence_id,record_pointer),
 FOREIGN KEY(evidence_id,scope_id) REFERENCES catalog.identity_evidence(id,scope_id) ON DELETE RESTRICT,
 CHECK((source_availability='known')=(source_effective_at IS NOT NULL))
);
CREATE TABLE catalog.observation_record_link (
 observation_key text NOT NULL, link_revision integer NOT NULL CHECK(link_revision>0), previous_revision integer,
 scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT, origin_kind text NOT NULL CHECK(origin_kind IN('frozen','identity')),
 frozen_observation_id uuid REFERENCES catalog.source_observation ON DELETE RESTRICT,
 identity_observation_id uuid, record_id uuid NOT NULL, contract_id uuid NOT NULL, proof_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN('linked','revoked')), frozen_decision_ids uuid[] NOT NULL DEFAULT '{}',
 reason text NOT NULL, actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(observation_key,link_revision), UNIQUE(observation_key,link_revision,scope_id),
 FOREIGN KEY(observation_key,previous_revision,scope_id) REFERENCES catalog.observation_record_link(observation_key,link_revision,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(identity_observation_id,scope_id) REFERENCES catalog.identity_observation(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(record_id,scope_id) REFERENCES catalog.source_record(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(proof_id,scope_id) REFERENCES catalog.identity_evidence(id,scope_id) ON DELETE RESTRICT,
 FOREIGN KEY(contract_id,scope_id) REFERENCES catalog.source_identity_contract_revision(contract_id,scope_id) ON DELETE RESTRICT,
 CHECK((origin_kind='frozen' AND frozen_observation_id IS NOT NULL AND identity_observation_id IS NULL AND observation_key='frozen:'||frozen_observation_id::text)
 OR(origin_kind='identity' AND identity_observation_id IS NOT NULL AND frozen_observation_id IS NULL AND observation_key='identity:'||identity_observation_id::text)),
 CHECK((link_revision=1 AND previous_revision IS NULL) OR(link_revision>1 AND previous_revision=link_revision-1))
);
CREATE TABLE catalog.source_identity_request (
 request_id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES catalog.source_scope ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT, action text NOT NULL CHECK(action IN('import_capture','register','revise','link')),
 intent_sha256 text NOT NULL CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 proof_id uuid NOT NULL, reason text NOT NULL, source_record_id uuid, record_revision integer, previous_revision integer,
 before_state jsonb, after_state jsonb, recorded_at timestamptz NOT NULL DEFAULT now(), request_xid bigint NOT NULL DEFAULT txid_current(),
 UNIQUE(source_record_id,record_revision), UNIQUE(source_record_id,record_revision,scope_id), UNIQUE(source_record_id,record_revision,request_id),
 FOREIGN KEY(source_record_id,scope_id) REFERENCES catalog.source_record(id,scope_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(source_record_id,previous_revision,scope_id) REFERENCES catalog.source_identity_request(source_record_id,record_revision,scope_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(proof_id,scope_id) REFERENCES catalog.identity_evidence(id,scope_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((source_record_id IS NULL AND record_revision IS NULL AND previous_revision IS NULL AND before_state IS NULL AND after_state IS NULL)
 OR(source_record_id IS NOT NULL AND after_state IS NOT NULL AND ((record_revision=1 AND previous_revision IS NULL AND before_state IS NULL)
 OR(record_revision>1 AND previous_revision=record_revision-1 AND before_state IS NOT NULL))))
);
ALTER TABLE catalog.source_record ADD CONSTRAINT identity_head_request_fk FOREIGN KEY(id,revision,latest_request_id)
 REFERENCES catalog.source_identity_request(source_record_id,record_revision,request_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
RESET ROLE;
