/**
 * 初始化「已确认商品对应」（本来源 + 规范化品名 + 市场 → 商品库商品）。
 *
 * 只写入在途各轮已经明确确认的对应，不从全部历史人工绑定自动学习：
 *   - 乙醇酸爽肤水 200ml：菲律宾/越南 → LS101274；泰国/马来西亚 → WM0094
 *   - 抗重力视黄醇按摩电动眼霜：菲律宾/越南 → WM0031；泰国/马来西亚 → WM0130
 *   - UV 水润防晒乳：菲律宾/越南 → WM0039；泰国/马来西亚 → WM0093
 *   - 泰国特供防晒水 90ml（明确写“泰国特供版本”）：泰国 → WM0082（既有用户确认）
 *   - 100g 升级普通版洗面奶：菲律宾/越南 → WM0012（沿用已确认升级普通版身份）
 *   - POKNZX027385 的「WM0057…M04 → WM0060」是单票纠错，不写通用对应。
 *
 * 用法：node scripts/shipment/seed-confirmed-mappings.mjs --run-id <run-2026...> [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArgs } from '../catalog/prepare.mjs';

const args = readArgs(process.argv.slice(2));
const dryRun = process.argv.includes('--dry-run');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const instanceRoot = path.join(REPO_ROOT, '.local', 'catalog', args.runId, 'instance');
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'env.inventory.json'), 'utf8'));

/** 规范化品名与市场必须与来源解析结果一致（本脚本不改写品名，只登记对应）。 */
const SEEDS = [
  { nameNorm: 'icelerskin乙醇酸爽肤水200ml', market: '菲律宾', iceCode: 'LS101274',
    basis: '在途各轮已确认：爽肤水 菲律宾/越南 → LS101274（合同 §11.1）' },
  { nameNorm: 'icelerskin乙醇酸爽肤水200ml', market: '越南', iceCode: 'LS101274',
    basis: '在途各轮已确认：爽肤水 菲律宾/越南 → LS101274（合同 §11.1）' },
  { nameNorm: 'icelerskin乙醇酸爽肤水200ml', market: '泰国', iceCode: 'WM0094',
    basis: '在途各轮已确认：爽肤水 泰国/马来西亚 → WM0094（合同 §11.1）' },
  { nameNorm: 'icelerskin乙醇酸爽肤水200ml', market: '马来西亚', iceCode: 'WM0094',
    basis: '在途各轮已确认：爽肤水 泰国/马来西亚 → WM0094（合同 §11.1）' },
  { nameNorm: 'icelerskin抗重力视黄醇按摩电动眼霜', market: '菲律宾', iceCode: 'WM0031',
    basis: '在途各轮已确认：眼霜 菲律宾/越南 → WM0031（合同 §12）' },
  { nameNorm: 'icelerskin抗重力视黄醇按摩电动眼霜', market: '越南', iceCode: 'WM0031',
    basis: '在途各轮已确认：眼霜 菲律宾/越南 → WM0031（合同 §12）' },
  { nameNorm: 'icelerskin抗重力视黄醇按摩电动眼霜', market: '泰国', iceCode: 'WM0130',
    basis: '在途各轮已确认：眼霜 泰国/马来西亚 → WM0130（合同 §12）' },
  { nameNorm: 'icelerskin抗重力视黄醇按摩电动眼霜', market: '马来西亚', iceCode: 'WM0130',
    basis: '在途各轮已确认：眼霜 泰国/马来西亚 → WM0130（合同 §12）' },
  { nameNorm: 'icelerskin防晒乳', market: '菲律宾', iceCode: 'WM0039',
    basis: '在途各轮已确认：防晒乳 菲律宾/越南 → WM0039（合同 §12）' },
  { nameNorm: 'icelerskin防晒乳', market: '越南', iceCode: 'WM0039',
    basis: '在途各轮已确认：防晒乳 菲律宾/越南 → WM0039（合同 §12）' },
  { nameNorm: 'icelerskin防晒乳', market: '泰国', iceCode: 'WM0093',
    basis: '在途各轮已确认：防晒乳 泰国/马来西亚 → WM0093（合同 §12）' },
  { nameNorm: 'icelerskin防晒乳', market: '马来西亚', iceCode: 'WM0093',
    basis: '在途各轮已确认：防晒乳 泰国/马来西亚 → WM0093（合同 §12）' },
  { nameNorm: 'icelerskin防晒水90ml(泰国特供版本)', market: '泰国', iceCode: 'WM0082',
    basis: '既有用户确认 user-20261020-jst-WM0082：明确写泰国特供的防晒水 90ml → WM0082' },
  { nameNorm: 'icelerskin氨基酸洗面奶100g(升级款)', market: '菲律宾', iceCode: 'WM0012',
    basis: '沿用已确认升级普通版身份：100g 升级款洗面奶 菲律宾/越南 → WM0012（合同 §11.1）' },
  { nameNorm: 'icelerskin氨基酸洗面奶100g(升级款)', market: '越南', iceCode: 'WM0012',
    basis: '沿用已确认升级普通版身份：100g 升级款洗面奶 菲律宾/越南 → WM0012（合同 §11.1）' },
];

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
await client.connect();
try {
  const identity = (await client.query(
    'SELECT current_database() AS db, inet_server_port() AS port, current_user AS usr')).rows[0];
  if (String(identity.port) !== String(inventoryEnv.port) || identity.db !== inventoryEnv.database) {
    throw new Error(`DB_IDENTITY_MISMATCH:${JSON.stringify(identity)}`);
  }
  const codes = [...new Set(SEEDS.map((seed) => seed.iceCode))];
  const products = new Map((await client.query(
    'SELECT ice_code, item_id FROM catalog.catalog_item_code WHERE ice_code = ANY($1::text[])',
    [codes])).rows.map((row) => [row.ice_code, row.item_id]));
  const missing = codes.filter((code) => !products.has(code));
  if (missing.length > 0) throw new Error(`ICE_CODE_NOT_FOUND:${missing.join(',')}`);
  const knownNames = new Set((await client.query(
    'SELECT DISTINCT product_name_norm FROM catalog.shipment_item')).rows
    .map((row) => row.product_name_norm));
  const unknownNames = [...new Set(SEEDS.map((seed) => seed.nameNorm))]
    .filter((name) => !knownNames.has(name));
  if (unknownNames.length > 0) throw new Error(`NORMALIZED_NAME_NOT_IN_SOURCE:${unknownNames.join(',')}`);

  if (!dryRun) {
    for (const seed of SEEDS) {
      await client.query(
        'SELECT catalog.shipment_mapping_upsert($1,$2,$3,$4,$5,NULL)',
        ['feishu_logistics_sheet', seed.nameNorm, seed.market, products.get(seed.iceCode), seed.basis]);
    }
  }
  const rows = (await client.query(
    `SELECT m.product_name_norm, m.market, c.ice_code, m.basis, m.revision
     FROM catalog.shipment_product_mapping m
     LEFT JOIN catalog.catalog_item_code c ON c.item_id=m.product_id
     ORDER BY m.product_name_norm, m.market`)).rows;
  const unexpected = (await client.query(
    `SELECT count(*)::int AS n FROM catalog.shipment_product_mapping
     WHERE product_name_norm LIKE 'wm0057%' OR market NOT IN ('菲律宾','越南','泰国','马来西亚')`)).rows[0].n;
  const result = {
    runId: args.runId,
    dryRun,
    database: identity,
    seeded: SEEDS.length,
    mappings: rows,
    unexpectedMappings: unexpected,
    checkedAt: new Date().toISOString(),
  };
  const dir = path.join(REPO_ROOT, '.local', 'shipment-v1-r6-auto-20261103');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `seed-mappings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (unexpected > 0) process.exitCode = 1;
} finally {
  await client.end();
}
