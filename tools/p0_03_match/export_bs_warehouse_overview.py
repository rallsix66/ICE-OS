"""BigSeller 按仓库汇总总览（规则内/外、挂库、库存）。"""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from . import config as cfg
from .export_html import _bigseller_warehouses
from .master_centric import is_in_stock_bigseller_candidate, parse_available_qty
from .match_policy import bigseller_outside_reason, is_in_policy_candidate
from .models import SourceRow


def _is_bigseller(candidate: dict[str, Any]) -> bool:
    return (candidate.get('source') or {}).get('source_system') == cfg.SOURCE_BIGSELLER


def _linked_to_master(
    candidate: dict[str, Any],
    embedded_reviews: dict[str, dict[str, Any]] | None,
) -> bool:
    if 'review_state' in candidate:
        return candidate.get('selected_master') is not None
    if candidate.get('master_matches'):
        return True
    cid = candidate.get('candidate_id') or ''
    rev = (embedded_reviews or {}).get(cid) or {}
    return bool((rev.get('manual_master_row') or '').strip())


def _source_row_from_candidate(candidate: dict[str, Any]) -> SourceRow:
    src = candidate.get('source') or {}
    return SourceRow(
        source_system=src.get('source_system') or '',
        source_row_key=src.get('source_row_key') or '',
        scope=src.get('scope') or '',
        warehouse=src.get('warehouse'),
        external_sku_raw=src.get('external_sku_raw') or '',
        external_name=src.get('external_name') or '',
        sheet_name=src.get('sheet_name'),
        gtin_raw=src.get('gtin_raw'),
        available_qty=src.get('available_qty'),
        extra=dict(src.get('extra') or {}),
    )


def _warehouse_market_label(warehouse: str) -> str:
    if warehouse == cfg.TARGET_INVENTORY_WAREHOUSE:
        return cfg.DEE_WAREHOUSE_MARKET_LABEL
    if cfg.PH_WAREHOUSE_KEYWORD in (warehouse or ''):
        return '菲律宾仓'
    if '越南' in (warehouse or ''):
        return '越南仓'
    if '印尼' in (warehouse or ''):
        return '印尼仓'
    if '喜运达' in (warehouse or '') or 'MY' in (warehouse or '').upper():
        return '马来仓'
    return '其他'


def _warehouse_rule_label(warehouse: str) -> str:
    if warehouse == cfg.TARGET_INVENTORY_WAREHOUSE:
        return f'{cfg.DEE_WAREHOUSE_MARKET_LABEL}·ICE货号/匹配条码'
    if cfg.PH_WAREHOUSE_KEYWORD in (warehouse or ''):
        return '菲律宾仓·货号对G列'
    return '其他仓·匹配条码对H列'


