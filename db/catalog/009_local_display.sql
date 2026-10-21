-- Local sample display: BS inventory snapshot and valuation basis (not live inventory).
SET ROLE ice_p0_02_owner;

CREATE TABLE catalog.bs_sample_export (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL UNIQUE REFERENCES catalog.baseline_release ON DELETE RESTRICT,
  export_label text NOT NULL,
  source_xlsx_sha256 text NOT NULL CHECK(source_xlsx_sha256 ~ '^[a-f0-9]{64}$'),
  sheet_name text NOT NULL,
  row_count integer NOT NULL CHECK(row_count = 530),
  basis_document_sha256 text NOT NULL CHECK(basis_document_sha256 ~ '^[a-f0-9]{64}$'),
  adoption_sha256 text NOT NULL CHECK(adoption_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog.bs_sample_inventory_row (
  export_id uuid NOT NULL REFERENCES catalog.bs_sample_export ON DELETE RESTRICT,
  excel_row integer NOT NULL CHECK(excel_row > 1),
  source_row_key text NOT NULL,
  observation_id uuid NOT NULL REFERENCES catalog.source_observation ON DELETE RESTRICT,
  warehouse text NOT NULL,
  sku text NOT NULL CHECK(length(btrim(sku)) > 0),
  on_hand text,
  order_locked text,
  warehouse_available text,
  activity_reserved text,
  in_transit text,
  formula_ok boolean,
  selection_state text NOT NULL CHECK(selection_state IN ('confirmed', 'unselected')),
  selected_item_id uuid REFERENCES catalog.catalog_item ON DELETE RESTRICT,
  PRIMARY KEY(export_id, excel_row),
  UNIQUE(export_id, observation_id)
);

CREATE INDEX bs_sample_inventory_row_item_idx ON catalog.bs_sample_inventory_row(selected_item_id);
CREATE INDEX bs_sample_inventory_row_wh_idx ON catalog.bs_sample_inventory_row(warehouse);

RESET ROLE;
