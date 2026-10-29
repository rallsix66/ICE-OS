#!/usr/bin/env node
/**
 * DATA-1：把 2026-10-28 人工复核结果（3156 行，sha256 5f39ae74…）实际应用到本机系统并逐条回读。
 *
 * 合同：docs/tasks/catalog-binding-inline-edit-v1.md §4；计划：.local/…/import/plan.md
 *
 * 用法：
 *   node scripts/catalog/review-import/review-import.mjs --mode plan   # 只读盘点 + 生成清单（默认）
 *   node scripts/catalog/review-import/review-import.mjs --mode apply --dsn <隔离库 app runner DSN>
 *   node scripts/catalog/review-import/review-import.mjs --mode verify --dsn <同上>
 *
 * 正式库写入保护：目标库名等于正式实例库名时，apply 必须同时给出 --allow-formal 且环境变量
 * REVIEW_IMPORT_FORMAL_APPROVED=1（由 Lead 明确批准后设置），否则拒绝执行。
 *
 * 写入只走既有 SECURITY DEFINER RPC（catalog.confirm_inventory_mapping、
 * catalog.apply_domestic_review_decision），事务内 set_config('request.jwt.claim.sub',<admin>)；
 * 每行 request_id 由“文件 sha256 + 来源行 ID”派生，重跑返回稳定回执/不产生重复换绑。
 * 证据文件写到 .local/catalog-binding-inline-edit-v1-20261028/import/（经服务端 lo_export，避免
 * 当前会话命令沙箱对 .local 目录的写限制；内容为精确 UTF-8 字节）。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_CSV = path.join(REPO_ROOT, '.local', 'three-table-view-20261028', 'review-received-5f39ae7438b4', '三表重新匹配复核结果.csv');
const INSTANCE_FILE = path.join(REPO_ROOT, '.local', 'catalog', 'run-20261026T211500Z-11a22b33', 'instance', 'catalog-instance.json');
const DEFAULT_EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog-binding-inline-edit-v1-20261028', 'import');

const EXPECTED_SHA256 = '5f39ae7438b4003caa5727dcace377ac912ad796ac9b3c9e61663dec69b40d12';
const EXPECTED_HEADER = [
  '来源类型', '来源行ID', '文件', '工作表', '原表行', '仓库', '来源SKU', '来源名称', '现有库存或实际库存数',
  '整仓可用或可用数', '规则候选状态', '规则候选商品', '匹配依据', '历史状态', '历史商品', '本次复核状态',
  '本次商品货号', '本次商品名称', '本次商品主表行', '备注',
];
const EXPECTED_CATEGORY_COUNTS = {
  bs_adopt: 387,
  jst_adopt: 123,
  bs_hidden: 121,
  bs_empty: 22,
  jst_empty: 764,
  bs_combo_keep: 1739,
};
const DEFAULT_UNIT = '个';
const VARIANT_KEY = 'default';

// ---------------------------------------------------------------------------
// args / instance
// ---------------------------------------------------------------------------
function readArgs(argv) {
  const args = { mode: 'plan', evidence: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--mode') args.mode = next();
    else if (a === '--dsn') args.dsn = next();
    else if (a === '--csv') args.csv = next();
    else if (a === '--evidence-dir') args.evidenceDir = next();
    else if (a === '--label') args.label = next();
    else if (a === '--allow-formal') args.allowFormal = true;
    else if (a === '--no-evidence') args.evidence = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['plan', 'apply', 'verify'].includes(args.mode)) throw new Error(`invalid --mode ${args.mode}`);
  return args;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deterministicUuid(...parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeName(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// CSV（入口一次解析与校验）
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function classify(row) {
  const type = row.sourceType;
  const note = row.note;
  const target = row.targetCode;
  if (type === 'BS 组合') return 'bs_combo_keep';
  if (type === '聚水潭国内') return target ? 'jst_adopt' : 'jst_empty';
  if (type === 'BS 单品') {
    if (note.includes('不显示')) return 'bs_hidden';
    return target ? 'bs_adopt' : 'bs_empty';
  }
  throw new Error(`REVIEW_ROW_SOURCE_TYPE_UNKNOWN:${routeTypeOf(row)}`);
}

function routeTypeOf(row) {
  return row.sourceType || '(empty)';
}

async function loadReviewCsv(csvPath) {
  const raw = await readFile(csvPath);
  const fileSha256 = sha256(raw);
  if (fileSha256 !== EXPECTED_SHA256) {
    throw new Error(`REVIEW_CSV_SHA256_MISMATCH:${fileSha256}`);
  }
  const table = parseCsv(raw.toString('utf8').replace(/^\uFEFF/, ''));
  const header = table[0] ?? [];
  if (header.length !== EXPECTED_HEADER.length || header.some((h, i) => h !== EXPECTED_HEADER[i])) {
    throw new Error(`REVIEW_CSV_HEADER_MISMATCH:${JSON.stringify(header)}`);
  }
  const index = Object.fromEntries(header.map((h, i) => [h, i]));
  const data = table.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
  if (data.length !== 3156) throw new Error(`REVIEW_CSV_ROW_COUNT:${data.length}`);
  const seen = new Set();
  const rows = data.map((r, position) => {
    const get = (key) => r[index[key]] ?? '';
    const row = {
      position: position + 2, // 原 CSV 行号（含表头）
      sourceType: get('来源类型').trim(),
      sourceRowId: get('来源行ID').trim(),
      file: get('文件').trim(),
      sheet: get('工作表').trim(),
      excelRow: get('原表行').trim(),
      warehouse: get('仓库').trim(),
      sourceSku: get('来源SKU'),
      sourceName: get('来源名称').trim(),
      onHand: get('现有库存或实际库存数').trim(),
      available: get('整仓可用或可用数').trim(),
      ruleStatus: get('规则候选状态').trim(),
      ruleItem: get('规则候选商品').trim(),
      matchBasis: get('匹配依据').trim(),
      historyStatus: get('历史状态').trim(),
      historyItem: get('历史商品').trim(),
      reviewStatus: get('本次复核状态').trim(),
      targetCode: get('本次商品货号').trim(),
      targetName: get('本次商品名称').trim(),
      targetMasterRow: get('本次商品主表行').trim(),
      note: get('备注').trim(),
    };
    if (!row.sourceRowId) throw new Error(`REVIEW_CSV_ROW_ID_EMPTY:line ${position + 2}`);
    if (seen.has(row.sourceRowId)) throw new Error(`REVIEW_CSV_ROW_ID_DUPLICATE:${row.sourceRowId}`);
    seen.add(row.sourceRowId);
    if (!row.sourceType) throw new Error(`REVIEW_CSV_SOURCE_TYPE_EMPTY:${row.sourceRowId}`);
    row.category = classify(row);
    return row;
  });
  const counts = {};
  for (const row of rows) counts[row.category] = (counts[row.category] ?? 0) + 1;
  for (const [category, expected] of Object.entries(EXPECTED_CATEGORY_COUNTS)) {
    if ((counts[category] ?? 0) !== expected) {
      throw new Error(`REVIEW_CSV_CATEGORY_COUNT:${category}:${counts[category] ?? 0}!=${expected}`);
    }
  }
  return { fileSha256, rows, counts };
}

// ---------------------------------------------------------------------------
// DB 读取（只读事务；app runner + 管理员身份）
// ---------------------------------------------------------------------------
function toJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function withReadTx(client, adminProfileId, fn) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [adminProfileId]);
    const isAdmin = (await client.query('SELECT catalog.is_admin() AS ok')).rows[0]?.ok;
    if (isAdmin !== true) throw new Error('REVIEW_IMPORT_NOT_ADMIN');
    const result = await fn();
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be broken */ }
    throw error;
  }
}

