import 'server-only';

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withAppDb, type DbIdentity } from '@/lib/database/app-db';
import { normalizeName, scopeObservationsForItemAudit, wouldMatchItemCandidate } from './candidate-service';
import type { CatalogRequestReceipt } from './reconcile';
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
const choiceCountsJoin = `LEFT JOIN (
  SELECT d.selected_item_id AS item_id,
    count(*) FILTER (WHERE n.system = 'bigseller')::bigint AS bigseller,
    count(*) FILTER (WHERE n.system = 'jushuitan')::bigint AS jushuitan
  FROM catalog.decision_evidence d
  JOIN catalog.source_observation o ON o.id = d.observation_id
  JOIN catalog.observation_batch b ON b.id = o.batch_id
  JOIN catalog.source_dataset ds ON ds.id = b.dataset_id
  JOIN catalog.source_namespace n ON n.id = ds.namespace_id
  WHERE d.entry_kind = 'candidate_snapshot' AND d.selected_item_id IS NOT NULL
  GROUP BY d.selected_item_id
) choice_counts ON choice_counts.item_id = i.id`;

const itemSelect = `SELECT i.id AS item_id,r.revision,r.ice_code_snapshot,i.new_product_confirmed,r.name_cn,r.fields,r.evidence_ref,
 r.reason,r.actor_id,r.recorded_at,
 coalesce(choice_counts.bigseller, 0)::text AS bigseller,
 coalesce(choice_counts.jushuitan, 0)::text AS jushuitan
 FROM catalog.catalog_item i
 JOIN catalog.item_current c ON c.item_id = i.id
 JOIN catalog.item_revision r ON r.item_id = i.id
 ${choiceCountsJoin}`;

/** 全部版本行（含历史审计原值）；只由服务端使用，日常投影另经 history-display 收敛。 */
const revisionHistorySelect = `SELECT i.id AS item_id,r.revision,r.ice_code_snapshot,i.new_product_confirmed,r.name_cn,r.fields,r.evidence_ref,
 r.reason,r.actor_id,r.recorded_at,
 coalesce(choice_counts.bigseller, 0)::text AS bigseller,
 coalesce(choice_counts.jushuitan, 0)::text AS jushuitan
 FROM catalog.catalog_item i
 JOIN catalog.item_revision r ON r.item_id = i.id
 ${choiceCountsJoin}`;

async function rpc<T>(client: PoolClient, name: string, values: unknown[]): Promise<T> {
  // Function names are module constants, never request input.
  const args = values.map((_, i) => `$${i + 1}`).join(',');
  const result = await client.query<{ result: T }>(`SELECT catalog.${name}(${args}) AS result`, values);
  return result.rows[0]!.result;
}

const OBSERVATION_ROW_FROM = `FROM catalog.source_observation o
  JOIN catalog.observation_batch b ON b.id=o.batch_id
  JOIN catalog.source_dataset ds ON ds.id=b.dataset_id
  JOIN catalog.source_namespace n ON n.id=ds.namespace_id
  LEFT JOIN catalog.decision_evidence d ON d.observation_id=o.id AND d.entry_kind='candidate_snapshot'`;

const OBSERVATION_ROW_SELECT = `SELECT o.id AS "observationId",n.system AS "sourceSystem",o.entry_key AS "entryKey",
  o.legacy_candidate_id AS "legacyCandidateId",o.position,o.scope,o.fields,o.review_state AS "reviewState",o.raw_ref AS "rawRef",b.coverage,
  d.selected_item_id AS "selectedItemId",d.id AS "existingDecisionRef",coalesce(d.summary->'flags','[]'::jsonb) AS conflicts ${OBSERVATION_ROW_FROM}`;

async function queryObservationRows(client: PoolClient, where: string, params: unknown[]): Promise<SafeObservation[]> {
  const tail = where ? ` WHERE ${where}` : '';
  const { rows } = await client.query(`${OBSERVATION_ROW_SELECT}${tail} ORDER BY n.system,o.entry_key`, params);
  return rows as SafeObservation[];
}

async function queryObservationRowsByIds(client: PoolClient, observationIds: string[]): Promise<SafeObservation[]> {
  if (!observationIds.length) return [];
  return queryObservationRows(client, 'o.id = ANY($1::uuid[])', [observationIds]);
}

