"""HATCH fill-mode recognition: solid vs pattern vs gradient.

A DXF gradient hatch sets solid_fill=1 and pattern_name=SOLID, exactly like a solid
fill, and only group 450 kind=1 distinguishes it. This check publishes a small AC1018
fixture with one of each mode and asserts that the adapter fills the solid only,
refusing the pattern and the gradient with distinct reasons.

Run:  python3 tests/check_hatch_gradient.py
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import json
import sys
from pathlib import Path

import ezdxf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from unified.dxf_adapter import read_dxf  # noqa: E402

FIXTURE = DATA / 'phase_j_evidence' / 'fixtures' / 'hatch_fill_modes.dxf'
OUT = DATA / 'phase_j_evidence' / 'profiles' / 'hatch-gradient.json'


def square(path, x0, y0):
    path.add_line((x0, y0), (x0 + 10, y0))
    path.add_line((x0 + 10, y0), (x0 + 10, y0 + 10))
    path.add_line((x0 + 10, y0 + 10), (x0, y0 + 10))
    path.add_line((x0, y0 + 10), (x0, y0))


def build(path):
    doc = ezdxf.new('AC1018')
    msp = doc.modelspace()

    solid = msp.add_hatch()
    solid.set_solid_fill(color=2)
    square(solid.paths.add_edge_path(flags=1), 0, 0)

    pattern = msp.add_hatch()
    pattern.set_pattern_fill('ANSI31', color=3, scale=2.0)
    square(pattern.paths.add_edge_path(flags=1), 20, 0)

    gradient = msp.add_hatch()
    gradient.set_gradient(color1=(255, 0, 0), color2=(0, 0, 255), name='LINEAR')
    square(gradient.paths.add_edge_path(flags=1), 40, 0)

    # Group 450 kind=0 is the standard's solid form, even if group 70 is absent.
    solid450 = msp.add_hatch()
    solid450.set_gradient(color1=(0, 255, 0), color2=(0, 0, 0), name='LINEAR')
    solid450.gradient.kind = 0
    square(solid450.paths.add_edge_path(flags=1), 60, 0)

    doc.saveas(path)
    return (solid.dxf.handle, pattern.dxf.handle, gradient.dxf.handle,
            solid450.dxf.handle)


def main():
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    handles = build(FIXTURE)
    env = read_dxf(FIXTURE, FIXTURE.read_bytes())
    ext = env['document']['extensions']['org.cad-preview.fill/1']
    fills = ext['fills']
    filled_handles = {
        ref.get('objectKey')
        for entity_id in fills
        for ref in env['document']['drawing']['entities'][entity_id].get('sourceRefs', [])
    }
    skipped = {entry['handle']: entry['reason'] for entry in ext['skipped']}

    # The fixture itself must show why group 70 is not enough.
    doc = ezdxf.readfile(FIXTURE)
    by_handle = {e.dxf.handle: e for e in doc.modelspace().query('HATCH')}
    gradient = by_handle[handles[2]]
    pattern = by_handle[handles[1]]

    cases = [
        {'case': 'solid', 'handle': handles[0], 'solidFillTag': int(by_handle[handles[0]].dxf.solid_fill),
         'gradientKind': None, 'fills': 1 if handles[0] in filled_handles else 0,
         'reason': skipped.get(handles[0]), 'expected': 'fill'},
        {'case': 'pattern', 'handle': handles[1], 'solidFillTag': int(pattern.dxf.solid_fill),
         'gradientKind': None, 'fills': 0, 'reason': skipped.get(handles[1]),
         'expected': 'pattern-fill-unsupported'},
        {'case': 'gradient', 'handle': handles[2], 'solidFillTag': int(gradient.dxf.solid_fill),
         'gradientKind': int(gradient.gradient.kind) if gradient.gradient else None,
         'fills': 1 if handles[2] in filled_handles else 0, 'reason': skipped.get(handles[2]),
         'expected': 'gradient-fill-unsupported'},
        {'case': 'gradient-kind0-solid', 'handle': handles[3],
         'solidFillTag': int(by_handle[handles[3]].dxf.solid_fill),
         'gradientKind': int(by_handle[handles[3]].gradient.kind),
         'fills': 1 if handles[3] in filled_handles else 0,
         'reason': skipped.get(handles[3]), 'expected': 'fill'},
    ]
    failures = []
    for case in cases:
        if case['expected'] == 'fill':
            ok = case['fills'] == 1 and case['reason'] is None
        else:
            ok = case['fills'] == 0 and case['reason'] == case['expected']
        case['ok'] = ok
        if not ok:
            failures.append(case)

    profile = {
        'schemaVersion': 'hatch-gradient/1',
        'fixture': str(FIXTURE.relative_to(DATA)),
        'fixtureSha256': hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
        'note': 'gradient and solid both can have DXF group 70 solid_fill=1; group 450 kind=1 is gradient, kind=0 is solid',
        'cases': cases,
        'failures': failures,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, indent=2) + '\n')
    print(json.dumps({'cases': len(cases), 'failed': len(failures)}))
    for failure in failures:
        print(' FAIL', failure)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
