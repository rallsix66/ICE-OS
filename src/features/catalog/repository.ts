import 'server-only';

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withAppDb, type DbIdentity } from '@/lib/database/app-db';
import type { CatalogItemDto, CatalogItemRevisionDto, FieldObservation, PreparedBaseline, PreparedFrozenObservations, PreparedFinancial, SourceSystem } from './types';

export interface CatalogRelease {
  releaseId: string; releaseKey: string; published: boolean; itemCount: number; observationCount: number; selectedCount: number;
}
export interface PublishResult { releaseId: string; published: true; itemCount: number; observationCount: number; selectedCount: number }
export interface SafeDecision {
  decisionId: string; entryKind: string; entryKey: string; observationId: string | null; selectedItemId: string | null;
  selectedJushuitanRef: string | null; reviewState: string | null; rawRef: string; summary: Record<string, string | number | boolean | null | string[]>;
}
export interface SafeObservation {
  observationId: string; sourceSystem: SourceSystem; entryKey: string; legacyCandidateId: string | null;
  position: Record<string, string | number | null>; scope: Record<string, unknown>; fields: Record<string, FieldObservation>;
  reviewState: string | null; rawRef: string; coverage: Record<string, unknown>; selectedItemId: string | null; existingDecisionRef: string | null;
  conflicts: string[];
}
export interface SafeArtifact { artifactId: string; logicalName: string; sha256: string; size: number; format: string; sensitivity: 'restricted' }
export interface EvidenceArtifact { artifactId: string; logicalName: string; sha256: string; size: number; storageHandle: string }
export interface MutationResult { itemId: string; revision: number; iceCode: string | null }
export interface FrozenImportResult { batchId: string; observationCount: number }
export class CatalogOperationError extends Error {
  readonly code: 'CATALOG_REQUEST_OUTCOME_UNKNOWN';
  constructor(code: 'CATALOG_REQUEST_OUTCOME_UNKNOWN') { super(code); this.name = 'CatalogOperationError'; this.code = code; }
}

export function intentHash(action: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([action, value])).digest('hex');
}

type ItemRow = { item_id: string; revision: number; ice_code_snapshot: string | null; new_product_confirmed: boolean;
  name_cn: string; fields: Record<string, FieldObservation>; evidence_ref: string; bigseller: string; jushuitan: string };
type RevisionRow = ItemRow & { reason: string; actor_id: string; recorded_at: Date };
function itemDto(row: ItemRow): CatalogItemDto {
  const missing: FieldObservation = { state: 'not_read', raw: null, reason: 'Not present in accepted projection', evidenceRef: row.evidence_ref };
  return { itemId: row.item_id, revision: row.revision, iceCode: row.ice_code_snapshot,
    codeState: row.ice_code_snapshot === null ? 'awaiting_code' : 'coded', newProductConfirmed: row.new_product_confirmed,
    nameCn: row.name_cn, fields: row.fields, specification: row.fields.specification ?? missing,
    barcodeRefs: [row.fields.barcode ?? missing], humanChoices: { bigseller: Number(row.bigseller), jushuitan: Number(row.jushuitan) },
    sourceRecordId: null, sourceIdentityVerified: false, relationshipUsable: false, provenanceRefs: [row.evidence_ref] };
}
function revisionDto(row: RevisionRow): CatalogItemRevisionDto {
  return { ...itemDto(row), revisionAudit: { reason: row.reason, actorId: row.actor_id,
    recordedAt: row.recorded_at.toISOString(), evidenceRef: row.evidence_ref } };
}
const itemSelect = `SELECT i.id AS item_id,r.revision,r.ice_code_snapshot,i.new_product_confirmed,r.name_cn,r.fields,r.evidence_ref,
 r.reason,r.actor_id,r.recorded_at,
 (SELECT count(*) FROM catalog.decision_evidence d JOIN catalog.source_observation o ON o.id=d.observation_id
 JOIN catalog.observation_batch b ON b.id=o.batch_id JOIN catalog.source_dataset ds ON ds.id=b.dataset_id
 JOIN catalog.source_namespace n ON n.id=ds.namespace_id WHERE d.selected_item_id=i.id AND d.entry_kind='candidate_snapshot' AND n.system='bigseller')::text AS bigseller,
 (SELECT count(*) FROM catalog.decision_evidence d JOIN catalog.source_observation o ON o.id=d.observation_id
 JOIN catalog.observation_batch b ON b.id=o.batch_id JOIN catalog.source_dataset ds ON ds.id=b.dataset_id
 JOIN catalog.source_namespace n ON n.id=ds.namespace_id WHERE d.selected_item_id=i.id AND d.entry_kind='candidate_snapshot' AND n.system='jushuitan')::text AS jushuitan
 FROM catalog.catalog_item i JOIN catalog.item_current c ON c.item_id=i.id JOIN catalog.item_revision r ON r.item_id=i.id`;