async function queryFeishuObservationsForItem(client: PoolClient, iceCode: string, nameCn: string): Promise<SafeObservation[]> {
  const { rows } = await client.query<{ observation_id: string }>(
    `WITH match AS (
      SELECT DISTINCT g.position->>'sheet' AS sheet, g.position->>'row' AS row
      FROM catalog.source_observation g
      JOIN catalog.observation_batch gb ON gb.id = g.batch_id
      JOIN catalog.source_dataset gds ON gds.id = gb.dataset_id
      JOIN catalog.source_namespace gn ON gn.id = gds.namespace_id
      JOIN catalog.source_observation bn ON bn.position->>'sheet' = g.position->>'sheet'
        AND bn.position->>'row' = g.position->>'row'
      JOIN catalog.observation_batch bnb ON bnb.id = bn.batch_id
      JOIN catalog.source_dataset bnds ON bnds.id = bnb.dataset_id
      JOIN catalog.source_namespace bnn ON bnn.id = bnds.namespace_id
      WHERE gn.system = 'feishu'
        AND bnn.system = 'feishu'
        AND g.position->>'cell' LIKE 'G%'
        AND g.fields->'value'->>'raw' = $1
        AND bn.position->>'cell' LIKE 'B%'
        AND bn.fields->'value'->>'raw' = $2
    )
    SELECT o.id AS observation_id
    FROM catalog.source_observation o
    JOIN catalog.observation_batch b ON b.id = o.batch_id
    JOIN catalog.source_dataset ds ON ds.id = b.dataset_id
    JOIN catalog.source_namespace n ON n.id = ds.namespace_id
    JOIN match m ON o.position->>'sheet' = m.sheet AND o.position->>'row' = m.row
    WHERE n.system = 'feishu'`,
    [iceCode, nameCn],
  );
  return queryObservationRowsByIds(client, rows.map((row) => row.observation_id));
}

async function queryBsJstObservationsForItem(client: PoolClient, item: CatalogItemDto): Promise<SafeObservation[]> {
  const selected = await client.query<{ observation_id: string }>(
    `SELECT d.observation_id
     FROM catalog.decision_evidence d
     JOIN catalog.source_observation o ON o.id = d.observation_id
     JOIN catalog.observation_batch b ON b.id = o.batch_id
     JOIN catalog.source_dataset ds ON ds.id = b.dataset_id
     JOIN catalog.source_namespace n ON n.id = ds.namespace_id
     WHERE d.entry_kind = 'candidate_snapshot'
       AND d.selected_item_id = $1::uuid
       AND n.system IN ('bigseller', 'jushuitan')`,
    [item.itemId],
  );
  const byId = new Map<string, SafeObservation>();
  const merge = (rows: SafeObservation[]) => {
    for (const row of rows) byId.set(row.observationId, row);
  };
  merge(await queryObservationRowsByIds(client, selected.rows.map((r) => r.observation_id)));
  const observedRawEquals = (key: string, param: string) => `(
    o.fields->'${key}'->>'state' = 'observed'
    AND o.fields->'${key}'->>'meaning' = 'value'
    AND o.fields->'${key}'->>'raw' = ${param}
  )`;
  if (item.iceCode) {
    merge(await queryObservationRows(client, `n.system IN ('bigseller','jushuitan') AND (
      ${observedRawEquals('sku', '$1')}
      OR ${observedRawEquals('styleCode', '$1')}
      OR ${observedRawEquals('productCode', '$1')}
    )`, [item.iceCode]));
  }
  const barcodeValues = [...new Set(
    item.barcodeRefs
      .map((field) => (field.state === 'observed' && field.meaning === 'value' ? field.raw : null))
      .filter((value): value is string => Boolean(value)),
  )];
  if (barcodeValues.length) {
    merge(await queryObservationRows(client, `n.system IN ('bigseller','jushuitan')
      AND o.fields->'barcode'->>'state' = 'observed'
      AND o.fields->'barcode'->>'meaning' = 'value'
      AND o.fields->'barcode'->>'raw' = ANY($1::text[])`, [barcodeValues]));
  }
  if (item.nameCn) {
    const normalized = normalizeName(item.nameCn);
    merge(await queryObservationRows(client, `n.system IN ('bigseller','jushuitan')
      AND o.fields->'name'->>'state' = 'observed'
      AND o.fields->'name'->>'meaning' = 'value'
      AND o.fields->'name'->>'raw' IS NOT NULL
      AND (
        position($1 in lower(regexp_replace(o.fields->'name'->>'raw', '\\s', '', 'g'))) > 0
        OR position(lower(regexp_replace(o.fields->'name'->>'raw', '\\s', '', 'g')) in $1) > 0
      )`, [normalized]));
  }
  const jushuitanPool = await queryObservationRows(client, `n.system = 'jushuitan'`, []);
  for (const row of jushuitanPool) {
    if (wouldMatchItemCandidate(item, { ...row, sourceSystem: 'jushuitan' })) byId.set(row.observationId, row);
  }
  return [...byId.values()];
}

