import { describe, expect, it } from 'vitest';
import {
  buildInventoryListHref,
  buildInventorySnapshotHref,
  parseInventorySearchParams,
  snapshotItemText,
  snapshotQuantityText,
  snapshotUnitText,
  snapshotVersionText,
  snapshotViewedBatchId,
} from './model';

const WAREHOUSE = '55aa957a-b213-42ea-8c39-c70cc447439d';
const BATCH_A = '13dd11d1-54fa-45c5-95ff-2f3cfa85f1e3';
const BATCH_B = 'a94b8e5c-9b68-4330-892a-b6c31645312b';

function parse(query: string) {
  return parseInventorySearchParams(new URLSearchParams(query));
}

describe('历史快照 query 解析', () => {
  it('解析快照参数，保留库存列表筛选', () => {
    const state = parse(
      `q=WM0080&warehouse=${WAREHOUSE}&market=TH&view=product&source=overseas&page=3&sort=name&dir=desc`
      + `&snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}&snapQ=757577407458&snapPage=2&snapBPage=3`,
    );
    expect(state.q).toBe('WM0080');
    expect(state.warehouse).toBe(WAREHOUSE);
    expect(state.market).toBe('TH');
    expect(state.view).toBe('product');
    expect(state.source).toBe('overseas');
    expect(state.page).toBe(3);
    expect(state.snapshot).toBe(true);
    expect(state.snapWarehouse).toBe(WAREHOUSE);
    expect(state.snapBatch).toBe(BATCH_A);
    expect(state.snapQ).toBe('757577407458');
    expect(state.snapPage).toBe(2);
    expect(state.snapBPage).toBe(3);
  });

  it('非法仓库/批次 UUID 与越界页码回退，不伪造快照条件', () => {
    const state = parse('snap=1&snapWarehouse=not-a-uuid&snapBatch=../../x&snapPage=0&snapBPage=0&snapQ=%20%20');
    expect(state.snapshot).toBe(true);
    expect(state.snapWarehouse).toBe('');
    expect(state.snapBatch).toBe('');
    expect(state.snapPage).toBe(1);
    expect(state.snapBPage).toBe(1);
    expect(state.snapQ).toBe('');
  });

  it('没有 snap=1 时不是快照视图（旧链接不受影响）', () => {
    expect(parse('q=ICE&warehouse=all').snapshot).toBe(false);
  });
});

