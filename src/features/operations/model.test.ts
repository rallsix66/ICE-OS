import { describe, expect, it } from 'vitest';
import {
  buildOperationHref,
  DEFAULT_OPERATION_QUERY,
  formatOperationTime,
  operationActionLabel,
  operationActionTone,
  operationCategoryCountLabel,
  operationCategoryTotal,
  operationDateBounds,
  operationDetailView,
  operationItemChunks,
  operationPageRange,
  operationResultText,
  operationTicketHref,
  parseOperationSearchParams,
} from './model';
import type { OperationRecordDto } from './types';

function record(partial: Partial<OperationRecordDto>): OperationRecordDto {
  return {
    id: 'r1',
    at: '2026-11-16T03:40:24.387Z',
    category: 'catalog',
    action: 'item_revision',
    actorId: '11111111-1111-4111-8111-111111111101',
    actorName: 'ISOLATED TEST admin',
    objectKind: '商品',
    objectTitle: '商品资料',
    objectRef: 'WM0001',
    itemId: null,
    ticketId: null,
    batchId: null,
    iceCode: null,
    externalSku: null,
    ticketNo: null,
    market: null,
    detail: {},
    ...partial,
  };
}

const batchRecord = record({
  id: 'src_batch:40b3c87c-f399-444a-9d35-fb7964f82e56',
  action: 'source_batch_applied',
  objectTitle: '来源资料批次',
  objectRef: '40b3c87c-f399-444a-9d35-fb7964f82e56',
  batchId: '40b3c87c-f399-444a-9d35-fb7964f82e56',
  detail: {
    status: 'partial',
    counts: { updated: 1, unchanged: 26, needsReview: 101, failed: 0, missing: 0, businessRows: 133 },
    capturedAt: '2026-11-11T10:12:58.552Z',
    receivedAt: '2026-11-16T03:40:24.387Z',
    snapshotKey: '7c9a77bd197ed8a646ad0623989ffee98634fc3a7a4e6409cfa062adac9ef4f6',
    results: [
      {
        itemId: 'b47da6ed-375c-48b7-b54d-9a3129f445cd',
        iceCode: 'WM0049',
        nameCn: 'ICE LERSKIN 多效提亮防晒喷雾',
        itemRevision: 3,
        action: 'needs_review',
        reasonText: '来源单元格为公式错误值，未采用',
        changes: [
          { fieldKey: 'nameCn', beforeRaw: 'ICE LERSKIN 防晒喷雾升级版150ml', afterRaw: 'ICE LERSKIN 多效提亮防晒喷雾', kind: 'update' },
        ],
      },
    ],
  },
});

const rebindRecord = record({
  category: 'inventory',
  action: 'inventory_rebind',
  objectKind: '库存对应',
  objectTitle: '喜运达MY仓',
  objectRef: '1 条来源 SKU',
  detail: {
    applied: 1,
    skipped: [],
    items: [{
      externalSku: '757577983037',
      unit: '个',
      version: 2,
      mappingId: 'a6249fc6-e54f-4587-ad6f-fbb4af6d9a76',
      effectiveAt: 'next_batch',
      warehouseName: '喜运达MY仓',
      itemId: 'eeccfdee-a041-4539-918b-8e0441b1bf52',
      iceCode: 'WM0069',
      nameCn: 'ICE LERSKIN 护发精油 (无花果) 80ml-粉色-泰国特供版',
      previousItemId: 'b3366ce1-db05-4fb7-b0cb-675d3de98aad',
      previousIceCode: 'WM0027',
      previousNameCn: 'ICE LERSKIN护发精油-茉莉',
    }],
  },
});

const manualRecord = record({
  category: 'shipment',
  action: 'shipment_manual_correction',
  objectKind: '货票',
  objectTitle: 'POKNZX026710',
  ticketNo: 'POKNZX026710',
  ticketId: '27d6c5cb-f691-410c-ab12-e45e0f21a248',
  detail: {
    action: 'apply',
    revision: 1,
    manualStatus: 'in_transit',
    manualShelvedQuantity: null,
    previousManualStatus: null,
    receivedQuantity: 0,
    remainingQuantity: 11440,
    actorName: 'ISOLATED TEST admin',
  },
});