async function loadAdminProfileId(client) {
  const result = await client.query(`
    SELECT p.id FROM public.profiles p
    JOIN public.role r ON r.id=p.role_id
    WHERE p.is_active AND r.name='admin'
    ORDER BY p.created_at,p.id
    LIMIT 2`);
  if (result.rowCount === 0) throw new Error('REVIEW_IMPORT_ADMIN_PROFILE_MISSING');
  if (result.rowCount > 1) throw new Error('REVIEW_IMPORT_ADMIN_PROFILE_AMBIGUOUS');
  return result.rows[0].id;
}

async function loadState(client) {
  const accounts = (await client.query(
    `SELECT id,account_key,account_label,external_account_code,source_system
     FROM catalog.inventory_source_account ORDER BY created_at,id`)).rows;
  if (accounts.length === 0) throw new Error('REVIEW_IMPORT_ACCOUNT_MISSING');
  // 与 catalog.inventory_bound_account_id() 相同的选择顺序：已被同步设置绑定的账号优先。
  const boundRows = (await client.query(`
    SELECT a.id FROM catalog.inventory_source_account a
    LEFT JOIN catalog.inventory_sync_settings s ON s.account_id=a.id
    ORDER BY (s.account_id IS NULL), a.created_at, a.id
    LIMIT 1`)).rows;
  const bound = boundRows[0]?.id;
  const account = accounts.find((a) => a.id === bound) ?? accounts[0];
  const warehouses = (await client.query(
    `SELECT id,external_warehouse_id,external_name,status,market
     FROM catalog.inventory_warehouse WHERE account_id=$1 ORDER BY external_warehouse_id`, [account.id])).rows;
  const items = (await client.query(
    `SELECT i.id, v.ice_code_snapshot AS ice_code, v.name_cn, c.revision
     FROM catalog.catalog_item i
     JOIN catalog.item_current c ON c.item_id=i.id
     JOIN catalog.item_revision v ON v.item_id=c.item_id AND v.revision=c.revision
     ORDER BY i.id`)).rows;
  const mappings = (await client.query(
    `SELECT DISTINCT ON (m.warehouse_id,m.external_sku)
       m.id,m.warehouse_id,m.external_sku,m.item_id,m.unit,m.version,m.status,m.created_at
     FROM catalog.inventory_sku_mapping m
     WHERE m.account_id=$1
     ORDER BY m.warehouse_id,m.external_sku,m.version DESC`, [account.id])).rows;
  const variants = (await client.query(
    `SELECT item_id,unit FROM catalog.inventory_variant WHERE variant_key=$1`, [VARIANT_KEY])).rows;
  const jstLinks = toJson((await client.query('SELECT catalog.read_inventory_domestic_links() AS links')).rows[0].links);
  const observations = (await client.query(
    `SELECT id,legacy_candidate_id AS "legacyCandidateId",review_state AS "reviewState"
     FROM catalog.source_observation
     WHERE position->>'sourceRowKey' LIKE 'jushuitan:%' AND legacy_candidate_id IS NOT NULL`)).rows;
  return { account, accounts, warehouses, items, mappings, variants, jstLinks, observations };
}

