"""Consistency check for DXF_CAPABILITY_MATRIX.json and the DXF rows in
CAPABILITY_MATRIX.json.

The check is deliberately code-derived: supported types, unsupported reasons, engine
version and input limits are re-imported from unified/dxf_adapter.py and compared with
the published JSON; error codes must exist in the worker/server that emits them; every
evidence path must exist; the project-wide matrix must agree with the detailed one.

Run:  python3 check_capability_dxf.py     (exit 0 only when everything matches)
"""
from dev_paths import DATA, BROWSER
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = DATA
sys.path.insert(0, str(ROOT))
from unified.dxf_adapter import (  # noqa: E402
    ANNOTATION_ENTITIES, CORE_ENTITIES, ENGINE, FILL_ENTITIES, MAX_CURVE_SEGMENTS,
    MAX_ENTITIES, MAX_PROJECTION_DRAWS, RELEASE, UNSUPPORTED_REASONS,
)

DXF_MATRIX = PROJECT / 'DXF_CAPABILITY_MATRIX.json'
ROOT_MATRIX = PROJECT / 'CAPABILITY_MATRIX.json'
ERROR_SOURCES = [ROOT / 'unified' / 'dxf_adapter.py', ROOT / 'dxf_convert.py', ROOT.parent / 'dev/server.py']
STATUSES = {'verified-scope', 'partial', 'experimental', 'unsupported', 'failed'}
failures = []


def check(label, condition, detail=None):
    if not condition:
        failures.append(label + (': ' + json.dumps(detail, ensure_ascii=False) if detail is not None else ''))
    print(('PASS ' if condition else 'FAIL ') + label)