const groupingRecord = record({
  category: 'shipment',
  action: 'shipment_grouping_decision',
  objectKind: '货票',
  objectTitle: 'POKNZX027485',
  detail: {
    kind: 'merge',
    decision: 'keep_separate',
    status: 'resolved',
    resolvedAt: '2026-11-11T05:43:18.832Z',
    tickets: [{ ticketNo: 'POKNZX027485', market: '越南', itemCount: 11 }],
    affectedProducts: ['CHIC PEAK 果冻定妆喷雾 58g'],
  },
});

describe('操作记录：URL 解析与链接', () => {
  it('默认值：全部类别、全部账号、无日期、无搜索、第 1 页', () => {
    expect(parseOperationSearchParams(new URLSearchParams())).toEqual(DEFAULT_OPERATION_QUERY);
  });

  it('解析合法筛选并保留分页', () => {
    const query = parseOperationSearchParams(new URLSearchParams(
      'cat=shipment&actor=11111111-1111-4111-8111-111111111101&from=2026-11-10&to=2026-11-16&q=%20POKNZX%20&page=3',
    ));
    expect(query).toEqual({
      category: 'shipment',
      actor: '11111111-1111-4111-8111-111111111101',
      from: '2026-11-10',
      to: '2026-11-16',
      q: 'POKNZX',
      page: 3,
    });
  });

  it('非法类别/账号/日期/页码按默认处理，不猜值', () => {
    const query = parseOperationSearchParams(new URLSearchParams('cat=other&actor=abc&from=2026-02-30&to=not-a-date&page=-5'));
    expect(query.category).toBe('all');
    expect(query.actor).toBe('');
    expect(query.from).toBe('');
    expect(query.to).toBe('');
    expect(query.page).toBe(1);
  });

  it('日期边界按 +08 自然日：结束日不含次日 00:00', () => {
    expect(operationDateBounds({ from: '2026-11-10', to: '2026-11-10' })).toEqual({
      from: '2026-11-10T00:00:00+08:00',
      to: '2026-11-11T00:00:00+08:00',
      invalid: false,
    });
    expect(operationDateBounds({ from: '', to: '2026-11-16' })).toEqual({
      from: null,
      to: '2026-11-17T00:00:00+08:00',
      invalid: false,
    });
  });

  it('开始晚于结束：返回 invalid 且不给边界（页面提示后不查询）', () => {
    expect(operationDateBounds({ from: '2026-11-16', to: '2026-11-10' })).toEqual({ from: null, to: null, invalid: true });
  });

  it('构造链接省略默认值，并保留筛选与页码', () => {
    expect(buildOperationHref({ ...DEFAULT_OPERATION_QUERY })).toBe('/dashboard/operations');
    const href = buildOperationHref(
      { category: 'inventory', actor: '11111111-1111-4111-8111-111111111101', from: '2026-10-01', to: '', q: '757577983037', page: 2 },
      { page: 3 },
    );
    expect(href).toContain('cat=inventory');
    expect(href).toContain('actor=11111111-1111-4111-8111-111111111101');
    expect(href).toContain('from=2026-10-01');
    expect(href).toContain('q=757577983037');
    expect(href).toContain('page=3');
    expect(parseOperationSearchParams(new URLSearchParams(href.split('?')[1]))).toMatchObject({ category: 'inventory', page: 3 });
  });

  it('分页范围：越界页码收敛到末页，0 条不伪造第 1 条', () => {
    expect(operationPageRange(365, 50, 99)).toMatchObject({ page: 8, pageCount: 8, from: 351, to: 365, hasNext: false });
    expect(operationPageRange(365, 50, 1)).toMatchObject({ page: 1, from: 1, to: 50, hasPrev: false, hasNext: true });
    expect(operationPageRange(0, 50, 1)).toMatchObject({ page: 1, pageCount: 1, from: 0, to: 0 });
  });
});

describe('操作记录：计数语义', () => {
  it('全部业务 = 三类之和；缺一类视为没读到', () => {
    expect(operationCategoryTotal({ catalog: 152, inventory: 100, shipment: 113 })).toBe(365);
    expect(operationCategoryTotal({ catalog: 152, inventory: 100 })).toBeNull();
    expect(operationCategoryTotal(null)).toBeNull();
  });

  it('没读到显示「—」，真实 0 显示 0 条', () => {
    expect(operationCategoryCountLabel(null)).toBe('—');
    expect(operationCategoryCountLabel(0)).toBe('0 条');
    expect(operationCategoryCountLabel(152)).toBe('152 条');
  });
});

