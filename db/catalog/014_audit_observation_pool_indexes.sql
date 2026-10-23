SET ROLE ice_p0_02_owner;

CREATE INDEX IF NOT EXISTS decision_evidence_candidate_selected_item_idx
  ON catalog.decision_evidence (selected_item_id)
  WHERE entry_kind = 'candidate_snapshot' AND selected_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS decision_evidence_candidate_observation_idx
  ON catalog.decision_evidence (observation_id)
  WHERE entry_kind = 'candidate_snapshot' AND observation_id IS NOT NULL;

RESET ROLE;
