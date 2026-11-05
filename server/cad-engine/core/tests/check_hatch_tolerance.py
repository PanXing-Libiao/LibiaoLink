"""HATCH boundary endpoint-tolerance conformance check.

The adapter pairs edge endpoints at an absolute tolerance of 1e-6 drawing units. The
value is justified by measurement, not by a sample: across 621 edge-path edges in the
11 real samples the largest nearest-endpoint mismatch is 6.6e-7 (arc endpoint
trigonometric round-off). This check exercises the two sides of that boundary at three
drawing scales:

* unordered but closed edges  -> must fill (source edge order is not semantic);
* a real 1e-5 gap             -> must refuse hatch-boundary-discontinuous;
* one missing edge            -> must refuse hatch-boundary-discontinuous.

The same absolute gap is used at every scale. It is deliberately not scaled with the
drawing: endpoint mismatch from arc round-off does not grow with drawing size, so a
relative tolerance would hide real gaps in large drawings.

Run:  python3 tests/check_hatch_tolerance.py
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import sys
import tempfile
from pathlib import Path

import ezdxf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from unified.dxf_adapter import read_dxf  # noqa: E402

OUT = DATA / 'phase_j_evidence' / 'profiles' / 'hatch-tolerance.json'
GAP = 1e-5
ORDER = [2, 0, 3, 1]


def edges(size, gap=0.0, drop=False):
    e0 = ((0.0, 0.0), (size, 0.0))
    e1 = ((size, 0.0), (size, size - gap))
    e2 = ((size, size), (0.0, size))
    e3 = ((0.0, size), (0.0, 0.0))
    result = [e0, e1, e2, e3]
    return result[:3] if drop else result


def build(path, scale, gap=0.0, drop=False):
    size = 10.0 * scale
    doc = ezdxf.new('AC1015')
    hatch = doc.modelspace().add_hatch()
    hatch.set_solid_fill(color=2)
    boundary = hatch.paths.add_edge_path(flags=1)
    ring = edges(size, gap, drop)
    for index in ORDER:
        if index >= len(ring):
            continue
        start, end = ring[index]
        boundary.add_line(start, end)
    hatch.dxf.hatch_style = 0
    doc.saveas(path)


def run_case(tmp, name, scale, gap=0.0, drop=False, expected='fill'):
    path = tmp / (name + '.dxf')
    build(path, scale, gap, drop)
    envelope = read_dxf(path, path.read_bytes())
    extension = envelope['document']['extensions']['org.cad-preview.fill/1']
    reasons = [skip['reason'] for skip in extension['skipped']]
    return {
        'case': name,
        'scale': scale,
        'absoluteGap': gap,
        'droppedEdge': drop,
        'fills': len(extension['fills']),
        'skipped': reasons,
        'expected': expected,
        'ok': ((len(extension['fills']) == 1 and not reasons) if expected == 'fill'
               else (not extension['fills'] and reasons == ['hatch-boundary-discontinuous'])),
    }


def main():
    cases = []
    failures = []
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        for scale in (1.0, 1e6, 1e-3):
            label = ('%g' % scale).replace('.', 'p')
            cases.append(run_case(tmp, 'closed-unordered-' + label, scale))
            cases.append(run_case(tmp, 'gap-' + label, scale, gap=GAP,
                                  expected='hatch-boundary-discontinuous'))
            cases.append(run_case(tmp, 'missing-edge-' + label, scale, drop=True,
                                  expected='hatch-boundary-discontinuous'))
        for case in cases:
            if not case['ok']:
                failures.append(case)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        'schemaVersion': 'hatch-tolerance/1',
        'endpointTolerance': 1e-6,
        'measuredNoise': {'max': 6.63e-7, 'p99': 3.83e-13, 'median': 4.8e-14,
                          'edges': 621, 'openComponents': 0},
        'gapUsed': GAP,
        'cases': cases,
        'failures': failures,
    }, indent=2) + '\n')
    print(json.dumps({'cases': len(cases), 'failed': len(failures)}))
    for failure in failures:
        print(' FAIL', failure)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