describe('操作记录：文案只用已保存字段', () => {
  it('动作中文名与色调', () => {
    expect(operationActionLabel('source_batch_applied')).toBe('来源资料采用');
    expect(operationActionLabel('inventory_rebind')).toBe('更换绑定（换绑商品对应）');
    expect(operationActionLabel('source_field_decision_revoked')).toBe('撤销字段人工口径');
    expect(operationActionLabel('duplicate_source_decision_revoked')).toBe('撤销来源行选择');
    expect(operationActionLabel('shipment_grouping_revoked')).toBe('撤销分合票人工决定');
    expect(operationActionLabel('unknown_action')).toBe('业务处理');
    expect(operationActionTone('disable_inventory_mapping')).toBe('red');
    expect(operationActionTone('inventory_rebind')).toBe('green');
    expect(operationActionTone('source_field_decision_revoked')).toBe('amber');
  });

  it('来源采用结果按回执计数与已写入明细生成，不把未写入行算成已更新', () => {
    const text = operationResultText(batchRecord);
    expect(text).toContain('已写入 1 款');
    expect(text).toContain('待核对 101 款');
    expect(text).toContain('失败 0 款');
    expect(text).toContain('无变化 26 款');
  });

  it('换绑结果写清本次确认条数、换商品条数与生效方式', () => {
    expect(operationResultText(rebindRecord)).toBe('本次确认 1 条商品对应，其中 1 条换了商品；下一批起生效。');
  });

  it('人工修正：状态用物流页同一套中文；未保存的累计上架写「未填写」不写 0', () => {
    expect(operationResultText(manualRecord)).toBe('人工修正：状态「运输中」；累计已上架 未填写；剩余 11440。');
  });

  it('分合票决定用物流页同一套结论文案', () => {
    expect(operationResultText(groupingRecord)).toBe('合票复核结论：仍然分开。');
  });

  it('已撤销的来源资料选择不写成“没有真实人工确认”，只说明被撤销', () => {
    const text = operationResultText(record({
      action: 'duplicate_source_decision',
      detail: {
        state: 'superseded',
        chosenRowNumber: 128,
        supersededAt: '2026-11-10T06:44:50.408Z',
        note: '撤销脚本代选：无真实人工确认记录，恢复待人工确认',
      },
    }));
    expect(text).toContain('已于 2026-11-10 14:44:50 被撤销');
    expect(text).toContain('原决定仍保留');
    expect(text).not.toContain('没有真实人工确认');
  });

  it('撤销字段口径：写明撤销的字段与已保存说明', () => {
    const text = operationResultText(record({
      action: 'source_field_decision_revoked',
      detail: {
        fieldKey: 'unitWeight',
        originalAction: 'override',
        decidedAt: '2026-11-10T04:36:38.362Z',
        revokedAt: '2026-11-10T06:44:50.408Z',
        revokedNote: '撤销固定 0.05 override：改为按来源列解释重量',
      },
    }));
    expect(text).toContain('撤销「单件重量」的人工口径');
    expect(text).toContain('改为按来源列解释重量');
  });

  it('撤销来源行选择分「撤销」与「被后续选择替代」两种真实状态', () => {
    const revoked = operationResultText(record({
      action: 'duplicate_source_decision_revoked',
      detail: { chosenRowNumber: 132, revokedByAccount: true },
    }));
    expect(revoked).toContain('撤销来源第 132 行选择');
    const replaced = operationResultText(record({
      action: 'duplicate_source_decision_revoked',
      detail: { chosenRowNumber: 132, revokedByAccount: false },
    }));
    expect(replaced).toContain('已被后续选择替代');
  });

  it('商品资料首版明确写「没有上一版本」', () => {
    expect(operationResultText(record({ action: 'item_baseline', detail: { revision: 1, previousRevision: null } })))
      .toContain('没有上一版本');
  });

  it('商品资料修改摘要按已保存差异计数（删除也计入）', () => {
    const text = operationResultText(record({
      action: 'item_revision',
      detail: {
        revision: 3,
        previousRevision: 2,
        reason: '撤销脚本代选，恢复待人工确认',
        changes: [{ fieldKey: 'barcode', changeKind: 'removed', beforeRaw: '757577407359', afterRaw: null }],
      },
    }));
    expect(text).toContain('第 3 版');
    expect(text).toContain('删除 1 项');
  });

  it('时间固定按 Asia/Shanghai 显示', () => {
    expect(formatOperationTime('2026-11-10T06:44:50.408Z')).toBe('2026-11-10 14:44:50');
    expect(formatOperationTime(null)).toBe('');
  });

  it('货票入口：有货票 id 直接开详情，否则按货票号搜索', () => {
    expect(operationTicketHref({ ticketId: '27d6c5cb-f691-410c-ab12-e45e0f21a248', ticketNo: 'X' }))
      .toBe('/dashboard/in-transit?ticket=27d6c5cb-f691-410c-ab12-e45e0f21a248');
    expect(operationTicketHref({ ticketId: null, ticketNo: 'POKNZX027675' }))
      .toBe('/dashboard/in-transit?q=POKNZX027675');
    expect(operationTicketHref({ ticketId: null, ticketNo: null })).toBeNull();
  });
});

