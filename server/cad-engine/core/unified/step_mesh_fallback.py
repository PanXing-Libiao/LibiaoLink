"""Conservative display tessellation of a single non-periodic trimmed surface.

OCCT 7.8.1 supplies ordered pcurves and face classification. Acceptance is a finite
sampling contract, NOT a proof of a Hausdorff bound or arbitrary B-spline support.
The B-Rep is never edited. Uncertain topology is refused, leaving strict/partial
missing-face handling to the caller.
"""
import math,struct
from .step_repair_quality import display_area_check

SAMPLES_PER_EDGE = 25
MAX_RINGS = 64
UV_TOLERANCE = 1e-7
# Each triangle: centroid, all edge midpoints, and points near all three corners.
BARYCENTRIC_SAMPLES = ((1/3, 1/3, 1/3), (.5, .5, 0), (0, .5, .5),
                       (.5, 0, .5), (.98, .01, .01), (.01, .98, .01), (.01, .01, .98))


def _cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def _centroid(points):
    area = cx = cy = 0.0
    for a, b in zip(points, points[1:] + points[:1]):
        cross = a[0]*b[1]-b[0]*a[1]
        area += cross
        cx += (a[0]+b[0])*cross
        cy += (a[1]+b[1])*cross
    return None if abs(area) < 1e-15 else (cx/(3*area), cy/(3*area))


def _star_shaped(points, centre):
    """Reject crossing, repeated and narrow sampled loops; include closure.

    A strictly positive fan with total winding 2*pi partitions this polygon without
    overlapping triangles. This says nothing about unsampled pcurve excursions.
    """
    if len(points) < 3 or centre is None:
        return False
    span = max(math.dist(centre, p) for p in points)
    eps = max(1e-15, span*span*1e-12)
    angles = []
    for a, b in zip(points, points[1:]+points[:1]):
        cross = _cross(centre, a, b)
        if cross <= eps:
            return False
        angles.append(math.atan2(cross, (a[0]-centre[0])*(b[0]-centre[0]) +
                                 (a[1]-centre[1])*(b[1]-centre[1])))
    if abs(sum(angles)-2*math.pi) > 1e-8:
        return False
    return True


def _point(surface, uv):
    p = surface.Value(*uv)
    return (p.X(), p.Y(), p.Z())


def _pcurve_loop(face, surface, deflection):
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve2d
    from OCP.BRepTools import BRepTools, BRepTools_WireExplorer
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_WIRE, TopAbs_REVERSED, TopAbs_FORWARD
    from OCP.TopExp import TopExp_Explorer
    wires = TopExp_Explorer(face, TopAbs_WIRE)
    count = 0
    while wires.More():
        count += 1
        wires.Next()
    if count != 1:
        return None
    wire = BRepTools.OuterWire_s(face)
    if wire.IsNull() or not wire.Closed():
        return None
    ex = TopExp_Explorer(wire, TopAbs_EDGE)
    count = 0
    while ex.More():
        count += 1
        ex.Next()
    ordered = BRepTools_WireExplorer(wire, face)
    segments = []
    degenerate_segments = set()
    visited = []
    worst = 0.0
    degenerate = 0
    while ordered.More():
        edge = ordered.Current()
        ordered.Next()
        if edge.Orientation() not in (TopAbs_FORWARD, TopAbs_REVERSED):
            return None
        if any(edge.IsSame(old) for old in visited) or BRep_Tool.IsClosed_s(edge, face):
            return None
        visited.append(edge)
        curve = BRepAdaptor_Curve2d(edge, face)
        first, last = curve.FirstParameter(), curve.LastParameter()
        if not (math.isfinite(first) and math.isfinite(last)) or last <= first:
            return None
        reverse = edge.Orientation() == TopAbs_REVERSED
        def at(ratio):
            p = curve.Value(first+(last-first)*(1-ratio if reverse else ratio))
            return (p.X(), p.Y())
        points = [at(i/SAMPLES_PER_EDGE) for i in range(SAMPLES_PER_EDGE+1)]
        if BRep_Tool.Degenerated_s(edge):
            degenerate += 1
            degenerate_segments.add(len(segments))
            # Never silently remove a degenerate edge spanning a UV pole/seam.
            origin = _point(surface, points[0])
            if max(math.dist(origin, _point(surface, p)) for p in points) > deflection:
                return None
        for i in range(SAMPLES_PER_EDGE):
            a, b = _point(surface, points[i]), _point(surface, points[i+1])
            for fraction in (.25, .5, .75):
                exact = _point(surface, at((i+fraction)/SAMPLES_PER_EDGE))
                chord = tuple(a[j]*(1-fraction)+b[j]*fraction for j in range(3))
                worst = max(worst, math.dist(exact, chord))
        segments.append(points)
    if len(visited) != count or not segments or worst > deflection:
        return None
    for a, b in zip(segments, segments[1:]+segments[:1]):
        if math.dist(a[-1], b[0]) > UV_TOLERANCE:
            return None
    points = []
    for segment_index, segment in enumerate(segments):
        if segment_index in degenerate_segments:
            continue
        for p in segment[:-1]:
            if not points or math.dist(points[-1], p) > UV_TOLERANCE:
                points.append(p)
    if len(points) < 3:
        return None
    if math.dist(points[-1], points[0]) <= UV_TOLERANCE:
        points.pop()
    signed = sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1]))
    if signed < 0:
        points.reverse()
    return points, worst, degenerate, [p for segment in segments for p in segment]


