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
    positions, triangles, line_points, lines = [], [], [], []
    for face in TraceBuilder.from_polyline(entity, segments=segments).faces():
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
        points, indices = triangulate([{'points': [p + [elevation] for p in plane], 'points2d': plane,
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
