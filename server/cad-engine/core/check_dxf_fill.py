"""Phase J fill verification.

Independent side: a small ASCII-DXF group-code reader in this file (test tooling, not
the product parser) extracts HATCH boundary edges and SOLID corners straight from the
file, pairs endpoints into loops without trusting source edge order, and computes ring
area / bounding boxes with exact line, circular-arc and polyline-bulge math (Green's
theorem). It also implements the DXF clockwise arc complementary-angle rule. UCD side:
the published triangle Representation is decoded from the envelope buffers.

The two sides share no code, so this is an independent structural check of the fill
geometry. It is *not* the independent CAD visual: that is a separate check,
tests/check_dxf_cad_visual.py, which renders the source with LibreCAD 2.2.1 and compares
the PDF fill paths. Structural and visual evidence are reported separately and are not
substitutes for each other.

Run:  python3 check_dxf_fill.py
"""
from dev_paths import DATA, BROWSER
import base64
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = DATA
sys.path.insert(0, str(ROOT))
from unified.adapter import identity  # noqa: E402
from unified.dxf_adapter import read_dxf  # noqa: E402
from unified.validation import validate_envelope  # noqa: E402

OUT = PROJECT / 'phase_j_evidence' / 'profiles' / 'dxf-fill-geometry.json'
MD = PROJECT / 'phase_j_evidence' / 'profiles' / 'dxf-fill-geometry.md'
TOL = 1e-6


def group_codes(path):
    text = path.read_text(encoding='utf-8', errors='replace')
    lines = text.splitlines()
    pairs = []
    for i in range(0, len(lines) - 1, 2):
        try:
            code = int(lines[i].strip())
        except ValueError:
            continue
        pairs.append((code, lines[i + 1].strip()))
    return pairs


def entities(path):
    pairs = group_codes(path)
    section = None
    current = None
    for code, value in pairs:
        if code == 0 and value == 'SECTION':
            section = 'PENDING'
            continue
        if section == 'PENDING' and code == 2:
            section = value
            continue
        if code == 0:
            if current is not None:
                yield current
                current = None
            if section in ('ENTITIES', 'BLOCKS'):
                current = {'type': value, 'tags': []}
            continue
        if current is not None:
            current['tags'].append((code, value))
    if current is not None:
        yield current


def tag(tags, code, default=None):
    for c, v in tags:
        if c == code:
            return v
    return default


def ocs_axes(record):
    """Arbitrary axis algorithm for OCS -> WCS (AutoCAD reference)."""
    nx = float(tag(record['tags'], 210, '0') or 0)
    ny = float(tag(record['tags'], 220, '0') or 0)
    nz = float(tag(record['tags'], 230, '1') or 1)
    if abs(nx) < 1 / 64 and abs(ny) < 1 / 64:
        x_axis = (-1.0, 0.0) if nz < 0 else (1.0, 0.0)
    else:
        length = math.hypot(nx, ny)
        x_axis = (ny / length, -nx / length)
    y_axis = (-nz * x_axis[1], nz * x_axis[0])
    det = x_axis[0] * y_axis[1] - x_axis[1] * y_axis[0]
    if abs(nz) < 1e-12:
        # side view: use the simple fallback that keeps the OCS x/y as horizontal axes
        x_axis, y_axis, det = (1.0, 0.0), (0.0, 1.0), 1.0
    def to_wcs(point):
        x, y = point
        return (x * x_axis[0] + y * y_axis[0], x * x_axis[1] + y * y_axis[1])
    return to_wcs, det


def shoelace(ring):
    area = 0.0
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area * 0.5


def arc_ring(cx, cy, r, a1, a2, ccw):
    start = math.radians(a1)
    end = math.radians(a2)
    if ccw and end <= start:
        end += 2 * math.pi
    if not ccw and end >= start:
        end -= 2 * math.pi
    steps = max(8, int(abs(end - start) / (math.pi / 90)))
    return [(cx + r * math.cos(start + (end - start) * i / steps),
             cy + r * math.sin(start + (end - start) * i / steps)) for i in range(steps + 1)]


