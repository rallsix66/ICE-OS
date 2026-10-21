"""All sample-review outputs are projections of the same effective records."""
from __future__ import annotations

import csv
import html
import json
from collections import Counter, defaultdict
from pathlib import Path

from .review_result import MANUAL_FIELDS, effective_master


def review_records(bundle):
    rows = []
    for c in bundle['candidates']:
        s, m = c.get('source') or {}, effective_master(c) or {}
        j = c.get('selected_jushuitan') or {}
        rows.append({
            'candidate_id': c['candidate_id'], 'source_system': s.get('source_system', ''),
            'source_row_key': s.get('source_row_key', ''), 'warehouse': s.get('warehouse') or '',
            'external_sku_raw': s.get('external_sku_raw', ''), 'external_name': s.get('external_name', ''),
            'available_qty': s.get('available_qty') or '',
            'review_state': c['review_state'], 'review_decision': c.get('review_decision') or '',
            'review_notes': c.get('review_notes') or '', 'review_reason': c['review_reason'],
            **{k: c.get(k) or '' for k in MANUAL_FIELDS},
            'master_row_index': m.get('row_index', ''), 'master_ice_code': m.get('ice_code', ''),
            'master_name_cn': m.get('name_cn', ''), 'master_barcode': m.get('barcode', ''),
            'selected_jst_candidate_id': j.get('candidate_id', ''),
            'selected_jst_sku': (j.get('source') or {}).get('external_sku_raw', ''),
            'candidate_targets': json.dumps(c.get('master_matches') or [], ensure_ascii=False, sort_keys=True),
            'quality_flags': ';'.join(c.get('retained_quality_flags') or []),
            'validation_errors': ';'.join(c.get('validation_errors') or []),
            'selected_master_quality_issues': json.dumps(c.get('selected_master_quality_issues') or [], ensure_ascii=False, sort_keys=True),
            'historical_correction_reason': c.get('historical_correction_reason') or '',
            'manual_jushuitan_conflict': json.dumps(c.get('manual_jushuitan_conflict'), ensure_ascii=False, sort_keys=True),
            'batch_business_pending': json.dumps(c.get('batch_business_pending'), ensure_ascii=False, sort_keys=True),
        })
    return rows


def write_csv(path, rows, fields=None):
    fields = fields or (list(rows[0]) if rows else ['candidate_id'])
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def warehouse_rows(records):
    groups = defaultdict(list)
    for r in records:
        if r['source_system'] == 'bigseller':
            groups[r['warehouse']].append(r)
    return [{'warehouse': wh, 'source_rows': len(rs), **{k: sum(r['review_state'] == k for r in rs) for k in ('candidate', 'manual_selected', 'pending', 'rejected', 'ignored', 'outside_rules')}} for wh, rs in sorted(groups.items())]


