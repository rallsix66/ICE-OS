-- Catalog first slice. Apply only to the separately guarded fresh catalog instance.
CREATE SCHEMA catalog AUTHORIZATION ice_p0_02_owner;
CREATE SCHEMA catalog_private AUTHORIZATION ice_p0_02_owner;
-- The catalog definer owns no legacy table and receives only the minimal
-- profile checks / actor FK privileges needed by this module.
GRANT SELECT, REFERENCES ON public.profiles TO ice_p0_02_owner;
GRANT SELECT ON public.role TO ice_p0_02_owner;
GRANT USAGE ON SCHEMA auth TO ice_p0_02_owner;
GRANT EXECUTE ON FUNCTION auth.uid(),public.get_user_role() TO ice_p0_02_owner;
SET ROLE ice_p0_02_owner;

CREATE TABLE catalog.baseline_release (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_key text NOT NULL UNIQUE,
 bundle_sha256 text NOT NULL CHECK(bundle_sha256 ~ '^[a-f0-9]{64}$'),
 effective_csv_sha256 text NOT NULL CHECK(effective_csv_sha256 ~ '^[a-f0-9]{64}$'),
 parser_version text NOT NULL, adoption_sha256 text NOT NULL,
 manifest jsonb NOT NULL, published boolean NOT NULL DEFAULT false,
 published_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bundle_sha256,effective_csv_sha256)
);
CREATE TABLE catalog.artifact (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES catalog.baseline_release ON DELETE RESTRICT,
 logical_name text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 format text NOT NULL, sensitivity text NOT NULL CHECK(sensitivity='restricted'),
 UNIQUE(release_id,logical_name), UNIQUE(id,release_id)
);
CREATE TABLE catalog_private.artifact_handle (
 artifact_id uuid PRIMARY KEY REFERENCES catalog.artifact ON DELETE RESTRICT, storage_handle text NOT NULL
);
CREATE TABLE catalog.catalog_item (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), first_release_id uuid NOT NULL REFERENCES catalog.baseline_release ON DELETE RESTRICT,
 new_product_confirmed boolean NOT NULL DEFAULT false, confirmation_ref text,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog.catalog_item_code (
 item_id uuid PRIMARY KEY REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 ice_code varchar(50) NOT NULL UNIQUE CHECK(length(btrim(ice_code))>0 AND ice_code=btrim(ice_code)),
 evidence_ref text NOT NULL, request_id uuid, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog.baseline_item_anchor (
 release_id uuid NOT NULL REFERENCES catalog.baseline_release ON DELETE RESTRICT,
 artifact_id uuid NOT NULL, json_pointer text NOT NULL, item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 row_position integer NOT NULL, payload_sha256 text NOT NULL,
 PRIMARY KEY(release_id,artifact_id,json_pointer), UNIQUE(release_id,item_id),
 FOREIGN KEY(artifact_id,release_id) REFERENCES catalog.artifact(id,release_id) ON DELETE RESTRICT
);
CREATE TABLE catalog.item_revision (
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT, revision integer NOT NULL CHECK(revision>0),
 previous_revision integer, ice_code_snapshot text, name_cn text NOT NULL CHECK(length(name_cn)>0), fields jsonb NOT NULL,
 artifact_id uuid REFERENCES catalog.artifact ON DELETE RESTRICT, evidence_ref text NOT NULL, reason text NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(item_id,revision), FOREIGN KEY(item_id,previous_revision) REFERENCES catalog.item_revision ON DELETE RESTRICT,
 CHECK((revision=1 AND previous_revision IS NULL) OR previous_revision=revision-1)
);
CREATE TABLE catalog_private.item_financial_revision (
 item_id uuid NOT NULL REFERENCES catalog.catalog_item ON DELETE RESTRICT, financial_revision integer NOT NULL CHECK(financial_revision>0),
 payload jsonb NOT NULL, PRIMARY KEY(item_id,financial_revision)
);
CREATE TABLE catalog.item_current (
 item_id uuid PRIMARY KEY REFERENCES catalog.catalog_item ON DELETE RESTRICT, revision integer NOT NULL, financial_revision integer,
 FOREIGN KEY(item_id,revision) REFERENCES catalog.item_revision ON DELETE RESTRICT,
 FOREIGN KEY(item_id,financial_revision) REFERENCES catalog_private.item_financial_revision ON DELETE RESTRICT
);
CREATE TABLE catalog.source_namespace (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system text NOT NULL CHECK(system IN ('bigseller','jushuitan','feishu')),
 local_key text NOT NULL UNIQUE, account_scope jsonb NOT NULL
);
CREATE TABLE catalog.source_dataset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), namespace_id uuid NOT NULL REFERENCES catalog.source_namespace ON DELETE RESTRICT,
 local_dataset_key text NOT NULL, resource_identity jsonb NOT NULL, key_contract jsonb NOT NULL,
 UNIQUE(namespace_id,local_dataset_key)
);
CREATE TABLE catalog.observation_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dataset_id uuid NOT NULL REFERENCES catalog.source_dataset ON DELETE RESTRICT,
 release_id uuid NOT NULL REFERENCES catalog.baseline_release ON DELETE RESTRICT, artifact_id uuid NOT NULL REFERENCES catalog.artifact ON DELETE RESTRICT,
 snapshot_key text NOT NULL, content_sha256 text NOT NULL, coverage jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(dataset_id,snapshot_key)
);
CREATE TABLE catalog.source_observation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES catalog.observation_batch ON DELETE RESTRICT,
 artifact_id uuid NOT NULL REFERENCES catalog.artifact ON DELETE RESTRICT, entry_key text NOT NULL,
 legacy_candidate_id text, position jsonb NOT NULL, scope jsonb NOT NULL, fields jsonb NOT NULL, review_state text,
 raw_ref text NOT NULL, payload_sha256 text NOT NULL, UNIQUE(batch_id,entry_key)
);
CREATE TABLE catalog_private.observation_amounts (
 observation_id uuid PRIMARY KEY REFERENCES catalog.source_observation ON DELETE RESTRICT, payload jsonb NOT NULL
);
CREATE TABLE catalog.decision_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES catalog.baseline_release ON DELETE RESTRICT,
 artifact_id uuid NOT NULL, entry_kind text NOT NULL, entry_key text NOT NULL,
 observation_id uuid REFERENCES catalog.source_observation ON DELETE RESTRICT, selected_item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
 selected_jushuitan_ref text, selected_jushuitan_sha256 text, review_state text, payload_sha256 text NOT NULL, raw_ref text NOT NULL, summary jsonb NOT NULL,
 UNIQUE(release_id,artifact_id,entry_kind,entry_key),
 FOREIGN KEY(artifact_id,release_id) REFERENCES catalog.artifact(id,release_id) ON DELETE RESTRICT
);
CREATE TABLE catalog.audit_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE, intent_sha256 text NOT NULL,
 actor_id uuid NOT NULL REFERENCES public.profiles ON DELETE RESTRICT, action text NOT NULL,
 item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT, release_id uuid REFERENCES catalog.baseline_release ON DELETE RESTRICT,
 result jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
RESET ROLE;
