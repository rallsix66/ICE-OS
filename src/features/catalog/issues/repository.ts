import 'server-only';

import { withReadOnlyAppDb, type DbIdentity } from '@/lib/database/app-db';
import type { BrushPendingFact, CatalogIssueFacts, UncodedNewItemFact } from './issue-index';

/**
 * 只读批量取数：仿照 `features/catalog/repository.ts` 的 `bsNotCreatedItemIds`，
 * 只 SELECT，不写业务数据、不加 schema/migration，沿用既有 `catalog.require_admin()` 与 RLS 路径。
 *
 * 事务以 `BEGIN READ ONLY` 开启（`withReadOnlyAppDb`），因此即使未来误加写语句也会在数据库侧被拒绝。
 */

type UncodedNewItemRow = {
  item_id: string;
  name_cn: string;
  revision: number;
  evidence_ref: string | null;
};

type BrushPendingRow = {
  decision_id: string;
  entry_key: string;
  raw_ref: string;
  item_id: string;
  ice_code: string | null;
  name_cn: string;
  source_system: string | null;
  reason: string | null;
  do_not_merge: boolean | null;
};

/** 已确认新品且当前版本缺 ICE 货号的批量取数（一条商品一行）。 */
const UNCODED_NEW_ITEM_SQL = `SELECT i.id AS item_id,
  r.name_cn,
  r.revision,
  r.evidence_ref
 FROM catalog.catalog_item i
 JOIN catalog.item_current c ON c.item_id = i.id
 JOIN catalog.item_revision r ON r.item_id = i.id AND r.revision = c.revision
 WHERE i.new_product_confirmed = true
   AND r.ice_code_snapshot IS NULL
 ORDER BY r.name_cn, i.id`;

/**
 * 两刷子待确认的批量取数（一条既有记录一行，按原记录身份去重）。
 * 只取 `selected_item_id` 存在的记录：契约要求每条事项都能追到原商品。
 */
const BRUSH_PENDING_SQL = `SELECT d.id AS decision_id,
  d.entry_key,
  d.raw_ref,
  d.selected_item_id AS item_id,
  r.ice_code_snapshot AS ice_code,
  r.name_cn,
  d.summary->>'sourceSystem' AS source_system,
  d.summary->>'reason' AS reason,
  CASE WHEN lower(coalesce(d.summary->>'doNotMerge', '')) = 'true' THEN true ELSE false END AS do_not_merge
 FROM catalog.decision_evidence d
 JOIN catalog.catalog_item i ON i.id = d.selected_item_id
 JOIN catalog.item_current c ON c.item_id = i.id
 JOIN catalog.item_revision r ON r.item_id = i.id AND r.revision = c.revision
 WHERE d.entry_kind = 'history:batch_brush_preservation'
   AND d.summary->>'status' = 'pending_confirmation'
   AND d.selected_item_id IS NOT NULL
 ORDER BY r.name_cn, d.entry_key`;

function toUncodedNewItem(row: UncodedNewItemRow): UncodedNewItemFact {
  return {
    itemId: row.item_id,
    nameCn: row.name_cn,
    revision: Number(row.revision),
    evidenceRef: row.evidence_ref && row.evidence_ref.trim() !== '' ? row.evidence_ref : null,
  };
}

function toBrushPending(row: BrushPendingRow): BrushPendingFact {
  return {
    decisionId: row.decision_id,
    entryKey: row.entry_key,
    rawRef: row.raw_ref,
    itemId: row.item_id,
    iceCode: row.ice_code ?? null,
    nameCn: row.name_cn,
    sourceSystem: row.source_system ?? null,
    reason: row.reason ?? null,
    doNotMerge: row.do_not_merge === true,
  };
}

/** 在同一个只读事务里读取两类既有事实；任一读取失败即整体失败（不把失败当 0 项）。 */
export async function readCatalogIssueFacts(identity: DbIdentity): Promise<CatalogIssueFacts> {
  return withReadOnlyAppDb(identity, async (client) => {
    await client.query('SELECT catalog.require_admin()');
    const uncoded = await client.query<UncodedNewItemRow>(UNCODED_NEW_ITEM_SQL);
    const brush = await client.query<BrushPendingRow>(BRUSH_PENDING_SQL);
    return {
      uncodedNewItems: uncoded.rows.map(toUncodedNewItem),
      brushPending: brush.rows.map(toBrushPending),
    };
  });
}

/** 批量取数：已确认新品且缺 ICE 货号的商品 ID 集合（只读）。 */
export async function uncodedNewItemIds(identity: DbIdentity): Promise<Set<string>> {
  const facts = await readCatalogIssueFacts(identity);
  return new Set(facts.uncodedNewItems.map((fact) => fact.itemId));
}

/** 批量取数：两刷子待确认记录关联的商品 ID 集合（只读）。 */
export async function brushPendingItemIds(identity: DbIdentity): Promise<Set<string>> {
  const facts = await readCatalogIssueFacts(identity);
  return new Set(facts.brushPending.map((fact) => fact.itemId));
}
