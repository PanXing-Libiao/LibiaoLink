"""Filled-entity support for the DXF adapter (SOLID, TRACE and HATCH).

Two separate concerns, deliberately kept apart:

* Source boundary geometry: the exact boundary paths (polyline vertices with bulges,
  line/arc/ellipse/spline edges) are returned verbatim so the adapter can keep them as
  analytic data next to the UCD Hatch entity.
* Display geometry: boundaries are flattened with the adapter's documented sagitta
  policy and triangulated with the even-odd rule; the triangles are display-only.

Pattern strokes use the stored, already scaled/rotated DXF definition and ezdxf's
even-odd polygon clipping, over the same flattened boundaries as solid fills.
Gradient appearance is handled by dxf_gradients in the adapter. Associative
boundary recomputation and unsupported boundary styles are never guessed.
"""
import math
import time

from ezdxf.entities.boundary_paths import EdgePath, PolylinePath
from ezdxf.math.triangulation import mapbox_earcut_2d
from ezdxf.path import from_hatch_boundary_path

RELATIVE_TOLERANCE = 1e-3

# Boundary endpoints in a HATCH edge path must connect. Across all 621 edges of the 11
# real samples the largest nearest-endpoint mismatch is 6.6e-7 drawing units (arc
# endpoint trigonometric round-off; median 4.8e-14, p99 3.83e-13), so 1e-6 is used as a
# pure numerical tolerance. It is not a geometric fudge factor and does not scale with
# drawing size. A gap of 1e-5 or more is treated as a real discontinuity and refused;
# a gap below 1e-6 cannot be distinguished from round-off and is not claimed either way.
ENDPOINT_TOLERANCE = 1e-6

SOLID_PATTERNS = ('SOLID', 'SOLID,_O')

# DXF group code 75 (HATCH hatch style). Only the values that can be represented
# without guessing are accepted; see hatch_style_name().
HATCH_STYLE_NAMES = {0: 'odd-parity', 1: 'outer', 2: 'ignore'}
MAX_PATTERN_SEGMENTS = 50000
PATTERN_SECONDS = 2.0


def pattern_strokes(entity, rings, max_segments=MAX_PATTERN_SEGMENTS):
    """Display-only strokes, in WCS, with the source pattern phase unchanged.

    Autodesk HATCH groups 53/43/44/45/46/49 describe effective line definitions.
    ezdxf 1.4.2 pattern_baselines() must NOT apply group 41/52 a second time.
    No random origin jiggle, density substitution, or solid-fill fallback is used.
    Empty/over-budget patterns are explicitly refused, never partially published.
    """
    from ezdxf.math import Vec2
    from ezdxf.render.hatching import pattern_baselines, hatch_polygons, HatchingError
    if entity.pattern is None or not entity.pattern.lines:
        raise ValueError('hatch-pattern-definition-missing')
    if entity.dxf.pattern_double:
        raise ValueError('hatch-pattern-double-unsupported')
    for line in entity.pattern.lines:
        values = [line.angle, *line.base_point, *line.offset, *line.dash_length_items]
        if not all(math.isfinite(value) for value in values):
            raise ValueError('hatch-pattern-nonfinite')
        if line.dash_length_items and sum(abs(value) for value in line.dash_length_items) < 1e-9:
            raise ValueError('hatch-pattern-degenerate-dashes')
    for ring in rings:
        analytic = ring['analytic']
        if analytic['type'] == 'polyline' and not analytic['closed']:
            vertices = analytic['vertices']
            if not vertices or math.dist(vertices[0][:2], vertices[-1][:2]) > ENDPOINT_TOLERANCE:
                raise ValueError('hatch-boundary-discontinuous')
    polygons = [[Vec2(point) for point in ring['points2d']] for ring in rings]
    ocs = entity.ocs()
    elevation = float(entity.dxf.elevation.z)
    deadline = time.perf_counter() + PATTERN_SECONDS
    points, segments = [], []

    def terminate():
        # Raise: ezdxf's True return otherwise silently yields a truncated hatch.
        if time.perf_counter() > deadline:
            raise ValueError('hatch-pattern-time-budget')
        return False

    try:
        for baseline in pattern_baselines(entity, jiggle_origin=False):
            terminate()
            for line in hatch_polygons(baseline, polygons, terminate=terminate):
                renderer = baseline.pattern_renderer(line.distance)
                for a, b in renderer.render(line.start, line.end):
                    terminate()
                    if len(segments) >= min(max_segments, MAX_PATTERN_SEGMENTS):
                        raise ValueError('hatch-pattern-segment-budget')
                    first = len(points)
                    # Zero-length strokes encode source dots; Canvas uses round
                    # caps, not the unrelated POINT entity's cross marker.
                    points.extend([list(ocs.to_wcs((p.x, p.y, elevation))) for p in (a, b)])
                    segments.append((first, first + 1))
    except HatchingError as error:
        raise ValueError('hatch-pattern-unrenderable:' + type(error).__name__) from error
    if not segments:
        raise ValueError('hatch-pattern-empty')
    if not all(math.isfinite(value) for point in points for value in point):
        raise ValueError('hatch-pattern-nonfinite')
    return points, segments