def _triangle_area(a, b, c):
    u = [b[i]-a[i] for i in range(3)]
    v = [c[i]-a[i] for i in range(3)]
    return .5*math.sqrt(sum(x*x for x in (u[1]*v[2]-u[2]*v[1],
                         u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])))


def pcurve_region_mesh(face, deflection=0.08):
    from OCP.BRep import BRep_Tool
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FORWARD, TopAbs_REVERSED, TopAbs_IN, TopAbs_ON
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Pnt2d, gp_Pnt, gp_Vec
    if not math.isfinite(deflection) or deflection <= 0:
        return None
    if face.Orientation() not in (TopAbs_FORWARD, TopAbs_REVERSED):
        return None
    reversed_face = face.Orientation() == TopAbs_REVERSED
    forward = TopoDS.Face_s(face.Oriented(TopAbs_FORWARD))
    if not BRepCheck_Analyzer(forward).IsValid():
        return None
    # This overload ALREADY applies the face location (BRep_Tool.cxx V7_8_1).
    surface = BRep_Tool.Surface_s(forward)
    if surface.IsUPeriodic() or surface.IsVPeriodic() or surface.IsUClosed() or surface.IsVClosed():
        return None
    boundary = _pcurve_loop(forward, surface, deflection)
    if boundary is None:
        return None
    loop, boundary_worst, degenerate_edges, source_boundary = boundary
    centre = _centroid(loop)
    if not _star_shaped(loop, centre):
        return None
    classifier = BRepClass_FaceClassifier()
    counts = {'IN': 0, 'ON': 0}
    def inside(uv, strict=False):
        classifier.Perform(forward, gp_Pnt2d(*uv), UV_TOLERANCE)
        state = classifier.State()
        if state not in (TopAbs_IN, TopAbs_ON) or strict and state != TopAbs_IN:
            return False
        counts['IN' if state == TopAbs_IN else 'ON'] += 1
        return True
    if not inside(centre, strict=True):
        return None
    # A straight UV chord between pcurve samples can lie OUT even when both
    # endpoints lie ON. Use a conservative inscribed polygon; do not relax the
    # classifier tolerance. The boundary displacement is measured and gated below.
    original_loop = loop
    def inset(ratio):
        return [tuple(centre[j]+(p[j]-centre[j])*ratio for j in range(2)) for p in original_loop]
    def boundary_inside(points):
        return all(inside(tuple(a[j]*(1-t)+b[j]*t for j in range(2)))
                   for a,b in zip(points,points[1:]+points[:1])
                   for t in (0, .25, .5, .75))
    inset_ratio = 1.0
    if not boundary_inside(loop):
        low, high = 0.0, 1.0
        for _ in range(28):
            mid = (low+high)/2
            if boundary_inside(inset(mid)):
                low = mid
            else:
                high = mid
        inset_ratio = low
        loop = inset(low)
        if not _star_shaped(loop, centre) or not boundary_inside(loop):
            return None
    def segment_distance(p, a, b):
        direction = tuple(b[j]-a[j] for j in range(3))
        length2 = sum(x*x for x in direction)
        t = max(0, min(1, sum((p[j]-a[j])*direction[j] for j in range(3))/length2)) if length2 else 0
        return math.dist(p, tuple(a[j]+t*direction[j] for j in range(3)))
    polygon_xyz = [_point(surface, p) for p in loop]
    source_xyz = [_point(surface, p) for p in source_boundary]
    # Directed sampled distances in both directions, including skipped degenerate
    # pcurve spans. This is a measured maximum, not a continuous curve bound.
    def directed(samples, polyline):
        return max(min(segment_distance(p,a,b) for a,b in zip(polyline,polyline[1:]+polyline[:1])) for p in samples)
    boundary_worst = max(boundary_worst, directed(source_xyz, polygon_xyz),
                         directed(polygon_xyz, source_xyz))
    if boundary_worst > deflection:
        return None
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(forward, props)
    source_area = props.Mass()
    if source_area <= 0:
        return None
    boundary_xyz = [_point(surface, p) for p in loop]
    span = max(math.dist(boundary_xyz[0], p) for p in boundary_xyz)
    rings = max(1, min(MAX_RINGS, math.ceil(span/(deflection*2))))
    for _ in range(7):
        uvs = [centre]
        for ring in range(1, rings+1):
            uvs.extend(tuple(centre[j]+(p[j]-centre[j])*ring/rings for j in range(2)) for p in loop)
        positions = [_point(surface, p) for p in uvs]
        if not all(math.isfinite(x) for p in positions for x in p):
            return None
        indices = []
        n = len(loop)
        for i in range(n):
            indices.extend((0, 1+i, 1+(i+1)%n))
        for ring in range(1, rings):
            for i in range(n):
                a, b = 1+(ring-1)*n+i, 1+ring*n+i
                c, d = 1+ring*n+(i+1)%n, 1+(ring-1)*n+(i+1)%n
                indices.extend((a,b,c,a,c,d))
        worst = area = 0.0
        accepted = []
        collapsed = 0
        for k in range(0, len(indices), 3):
            ids = indices[k:k+3]
            xyz = [positions[i] for i in ids]
            tuv = [uvs[i] for i in ids]
            if _cross(*tuv) <= 0:
                return None
            point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
            surface.D1(sum(p[0] for p in tuv)/3, sum(p[1] for p in tuv)/3, point, du, dv)
            normal = du.Crossed(dv)
            ab = gp_Vec(*(xyz[1][j]-xyz[0][j] for j in range(3)))
            ac = gp_Vec(*(xyz[2][j]-xyz[0][j] for j in range(3)))
            if ab.Crossed(ac).Dot(normal) < 0:
                return None
            tri_area = _triangle_area(*xyz)
            # Refuse singular/degenerate triangles; do not silently omit them.
            if tri_area <= 1e-14:
                return None
            accepted.extend((ids[0],ids[2],ids[1]) if reversed_face else ids)
            area += tri_area
            for weights in BARYCENTRIC_SAMPLES:
                uv = tuple(sum(tuv[i][j]*weights[i] for i in range(3)) for j in range(2))
                if not inside(uv):
                    return None
                exact = _point(surface, uv)
                chord = tuple(sum(xyz[i][j]*weights[i] for i in range(3)) for j in range(3))
                worst = max(worst, math.dist(exact, chord))
        ratio = area/source_area
        area_check=display_area_check(source_area,area)
        stored=[struct.unpack('<fff',struct.pack('<fff',*p)) for p in positions]
        stored_area=sum(_triangle_area(*(stored[accepted[i+j]] for j in range(3))) for i in range(0,len(accepted),3))
        stored_area_check=display_area_check(source_area,stored_area)
        if accepted and worst <= deflection and area_check['accepted'] and stored_area_check['accepted']:
            return {'uvs': uvs, 'positions': positions, 'indices': accepted, 'area': area,
                    'rings': rings, 'maxDeviation': worst, 'areaRatio': ratio,
                    'trim': 'single-pcurve-loop-classified',
                    'validation': {'kind': 'finite-sampled-display-repair',
                        'classifier': 'BRepClass_FaceClassifier OCCT 7.8.1',
                        'uvTolerance': UV_TOLERANCE, 'classificationCounts': counts,
                        'samplesPerTriangle': len(BARYCENTRIC_SAMPLES),
                        'boundaryMeasuredMaximumMM': boundary_worst,
                        'pairedSurfaceMeshMeasuredMaximumMM': worst,
                        'deviationMeaning': 'Euclidean distance of paired UV surface and barycentric mesh samples; sampled correspondence in both directions, not Hausdorff maximum',
                        'degenerateBoundaryEdges': degenerate_edges,
                        'boundaryInsetRatio': inset_ratio,
                        'areaCheck': area_check,'float32AreaCheck': stored_area_check,
                        'sourceBoundarySamples': len(source_boundary),
                        'collapsedBoundaryTriangles': collapsed,
                        'mathematicalMaximumBound': False}}
        if rings == MAX_RINGS:
            break
        rings = min(MAX_RINGS, rings*2)
    return None
