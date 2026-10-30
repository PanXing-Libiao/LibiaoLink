"""Bounded source clipping in block coordinates and paper coordinates."""
import math
from ezdxf import path
from ezdxf.xclip import XClip

MAX_CLIP_VERTICES = 16384


def polygon(points):
    result = []
    for p in points:
        point = [float(p[0]), float(p[1])]
        if not all(math.isfinite(value) for value in point):
            raise ValueError('clip-boundary-nonfinite')
        if not result or point != result[-1]:
            result.append(point)
        if len(result) > MAX_CLIP_VERTICES:
            raise ValueError('clip-boundary-vertex-limit')
    if len(result) > 1 and result[0] == result[-1]:
        result.pop()
    if len(result) < 3:
        raise ValueError('clip-boundary-degenerate')
    x0, y0 = result[0]
    area = sum((a[0]-x0)*(b[1]-y0)-(b[0]-x0)*(a[1]-y0) for a,b in zip(result,result[1:]+result[:1]))
    if area == 0 or not math.isfinite(area):
        raise ValueError('clip-boundary-zero-area')
    return result


def block_clip(insert):
    clip = XClip(insert)
    if not clip.is_clipping_enabled:
        return None
    spatial = clip.get_spatial_filter()
    if spatial.dxf.has_front_clipping_plane or spatial.dxf.has_back_clipping_plane:
        raise ValueError('xclip-depth-planes-unsupported')
    normal = spatial.dxf.extrusion
    if abs(normal.x) > 1e-9 or abs(normal.y) > 1e-9 or abs(normal.z) < 1e-9:
        raise ValueError('xclip-nonplanar-boundary-unsupported')
    boundary = clip.get_block_clipping_path()
    if boundary.is_inverted_clip and (not boundary.inverted_clip or not boundary.inverted_clip_compare):
        raise ValueError('xclip-inverted-data-incomplete')
    points = boundary.inner_polygon() if boundary.is_inverted_clip else boundary.vertices
    return {'boundary': polygon(points), 'inverted': boundary.is_inverted_clip}


def viewport_boundary(viewport):
    if not viewport.dxf.flags & 65536:
        return polygon(viewport.clipping_rect_corners())
    handle = viewport.dxf.clipping_boundary_handle
    entity = viewport.doc.entitydb.get(handle)
    if entity is None or not entity.is_alive:
        raise ValueError('viewport-clipping-boundary-missing')
    curve = path.make_path(entity)
    if not curve.is_closed:
        raise ValueError('viewport-clipping-boundary-open')
    tolerance = max(min(viewport.dxf.width, viewport.dxf.height) * 1e-5, 1e-9)
    return polygon(curve.flattening(tolerance, segments=4))