def is_solid_hatch(entity):
    # Group 450 kind=0 is the standard's solid form; some writers leave group 70 unset.
    gradient = getattr(entity, 'gradient', None)
    if gradient is not None:
        try:
            if int(getattr(gradient, 'kind', 0) or 0) == 0:
                return True
        except (TypeError, ValueError):
            pass
    if int(entity.dxf.get('solid_fill', 0) or 0):
        return True
    return str(entity.dxf.get('pattern_name', '') or '').upper() in SOLID_PATTERNS


def is_gradient_hatch(entity):
    """True only for a real gradient (group code 450 kind=1).

    DXF gradient hatches also set solid_fill=1 and pattern_name=SOLID, so checking
    only is_solid_hatch() would silently fill a gradient as a solid colour. A 450
    payload with kind=0 is the standard's solid form and stays solid.
    """
    gradient = getattr(entity, 'gradient', None)
    if gradient is None:
        return False
    try:
        return int(getattr(gradient, 'kind', 0) or 0) == 1
    except (TypeError, ValueError):
        return True


def hatch_style(entity):
    """Return DXF hatch style (group code 75) for a HATCH entity.

    Group 75 is optional in practice and both ezdxf and the DXF reference default it
    to 0, so an absent tag means odd-parity rather than "unknown". A present but
    non-numeric value is not guessed at.
    """
    try:
        return int(entity.dxf.get('hatch_style', 0) or 0)
    except (TypeError, ValueError):
        raise ValueError('hatch-style-unreadable')


def hatch_style_name(value):
    return HATCH_STYLE_NAMES.get(value, 'unknown')


def solid_polygon(entity):
    """Return a SOLID/TRACE polygon, preserving its OCS vertex elevations.

    DXF SOLID corner order is 1, 2, 4, 3 (third and fourth corners are swapped
    relative to the drawing order), so the boundary must be reordered before it is
    used as a polygon.
    """
    vertices = entity.vertices()
    corners = list(entity.ocs().points_to_wcs(vertices))
    plane = [(float(p.x), float(p.y)) for p in vertices]
    if _distance(corners[0], corners[-1]) < 1e-9:
        corners.pop()
        plane.pop()
    if len(corners) < 3:
        raise ValueError('solid-degenerate')
    return {'points': [list(p) for p in corners], 'points2d': plane}


def _distance(a, b):
    return math.dist([a[0], a[1], a[2]], [b[0], b[1], b[2]])


def _edge_record(edge):
    name = type(edge).__name__
    if name == 'LineEdge':
        return {'kind': 'line',
                'start': [float(edge.start.x), float(edge.start.y)],
                'end': [float(edge.end.x), float(edge.end.y)]}
    if name == 'ArcEdge':
        return {'kind': 'arc',
                'center': [float(edge.center.x), float(edge.center.y)],
                'radius': float(edge.radius),
                'startAngle': float(edge.start_angle),
                'endAngle': float(edge.end_angle),
                'counterClockwise': bool(edge.ccw)}
    if name == 'EllipseEdge':
        return {'kind': 'ellipse',
                'center': [float(edge.center.x), float(edge.center.y)],
                'majorAxis': [float(edge.major_axis.x), float(edge.major_axis.y)],
                'ratio': float(edge.ratio),
                'startParameter': float(edge.start_angle),
                'endParameter': float(edge.end_angle),
                'counterClockwise': bool(edge.ccw)}
    if name == 'SplineEdge':
        return {'kind': 'spline', 'degree': int(edge.degree), 'rational': bool(edge.rational),
                'periodic': bool(edge.periodic),
                'knotValues': [float(v) for v in edge.knot_values],
                'controlPoints': [[float(p.x), float(p.y)] for p in edge.control_points],
                'fitPoints': [[float(p.x), float(p.y)] for p in edge.fit_points],
                'weights': [float(w) for w in edge.weights]}
    raise ValueError('hatch-edge-unsupported:' + name)