describe('历史快照链接', () => {
  it('进入快照保留库存筛选，并写入快照参数', () => {
    const href = buildInventorySnapshotHref(
      {
        q: 'WM0080',
        warehouse: WAREHOUSE,
        market: 'TH',
        view: 'product',
        source: 'overseas',
        page: 2,
        sort: 'name',
        sortDir: 'desc',
      },
      { snapWarehouse: WAREHOUSE, snapBatch: BATCH_A, snapQ: '757577407458', snapPage: 1 },
    );
    const url = new URL(href, 'http://127.0.0.1');
    expect(url.pathname).toBe('/dashboard/inventory');
    expect(url.searchParams.get('q')).toBe('WM0080');
    expect(url.searchParams.get('warehouse')).toBe(WAREHOUSE);
    expect(url.searchParams.get('market')).toBe('TH');
    expect(url.searchParams.get('view')).toBe('product');
    expect(url.searchParams.get('source')).toBe('overseas');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('sort')).toBe('name');
    expect(url.searchParams.get('dir')).toBe('desc');
    expect(url.searchParams.get('snap')).toBe('1');
    expect(url.searchParams.get('snapWarehouse')).toBe(WAREHOUSE);
    expect(url.searchParams.get('snapBatch')).toBe(BATCH_A);
    expect(url.searchParams.get('snapQ')).toBe('757577407458');
    expect(url.searchParams.get('snapPage')).toBeNull();
  });

  it('不携带 item/row/pending，避免进入快照时重开库存详情或待处理弹窗', () => {
    const state = parse(`item=${BATCH_A}&row=bigseller:wh:sku&pending=open`);
    const href = buildInventorySnapshotHref(state);
    expect(href).not.toContain('item=');
    expect(href).not.toContain('row=');
    expect(href).not.toContain('pending=');
    expect(href).toBe('/dashboard/inventory?snap=1');
  });

  it('切换批次保留来源 SKU 搜索；翻页保留批次与搜索', () => {
    const state = parse(`snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}&snapQ=757577407458&snapPage=2`);
    const nextBatch = buildInventorySnapshotHref(state, { snapBatch: BATCH_B, snapPage: 1 });
    const nextBatchUrl = new URL(nextBatch, 'http://127.0.0.1');
    expect(nextBatchUrl.searchParams.get('snapBatch')).toBe(BATCH_B);
    expect(nextBatchUrl.searchParams.get('snapQ')).toBe('757577407458');
    expect(nextBatchUrl.searchParams.get('snapPage')).toBeNull();
    expect(nextBatchUrl.searchParams.get('snapWarehouse')).toBe(WAREHOUSE);

    const nextPage = buildInventorySnapshotHref(state, { snapPage: 3 });
    const nextPageUrl = new URL(nextPage, 'http://127.0.0.1');
    expect(nextPageUrl.searchParams.get('snapBatch')).toBe(BATCH_A);
    expect(nextPageUrl.searchParams.get('snapQ')).toBe('757577407458');
    expect(nextPageUrl.searchParams.get('snapPage')).toBe('3');
  });

  it('区分「未指定批次列表页」与「明确第一页」', () => {
    // 未指定：0，页面按所选批次自动定位。
    const auto = parse(`snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}`);
    expect(auto.snapBPage).toBe(0);
    expect(new URL(buildInventorySnapshotHref(auto), 'http://127.0.0.1').searchParams.get('snapBPage')).toBeNull();

    // 明确第一页：保留 snapBPage=1，页面必须回到第 1 页（不能被批次位置拉回）。
    const first = parse(`snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}&snapBPage=1`);
    expect(first.snapBPage).toBe(1);
    const firstHref = new URL(buildInventorySnapshotHref(first), 'http://127.0.0.1');
    expect(firstHref.searchParams.get('snapBPage')).toBe('1');
    expect(firstHref.searchParams.get('snapBatch')).toBe(BATCH_A);

    // 明确第 2 页同理。
    const second = parse(`snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}&snapBPage=2`);
    expect(second.snapBPage).toBe(2);
    expect(new URL(buildInventorySnapshotHref(second), 'http://127.0.0.1').searchParams.get('snapBPage')).toBe('2');
  });

  it('批次列表翻页保留已选批次与搜索，并写入当前列表页（含第 1 页）', () => {
    const state = parse(`snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}&snapQ=757577407458&snapPage=2`);
    expect(state.snapBPage).toBe(0);
    const firstPage = buildInventorySnapshotHref(state, { snapBPage: 1 });
    const firstPageUrl = new URL(firstPage, 'http://127.0.0.1');
    expect(firstPageUrl.searchParams.get('snapBPage')).toBe('1');
    expect(firstPageUrl.searchParams.get('snapBatch')).toBe(BATCH_A);

    const older = buildInventorySnapshotHref(state, { snapBPage: 2 });
    const olderUrl = new URL(older, 'http://127.0.0.1');
    expect(olderUrl.searchParams.get('snapBPage')).toBe('2');
    expect(olderUrl.searchParams.get('snapBatch')).toBe(BATCH_A);
    expect(olderUrl.searchParams.get('snapQ')).toBe('757577407458');
    expect(olderUrl.searchParams.get('snapPage')).toBe('2');
    expect(olderUrl.searchParams.get('snapWarehouse')).toBe(WAREHOUSE);

    // 选批只换批次，仍停留在当前批次列表页。
    const picked = buildInventorySnapshotHref(state, { snapBatch: BATCH_B, snapBPage: 3 });
    const pickedUrl = new URL(picked, 'http://127.0.0.1');
    expect(pickedUrl.searchParams.get('snapBatch')).toBe(BATCH_B);
    expect(pickedUrl.searchParams.get('snapBPage')).toBe('3');
    expect(pickedUrl.searchParams.get('snapQ')).toBe('757577407458');
  });

  it('翻列表/明细页沿用页面实际查看的批次，而不是 URL 里可能为空的 snapBatch', () => {
    // 默认最新批次时 URL 没有 snapBatch，但详情已读到 latest；链接必须带 latest。
    expect(snapshotViewedBatchId(BATCH_A, '')).toBe(BATCH_A);
    expect(snapshotViewedBatchId(null, BATCH_B)).toBe(BATCH_B);
    expect(snapshotViewedBatchId(BATCH_A, BATCH_B)).toBe(BATCH_A);
    expect(snapshotViewedBatchId(null, '')).toBe('');
    const href = buildInventorySnapshotHref(
      parse(`snap=1&snapWarehouse=${WAREHOUSE}&snapQ=757577407458`),
      { snapBatch: snapshotViewedBatchId(BATCH_A, ''), snapQ: '757577407458', snapBPage: 2 },
    );
    const url = new URL(href, 'http://127.0.0.1');
    expect(url.searchParams.get('snapBatch')).toBe(BATCH_A);
    expect(url.searchParams.get('snapBPage')).toBe('2');
    expect(url.searchParams.get('snapQ')).toBe('757577407458');
  });

  it('清空快照搜索只清 snapQ，不改批次/仓库', () => {
    const state = parse(`snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}&snapQ=757577407458`);
    const href = buildInventorySnapshotHref(state, { snapQ: '', snapPage: 1 });
    const url = new URL(href, 'http://127.0.0.1');
    expect(url.searchParams.get('snapQ')).toBeNull();
    expect(url.searchParams.get('snapBatch')).toBe(BATCH_A);
    expect(url.searchParams.get('snapWarehouse')).toBe(WAREHOUSE);
  });

  it('返回当前库存：去掉快照参数，保留原库存筛选', () => {
    const state = parse(
      `q=WM0080&warehouse=${WAREHOUSE}&market=TH&view=product&source=overseas&page=2`
      + `&snap=1&snapWarehouse=${WAREHOUSE}&snapBatch=${BATCH_A}&snapQ=757577407458&snapPage=2`,
    );
    const back = buildInventoryListHref(state);
    const url = new URL(back, 'http://127.0.0.1');
    expect(url.searchParams.get('q')).toBe('WM0080');
    expect(url.searchParams.get('warehouse')).toBe(WAREHOUSE);
    expect(url.searchParams.get('market')).toBe('TH');
    expect(url.searchParams.get('view')).toBe('product');
    expect(url.searchParams.get('source')).toBe('overseas');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('snap')).toBeNull();
    expect(url.searchParams.get('snapBatch')).toBeNull();
    expect(url.searchParams.get('snapQ')).toBeNull();
  });
});

