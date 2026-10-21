"""导出以商品库为主的 CSV / HTML。"""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any


def export_master_centric_csv(bundle: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        'master_row_index',
        'ice_code',
        'barcode',
        'name_cn',
        'spec',
        'in_stock_bigseller_count',
        'review_tier',
        'review_reasons',
        'flags_union',
        'bigseller_skus',
        'bigseller_qty',
        'bigseller_warehouses',
    ]
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in bundle.get('rows') or []:
            links = row.get('bigseller_links') or []
            w.writerow(
                {
                    'master_row_index': row.get('master_row_index'),
                    'ice_code': row.get('ice_code'),
                    'barcode': row.get('barcode'),
                    'name_cn': row.get('name_cn'),
                    'spec': row.get('spec'),
                    'in_stock_bigseller_count': row.get('in_stock_bigseller_count'),
                    'review_tier': row.get('review_tier'),
                    'review_reasons': '；'.join(row.get('review_reasons') or []),
                    'flags_union': ';'.join(row.get('flags_union') or []),
                    'bigseller_skus': ';'.join(l.get('sku') or '' for l in links),
                    'bigseller_qty': ';'.join(str(l.get('available_qty') or '') for l in links),
                    'bigseller_warehouses': ';'.join(l.get('warehouse') or '' for l in links),
                }
            )


def export_master_centric_html(bundle: dict[str, Any], path: Path) -> None:
    data_json = json.dumps(bundle, ensure_ascii=False, separators=(',', ':'))
    html = _TEMPLATE.replace('__DATA__', data_json)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding='utf-8')