def _edge_endpoints(edge):
    """Return (start, end) of one HATCH boundary edge in the OCS plane."""
    name = type(edge).__name__
    try:
        if name == 'LineEdge':
            return (float(edge.start.x), float(edge.start.y)), (float(edge.end.x), float(edge.end.y))
        if name == 'ArcEdge':
            start = edge.start_point
            end = edge.end_point
            return (float(start.x), float(start.y)), (float(end.x), float(end.y))
        if name == 'EllipseEdge':
            start = edge.start_point
            end = edge.end_point
            return (float(start.x), float(start.y)), (float(end.x), float(end.y))
        if name == 'SplineEdge':
            start = edge.start_point
            end = edge.end_point
            return (float(start.x), float(start.y)), (float(end.x), float(end.y))
    except AttributeError:
        return None
    return None


def _flatten_edge(edge, sagitta):
    """Flatten one HATCH edge in its OCS plane."""
    if type(edge).__name__ == 'LineEdge':
        return [(float(edge.start.x), float(edge.start.y)),
                (float(edge.end.x), float(edge.end.y))]
    tool = edge.construction_tool()
    return [(float(point.x), float(point.y)) for point in tool.flattening(sagitta)]


def _edge_loops(path, sagitta):
    """Reorder an edge path into closed loops by endpoint connectivity.

    DXF writers are not consistent about edge order: QCAD's title-block hatches store
    the edges of one boundary path out of order even though every endpoint still pairs
    with exactly one other endpoint. A sequential "edge i ends where edge i+1 starts"
    check therefore misclassifies those files. Connectivity at ENDPOINT_TOLERANCE
    recovers the loops; genuinely open or branching boundaries leave an endpoint
    without a partner (or with three partners) and are refused.
    """
    segments = []
    for edge in getattr(path, 'edges', []):
        endpoints = _edge_endpoints(edge)
        if endpoints is None:
            raise ValueError('hatch-edge-unsupported:' + type(edge).__name__)
        segments.append((edge, endpoints[0], endpoints[1]))
    if not segments:
        return []
    points = []
    for index, (_edge, start, end) in enumerate(segments):
        points.append((index, 0, start))
        points.append((index, 1, end))
    parent = list(range(len(points)))

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(left, right):
        left, right = find(left), find(right)
        if left != right:
            parent[right] = left

    for left in range(len(points)):
        for right in range(left + 1, len(points)):
            if math.dist(points[left][2], points[right][2]) <= ENDPOINT_TOLERANCE:
                union(left, right)
    clusters = {}
    for index, (_edge, _end, _point) in enumerate(points):
        clusters.setdefault(find(index), []).append(index)
    if any(len(members) != 2 for members in clusters.values()):
        raise ValueError('hatch-boundary-discontinuous')
    partner = {}
    for members in clusters.values():
        first, second = members
        partner[first] = second
        partner[second] = first

    loops = []
    used = set()
    for seed in range(len(segments)):
        if seed in used:
            continue
        start_cluster = find(2 * seed)
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
                if find(next_point) != start_cluster:
                    raise ValueError('hatch-boundary-discontinuous')
                break
            if next_edge in used:
                raise ValueError('hatch-boundary-discontinuous')
            edge_index, entry_end = next_edge, next_end
        loops.append(loop)
    return loops


def _loop_polygon(loop, segments, sagitta):
    polygon = []
    for edge_index, forward in loop:
        edge = segments[edge_index][0]
        points = _flatten_edge(edge, sagitta)
        if not forward:
            points.reverse()
        if polygon and math.dist(polygon[-1], points[0]) <= ENDPOINT_TOLERANCE:
            points = points[1:]
        polygon.extend(points)
    if len(polygon) > 1 and math.dist(polygon[0], polygon[-1]) <= ENDPOINT_TOLERANCE:
        polygon.pop()
    return polygon