function observedFieldRaw(fields: Record<string, FieldObservation>, key: string): string | null {
  const field = fields[key];
  return field?.state === 'observed' && field.meaning === 'value' ? field.raw : null;
}

async function fetchItemAuditObservationPool(client: PoolClient, item: CatalogItemDto): Promise<SafeObservation[]> {
  const byId = new Map<string, SafeObservation>();
  const add = (rows: SafeObservation[]) => {
    for (const row of rows) byId.set(row.observationId, row);
  };

  if (item.iceCode) {
    add(await queryFeishuObservationsForItem(client, item.iceCode, item.nameCn));
  }

  add(await queryBsJstObservationsForItem(client, item));

  let expanded = true;
  while (expanded) {
    expanded = false;
    const skuKeys = new Set<string>();
    const barcodeKeys = new Set<string>();
    for (const observation of byId.values()) {
      if (observation.sourceSystem !== 'bigseller' && observation.sourceSystem !== 'jushuitan') continue;
      const sku = observedFieldRaw(observation.fields, 'sku');
      const barcode = observedFieldRaw(observation.fields, 'barcode');
      if (sku) skuKeys.add(`${observation.sourceSystem}\0${sku}`);
      if (barcode) barcodeKeys.add(`${observation.sourceSystem}\0${barcode}`);
    }
    const skus = [...skuKeys].map((key) => key.split('\0')[1]!).filter(Boolean);
    const barcodes = [...barcodeKeys].map((key) => key.split('\0')[1]!).filter(Boolean);
    if (!skus.length && !barcodes.length) break;
    const extra = await queryObservationRows(client, `n.system IN ('bigseller','jushuitan') AND (
      ($1::text[] <> '{}'::text[] AND (o.fields->'sku'->>'raw') = ANY($1::text[]))
      OR ($2::text[] <> '{}'::text[] AND (o.fields->'barcode'->>'raw') = ANY($2::text[]))
    )`, [skus, barcodes]);
    for (const row of extra) {
      if (!byId.has(row.observationId)) {
        byId.set(row.observationId, row);
        expanded = true;
      }
    }
  }

  return [...byId.values()];
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
  async listOnClient(
    client: PoolClient,
    identity: DbIdentity,
    options: { baselinePublishedOnly?: boolean } = {},
  ): Promise<CatalogItemDto[]> {
    await client.query('SELECT catalog.require_admin()');
    const baselineFilter = options.baselinePublishedOnly ? ' AND i.first_release_id IS NOT NULL' : '';
    const result = await client.query<ItemRow>(`${itemSelect} WHERE r.revision=c.revision${baselineFilter} ORDER BY r.name_cn,i.id`);
    return result.rows.map(itemDto);
  },
  async list(identity: DbIdentity, options: { baselinePublishedOnly?: boolean } = {}): Promise<CatalogItemDto[]> {
    return withAppDb(identity, (c) => catalogRepository.listOnClient(c, identity, options));
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
      const result = await c.query<RevisionRow>(`${revisionHistorySelect} WHERE i.id=$1 ORDER BY r.revision DESC`, [itemId]);
      return result.rows.map(revisionDto);
    });
  },
  async historyRevision(identity: DbIdentity, itemId: string, revision: number): Promise<CatalogItemRevisionDto | null> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const result = await c.query<RevisionRow>(`${revisionHistorySelect} WHERE i.id=$1 AND r.revision=$2`, [itemId, revision]);
      return result.rows[0] ? revisionDto(result.rows[0]) : null;
    });
  },
  /** 当前版本号（item_current），用于判定历史行是否“当前”；不存在返回 null。 */
  async currentRevision(identity: DbIdentity, itemId: string): Promise<number | null> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query<{ revision: number }>('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemId]);
      return rows[0] ? rows[0].revision : null;
    });
  },
  /**
   * 操作者显示名：只读 public.profiles（真实用户表，item_revision.actor_id 有 FK 约束）。
   * 返回不到的 id 不在结果里；调用方据此输出 null，绝不回传 UUID。
   */
  async profileDisplayNames(identity: DbIdentity, actorIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(actorIds.filter((id) => /^[a-f\d-]{36}$/i.test(id)))];
    if (!ids.length) return new Map();
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query<{ id: string; display_name: string | null }>(
        'SELECT id, display_name FROM public.profiles WHERE id = ANY($1::uuid[])', [ids]);
      return new Map(rows.filter((row) => typeof row.display_name === 'string' && row.display_name.trim())
        .map((row) => [row.id, row.display_name as string]));
    });
  },
  async bsNotCreatedItemIds(identity: DbIdentity): Promise<Set<string>> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query<{ id: string }>(
        `SELECT DISTINCT selected_item_id AS id FROM catalog.decision_evidence
         WHERE entry_kind = 'history:batch_bs_not_created'
           AND summary->>'sourceSystem' = 'bigseller'
           AND summary->>'status' = 'user_confirmed_not_created'
           AND selected_item_id IS NOT NULL`,
      );
      return new Set(rows.map((row) => row.id));
    });
  },
  async itemStatusFlags(identity: DbIdentity, itemId: string): Promise<{ bsNotCreated: boolean; brushPending: boolean }> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query<{ bs_not_created: boolean; brush_pending: boolean }>(
        `SELECT
          EXISTS(
            SELECT 1 FROM catalog.decision_evidence
            WHERE selected_item_id = $1
              AND entry_kind = 'history:batch_bs_not_created'
              AND summary->>'sourceSystem' = 'bigseller'
              AND summary->>'status' = 'user_confirmed_not_created'
          ) AS bs_not_created,
          EXISTS(
            SELECT 1 FROM catalog.decision_evidence
            WHERE selected_item_id = $1
              AND entry_kind = 'history:batch_brush_preservation'
              AND summary->>'status' = 'pending_confirmation'
          ) AS brush_pending`,
        [itemId],
      );
      const row = rows[0];
      return { bsNotCreated: Boolean(row?.bs_not_created), brushPending: Boolean(row?.brush_pending) };
    });
  },
  async sourceSearchTokensByItem(identity: DbIdentity): Promise<Map<string, string[]>> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query<{ item_id: string; tokens: string[] }>(
        `SELECT d.selected_item_id AS item_id,
          array_agg(DISTINCT sku.raw ORDER BY sku.raw) AS tokens
         FROM catalog.decision_evidence d
         JOIN catalog.source_observation o ON o.id = d.observation_id
         CROSS JOIN LATERAL (
           SELECT NULLIF(trim(both FROM o.fields #>> '{sku,raw}'), '') AS raw
           WHERE o.fields #>> '{sku,state}' = 'observed'
             AND o.fields #>> '{sku,meaning}' = 'value'
         ) sku
         WHERE d.entry_kind = 'candidate_snapshot'
           AND d.selected_item_id IS NOT NULL
           AND sku.raw IS NOT NULL
         GROUP BY d.selected_item_id`,
      );
      return new Map(rows.map((row) => [row.item_id, row.tokens ?? []]));
    });
  },
  async adminSummaryCounts(identity: DbIdentity): Promise<{
    items: number; coded: number; observations: number; choices: number; history: number;
  }> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query<{ items: string; coded: string; observations: string; choices: string; history: string }>(
        `SELECT
          (SELECT count(*)::text FROM catalog.catalog_item i WHERE i.first_release_id IS NOT NULL) AS items,
          (SELECT count(*)::text FROM catalog.catalog_item i
            JOIN catalog.item_current c ON c.item_id = i.id
            JOIN catalog.item_revision r ON r.item_id = i.id AND r.revision = c.revision
            WHERE i.first_release_id IS NOT NULL AND r.ice_code_snapshot IS NOT NULL) AS coded,
          (SELECT count(*)::text FROM catalog.source_observation) AS observations,
          (SELECT count(*)::text FROM catalog.decision_evidence WHERE entry_kind = 'candidate_snapshot' AND selected_item_id IS NOT NULL) AS choices,
          (SELECT count(*)::text FROM catalog.decision_evidence WHERE entry_kind <> 'candidate_snapshot') AS history`,
      );
      const row = rows[0]!;
      return {
        items: Number(row.items),
        coded: Number(row.coded),
        observations: Number(row.observations),
        choices: Number(row.choices),
        history: Number(row.history),
      };
    });
  },
  async decisionsPage(identity: DbIdentity, options: { offset: number; limit: number }): Promise<{ total: number; rows: SafeDecision[] }> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const totalRow = (await c.query<{ count: string }>('SELECT count(*)::text AS count FROM catalog.decision_evidence')).rows[0]!;
      const { rows } = await c.query(
        `SELECT id AS "decisionId",entry_kind AS "entryKind",entry_key AS "entryKey",
        observation_id AS "observationId",selected_item_id AS "selectedItemId",selected_jushuitan_ref AS "selectedJushuitanRef",
        review_state AS "reviewState",raw_ref AS "rawRef",summary FROM catalog.decision_evidence
        ORDER BY entry_kind, entry_key OFFSET $1 LIMIT $2`,
        [options.offset, options.limit],
      );
      return { total: Number(totalRow.count), rows: rows as SafeDecision[] };
    });
  },
  async observationsPage(identity: DbIdentity, options: { offset: number; limit: number }): Promise<{ total: number; rows: SafeObservation[] }> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const totalRow = (await c.query<{ count: string }>('SELECT count(*)::text AS count FROM catalog.source_observation')).rows[0]!;
      const { rows } = await c.query(
        `SELECT o.id AS "observationId",n.system AS "sourceSystem",o.entry_key AS "entryKey",
        o.legacy_candidate_id AS "legacyCandidateId",o.position,o.scope,o.fields,o.review_state AS "reviewState",o.raw_ref AS "rawRef",b.coverage,
        d.selected_item_id AS "selectedItemId",d.id AS "existingDecisionRef",coalesce(d.summary->'flags','[]'::jsonb) AS conflicts FROM catalog.source_observation o
        JOIN catalog.observation_batch b ON b.id=o.batch_id JOIN catalog.source_dataset ds ON ds.id=b.dataset_id
        JOIN catalog.source_namespace n ON n.id=ds.namespace_id LEFT JOIN catalog.decision_evidence d ON d.observation_id=o.id AND d.entry_kind='candidate_snapshot'
        ORDER BY n.system,o.entry_key OFFSET $1 LIMIT $2`,
        [options.offset, options.limit],
      );
      return { total: Number(totalRow.count), rows: rows as SafeObservation[] };
    });
  },
  async allObservationsWithDecisionsOnClient(client: PoolClient, identity: DbIdentity): Promise<SafeObservation[]> {
    void identity;
    await client.query('SELECT catalog.require_admin()');
    return queryObservationRows(client, '', []);
  },
  async allObservationsWithDecisions(identity: DbIdentity): Promise<SafeObservation[]> {
    return withAppDb(identity, (c) => catalogRepository.allObservationsWithDecisionsOnClient(c, identity));
  },
  async observationsForItemOnClient(
    client: PoolClient,
    identity: DbIdentity,
    item: CatalogItemDto,
  ): Promise<SafeObservation[]> {
    await client.query('SELECT catalog.require_admin()');
    const pool = await fetchItemAuditObservationPool(client, item);
    return scopeObservationsForItemAudit(item, pool, { verifyEquivalence: false }) as SafeObservation[];
  },
  async observationsForItem(identity: DbIdentity, item: CatalogItemDto): Promise<SafeObservation[]> {
    return withAppDb(identity, (c) => catalogRepository.observationsForItemOnClient(c, identity, item));
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
  async baselineAmountsMap(identity: DbIdentity): Promise<Map<string, PreparedFinancial | null>> {
    const raw = await withAppDb(identity, (c) => rpc<Record<string, PreparedFinancial | null>>(c, 'read_baseline_item_amounts_map', []));
    return new Map(Object.entries(raw ?? {}));
  },
  async observationAmounts(identity: DbIdentity, observationId: string): Promise<Record<string, FieldObservation> | null> {
    return withAppDb(identity, (c) => rpc(c, 'read_observation_amounts', [observationId]));
  },
  async evidence(identity: DbIdentity, artifactId: string): Promise<EvidenceArtifact | null> {
    return withAppDb(identity, (c) => rpc(c, 'read_artifact', [artifactId]));
  },
  /**
   * 只读回执查询：request_id + actor_id（不跨用户枚举）。itemId 用于调用方核对请求范围。
   * 只 SELECT，不写 audit_event、不重放原请求。
   */
  async request(identity: DbIdentity, requestId: string): Promise<CatalogRequestReceipt | null> {
    return withAppDb(identity, async (c) => {
      await c.query('SELECT catalog.require_admin()');
      const { rows } = await c.query<{ action: string; item_id: string | null; intent_sha256: string | null; result: unknown }>(
        'SELECT action,item_id,intent_sha256,result FROM catalog.audit_event WHERE request_id=$1 AND actor_id=$2',
        [requestId, identity.profileUserId],
      );
      const row = rows[0];
      return row ? { action: row.action, itemId: row.item_id, intentSha256: row.intent_sha256, result: row.result } : null;
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