describe('历史快照展示口径', () => {
  it('真实零显示 0，来源缺失显示「未提供」', () => {
    expect(snapshotQuantityText(0)).toBe('0');
    expect(snapshotQuantityText(1494)).toBe('1,494');
    expect(snapshotQuantityText(null)).toBe('未提供');
    expect(snapshotQuantityText(undefined)).toBe('未提供');
    expect(snapshotQuantityText(Number.NaN)).toBe('未提供');
  });

  it('单位缺失显示「未提供」', () => {
    expect(snapshotUnitText('个')).toBe('个');
    expect(snapshotUnitText('  ')).toBe('未提供');
    expect(snapshotUnitText(null)).toBe('未提供');
  });

  it('商品归属用批次保存的货号与当时品名；未绑定单独说明', () => {
    const bound = snapshotItemText({ itemId: 'item-1', iceCode: 'WM0080', nameCn: 'CHICPEAK 唇泥' });
    expect(bound).toEqual({
      bound: true,
      title: 'WM0080 · CHICPEAK 唇泥',
      note: '历史归属按批次保存的对应关系',
    });
    const unbound = snapshotItemText({ itemId: null, iceCode: null, nameCn: null });
    expect(unbound.bound).toBe(false);
    expect(unbound.title).toBe('未绑定商品');
    expect(snapshotItemText({ itemId: 'item-2', iceCode: 'WM0098', nameCn: null }).title).toBe('WM0098');
  });

  it('映射版本与商品版本任一缺失写「未提供」', () => {
    expect(snapshotVersionText({ mappingVersion: 1, itemRevision: 2 })).toBe('映射 v1 · 商品版本 2');
    expect(snapshotVersionText({ mappingVersion: null, itemRevision: null }))
      .toBe('映射版本未提供 · 商品版本未提供');
  });
});