def boundary_paths(entity):
    """Return every HATCH boundary path in source (analytic) and flattened form.

    Group code 92 path flags are preserved on every ring. Textbox paths (flag 8) are
    annotation masks, not fill boundaries: they are skipped and reported instead of
    filling a rectangle that the source never asked to fill. Derived paths (flag 4)
    are the stored boundary loops and are kept.

    Display points and flattened 2D points are built from the same flattening call, so
    ring points and bulges always have identical length. For polylines with bulges the
    analytic record keeps the original vertices/bulges, while display uses the
    documented sagitta flattening (as for edge paths).
    """
    ocs = entity.ocs()
    elevation = float(entity.dxf.elevation.z)
    raw = []
    skipped_textbox = 0
    style_code = hatch_style(entity)
    paths = []
    for path in entity.paths:
        flags = int(path.path_type_flags)
        unknown = flags & ~0x1F
        if unknown:
            # Bits above the five documented flags have no published meaning; filling
            # them would be a guess. Refuse instead of silently ignoring the bits.
            raise ValueError('hatch-path-flags-unsupported:%d' % unknown)
        if flags & 8:
            skipped_textbox += 1
            continue
        paths.append((path, flags))
    # Style 1 (outer) renders EXTERNAL and OUTERMOST paths; style 2 (ignore) renders
    # EXTERNAL paths only (ezdxf BoundaryPaths.rendering_paths uses the same rule).
    # With one non-textbox path every style selects the same area, so the filter is
    # only needed when there is something to choose between. No selected path means
    # the flags do not identify an outer boundary; refuse rather than guess.
    if style_code in (1, 2) and len(paths) > 1:
        if style_code == 1:
            selected = [(path, flags) for path, flags in paths if flags & (1 | 16)]
        else:
            selected = [(path, flags) for path, flags in paths if flags & 1]
        if not selected:
            raise ValueError('hatch-style-unsupported:%d-multipath' % style_code)
        paths = selected
    for path, flags in paths:
        if isinstance(path, PolylinePath):
            vertices = [(float(v[0]), float(v[1]), float(v[2])) for v in path.vertices]
            diagonal = 0.0
            for index, start in enumerate(vertices):
                for other in vertices[index + 1:]:
                    diagonal = max(diagonal, math.dist(start[:2], other[:2]))
            sagitta = max(1e-6, diagonal * RELATIVE_TOLERANCE)
            ez_path = from_hatch_boundary_path(path, ocs=ocs, elevation=elevation)
            flattened = list(ez_path.flattening(sagitta))
            points3d = [tuple(point) for point in flattened]
            points2d = []
            for point in flattened:
                planar = ocs.from_wcs(point)
                points2d.append((float(planar.x), float(planar.y)))
            if len(points3d) > 2 and _distance(points3d[0], points3d[-1]) < 1e-9:
                points3d.pop()
                points2d.pop()
            if len(points3d) < 3:
                raise ValueError('hatch-boundary-degenerate')
            record = {'type': 'polyline', 'closed': bool(path.is_closed),
                      'vertices': [[v[0], v[1], v[2]] for v in vertices]}
            bulges = [0.0] * len(points3d)
        else:
            segments = []
            endpoints = []
            for edge in getattr(path, 'edges', []):
                pair = _edge_endpoints(edge)
                if pair is None:
                    raise ValueError('hatch-edge-unsupported:' + type(edge).__name__)
                segments.append((edge, pair[0], pair[1]))
                endpoints.extend(pair)
            diagonal = 0.0
            for index, start in enumerate(endpoints):
                for other in endpoints[index + 1:]:
                    diagonal = max(diagonal, math.dist(start, other))
            sagitta = max(1e-6, diagonal * RELATIVE_TOLERANCE)
            loops = _edge_loops(path, sagitta)
            rings = []
            for loop in loops:
                polygon = _loop_polygon(loop, segments, sagitta)
                if len(polygon) < 3:
                    raise ValueError('hatch-boundary-degenerate')
                points2d = polygon
                points3d = [tuple(ocs.to_wcs((x, y, elevation))) for x, y in polygon]
                rings.append({'points': [list(point) for point in points3d],
                              'points2d': points2d,
                              'bulges': [0.0] * len(points3d),
                              'analytic': {'type': 'edges', 'closed': True,
                                           'edges': [_edge_record(segments[index][0])
                                                     for index, _forward in loop]},
                              'flags': flags})
            raw.extend(rings)
            continue
        raw.append({'points': [list(point) for point in points3d], 'points2d': points2d,
                    'bulges': bulges, 'analytic': record, 'flags': flags})
    if not raw:
        if skipped_textbox:
            raise ValueError('hatch-textbox-only')
        raise ValueError('hatch-without-boundary')
    return raw, skipped_textbox


