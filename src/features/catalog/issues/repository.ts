import 'server-only';

import { withReadOnlyAppDb, type DbIdentity } from '@/lib/database/app-db';
import { SOURCE_PROFILE_KEY } from '../product-source/contract';
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

/** 飞书商品资料待核对事项的只读取数结果（中文标签由 module-facts 统一转换）。 */
export type ProductSourceIssueRow = {
  issueId: string;
  issueKind: string;
  detail: Record<string, unknown>;
  itemId: string | null;
  /** 关联商品当前资料版本；补号动作需要（无关联商品为 null）。 */
  itemRevision: number | null;
  iceCode: string | null;
  nameCn: string | null;
  /** 商品「规格」字段原文；读不到时为 null（页面显示「规格未填写」）。 */
  specificationRaw: string | null;
};

type ProductSourceIssueDbRow = {
  issue_id: string;
  issue_kind: string;
  detail: Record<string, unknown> | null;
  item_id: string | null;
  item_revision: number | null;
  ice_code: string | null;
  name_cn: string | null;
  specification_raw: string | null;
};

/**
 * 来源待核对事项（review_state=open）：只读取既有事项、关联商品与来源行号。
 * 只 SELECT；不写事项、不改批次、不改商品。来源表未安装时由调用方降级为“未接入”。
 */const PRODUCT_SOURCE_ISSUE_SQL = `SELECT i.id AS issue_id,
  i.issue_kind,
  i.detail,
  i.item_id,
  ic.revision AS item_revision,
  c.ice_code,
  v.name_cn,
  NULLIF(btrim(coalesce(v.fields->'specification'->>'raw', '')), '') AS specification_raw
 FROM catalog.product_source_issue i
 JOIN catalog.product_source_batch b ON b.id = i.batch_id
 JOIN catalog.product_source_profile p ON p.id = b.profile_id
 LEFT JOIN catalog.catalog_item_code c ON c.item_id = i.item_id
 LEFT JOIN catalog.item_current ic ON ic.item_id = i.item_id
 LEFT JOIN catalog.item_revision v ON v.item_id = ic.item_id AND v.revision = ic.revision
 WHERE p.profile_key = $1 AND i.review_state = 'open'
 ORDER BY i.opened_at DESC`;

/** 读取飞书商品资料待核对事项（只读；未安装来源表时由调用方降级）。 */
export async function readProductSourceIssueRows(identity: DbIdentity): Promise<ProductSourceIssueRow[]> {
  return withReadOnlyAppDb(identity, async (client) => {
    await client.query('SELECT catalog.require_admin()');
    const result = await client.query<ProductSourceIssueDbRow>(PRODUCT_SOURCE_ISSUE_SQL, [SOURCE_PROFILE_KEY]);
    return result.rows.map((row) => ({
      issueId: row.issue_id,
      issueKind: row.issue_kind,
      detail: row.detail ?? {},
      itemId: row.item_id,
      itemRevision: row.item_revision === null || row.item_revision === undefined ? null : Number(row.item_revision),
      iceCode: row.ice_code,
      nameCn: row.name_cn,
      specificationRaw: row.specification_raw,
    }));
  });
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