def hatch_rings(record):
    """Return (rings, flags) as segment lists plus the group-92 path flags.

    Segment forms: ('line', p1, p2) or ('arc', c, r, a1, a2, ccw). Edge types other
    than line and arc (ellipse, spline) are reported as unverifiable instead of being
    approximated.
    """
    tags = record['tags']
    index = 0
    while index < len(tags) and tags[index][0] != 91:
        index += 1
    if index >= len(tags):
        raise ValueError('no boundary path count')
    count = int(tags[index][1])
    index += 1
    rings = []
    flags_list = []
    for _ in range(count):
        while index < len(tags) and tags[index][0] != 92:
            index += 1
        if index + 1 >= len(tags):
            raise ValueError('truncated hatch path')
        flags_list.append(int(tags[index][1]))
        index += 1
        if index >= len(tags):
            raise ValueError('truncated hatch path')
        if tags[index][0] == 93:  # edge path
            edge_count = int(tags[index][1])
            index += 1
            segments = []
            for _edge in range(edge_count):
                while index < len(tags) and tags[index][0] != 72:
                    index += 1
                if index + 1 >= len(tags):
                    raise ValueError('truncated hatch edge')
                edge_type = int(tags[index][1])
                index += 1
                if edge_type == 1:
                    values = {}
                    while len(values) < 4 and index < len(tags):
                        code, value = tags[index]
                        if code in (10, 20, 11, 21):
                            values[code] = float(value)
                        index += 1
                    if len(values) < 4:
                        raise ValueError('truncated line edge')
                    segments.append(('line', (values[10], values[20]), (values[11], values[21])))
                elif edge_type == 2:
                    values = {}
                    while len(values) < 5 and index < len(tags):
                        code, value = tags[index]
                        if code in (10, 20, 40, 50, 51):
                            values[code] = float(value)
                        index += 1
                    if len(values) < 5:
                        raise ValueError('truncated arc edge')
                    ccw = True
                    if index < len(tags) and tags[index][0] == 73:
                        ccw = tags[index][1] == '1'
                        index += 1
                    start_angle, end_angle = values[50], values[51]
                    if not ccw:
                        # DXF stores clockwise HATCH arc angles as complementary
                        # angles (360 - angle). Convert both to recover the real
                        # traversal endpoints; the sweep direction stays clockwise.
                        start_angle, end_angle = 360.0 - start_angle, 360.0 - end_angle
                    segments.append(('arc', (values[10], values[20]), values[40],
                                     start_angle, end_angle, ccw))
                else:
                    raise ValueError('unsupported independent edge type ' + str(edge_type))
            rings.append(segments)
        else:  # polyline path: 72 has_bulge, 73 vertex count
            if index >= len(tags) or tags[index][0] != 72:
                raise ValueError('truncated polyline path')
            has_bulge = int(tags[index][1])
            index += 1
            if index >= len(tags) or tags[index][0] != 73:
                raise ValueError('truncated polyline path')
            index += 1  # group 73 = is_closed
            if index >= len(tags) or tags[index][0] != 93:
                raise ValueError('truncated polyline path')
            vertex_count = int(tags[index][1])
            index += 1
            points = []
            bulges = []
            for _vertex in range(vertex_count):
                point = {}
                bulge = 0.0
                while len(point) < 2 and index < len(tags):
                    code, value = tags[index]
                    if code == 10:
                        point['x'] = float(value)
                    elif code == 20:
                        point['y'] = float(value)
                    index += 1
                if len(point) < 2:
                    raise ValueError('truncated polyline vertex')
                if has_bulge and index < len(tags) and tags[index][0] == 42:
                    bulge = float(tags[index][1])
                    index += 1
                points.append((point['x'], point['y']))
                bulges.append(bulge)
            segments = []
            for i, start in enumerate(points):
                end = points[(i + 1) % len(points)]
                if abs(bulges[i]) > 1e-12:
                    segments.append(('bulge', start, end, bulges[i]))
                else:
                    segments.append(('line', start, end))
            rings.append(segments)
    return rings, flags_list