def _ring_area(ring):
    area = 0.0
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area * 0.5


def _point_in_ring(point, ring):
    x, y = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < cross:
                inside = not inside
        j = i
    return inside


def _classify(rings):
    """Even-odd nesting: depth even = island, depth odd = hole of the enclosing ring."""
    depths = []
    for index, ring in enumerate(rings):
        point = ring[0]
        depth = 0
        for other_index, other in enumerate(rings):
            if other_index == index:
                continue
            if _point_in_ring(point, other):
                depth += 1
        depths.append(depth)
    containers = {}
    for index, depth in enumerate(depths):
        if depth % 2 == 0:
            continue
        candidates = [i for i, d in enumerate(depths)
                      if d == depth - 1 and _point_in_ring(rings[index][0], rings[i])]
        if not candidates:
            raise ValueError('hatch-nesting-unresolved')
        containers[index] = min(candidates, key=lambda i: abs(_ring_area(rings[i])))
    return depths, containers


def _clean_ring(ring):
    points, plane, bulges = [], [], []
    for index, point in enumerate(ring['points']):
        planar = ring['points2d'][index]
        if plane and math.dist(plane[-1], planar) < 1e-12:
            continue
        points.append(point)
        plane.append(planar)
        bulges.append(ring['bulges'][index])
    while len(plane) > 2 and math.dist(plane[0], plane[-1]) < 1e-12:
        points.pop()
        plane.pop()
        bulges.pop()
    if len(plane) < 3:
        return None
    return {'points': points, 'points2d': plane, 'bulges': bulges,
            'analytic': ring['analytic'], 'flags': ring['flags']}


def triangulate(rings):
    """Triangulate boundary rings with holes; returns (points3d, triangles)."""
    cleaned = []
    for ring in rings:
        row = _clean_ring(ring)
        if row is not None:
            cleaned.append(row)
    if not cleaned:
        raise ValueError('hatch-boundary-degenerate')
    # Odd-parity fill counts crossings: two boundary rings with identical geometry
    # cancel out. Some real files (cw750) store such a pair with opposite orientation
    # instead of leaving the feature unfilled; removing even counts keeps the net area
    # and avoids ambiguous point-in-ring classification for coincident rings.
    groups = {}
    for ring in cleaned:
        key = tuple(sorted((round(x, 9), round(y, 9)) for x, y in ring['points2d']))
        groups.setdefault(key, []).append(ring)
    rings = [group[0] for group in groups.values() if len(group) % 2 == 1]
    if not rings:
        raise ValueError('hatch-boundary-degenerate')
    rings2d = [ring['points2d'] for ring in rings]
    depths, containers = _classify(rings2d)
    points = []
    index_of = {}
    for ring_index, ring in enumerate(rings):
        for point_index, point in enumerate(ring['points']):
            index_of[(ring_index, point_index)] = len(points)
            points.append(point)
    lookup = {}
    for ring_index, ring in enumerate(rings2d):
        for point_index, point in enumerate(ring):
            lookup.setdefault((round(point[0], 9), round(point[1], 9)), (ring_index, point_index))
    triangles = []
    expected = 0.0
    for ring_index, depth in enumerate(depths):
        if depth % 2 != 0:
            continue
        exterior = rings2d[ring_index]
        hole_indices = sorted(i for i, owner in containers.items() if owner == ring_index)
        holes = [rings2d[i] for i in hole_indices]
        expected += abs(_ring_area(exterior)) - sum(abs(_ring_area(hole)) for hole in holes)
        result = mapbox_earcut_2d(exterior, holes)
        for triangle in result:
            row = []
            for vertex in triangle:
                key = (round(float(vertex.x), 9), round(float(vertex.y), 9))
                if key not in lookup:
                    raise ValueError('hatch-triangulation-mismatch')
                ring_id, point_id = lookup[key]
                row.append(index_of[(ring_id, point_id)])
            if len(set(row)) != 3:
                continue
            triangles.append(row)
    if not triangles:
        raise ValueError('hatch-triangulation-empty')
    actual = 0.0
    for a, b, c in triangles:
        pa, pb, pc = points[a], points[b], points[c]
        actual += abs((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1])) * 0.5
    if expected > 0 and abs(actual - expected) > max(expected * 1e-6, 1e-9):
        raise ValueError('hatch-area-mismatch')
    return points, triangles
