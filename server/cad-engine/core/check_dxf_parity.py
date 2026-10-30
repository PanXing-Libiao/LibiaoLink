"""Compare the browser projection module (via Node) with the Python reference.

The browser rebuilds a DrawingProjection for every model space and layout without
re-parsing the DXF; this test proves that both implementations resolve the same
draw ids, order, visibility, styles, block paths and viewport placement from one
UCD document. Run:  .phase-work/dxf/bin/python check_dxf_parity.py
"""
from dev_paths import DATA, BROWSER
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from unified.dxf_adapter import read_dxf, project_drawing  # noqa: E402

EVIDENCE = DATA / 'phase_i_evidence'
OUT = DATA / 'phase_k_evidence/followup/dxf-projection-parity.json'
DIFF_LIMIT = 3


def normalise(projection):
    draws = {}
    for draw_id, draw in projection['draws'].items():
        draws[draw_id] = {
            'itemId': draw['itemId'], 'kind': draw['kind'], 'drawOrder': draw['drawOrder'],
            'visibility': draw['visibility'], 'availability': draw['availability'],
            'viewportId': draw.get('viewportId'), 'localToSpace': [round(v, 9) for v in draw['localToSpace']],
            'style': json.loads(json.dumps(draw['style'], sort_keys=True)),
            'blockPath': [{k: step[k] for k in ('instanceId', 'row', 'column')} for step in draw['blockPath']],
        }
    return {'drawingId': projection['drawingId'], 'draws': draws, 'effectiveLayers': projection.get('_effectiveLayers'),
            'layerStates': projection['layerStates'], 'viewports': sorted(projection.get('viewports') or {})}


def diff(a, b, path='', out=None):
    out = out if out is not None else []
    if len(out) >= DIFF_LIMIT:
        return out
    if type(a) is not type(b) and not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
        out.append({'path': path, 'python': a, 'browser': b}); return out
    if isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            if key not in a or key not in b:
                out.append({'path': path + '/' + key, 'python': a.get(key), 'browser': b.get(key)})
            else:
                diff(a[key], b[key], path + '/' + key, out)
            if len(out) >= DIFF_LIMIT:
                break
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append({'path': path + '/length', 'python': len(a), 'browser': len(b)}); return out
        for index, (x, y) in enumerate(zip(a, b)):
            diff(x, y, path + '/%d' % index, out)
            if len(out) >= DIFF_LIMIT:
                break
    elif isinstance(a, float) or isinstance(b, float):
        if not (math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)):
            out.append({'path': path, 'python': a, 'browser': b})
    elif a != b:
        out.append({'path': path, 'python': a, 'browser': b})
    return out


def main():
    samples = sorted((EVIDENCE / 'samples' / 'real').glob('*.dxf'))
    rows = []
    failed = []
    with tempfile.TemporaryDirectory() as temp:
        temp = Path(temp)
        for dxf in samples:
            raw = dxf.read_bytes()
            env = read_dxf(str(dxf), raw)
            document = env['document']
            drawing = document['drawing']
            model_space = drawing['drawings'][next(iter(drawing['drawings']))]['modelSpaceId']
            targets = [{'kind': 'model', 'spaceId': model_space}]
            targets += [{'kind': 'layout', 'layoutId': layout_id} for layout_id in drawing['layouts']]
            reference = {}
            for target in targets:
                key = 'model' if target['kind'] == 'model' else target['layoutId']
                layers = {}
                projection = project_drawing(document, target, layers)
                reference[key] = normalise({**projection, '_effectiveLayers': layers})
            payload = {'drawing': drawing, 'extensions': document['extensions']}
            ucd_path = temp / (dxf.stem + '.json')
            out_path = temp / (dxf.stem + '.projection.json')
            ucd_path.write_text(json.dumps(payload, ensure_ascii=False))
            subprocess.run([str(ROOT / 'tests' / 'run_node.sh'), str(ROOT / 'tests' / 'parity_projection.mjs'),
                            str(ucd_path), str(out_path)], check=True, timeout=300)
            browser = {key: normalise(value) for key, value in json.loads(out_path.read_text()).items()}
            difference = []
            for key, expected in reference.items():
                if key not in browser:
                    difference.append({'path': key, 'python': 'present', 'browser': 'missing'}); continue
                difference += diff(expected, browser[key], key)
                if len(difference) >= DIFF_LIMIT:
                    break
            row = {'file': dxf.name, 'spaces': list(reference), 'draws': len(reference['model']['draws']),
                   'drawIdsEqual': not difference, 'differences': difference[:DIFF_LIMIT]}
            rows.append(row)
            if difference:
                failed.append(row)
    result = {'schemaVersion': 'dxf-projection-parity/1', 'generatedAt': '2026-10-19',
              'reference': 'unified/dxf_adapter.py project_drawing', 'browser': 'public/drawing-projection.js',
              'summary': {'samples': len(rows), 'spaces': sum(len(r['spaces']) for r in rows),
                          'identical': sum(1 for r in rows if r['drawIdsEqual']), 'failed': len(failed)},
              'samples': rows}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(result['summary'], ensure_ascii=False))
    for row in failed:
        print(row['file'], json.dumps(row['differences'], ensure_ascii=False)[:600])
    return 0 if not failed else 1


if __name__ == '__main__':
    raise SystemExit(main())
