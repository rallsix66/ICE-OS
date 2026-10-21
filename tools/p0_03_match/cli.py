"""Local, explicit sample review; never writes a database or the Desktop."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .loaders import load_bigseller, load_jushuitan_merged, load_master
from .match_engine import build_match_bundle
from .review_result import read_decisions, resolve_reviews, source_identity
from .review_exports import export_effective_outputs


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def _new_output(path):
    out = Path(path).resolve()
    if out.exists() and any(out.iterdir()):
        raise ValueError(f'Refusing to overwrite existing evidence: {out}')
    out.mkdir(parents=True, exist_ok=True)
    return out


def _freeze(path, out, name):
    data = path.read_bytes()
    dest = out/name
    dest.write_bytes(data)
    return {'path': str(path), 'frozen': name, 'sha256': hashlib.sha256(data).hexdigest()}


def _generate(master_path, bs_path, jst_paths):
    masters = load_master(master_path)
    sources = load_bigseller(bs_path) + load_jushuitan_merged(*jst_paths)
    bundle = build_match_bundle(masters, sources)
    physical = len(pd.read_excel(master_path, sheet_name=0, dtype=str))
    bundle['summary'].update(master_excel_data_rows=physical, master_blank_rows_skipped=physical-len(masters),
                             master_nonempty_rows=len(masters), source_by_system=dict(Counter(s.source_system for s in sources)))
    return masters, bundle


def preserve_sample_ids(bundle, old):
    """Frozen source identity within this sample, including IDs before method changes."""
    old_by_source = {}
    for previous in old['candidates']:
        key = source_identity(previous)
        if key in old_by_source:
            raise ValueError(f'Ambiguous frozen source identity: {key}')
        old_by_source[key] = previous
    for c in bundle['candidates']:
        previous = old_by_source.get(source_identity(c))
        if previous:
            c['candidate_id_lineage'] = sorted(set([
                c['candidate_id'], previous['candidate_id'],
                *previous.get('candidate_id_lineage', []),
                *(r['candidate_id'] for r in previous.get('decision_records', []))]))
            c['candidate_id'] = previous['candidate_id']
            c['previous_master_matches'] = previous['master_matches']
    return bundle


def _finish(bundle, masters, decisions, out, manifest, history=()):
    outcome = resolve_reviews(bundle, decisions, masters, history=history)
    outcome['input_manifest'] = manifest
    export_effective_outputs(outcome, out)
    (out/'input-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'output_dir': str(out), 'summary': outcome['summary'], 'unapplied_decisions': len(outcome['unapplied_decisions'])}, ensure_ascii=False))
    return 0


def cmd_match(args):
    master, bs = Path(args.master).resolve(), Path(args.bigseller).resolve()
    jst = [Path(p).resolve() for p in [args.jushuitan, *args.jushuitan_extra]]
    out = _new_output(args.output)
    masters, bundle = _generate(master, bs, jst)
    manifest = {'generated_at': datetime.now(timezone.utc).isoformat(), 'inputs': {
        'master': {'path': str(master), 'sha256': _sha256(master)},
        'bigseller': {'path': str(bs), 'sha256': _sha256(bs)},
        'jushuitan': {'paths': [{'path': str(p), 'sha256': _sha256(p)} for p in jst]}},
        'scope': 'current_sample_review_only; future_binding_undecided'}
    decisions = {}
    if args.review_csv:
        manifest['decision_source'] = _freeze(Path(args.review_csv).resolve(), out, 'manual-decisions.frozen.csv')
        decisions = read_decisions(out/'manual-decisions.frozen.csv')
    return _finish(bundle, masters, decisions, out, manifest)


def cmd_rework(args):
    base = Path(args.evidence).resolve()
    old = _json(base/'match-bundle.json')
    manifest = _json(base/'input-manifest.json')
    inputs = manifest['inputs']
    all_inputs = [inputs['master'], inputs['bigseller'], *inputs['jushuitan']['paths']]
    for item in all_inputs:
        if _sha256(Path(item['path'])) != item['sha256']:
            raise ValueError(f'Original input hash changed: {item["path"]}')
    out = _new_output(args.output)
    manifest = {'generated_at': datetime.now(timezone.utc).isoformat(), 'inputs': inputs,
                'scope': 'current_sample_review_only; future_binding_undecided',
                'base_evidence': str(base),
                'base_evidence_hashes': {p.name: _sha256(p) for p in base.iterdir() if p.is_file()},
                'decision_source': _freeze(Path(args.review_csv).resolve(), out, 'manual-decisions.frozen.csv')}
    history = [old]
    manifest['history_bundles'] = []
    for i, arg in enumerate(args.history_bundle):
        p = Path(arg).resolve()
        manifest['history_bundles'].append(_freeze(p, out, f'history-bundle-{i}.frozen.json'))
        history.append(_json(out/f'history-bundle-{i}.frozen.json'))
    _freeze(base/'match-bundle.json', out, 'original-match-bundle.frozen.json')
    if (base/'review-outcome.json').is_file():
        _freeze(base/'review-outcome.json', out, 'original-review-outcome.frozen.json')
    masters, bundle = _generate(Path(inputs['master']['path']), Path(inputs['bigseller']['path']),
                                [Path(p['path']) for p in inputs['jushuitan']['paths']])
    # Preserve batch record identity when corrected match methods change the legacy ID.
    preserve_sample_ids(bundle, old)
    decisions = read_decisions(out/'manual-decisions.frozen.csv')
    return _finish(bundle, masters, decisions, out, manifest, history)


def cmd_apply_review(args):
    path = Path(args.bundle).resolve()
    bundle = _json(path)
    if not bundle.get('master_rows'):
        raise ValueError('Use rework with the original evidence for legacy bundles without master_rows')
    from .models import MasterRow
    masters = [MasterRow(**m) for m in bundle['master_rows']]
    out = _new_output(Path(args.output).resolve().parent)
    manifest = {'generated_at': datetime.now(timezone.utc).isoformat(),
                'scope': 'current_sample_review_only; future_binding_undecided',
                'bundle': _freeze(path, out, 'input-bundle.frozen.json'),
                'decision_source': _freeze(Path(args.review_csv).resolve(), out, 'manual-decisions.frozen.csv')}
    return _finish(bundle, masters, read_decisions(out/'manual-decisions.frozen.csv'), out, manifest)


def main(argv=None):
    parser = argparse.ArgumentParser(prog='p0-03-match')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('match')
    for key in ('master', 'bigseller', 'jushuitan', 'output'):
        p.add_argument('--'+key, required=True)
    p.add_argument('--jushuitan-extra', action='append', default=[])
    p.add_argument('--review-csv')
    p.set_defaults(func=cmd_match)
    p = sub.add_parser('rework')
    for key in ('evidence', 'review-csv', 'output'):
        p.add_argument('--'+key, required=True)
    p.add_argument('--history-bundle', action='append', default=[])
    p.set_defaults(func=cmd_rework)
    p = sub.add_parser('curate-sample')
    for key in ('evidence', 'review-csv', 'corrections', 'output'):
        p.add_argument('--'+key, required=True)
    from .sample_curation import cmd_curate_sample
    p.set_defaults(func=cmd_curate_sample)
    p = sub.add_parser('confirm-sample')
    for key in ('evidence', 'decisions', 'output'):
        p.add_argument('--'+key, required=True)
    from .business_confirmations import cmd_confirm_sample
    p.set_defaults(func=cmd_confirm_sample)
    p = sub.add_parser('confirm-jst-sample')
    for key in ('evidence', 'decisions', 'output'):
        p.add_argument('--'+key, required=True)
    from .jst_confirmations import cmd_confirm_jst_sample
    p.set_defaults(func=cmd_confirm_jst_sample)
    p = sub.add_parser('finalize-sample')
    for key in ('evidence', 'decisions', 'output'):
        p.add_argument('--'+key, required=True)
    from .final_decisions import cmd_finalize_sample
    p.set_defaults(func=cmd_finalize_sample)
    p = sub.add_parser('apply-review')
    for key in ('bundle', 'review-csv', 'output'):
        p.add_argument('--'+key, required=True)
    p.set_defaults(func=cmd_apply_review)
    p = sub.add_parser('html')
    p.add_argument('--bundle', required=True)
    p.add_argument('--output', required=True)
    p.set_defaults(func=cmd_html)
    args = parser.parse_args(argv)
    return args.func(args)


def cmd_html(args):
    from .review_exports import export_effective_html
    bundle = _json(Path(args.bundle))
    if not bundle.get('review_schema'):
        raise ValueError('Use rework to validate legacy results first')
    dest = Path(args.output)
    if dest.exists():
        raise ValueError('Refusing to overwrite evidence')
    export_effective_html(bundle, dest)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