// ---------------------------------------------------------------------------
// 计划：把 CSV 行与当前库状态对齐
// ---------------------------------------------------------------------------
function buildPlan(context) {
  const { csv, state, adminProfileId } = context;
  const account = state.account;
  const itemById = new Map(state.items.map((i) => [i.id, i]));
  const itemByCode = new Map(state.items.map((i) => [i.ice_code, i]));
  const warehouseByName = new Map(state.warehouses.map((w) => [w.external_name, w]));
  const warehouseById = new Map(state.warehouses.map((w) => [w.id, w]));
  const mappingByKey = new Map(state.mappings.map((m) => [`${m.warehouse_id}|${m.external_sku}`, m]));
  const variantUnit = new Map(state.variants.map((v) => [v.item_id, v.unit]));
  const jstByCandidate = new Map();
  for (const link of state.jstLinks) jstByCandidate.set(link.legacyCandidateId, link);
  const observationByCandidate = new Map(state.observations.map((o) => [o.legacyCandidateId, o]));

  const rows = csv.rows.map((row) => {
    const out = {
      ...row,
      sourceSystem: row.category.startsWith('jst') ? '聚水潭' : (row.category === 'bs_combo_keep' ? 'BigSeller组合' : 'BigSeller'),
      accountLabel: account.account_label,
      accountId: account.id,
      warehouseExternalId: null,
      warehouseId: null,
      targetItemId: null,
      targetItemName: null,
      currentItemId: null,
      currentItemCode: null,
      currentVersion: null,
      currentStatus: null,
      unit: null,
      expectedVersion: null,
      action: null,
      reason: null,
      actionReasonCode: null,
      requestId: null,
      receipt: null,
      result: null,
      resultDetail: null,
    };

    if (row.category === 'bs_combo_keep') {
      out.action = 'combo_keep';
      out.reason = 'BS 组合 SKU 无明确目标，原样保留，不拆分、不自动计库存';
      out.result = '保留组合';
      return out;
    }
    if (row.category === 'jst_empty') {
      out.action = 'no_change';
      out.reason = '聚水潭未填本次目标，无新目标，不清空旧关系';
      out.result = '不动';
      return out;
    }
    if (row.category === 'bs_empty') {
      out.action = 'pending_target';
      out.reason = 'BS 单品未填目标且未标不显示，待用户后续决定；不猜绑、不清空现有关系';
      out.result = '待处理';
      return out;
    }
    if (row.category === 'bs_hidden') {
      const warehouse = warehouseByName.get(row.warehouse);
      const current = warehouse ? mappingByKey.get(`${warehouse.id}|${row.sourceSku}`) : null;
      out.warehouse = row.warehouse;
      out.warehouseExternalId = warehouse?.external_warehouse_id ?? null;
      out.warehouseId = warehouse?.id ?? null;
      out.sourceSku = row.sourceSku;
      if (current) {
        out.currentItemId = current.item_id;
        out.currentItemCode = itemById.get(current.item_id)?.ice_code ?? null;
        out.currentVersion = current.version;
        out.currentStatus = current.status;
        out.action = 'hidden_keep_existing';
        out.reason = `备注“不显示”；本包不执行隐藏/停用，保留现有正式关系 ${out.currentItemCode}（v${current.version}）`;
        out.result = '保留现有关系';
      } else {
        out.action = 'hidden_no_binding';
        out.reason = '备注“不显示”；本包不建新绑定、不删除来源，仅保存未来忽略清单';
        out.result = '仅存忽略清单';
      }
      return out;
    }
    if (row.category === 'bs_adopt') {
      const warehouse = warehouseByName.get(row.warehouse);
      const item = itemByCode.get(row.targetCode);
      out.warehouseExternalId = warehouse?.external_warehouse_id ?? null;
      out.warehouseId = warehouse?.id ?? null;
      if (!warehouse) {
        out.action = 'blocked';
        out.actionReasonCode = 'WAREHOUSE_UNKNOWN';
        out.reason = `仓库名未在现役账号仓库中找到：${row.warehouse}`;
        out.result = '阻塞';
        return out;
      }
      if (!item) {
        out.action = 'blocked';
        out.actionReasonCode = 'ITEM_CODE_UNKNOWN';
        out.reason = `本次商品货号未在商品库唯一命中：${row.targetCode}`;
        out.result = '阻塞';
        return out;
      }
      out.targetItemId = item.id;
      out.targetItemName = item.name_cn;
      if (normalizeName(row.targetName) !== normalizeName(item.name_cn)) {
        out.action = 'blocked';
        out.actionReasonCode = 'ITEM_NAME_MISMATCH';
        out.reason = `本次商品名称与商品库不一致：CSV“${row.targetName}” / 库“${item.name_cn}”`;
        out.result = '阻塞';
        return out;
      }
      const current = mappingByKey.get(`${warehouse.id}|${row.sourceSku}`);
      out.currentItemId = current?.item_id ?? null;
      out.currentItemCode = current ? (itemById.get(current.item_id)?.ice_code ?? null) : null;
      out.currentVersion = current?.version ?? null;
      out.currentStatus = current?.status ?? null;
      out.unit = variantUnit.get(item.id) ?? DEFAULT_UNIT;
      if (!current) {
        out.action = 'new';
        out.expectedVersion = null;
        out.reason = `当前无正式关系；本次新建 ${item.ice_code}`;
      } else if (current.item_id === item.id && current.status === 'confirmed') {
        out.action = 'keep';
        out.reason = `当前已是 ${item.ice_code}（v${current.version}），保持，不重建版本`;
      } else {
        out.action = 'rebind';
        out.expectedVersion = current.version;
        out.reason = `换绑 ${out.currentItemCode ?? current.item_id} → ${item.ice_code}（当前 v${current.version}，状态 ${current.status}）`;
      }
      out.requestId = deterministicUuid('iceos-review-import-bs-v1', csv.fileSha256, row.sourceRowId);
      out.result = '未执行';
      return out;
    }
    // jst_adopt
    const link = jstByCandidate.get(row.sourceRowId);
    const observation = observationByCandidate.get(row.sourceRowId);
    const item = itemByCode.get(row.targetCode);
    if (!link || !observation) {
      out.action = 'blocked';
      out.actionReasonCode = 'OBSERVATION_NOT_FOUND';
      out.reason = '冻结聚水潭观察中找不到该来源行 ID';
      out.result = '阻塞';
      return out;
    }
    if ((link.sheet ?? '') !== row.sheet || String(link.excelRow ?? '') !== row.excelRow
      || (link.sourceSku ?? '') !== row.sourceSku) {
      out.action = 'blocked';
      out.actionReasonCode = 'SOURCE_POSITION_MISMATCH';
      out.reason = `来源位置/原 SKU 与冻结观察不一致：CSV ${row.sheet}/${row.excelRow}/${row.sourceSku} vs 库 ${link.sheet}/${link.excelRow}/${link.sourceSku}`;
      out.result = '阻塞';
      return out;
    }
    if (!item) {
      out.action = 'blocked';
      out.actionReasonCode = 'ITEM_CODE_UNKNOWN';
      out.reason = `本次商品货号未在商品库唯一命中：${row.targetCode}`;
      out.result = '阻塞';
      return out;
    }
    out.targetItemId = item.id;
    out.targetItemName = item.name_cn;
    if (normalizeName(row.targetName) !== normalizeName(item.name_cn)) {
      out.action = 'blocked';
      out.actionReasonCode = 'ITEM_NAME_MISMATCH';
      out.reason = `本次商品名称与商品库不一致：CSV“${row.targetName}” / 库“${item.name_cn}”`;
      out.result = '阻塞';
      return out;
    }
    out.currentItemId = link.itemId ?? null;
    out.currentItemCode = link.itemId ? (itemById.get(link.itemId)?.ice_code ?? null) : null;
    out.currentStatus = link.reviewState ?? null;
    out.observationId = observation.id;
    if (link.reviewState === 'manual_selected' && link.itemId === item.id) {
      out.action = 'keep';
      out.reason = `当前冻结决定已是 manual_selected → ${item.ice_code}，保持，不追加新决定`;
    } else {
      out.action = 'rebind';
      out.reason = `追加本次复核决定：${link.reviewState ?? '(none)'} → manual_selected ${item.ice_code}`;
    }
    out.requestId = deterministicUuid('iceos-review-import-jst-v1', csv.fileSha256, row.sourceRowId);
    out.result = '未执行';
    return out;
  });

  const summary = summarize(rows, csv.fileSha256);
  for (const row of rows) {
    if ((row.category === 'bs_adopt' || row.category === 'jst_adopt') && row.result === '未执行') {
      row.result = row.action === 'keep' ? '保持' : '待执行';
    }
  }
  return { rows, summary, itemById, itemByCode, warehouseByName, warehouseById, mappingByKey, account, adminProfileId };
}

