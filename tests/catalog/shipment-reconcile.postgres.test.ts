import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { parseShipmentSnapshot } from '@/features/shipment/server/parse';
import type { ShipmentSourceCollection } from '@/features/shipment/types';

/**
 * 货票与在途 v1 第二轮：Lead 只读对账（最新真实来源 → 解析 → 数据库 → 列表/详情 RPC）。
 *
 * - 使用 .local 实例的连接串（不写死库名/凭据），全程只读事务，结束 ROLLBACK；
 * - 原网格取自最近一次成功读取快照（由页面真实刷新写入），用当前解析器重新解析；
 * - 逐票逐明细比较身份/编号/市场/报关/运单号/采购单号/G/H/状态分类/到货依据/发货量/累计到货/
 *   来源备注，差异计入报告；最后核对列表/详情/相关货票/身份索引 RPC 输出。
 * - 证据写到 .local/shipment-v1-repair-20261101/lead-reconcile/reconciliation.json。
 *
 * 运行：node node_modules/vitest/vitest.mjs run tests/catalog/shipment-reconcile.postgres.test.ts
 * （文件名含 postgres.test.ts，默认 `npm run test` 会排除）
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTANCE = path.join(REPO_ROOT, '.local/catalog/run-20261026T211500Z-11a22b33/instance');
const ENV_FILE = path.join(INSTANCE, 'env.inventory.json');
const OUT_DIR = path.join(REPO_ROOT, '.local/shipment-v1-repair-20261101/lead-reconcile');
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';

type ShipmentListRpc = {
  total: number;
  counts: Record<string, number>;
  includeAbsent: boolean;
  absentTickets: number;
  absentItems: number;
  rows: Array<Record<string, unknown>>;
};

type ShipmentDetailRpc = {
  items: unknown[];
  missingItems: unknown[];
  shipment: { presentInLatestRead: boolean; identityStatus: string };
  latestReadAt: string | null;
};

type ProductLinkRpc = {
  total: number;
  rows: Array<{ ticketNo?: string }>;
};

function readEnv(): { appDbUrl: string; ownerDbUrl: string } {
  const parsed = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8')) as {
    appDbUrl: string;
    ownerDbUrl: string;
  };
  return { appDbUrl: parsed.appDbUrl, ownerDbUrl: parsed.ownerDbUrl };
}

function receivedOf(basis: string, shipped: number): number | null {
  if (basis === 'status_arrived_full') return shipped;
  if (basis === 'status_in_transit_zero' || basis === 'status_awaiting_shelving_zero') return 0;
  return null;
}

describe('shipment real-source read-only reconciliation', () => {
  it('最新真实网格 → 解析 → 数据库 → 列表/详情/相关货票 一致', async () => {
    const { appDbUrl, ownerDbUrl } = readEnv();
    const owner = new pg.Client({ connectionString: ownerDbUrl });
    await owner.connect();
    const differences: Array<Record<string, unknown>> = [];
    const summary: {
      snapshot?: unknown;
      database?: unknown;
      rpc?: {
        list: {
          total: number;
          counts: Record<string, number>;
          includeAbsent: boolean;
          absentTickets: number;
          absentItems: number;
          rows: number;
          allPresent: boolean;
          summaryIsNamesOnly: boolean;
          noSourceUpdatedAt: boolean;
        };
        listAll: { total: number; rows: number };
        detail: { items: number; missingItems: number; present: boolean; identity: string; latestReadAt: string | null };
        productLinks: { total: number; ticketNos: string[] };
        identityIndex: number;
      };
    } = {};
    try {
      await owner.query('BEGIN READ ONLY');
      const latest = (await owner.query(
        `SELECT id, revision, document_edited_at, read_finished_at, raw
           FROM catalog.shipment_source_snapshot
          WHERE status='success' ORDER BY read_finished_at DESC, id DESC LIMIT 1`,
      )).rows[0];
      const raw = latest.raw as {
        values: Array<Array<string | number | null>>;
        merges: [];
        collection: ShipmentSourceCollection;
      };
      const parsed = parseShipmentSnapshot({
        collection: { ...raw.collection, revision: Number(latest.revision) },
        values: raw.values,
        merges: raw.merges,
      });
      summary.snapshot = {
        id: latest.id,
        revision: latest.revision,
        documentEditedAt: latest.document_edited_at,
        readFinishedAt: latest.read_finished_at,
        ticketCount: parsed.tickets.length,
        itemCount: parsed.tickets.reduce((total, ticket) => total + ticket.items.length, 0),
      };

      const dbTickets = (await owner.query(
        `SELECT id, ticket_key, ticket_no, market, customs_method, waybills_text, purchase_order,
                transport_text, arrival_text, status_class, received_basis, identity_status,
                identity_note, source_row_start, source_row_end, last_seen_snapshot_id
           FROM catalog.shipment ORDER BY source_row_start`,
      )).rows;
      const dbItems = (await owner.query(
        `SELECT i.shipment_id, i.item_key, i.product_name_raw, i.shipped_quantity,
                i.received_quantity, i.receipt_basis, i.source_note, i.product_id,
                i.association_status, i.last_seen_snapshot_id
           FROM catalog.shipment_item i ORDER BY i.shipment_id, i.sort_index, i.id`,
      )).rows;
      summary.database = {
        tickets: dbTickets.length,
        items: dbItems.length,
        currentTickets: dbTickets.filter((row) => row.last_seen_snapshot_id === latest.id).length,
        associatedItems: dbItems.filter((row) => row.product_id !== null).length,
        historyRevisions: (await owner.query(
          'SELECT (SELECT count(*) FROM catalog.shipment_revision) AS ticket,'
          + ' (SELECT count(*) FROM catalog.shipment_item_revision) AS item,'
          + ' (SELECT count(*) FROM catalog.shipment_item_association_revision) AS association',
        )).rows[0],
      };

      expect(dbTickets.length).toBe(parsed.tickets.length);
      const byKey = new Map(dbTickets.map((row) => [row.ticket_key, row]));
      for (const ticket of parsed.tickets) {
        const row = byKey.get(ticket.ticketKey);
        if (!row) {
          differences.push({ scope: 'ticket', key: ticket.ticketKey, field: 'missing_in_db' });
          continue;
        }
        const expectations: Record<string, unknown> = {
          ticket_no: ticket.ticketNo,
          market: ticket.market,
          customs_method: ticket.customsMethod,
          waybills_text: ticket.waybillsText,
          purchase_order: ticket.purchaseOrder,
          transport_text: ticket.transportText,
          arrival_text: ticket.arrivalText,
          status_class: ticket.statusClass,
          received_basis: ticket.receivedBasis,
          identity_status: 'confirmed',
          source_row_start: ticket.sourceRowStart,
          source_row_end: ticket.sourceRowEnd,
          last_seen_snapshot_id: latest.id,
        };
        for (const [field, expected] of Object.entries(expectations)) {
          if (row[field] !== expected) {
            differences.push({ scope: 'ticket', key: ticket.ticketNo, field, expected, actual: row[field] });
          }
        }
        const items = dbItems.filter((item) => item.shipment_id === row.id);
        const ticketItems = items;
        if (ticketItems.length !== ticket.items.length) {
          differences.push({
            scope: 'ticket', key: ticket.ticketNo, field: 'item_count',
            expected: ticket.items.length, actual: ticketItems.length,
          });
          continue;
        }
        for (const item of ticket.items) {
          const itemRow = ticketItems.find((candidate) => candidate.item_key === item.itemKey);
          if (!itemRow) {
            differences.push({ scope: 'item', key: `${ticket.ticketNo}/${item.itemKey}`, field: 'missing_in_db' });
            continue;
          }
          const itemExpectations: Record<string, unknown> = {
            product_name_raw: item.productNameRaw,
            shipped_quantity: item.shippedQuantity,
            received_quantity: receivedOf(ticket.receivedBasis, item.shippedQuantity),
            receipt_basis: ticket.receivedBasis,
            source_note: item.sourceNote,
            last_seen_snapshot_id: latest.id,
          };
          for (const [field, expected] of Object.entries(itemExpectations)) {
            if (itemRow[field] !== expected) {
              differences.push({
                scope: 'item', key: `${ticket.ticketNo}/${item.itemKey}`, field, expected, actual: itemRow[field],
              });
            }
          }
        }
      }

      // ---- RPC：app 角色 + 启用中管理员 claim（只读，结束 ROLLBACK）----
      const app = new pg.Client({ connectionString: appDbUrl });
      await app.connect();
      const rpc = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
        const result = await app.query<{ result: T }>(sql, params);
        await app.query('ROLLBACK');
        return result.rows[0]?.result as T;
      };
      try {
        const list = await rpc<ShipmentListRpc>(
          'SELECT catalog.read_shipment_list($1,$2,$3,$4,$5,$6,$7) AS result',
          [null, null, null, null, false, 100, 0],
        );
        const listAll = await rpc<ShipmentListRpc>(
          'SELECT catalog.read_shipment_list($1,$2,$3,$4,$5,$6,$7) AS result',
          [null, null, null, null, true, 100, 0],
        );
        const detail = await rpc<ShipmentDetailRpc>(
          'SELECT catalog.read_shipment_detail($1) AS result', [dbTickets[0].id],
        );
        const associations = dbItems.filter((item) => item.product_id !== null);
        const productLink = await rpc<ProductLinkRpc>(
          'SELECT catalog.read_product_shipment_links($1,$2) AS result',
          [associations[0].product_id, 20],
        );
        const identityIndex = await rpc<unknown[]>(
          'SELECT catalog.read_shipment_identity_index() AS result',
        );
        summary.rpc = {
          list: {
            total: list.total,
            counts: list.counts,
            includeAbsent: list.includeAbsent,
            absentTickets: list.absentTickets,
            absentItems: list.absentItems,
            rows: list.rows.length,
            allPresent: list.rows.every((row: Record<string, unknown>) => row.presentInLatestRead === true),
            summaryIsNamesOnly: list.rows.every((row: Record<string, unknown>) =>
              Array.isArray(row.productSummary)
              && row.productSummary.every((entry: unknown) => typeof entry === 'string')),
            noSourceUpdatedAt: list.rows.every((row: Record<string, unknown>) => !('sourceUpdatedAt' in row)),
          },
          listAll: { total: listAll.total, rows: listAll.rows.length },
          detail: {
            items: detail.items.length,
            missingItems: detail.missingItems.length,
            present: detail.shipment.presentInLatestRead,
            identity: detail.shipment.identityStatus,
            latestReadAt: detail.latestReadAt,
          },
          productLinks: {
            total: productLink.total,
            ticketNos: productLink.rows.map((row: Record<string, unknown>) => row.ticketNo),
          },
          identityIndex: identityIndex.length,
        };

        expect(list.total).toBe(parsed.tickets.length);
        expect(list.rows.length).toBe(parsed.tickets.length);
        expect(list.absentTickets).toBe(0);
        expect(list.absentItems).toBe(0);
        expect(list.counts.inTransit + list.counts.partial + list.counts.arrivedPendingShelving
          + list.counts.arrived + list.counts.unknown).toBe(parsed.tickets.length);
        expect(summary.rpc?.list.allPresent).toBe(true);
        expect(summary.rpc?.list.summaryIsNamesOnly).toBe(true);
        expect(summary.rpc?.list.noSourceUpdatedAt).toBe(true);
        expect(listAll.rows.length).toBe(parsed.tickets.length);
        expect(detail.items.length).toBeGreaterThan(0);
        expect(detail.missingItems.length).toBe(0);
        expect(detail.shipment.presentInLatestRead).toBe(true);
        expect(productLink.total).toBeGreaterThan(0);
        expect(identityIndex.length).toBe(parsed.tickets.length);
        expect(differences).toEqual([]);
      } finally {
        await app.end();
      }
      await owner.query('ROLLBACK');
    } finally {
      await owner.end();
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'reconciliation.json'), `${JSON.stringify({
      checkedAt: new Date().toISOString(),
      differences,
      summary,
    }, null, 2)}\n`);
  }, 180_000);
});