async function rpc<T>(client: PoolClient, name: string, values: unknown[]): Promise<T> {
  // Function names are module constants, never request input.
  const args = values.map((_, i) => `$${i + 1}`).join(',');
  const result = await client.query<{ result: T }>(`SELECT catalog.${name}(${args}) AS result`, values);
  return result.rows[0]!.result;
}

/** An uncertain COMMIT is reconciled by the original request, never replayed blind. */
async function mutation<T>(identity: DbIdentity, requestId: string, action: string, intent: string, name: string, values: unknown[]): Promise<T> {
  try {
    return await withAppDb(identity, (c) => rpc<T>(c, name, values));
  } catch (original) {
    try {
      const persisted = await withAppDb(identity, async (c) => {
        await c.query('SELECT catalog.require_admin()');
        const result = await c.query<{ action: string; intent_sha256: string; result: T }>(
          'SELECT action,intent_sha256,result FROM catalog.audit_event WHERE request_id=$1 AND actor_id=$2', [requestId, identity.profileUserId]);
        return result.rows[0];
      });
      if (persisted && persisted.action === action && persisted.intent_sha256 === intent) return persisted.result;
    } catch {
      // Receipt query failure remains an unknown result; caller retries same request id.
    }
    const sqlCode = typeof original === 'object' && original !== null && 'code' in original ? String(original.code) : '';
    if (!sqlCode || sqlCode.startsWith('08') || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(sqlCode)) {
      throw new CatalogOperationError('CATALOG_REQUEST_OUTCOME_UNKNOWN');
    }
    throw original;
  }
}

