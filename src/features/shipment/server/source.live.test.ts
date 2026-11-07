import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readShipmentSource, shipmentSourceConfig } from './source';
import { parseShipmentSnapshot } from './parse';

/**
 * 真实来源探针（需要本机 lark-cli 与飞书授权）：
 * 读取真实「物流情况表」→ 解析 → 把期望结果写到 .local 证据目录，供后续对账脚本使用。
 */
describe('live feishu source probe', () => {
  it('读取真实来源并解析', async () => {
    const config = shipmentSourceConfig();
    expect(config.configured).toBe(true);
    const raw = await readShipmentSource();
    const parsed = parseShipmentSnapshot(raw);
    const itemCount = parsed.tickets.reduce((sum, ticket) => sum + ticket.items.length, 0);
    const byClass: Record<string, number> = {};
    for (const ticket of parsed.tickets) byClass[ticket.statusClass] = (byClass[ticket.statusClass] ?? 0) + 1;

    const evidenceDir = path.join(process.cwd(), '.local', 'shipment-v1-20261030');
    mkdirSync(evidenceDir, { recursive: true });
    const expectation = {
      capturedAt: new Date().toISOString(),
      config,
      collection: {
        docTitle: parsed.collection.docTitle,
        docToken: parsed.collection.docToken,
        sheetId: parsed.collection.sheetId,
        sheetTitle: parsed.collection.sheetTitle,
        revision: parsed.collection.revision,
        documentEditedAt: parsed.collection.documentEditedAt,
        gridRows: parsed.collection.gridRows,
        lastNonEmptyRow: parsed.collection.lastNonEmptyRow,
        rawContentHash: parsed.collection.rawContentHash,
        headers: parsed.collection.headers,
        mergeCount: parsed.collection.merges.length,
      },
      totals: { tickets: parsed.tickets.length, items: itemCount, byClass },
      tickets: parsed.tickets.map((ticket) => ({
        ticketKey: ticket.ticketKey,
        ticketNo: ticket.ticketNo,
        sourceRowStart: ticket.sourceRowStart,
        sourceRowEnd: ticket.sourceRowEnd,
        market: ticket.market,
        customsMethod: ticket.customsMethod,
        waybillsText: ticket.waybillsText,
        purchaseOrder: ticket.purchaseOrder,
        transportText: ticket.transportText,
        arrivalText: ticket.arrivalText,
        vessel: ticket.vessel,
        dispatchedText: ticket.dispatchedText,
        statusClass: ticket.statusClass,
        receivedBasis: ticket.receivedBasis,
        items: ticket.items.map((item) => ({
          itemKey: item.itemKey,
          productNameRaw: item.productNameRaw,
          shippedQuantity: item.shippedQuantity,
          sourceRow: item.sourceRow,
          sourceNote: item.sourceNote,
        })),
      })),
    };
    writeFileSync(path.join(evidenceDir, 'expected-snapshot.json'), `${JSON.stringify(expectation, null, 1)}\n`, 'utf8');
    // 完整入参（供 .local 下的真实入库/对账脚本使用；与 actions 传给 RPC 的结构一致）。
    writeFileSync(path.join(evidenceDir, 'ingest-payload.json'), `${JSON.stringify(parsed)}\n`, 'utf8');
    console.log(JSON.stringify({ totals: expectation.totals, revision: expectation.collection.revision }, null, 1));
    expect(parsed.tickets.length).toBeGreaterThan(0);
  }, 120_000);
});
