"""HATCH group 75 (style) and group 92 (path flag) conformance check.

Builds tiny AC1015 files with ezdxf, then reads them through the product adapter and
asserts the published style rules. Group 75 values that ezdxf's validator would
normalise are patched in the saved ASCII DXF, which is also how a foreign writer can
produce them.

Cases:
  style 0, one ring        -> filled (odd-parity)
  style 1/2, one ring      -> filled (all styles select the same single area)
  style 1, two EXTERNAL    -> filled (style 1 uses EXTERNAL + OUTERMOST paths)
  style 2, two EXTERNAL    -> filled (style 2 uses EXTERNAL paths only)
  style 1/2, no EXTERNAL/OUTERMOST among multiple paths
                           -> refused hatch-style-unsupported:<n>-multipath
  style 3, one ring        -> refused hatch-style-unsupported:3 (raw group-code patch)
  group 75 removed         -> filled as style 0 (the documented DXF/ezdxf default)
  textbox-only path (92=8) -> refused hatch-textbox-only
  textbox mixed with body  -> body filled, textbox counted and skipped

Run:  python3 tests/check_hatch_style.py
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

OUT = DATA / 'phase_j_evidence' / 'profiles' / 'hatch-style.json'


def square(path, x0=0.0, y0=0.0, x1=10.0, y1=10.0):
    path.add_line((x0, y0), (x1, y0))
    path.add_line((x1, y0), (x1, y1))
    path.add_line((x1, y1), (x0, y1))
    path.add_line((x0, y1), (x0, y0))


def build(path, style, rings=1, textbox_only=False, flags=None, mixed_textbox=False):
    doc = ezdxf.new('AC1015')
    msp = doc.modelspace()
    hatch = msp.add_hatch()
    hatch.set_solid_fill(color=2)
    if mixed_textbox:
        mask = hatch.paths.add_edge_path(flags=8)
        square(mask, 0.0, 0.0, 5.0, 5.0)
        body = hatch.paths.add_edge_path(flags=1)
        square(body, 20.0, 0.0, 30.0, 10.0)
    else:
        for i in range(rings):
            ring_flags = 9 if textbox_only else (flags[i] if flags else 1)
            p = hatch.paths.add_edge_path(flags=ring_flags)
            square(p, i * 20.0, 0.0, i * 20.0 + 10.0, 10.0)
    hatch.dxf.hatch_style = style
    doc.saveas(path)


def patch_style(path, value):
    """Rewrite the HATCH 75 tag in the saved ASCII DXF (value None removes it)."""
    lines = path.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == 'HATCH')
    tag = next(i for i in range(start, len(lines) - 1) if lines[i].strip() == '75')
    if value is None:
        del lines[tag:tag + 2]
    else:
        lines[tag + 1] = str(value)
    path.write_text('\n'.join(lines) + '\n')


def run_case(tmp, name, style, rings=1, textbox_only=False, patch='keep',
             flags=None, mixed_textbox=False):
    p = tmp / (name + '.dxf')
    build(p, style, rings, textbox_only, flags, mixed_textbox)
    if patch != 'keep':
        patch_style(p, patch)
    env = read_dxf(p, p.read_bytes())
    ext = env['document']['extensions']['org.cad-preview.fill/1']
    return {
        'case': name,
        'sourceStyle': style if patch == 'keep' else patch,
        'rings': rings,
        'flags': flags,
        'fills': len(ext['fills']),
        'textboxPathsSkipped': sum(fill.get('textboxPathsSkipped', 0)
                                    for fill in ext['fills'].values()),
        'skipped': [s['reason'] for s in ext['skipped']],
    }


def main():
    failures = []
    cases = []
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        expectations = [
            ('style0-one-ring', 0, 1, False, 'keep', None, False, 'fill', 1, 0),
            ('style1-one-ring', 1, 1, False, 'keep', None, False, 'fill', 1, 0),
            ('style2-one-ring', 2, 1, False, 'keep', None, False, 'fill', 1, 0),
            ('style1-multipath-external', 1, 2, False, 'keep', None, False, 'fill', 1, 0),
            ('style2-multipath-external', 2, 2, False, 'keep', None, False, 'fill', 1, 0),
            ('style1-multipath-no-external', 1, 2, False, 'keep', [0, 0], False,
             'hatch-style-unsupported:1-multipath', 0, 0),
            ('style2-multipath-no-external', 2, 2, False, 'keep', [0, 0], False,
             'hatch-style-unsupported:2-multipath', 0, 0),
            ('style1-multipath-mixed-flags', 1, 3, False, 'keep', [1, 16, 0], False,
             'fill', 1, 0),
            ('style2-multipath-ignore-default', 2, 2, False, 'keep', [1, 0], False,
             'fill', 1, 0),
            ('style3', 1, 1, False, 3, None, False, 'hatch-style-unsupported:3', 0, 0),
            ('style-missing', 1, 1, False, None, None, False, 'fill', 1, 0),
            ('flags1-external', 0, 1, False, 'keep', [1], False, 'fill', 1, 0),
            ('flags4-derived', 0, 1, False, 'keep', [4], False, 'fill', 1, 0),
            ('flags16-outermost', 0, 1, False, 'keep', [16], False, 'fill', 1, 0),
            ('textbox-only', 0, 1, True, 'keep', None, False, 'hatch-textbox-only', 0, 0),
            ('textbox-mixed', 0, 1, False, 'keep', None, True, 'fill-mixed', 1, 1),
            ('flags-unknown-32', 0, 1, False, 'keep', [32], False,
             'hatch-path-flags-unsupported:32', 0, 0),
            ('style2-textbox-only', 2, 1, True, 'keep', None, False,
             'hatch-textbox-only', 0, 0),
            ('style1-textbox-mixed', 1, 1, False, 'keep', None, True, 'fill-mixed', 1, 1),
            ('style2-textbox-mixed', 2, 1, False, 'keep', None, True, 'fill-mixed', 1, 1),
        ]
        for (name, style, rings, textbox, patch, flags, mixed, expected,
             expected_fills, expected_textbox) in expectations:
            result = run_case(tmp, name, style, rings, textbox, patch, flags, mixed)
            cases.append(result)
            if expected in ('fill', 'fill-mixed'):
                ok = (result['fills'] == expected_fills and not result['skipped']
                      and result['textboxPathsSkipped'] == expected_textbox)
            else:
                ok = result['fills'] == 0 and result['skipped'] == [expected]
            result['expected'] = expected
            result['ok'] = ok
            if not ok:
                failures.append(result)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({'cases': cases, 'failures': failures}, indent=2) + '\n')
    print(json.dumps({'cases': len(cases), 'failed': len(failures)}))
    for f in failures:
        print(' FAIL', f)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