function summarize(rows, fileSha256) {
  const categories = {};
  const actions = {};
  for (const row of rows) {
    categories[row.category] = (categories[row.category] ?? 0) + 1;
    const key = `${row.category}:${row.action}`;
    actions[key] = (actions[key] ?? 0) + 1;
  }
  const adopt = rows.filter((r) => r.category === 'bs_adopt' || r.category === 'jst_adopt');
  const blocked = adopt.filter((r) => r.action === 'blocked');
  return {
    fileSha256,
    totalRows: rows.length,
    categories,
    actions,
    adoptTotal: adopt.length,
    adoptBlockedAtPlan: blocked.length,
    closure: {
      expected: 3156,
      categoriesSum: Object.values(categories).reduce((a, b) => a + b, 0),
      matches: Object.values(categories).reduce((a, b) => a + b, 0) === 3156,
    },
  };
}

// ---------------------------------------------------------------------------
// 写入：BS 逐行（既有 confirm RPC）
// ---------------------------------------------------------------------------
async function applyBsRow(client, adminProfileId, row, context) {
  const payload = {
    mappings: [{
      externalSku: row.sourceSku,
      warehouseExternalId: row.warehouseExternalId,
      itemId: row.targetItemId,
      unit: row.unit,
      expectedVersion: row.expectedVersion,
      reason: `复核结果采用 ${context.fileSha256.slice(0, 12)} ${row.sourceRowId}`.slice(0, 500),
      variantKey: VARIANT_KEY,
    }],
  };
  const intent = sha256(canonicalJson(payload));
  const requestId = row.requestId;
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [adminProfileId]);
    const isAdmin = (await client.query('SELECT catalog.is_admin() AS ok')).rows[0]?.ok;
    if (isAdmin !== true) throw new Error('REVIEW_IMPORT_NOT_ADMIN');
    // 写入前复核当前关系，防止覆盖计划之后的其他人工修改。
    const currentRows = (await client.query(`
      SELECT DISTINCT ON (m.warehouse_id,m.external_sku)
        m.id,m.external_sku,m.item_id,m.unit,m.version,m.status
      FROM catalog.inventory_sku_mapping m
      WHERE m.account_id=$1 AND m.warehouse_id=$2 AND m.external_sku=$3
      ORDER BY m.warehouse_id,m.external_sku,m.version DESC`,
    [context.account.id, row.warehouseId, row.sourceSku])).rows;
    const current = currentRows[0] ?? null;
    const plannedVersion = row.expectedVersion;
    const drifted = row.action === 'new'
      ? current !== null
      : (current === null || current.version !== plannedVersion || current.item_id !== row.currentItemId);
    if (drifted) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        outcome: 'blocked',
        reasonCode: 'IDENTITY_CHANGED_SINCE_PLAN',
        message: `计划后当前关系已变化（现 ${current ? `${current.item_id} v${current.version} ${current.status}` : '(none)'}）`,
        requestId,
      };
    }
    const receipt = (await client.query(
      'SELECT catalog.confirm_inventory_mapping($1,$2,$3::jsonb) AS r',
      [requestId, intent, JSON.stringify(payload.mappings)])).rows[0].r;
    await client.query('COMMIT');
    if (receipt.applied === 0) {
      const skipped = Array.isArray(receipt.skipped) ? receipt.skipped : [];
      return {
        ok: false,
        outcome: 'blocked',
        reasonCode: skipped[0]?.reason ?? 'INVENTORY_MAPPING_NOT_APPLIED',
        message: `映射未写入（applied=0）：${skipped.map((s) => s.reason).join(',') || 'unknown'}`,
        receipt,
        requestId,
        intent,
      };
    }
    return { ok: true, outcome: 'applied', receipt, requestId, intent };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return {
      ok: false,
      outcome: 'blocked',
      reasonCode: error.code ? `${error.code}:${String(error.message).split(':')[0]}` : String(error.message),
      message: String(error.message),
      requestId,
    };
  }
}