def bulge_arc(start, end, bulge):
    """Return (center, radius, sweep) for a DXF polyline bulge segment.

    bulge = tan(sweep/4), positive = counter-clockwise. This is the exact
    specification formula, implemented here independently of ezdxf.
    """
    x1, y1 = start
    x2, y2 = end
    chord = math.hypot(x2 - x1, y2 - y1)
    if chord == 0:
        return None
    sweep = 4.0 * math.atan(bulge)
    radius = chord / (2.0 * math.sin(abs(sweep) / 2.0))
    half = chord / 2.0
    offset = math.sqrt(max(radius * radius - half * half, 0.0))
    mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    nx, ny = -(y2 - y1) / chord, (x2 - x1) / chord
    sign = 1.0 if bulge > 0 else -1.0
    return (mx + sign * offset * nx, my + sign * offset * ny), radius, sweep


def bulge_points(start, end, bulge, steps=48):
    arc = bulge_arc(start, end, bulge)
    if arc is None:
        return [start, end]
    (cx, cy), radius, sweep = arc
    a0 = math.atan2(start[1] - cy, start[0] - cx)
    return [(cx + radius * math.cos(a0 + sweep * i / steps),
             cy + radius * math.sin(a0 + sweep * i / steps)) for i in range(steps + 1)]


def ring_area(segments):
    total = 0.0
    for segment in segments:
        if segment[0] == 'line':
            (x1, y1), (x2, y2) = segment[1], segment[2]
            total += x1 * y2 - x2 * y1
        elif segment[0] == 'bulge':
            _kind, start, end, bulge = segment
            (cx, cy), radius, sweep = bulge_arc(start, end, bulge)
            total += (cx * (end[1] - start[1]) - cy * (end[0] - start[0])
                      + radius * radius * sweep)
        else:
            _kind, (cx, cy), r, a1, a2, ccw = segment
            start, end = math.radians(a1), math.radians(a2)
            if ccw and end <= start:
                end += 2 * math.pi
            if not ccw and end >= start:
                end -= 2 * math.pi
            p1 = (cx + r * math.cos(start), cy + r * math.sin(start))
            p2 = (cx + r * math.cos(end), cy + r * math.sin(end))
            total += (cx * (p2[1] - p1[1]) - cy * (p2[0] - p1[0])) + r * r * (end - start)
    return total * 0.5


def ring_points(segments):
    points = []
    for segment in segments:
        if segment[0] == 'line':
            points.extend([segment[1], segment[2]])
        elif segment[0] == 'bulge':
            _kind, start, end, bulge = segment
            points.extend(bulge_points(start, end, bulge))
        else:
            _kind, (cx, cy), r, a1, a2, ccw = segment
            points.extend(arc_ring(cx, cy, r, a1, a2, ccw))
    return points


def inside(point, ring):
    x, y = point
    hit = False
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def segment_endpoints(segment):
    if segment[0] == 'line':
        return segment[1], segment[2]
    if segment[0] == 'bulge':
        return segment[1], segment[2]
    _kind, (cx, cy), r, a1, a2, ccw = segment
    start, end = math.radians(a1), math.radians(a2)
    if ccw and end <= start:
        end += 2 * math.pi
    if not ccw and end >= start:
        end -= 2 * math.pi
    return ((cx + r * math.cos(start), cy + r * math.sin(start)),
            (cx + r * math.cos(end), cy + r * math.sin(end)))


def order_loops(segments, tolerance=1e-6):
    """Pair segment endpoints into closed loops, independent of source edge order."""
    if not segments:
        return []
    ends = []
    for index, segment in enumerate(segments):
        start, end = segment_endpoints(segment)
        ends.append((index, 0, start))
        ends.append((index, 1, end))
    parent = list(range(len(ends)))

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(left, right):
        left, right = find(left), find(right)
        if left != right:
            parent[right] = left

    for left in range(len(ends)):
        for right in range(left + 1, len(ends)):
            if math.dist(ends[left][2], ends[right][2]) <= tolerance:
                union(left, right)
    clusters = {}
    for index, (_edge, _end, _point) in enumerate(ends):
        clusters.setdefault(find(index), []).append(index)
    if any(len(members) != 2 for members in clusters.values()):
        raise ValueError('source-boundary-discontinuous')
    partner = {}
    for members in clusters.values():
        partner[members[0]] = members[1]
        partner[members[1]] = members[0]
    loops = []
    used = set()
    for seed in range(len(segments)):
        if seed in used:
            continue
        loop = []
        edge_index = seed
        entry_end = 0
        while True:
            used.add(edge_index)
            loop.append((edge_index, entry_end == 0))
            exit_end = 1 if entry_end == 0 else 0
            next_point = partner[2 * edge_index + exit_end]
            next_edge, next_end = divmod(next_point, 2)
            if next_edge == seed:
                break
            if next_edge in used:
                raise ValueError('source-boundary-discontinuous')
            edge_index, entry_end = next_edge, next_end
        loops.append(loop)
    return loops


