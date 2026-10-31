# Adapted from cq-acis 0.3.12, copyright (c) 2026 cq-acis contributors.
# MIT license: dwg_acis_LICENSE.txt.
import math
def check_boundaries(converter, result, surface, boundaries):
    from OCP.BRep import BRep_Tool
    from OCP.BRepLib import BRepLib
    from OCP.Geom import Geom_CylindricalSurface, Geom_RectangularTrimmedSurface
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from cq_acis._supported_curves import deviation

    support = BRep_Tool.Surface_s(result.wrapped)
    if isinstance(support, Geom_RectangularTrimmedSurface):
        support = support.BasisSurface()
    def signature(s):
        c=s.BasisCurve();return (s.Direction().Coord(),c.MajorRadius(),c.MinorRadius(),c.Location().Coord(),c.Position().XDirection().Coord(),c.Position().YDirection().Coord())
    if type(support)!=type(surface) or signature(support)!=signature(surface):raise ValueError('support changed')
    # The seam tool creates a new edge at its default tolerance and may split
    # circles with unset parameter flags. Recompute generated UV clocks and
    # their tolerances, then independently qualify every 3D curve below.
    # This path has no saved pcurves to refit.
    BRepLib.SameParameter_s(result.wrapped, converter.tolerance, True)
    spans = [[] for _ in boundaries]
    maximum = 0.
    seams = []
    # OCCT may round the scaled source precision (e.g. 1e-6 * 10) by one ulp.
    tolerance_limit = math.nextafter(converter.tolerance, math.inf)
    for edge in result.Edges():
        curve = BRep_Tool.Curve_s(edge.wrapped, 0., 0.)
        first, last = BRep_Tool.Range_s(edge.wrapped)
        seam = BRep_Tool.IsClosed_s(edge.wrapped, result.wrapped)
        if seam:
            seams.append(edge)
        else:
            matches = [i for i, (source, saved, _, _) in enumerate(boundaries)
                       if curve == saved and edge.wrapped.Orientation() == source.wrapped.Orientation()]
            if len(matches) != 1:
                raise ValueError('changed, ambiguous or reversed physical boundary')
            spans[matches[0]].append((first, last))
        uses = (edge.wrapped, TopoDS.Edge_s(edge.wrapped.Reversed())) if seam else (edge.wrapped,)
        for use in uses:
            pc = BRep_Tool.CurveOnSurface_s(use, result.wrapped, 0., 0.)
            if pc is None or BRep_Tool.Range_s(use, result.wrapped) != (first, last):
                raise ValueError('missing pcurve or inconsistent trim clock')
            distance = deviation(curve, pc, surface, first, last)
            if not math.isfinite(distance) or distance > converter.tolerance:
                raise ValueError('seam pcurve exceeds source precision')
            maximum = max(maximum, distance)
        if BRep_Tool.Tolerance_s(edge.wrapped) > tolerance_limit:
            raise ValueError('edge tolerance was enlarged')
    if len(seams) != 1 or len(result.Wires()) != 1:
        raise ValueError('expected one chart seam in one wire')
    explorer = TopExp_Explorer(result.wrapped, TopAbs_EDGE)
    senses = []
    while explorer.More():
        use = explorer.Current()
        if use.IsSame(seams[0].wrapped):
            senses.append(use.Orientation())
        explorer.Next()
    if len(senses) != 2 or senses[0] == senses[1]:
        raise ValueError('chart seam must have two opposite uses')
    for (_, curve, first, last), intervals in zip(boundaries, spans):
        epsilon = max(1e-12, 64 * math.ulp(max(1., abs(first), abs(last))))
        if curve.IsPeriodic():
            period = curve.Period()
            normalized = []
            for start, end in intervals:
                length = end - start
                if length <= 0 or length > period + epsilon:
                    raise ValueError('invalid periodic trim length')
                start = first + (start - first) % period
                if first + period - start <= epsilon:
                    start = first
                end = start + length
                if end > first + period + epsilon:
                    normalized.extend(((start, first + period), (first, end - period)))
                else:
                    normalized.append((start, min(end, first + period)))
            intervals = normalized
        cursor = first
        for start, end in sorted(intervals):
            if abs(start - cursor) > epsilon or end <= start:
                raise ValueError('source trim was omitted, overlapped or extended')
            cursor = end
        if not intervals or abs(cursor - last) > epsilon:
            raise ValueError('incomplete source trim coverage')
    vertices = result.Vertices()
    for source, _, _, _ in boundaries:
        for vertex in source.Vertices():
            if not any(math.dist(vertex.toTuple(), other.toTuple()) <= converter.tolerance for other in vertices):
                raise ValueError('source vertex was removed or moved')
    if any(BRep_Tool.Tolerance_s(v.wrapped) > tolerance_limit for v in vertices):
        raise ValueError('vertex tolerance was enlarged')
    if not result.isValid() or not math.isfinite(result.Area()) or result.Area() <= 0:
        raise ValueError('cylinder seam did not produce a valid bounded face')
    return dict(source_edges=len(boundaries), physical_edges=sum(map(len, spans)),
                seam_edges=len(seams), max_deviation_mm=maximum, tolerance_mm=converter.tolerance)