_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>P0-03 商品库为主 · 有库存 BigSeller 核对</title>
  <style>
    body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #f4f5f7; color: #1a1d21; }
    header { background: #fff; border-bottom: 1px solid #e2e6ea; padding: 12px 16px; position: sticky; top: 0; z-index: 5; }
    h1 { margin: 0 0 6px; font-size: 17px; }
    .meta { color: #5c6570; font-size: 12px; }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .stat { background: #f4f5f7; border-radius: 6px; padding: 6px 10px; min-width: 100px; }
    .stat b { font-size: 16px; display: block; }
    main { padding: 12px 16px 32px; max-width: 1400px; margin: 0 auto; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    input, select, button { padding: 6px 8px; border: 1px solid #e2e6ea; border-radius: 6px; font: inherit; }
    button.primary { background: #0f6bdc; color: #fff; border-color: #0f6bdc; }
    .tabs .tab { margin-right: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid #e2e6ea; background: #fff; cursor: pointer; }
    .tab.active { background: #e8f1fd; border-color: #b6d4fe; color: #0f6bdc; font-weight: 600; }
    .list { background: #fff; border: 1px solid #e2e6ea; border-radius: 8px; max-height: calc(100vh - 280px); overflow: auto; }
    .row { border-bottom: 1px solid #eee; padding: 6px 10px; font-size: 12px; }
    .row:nth-child(even) { background: #fafbfc; }
    .tier-needs_manual { border-left: 3px solid #b91c1c; }
    .tier-review_light { border-left: 3px solid #b45309; }
    .tier-likely_ok { border-left: 3px solid #15803d; }
    .tier-no_in_stock_bigseller { border-left: 3px solid #94a3b8; }
    .muted { color: #5c6570; }
    details summary { cursor: pointer; color: #0f6bdc; }
  </style>
</head>
<body>
<header>
  <h1>商品库为主 · 有库存 BigSeller 核对</h1>
  <div class="meta">仅统计整仓可用&gt;0、非组合 SKU 的 BigSeller 行与主资料关联；仍不自动确认映射。</div>
  <div class="stats" id="stats"></div>
</header>
<main>
  <div class="toolbar">
    <input type="search" id="q" placeholder="货号 / 条码 / 品名" />
    <select id="tier"><option value="">全部层级</option>
      <option value="needs_manual">必须人工</option>
      <option value="review_light">建议复核</option>
      <option value="likely_ok">单条有库存且无冲突</option>
      <option value="no_in_stock_bigseller">无有库存 BigSeller</option>
    </select>
    <button type="button" id="exportCsv" class="primary">导出当前筛选 CSV</button>
  </div>
  <div class="tabs" id="tabs"></div>
  <div class="list" id="list"></div>
</main>
<script>
const DATA = __DATA__;
const s = DATA.summary || {};
const tierLabel = {
  needs_manual: '必须人工',
  review_light: '建议复核',
  likely_ok: '可无冲突单条匹配',
  no_in_stock_bigseller: '无有库存 BS',
};
function renderStats() {
  const el = document.getElementById('stats');
  const tc = s.tier_counts || {};
  el.innerHTML = [
    ['主资料行数', s.master_row_count],
    ['有库存 BS 关联', s.masters_with_in_stock_bigseller],
    ['需人工(含建议复核)', s.human_review_master_rows],
    ['必须人工', s.human_review_master_strict],
    ['建议复核', s.human_review_master_light],
    ['可无冲突单条', s.likely_ok_unique_in_stock],
    ['无有库存 BS', s.masters_no_in_stock_bigseller_link],
    ['有库存但未入主资料', s.orphan_in_stock_bigseller_rows],
  ].map(([k,v]) => `<div class="stat"><span class="muted">${k}</span><b>${v ?? '—'}</b></div>`).join('');
}
function tabFilter(tab) {
  if (tab === 'manual') return r => r.review_tier === 'needs_manual' || r.review_tier === 'review_light';
  if (tab === 'orphan') return null;
  if (tab === 'ok') return r => r.review_tier === 'likely_ok';
  return () => true;
}
let activeTab = 'manual';
function renderTabs() {
  const tabs = [
    ['manual', '需核对'],
    ['all', '全部主资料'],
    ['ok', '无冲突单条'],
    ['orphan', '有库存未匹配'],
  ];
  document.getElementById('tabs').innerHTML = tabs.map(([id, label]) =>
    `<button type="button" class="tab ${activeTab===id?'active':''}" data-tab="${id}">${label}</button>`
  ).join('');
  document.querySelectorAll('.tab').forEach(btn => btn.onclick = () => { activeTab = btn.dataset.tab; renderTabs(); renderList(); });
}
function rowHtml(r) {
  const links = (r.bigseller_links || []).map(l =>
    `${l.warehouse || ''} · ${l.sku || ''} · 可用${l.available_qty || ''}`
  ).join(' | ');
  const reasons = (r.review_reasons || []).join('；');
  return `<div class="row tier-${r.review_tier}">
    <div><b>${r.ice_code || '—'}</b> · ${r.barcode || '—'} · ${r.name_cn || ''} <span class="muted">${tierLabel[r.review_tier]||r.review_tier}</span></div>
    <div class="muted">${reasons}</div>
    ${links ? `<details><summary>有库存 BigSeller (${r.in_stock_bigseller_count})</summary><div>${links}</div></details>` : ''}
  </div>`;
}
function orphanHtml(o) {
  return `<div class="row tier-needs_manual">
    <div><b>${o.sku || '—'}</b> · ${o.warehouse || ''} · 可用 ${o.available_qty || ''}</div>
    <div class="muted">${o.name || ''} · ${(o.flags||[]).join('; ')}</div>
  </div>`;
}
function renderList() {
  const q = (document.getElementById('q').value || '').trim().toLowerCase();
  const tier = document.getElementById('tier').value;
  const list = document.getElementById('list');
  if (activeTab === 'orphan') {
    let rows = DATA.orphan_in_stock_bigseller || [];
    if (q) rows = rows.filter(o => JSON.stringify(o).toLowerCase().includes(q));
    list.innerHTML = rows.length ? rows.map(orphanHtml).join('') : '<div class="row muted">无</div>';
    return;
  }
  let rows = DATA.rows || [];
  const tf = tabFilter(activeTab);
  if (tf) rows = rows.filter(tf);
  if (tier) rows = rows.filter(r => r.review_tier === tier);
  if (q) {
    rows = rows.filter(r => [r.ice_code, r.barcode, r.name_cn, r.spec].join(' ').toLowerCase().includes(q));
  }
  list.innerHTML = rows.length ? rows.map(rowHtml).join('') : '<div class="row muted">无匹配行</div>';
}
document.getElementById('q').oninput = renderList;
document.getElementById('tier').onchange = renderList;
document.getElementById('exportCsv').onclick = () => {
  const blob = new Blob([JSON.stringify({summary: DATA.summary, rows: DATA.rows}, null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'P0-03-master-review-export.json';
  a.click();
};
renderStats();
renderTabs();
renderList();
</script>
</body>
</html>
"""