def segment_points(segment, forward=True):
    if segment[0] == 'line':
        points = [segment[1], segment[2]]
    elif segment[0] == 'bulge':
        _kind, start, end, bulge = segment
        points = bulge_points(start, end, bulge)
    else:
        _kind, (cx, cy), r, a1, a2, ccw = segment
        points = arc_ring(cx, cy, r, a1, a2, ccw)
    return points if forward else list(reversed(points))


def loop_points(loop, segments):
    points = []
    for edge_index, forward in loop:
        part = segment_points(segments[edge_index], forward)
        if points and math.dist(points[-1], part[0]) < 1e-6:
            part = part[1:]
        points.extend(part)
    return points


def segment_area(segment, forward=True):
    if segment[0] == 'line':
        (x1, y1), (x2, y2) = segment[1], segment[2]
        value = x1 * y2 - x2 * y1
    elif segment[0] == 'bulge':
        _kind, start, end, bulge = segment
        (cx, cy), radius, sweep = bulge_arc(start, end, bulge)
        value = cx * (end[1] - start[1]) - cy * (end[0] - start[0]) + radius * radius * sweep
    else:
        _kind, (cx, cy), r, a1, a2, ccw = segment
        start, end = math.radians(a1), math.radians(a2)
        if ccw and end <= start:
            end += 2 * math.pi
        if not ccw and end >= start:
            end -= 2 * math.pi
        p1 = (cx + r * math.cos(start), cy + r * math.sin(start))
        p2 = (cx + r * math.cos(end), cy + r * math.sin(end))
        value = (cx * (p2[1] - p1[1]) - cy * (p2[0] - p1[0])) + r * r * (end - start)
    return value if forward else -value


def independent_fill(record):
    to_wcs, _det = ocs_axes(record)
    if record['type'] == 'SOLID':
        tags = record['tags']
        corners = []
        for base in (10, 11, 12, 13):
            x = tag(tags, base)
            y = tag(tags, base + 10)
            if x is None or y is None:
                continue
            corners.append((float(x), float(y)))
        if len(corners) == 4:
            corners = [corners[0], corners[1], corners[3], corners[2]]
        if len(corners) < 3:
            raise ValueError('degenerate SOLID')
        return {'rings': 1, 'area': abs(shoelace(corners)),
                'bbox': bbox([to_wcs(p) for p in corners]), 'holes': 0, 'curved': False}
    rings, flags_list = hatch_rings(record)
    style_value = tag(record['tags'], 75)
    style = int(style_value) if style_value is not None else 0
    if style not in (0, 1, 2):
        raise ValueError('style-unsupported')
    kept = [(ring, flags) for ring, flags in zip(rings, flags_list) if not (flags & 8)]
    if not kept:
        raise ValueError('textbox-only')
    rings = []
    for raw, flags in kept:
        for loop in order_loops(raw):
            points = loop_points(loop, raw)
            if len(points) < 3:
                continue
            area = abs(sum(segment_area(raw[index], forward)
                           for index, forward in loop) * 0.5)
            if area <= 0:
                raise ValueError('degenerate ring')
            rings.append({'points': points, 'area': area, 'curved':
                          any(raw[index][0] != 'line' for index, _forward in loop)})
    if not rings:
        raise ValueError('no rings')
    # Even-odd fill cancels coincident rings; drop even counts before nesting.
    groups = {}
    for ring in rings:
        key = tuple(sorted((round(x, 9), round(y, 9)) for x, y in ring['points']))
        groups.setdefault(key, []).append(ring)
    rings = [group[0] for group in groups.values() if len(group) % 2 == 1]
    if not rings:
        raise ValueError('degenerate ring')
    if style in (1, 2) and len(rings) > 1:
        raise ValueError('style-multipath')
    point_rings = [ring['points'] for ring in rings]
    depth = [sum(1 for j, other in enumerate(point_rings) if j != i and inside(point_rings[i][0], other))
             for i in range(len(point_rings))]
    area = sum(rings[i]['area'] if d % 2 == 0 else -rings[i]['area'] for i, d in enumerate(depth))
    curved = any(ring['curved'] for ring in rings)
    holes = 0 if style in (1, 2) else sum(1 for d in depth if d % 2 == 1)
    return {'rings': len(rings), 'area': area, 'style': style,
            'bbox': bbox([to_wcs(point) for ring in point_rings for point in ring]),
            'holes': holes, 'curved': curved}


def bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def triangles(document, payloads, item_id):
    rep_id = identity('representation', [item_id])
    rep = document['representations'][rep_id]
    geometry = document['geometries'][rep['bindings'][0]['geometryId']]
    primitive = geometry['primitives'][0]
    if primitive['topology'] != 'triangles' or 'indices' not in primitive:
        raise ValueError('not a triangle representation')
    position = document['accessors'][geometry['attributes']['POSITION']]
    index = document['accessors'][primitive['indices']]
    position_blob = base64.b64decode(payloads[position['bufferId']])
    index_blob = base64.b64decode(payloads[index['bufferId']])
    coords = struct.unpack_from('<' + 'd' * (position['count'] * 3), position_blob, position['byteOffset'])
    indices = struct.unpack_from('<' + 'I' * index['count'], index_blob, index['byteOffset'])
    points = [(coords[i * 3], coords[i * 3 + 1]) for i in range(position['count'])]
    area = 0.0
    for i in range(0, len(indices), 3):
        a, b, c = (points[indices[i]], points[indices[i + 1]], points[indices[i + 2]])
        area += abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) * 0.5
    return {'area': area, 'bbox': bbox(points), 'triangles': len(indices) // 3}


def compare(name, expected, observed):
    # Curved boundaries are compared with the display discretisation tolerance; straight
    # boundaries must match to 1e-6 relative.
    tol = 5e-3 if expected.get('curved') else TOL
    failures = []
    if abs(expected['area'] - observed['area']) > max(abs(expected['area']) * tol, 1e-6):
        failures.append({'area': [expected['area'], observed['area']]})
    for i in range(4):
        if abs(expected['bbox'][i] - observed['bbox'][i]) > max(abs(expected['bbox'][i]) * tol, 1e-6):
            failures.append({'bbox': [expected['bbox'], observed['bbox']]})
    return {'file': name, 'expected': expected, 'observed': observed, 'ok': not failures,
            'failures': failures}


def main():
    targets = [
        ('qcad_example00.dxf', 'phase_i_evidence/samples/real/qcad_example00.dxf'),
        ('qcad_example01.dxf', 'phase_i_evidence/samples/real/qcad_example01.dxf'),
        ('qcad_entities.dxf', 'phase_i_evidence/samples/real/qcad_entities.dxf'),
        ('qcad_flange.dxf', 'phase_i_evidence/samples/real/qcad_flange.dxf'),
        ('acadsharp_sample_AC1015.dxf', 'phase_i_evidence/samples/real/acadsharp_sample_AC1015.dxf'),
        ('acadsharp_sample_AC1032.dxf', 'phase_i_evidence/samples/real/acadsharp_sample_AC1032.dxf'),
        ('acadsharp_sample_AC1009.dxf', 'phase_i_evidence/samples/real/acadsharp_sample_AC1009.dxf'),
        ('librecad_dim_sample.dxf', 'phase_i_evidence/samples/real/librecad_dim_sample.dxf'),
        ('dxfparser_api_cw750_details.dxf', 'phase_i_evidence/samples/real/dxfparser_api_cw750_details.dxf'),
        ('fill_holes_curves.dxf', 'phase_j_evidence/fixtures/fill_holes_curves.dxf'),
        ('ocs_extrusion.dxf', 'phase_j_evidence/fixtures/ocs_extrusion.dxf'),
    ]
    rows = []
    failures = []
    file_summary = {}
    for name, relative in targets:
        path = PROJECT / relative
        envelope = read_dxf(str(path), path.read_bytes())
        validate_envelope(envelope)
        document = envelope['document']
        payloads = envelope['bufferPayloads']
        fills = document['extensions']['org.cad-preview.fill/1']['fills']
        raw = {}
        for record in entities(path):
            if record['type'] in ('HATCH', 'SOLID'):
                solid = record['type'] == 'SOLID'
                if record['type'] == 'HATCH':
                    solid = tag(record['tags'], 70) == '1' or (tag(record['tags'], 2) or '').upper().startswith('SOLID')
                if solid:
                    raw[tag(record['tags'], 5)] = record
        checked = 0
        filled_handles = set()
        skip_map = {row['handle'].upper(): row['reason']
                    for row in document['extensions']['org.cad-preview.fill/1'].get('skipped', [])}
        file_summary[name] = {'solidFills': len(raw), 'checked': 0, 'skipped': {}, 'refused': {}}
        for item_id, record in fills.items():
            entity = document['drawing']['entities'][item_id]
            handle = entity['sourceRefs'][0]['objectKey']
            filled_handles.add(handle.upper())
            if handle not in raw:
                continue
            try:
                expected = independent_fill(raw[handle])
            except ValueError as error:
                rows.append({'file': name, 'handle': handle, 'skipped': str(error)})
                file_summary[name]['skipped'][str(error)] = file_summary[name]['skipped'].get(str(error), 0) + 1
                continue
            observed = triangles(document, payloads, item_id)
            row = compare(name, expected, observed)
            row['handle'] = handle
            rows.append(row)
            checked += 1
            if not row['ok']:
                failures.append({'file': name, 'handle': handle, 'failures': row['failures']})
        file_summary[name]['checked'] = checked
        unfilled = [handle for handle in raw if handle.upper() not in filled_handles]
        for handle in unfilled:
            reason = skip_map.get(handle.upper())
            if reason is None:
                failures.append({'file': name, 'handle': handle,
                                 'error': 'solid fill neither filled nor explicitly refused'})
            else:
                bucket = file_summary[name]['refused']
                bucket[reason] = bucket.get(reason, 0) + 1
        if len(raw) and checked == 0 and not unfilled:
            failures.append({'file': name, 'error': 'solid fills exist but none could be checked'})
        if not len(raw):
            file_summary[name]['note'] = 'no solid fill entities'
    profile = {'schemaVersion': 'dxf-fill-geometry/1', 'generatedAt': '2026-10-19',
               'independentSide': 'ASCII DXF group-code reader in check_dxf_fill.py (no ezdxf)',
               'ucdSide': 'triangle Representation decoded from envelope buffers',
               'tolerance': TOL, 'checks': rows, 'files': file_summary,
               'summary': {'checked': sum(1 for row in rows if row.get('ok') is not None),
                           'failed': len(failures), 'failures': failures,
                           'skipped': sum(1 for row in rows if row.get('skipped'))}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    lines = ['# DXF fill geometry verification (independent raw tags vs UCD triangles)', '',
             'The independent side reads group codes directly from the ASCII DXF and computes ring area with',
             'exact line/arc/bulge Green\'s theorem and endpoint-paired loops. The UCD side decodes the published triangle representation.', '',
             '| file | handle | rings | holes | independent area | UCD triangle area | verdict |',
             '| --- | --- | --- | --- | --- | --- | --- |']
    for row in rows:
        if row.get('skipped'):
            lines.append('| ' + row['file'] + ' | ' + row['handle'] + ' | - | - | - | - | skipped: ' + row['skipped'] + ' |')
            continue
        lines.append('| %s | %s | %d | %d | %.6f | %.6f | %s |' % (
            row['file'], row['handle'], row['expected']['rings'], row['expected']['holes'],
            row['expected']['area'], row['observed']['area'], 'ok' if row['ok'] else 'MISMATCH'))
    MD.write_text('\n'.join(lines) + '\n')
    print(json.dumps(profile['summary'], ensure_ascii=False, indent=1))
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
