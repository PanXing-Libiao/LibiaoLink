"""OCS / extrusion audit for the DXF adapter.

The audit answers one question: does any WCS entity (LINE, POINT, ELLIPSE, 3D POLYLINE)
get pushed through the OCS transform a second time, and do OCS entities (CIRCLE, ARC,
LWPOLYLINE, SOLID, HATCH) get transformed exactly once?

The independent side reads raw group codes from the fixture and applies the DXF
arbitrary-axis algorithm implemented here. The UCD side is the parsed envelope. No
ezdxf on the independent side.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
PROJECT = DATA
sys.path.insert(0, str(APP))
from unified.dxf_adapter import read_dxf  # noqa: E402
from unified.validation import validate_envelope  # noqa: E402

FIXTURE = PROJECT / 'phase_j_evidence' / 'fixtures' / 'ocs_extrusion.dxf'
OUT = PROJECT / 'phase_j_evidence' / 'profiles' / 'dxf-ocs-audit.json'
TOL = 1e-9


def group_codes(path):
    lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    pairs = []
    for i in range(0, len(lines) - 1, 2):
        try:
            code = int(lines[i].strip())
        except ValueError:
            continue
        pairs.append((code, lines[i + 1].strip()))
    return pairs


def raw_entities(path):
    section = None
    current = None
    out = []
    for code, value in group_codes(path):
        if code == 0 and value == 'SECTION':
            section = 'PENDING'
            continue
        if section == 'PENDING' and code == 2:
            section = value
            continue
        if code == 0:
            if current is not None:
                out.append(current)
                current = None
            if section in ('ENTITIES', 'BLOCKS'):
                current = {'type': value, 'tags': []}
            continue
        if current is not None:
            current['tags'].append((code, value))
    if current is not None:
        out.append(current)
    return out


def values(tags, code):
    return [v for c, v in tags if c == code]


def first(tags, code, default=None):
    for c, v in tags:
        if c == code:
            return v
    return default


def point(tags, base):
    x, y, z = first(tags, base), first(tags, base + 10), first(tags, base + 20)
    return (float(x), float(y), float(z or 0.0))


def normalize(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def ocs_to_wcs(x, y, z, normal):
    """AutoCAD arbitrary axis algorithm, implemented from the DXF reference."""
    n = normalize(normal)
    if abs(n[0]) < 1.0 / 64.0 and abs(n[1]) < 1.0 / 64.0:
        ax = normalize(cross((0.0, 1.0, 0.0), n))
    else:
        ax = normalize(cross((0.0, 0.0, 1.0), n))
    ay = cross(n, ax)
    return tuple(ax[i] * x + ay[i] * y + n[i] * z for i in range(3))


def extrusion(tags):
    return point(tags, 210) if first(tags, 210) is not None else (0.0, 0.0, 1.0)


def apply(matrix, point3):
    x, y, z = point3
    return (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
            matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
            matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14])


def close(a, b, tolerance=TOL):
    return all(abs(a[i] - b[i]) <= tolerance for i in range(3))


def identity_matrix(matrix):
    return close(tuple(matrix)[:3], (1.0, 0.0, 0.0)) and close(tuple(matrix)[4:7], (0.0, 1.0, 0.0)) \
        and close(tuple(matrix)[8:11], (0.0, 0.0, 1.0)) and close(tuple(matrix)[12:15], (0.0, 0.0, 0.0))


def hatch_paths(tags):
    """Return [(flags, [(x, y), ...])] for polyline boundary paths."""
    index = 0
    while index < len(tags) and tags[index][0] != 91:
        index += 1
    count = int(tags[index][1])
    index += 1
    paths = []
    for _ in range(count):
        while index < len(tags) and tags[index][0] != 92:
            index += 1
        flags = int(tags[index][1])
        index += 1
        has_bulge = int(tags[index][1])
        index += 1
        vertices = int(tags[index][1])
        index += 1
        points = []
        for _ in range(vertices):
            x = y = None
            while x is None or y is None:
                if tags[index][0] == 10:
                    x = float(tags[index][1])
                elif tags[index][0] == 20:
                    y = float(tags[index][1])
                index += 1
            if has_bulge:
                index += 1
            points.append((x, y))
        paths.append((flags, points))
    return paths


def record(tag, detail):
    return {'check': tag, 'detail': detail}


def main():
    envelope = read_dxf(str(FIXTURE), FIXTURE.read_bytes())
    validate_envelope(envelope)
    document = envelope['document']
    drawing = document['drawing']
    sha = document['sources'][0]['sha256']
    entity_by_handle = {}
    for eid, entity in drawing['entities'].items():
        for ref in entity.get('sourceRefs', []):
            entity_by_handle[ref['objectKey'].upper()] = entity
    checks = []
    failures = []

    def expect(ok, label, detail=''):
        checks.append({'check': label, 'ok': bool(ok), 'detail': detail})
        if not ok:
            failures.append(label + (': ' + detail if detail else ''))

    raw = {first(record['tags'], 5).upper(): record for record in raw_entities(FIXTURE)
           if first(record['tags'], 5)}
    fill_ext = document['extensions']['org.cad-preview.fill/1']
    skip_reasons = {row['handle'].upper(): row['reason'] for row in fill_ext['skipped']}

    # 1. WCS entities must not move at all, and must keep an identity local matrix.
    for handle, label in (('100', 'LINE'), ('101', 'POINT')):
        entity = entity_by_handle[handle]
        expect(identity_matrix(entity['localFromOwner']), label + ' localFromOwner is identity',
               json.dumps(entity['localFromOwner'][:3]))
    line = entity_by_handle['100']
    expect(close(tuple(line['geometry']['start']), tuple(point(raw['100']['tags'], 10))), 'LINE start unchanged by extrusion')
    expect(close(tuple(line['geometry']['end']), tuple(point(raw['100']['tags'], 11))), 'LINE end unchanged by extrusion')
    point_entity = entity_by_handle['101']
    expect(close(tuple(point_entity['geometry']['position']), tuple(point(raw['101']['tags'], 10))), 'POINT unchanged by extrusion')

    ellipse = entity_by_handle['102']
    expect(identity_matrix(ellipse['localFromOwner']), 'ELLIPSE localFromOwner is identity (WCS entity)')
    expect(close(tuple(ellipse['geometry']['center']), tuple(point(raw['102']['tags'], 10))), 'ELLIPSE center is WCS')

    poly3d = entity_by_handle['103']
    expect(identity_matrix(poly3d['localFromOwner']), '3D POLYLINE localFromOwner is identity (WCS entity)')
    raw_vertices = [point(record['tags'], 10) for record in raw_entities(FIXTURE)
                    if record['type'] == 'VERTEX']
    expect(len(poly3d['geometry']['points']) == len(raw_vertices), '3D POLYLINE keeps every raw vertex')
    for got, want in zip(poly3d['geometry']['points'], raw_vertices):
        expect(close(tuple(got), want), '3D POLYLINE vertex is WCS', str(want))

    # 2. OCS entities: exactly one transform, checked against the independent algorithm.
    circle = entity_by_handle['104']
    expected = ocs_to_wcs(10.0, 0.0, 0.0, extrusion(raw['104']['tags']))
    expect(close(apply(circle['localFromOwner'], tuple(circle['geometry']['center'])), expected),
           'CIRCLE applies OCS exactly once', str(expected))

    arc = entity_by_handle['105']
    expected = ocs_to_wcs(12.0, 3.0, 0.0, extrusion(raw['105']['tags']))
    expect(close(apply(arc['localFromOwner'], tuple(arc['geometry']['center'])), expected),
           'ARC applies OCS exactly once', str(expected))

    lwpoly = entity_by_handle['106']
    raw_points = []
    tags = raw['106']['tags']
    index = 0
    while index < len(tags):
        if tags[index][0] == 10:
            raw_points.append((float(tags[index][1]), float(tags[index + 1][1]), 3.0))
            index += 2
        else:
            index += 1
    expect(len(lwpoly['geometry']['points']) == len(raw_points), 'LWPOLYLINE keeps every vertex')
    for got, want in zip(lwpoly['geometry']['points'], raw_points):
        expect(close(apply(lwpoly['localFromOwner'], tuple(got)), ocs_to_wcs(want[0], want[1], want[2], (0, 0, -1))),
               'LWPOLYLINE applies OCS exactly once', str(want))

    # 3. Fills: boundary entities hold WCS points; triangles lie in the same plane.
    solid = fill_ext['fills']
    solid_handles = {document['drawing']['entities'][eid]['sourceRefs'][0]['objectKey'].upper(): eid
                     for eid in solid}
    solid_fill = solid[solid_handles['107']]
    boundary_points = []
    for row in solid_fill['boundaries']:
        boundary_points.extend(document['drawing']['entities'][row['entityId']]['geometry']['points'])
    raw_corners = [point(raw['107']['tags'], base) for base in (10, 11, 12, 13)]
    expected_corners = [ocs_to_wcs(p[0], p[1], float(first(raw['107']['tags'], 30, 0)), extrusion(raw['107']['tags']))
                        for p in (raw_corners[0], raw_corners[1], raw_corners[3], raw_corners[2])]
    for want in expected_corners:
        expect(any(close(tuple(got), want) for got in boundary_points), 'SOLID boundary point is WCS', str(want))

    # 4. HATCH style semantics (group code 75) and explicit refusal.
    expect('108' in solid_handles, 'style-0 hatch with a hole is filled')
    expect(solid[solid_handles['108']]['hatchStyle'] == 0, 'style-0 hatch records hatchStyle 0')
    expect(solid_handles.get('109') is not None and solid[solid_handles['109']]['hatchStyle'] == 1,
           'style-1 single-boundary hatch is filled and records hatchStyle 1')
    expect(skip_reasons.get('10A') == 'hatch-style-unsupported:1-multipath',
           'style-1 multipath hatch is explicitly refused', str(skip_reasons.get('10A')))
    expect(skip_reasons.get('10B') == 'pattern-fill-unsupported',
           'pattern hatch is explicitly refused', str(skip_reasons.get('10B')))

    # 5. The hole hatch keeps both rings; the actual filled area (100 - 16) is checked
    # against the triangle representation by check_dxf_fill.py.
    expect(len(solid[solid_handles['108']]['boundaries']) == 2, 'hole hatch keeps outer ring and hole')
    expect(solid[solid_handles['108']]['triangleCount'] > 0, 'hole hatch has display triangles',
           str(solid[solid_handles['108']]['triangleCount']))

    profile = {'schemaVersion': 'dxf-ocs-audit/1', 'generatedAt': '2026-10-19',
               'fixture': 'phase_j_evidence/fixtures/ocs_extrusion.dxf',
               'independentSide': 'raw group-code reader + arbitrary-axis algorithm in tests/check_dxf_ocs.py',
               'ucdSide': 'parsed envelope (geometry, localFromOwner, fill extension)',
               'checks': checks, 'failures': failures,
               'summary': {'checks': len(checks), 'failed': len(failures)}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(profile['summary'], ensure_ascii=False))
    for failure in failures:
        print('FAIL', failure)
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