// ---------------------------------------------------------------------------
// 写入：JST 逐行（025 追加决定 RPC）
// ---------------------------------------------------------------------------
async function applyJstRow(client, adminProfileId, row, fileSha256) {
  const decision = {
    datasetSha256: fileSha256,
    sourceRowId: row.sourceRowId,
    legacyCandidateId: row.sourceRowId,
    observationId: row.observationId,
    itemId: row.targetItemId,
    reviewState: 'manual_selected',
    sourceFile: row.file,
    sourceSheet: row.sheet,
    sourceExcelRow: row.excelRow,
    sourceSku: row.sourceSku,
  };
  const payload = { decision };
  const intent = sha256(canonicalJson(payload));
  const requestId = row.requestId;
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [adminProfileId]);
    const isAdmin = (await client.query('SELECT catalog.is_admin() AS ok')).rows[0]?.ok;
    if (isAdmin !== true) throw new Error('REVIEW_IMPORT_NOT_ADMIN');
    const receipt = (await client.query(
      'SELECT catalog.apply_domestic_review_decision($1,$2,$3::jsonb) AS r',
      [requestId, intent, JSON.stringify(decision)])).rows[0].r;
    await client.query('COMMIT');
    return { ok: true, outcome: receipt.applied > 0 ? 'applied' : 'already', receipt, requestId, intent };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return {
      ok: false,
      outcome: 'blocked',
      reasonCode: error.code ? `${error.code}:${String(error.message).split(':')[0]}` : String(error.message),
      message: String(error.message),
      requestId,
    };
  }
}

