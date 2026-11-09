"""Source width facts and bounded display bands over the vendored ezdxf tools.

TraceBuilder owns DXF width overrides, mitres and bulges. This adapter keeps the
source curve separate, batches its faces into our display presentations and keeps
zero-width segments as lines. No upstream renderer or new runtime is bundled.
"""
from ezdxf.render.trace import TraceBuilder

from .dxf_fill import triangulate


def segment_widths(entity, count):
    if entity.dxftype() == 'LWPOLYLINE':
        constant = float(entity.dxf.const_width)
        pairs = ([[constant, constant]] * count if constant else
                 [[float(start), float(end)] for start, end in entity.get_points('se')][:count])
    else:
        pairs = [[float(vertex.dxf.get('start_width', entity.dxf.default_start_width)),
                  float(vertex.dxf.get('end_width', entity.dxf.default_end_width))]
                 for vertex in entity.vertices[:count]]
    if any(min(pair) < 0 for pair in pairs):
        raise ValueError('polyline-width-negative')
    return pairs if any(max(pair) > 0 for pair in pairs) else None


def display_parts(entity, segments, vertex_budget):
    """Return triangle/line batches in the polyline's OCS, including elevation."""
    elevation = (float(entity.dxf.elevation) if entity.dxftype() == 'LWPOLYLINE'
                 else float(entity.dxf.elevation.z))
    return _display_parts(TraceBuilder.from_polyline(entity, segments=segments), elevation, vertex_budget)


def display_parts_from_vertices(vertices, closed, elevation, segments, vertex_budget):
    """Native OCS stations share the exact width/arc/join algorithm with DXF."""
    return _display_parts(TraceBuilder.from_vertices(vertices, closed, segments), elevation, vertex_budget)


def _simple_band_faces(face):
    """Split a crossed trace quad into its two filled lobes, not its convex hull.

    Miter cross-sections can cross on short segments, as can radial sections
    when an arc's half-width exceeds its radius. A simple-ring triangulator
    cannot use the signed (cancelling) area of that bow-tie as its filled area.
    """
    for i, j, k, l in ((0, 1, 2, 3), (1, 2, 3, 0)):
        a, b, c, d = (face[n] for n in (i, j, k, l))
        r, s, q = b - a, d - c, c - a
        denominator = r.det(s)
        if denominator == 0:
            continue
        t, u = q.det(s) / denominator, q.det(r) / denominator
        if 0 < t < 1 and 0 < u < 1:
            crossing = a + r * t
            return ((crossing, b, c, crossing), (crossing, d, a, crossing))
    return (face,)


def _display_parts(trace, elevation, vertex_budget):
    positions, triangles, line_points, lines = [], [], [], []
    for face in (part for quad in trace.faces() for part in _simple_band_faces(quad)):
        if len(positions) + len(line_points) + 4 > vertex_budget:
            raise ValueError('polyline-width-vertex-budget')
        # A zero-width segment is still visible at its plotted lineweight.
        if face[0] == face[1] and face[2] == face[3]:
            if face[0] != face[2]:
                first = len(line_points)
                line_points.extend([[float(p.x), float(p.y), elevation] for p in (face[0], face[2])])
                lines.append((first, first + 1))
            continue
        plane = []
        for point in face:
            p = [float(point.x), float(point.y)]
            if not plane or p != plane[-1]: plane.append(p)
        if len(plane) > 1 and plane[0] == plane[-1]: plane.pop()
        if len(plane) < 3: continue
        # Area tests must use a local origin: millimetre-wide bands can sit at
        # million-unit coordinates, where absolute shoelace products cancel.
        origin = plane[0]
        local_plane = [[p[0]-origin[0], p[1]-origin[1]] for p in plane]
        if len(plane) == 3:
            # Already a triangle: retain its vertices directly. The general
            # ring triangulator's rounded lookup can merge a tiny split lobe.
            points, indices = [p + [elevation] for p in plane], [(0, 1, 2)]
        else:
            points, indices = triangulate([{'points': [p + [elevation] for p in plane], 'points2d': local_plane,
                                           'bulges': [0.0] * len(plane), 'analytic': {'type': 'display-band'}, 'flags': 0}])
        first = len(positions)
        positions.extend(points)
        # Consistent winding makes overlapping bands a union, not an even-odd cutout.
        for a, b, c in indices:
            pa, pb, pc = points[a], points[b], points[c]
            cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
            if cross: triangles.append(tuple(first + i for i in ((a, b, c) if cross > 0 else (a, c, b))))
    parts = []
    if triangles: parts.append((positions, triangles, 'triangles'))
    if lines: parts.append((line_points, lines, 'lines'))
    if not parts: raise ValueError('polyline-width-no-visible-geometry')
    return parts
