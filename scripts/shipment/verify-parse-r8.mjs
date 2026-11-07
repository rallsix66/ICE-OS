/**
 * 第八轮解析口径回读：用**现役库最近一次成功快照的原始网格** + 仓库当前 parse.ts 重新解析，
 * 验证两条真实误判是否会被下一次正常读取自动纠正（只读，不写库、不触发飞书）：
 *   - POKNZX026710 H=`三酸喷雾：已到货上架`：WM0098 明细 sourceReceiptBasis=status_arrived_full（剩余 0），
 *     同票 WM0094 未被点名 → 保持 pending（不整票归零）；
 *   - POKNZX027080 G=`11/3 排队送往拆派仓`、H 空 → 票级 in_transit（剩余 = 发货量）；
 *   - POKNZX027084 只有运单号/数字行 → 仍 partial，明细不归属。
 *
 * 用法：node scripts/shipment/verify-parse-r8.mjs [--run-id ...]
 * 证据：.local/shipment-v1-r8-20261104/parse-r8-verify.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTsLoader } from '../catalog/feishu-source/ts-loader.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r8-20261104');

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

/** 与 029 ingest core 相同的原表判断优先级（只用于本次证据核对）。 */
function sourceJudgement(ticket, item) {
  let basis;
  let received;
  if (item.sourceReceiptBasis) {
    basis = item.sourceReceiptBasis;
    received = basis === 'status_arrived_full'
      ? item.shippedQuantity
      : basis === 'pending' ? null : 0;
  } else if (typeof item.sourceReceivedQuantity === 'number') {
    basis = 'source_quantity';
    received = item.sourceReceivedQuantity;
  } else {
    basis = ticket.receivedBasis;
    received = basis === 'status_arrived_full'
      ? item.shippedQuantity
      : basis === 'pending' ? null : 0;
  }
  return {
    basis,
    received,
    remaining: received === null ? null : item.shippedQuantity - received,
  };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const env = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, '.local/catalog', runId, 'instance/env.inventory.json'), 'utf8'));
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: env.ownerDbUrl });
  await client.connect();
  const evidence = { runId, database: env.database, at: new Date().toISOString(), checks: results };
  try {
    const snapshot = (await client.query(
      `SELECT id, revision, read_finished_at, ticket_count, item_count, raw
       FROM catalog.shipment_source_snapshot
       WHERE status='success' ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1`)).rows[0];
    evidence.snapshot = {
      id: snapshot?.id ?? null,
      revision: snapshot?.revision ?? null,
      readFinishedAt: snapshot?.read_finished_at ?? null,
      ticketCount: snapshot?.ticket_count ?? null,
      itemCount: snapshot?.item_count ?? null,
    };
    check('现役库存在最近成功快照原始网格', Boolean(snapshot?.raw?.values), evidence.snapshot);
    if (!snapshot?.raw?.values) return;

    const loader = createTsLoader({ tempDir: path.join(EVIDENCE_DIR, 'ts-temp') });
    const parse = await loader.load(path.join(REPO_ROOT, 'src/features/shipment/server/parse.ts'));
    const parsed = parse.parseShipmentSnapshot({
      collection: snapshot.raw.collection,
      values: snapshot.raw.values,
      merges: snapshot.raw.merges ?? [],
    });
    evidence.parsedTotals = {
      tickets: parsed.tickets.length,
      items: parsed.tickets.reduce((sum, ticket) => sum + ticket.items.length, 0),
    };
    check('重新解析票/明细数与最近成功快照一致',
      evidence.parsedTotals.tickets === snapshot.ticket_count
      && evidence.parsedTotals.items === snapshot.item_count, evidence.parsedTotals);

    const byPo = new Map(parsed.tickets.map((ticket) => [ticket.purchaseOrder, ticket]));
    const summarize = (ticket) => ticket && {
      ticketKey: ticket.ticketKey,
      purchaseOrder: ticket.purchaseOrder,
      statusClass: ticket.statusClass,
      receivedBasis: ticket.receivedBasis,
      transportText: ticket.transportText,
      arrivalText: ticket.arrivalText,
      items: ticket.items.map((item) => {
        const judgement = sourceJudgement(ticket, item);
        return {
          productNameRaw: item.productNameRaw,
          shippedQuantity: item.shippedQuantity,
          sourceReceiptBasis: item.sourceReceiptBasis,
          basis: judgement.basis,
          receivedQuantity: judgement.received,
          remainingQuantity: judgement.received === null
            ? null : item.shippedQuantity - judgement.received,
        };
      }),
    };

    // ---- POKNZX026710：逐商品点名到货 ----
    const ticket026710 = byPo.get('POKNZX026710');
    const summary026710 = summarize(ticket026710);
    evidence.poknzx026710 = summary026710;
    if (ticket026710) {
      const namedItem = ticket026710.items.find((item) => item.productNameRaw.includes('三酸'));
      const otherItem = ticket026710.items.find((item) => item.productNameRaw.includes('乙醇酸'));
      check('POKNZX026710 票级仍为部分到货待核',
        ticket026710.statusClass === 'partial' && ticket026710.receivedBasis === 'pending',
        { statusClass: ticket026710.statusClass, receivedBasis: ticket026710.receivedBasis });
      check('POKNZX026710 被点名的三酸明细 → 已到货上架（剩余 0）',
        namedItem?.sourceReceiptBasis === 'status_arrived_full'
        && sourceJudgement(ticket026710, namedItem).received === namedItem.shippedQuantity
        && sourceJudgement(ticket026710, namedItem).remaining === 0,
        namedItem ? {
          item: namedItem.productNameRaw,
          basis: namedItem.sourceReceiptBasis,
          received: sourceJudgement(ticket026710, namedItem).received,
          remaining: sourceJudgement(ticket026710, namedItem).remaining,
        } : null);
      check('POKNZX026710 未被点名的乙醇酸明细 → 保持待核（不整票归零）',
        otherItem?.sourceReceiptBasis === null
        && sourceJudgement(ticket026710, otherItem).received === null
        && sourceJudgement(ticket026710, otherItem).remaining === null,
        otherItem ? {
          item: otherItem.productNameRaw,
          basis: otherItem.sourceReceiptBasis,
          received: sourceJudgement(ticket026710, otherItem).received,
        } : null);
    } else {
      check('POKNZX026710 仍在来源里', false, '未找到该票');
    }

    // ---- POKNZX027080：G 运输进度 → 运输中 ----
    const ticket027080 = byPo.get('POKNZX027080');
    const summary027080 = summarize(ticket027080);
    evidence.poknzx027080 = summary027080;
    check('POKNZX027080 G 写运输进度、H 空 → 运输中（剩余=发货量）',
      ticket027080?.statusClass === 'in_transit'
      && ticket027080?.receivedBasis === 'status_in_transit_zero'
      && ticket027080.items.every((item) => sourceJudgement(ticket027080, item).received === 0),
      summary027080 ? {
        statusClass: summary027080.statusClass,
        items: summary027080.items.map((row) => [row.productNameRaw, row.receivedQuantity, row.remainingQuantity]),
      } : null);

    // ---- POKNZX027084：只有运单号/数字行 → 仍 partial、明细不归属 ----
    const ticket027084 = byPo.get('POKNZX027084');
    evidence.poknzx027084 = summarize(ticket027084);
    check('POKNZX027084 仍为部分到货待核且明细不归属（不解析自由文本数字）',
      ticket027084?.statusClass === 'partial'
      && ticket027084.receivedBasis === 'pending'
      && ticket027084.items.every((item) => item.sourceReceiptBasis === null
        && sourceJudgement(ticket027084, item).received === null),
      evidence.poknzx027084);

    // ---- 全表：逐商品归属只发生在点名行上 ----
    const attributed = [];
    for (const ticket of parsed.tickets) {
      for (const item of ticket.items) {
        if (item.sourceReceiptBasis) {
          attributed.push({ ticketNo: ticket.ticketNo, item: item.productNameRaw, basis: item.sourceReceiptBasis });
        }
      }
    }
    evidence.attributedItems = attributed;
    check('逐商品归属没有扩散到无关票据', attributed.length <= 5, attributed);

    // ---- 下一次正常读取会带来的票级/明细级变化（只读预测，供验收核对“无意外修订”） ----
    const dbTickets = (await client.query(
      `SELECT ticket_key, purchase_order, status_class, received_basis FROM catalog.shipment`)).rows;
    const dbByPo = new Map(dbTickets.filter((row) => row.purchase_order).map((row) => [row.purchase_order, row]));
    const statusChanges = [];
    for (const ticket of parsed.tickets) {
      const row = dbByPo.get(ticket.purchaseOrder);
      if (!row) continue;
      if (row.status_class !== ticket.statusClass || row.received_basis !== ticket.receivedBasis) {
        statusChanges.push({
          purchaseOrder: ticket.purchaseOrder,
          from: [row.status_class, row.received_basis],
          to: [ticket.statusClass, ticket.receivedBasis],
        });
      }
    }
    evidence.statusChanges = statusChanges;
    check('票级状态变化的票数在预期范围（028 修复 + G 在途修正）', statusChanges.length <= 8, statusChanges);

    const dbItems = (await client.query(
      `SELECT i.item_key, i.source_receipt_basis, s.purchase_order
       FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id`)).rows;
    const itemBasisChanges = [];
    for (const row of dbItems) {
      const ticket = row.purchase_order ? byPo.get(row.purchase_order) : null;
      if (!ticket) continue;
      const parsedItem = ticket.items.find((item) => item.itemKey === row.item_key);
      if (!parsedItem) continue;
      const nextBasis = parsedItem.sourceReceiptBasis ?? ticket.receivedBasis;
      if (nextBasis !== row.source_receipt_basis) {
        itemBasisChanges.push({
          purchaseOrder: row.purchase_order,
          itemKey: row.item_key,
          from: row.source_receipt_basis,
          to: nextBasis,
        });
      }
    }
    evidence.itemBasisChanges = itemBasisChanges;
    check('明细来源依据变化条数在预期范围（只有逐商品点名）', itemBasisChanges.length <= 8,
      itemBasisChanges.slice(0, 10));

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'parse-r8-verify.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    const failed = results.filter((row) => !row.ok);
    console.log(`\nSUMMARY checks=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