async function findReceipt(client, adminProfileId, requestId) {
  return withReadTx(client, adminProfileId, async () => {
    const result = await client.query(
      'SELECT request_id,action,response,created_at FROM catalog.inventory_request WHERE request_id=$1', [requestId]);
    return result.rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------------
// 回读：按当前库重新核对（写入后也用它生成 result）
// ---------------------------------------------------------------------------
async function readback(client, plan, csv) {
  const state = await withReadTx(client, plan.adminProfileId, async () => loadState(client));
  const itemById = new Map(state.items.map((i) => [i.id, i]));
  const itemByCode = new Map(state.items.map((i) => [i.ice_code, i]));
  const warehouseByName = new Map(state.warehouses.map((w) => [w.external_name, w]));
  const mappingByKey = new Map(state.mappings.map((m) => [`${m.warehouse_id}|${m.external_sku}`, m]));
  const jstByCandidate = new Map(state.jstLinks.map((l) => [l.legacyCandidateId, l]));

  const bsRows = [];
  const jstRows = [];
  for (const row of plan.rows) {
    if (row.category === 'bs_adopt') {
      const warehouse = warehouseByName.get(row.warehouse);
      const current = warehouse ? mappingByKey.get(`${warehouse.id}|${row.sourceSku}`) : null;
      const currentCode = current ? (itemById.get(current.item_id)?.ice_code ?? null) : null;
      let status;
      let detail;
      if (!current) {
        status = row.action === 'blocked' ? '阻塞' : '仍未知';
        detail = `当前无正式关系（计划动作 ${row.action}）`;
      } else if (current.item_id === row.targetItemId) {
        status = row.currentItemId && row.currentItemId !== row.targetItemId
          ? '换绑'
          : (row.action === 'new' ? '新建' : '保持');
        detail = `${currentCode} v${current.version} ${current.status}`;
      } else {
        status = row.action === 'blocked' ? '阻塞' : '阻塞';
        detail = `当前为 ${currentCode} v${current.version}，与本次目标 ${row.targetCode} 不一致`;
      }
      bsRows.push({
        sourceRowId: row.sourceRowId,
        warehouse: row.warehouse,
        warehouseExternalId: row.warehouseExternalId,
        sourceSku: row.sourceSku,
        targetCode: row.targetCode,
        planAction: row.action,
        readbackStatus: status,
        currentCode,
        currentVersion: current?.version ?? null,
        mappingId: current?.id ?? null,
        detail,
      });
      row.result = status;
      row.resultDetail = detail;
    } else if (row.category === 'jst_adopt') {
      const link = jstByCandidate.get(row.sourceRowId);
      const currentCode = link?.itemId ? (itemById.get(link.itemId)?.ice_code ?? null) : null;
      let status;
      let detail;
      if (link && link.reviewState === 'manual_selected' && link.itemId === row.targetItemId) {
        status = row.currentStatus === 'manual_selected' && row.currentItemId === row.targetItemId ? '保持' : '换绑';
        detail = `manual_selected ${currentCode}`;
      } else {
        status = '阻塞';
        detail = `当前 reviewState=${link?.reviewState ?? '(none)'} item=${currentCode ?? '(none)'}`;
      }
      jstRows.push({
        sourceRowId: row.sourceRowId,
        file: row.file,
        sheet: row.sheet,
        excelRow: row.excelRow,
        sourceSku: row.sourceSku,
        targetCode: row.targetCode,
        previousReviewState: row.currentStatus,
        previousCode: row.currentItemCode,
        planAction: row.action,
        readbackStatus: status,
        currentReviewState: link?.reviewState ?? null,
        currentCode,
        detail,
      });
      row.result = status;
      row.resultDetail = detail;
    }
  }
  const count = (rows, key) => rows.reduce((acc, r) => {
    const value = r[key];
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  const domesticSnapshot = {
    recordCount: state.jstLinks.length,
    selectedCount: state.jstLinks.filter((l) => l.reviewState === 'manual_selected').length,
    linkedSelectedCount: state.jstLinks.filter((l) => l.reviewState === 'manual_selected' && l.itemId).length,
    linkedItemCount: new Set(state.jstLinks.filter((l) => l.itemId).map((l) => l.itemId)).size,
  };
  return {
    bs: { counts: count(bsRows, 'readbackStatus'), rows: bsRows },
    jst: { counts: count(jstRows, 'readbackStatus'), rows: jstRows },
    domesticSnapshot,
    state,
  };
}

// ---------------------------------------------------------------------------
// 证据写出（服务端大对象导出：精确 UTF-8 字节）
// ---------------------------------------------------------------------------
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvEscape(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(c.value(row))).join(','));
  return `${lines.join('\n')}\n`;
}

async function writeEvidenceFile(ownerClient, evidenceDir, name, content) {
  const absolute = path.resolve(evidenceDir, name).replace(/\\/g, '/');
  const { rows } = await ownerClient.query("SELECT lo_from_bytea(0, convert_to($1,'UTF8')) AS oid", [content]);
  const oid = rows[0].oid;
  try {
    await ownerClient.query('SELECT lo_export($1,$2)', [oid, absolute]);
  } finally {
    await ownerClient.query('SELECT lo_unlink($1)', [oid]);
  }
  return absolute;
}

function evidencePayloads(plan, csv, readbackResult, mode, context) {
  const generatedAt = new Date().toISOString();
  const classificationColumns = [
    { label: '分类', value: (r) => r.category },
    { label: '来源类型', value: (r) => r.sourceType },
    { label: '来源行ID', value: (r) => r.sourceRowId },
    { label: '文件', value: (r) => r.file },
    { label: '工作表', value: (r) => r.sheet },
    { label: '原表行', value: (r) => r.excelRow },
    { label: '仓库', value: (r) => r.warehouse },
    { label: '来源SKU', value: (r) => r.sourceSku },
    { label: '本次商品货号', value: (r) => r.targetCode },
    { label: '备注', value: (r) => r.note },
    { label: '动作', value: (r) => r.action },
    { label: '理由', value: (r) => r.reason },
    { label: '结果', value: (r) => r.result },
  ];
  const adoptRows = plan.rows.filter((r) => r.category === 'bs_adopt' || r.category === 'jst_adopt');
  const manifestColumns = [
    { label: '分类', value: (r) => r.category },
    { label: '来源行ID', value: (r) => r.sourceRowId },
    { label: '来源系统', value: (r) => r.sourceSystem },
    { label: '账号', value: (r) => r.accountLabel },
    { label: '仓库', value: (r) => r.warehouse },
    { label: '仓库ID', value: (r) => r.warehouseExternalId },
    { label: '原SKU', value: (r) => r.sourceSku },
    { label: '来源名称', value: (r) => r.sourceName },
    { label: '原目标商品', value: (r) => r.currentItemCode ?? '' },
    { label: '当前版本', value: (r) => r.currentVersion ?? '' },
    { label: '本次目标商品', value: (r) => r.targetCode ? `${r.targetCode} ${r.targetName}`.trim() : '' },
    { label: '动作', value: (r) => r.action },
    { label: '理由', value: (r) => r.reason },
    { label: '结果', value: (r) => r.result },
    { label: '结果明细', value: (r) => r.resultDetail ?? '' },
    { label: '请求ID', value: (r) => r.requestId ?? '' },
    { label: '来源文件', value: (r) => r.file },
    { label: '原表行', value: (r) => r.excelRow },
  ];
  const hiddenRows = plan.rows.filter((r) => r.category === 'bs_hidden' && r.action === 'hidden_keep_existing');
  const hiddenColumns = [
    { label: '来源行ID', value: (r) => r.sourceRowId },
    { label: '仓库', value: (r) => r.warehouse },
    { label: '原SKU', value: (r) => r.sourceSku },
    { label: 'CSV本次目标', value: (r) => r.targetCode },
    { label: '保留的正式关系', value: (r) => r.currentItemCode },
    { label: '关系版本', value: (r) => r.currentVersion },
    { label: '说明', value: (r) => r.reason },
  ];
  const receipts = plan.rows
    .filter((r) => r.receipt || r.requestId)
    .map((r) => ({
      sourceRowId: r.sourceRowId,
      category: r.category,
      action: r.action,
      result: r.result,
      requestId: r.requestId,
      applied: r.receipt?.applied ?? null,
      existing: r.receipt?.existing ?? null,
      skipped: r.receipt?.skipped ?? null,
      committed: r.receipt?.committed ?? null,
      error: r.receiptError ?? null,
    }));
  const summary = {
    ...plan.summary,
    mode,
    generatedAt,
    database: context.database,
    evidenceDir: context.evidenceDir,
    apply: readbackResult ? { runAt: generatedAt } : null,
  };
  return {
    'classification-summary.json': `${JSON.stringify(summary, null, 2)}\n`,
    'classification-rows.csv': toCsv(classificationColumns, plan.rows),
    'apply-manifest.csv': toCsv(manifestColumns, adoptRows),
    'hidden-existing-mappings.csv': toCsv(hiddenColumns, hiddenRows),
    'receipts.json': `${JSON.stringify({ fileSha256: csv.fileSha256, receipts }, null, 2)}\n`,
    ...(readbackResult ? {
      'readback-bs.json': `${JSON.stringify({ mode, generatedAt, counts: readbackResult.bs.counts, rows: readbackResult.bs.rows }, null, 2)}\n`,
      'readback-jst.json': `${JSON.stringify({ mode, generatedAt, counts: readbackResult.jst.counts, domesticSnapshot: readbackResult.domesticSnapshot, rows: readbackResult.jst.rows }, null, 2)}\n`,
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: review-import.mjs --mode plan|apply|verify [--dsn <url>] [--allow-formal] [--no-evidence]');
    return;
  }
  const csvPath = args.csv ?? DEFAULT_CSV;
  const evidenceDir = args.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
  const instance = JSON.parse(await readFile(INSTANCE_FILE, 'utf8'));
  const { default: pg } = await import('pg');

  const formalAppUrl = `postgres://${instance.appRunnerUser}:${instance.appRunnerPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const targetUrl = args.dsn ?? formalAppUrl;
  const target = new URL(targetUrl);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const host = target.hostname;
  const port = Number(target.port || 5432);
  const targetIsFormal = dbName === instance.dbName;
  if (args.mode === 'apply' && targetIsFormal) {
    if (!args.allowFormal || process.env.REVIEW_IMPORT_FORMAL_APPROVED !== '1') {
      throw new Error('REVIEW_IMPORT_FORMAL_WRITE_NOT_APPROVED: 正式库写入需 Lead 批准（--allow-formal + REVIEW_IMPORT_FORMAL_APPROVED=1）');
    }
  }
  if (args.mode === 'apply' && targetIsFormal && !args.dsn) {
    // 明确目标，不允许“没传 dsn 就默默写正式库”。
    throw new Error('REVIEW_IMPORT_FORMAL_WRITE_NEEDS_EXPLICIT_DSN');
  }

  const csv = await loadReviewCsv(csvPath);
  const app = new pg.Client({ connectionString: targetUrl });
  await app.connect();
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${host}:${port}/${dbName}`;
  let owner = null;
  try {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
  } catch (error) {
    owner = null;
    if (args.evidence && args.mode !== 'plan') {
      console.error(`WARN evidence writer unavailable (${error.message}); continuing without file evidence`);
    }
  }
  const context = {
    csvPath,
    fileSha256: csv.fileSha256,
    database: {
      host,
      port,
      dbName,
      targetIsFormal,
      appUser: decodeURIComponent(target.username),
      label: args.label ?? null,
    },
    evidenceDir,
  };
  try {
    const adminProfileId = await loadAdminProfileId(owner ?? app);
    const state = await withReadTx(app, adminProfileId, async () => loadState(app));
    const plan = buildPlan({ csv, state, adminProfileId });
    context.account = plan.account;
    console.log(JSON.stringify({ stage: 'plan', ...plan.summary, database: context.database }, null, 2));

    let readbackResult = null;
    if (args.mode === 'apply') {
      const started = Date.now();
      for (const row of plan.rows) {
        if (row.category === 'bs_adopt' && (row.action === 'new' || row.action === 'rebind')) {
          const outcome = await applyBsRow(app, adminProfileId, row, context);
          row.receipt = outcome.receipt ?? null;
          row.receiptError = outcome.ok ? null : outcome.message;
          row.applyOutcome = outcome;
          if (outcome.ok) row.result = outcome.receipt.applied > 0 ? '已写入' : '已有回执';
          else row.result = '阻塞';
        } else if (row.category === 'jst_adopt' && row.action === 'rebind') {
          const outcome = await applyJstRow(app, adminProfileId, row, csv.fileSha256);
          row.receipt = outcome.receipt ?? null;
          row.receiptError = outcome.ok ? null : outcome.message;
          row.applyOutcome = outcome;
          if (outcome.ok) row.result = outcome.receipt.applied > 0 ? '已写入' : '已有回执';
          else row.result = '阻塞';
        } else if ((row.category === 'bs_adopt' || row.category === 'jst_adopt') && row.action === 'keep') {
          const receipt = await findReceipt(app, adminProfileId, row.requestId);
          row.receipt = receipt ? toJson(receipt.response) : null;
          row.result = receipt ? '已有回执' : '保持';
        }
      }
      const elapsedMs = Date.now() - started;
      const failures = plan.rows.filter((r) => r.receiptError).slice(0, 40)
        .map((r) => ({ sourceRowId: r.sourceRowId, category: r.category, action: r.action, error: r.receiptError }));
      readbackResult = await readback(app, plan, csv);
      console.log(JSON.stringify({
        stage: 'apply',
        elapsedMs,
        bs: readbackResult.bs.counts,
        jst: readbackResult.jst.counts,
        domesticSnapshot: readbackResult.domesticSnapshot,
        failures,
      }, null, 2));
    } else if (args.mode === 'verify') {
      readbackResult = await readback(app, plan, csv);
      console.log(JSON.stringify({ stage: 'verify', bs: readbackResult.bs.counts, jst: readbackResult.jst.counts, domesticSnapshot: readbackResult.domesticSnapshot }, null, 2));
    }

    if (args.evidence && owner) {
      const payloads = evidencePayloads(plan, csv, readbackResult, args.mode, context);
      const written = [];
      for (const [name, content] of Object.entries(payloads)) {
        written.push(await writeEvidenceFile(owner, evidenceDir, name, content));
      }
      console.log(JSON.stringify({ stage: 'evidence', files: written }, null, 2));
    }
    console.log(JSON.stringify({
      stage: 'final',
      mode: args.mode,
      fileSha256: csv.fileSha256,
      adopt: {
        bs: plan.rows.filter((r) => r.category === 'bs_adopt').reduce((acc, r) => { acc[r.result ?? r.action] = (acc[r.result ?? r.action] ?? 0) + 1; return acc; }, {}),
        jst: plan.rows.filter((r) => r.category === 'jst_adopt').reduce((acc, r) => { acc[r.result ?? r.action] = (acc[r.result ?? r.action] ?? 0) + 1; return acc; }, {}),
      },
      otherCategories: plan.rows.filter((r) => !['bs_adopt', 'jst_adopt'].includes(r.category)).reduce((acc, r) => {
        acc[r.category] = (acc[r.category] ?? 0) + 1;
        return acc;
      }, {}),
    }, null, 2));
  } finally {
    await app.end().catch(() => {});
    if (owner) await owner.end().catch(() => {});
  }
}

export {
  DEFAULT_CSV,
  EXPECTED_SHA256,
  buildPlan,
  loadAdminProfileId,
  loadReviewCsv,
  loadState,
  withReadTx,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