describe('操作记录：展开依据', () => {
  it('来源采用：商品变化与入口在同一明细里，批次入口名称准确且不再跳最新批次', () => {
    const view = operationDetailView(batchRecord);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].changes).toContainEqual({
      field: '中文名称',
      before: 'ICE LERSKIN 防晒喷雾升级版150ml',
      after: 'ICE LERSKIN 多效提亮防晒喷雾',
      kind: 'modified',
    });
    expect(view.items[0].productHref).toBe('/dashboard/catalog/b47da6ed-375c-48b7-b54d-9a3129f445cd');
    expect(view.links.map((link) => link.href)).toContain('/dashboard/catalog/sources');
    expect(view.links.map((link) => link.href)).not.toContain('/dashboard/sync?panel=product-update');
    expect(view.sources.map((source) => source.label)).toContain('快照哈希');
  });

  it('换绑：上一版商品取被替代行，并给商品与库存入口', () => {
    const view = operationDetailView(rebindRecord);
    expect(view.items[0].changes[0].before).toContain('原商品 WM0027');
    expect(view.items[0].changes[0].after).toContain('现商品 WM0069');
    expect(view.items[0].productHref).toBe('/dashboard/catalog/eeccfdee-a041-4539-918b-8e0441b1bf52');
    expect(view.items[0].inventoryHref).toBe('/dashboard/inventory?q=757577983037&source=overseas');
    expect(view.notes.join(' ')).toContain('不是当前商品资料');
  });

  it('人工修正：修正前状态与累计上架如实写「未记录 / 未提供」', () => {
    const view = operationDetailView(manualRecord);
    const facts = Object.fromEntries(view.facts.map((fact) => [fact.label, fact.value]));
    expect(facts['修正前状态']).toBe('未记录');
    expect(facts['累计已上架']).toBe('未提供');
    expect(facts['剩余']).toBe('11440');
    expect(view.links.map((link) => link.href)).toContain('/dashboard/in-transit?ticket=27d6c5cb-f691-410c-ab12-e45e0f21a248');
  });

  it('分合票决定：列票号与入口，并说明不能反查具体操作人', () => {
    const view = operationDetailView(groupingRecord);
    expect(view.tickets[0].ticketNo).toBe('POKNZX027485');
    expect(view.tickets[0].href).toBe('/dashboard/in-transit?q=POKNZX027485');
    expect(view.notes.join(' ')).toContain('无法反查具体操作人');
  });

  it('首版修订：没有前值，不生成字段差异', () => {
    const view = operationDetailView(record({
      action: 'item_baseline',
      detail: { revision: 1, previousRevision: null, reason: 'accepted frozen baseline', changes: [] },
    }));
    const facts = Object.fromEntries(view.facts.map((fact) => [fact.label, fact.value]));
    expect(facts['上一版本']).toBe('无（首版）');
    expect(view.changes).toEqual([]);
    expect(view.notes.join(' ')).toContain('没有前值');
  });

  it('R1 删除字段：商品条码显示 757577407359 → 已移除，不再误判首版', () => {
    const view = operationDetailView(record({
      action: 'item_revision',
      iceCode: 'WM0073',
      itemId: '4a97ad8b-8bd9-4aaf-a48a-530ae130b68a',
      at: '2026-11-10T06:44:50.408Z',
      detail: {
        revision: 3,
        previousRevision: 2,
        declaredPreviousRevision: 2,
        reason: '撤销脚本代选，恢复待人工确认',
        changes: [{
          fieldKey: 'barcode',
          changeKind: 'removed',
          beforeRaw: '757577407359',
          afterRaw: null,
          beforePresent: true,
          afterPresent: false,
        }],
      },
    }));
    const facts = Object.fromEntries(view.facts.map((fact) => [fact.label, fact.value]));
    expect(view.changes[0]).toEqual({ field: '商品条码', before: '757577407359', after: '已移除', kind: 'removed' });
    expect(facts['上一版本']).toBe('第 2 版');
    expect(view.notes.join(' ')).not.toContain('首版');
    expect(view.notes.join(' ')).not.toContain('没有前值');
  });

  it('R1 新增字段显示「历史未保存」，已有键的空值显示「未填写」', () => {
    const view = operationDetailView(record({
      action: 'item_revision',
      detail: {
        revision: 4,
        previousRevision: 3,
        changes: [
          { fieldKey: 'factory', changeKind: 'added', beforeRaw: null, afterRaw: '广州圣宝兰生物科技有限公司', beforePresent: false, afterPresent: true },
          { fieldKey: 'barcode', changeKind: 'modified', beforeRaw: null, afterRaw: '757577407359', beforePresent: true, afterPresent: true },
        ],
      },
    }));
    expect(view.changes[0]).toMatchObject({ field: '生产工厂', before: '历史未保存', after: '广州圣宝兰生物科技有限公司', kind: 'added' });
    expect(view.changes[1]).toMatchObject({ field: '商品条码', before: '未填写', after: '757577407359', kind: 'modified' });
  });

  it('声明了上一版但历史行缺失：不伪造前值，也不写成首版', () => {
    const view = operationDetailView(record({
      action: 'item_revision',
      detail: { revision: 3, previousRevision: null, declaredPreviousRevision: 2, changes: [] },
    }));
    expect(view.notes.join(' ')).toContain('历史里找不到该版本');
    expect(view.notes.join(' ')).not.toContain('首版没有上一版本');
  });

  it('R3 批次明细不截断：94 款全部进入展开模型，可分段展示', () => {
    const results = Array.from({ length: 94 }, (_, index) => ({
      itemId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      iceCode: index === 40 ? 'WM0054' : `WM${String(index).padStart(4, '0')}`,
      nameCn: `商品 ${index + 1}`,
      itemRevision: 2,
      action: 'update',
      reasonText: '来源首轮基线',
      changes: index === 40 ? [{ fieldKey: 'factory', beforeRaw: null, afterRaw: '广州圣宝兰生物科技有限公司', kind: 'initial_baseline' }] : [],
    }));
    const view = operationDetailView(record({
      action: 'source_batch_applied',
      objectTitle: '来源资料批次',
      detail: { status: 'partial', counts: { businessRows: 131 }, results },
    }));
    expect(view.items).toHaveLength(94);
    expect(view.items[40].title).toBe('商品 41');
    expect(view.items[40].changes[0]).toMatchObject({ field: '生产工厂', before: '历史未保存', after: '广州圣宝兰生物科技有限公司', kind: 'added' });
    const chunks = operationItemChunks(view.items);
    expect(chunks).toHaveLength(5);
    expect(chunks.map((chunk) => chunk.length)).toEqual([20, 20, 20, 20, 14]);
    expect(chunks[4][13].key).toBe(view.items[93].key);
  });

  it('撤销字段口径：保留原决定时间，撤销说明与请求号分开展示', () => {
    const view = operationDetailView(record({
      action: 'source_field_decision_revoked',
      detail: {
        fieldKey: 'unitWeight',
        originalAction: 'override',
        decidedAt: '2026-11-10T04:36:38.362Z',
        revokedAt: '2026-11-10T06:44:50.408Z',
        revokedNote: '撤销固定 0.05 override：改为按来源列解释重量',
        reason: '用户确认：单个重量取 O 列 0.05/件',
        requestId: '498fcd8c-b81f-4e2f-ba56-fe3232961dc3',
      },
    }));
    const facts = Object.fromEntries(view.facts.map((fact) => [fact.label, fact.value]));
    expect(facts['原决定时间']).toBe('2026-11-10 12:36:38');
    expect(facts['撤销时间']).toBe('2026-11-10 14:44:50');
    expect(view.notes.join(' ')).toContain('已保存撤销说明');
    expect(view.sources.map((source) => source.label)).toContain('请求号');
  });
});