def build_bs_warehouse_overview_rows(
    bundle: dict[str, Any],
    embedded_reviews: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    embedded_reviews = embedded_reviews or {}
    by_wh: dict[str, dict[str, Any]] = {}

    def bucket(wh: str) -> dict[str, Any]:
        if wh not in by_wh:
            by_wh[wh] = {
                'warehouse': wh,
                'market': _warehouse_market_label(wh),
                'match_rule': _warehouse_rule_label(wh),
                'bs_rows_total': 0,
                'in_stock_rows': 0,
                'in_stock_qty_sum': 0.0,
                'outside_rules_rows': 0,
                'in_policy_rows': 0,
                'linked_master_rows': 0,
                'in_policy_unlinked_rows': 0,
                'pending_review_rows': 0,
                'unmatched_rows': 0,
                'in_stock_in_policy_rows': 0,
                'in_stock_linked_rows': 0,
                'in_stock_unlinked_in_policy_rows': 0,
            }
        return by_wh[wh]

    for c in bundle.get('candidates') or []:
        if not _is_bigseller(c):
            continue
        src = c.get('source') or {}
        wh = (src.get('warehouse') or '').strip() or '（未填仓库）'
        b = bucket(wh)
        b['bs_rows_total'] += 1
        in_stock = is_in_stock_bigseller_candidate(c)
        qty = parse_available_qty(src.get('available_qty'))
        if in_stock:
            b['in_stock_rows'] += 1
            b['in_stock_qty_sum'] += qty

        if not is_in_policy_candidate(c):
            b['outside_rules_rows'] += 1
            continue

        b['in_policy_rows'] += 1
        lc = c.get('lifecycle') or ''
        if lc == 'pending_review':
            b['pending_review_rows'] += 1
        elif lc == 'unmatched':
            b['unmatched_rows'] += 1

        linked = _linked_to_master(c, embedded_reviews)
        if linked:
            b['linked_master_rows'] += 1
        else:
            b['in_policy_unlinked_rows'] += 1

        if in_stock:
            b['in_stock_in_policy_rows'] += 1
            if linked:
                b['in_stock_linked_rows'] += 1
            else:
                b['in_stock_unlinked_in_policy_rows'] += 1

    order = {w: i for i, w in enumerate(_bigseller_warehouses(bundle))}
    rows = list(by_wh.values())
    rows.sort(key=lambda r: (order.get(r['warehouse'], 999), r['warehouse']))

    total = {
        'warehouse': '【合计】',
        'market': '',
        'match_rule': '',
    }
    for key in rows[0].keys() if rows else []:
        if key in ('warehouse', 'market', 'match_rule'):
            continue
        if key == 'in_stock_qty_sum':
            total[key] = sum(r[key] for r in rows)
        else:
            total[key] = sum(r[key] for r in rows)
    if rows:
        rows.append(total)

    for r in rows:
        if r.get('in_stock_qty_sum') is not None:
            q = r['in_stock_qty_sum']
            r['in_stock_qty_sum'] = int(q) if q == int(q) else round(q, 2)

    return rows


def build_bs_warehouse_detail_rows(
    bundle: dict[str, Any],
    embedded_reviews: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    embedded_reviews = embedded_reviews or {}
    details: list[dict[str, Any]] = []
    order = {w: i for i, w in enumerate(_bigseller_warehouses(bundle))}

    for c in bundle.get('candidates') or []:
        if not _is_bigseller(c):
            continue
        src = c.get('source') or {}
        wh = (src.get('warehouse') or '').strip() or '（未填仓库）'
        cid = c.get('candidate_id') or ''
        rev = embedded_reviews.get(cid) or {}
        in_policy = is_in_policy_candidate(c)
        matches = c.get('master_matches') or []
        primary = matches[0] if len(matches) == 1 else None
        if 'review_state' in c:
            primary = c.get('selected_master')
            rev = {'decision': c.get('review_decision')}
        manual_row = (rev.get('manual_master_row') or '').strip()
        manual_ice = (rev.get('manual_master_ice') or '').strip()
        linked = _linked_to_master(c, embedded_reviews)
        if manual_row:
            link_src = 'manual'
            master_ice = manual_ice
            master_barcode = ''
            master_row = manual_row
        elif primary:
            link_src = 'engine'
            master_ice = primary.get('ice_code') or ''
            master_barcode = primary.get('barcode') or ''
            master_row = str(primary.get('row_index') or '')
        else:
            link_src = 'none'
            master_ice = master_barcode = master_row = ''

        qty_raw = src.get('available_qty') or ''
        qty = parse_available_qty(qty_raw)
        details.append(
            {
                'warehouse': wh,
                'candidateId': cid,
                'sheet': src.get('sheet_name') or '',
                'sku': src.get('external_sku_raw') or '',
                'gtin': src.get('gtin_raw') or '',
                'name': src.get('external_name') or '',
                'availableQty': qty_raw,
                'availableQtyNum': qty,
                'inStock': qty > 0,
                'policy': '规则内' if in_policy else '规则外',
                'lifecycle': c.get('lifecycle') or '',
                'linked': '是' if linked else '否',
                'linkSource': link_src,
                'masterIce': master_ice,
                'masterBarcode': master_barcode,
                'masterRow': master_row,
                'outsideReason': (
                    bigseller_outside_reason(_source_row_from_candidate(c)) or c.get('notes') or ''
                )
                if not in_policy
                else '',
                'flags': ';'.join(c.get('flags') or []),
                'reviewDecision': rev.get('decision') or '',
            }
        )

    details.sort(
        key=lambda r: (
            order.get(r['warehouse'], 999),
            r['warehouse'],
            -r['availableQtyNum'],
            r['sku'] or '',
        )
    )
    for r in details:
        del r['availableQtyNum']
    return details


def export_bs_warehouse_overview_csv(
    bundle: dict[str, Any],
    path: Path,
    embedded_reviews: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    if bundle.get('review_schema'):
        from .review_exports import review_records, warehouse_rows, write_csv
        rows = warehouse_rows(review_records(bundle))
        write_csv(path, rows)
        return rows
    rows = build_bs_warehouse_overview_rows(bundle, embedded_reviews)
    fields = [
        'warehouse',
        'market',
        'match_rule',
        'bs_rows_total',
        'in_stock_rows',
        'in_stock_qty_sum',
        'outside_rules_rows',
        'in_policy_rows',
        'linked_master_rows',
        'in_policy_unlinked_rows',
        'in_stock_in_policy_rows',
        'in_stock_linked_rows',
        'in_stock_unlinked_in_policy_rows',
        'pending_review_rows',
        'unmatched_rows',
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    return rows


_OVERVIEW_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>P0-03 BigSeller 仓库总览</title>
  <style>
    :root { --bg: #f4f5f7; --card: #fff; --line: #e2e6ea; --muted: #5c6570; --accent: #0f6bdc; --ok: #15803d; --warn: #b45309; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px/1.45 system-ui, "Segoe UI", sans-serif; background: var(--bg); color: #1a1d21; }
    header { background: var(--card); border-bottom: 1px solid var(--line); padding: 14px 18px; position: sticky; top: 0; z-index: 10; }
    h1 { margin: 0 0 6px; font-size: 18px; }
    .meta { color: var(--muted); font-size: 12px; max-width: 960px; }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .stat { background: var(--bg); border-radius: 8px; padding: 8px 12px; min-width: 110px; }
    .stat span { display: block; font-size: 11px; color: var(--muted); }
    .stat b { font-size: 17px; font-weight: 600; }
    main { padding: 14px 18px 40px; max-width: 1480px; margin: 0 auto; }
    h2 { font-size: 15px; margin: 20px 0 10px; }
    tr.data { cursor: pointer; }
    tr.data.selected { background: #e8f1fd !important; outline: 1px solid #b6d4fe; }
    .detail-wrap { margin-top: 8px; }
    .detail-wrap .card { max-height: min(520px, 55vh); }
    .detail-wrap th { top: 0; }
    .badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #eef2f7; }
    .badge.out { background: #fef3c7; color: #92400e; }
    .badge.in { background: #dcfce7; color: #166534; }
    label.chk { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
    input, button { font: inherit; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
    button.primary { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 8px 10px; text-align: right; border-bottom: 1px solid #eee; white-space: nowrap; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
    th { background: #f8f9fb; font-weight: 600; position: sticky; top: 0; cursor: pointer; user-select: none; }
    th:hover { background: #eef2f7; }
    tr.data:hover { background: #f8fbff; }
    tr.total { font-weight: 600; background: #f0f4f8; }
    tr.total td { border-top: 2px solid var(--line); }
    .rule-ph { color: var(--ok); }
    .rule-69 { color: var(--accent); }
    .gap-warn { color: var(--warn); font-weight: 600; }
    .hint { margin-top: 10px; font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
<header>
  <h1>BigSeller 仓库总览</h1>
  <div class="meta" id="meta"></div>
  <div class="stats" id="stats"></div>
</header>
<main>
  <div class="toolbar">
    <input type="search" id="q" placeholder="筛选仓库名…" style="min-width:220px" />
    <button type="button" class="primary" id="exportCsv">导出当前表 CSV</button>
  </div>
  <div class="card">
    <table id="tbl">
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
  </div>
  <p class="hint">组合 SKU 已剔除，明细仅含单个 SKU。规则内 = 菲仓货号 / 其他仓匹配条码；规则外 = 非匹配条码且非菲仓货号等。</p>
  <section class="detail-wrap">
    <h2 id="detailTitle">仓库明细</h2>
    <div class="toolbar">
      <input type="search" id="dq" placeholder="SKU / 名称 / 货号 / 条码…" style="min-width:240px" />
      <label class="chk"><input type="checkbox" id="fInStock" /> 仅有库存</label>
      <label class="chk"><input type="checkbox" id="fInPolicy" /> 仅规则内</label>
      <label class="chk"><input type="checkbox" id="fOutsidePolicy" /> 仅规则外</label>
      <label class="chk"><input type="checkbox" id="fLinked" /> 仅已挂库</label>
      <label class="chk"><input type="checkbox" id="fUnlinked" /> 仅未挂库</label>
      <button type="button" class="primary" id="exportDetailCsv">导出当前明细 CSV</button>
    </div>
    <div class="card">
      <table>
        <thead><tr id="dhead"></tr></thead>
        <tbody id="dbody"></tbody>
      </table>
    </div>
    <p class="hint" id="detailHint"></p>
  </section>
</main>
<script type="application/json" id="payload">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById('payload').textContent);
const COLS = [
  { key: 'warehouse', label: '仓库', align: 'left' },
  { key: 'market', label: '市场', align: 'left' },
  { key: 'match_rule', label: '匹配规则', align: 'left' },
  { key: 'bs_rows_total', label: 'BS 行数' },
  { key: 'in_stock_rows', label: '有库存行' },
  { key: 'in_stock_qty_sum', label: '可用库存合计' },
  { key: 'outside_rules_rows', label: '规则外' },
  { key: 'in_policy_rows', label: '规则内' },
  { key: 'linked_master_rows', label: '已挂商品库' },
  { key: 'in_policy_unlinked_rows', label: '规则内未挂' },
  { key: 'in_stock_linked_rows', label: '有库存已挂' },
  { key: 'in_stock_unlinked_in_policy_rows', label: '有库存未挂', warn: true },
  { key: 'pending_review_rows', label: '引擎 pending' },
  { key: 'unmatched_rows', label: '引擎 unmatched' },
];
let sortKey = 'bs_rows_total';
let sortDir = -1;
let selectedWh = '';
const DETAIL_COLS = [
  { key: 'sheet', label: '工作表' },
  { key: 'sku', label: 'SKU' },
  { key: 'gtin', label: 'GTIN' },
  { key: 'name', label: '名称' },
  { key: 'availableQty', label: '可用' },
  { key: 'policy', label: '规则' },
  { key: 'lifecycle', label: 'lifecycle' },
  { key: 'linked', label: '挂库' },
  { key: 'masterIce', label: 'ICE货号' },
  { key: 'masterBarcode', label: '匹配条码' },
  { key: 'masterRow', label: '商品库行' },
  { key: 'linkSource', label: '来源' },
  { key: 'reviewDecision', label: '核对' },
  { key: 'outsideReason', label: '规则外说明' },
  { key: 'flags', label: 'flags' },
];
let dSortKey = 'availableQty';
let dSortDir = -1;

function warehouseList() {
  return (DATA.rows || []).filter(r => r.warehouse && r.warehouse !== '【合计】').map(r => r.warehouse);
}
function pickDefaultWh() {
  const list = warehouseList();
  if (!selectedWh && list.length) selectedWh = list[0];
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;');
}
function fmt(n) {
  if (n === '' || n == null) return '';
  if (typeof n === 'number') return n.toLocaleString('zh-CN');
  return esc(n);
}
function totalRow() {
  return (DATA.rows || []).find(r => r.warehouse === '【合计】') || {};
}
function renderMeta() {
  const t = totalRow();
  const parts = [];
  if (DATA.generatedAt) parts.push('生成 ' + DATA.generatedAt.slice(0, 19).replace('T', ' '));
  if (DATA.bigsellerSource) parts.push('来源 ' + DATA.bigsellerSource);
  document.getElementById('meta').textContent = parts.join(' · ') || 'P0-03 样表匹配';
  document.getElementById('stats').innerHTML = [
    ['BS 行合计', t.bs_rows_total],
    ['规则内', t.in_policy_rows],
    ['已挂商品库', t.linked_master_rows],
    ['规则外', t.outside_rules_rows],
    ['有库存·规则内未挂', t.in_stock_unlinked_in_policy_rows],
  ].map(([k,v]) => `<div class="stat"><span>${k}</span><b>${fmt(v)}</b></div>`).join('');
}
function filteredRows() {
  const q = (document.getElementById('q').value || '').trim().toLowerCase();
  return (DATA.rows || []).filter(r => {
    if (r.warehouse === '【合计】') return false;
    if (!q) return true;
    return (r.warehouse || '').toLowerCase().includes(q);
  });
}
function sortedRows(list) {
  const copy = list.slice();
  copy.sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (typeof va === 'number' && typeof vb === 'number') return sortDir * (va - vb);
    return sortDir * String(va).localeCompare(String(vb), 'zh-CN');
  });
  return copy;
}
function renderTable() {
  const head = document.getElementById('head');
  head.innerHTML = COLS.map(c => {
    const arrow = sortKey === c.key ? (sortDir > 0 ? ' ↑' : ' ↓') : '';
    return `<th data-key="${c.key}">${esc(c.label)}${arrow}</th>`;
  }).join('');
  const body = document.getElementById('body');
  const rows = sortedRows(filteredRows());
  body.innerHTML = rows.map(r => {
    const sel = r.warehouse === selectedWh ? ' selected' : '';
    return `<tr class="data${sel}" data-wh="${esc(r.warehouse)}">${COLS.map(c => {
      let cls = '';
      let val = r[c.key];
      if (c.key === 'match_rule') cls = (val || '').includes('菲律宾') ? 'rule-ph' : 'rule-69';
      if (c.warn && val > 0) cls = 'gap-warn';
      return `<td class="${cls}">${fmt(val)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const t = totalRow();
  if (t.warehouse) {
    body.innerHTML += `<tr class="total">${COLS.map(c => `<td>${fmt(t[c.key])}</td>`).join('')}</tr>`;
  }
}
function exportCsv() {
  const rows = sortedRows(filteredRows());
  const t = totalRow();
  const all = t.warehouse ? [...rows, t] : rows;
  const header = COLS.map(c => c.label);
  const lines = [header.join(',')];
  for (const r of all) {
    lines.push(COLS.map(c => {
      const v = r[c.key];
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'P0-03-bs-warehouse-overview.csv';
  a.click();
}
function detailFiltered() {
  if (!selectedWh) return [];
  const q = (document.getElementById('dq').value || '').trim().toLowerCase();
  const inStock = document.getElementById('fInStock').checked;
  const inPolicy = document.getElementById('fInPolicy').checked;
  const outsidePolicy = document.getElementById('fOutsidePolicy').checked;
  const linked = document.getElementById('fLinked').checked;
  const unlinked = document.getElementById('fUnlinked').checked;
  return (DATA.details || []).filter(r => {
    if (r.warehouse !== selectedWh) return false;
    if (inStock && !r.inStock) return false;
    if (inPolicy && r.policy !== '规则内') return false;
    if (outsidePolicy && r.policy !== '规则外') return false;
    if (linked && r.linked !== '是') return false;
    if (unlinked && r.linked !== '否') return false;
    if (!q) return true;
    const hay = [r.sku, r.gtin, r.name, r.masterIce, r.masterBarcode, r.outsideReason].join(' ').toLowerCase();
    return hay.includes(q);
  });
}
function renderDetails() {
  pickDefaultWh();
  document.getElementById('detailTitle').textContent = selectedWh
    ? `仓库明细 · ${selectedWh}`
    : '仓库明细（请点击上方仓库）';
  document.getElementById('dhead').innerHTML = DETAIL_COLS.map(c => {
    const arrow = dSortKey === c.key ? (dSortDir > 0 ? ' ↑' : ' ↓') : '';
    return `<th data-dkey="${c.key}">${esc(c.label)}${arrow}</th>`;
  }).join('');
  let list = detailFiltered();
  list = list.slice().sort((a, b) => {
    const va = a[dSortKey], vb = b[dSortKey];
    const na = parseFloat(va), nb = parseFloat(vb);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && String(va).match(/^-?\d/)) return dSortDir * (na - nb);
    if (typeof va === 'boolean') return dSortDir * ((va === vb) ? 0 : va ? 1 : -1);
    return dSortDir * String(va ?? '').localeCompare(String(vb ?? ''), 'zh-CN');
  });
  const cap = 2000;
  const show = list.slice(0, cap);
  document.getElementById('dbody').innerHTML = show.map(r => `<tr>${DETAIL_COLS.map(c => {
    let val = r[c.key];
    let extra = '';
    if (c.key === 'policy') extra = val === '规则外' ? ' badge out' : ' badge in';
    if (c.key === 'linked' && val === '否' && r.policy === '规则内') extra = ' gap-warn';
    return `<td class="${extra.trim()}">${fmt(val)}</td>`;
  }).join('')}</tr>`).join('') || `<tr><td colspan="${DETAIL_COLS.length}" class="muted" style="text-align:left">无数据</td></tr>`;
  document.getElementById('detailHint').textContent = selectedWh
    ? `显示 ${show.length} / ${list.length} 行${list.length > cap ? '（已截断，请用筛选缩小）' : ''}`
    : '';
}
function exportDetailCsv() {
  const list = detailFiltered();
  const header = DETAIL_COLS.map(c => c.label);
  const lines = [header.join(',')];
  for (const r of list) {
    lines.push(DETAIL_COLS.map(c => {
      const v = r[c.key];
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  const safe = (selectedWh || 'all').replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'P0-03-bs-detail-' + safe + '.csv';
  a.click();
}
document.getElementById('body').addEventListener('click', e => {
  const tr = e.target.closest('tr.data[data-wh]');
  if (!tr) return;
  selectedWh = tr.getAttribute('data-wh') || '';
  renderTable();
  renderDetails();
});
document.getElementById('dhead').addEventListener('click', e => {
  const th = e.target.closest('th[data-dkey]');
  if (!th) return;
  const k = th.getAttribute('data-dkey');
  if (dSortKey === k) dSortDir *= -1;
  else { dSortKey = k; dSortDir = k === 'availableQty' ? -1 : 1; }
  renderDetails();
});
function syncPolicyFilters(changed) {
  const inEl = document.getElementById('fInPolicy');
  const outEl = document.getElementById('fOutsidePolicy');
  if (changed === 'in' && inEl.checked) outEl.checked = false;
  if (changed === 'out' && outEl.checked) inEl.checked = false;
}
['dq','fInStock','fLinked','fUnlinked'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderDetails);
  document.getElementById(id).addEventListener('change', renderDetails);
});
document.getElementById('fInPolicy').addEventListener('change', () => {
  syncPolicyFilters('in');
  renderDetails();
});
document.getElementById('fOutsidePolicy').addEventListener('change', () => {
  syncPolicyFilters('out');
  renderDetails();
});
document.getElementById('exportDetailCsv').addEventListener('click', exportDetailCsv);
document.getElementById('head').addEventListener('click', e => {
  const th = e.target.closest('th[data-key]');
  if (!th) return;
  const k = th.getAttribute('data-key');
  if (sortKey === k) sortDir *= -1;
  else { sortKey = k; sortDir = typeof (DATA.rows[0] || {})[k] === 'number' ? -1 : 1; }
  renderTable();
});
document.getElementById('q').addEventListener('input', renderTable);
document.getElementById('exportCsv').addEventListener('click', exportCsv);
renderMeta();
renderTable();
renderDetails();
</script>
</body>
</html>
"""


def export_bs_warehouse_overview_html(
    bundle: dict[str, Any],
    path: Path,
    embedded_reviews: dict[str, dict[str, Any]] | None = None,
    manifest: dict[str, Any] | None = None,
) -> None:
    if bundle.get('review_schema'):
        from .review_exports import export_effective_html
        export_effective_html(bundle, path, warehouse=True)
        return
    rows = build_bs_warehouse_overview_rows(bundle, embedded_reviews)
    details = build_bs_warehouse_detail_rows(bundle, embedded_reviews)
    bs_path = ''
    if manifest:
        bs_path = ((manifest.get('inputs') or {}).get('bigseller') or {}).get('path') or ''
        if bs_path:
            bs_path = Path(bs_path).name
    payload = {
        'rows': rows,
        'details': details,
        'generatedAt': (manifest or {}).get('generated_at') or '',
        'bigsellerSource': bs_path,
    }
    html = _OVERVIEW_HTML.replace('__DATA__', json.dumps(payload, ensure_ascii=False))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding='utf-8')