export const catalogRepository = {
  async originKind(identity: DbIdentity, itemId: string): Promise<'baseline' | 'new_item' | null> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const row = (await c.query<{ first_release_id: string | null }>('SELECT first_release_id FROM catalog.catalog_item WHERE id=$1', [itemId])).rows[0];
      return row ? row.first_release_id === null ? 'new_item' : 'baseline' : null;
    });
  },
  async list(identity: DbIdentity, options: { baselinePublishedOnly?: boolean } = {}): Promise<CatalogItemDto[]> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const baselineFilter = options.baselinePublishedOnly ? ' AND i.first_release_id IS NOT NULL' : '';
      const result = await c.query<ItemRow>(`${itemSelect} WHERE r.revision=c.revision${baselineFilter} ORDER BY r.name_cn,i.id`);
      return result.rows.map(itemDto);
    });
  },
  async get(identity: DbIdentity, itemId: string, revision?: number): Promise<CatalogItemDto | null> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const result = await c.query<ItemRow>(`${itemSelect} WHERE i.id=$1 AND r.revision=coalesce($2::integer,c.revision)`, [itemId, revision ?? null]);
      return result.rows[0] ? itemDto(result.rows[0]) : null;
    });
  },
  async history(identity: DbIdentity, itemId: string): Promise<CatalogItemRevisionDto[]> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const result = await c.query<RevisionRow>(`${itemSelect} WHERE i.id=$1 ORDER BY r.revision DESC`, [itemId]);
      return result.rows.map(revisionDto);
    });
  },
  async release(identity: DbIdentity): Promise<CatalogRelease | null> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const result = await c.query<{ id: string; release_key: string; published: boolean; manifest: PreparedBaseline['counts'] }>(
        'SELECT id,release_key,published,manifest FROM catalog.baseline_release WHERE published ORDER BY recorded_at LIMIT 1');
      const r = result.rows[0];
      return r ? { releaseId: r.id, releaseKey: r.release_key, published: r.published, itemCount: r.manifest.items,
        observationCount: r.manifest.observations, selectedCount: r.manifest.selected } : null;
    });
  },
  async decisions(identity: DbIdentity, itemId?: string): Promise<SafeDecision[]> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query(`SELECT id AS "decisionId",entry_kind AS "entryKind",entry_key AS "entryKey",
      observation_id AS "observationId",selected_item_id AS "selectedItemId",selected_jushuitan_ref AS "selectedJushuitanRef",
      review_state AS "reviewState",raw_ref AS "rawRef",summary FROM catalog.decision_evidence d
      WHERE ($1::uuid IS NULL OR selected_item_id=$1 OR EXISTS(
        SELECT 1 FROM catalog.decision_evidence current_choice WHERE current_choice.entry_kind='candidate_snapshot'
        AND current_choice.selected_item_id=$1 AND current_choice.observation_id=d.observation_id
      )) ORDER BY entry_kind,entry_key`, [itemId ?? null]);
      return rows as SafeDecision[];
    });
  },
  async observations(identity: DbIdentity): Promise<SafeObservation[]> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query(`SELECT o.id AS "observationId",n.system AS "sourceSystem",o.entry_key AS "entryKey",
      o.legacy_candidate_id AS "legacyCandidateId",o.position,o.scope,o.fields,o.review_state AS "reviewState",o.raw_ref AS "rawRef",b.coverage,
      d.selected_item_id AS "selectedItemId",d.id AS "existingDecisionRef",coalesce(d.summary->'flags','[]'::jsonb) AS conflicts FROM catalog.source_observation o
      JOIN catalog.observation_batch b ON b.id=o.batch_id JOIN catalog.source_dataset ds ON ds.id=b.dataset_id
      JOIN catalog.source_namespace n ON n.id=ds.namespace_id LEFT JOIN catalog.decision_evidence d ON d.observation_id=o.id AND d.entry_kind='candidate_snapshot'
      ORDER BY n.system,o.entry_key`);
      return rows as SafeObservation[];
    });
  },
  async artifacts(identity: DbIdentity): Promise<SafeArtifact[]> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      return (await c.query(`SELECT id AS "artifactId",logical_name AS "logicalName",sha256,size_bytes::integer AS size,format,sensitivity
        FROM catalog.artifact ORDER BY logical_name`)).rows as SafeArtifact[];
    });
  },
  async publish(identity: DbIdentity, requestId: string, prepared: PreparedBaseline): Promise<PublishResult> {
    const intent = intentHash('publish_baseline', prepared.contentSha256);
    return mutation(identity, requestId, 'publish_baseline', intent, 'publish_baseline', [requestId, intent, JSON.stringify(prepared)]);
  },
  async importFrozen(identity: DbIdentity, requestId: string, prepared: PreparedFrozenObservations): Promise<FrozenImportResult> {
    const intent = intentHash('import_frozen_observations', prepared.contentSha256);
    return mutation(identity, requestId, 'import_frozen_observations', intent, 'import_frozen_observations', [requestId, intent, JSON.stringify(prepared)]);
  },
  async assignInitialCode(identity: DbIdentity, input: { itemId: string; expectedRevision: number; requestId: string; code: string; reason: string }): Promise<MutationResult> {
    const intent = intentHash('assign_initial_code', input);
    return mutation(identity, input.requestId, 'assign_initial_code', intent, 'assign_initial_code', [input.requestId, intent, input.itemId,
      input.expectedRevision, input.code, input.reason, `manual-request:${input.requestId}`]);
  },
  async appendNonPriceRevision(identity: DbIdentity, input: { itemId: string; expectedRevision: number; requestId: string; reason: string; fields: Record<string, FieldObservation> }): Promise<MutationResult> {
    const intent = intentHash('append_nonprice_revision', input);
    return mutation(identity, input.requestId, 'append_nonprice_revision', intent, 'append_nonprice_revision', [input.requestId, intent, input.itemId,
      input.expectedRevision, JSON.stringify(input.fields), input.reason, `manual-request:${input.requestId}`]);
  },
  async amounts(identity: DbIdentity, itemId: string): Promise<PreparedFinancial | null> {
    return withAppDb(identity, (c) => rpc(c, 'read_item_amounts', [itemId]));
  },
  async observationAmounts(identity: DbIdentity, observationId: string): Promise<Record<string, FieldObservation> | null> {
    return withAppDb(identity, (c) => rpc(c, 'read_observation_amounts', [observationId]));
  },
  async evidence(identity: DbIdentity, artifactId: string): Promise<EvidenceArtifact | null> {
    return withAppDb(identity, (c) => rpc(c, 'read_artifact', [artifactId]));
  },
  async request(identity: DbIdentity, requestId: string): Promise<{ action: string; result: unknown } | null> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      return (await c.query('SELECT action,result FROM catalog.audit_event WHERE request_id=$1 AND actor_id=$2', [requestId, identity.profileUserId])).rows[0] ?? null;
    });
  },
  async importBsSampleInventory(identity: DbIdentity, requestId: string, prepared: Record<string, unknown>): Promise<{ exportId: string; rowCount: number; confirmedRows: number; unselectedRows: number }> {
    const intent = intentHash('import_bs_sample_inventory', prepared.contentSha256);
    return mutation(identity, requestId, 'import_bs_sample_inventory', intent, 'import_bs_sample_inventory', [requestId, intent, JSON.stringify(prepared)]);
  },
  async bsSampleMeta(identity: DbIdentity): Promise<Record<string, unknown> | null> {
    return withAppDb(identity, (c) => rpc(c, 'read_bs_sample_display_meta', []));
  },
  async itemBsSampleRows(identity: DbIdentity, itemId: string, warehouse?: string | null): Promise<unknown[]> {
    return withAppDb(identity, (c) => rpc(c, 'read_item_bs_sample_inventory', [itemId, warehouse ?? null]));
  },
  async allBsSampleRows(identity: DbIdentity): Promise<Array<{
    itemId: string | null; excelRow: number; warehouse: string; sku: string; onHand: string | null;
    orderLocked: string | null; warehouseAvailable: string | null; activityReserved: string | null; inTransit: string | null;
    selectionState: string; observationId: string; formulaOk: boolean | null;
  }>> {
    const raw = await withAppDb(identity, (c) => rpc(c, 'read_bs_sample_inventory_rows', [])) as unknown[] | null;
    if (!Array.isArray(raw)) return [];
    return raw.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        itemId: typeof r.itemId === 'string' ? r.itemId : null,
        excelRow: Number(r.excelRow),
        warehouse: String(r.warehouse),
        sku: String(r.sku),
        onHand: r.onHand == null ? null : String(r.onHand),
        orderLocked: r.orderLocked == null ? null : String(r.orderLocked),
        warehouseAvailable: r.warehouseAvailable == null ? null : String(r.warehouseAvailable),
        activityReserved: r.activityReserved == null ? null : String(r.activityReserved),
        inTransit: r.inTransit == null ? null : String(r.inTransit),
        selectionState: String(r.selectionState),
        observationId: String(r.observationId),
        formulaOk: r.formulaOk == null ? null : Boolean(r.formulaOk),
      };
    });
  },
};
