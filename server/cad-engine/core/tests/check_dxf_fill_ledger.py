"""Fill ledger: reconcile source entities, fills, refusals and verification per file.

This is the audit trail that keeps "560 checked" from hiding files whose solid fills
were never verified. For every real sample and fill fixture, each solid HATCH and SOLID
entity is either in the fill registry or listed in fill/1.skipped with a reason;
pattern HATCH is counted separately from triangle fills. Verified solid counts come from dxf-fill-geometry.json, and the
corpus totals are asserted below so a silent regression cannot pass.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import sys
from collections import Counter
from pathlib import Path

import ezdxf

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
PROJECT = DATA
sys.path.insert(0, str(APP_DIR))
from unified.dxf_adapter import read_dxf  # noqa: E402

REAL = PROJECT / 'phase_i_evidence' / 'samples' / 'real'
FIXTURES = PROJECT / 'phase_j_evidence' / 'fixtures'
OUT = PROJECT / 'phase_j_evidence' / 'profiles' / 'dxf-fill-ledger.json'
EXPECTED_TOTALS = {'solidFills': 564, 'filled': 561, 'refused': 3, 'checked': 560,
                   'patternFills': 91, 'patternRefused': 0}
GEOMETRY = PROJECT / 'phase_j_evidence' / 'profiles' / 'dxf-fill-geometry.json'

REFUSAL_REASONS = {
    'pattern-fill-unsupported', 'gradient-fill-unsupported',
    'hatch-style-unsupported:0-multipath',
    'hatch-style-unsupported:1-multipath', 'hatch-style-unsupported:2-multipath',
    'hatch-boundary-discontinuous', 'hatch-boundary-degenerate',
    'hatch-nesting-unresolved', 'hatch-triangulation-empty', 'hatch-area-mismatch',
    'hatch-without-boundary', 'hatch-textbox-only', 'hatch-style-unreadable',
    'hatch-triangulation-mismatch', 'solid-degenerate',
}


def is_solid(entity):
    if int(entity.dxf.get('solid_fill', 0) or 0) == 1:
        return True
    return str(entity.dxf.get('pattern_name', '') or '').upper() in ('SOLID', 'SOLID,_O')


def classify(path):
    """Map handle -> ('SOLID'|'hatch-solid'|'hatch-pattern') for every drawn entity."""
    document = ezdxf.readfile(str(path))
    kinds = {}
    styles = Counter()

    def scan(entities):
        for entity in entities:
            kind = entity.dxftype()
            if kind == 'SOLID':
                kinds[entity.dxf.handle.upper()] = 'SOLID'
            elif kind == 'HATCH':
                if is_solid(entity):
                    kinds[entity.dxf.handle.upper()] = 'hatch-solid'
                    styles[int(entity.dxf.get('hatch_style', 0) or 0)] += 1
                else:
                    kinds[entity.dxf.handle.upper()] = 'hatch-pattern'

    scan(document.modelspace())
    for layout in document.layouts:
        if layout.name.lower() != 'model':
            scan(layout)
    for block in document.blocks:
        if not block.name.lower().startswith(('*model', '*paper')):
            scan(block)
    return kinds, styles


def main():
    geometry = json.loads(GEOMETRY.read_text()) if GEOMETRY.exists() else {'files': {}}
    verified = geometry.get('files', {})
    files = sorted(REAL.glob('*.dxf')) + [FIXTURES / 'fill_holes_curves.dxf',
                                          FIXTURES / 'ocs_extrusion.dxf']
    rows = []
    failures = []
    totals = Counter()
    for path in files:
        envelope = read_dxf(str(path), path.read_bytes())
        document = envelope['document']
        registry = document['extensions']['org.cad-preview.fill/1']
        fills = registry['fills']
        skipped = registry['skipped']
        kinds, styles = classify(path)
        filled_handles = set()
        filled_by_kind = Counter()
        solid_filled = 0
        for entity_id, record in fills.items():
            handle = document['drawing']['entities'][entity_id]['sourceRefs'][0]['objectKey'].upper()
            filled_handles.add(handle)
            filled_by_kind[record['sourceKind']] += 1
            solid_filled += int(record['solid'])
        refused = {}
        for row in skipped:
            handle = row['handle'].upper()
            refused[handle] = row['reason']
        solid_handles = {handle for handle, kind in kinds.items() if kind != 'hatch-pattern'}
        pattern_handles = {handle for handle, kind in kinds.items() if kind == 'hatch-pattern'}
        missing = sorted(solid_handles - filled_handles - set(refused))
        extra = sorted((filled_handles | set(refused)) - set(kinds))
        pattern_filled = sorted(pattern_handles & filled_handles)
        pattern_unrefused = sorted(pattern_handles - set(refused) - filled_handles)
        unknown = sorted({reason for reason in refused.values()
                          if reason not in REFUSAL_REASONS
                          and not reason.startswith(('hatch-edge-unsupported', 'hatch-pattern-'))})
        row = {
            'file': path.name,
            'source': {'hatch': sum(1 for kind in kinds.values() if kind.startswith('hatch')),
                       'hatchSolid': sum(1 for kind in kinds.values() if kind == 'hatch-solid'),
                       'hatchPattern': len(pattern_handles),
                       'solid': sum(1 for kind in kinds.values() if kind == 'SOLID'),
                       'hatchStyles': dict(sorted(styles.items()))},
            'fills': {'total': len(fills), 'byKind': dict(sorted(filled_by_kind.items()))},
            'refused': dict(sorted(Counter(refused.values()).items())),
            'verified': verified.get(path.name, {}),
            'gaps': {'missingSolid': missing, 'unknownHandles': extra,
                     'patternUnaccounted': pattern_unrefused},
            'patterns': {'filled': len(pattern_filled),
                         'refused': len(pattern_handles & set(refused))},
        }
        totals['solidFills'] += len(solid_handles)
        totals['filled'] += solid_filled
        totals['refused'] += len(solid_handles & set(refused))
        totals['patternFills'] += len(pattern_filled)
        totals['patternRefused'] += len(pattern_handles & set(refused))
        totals['checked'] += int(row['verified'].get('checked', 0))
        rows.append(row)
        for label, values in (('solid neither filled nor refused', missing),
                              ('filled/refused handle not found in source', extra),
                              ('pattern hatch neither filled nor refused', pattern_unrefused),
                              ('undocumented refusal reason', unknown)):
            if values:
                failures.append('%s: %s %s' % (path.name, label, values))
        for entity_id, record in fills.items():
            if record['sourceKind'] == 'HATCH' and record['hatchStyle'] not in (0, 1, 2):
                failures.append('%s: filled hatch style %s' % (path.name, record['hatchStyle']))
            if record['sourceKind'] == 'HATCH' and record['hatchStyle'] in (1, 2) and \
                    len(record['boundaries']) > 1:
                failures.append('%s: multipath style %d hatch was filled'
                                % (path.name, record['hatchStyle']))
    if dict(totals) != EXPECTED_TOTALS:
        failures.append('corpus totals changed: expected %s, got %s'
                        % (EXPECTED_TOTALS, dict(totals)))
    profile = {'schemaVersion': 'dxf-fill-ledger/1', 'generatedAt': '2026-10-19',
               'note': 'Every HATCH/SOLID is drawn or explicitly refused; pattern strokes '
                       'are counted separately; solid verified counts come from dxf-fill-geometry.json.',
               'totals': dict(totals), 'files': rows, 'failures': failures}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    for row in rows:
        print('%-34s solid %3d filled %3d refused %3d checked %3d' % (
            row['file'], row['source']['hatchSolid'] + row['source']['solid'],
            row['fills']['total'], sum(row['refused'].values()),
            int(row['verified'].get('checked', 0))))
    print(json.dumps(dict(totals)))
    for failure in failures:
        print('FAIL', failure)
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
