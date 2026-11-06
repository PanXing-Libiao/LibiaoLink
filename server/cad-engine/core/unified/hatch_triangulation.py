import importlib.util
import math
from pathlib import Path

_EARCUT_PATH = Path(__file__).resolve().parents[1] / 'vendor' / 'ezdxf' / 'src' / 'ezdxf' / 'math' / '_mapbox_earcut.py'
_EARCUT = None
_BOUNDARY_EPSILON = 1e-7
_MAX_HOLES_PER_SHELL = 128
_MAX_SHELL_POINTS = 100000

class _Point:
    __slots__ = ('x', 'y', 'index')

    def __init__(self, x, y, index):
        self.x = float(x)
        self.y = float(y)
        self.index = index

def _area(ring):
    total = 0.0
    for index, point in enumerate(ring):
        following = ring[(index + 1) % len(ring)]
        total += point[0] * following[1] - following[0] * point[1]
    return total * 0.5

def _box(ring):
    xs = [point[0] for point in ring]
    ys = [point[1] for point in ring]
    return (min(xs), min(ys), max(xs), max(ys))

def _split_ring(points):
    stack = []
    positions = {}
    result = []
    for point in points:
        index = positions.get(point)
        if index is None:
            positions[point] = len(stack)
            stack.append(point)
            continue
        loop = stack[index:]
        if len(loop) >= 3:
            result.append(loop)
        for removed in stack[index + 1:]:
            positions.pop(removed, None)
        stack = stack[:index + 1]
    if len(stack) >= 3:
        result.append(stack)
    return result

def _clean(rings):
    cleaned = []
    for ring in rings or []:
        points = []
        for point in ring:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            x, y = float(point[0]), float(point[1])
            if not math.isfinite(x) or not math.isfinite(y):
                continue
            value = (round(x, 9), round(y, 9))
            if points and points[-1] == value:
                continue
            points.append(value)
        while len(points) > 2 and points[0] == points[-1]:
            points.pop()
        if len(points) >= 3:
            cleaned.extend(_split_ring(points))
    groups = {}
    for ring in cleaned:
        key = tuple(sorted(ring))
        groups.setdefault(key, []).append(ring)
    return [group[0] for group in groups.values() if len(group) % 2 == 1]

def normalize_rings(rings):
    return [list(ring) for ring in _clean(rings)]

def _relation(point, ring):
    x, y = point
    inside = False
    for index, first in enumerate(ring):
        second = ring[(index + 1) % len(ring)]
        x1, y1 = first
        x2, y2 = second
        cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        if (abs(cross) <= _BOUNDARY_EPSILON * max(1.0, abs(x2 - x1), abs(y2 - y1))
                and min(x1, x2) - _BOUNDARY_EPSILON <= x <= max(x1, x2) + _BOUNDARY_EPSILON
                and min(y1, y2) - _BOUNDARY_EPSILON <= y <= max(y1, y2) + _BOUNDARY_EPSILON):
            return 0
        if (y1 > y) != (y2 > y):
            boundary = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < boundary:
                inside = not inside
    return 1 if inside else -1

def _contains(inner, outer, inner_box, outer_box):
    if (inner_box[0] < outer_box[0] - _BOUNDARY_EPSILON
            or inner_box[1] < outer_box[1] - _BOUNDARY_EPSILON
            or inner_box[2] > outer_box[2] + _BOUNDARY_EPSILON
            or inner_box[3] > outer_box[3] + _BOUNDARY_EPSILON):
        return False
    has_interior = False
    for point in inner:
        relation = _relation(point, outer)
        if relation < 0:
            return False
        if relation > 0:
            has_interior = True
    return has_interior

def _earcut():
    global _EARCUT
    if _EARCUT is not None:
        return _EARCUT
    spec = importlib.util.spec_from_file_location('libiaolink_earcut', _EARCUT_PATH)
    if spec is None or spec.loader is None:
        raise ValueError('hatch-earcut-unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _EARCUT = module.earcut
    return _EARCUT

def triangulate(rings):
    rings = _clean(rings)
    if not rings:
        return []
    boxes = [_box(ring) for ring in rings]
    candidates = []
    for index, ring in enumerate(rings):
        candidates.append([other for other, other_ring in enumerate(rings)
                           if other != index and _contains(ring, other_ring, boxes[index], boxes[other])])
    depths = [len(values) for values in candidates]
    containers = {}
    for index, depth in enumerate(depths):
        if depth % 2 != 1:
            continue
        parents = [other for other in candidates[index] if depths[other] == depth - 1]
        if parents:
            containers[index] = min(parents, key=lambda other: abs(_area(rings[other])))
    earcut = _earcut()
    result = []
    for index, depth in enumerate(depths):
        if depth % 2 != 0:
            continue
        exterior = [_Point(x, y, point_index) for point_index, (x, y) in enumerate(rings[index])]
        hole_indices = sorted(other for other, owner in containers.items() if owner == index)
        if len(hole_indices) > _MAX_HOLES_PER_SHELL:
            return []
        if len(exterior) + sum(len(rings[hole]) for hole in hole_indices) > _MAX_SHELL_POINTS:
            return []
        holes = [[_Point(x, y, point_index) for point_index, (x, y) in enumerate(rings[hole_index])]
                 for hole_index in hole_indices]
        for triangle in earcut(exterior, holes):
            row = [[point.x, point.y] for point in triangle]
            area = ((row[1][0] - row[0][0]) * (row[2][1] - row[0][1])
                    - (row[2][0] - row[0][0]) * (row[1][1] - row[0][1]))
            if abs(area) <= 1e-18:
                continue
            if area < 0:
                row = [row[0], row[2], row[1]]
            result.append(row)
    return result