def main():
    dxf = json.loads(DXF_MATRIX.read_text())
    root = json.loads(ROOT_MATRIX.read_text())

    check('dxf-matrix-format', dxf.get('format') == 'DXF')
    check('status-vocabulary-complete', set(dxf['statusVocabulary']) == STATUSES, sorted(dxf['statusVocabulary']))

    mapping = dxf['entityMapping']
    check('supported-entity-registry', [r['dxf'] for r in mapping['supported']] == list(CORE_ENTITIES),
          [r['dxf'] for r in mapping['supported']])
    check('annotation-entity-registry', [r['dxf'] for r in mapping['annotations']] == list(ANNOTATION_ENTITIES),
          [r['dxf'] for r in mapping['annotations']])
    check('unsupported-registry', {r['dxf']: r['reason'] for r in mapping['unsupported']} == UNSUPPORTED_REASONS)
    check('filled-entity-registry', [r['dxf'] for r in mapping.get('filled', [])] == list(FILL_ENTITIES),
          [r['dxf'] for r in mapping.get('filled', [])])
    names = ([r['dxf'] for r in mapping['supported']] + [r['dxf'] for r in mapping.get('filled', [])]
             + [r['dxf'] for r in mapping['annotations']] + [r['dxf'] for r in mapping['unsupported']])
    check('entity-mapping-no-overlap', len(names) == len(set(names)), sorted({n for n in names if names.count(n) > 1}))
    check('unsupported-has-reasons', all(r['reason'].strip() for r in mapping['unsupported']))
    check('filled-have-support', all(r['support'].strip() and r['ucd'] == 'hatch' for r in mapping.get('filled', [])))

    engine = dxf['engine']
    check('engine-version', engine['version'] == ENGINE, {'matrix': engine['version'], 'code': ENGINE})
    check('engine-pin-file', (ROOT / engine['pin']).exists(), engine['pin'])

    limits = dxf['input']
    check('limit-max-entities', limits['maxEntities'] == MAX_ENTITIES, {'matrix': limits['maxEntities'], 'code': MAX_ENTITIES})
    check('limit-max-draws', limits['maxProjectionDraws'] == MAX_PROJECTION_DRAWS)
    check('limit-max-segments', limits['maxSegmentsPerCurve'] == MAX_CURVE_SEGMENTS)
    check('limit-transport', limits['transportProfiles'] == ['ucd-base64-envelope/1', 'ucd-binary-manifest/1'], limits['transportProfiles'])
    check('limit-transport-default', limits['transportDefault'] == 'ucd-base64-envelope/1')
    check('limit-model-query', 'model=ucd' in limits['modelQuery'])
    check('limit-binary-and-dwg-disabled', limits['binaryDxf'] is False and limits['dwg'] is False)

    versions = dxf['sourceVersions']['verified']
    check('versions-declared-in-release', all(v in RELEASE for v in versions), versions)
    verification_path = PROJECT / dxf['evidence']['verification']
    check('verification-artifact-exists', verification_path.exists(), str(verification_path))
    if verification_path.exists():
        verification = json.loads((verification_path.parent / 'VERIFICATION.json').read_text())
        observed = {row['dxf_version'] for row in verification['samples']}
        check('versions-match-verified-samples', set(versions) == observed, {'matrix': sorted(versions), 'samples': sorted(observed)})
        check('verification-all-pass', verification['summary']['failed'] == 0, verification['summary'])

    sources = '\n'.join(path.read_text() for path in ERROR_SOURCES if path.exists())
    codes = [entry['code'] for entry in dxf['errorClassification']]
    check('error-codes-unique', len(codes) == len(set(codes)))
    for code in codes:
        check('error-code-emitted:' + code, code in sources)

    check('capability-statuses-valid', all(row['status'] in STATUSES for row in dxf['capabilities']),
          sorted({row['status'] for row in dxf['capabilities']} - STATUSES))
    levels = dxf.get('evidenceLevels', {})
    check('evidence-levels-declared', set(levels) == {'A', 'B', 'C'}, sorted(levels))
    for row in dxf['capabilities']:
        check('evidence-level-valid:' + row['feature'],
              bool(row.get('evidenceLevel')) and set(row['evidenceLevel']) <= set(levels), row.get('evidenceLevel'))
    gaps = dxf.get('schemaGaps', [])
    check('schema-gaps-structured', all({'id', 'field', 'schemaState', 'resolution', 'compatibility'} <= set(gap) for gap in gaps),
          [gap.get('id') for gap in gaps])
    check('schema-gap-colour-claim-withdrawn',
          any(gap['id'] == 'style-colour-modes' and gap['schemaState'] == 'supported' for gap in gaps))
    check('schema-gap-hatch-inline', any(gap['id'] == 'hatch-inline-boundaries' for gap in gaps))
    info = dxf.get('projectInfo', {})
    check('project-version', info.get('phase') == 'K' and info.get('version') == '2.0.0-phase-k'
          and info.get('ucdSchema') == 'urn:cad-preview:ucd:2.0.0', info)
    mapping = {row['dxf']: row for row in dxf['entityMapping']['supported']}
    check('line-is-wcs', 'WCS' in mapping['LINE']['note']
          and 'no OCS' in mapping['LINE']['note'], mapping['LINE']['note'])
    hatch_note = next(row for row in dxf['entityMapping']['filled'] if row['dxf'] == 'HATCH')['note']
    check('hatch-note-matches-code',
          'bulge' in hatch_note and 'unpaired' in hatch_note and 'cancel' in hatch_note,
          hatch_note)
    fill_source = ((ROOT / 'unified' / 'dxf_fill.py').read_text()
                   + (ROOT / 'unified' / 'dxf_adapter.py').read_text())
    for entry in dxf.get('entityReasonCodes', []):
        check('entity-reason-emitted:' + entry['prefix'], entry['prefix'] in fill_source, entry)
    for row in dxf['capabilities']:
        check('evidence-present:' + row['feature'], bool(row.get('evidence')) and bool(row.get('scope')))
        for entry in row.get('evidence', []):
            target = entry['artifact']
            exists = (PROJECT / target).exists()
            check('evidence-exists:' + target, exists)
        check('limitations-present:' + row['feature'], bool(row.get('limitations')))

    # Evidence profiles must still contain the counts the matrix text relies on.
    profile_dir = PROJECT / 'phase_j_evidence' / 'profiles'

    def profile(name):
        return json.loads((profile_dir / name).read_text())

    geometry = profile('dxf-fill-geometry.json')
    check('fill-geometry-summary', geometry.get('summary', {}).get('checked') == 560
          and geometry.get('summary', {}).get('failed') == 0, geometry.get('summary'))
    ledger = profile('dxf-fill-ledger.json')
    check('fill-ledger-totals', ledger.get('totals') == {'solidFills': 564, 'filled': 561,
                                                         'refused': 94, 'checked': 560},
          ledger.get('totals'))
    style = profile('hatch-style.json')
    check('hatch-style-cases', len(style.get('cases', [])) == 20 and not style.get('failures'),
          {'cases': len(style.get('cases', [])), 'failures': style.get('failures')})
    gradient = profile('hatch-gradient.json')
    check('hatch-gradient-cases', len(gradient.get('cases', [])) == 4
          and not gradient.get('failures')
          and {case.get('case') for case in gradient.get('cases', [])}
          == {'solid', 'pattern', 'gradient', 'gradient-kind0-solid'},
          {'cases': len(gradient.get('cases', [])), 'failures': gradient.get('failures')})
    tolerance = profile('hatch-tolerance.json')
    check('hatch-tolerance-cases', len(tolerance.get('cases', [])) == 9
          and not tolerance.get('failures'), {'cases': len(tolerance.get('cases', [])),
                                              'failures': tolerance.get('failures')})
    audit = profile('refusal-audit.json')
    check('refusal-audit-samples', len(audit.get('samples', [])) == 14
          and not audit.get('failures'), {'samples': len(audit.get('samples', [])),
                                          'failures': audit.get('failures')})
    # Followup keeps the unresolved 225A difference; historical exports remain inputs.
    followup = PROJECT / 'phase_k_evidence' / 'followup'
    visual = json.loads((followup / 'dxf-cad-visual.json').read_text())
    check('cad-visual-recorded', visual.get('summary', {}).get('files') == 4
          and visual.get('summary', {}).get('matched') == 15
          and visual.get('summary', {}).get('renderOnly') == 1
          and not visual.get('failures'), visual.get('summary'))
    check('cad-visual-unresolved-difference-retained',
          visual['areaComparison']['matched'] == 14
          and visual['areaComparison']['diverged'] == 1
          and not visual['areaComparison']['rendererArtifacts'])
    verification = json.loads((followup / 'dxf-cad-visual-verification.json').read_text())
    check('cad-visual-independent-verification',
          verification.get('librecadRequired') is False and not verification.get('failures')
          and len(verification.get('results', [])) == 4, verification.get('failures'))

    dxf_rows = {row['capability']: row for row in root['rows'] if row['format'] == 'DXF'}
    detailed = {row['feature']: row for row in dxf['capabilities']}
    check('root-matrix-dxf-rows', set(dxf_rows) == set(detailed), {'root': sorted(set(dxf_rows) - set(detailed)),
                                                                   'detailed': sorted(set(detailed) - set(dxf_rows))})
    mismatched = {name: {'detailed': detailed[name]['status'], 'root': dxf_rows[name]['status']}
                  for name in set(dxf_rows) & set(detailed) if detailed[name]['status'] != dxf_rows[name]['status']}
    check('root-matrix-status-agrees', not mismatched, mismatched)
    check('root-matrix-phase', root.get('phase') == 'K', root.get('phase'))
    root_levels = {name: row.get('evidenceLevel') for name, row in dxf_rows.items()}
    check('root-matrix-evidence-levels-agree',
          all(root_levels[name] == detailed[name].get('evidenceLevel') for name in detailed), root_levels)

    # Runtime wiring that the matrix claims must exist.
    for relative in ['public/drawing-projection.js', 'public/drawing-viewer.js', 'dxf_convert.py',
                     'samples/QCAD_flange.dxf', 'samples/byblock_bylayer.dxf', 'samples/frozen_layers_r12.dxf']:
        check('wiring-exists:' + relative, (ROOT / relative).exists())

    print()
    print('FAILURES: ' + str(len(failures)))
    for failure in failures:
        print(' - ' + failure)
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