def export_effective_html(bundle, path, *, warehouse=False):
    records = review_records(bundle)
    if warehouse:
        records = [r for r in records if r['source_system'] == 'bigseller']
    payload = {'rows': records, 'summary': dict(Counter(r['review_state'] for r in records)),
               'warehouseSummary': warehouse_rows(records), 'inputManifest': bundle.get('input_manifest')}
    labels = {'candidate': '有候选', 'manual_selected': '人工已选', 'pending': '待核对', 'rejected': '拒绝', 'ignored': '忽略', 'outside_rules': '规则外'}
    columns = ['source_system', 'warehouse', 'external_sku_raw', 'external_name', 'review_state', 'master_row_index', 'master_ice_code', 'manual_master_row', 'manual_master_ice', 'selected_jst_sku', 'review_decision', 'review_notes', 'review_reason', 'quality_flags', 'selected_master_quality_issues', 'candidate_targets', 'manual_jst_sku', 'historical_correction_reason', 'manual_jushuitan_conflict', 'batch_business_pending']
    headings = ['来源', '仓库', '来源SKU', '品名', '核对状态', '有效主库行', '有效ICE货号', '原人工主库行', '原人工ICE货号', '有效JST项', '人工决定', '人工备注', '说明', '来源冲突标记', '所选主库资料冲突', '候选（不代表人工已选）', '原填JST项', '历史纠错原因', '双方已选主库行冲突', '本批业务待决（既有对应保留）']
    tr = []
    for r in records:
        cells = ''.join('<td>'+html.escape(str(labels.get(r[k], r[k]) if k == 'review_state' else r[k]))+'</td>' for k in columns)
        tr.append(f'<tr data-id="{html.escape(r["candidate_id"])}" data-state="{r["review_state"]}">{cells}</tr>')
    data = json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c')
    summary = ' · '.join(f'{labels[k]} {n}' for k, n in payload['summary'].items())
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>P0-03 本批资料核对</title>
<style>body{font:14px system-ui;margin:24px;color:#1e293b}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:6px;text-align:left}thead{position:sticky;top:0;background:#f1f5f9}td{max-width:320px;overflow-wrap:anywhere}input,select{padding:8px;margin:12px}</style>
<h1>P0-03 本批资料核对</h1><p>人工已选仅表达本批资料核对；后续持续绑定及使用方案尚未确定。整仓可用数&gt;0 不表示存在实物库存。空值/clear 清除旧决定；reject 拒绝；ignore 忽略；defer 暂缓。修改须通过显式 CSV 重新生成新证据。</p>
<p>__SUMMARY__</p><input id="search" placeholder="搜索SKU、仓库、货号"><select id="state"><option value="">全部状态</option>__OPTIONS__</select><span id="count"></span>
<table><thead><tr>__HEAD__</tr></thead><tbody>__ROWS__</tbody></table>
<script id="review-data" type="application/json">__DATA__</script><script>
const data=JSON.parse(document.getElementById('review-data').textContent);
const search=document.getElementById('search'), state=document.getElementById('state');
function filter(){let n=0;for(const r of document.querySelectorAll('tbody tr')){r.hidden=!!((state.value&&r.dataset.state!==state.value)||!r.textContent.toLowerCase().includes(search.value.toLowerCase()));if(!r.hidden)n++;}document.getElementById('count').textContent=n+' 条';}
search.addEventListener('input',filter);state.addEventListener('change',filter);filter();
</script></html>'''
    page = page.replace('__SUMMARY__', summary).replace('__OPTIONS__', ''.join(f'<option value="{k}">{v}</option>' for k, v in labels.items())).replace('__HEAD__', ''.join('<th>'+x+'</th>' for x in headings)).replace('__ROWS__', ''.join(tr)).replace('__DATA__', data)
    path.write_text(page, encoding='utf-8')


def export_effective_outputs(bundle, directory: Path):
    from .unified_view import build_unified_rows
    refresh_confirmation_summary(bundle)
    rows = review_records(bundle)
    if 'master_provenance' in bundle:
        export_curated_master(bundle, directory)
    fields = list(rows[0])
    for name in ('review-decisions-export.csv', 'manual-review.csv'):
        write_csv(directory/name, rows, fields)
    selected = [r for r in rows if r['review_state'] == 'manual_selected']
    write_csv(directory/'matched-total-detail.csv', selected, fields)
    write_csv(directory/'pending-user-review.csv', [r for r in rows if r['review_state'] in ('pending', 'candidate')], fields)
    write_csv(directory/'manual-selections-restored.csv', [r for r in rows if r['manual_master_row']], fields)
    write_csv(directory/'outside-rules.csv', [r for r in rows if r['review_state'] == 'outside_rules'], fields)
    write_csv(directory/'bs-warehouse-overview.csv', warehouse_rows(rows))
    grouped = defaultdict(list)
    for r in selected:
        grouped[r['master_row_index']].append(r)
    totals = [{'master_row_index': k, 'master_ice_code': rs[0]['master_ice_code'], 'selected_source_rows': len(rs), 'candidate_ids': ';'.join(r['candidate_id'] for r in rs)} for k, rs in sorted(grouped.items())]
    write_csv(directory/'matched-total-by-master.csv', totals)
    for name, value in [('review-outcome.json', bundle), ('match-bundle.json', bundle), ('unified-view.json', build_unified_rows(bundle)), ('effective-review-records.json', rows), ('correction-events.json', bundle['correction_events']), ('unapplied-decisions.json', bundle['unapplied_decisions'])]:
        (directory/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    for key, name in [('batch_business_pending', 'pending-business.json'), ('business_confirmation_events', 'business-confirmation-events.json'), ('business_confirmation_summary', 'business-confirmation-summary.json'), ('jst_confirmation_events', 'jst-confirmation-events.json'), ('jst_confirmation_summary', 'jst-confirmation-summary.json'), ('batch_bs_not_created', 'bs-not-created.json')]:
        if key in bundle:
            (directory/name).write_text(json.dumps(bundle[key], ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    for key, name in [('final_confirmation_events', 'final-confirmation-events.json'), ('final_confirmation_summary', 'final-confirmation-summary.json'),
                      ('batch_version_confirmations', 'version-confirmations.json'), ('batch_specification_resolutions', 'specification-resolutions.json'),
                      ('batch_brush_preservation', 'brush-preservation.json'), ('resolved_business_pending_history', 'resolved-business-pending-history.json')]:
        if key in bundle:
            (directory/name).write_text(json.dumps(bundle[key], ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    export_effective_html(bundle, directory/'match-review.html')
    export_effective_html(bundle, directory/'bs-warehouse-overview.html', warehouse=True)


def refresh_confirmation_summary(bundle):
    """Reapplying clear/defer must not leave an old effective-selection count."""
    if 'final_confirmation_events' in bundle:
        by_id = {c['candidate_id']: c for c in bundle['candidates']}
        new, reaffirmed, ignored = [], [], []
        for event in bundle['final_confirmation_events']:
            p = event['explicit_decision']
            c = by_id[p['candidate_id']]
            target = c.get('selected_master') or {}
            active = (c['review_state'] == 'manual_selected' and c.get('review_decision') == 'confirm'
                      and target.get('row_index') == p['target_row'] and target.get('ice_code') == p['target_ice'])
            if p['decision'] == 'confirm' and active:
                (reaffirmed if event['before_selected_master'] else new).append(c['candidate_id'])
            if p['decision'] == 'ignore' and c['review_state'] == 'ignored' and c.get('review_decision') == 'ignore':
                ignored.append(c['candidate_id'])
        for version in bundle.get('batch_version_confirmations', []):
            c = by_id[version['candidate_id']]
            target = c.get('selected_master') or {}
            version['effective_selection'] = (c['review_state'] == 'manual_selected' and c.get('review_decision') == 'confirm'
                and target.get('row_index') == version['target_row'] and target.get('ice_code') == version['target_ice'])
            c['batch_version_confirmation'] = dict(version)
        bundle['final_confirmation_summary'] = {'recorded_source_decisions': len(bundle['final_confirmation_events']),
            'new_effective_selections': len(new), 'new_effective_candidate_ids': new,
            'reaffirmed_existing_selections': len(reaffirmed), 'reaffirmed_candidate_ids': reaffirmed,
            'effective_ignores': len(ignored), 'ignored_candidate_ids': ignored,
            'current_confirmed_versions': sum(v['effective_selection'] for v in bundle.get('batch_version_confirmations', [])),
            'closed_specification_issues': sum(r['status'].startswith('closed_') for r in bundle.get('batch_specification_resolutions', [])),
            'remaining_business_issues': len(bundle.get('batch_business_pending', []))}
    if 'jst_confirmation_events' in bundle:
        by_id = {c['candidate_id']: c for c in bundle['candidates']}
        selected, ignored = [], []
        for event in bundle['jst_confirmation_events']:
            explicit = event['explicit_decision']
            c = by_id[explicit['candidate_id']]
            target = c.get('selected_master') or {}
            if (explicit['decision'] == 'confirm' and c['review_state'] == 'manual_selected'
                    and target.get('row_index') == explicit['target_row'] and target.get('ice_code') == explicit['target_ice']):
                selected.append(c['candidate_id'])
            if explicit['decision'] == 'ignore' and c['review_state'] == 'ignored' and c.get('review_decision') == 'ignore':
                ignored.append(c['candidate_id'])
        bundle['jst_confirmation_summary'] = {'recorded_source_decisions': len(bundle['jst_confirmation_events']),
            'new_effective_selections': len(selected), 'new_effective_candidate_ids': selected,
            'effective_ignores': len(ignored), 'ignored_candidate_ids': ignored,
            'bs_not_created_product_codes': [n['ice_code'] for n in bundle.get('batch_bs_not_created', [])]}
    if 'business_confirmation_events' not in bundle:
        return
    by_id = {c['candidate_id']: c for c in bundle['candidates']}
    new, reaffirmed, prices = [], [], 0
    events = bundle['business_confirmation_events']
    for event in events:
        explicit = event['explicit_decision']
        if event['type'] == 'source_confirmation':
            c = by_id[explicit['candidate_id']]
            selected = c.get('selected_master')
            if (c.get('review_state') == 'manual_selected' and selected
                    and selected['row_index'] == explicit['target_row'] and selected['ice_code'] == explicit['target_ice']):
                (new if not event['before_selected_master'] else reaffirmed).append(c['candidate_id'])
        else:
            m = next(m for m in bundle['master_provenance'] if m['row_index'] == explicit['master_anchor_row'])
            prices += int(not m['price_pending'] and m['data']['成本价格'] == explicit['cost']
                          and m['data']['运营价格'] == explicit['operating_price'])
    bundle['business_confirmation_summary'] = {'recorded_business_decisions': len(events),
        'implemented_business_decisions': len(new)+len(reaffirmed)+prices,
        'new_effective_selections': len(new), 'new_effective_candidate_ids': new,
        'reaffirmed_existing_selections': len(reaffirmed), 'reaffirmed_candidate_ids': reaffirmed,
        'current_price_selections': prices, 'remaining_business_issues': len(bundle['batch_business_pending'])}


def export_curated_master(bundle, directory):
    """Local evidence overview from the same effective selections, including reapply."""
    details = bundle['master_provenance']
    for item in details:
        item['selected_source_ids'] = [c['candidate_id'] for c in bundle['candidates']
                                       if c.get('selected_master') and c['selected_master']['row_index'] == item['row_index']]
    (directory/'master-overview.json').write_text(json.dumps(details, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    flat = [{**{k: v for k, v in m.items() if k not in ('data', 'source_records', 'corrections')}, **m['data']} for m in details]
    write_csv(directory/'master-overview.csv', [{k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in r.items()} for r in flat],
              fields=list(dict.fromkeys(k for r in flat for k in r)))
    payload = json.dumps(details, ensure_ascii=False).replace('<', '\\u003c')
    (directory/'master-overview.html').write_text('<!doctype html><meta charset="utf-8"><title>本批主资料核对证据</title><h1>本批主资料整理（本地证据）</h1><p>保留原Excel行号；现行价格与来源版本分别保留，未定价为空，不开展估值。</p><table><thead><tr><th>原行锚点</th><th>货号</th><th>包装条码</th><th>来源行</th><th>资料与价格版本</th></tr></thead><tbody>'+''.join('<tr data-master-row="'+str(m['row_index'])+'">'+''.join('<td>'+html.escape(str(v))+'</td>' for v in [m['row_index'], m['ice_code'], m['barcode'], m['source_rows'], json.dumps(m, ensure_ascii=False)])+'</tr>' for m in details)+'</tbody></table><script id="master-data" type="application/json">'+payload+'</script>', encoding='utf-8')
