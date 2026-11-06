"""Spatially chunked DWG previews without changing source identities."""
from collections import defaultdict
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import struct

from .canonical import canonical_sha256
from .dwg_pack import IDENTITY

VERSION = 'ucd-dwg-chunks/1'
CHUNK_VERSION = 'ucd-dwg-chunk/1'
OVERVIEW_BUFFER = 'buffer-chunk-overview'
TILE_BYTES = 4 * 1024 * 1024
PACK_BYTES = 6 * 1024 * 1024
TILE_ITEMS = 2200
PACK_ITEMS = 28
DETAIL_SCALE_RATIO = 8.0
DETAIL_MIN_PIXELS = 96.0
CHUNK_BUNDLE_MAGIC = b'CDW1'
CHUNK_EXTENSION = 'org.cad-preview.server-chunks/1'
CHUNK_MIME = 'application/vnd.libiaolink.dwg-chunk/1'


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _align(value, width):
    remainder = value % width
    return value if remainder == 0 else value + width - remainder


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _box(values):
    if not isinstance(values, (list, tuple)) or len(values) < 4:
        return None
    if not all(_finite(value) for value in values[:4]):
        return None
    min_x, min_y, max_x, max_y = (float(value) for value in values[:4])
    if max_x < min_x or max_y < min_y:
        return None
    return {'minX': min_x, 'minY': min_y, 'maxX': max_x, 'maxY': max_y}


def _box_union(left, right):
    if right is None:
        return left
    if left is None:
        return dict(right)
    return {'minX': min(left['minX'], right['minX']), 'minY': min(left['minY'], right['minY']),
            'maxX': max(left['maxX'], right['maxX']), 'maxY': max(left['maxY'], right['maxY'])}


def _box_array(boxes):
    result = None
    for value in boxes:
        result = _box_union(result, value)
    return result


def _box_values(value):
    if value is None:
        return None
    return [value['minX'], value['minY'], value['maxX'], value['maxY']]


def _box_intersects(left, right, padding=0.0):
    return (left['minX'] <= right['maxX'] + padding and left['maxX'] >= right['minX'] - padding
            and left['minY'] <= right['maxY'] + padding and left['maxY'] >= right['minY'] - padding)


def _point_box(points):
    result = None
    for point in points or []:
        if not isinstance(point, (list, tuple)) or len(point) < 2 or not _finite(point[0]) or not _finite(point[1]):
            continue
        x, y = float(point[0]), float(point[1])
        result = _box_union(result, {'minX': x, 'minY': y, 'maxX': x, 'maxY': y})
    return result


def _ring_signed_area(ring):
    area = 0.0
    for index, point in enumerate(ring):
        next_point = ring[(index + 1) % len(ring)]
        area += point[0] * next_point[1] - next_point[0] * point[1]
    return area * 0.5


def _point_in_ring(point, ring):
    """Even-odd containment with a small inclusive boundary tolerance."""
    x, y = point
    inside = False
    epsilon = 1e-7
    for index, first in enumerate(ring):
        second = ring[(index + 1) % len(ring)]
        x1, y1 = first
        x2, y2 = second
        cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        if (abs(cross) <= epsilon
                and min(x1, x2) - epsilon <= x <= max(x1, x2) + epsilon
                and min(y1, y2) - epsilon <= y <= max(y1, y2) + epsilon):
            return True
        if (y1 > y) != (y2 > y):
            boundary_x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < boundary_x:
                inside = not inside
    return inside


def _orient_fill_rings(rings):
    """Orient union rings for non-zero fills.

    Independent HATCH entities are batched into one path.  Even-odd would let
    overlapping HATCHes cancel each other, so depth determines winding instead:
    outer rings are positive and nested holes are negative.  The same rule also
    preserves holes when one filled region overlaps the hole of another.
    """
    prepared = []
    for ring in rings or []:
        if len(ring) < 3:
            continue
        box = _point_box(ring)
        if box is None:
            continue
        prepared.append((abs(_ring_signed_area(ring)), box, ring))
    prepared.sort(key=lambda value: value[0], reverse=True)
    result = []
    for index, (_area, box, ring) in enumerate(prepared):
        probe = ring[0]
        depth = 0
        for larger_area, larger_box, larger in prepared[:index]:
            if larger_area <= 0.0:
                continue
            if (box['minX'] < larger_box['minX'] - 1e-7
                    or box['minY'] < larger_box['minY'] - 1e-7
                    or box['maxX'] > larger_box['maxX'] + 1e-7
                    or box['maxY'] > larger_box['maxY'] + 1e-7):
                continue
            if _point_in_ring(probe, larger):
                depth += 1
        desired = 1.0 if depth % 2 == 0 else -1.0
        if _ring_signed_area(ring) * desired < 0:
            ring = list(reversed(ring))
        result.append(ring)
    return result


def _matrix_multiply(left, right):
    result = [0.0] * 16
    for column in range(4):
        for row in range(4):
            result[column * 4 + row] = sum(left[k * 4 + row] * right[column * 4 + k] for k in range(4))
    return result


def _matrix_translate(matrix, x, y, z):
    result = list(matrix)
    result[12] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    result[13] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
    result[14] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
    result[15] = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
    return result


def _transform_point(matrix, x, y):
    return (matrix[0] * x + matrix[4] * y + matrix[12],
            matrix[1] * x + matrix[5] * y + matrix[13])


def _transform_box(box, matrix):
    if box is None:
        return None
    points = [_transform_point(matrix, x, y) for x, y in (
        (box['minX'], box['minY']), (box['maxX'], box['minY']),
        (box['maxX'], box['maxY']), (box['minX'], box['maxY']))]
    xs = [value[0] for value in points]
    ys = [value[1] for value in points]
    return {'minX': min(xs), 'minY': min(ys), 'maxX': max(xs), 'maxY': max(ys)}


def _matrix_from(value):
    return list(value) if isinstance(value, (list, tuple)) and len(value) == 16 and all(_finite(item) for item in value) else list(IDENTITY)


def _copies(instance):
    array = instance.get('array') if isinstance(instance.get('array'), dict) else {}
    row_offset = array.get('rowOffset') or [0, 0, 0]
    column_offset = array.get('columnOffset') or [0, 0, 0]
    if not (isinstance(row_offset, (list, tuple)) and len(row_offset) >= 3 and all(_finite(v) for v in row_offset[:3])):
        row_offset = [0, 0, 0]
    if not (isinstance(column_offset, (list, tuple)) and len(column_offset) >= 3 and all(_finite(v) for v in column_offset[:3])):
        column_offset = [0, 0, 0]
    rows = int(array['rows']) if _finite(array.get('rows')) and int(array['rows']) > 0 and any(row_offset) else 1
    columns = int(array['columns']) if _finite(array.get('columns')) and int(array['columns']) > 0 and any(column_offset) else 1
    return rows, columns, [float(v) for v in row_offset[:3]], [float(v) for v in column_offset[:3]]


def _copy_placement(parent, instance, row, column):
    rows, columns, row_offset, column_offset = _copies(instance)
    dx = column_offset[0] * column + row_offset[0] * row
    dy = column_offset[1] * column + row_offset[1] * row
    dz = column_offset[2] * column + row_offset[2] * row
    owner = _matrix_translate(parent, dx, dy, dz)
    return _matrix_multiply(owner, _matrix_from(instance.get('localFromBlock')))


def _array_corners(rows, columns):
    return ((0, 0), (max(0, rows - 1), 0), (0, max(0, columns - 1)), (max(0, rows - 1), max(0, columns - 1)))


def _geometry_box(geometry):
    if not isinstance(geometry, dict):
        return None
    kind = geometry.get('type')
    if kind == 'line':
        return _point_box([geometry.get('start'), geometry.get('end')])
    if kind == 'polyline':
        return _point_box(geometry.get('points'))
    if kind == 'point':
        return _point_box([geometry.get('position')])
    if kind == 'spline':
        return _point_box(list(geometry.get('controlPoints') or []) + list(geometry.get('fitPoints') or []))
    if kind in ('arc', 'circle'):
        center = geometry.get('center')
        radius = geometry.get('radius')
        if isinstance(center, (list, tuple)) and len(center) >= 2 and _finite(center[0]) and _finite(center[1]) and _finite(radius):
            return {'minX': center[0] - abs(radius), 'minY': center[1] - abs(radius),
                    'maxX': center[0] + abs(radius), 'maxY': center[1] + abs(radius)}
    if kind == 'ellipse':
        center = geometry.get('center')
        major = geometry.get('majorAxis') or [0, 0, 0]
        minor = geometry.get('minorAxis') or [0, 0, 0]
        if isinstance(center, (list, tuple)) and len(center) >= 2:
            radius_x = math.hypot(*(float(v) for v in major[:3])) if len(major) >= 3 else 0.0
            radius_y = math.hypot(*(float(v) for v in minor[:3])) if len(minor) >= 3 else 0.0
            return {'minX': center[0] - radius_x, 'minY': center[1] - radius_y,
                    'maxX': center[0] + radius_x, 'maxY': center[1] + radius_y}
    if kind == 'image' and isinstance(geometry.get('corners'), list):
        return _point_box(geometry['corners'])
    return None


def _estimate(value):
    return len(_bytes(value))


class _Resources:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.items = []
        self._ids = set()

    def put(self, resource_id, content_type, value):
        if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', resource_id) or resource_id in self._ids:
            raise ValueError('dwg-chunk-resource-id')
        self._ids.add(resource_id)
        name = resource_id + '.bin'
        (self.directory / name).write_bytes(value)
        item = {'id': resource_id, 'sha256': _digest(value), 'byteLength': len(value),
                'file': name, 'contentType': content_type}
        self.items.append(item)
        return item


class _Accessors:
    def __init__(self, payload, source_document, positions, buffer_id, prefix):
        self.payload = payload
        self.source_accessors = source_document['accessors']
        self.positions = positions
        self.buffer_id = buffer_id
        self.prefix = prefix
        self.offset = 0
        self.bytes = bytearray()
        self.mapping = {}

    def copy(self, accessor_id):
        found = self.mapping.get(accessor_id)
        if found is not None:
            return found
        accessor = self.source_accessors.get(accessor_id)
        if not isinstance(accessor, dict):
            return None
        byte_offset = accessor.get('byteOffset', 0)
        byte_length = accessor.get('byteLength')
        if not isinstance(byte_offset, int) or not isinstance(byte_length, int) or byte_offset < 0 or byte_length < 0 or byte_offset + byte_length > len(self.positions):
            raise ValueError('dwg-chunk-accessor-range')
        component = accessor.get('component')
        width = {'u8': 1, 'u16': 2, 'u32': 4, 'f32': 4, 'f64': 8}.get(component)
        if width is None:
            raise ValueError('dwg-chunk-accessor-component')
        aligned = _align(self.offset, width)
        if aligned > self.offset:
            self.bytes.extend(b'\0' * (aligned - self.offset))
            self.offset = aligned
        if byte_length:
            self.bytes.extend(self.positions[byte_offset:byte_offset + byte_length])
        new_id = self.prefix + '-a-' + str(len(self.mapping))
        self.mapping[accessor_id] = new_id
        self.payload['accessors'][new_id] = {**accessor, 'bufferId': self.buffer_id,
                                            'byteOffset': self.offset}
        self.offset += byte_length
        return new_id

    def finish(self):
        return bytes(self.bytes)


def _read_entity_box(document, entity_id, cache):
    if entity_id in cache:
        return cache[entity_id]
    entity = document['drawing']['entities'].get(entity_id)
    if not isinstance(entity, dict):
        cache[entity_id] = None
        return None
    result = None
    representation_id = entity.get('displayRepresentationId')
    representation = document['representations'].get(representation_id) if representation_id else None
    if isinstance(representation, dict):
        for binding in representation.get('bindings') or []:
            geometry = document['geometries'].get(binding.get('geometryId')) if isinstance(binding, dict) else None
            if isinstance(geometry, dict):
                bounds = geometry.get('bounds')
                if isinstance(bounds, dict) and isinstance(bounds.get('min'), list) and isinstance(bounds.get('max'), list):
                    minimum, maximum = bounds['min'], bounds['max']
                    if len(minimum) >= 2 and len(maximum) >= 2 and all(_finite(v) for v in minimum[:2] + maximum[:2]):
                        result = _box_union(result, {'minX': minimum[0], 'minY': minimum[1],
                                                     'maxX': maximum[0], 'maxY': maximum[1]})
                result = _box_union(result, _geometry_box(geometry))
    result = _box_union(result, _geometry_box(entity.get('geometry')))
    geometry = entity.get('geometry') if isinstance(entity.get('geometry'), dict) else {}
    if result is None and geometry.get('type') == 'hatch':
        for boundary_id in geometry.get('boundaryEntityIds') or []:
            if boundary_id != entity_id:
                result = _box_union(result, _read_entity_box(document, boundary_id, cache))
    cache[entity_id] = result
    return result


def _read_annotation_box(annotation):
    if not isinstance(annotation, dict):
        return None
    position = annotation.get('position')
    if not isinstance(position, (list, tuple)) or len(position) < 2 or not _finite(position[0]) or not _finite(position[1]):
        return None
    semantic = annotation.get('semantic') if isinstance(annotation.get('semantic'), dict) else {}
    height = semantic.get('height', {}).get('value') if isinstance(semantic.get('height'), dict) else None
    width = semantic.get('rectangleWidth', {}).get('value') if isinstance(semantic.get('rectangleWidth'), dict) else None
    if not _finite(height) or height <= 0:
        height = 1.0
    if not _finite(width) or width <= 0:
        width = max(height, len(str(annotation.get('text') or '')) * height * 0.7)
    return {'minX': position[0], 'minY': position[1], 'maxX': position[0] + max(width, 1e-9),
            'maxY': position[1] + max(height, 1e-9)}


def _index(document):
    drawing = document['drawing']
    entities = defaultdict(list)
    instances = defaultdict(list)
    annotations = defaultdict(list)
    for entity_id, row in drawing.get('entities', {}).items():
        if isinstance(row, dict):
            entities[row.get('ownerSpaceId')].append(entity_id)
    for instance_id, row in drawing.get('blockInstances', {}).items():
        if isinstance(row, dict):
            instances[row.get('ownerSpaceId')].append(instance_id)
    for annotation_id, row in drawing.get('annotations', {}).items():
        if isinstance(row, dict):
            annotations[row.get('ownerSpaceId')].append(annotation_id)
    block_spaces = {}
    for block_id, block in drawing.get('blocks', {}).items():
        if isinstance(block, dict) and isinstance(block.get('spaceId'), str):
            block_spaces[block['spaceId']] = block_id
    return entities, instances, annotations, block_spaces


def _space_box(document, space_id, context):
    entities = context['entities_by_space'].get(space_id, [])
    result = None
    for entity_id in entities:
        result = _box_union(result, _read_entity_box(document, entity_id, context['entity_boxes']))
    for annotation_id in context['annotations_by_space'].get(space_id, []):
        result = _box_union(result, _read_annotation_box(document['drawing']['annotations'].get(annotation_id)))
    for instance_id in context['instances_by_space'].get(space_id, []):
        result = _box_union(result, _instance_box(document, document['drawing']['blockInstances'][instance_id], IDENTITY, context))
    return result


def _block_box(document, block_id, context):
    memo = context['block_boxes']
    if block_id in memo:
        return memo[block_id]
    active = context['block_active']
    if block_id in active:
        return None
    active.add(block_id)
    try:
        block = document['drawing']['blocks'].get(block_id)
        result = _space_box(document, block.get('spaceId'), context) if isinstance(block, dict) else None
        memo[block_id] = result
        return result
    finally:
        active.discard(block_id)


def _instance_box(document, instance, parent, context):
    if not isinstance(instance, dict):
        return None
    local = _block_box(document, instance.get('definitionId'), context)
    if local is None:
        return None
    rows, columns = _copies(instance)[:2]
    result = None
    for row, column in _array_corners(rows, columns):
        result = _box_union(result, _transform_box(local, _copy_placement(parent, instance, row, column)))
    return result


def _space_entity_ids(document, space_id):
    space = document['drawing']['spaces'].get(space_id) if isinstance(document['drawing'].get('spaces'), dict) else None
    values = space.get('entityIds') if isinstance(space, dict) else None
    return [value for value in values or [] if isinstance(value, str)]


def _style_extension(document):
    value = document.get('extensions', {}).get('org.cad-preview.style-inheritance/1')
    return value if isinstance(value, dict) else {}


def _item(document, kind, key, value, box, style, layer_id, order):
    return {'kind': kind, 'key': key, 'value': value, 'box': box, 'style': copy.deepcopy(style) if isinstance(style, dict) else {},
            'layerId': layer_id, 'order': order if _finite(order) else 0}


def _top_items(document, space_id, context):
    drawing = document['drawing']
    style = _style_extension(document)
    result = []
    for entity_id in _space_entity_ids(document, space_id):
        entity = drawing.get('entities', {}).get(entity_id)
        box = _read_entity_box(document, entity_id, context['entity_boxes'])
        result.append(_item(document, 'entity', entity_id, entity, box,
                            entity.get('style') if isinstance(entity, dict) else None,
                            entity.get('layerId') if isinstance(entity, dict) else None,
                            entity.get('displayOrder') if isinstance(entity, dict) else 0))
    for instance_id in drawing.get('spaces', {}).get(space_id, {}).get('blockInstanceIds', []) or []:
        instance = drawing.get('blockInstances', {}).get(instance_id)
        box = _instance_box(document, instance, IDENTITY, context)
        result.append(_item(document, 'instance', instance_id, instance, box,
                            instance.get('style') if isinstance(instance, dict) else None,
                            instance.get('layerId') if isinstance(instance, dict) else None,
                            (style.get('drawOrder') or {}).get(instance_id, 0)))
    for annotation_id in drawing.get('spaces', {}).get(space_id, {}).get('annotationIds', []) or []:
        annotation = drawing.get('annotations', {}).get(annotation_id)
        result.append(_item(document, 'annotation', annotation_id, annotation, _read_annotation_box(annotation),
                            (style.get('annotationStyles') or {}).get(annotation_id, {'color': {'mode': 'by-layer'}, 'plot': True}),
                            annotation.get('layerId') if isinstance(annotation, dict) else None,
                            (style.get('drawOrder') or {}).get(annotation_id, 0)))
    return result


def _kd_split(items, max_items, max_bytes, depth=0):
    total = sum(item['estimate'] for item in items)
    if len(items) <= max_items and total <= max_bytes or len(items) < 2 or depth >= 12:
        return [items]
    box = _box_array(item['box'] for item in items if item['box'] is not None)
    axis = 'x' if box is None or box['maxX'] - box['minX'] >= box['maxY'] - box['minY'] else 'y'
    ordered = sorted(items, key=lambda item: ((item['box']['minX'] + item['box']['maxX']) / 2 if item['box'] and axis == 'x'
                                              else (item['box']['minY'] + item['box']['maxY']) / 2 if item['box'] else 0,
                                              item['key']))
    half = total / 2
    split = 0
    running = 0
    for index, item in enumerate(ordered[:-1]):
        running += item['estimate']
        split = index + 1
        if running >= half:
            break
    split = max(1, min(len(ordered) - 1, split))
    return _kd_split(ordered[:split], max_items, max_bytes, depth + 1) + _kd_split(ordered[split:], max_items, max_bytes, depth + 1)


def _strongly_connected(nodes, edges):
    """Return SCCs so cyclic block references stay in one fetchable pack."""
    index = {}
    low = {}
    stack = []
    active = set()
    result = []
    counter = 0
    def visit(node):
        nonlocal counter
        index[node] = low[node] = counter
        counter += 1
        stack.append(node)
        active.add(node)
        for target in edges.get(node, ()):
            if target not in index:
                visit(target)
                low[node] = min(low[node], low[target])
            elif target in active:
                low[node] = min(low[node], index[target])
        if low[node] == index[node]:
            component = []
            while True:
                value = stack.pop()
                active.remove(value)
                component.append(value)
                if value == node:
                    break
            result.append(component)
    for node in nodes:
        if node not in index:
            visit(node)
    return result

OVERVIEW_GRID = 64
OVERVIEW_MAX_DEPTH = 32
OVERVIEW_MAX_LEAVES = 400000
OVERVIEW_FIT_QUANTILE = 0.002
OVERVIEW_CURVE_POINTS = 16
OVERVIEW_SEGMENTS_PER_GROUP = 65536


def _style_key(item):
    try:
        return _canonical(item['style'])
    except (TypeError, ValueError):
        return '{}'


def _annotation_style(document, annotation_id):
    extension = _style_extension(document)
    styles = extension.get('annotationStyles') if isinstance(extension.get('annotationStyles'), dict) else {}
    style = styles.get(annotation_id)
    return style if isinstance(style, dict) else {'color': {'mode': 'by-layer'}, 'plot': True}


def _sample_values(values, maximum):
    count = len(values)
    if count <= maximum:
        return list(values)
    if maximum <= 1:
        return [values[0]]
    return [values[round(index * (count - 1) / (maximum - 1))]
            for index in range(maximum)]


def _sample_axis(count):
    count = int(count) if _finite(count) else 1
    if count < 1:
        count = 1
    return list(range(count))


def _vector2(value, fallback=(1.0, 0.0)):
    if isinstance(value, (list, tuple)) and len(value) >= 2 and _finite(value[0]) and _finite(value[1]):
        x, y = float(value[0]), float(value[1])
        length = math.hypot(x, y)
        if length > 1e-12:
            return (x / length, y / length)
    return fallback


def _clean_path(points, maximum=OVERVIEW_CURVE_POINTS):
    result = []
    for point in points or []:
        if not isinstance(point, (list, tuple)) or len(point) < 2 or not _finite(point[0]) or not _finite(point[1]):
            continue
        value = (float(point[0]), float(point[1]))
        if not result or abs(value[0] - result[-1][0]) > 1e-9 or abs(value[1] - result[-1][1]) > 1e-9:
            result.append(value)
    if maximum is not None and len(result) > maximum:
        result = _sample_values(result, maximum)
    return result


def _arc_path(center, radius, start_angle, sweep_angle, x_axis=None, normal=None):
    if not (isinstance(center, (list, tuple)) and len(center) >= 2 and _finite(center[0]) and _finite(center[1])
            and _finite(radius) and _finite(start_angle) and _finite(sweep_angle)):
        return []
    axis_x = _vector2(x_axis)
    sign = -1.0 if isinstance(normal, (list, tuple)) and len(normal) >= 3 and _finite(normal[2]) and normal[2] < 0 else 1.0
    axis_y = (-axis_x[1] * sign, axis_x[0] * sign)
    count = max(1, min(24, int(math.ceil(abs(sweep_angle) / (math.pi / 4)))))
    result = []
    for index in range(count + 1):
        angle = start_angle + sweep_angle * index / count
        radius_x = float(radius) * math.cos(angle)
        radius_y = float(radius) * math.sin(angle)
        result.append((float(center[0]) + radius_x * axis_x[0] + radius_y * axis_y[0],
                       float(center[1]) + radius_x * axis_x[1] + radius_y * axis_y[1]))
    return result


def _ellipse_path(center, major, minor, start_angle, sweep_angle):
    if not (isinstance(center, (list, tuple)) and len(center) >= 2
            and isinstance(major, (list, tuple)) and len(major) >= 2
            and isinstance(minor, (list, tuple)) and len(minor) >= 2
            and all(_finite(value) for value in (center[0], center[1], major[0], major[1], minor[0], minor[1],
                                                  start_angle, sweep_angle))):
        return []
    count = max(1, min(24, int(math.ceil(abs(sweep_angle) / (math.pi / 4)))))
    result = []
    for index in range(count + 1):
        angle = start_angle + sweep_angle * index / count
        cosine, sine = math.cos(angle), math.sin(angle)
        result.append((float(center[0]) + cosine * float(major[0]) + sine * float(minor[0]),
                       float(center[1]) + cosine * float(major[1]) + sine * float(minor[1])))
    return result


def _geometry_paths(geometry, maximum=OVERVIEW_CURVE_POINTS):
    if not isinstance(geometry, dict):
        return []
    kind = geometry.get('type')
    if kind == 'line':
        return [path for path in (_clean_path([geometry.get('start'), geometry.get('end')], maximum),) if len(path) >= 2]
    if kind == 'polyline':
        path = _clean_path(geometry.get('points'), maximum)
        if geometry.get('closed') and len(path) > 2 and path[0] != path[-1]:
            path.append(path[0])
        return [path] if len(path) >= 2 else []
    if kind == 'arc':
        path = _arc_path(geometry.get('center'), geometry.get('radius'),
                         geometry.get('startAngle'), geometry.get('sweepAngle'),
                         geometry.get('xAxis'), geometry.get('normal'))
        return [path] if len(path) >= 2 else []
    if kind == 'circle':
        return [_arc_path(geometry.get('center'), geometry.get('radius'), 0.0, math.tau,
                          geometry.get('xAxis'), geometry.get('normal'))]
    if kind == 'ellipse':
        sweep = geometry.get('sweepAngle')
        if not _finite(sweep):
            sweep = math.tau
        path = _ellipse_path(geometry.get('center'), geometry.get('majorAxis'), geometry.get('minorAxis'),
                             geometry.get('startAngle') if _finite(geometry.get('startAngle')) else 0.0,
                             sweep)
        return [path] if len(path) >= 2 else []
    if kind == 'spline':
        path = _clean_path(geometry.get('fitPoints') or geometry.get('controlPoints'), maximum)
        return [path] if len(path) >= 2 else []
    if kind == 'point':
        position = geometry.get('position')
        if isinstance(position, (list, tuple)) and len(position) >= 2 and _finite(position[0]) and _finite(position[1]):
            x, y = float(position[0]), float(position[1])
            return [[(x - 1e-6, y), (x + 1e-6, y)], [(x, y - 1e-6), (x, y + 1e-6)]]
    return []


def _layer_rgba(document, layer_id):
    layer = document['drawing'].get('layers', {}).get(layer_id)
    default = layer.get('defaultStyle') if isinstance(layer, dict) else None
    color = default.get('color') if isinstance(default, dict) else None
    rgba = color.get('rgba') if isinstance(color, dict) else None
    if (isinstance(rgba, (list, tuple)) and len(rgba) >= 4
            and all(_finite(value) for value in rgba[:4])):
        return [float(value) for value in rgba[:4]]
    return [1.0, 1.0, 1.0, 1.0]


def _overview_style(document, style, layer_id, chain):
    result = copy.deepcopy(style) if isinstance(style, dict) else {}
    color = result.get('color') if isinstance(result.get('color'), dict) else {'mode': 'by-layer'}
    mode = color.get('mode')
    rgba = None
    if mode == 'explicit':
        value = color.get('rgba')
        if (isinstance(value, (list, tuple)) and len(value) >= 4
                and all(_finite(item) for item in value[:4])):
            rgba = [float(item) for item in value[:4]]
    elif mode == 'by-block':
        for parent_style, parent_layer in reversed(chain):
            parent_color = parent_style.get('color') if isinstance(parent_style, dict) else None
            parent_mode = parent_color.get('mode') if isinstance(parent_color, dict) else None
            if parent_mode == 'explicit':
                value = parent_color.get('rgba')
                if (isinstance(value, (list, tuple)) and len(value) >= 4
                        and all(_finite(item) for item in value[:4])):
                    rgba = [float(item) for item in value[:4]]
                    break
            elif parent_mode == 'by-layer':
                rgba = _layer_rgba(document, parent_layer)
                break
    if rgba is None:
        rgba = _layer_rgba(document, layer_id)
    result['color'] = {'mode': 'explicit', 'rgba': rgba}
    result.setdefault('plot', True)
    return result


def _hatch_boundary_paths(document, entity):
    geometry = entity.get('geometry') if isinstance(entity, dict) else None
    if not isinstance(geometry, dict) or geometry.get('type') != 'hatch':
        return []
    result = []
    for boundary_id in geometry.get('boundaryEntityIds') or []:
        boundary = document['drawing'].get('entities', {}).get(boundary_id)
        if not isinstance(boundary, dict):
            continue
        matrix = _matrix_from(boundary.get('localFromOwner'))
        for value in _transform_paths(_geometry_paths(boundary.get('geometry'), maximum=None), matrix):
            path = _clean_path(value, maximum=None)
            while (len(path) > 2 and abs(path[0][0] - path[-1][0]) <= 1e-9
                   and abs(path[0][1] - path[-1][1]) <= 1e-9):
                path.pop()
            if len(path) >= 3:
                result.append(path)
    return result


def _triangulate_hatch_rings(rings):
    """Triangulate one HATCH before batches merge, so holes stay holes."""
    if not rings:
        return []
    try:
        from .hatch_triangulation import triangulate as triangulate_hatch
        return triangulate_hatch(rings)
    except (ImportError, OSError, ValueError):
        return []

def _prepare_fill_triangles(document):
    fill = (document.get('extensions') or {}).get('org.cad-preview.fill/1')
    values = fill.get('fills') if isinstance(fill, dict) else None
    prepared = {}
    if not isinstance(values, dict):
        return prepared
    for key, entry in values.items():
        if not isinstance(entry, dict):
            continue
        triangles = entry.get('triangles')
        if isinstance(triangles, list) and triangles:
            entry['fillRule'] = 'nonzero'
            prepared[key] = triangles
            continue
        rings = entry.get('rings')
        triangles = _triangulate_hatch_rings(rings) if isinstance(rings, list) and rings else []
        if triangles:
            entry['triangles'] = triangles
            entry.pop('rings', None)
            entry['fillRule'] = 'nonzero'
            prepared[key] = triangles
            continue
        try:
            from .hatch_triangulation import normalize_rings
            cleaned = normalize_rings(rings) if isinstance(rings, list) else []
            if cleaned:
                entry['rings'] = [[[x, y] for x, y in ring] for ring in cleaned]
        except (ImportError, OSError, ValueError, TypeError):
            pass
        entry['fillRule'] = 'even-odd'
        prepared[key] = []
    return prepared

def _transform_paths(paths, matrix):
    return [[_transform_point(matrix, x, y) for x, y in path] for path in paths]


def _path_segments(paths):
    result = []
    for path in paths:
        for first, second in zip(path, path[1:]):
            result.append((first[0], first[1], second[0], second[1]))
    return result


def _box_segments(box):
    if box is None:
        return []
    min_x, min_y, max_x, max_y = box['minX'], box['minY'], box['maxX'], box['maxY']
    return [(min_x, min_y, max_x, min_y), (max_x, min_y, max_x, max_y),
            (max_x, max_y, min_x, max_y), (min_x, max_y, min_x, min_y)]


def _transform_triangles(triangles, matrix):
    return [[_transform_point(matrix, point[0], point[1]) for point in triangle]
            for triangle in triangles]


def _overview_entity_leaves(document, entity, parent, order, chain, context):
    if not isinstance(entity, dict) or context['overview_leaf_count'] >= OVERVIEW_MAX_LEAVES:
        return
    matrix = _matrix_multiply(parent, _matrix_from(entity.get('localFromOwner')))
    geometry = entity.get('geometry') if isinstance(entity.get('geometry'), dict) else {}
    rings = []
    paths = []
    triangles = []
    if geometry.get('type') == 'hatch':
        entity_id = entity.get('id')
        entry = context['fill_entries'].get(entity_id)
        local_rings = _hatch_boundary_paths(document, entity)
        if not local_rings and isinstance(entry, dict) and isinstance(entry.get('rings'), list):
            local_rings = [[[float(point[0]), float(point[1])] for point in ring
                            if isinstance(point, (list, tuple)) and len(point) >= 2]
                           for ring in entry['rings']]
            local_rings = [ring for ring in local_rings if len(ring) >= 3]
        rings = _transform_paths(local_rings, matrix)
        if entity_id in context['hatch_triangles']:
            local_triangles = context['hatch_triangles'][entity_id]
        else:
            local_triangles = _triangulate_hatch_rings(local_rings) if local_rings else []
            context['hatch_triangles'][entity_id] = local_triangles
        triangles = _transform_triangles(local_triangles, matrix)
        points = [point for ring in rings for point in ring]
        points.extend(point for triangle in triangles for point in triangle)
        box = _point_box(points)
    else:
        paths = _transform_paths(_geometry_paths(geometry), matrix)
        box = _read_entity_box(document, entity.get('id'), context['entity_boxes'])
        if box is not None:
            box = _transform_box(box, matrix)
        elif paths:
            box = _point_box([point for path in paths for point in path])
    if box is None:
        return
    context['overview_leaf_count'] += 1
    layer_id = entity.get('layerId')
    yield (box, _overview_style(document, entity.get('style'), layer_id, chain),
           layer_id, order, paths, rings, triangles)


def _overview_annotation_leaves(document, annotation, parent, order, chain, context):
    if not isinstance(annotation, dict) or context['overview_leaf_count'] >= OVERVIEW_MAX_LEAVES:
        return
    box = _read_annotation_box(annotation)
    if box is None:
        return
    matrix = _matrix_multiply(parent, _matrix_from(annotation.get('localFromOwner')))
    context['overview_leaf_count'] += 1
    layer_id = annotation.get('layerId')
    yield (_transform_box(box, matrix),
           _overview_style(document, _annotation_style(document, annotation.get('id')), layer_id, chain),
           layer_id, order, [], [], [])


def _overview_instance_leaves(document, instance, parent, order, depth, active, chain, context):
    if not isinstance(instance, dict) or context['overview_leaf_count'] >= OVERVIEW_MAX_LEAVES:
        return
    block_id = instance.get('definitionId')
    block = document['drawing'].get('blocks', {}).get(block_id)
    space_id = block.get('spaceId') if isinstance(block, dict) else None
    before = context['overview_leaf_count']
    if space_id and depth < OVERVIEW_MAX_DEPTH and block_id not in active:
        active.add(block_id)
        try:
            rows, columns, _row_offset, _column_offset = _copies(instance)
            child_chain = chain + [(instance.get('style') or {}, instance.get('layerId'))]
            for row in _sample_axis(rows):
                for column in _sample_axis(columns):
                    if context['overview_leaf_count'] >= OVERVIEW_MAX_LEAVES:
                        break
                    matrix = _copy_placement(parent, instance, row, column)
                    yield from _overview_space_leaves(document, space_id, matrix, depth + 1, active, child_chain, context)
                if context['overview_leaf_count'] >= OVERVIEW_MAX_LEAVES:
                    break
        finally:
            active.discard(block_id)
    if context['overview_leaf_count'] == before:
        box = _instance_box(document, instance, parent, context)
        if box is not None:
            context['overview_leaf_count'] += 1
            layer_id = instance.get('layerId')
            yield (box, _overview_style(document, instance.get('style'), layer_id, chain),
                   layer_id, order, [], [], [])


def _overview_item_leaves(document, item, parent, depth, active, chain, context):
    kind = item.get('kind')
    value = item.get('value')
    order = item.get('order') or 0
    if kind == 'entity':
        yield from _overview_entity_leaves(document, value, parent, order, chain, context)
    elif kind == 'annotation':
        yield from _overview_annotation_leaves(document, value, parent, order, chain, context)
    elif kind == 'instance':
        yield from _overview_instance_leaves(document, value, parent, order, depth, active, chain, context)
    elif item.get('box') is not None:
        context['overview_leaf_count'] += 1
        layer_id = item.get('layerId')
        yield (item['box'], _overview_style(document, item.get('style'), layer_id, chain),
               layer_id, order, [], [], [])


def _overview_space_leaves(document, space_id, parent, depth, active, chain, context):
    if depth > OVERVIEW_MAX_DEPTH:
        return
    drawing = document['drawing']
    for entity_id in context['entities_by_space'].get(space_id, ()):
        entity = drawing.get('entities', {}).get(entity_id)
        if isinstance(entity, dict):
            yield from _overview_entity_leaves(document, entity, parent,
                                               entity.get('displayOrder') or 0, chain, context)
    for instance_id in context['instances_by_space'].get(space_id, ()):
        instance = drawing.get('blockInstances', {}).get(instance_id)
        if isinstance(instance, dict):
            yield from _overview_instance_leaves(document, instance, parent,
                                                 instance.get('displayOrder') or 0,
                                                 depth, active, chain, context)
    for annotation_id in context['annotations_by_space'].get(space_id, ()):
        annotation = drawing.get('annotations', {}).get(annotation_id)
        if isinstance(annotation, dict):
            yield from _overview_annotation_leaves(document, annotation, parent,
                                                   annotation.get('displayOrder') or 0, chain, context)


def _overview_cell_items(document, items, context):
    tile_box = _box_array(item['box'] for item in items if item.get('box') is not None)
    if tile_box is None:
        return []
    width = max(0.0, tile_box['maxX'] - tile_box['minX'])
    height = max(0.0, tile_box['maxY'] - tile_box['minY'])
    span = max(width, height)
    cell_size = span / OVERVIEW_GRID if span > 0 else 0.0
    cells = {}
    direct = []
    for item in items:
        for box, style, layer_id, order, paths, rings, triangles in _overview_item_leaves(
                document, item, IDENTITY, 0, set(), [], context):
            if box is None:
                continue
            paths = [path for path in paths if len(path) >= 2]
            rings = [ring for ring in rings if len(ring) >= 3]
            triangles = [triangle for triangle in triangles if len(triangle) >= 3]
            is_fill = bool(rings or triangles)
            box_width = max(0.0, box['maxX'] - box['minX'])
            box_height = max(0.0, box['maxY'] - box['minY'])
            if cell_size <= 0 or max(box_width, box_height) > cell_size * 1.75:
                segments = _path_segments(rings if is_fill else paths)
                if not segments:
                    segments = _box_segments(box)
                direct.append({'box': box, 'style': style, 'layerId': layer_id, 'order': order,
                               'segments': segments, 'rings': rings, 'triangles': triangles, 'fill': is_fill})
                context['overview_fit_boxes'].append(box)
                continue
            column = max(0, min(OVERVIEW_GRID - 1,
                                int((box['minX'] + box['maxX']) * 0.5 - tile_box['minX']) // max(cell_size, 1e-9)))
            row = max(0, min(OVERVIEW_GRID - 1,
                             int((box['minY'] + box['maxY']) * 0.5 - tile_box['minY']) // max(cell_size, 1e-9)))
            key = (layer_id or '', _canonical(style), column, row, 'fill' if is_fill else 'line')
            cell = cells.get(key)
            if cell is None:
                cell = cells[key] = {'box': dict(box), 'style': style, 'layerId': layer_id,
                                     'order': order, 'paths': [], 'boxes': [], 'rings': [],
                                     'triangles': [], 'fill': is_fill}
            else:
                cell['box'] = _box_union(cell['box'], box)
                cell['order'] = min(cell['order'], order)
            if is_fill:
                cell['rings'].extend(rings)
                cell['triangles'].extend(triangles)
            elif paths:
                cell['paths'].extend(paths)
            else:
                cell['boxes'].append(box)
    result = direct
    for cell in cells.values():
        context['overview_fit_boxes'].append(cell['box'])
        segments = _path_segments(cell['rings'] if cell['fill'] else cell['paths'])
        if not segments:
            segments = []
            for box in cell['boxes']:
                segments.extend(_box_segments(box))
        result.append({'box': cell['box'], 'style': cell['style'], 'layerId': cell['layerId'],
                       'order': cell['order'], 'segments': segments,
                       'rings': cell['rings'], 'triangles': cell['triangles'], 'fill': cell['fill']})
    return result


def _overview_groups(items, tile_id):
    groups = {}
    for item in items:
        if item['box'] is None:
            continue
        fill = bool(item.get('fill') and (item.get('triangles') or item.get('rings')))
        key = (item['layerId'] or '', _style_key(item), 'fill' if fill else 'line')
        group = groups.get(key)
        if group is None:
            group = groups[key] = {'items': [], 'style': item['style'], 'layerId': item['layerId'],
                                   'order': item['order'], 'segments': [], 'seen': set(),
                                   'rings': [], 'ringsSeen': set(), 'triangles': [],
                                   'trianglesSeen': set(), 'fill': fill}
        group['items'].append(item)
        group['order'] = min(group['order'], item['order'])
        if fill:
            for ring in item.get('rings') or []:
                identity = tuple((round(point[0], 3), round(point[1], 3)) for point in ring)
                if identity in group['ringsSeen']:
                    continue
                group['ringsSeen'].add(identity)
                group['rings'].append(ring)
            for triangle in item.get('triangles') or []:
                identity = tuple((round(point[0], 3), round(point[1], 3)) for point in triangle)
                if identity in group['trianglesSeen']:
                    continue
                group['trianglesSeen'].add(identity)
                group['triangles'].append(triangle)
        for segment in item.get('segments') or []:
            identity = tuple(round(value, 3) for value in segment)
            if identity in group['seen']:
                continue
            group['seen'].add(identity)
            group['segments'].append(segment)
    result = []
    group_index = 0
    for group in groups.values():
        box = _box_array(item['box'] for item in group['items'])
        segments = group['segments']
        for left, bottom, right, top in segments:
            box = _box_union(box, {'minX': min(left, right), 'minY': min(bottom, top),
                                   'maxX': max(left, right), 'maxY': max(bottom, top)})
        if box is None or (not segments and not fill):
            continue
        fill = bool(group['fill'] and (group['triangles'] or group['rings']))
        if fill:
            group['rings'] = _orient_fill_rings(group['rings'])
            result.append({'style': group['style'], 'layerId': group['layerId'],
                           'order': group['order'], 'box': box, 'segments': segments,
                           'rings': group['rings'], 'triangles': group['triangles'], 'fill': True,
                           'id': 'chunk-overview-' + tile_id + '-' + str(group_index) + '-0'})
        else:
            for batch_start in range(0, len(segments), OVERVIEW_SEGMENTS_PER_GROUP):
                batch_segments = segments[batch_start:batch_start + OVERVIEW_SEGMENTS_PER_GROUP]
                if not batch_segments:
                    continue
                batch_index = batch_start // OVERVIEW_SEGMENTS_PER_GROUP
                result.append({'style': group['style'], 'layerId': group['layerId'],
                               'order': group['order'], 'box': box, 'segments': batch_segments,
                               'rings': [], 'fill': False,
                               'id': 'chunk-overview-' + tile_id + '-' + str(group_index) + '-' + str(batch_index)})
        group_index += 1
    return result


def _overview_fit_bounds(boxes, model_bounds):
    if model_bounds is None or len(boxes) < 32:
        return model_bounds
    xs = []
    ys = []
    for box in boxes:
        xs.extend((box['minX'], box['maxX']))
        ys.extend((box['minY'], box['maxY']))
    xs.sort()
    ys.sort()
    index = max(0, min(len(xs) - 1, int(len(xs) * OVERVIEW_FIT_QUANTILE)))
    upper = max(0, min(len(xs) - 1, int(len(xs) * (1 - OVERVIEW_FIT_QUANTILE))))
    robust = {'minX': xs[index], 'minY': ys[index], 'maxX': xs[upper], 'maxY': ys[upper]}
    if robust['maxX'] <= robust['minX'] or robust['maxY'] <= robust['minY']:
        return model_bounds
    raw_width = model_bounds['maxX'] - model_bounds['minX']
    raw_height = model_bounds['maxY'] - model_bounds['minY']
    robust_width = robust['maxX'] - robust['minX']
    robust_height = robust['maxY'] - robust['minY']
    # Only replace the raw extents when a very small tail is stretching the
    # fit view by a material amount. Ordinary drawings keep their exact bounds.
    if not (robust_width < raw_width * 0.75 or robust_height < raw_height * 0.75):
        return model_bounds
    pad_x = robust_width * 0.02
    pad_y = robust_height * 0.02
    return {'minX': robust['minX'] - pad_x, 'minY': robust['minY'] - pad_y,
            'maxX': robust['maxX'] + pad_x, 'maxY': robust['maxY'] + pad_y}


def _segment_bytes(items):
    values = []
    for item in items:
        segments = item.get('segments') or _box_segments(item.get('box'))
        for left, bottom, right, top in segments:
            values.extend((left, bottom, 0.0, right, top, 0.0))
    return struct.pack('<' + 'd' * len(values), *values)


def _copy_representation(document, representation_id, chunk_id, accessors):
    representation = document['representations'].get(representation_id)
    if not isinstance(representation, dict):
        return None, None
    copied = copy.deepcopy(representation)
    copied_representation_id = 'chunk-' + chunk_id + '-r-' + str(len(accessors.payload['representations']))
    copied['id'] = copied_representation_id
    copied_bindings = []
    geometry_records = {}
    geometry_index = len(accessors.payload['geometries'])
    for binding in copied.get('bindings') or []:
        old_geometry_id = binding.get('geometryId')
        geometry = document['geometries'].get(old_geometry_id)
        if not isinstance(geometry, dict):
            return None, None
        new_geometry_id = 'chunk-' + chunk_id + '-g-' + str(geometry_index + len(geometry_records))
        new_geometry = copy.deepcopy(geometry)
        new_geometry['id'] = new_geometry_id
        position_id = (geometry.get('attributes') or {}).get('POSITION')
        new_position_id = accessors.copy(position_id) if position_id else None
        if new_position_id is None:
            return None, None
        new_geometry['attributes'] = {**(geometry.get('attributes') or {}), 'POSITION': new_position_id}
        for primitive in new_geometry.get('primitives') or []:
            index_id = primitive.get('indices')
            if index_id:
                new_index_id = accessors.copy(index_id)
                if new_index_id is None:
                    return None, None
                primitive['indices'] = new_index_id
        copied_bindings.append({**binding, 'geometryId': new_geometry_id})
        geometry_records[new_geometry_id] = new_geometry
    copied['bindings'] = copied_bindings
    return copied, geometry_records

def _copy_entity_payload(document, entity_id, chunk_id, accessors, copied_representations):
    entity = document['drawing']['entities'].get(entity_id)
    if not isinstance(entity, dict):
        return None
    result = copy.deepcopy(entity)
    representation_id = entity.get('displayRepresentationId')
    if not representation_id:
        result.pop('displayRepresentationId', None)
        return result
    copied_id = copied_representations.get(representation_id)
    if copied_id is None:
        representation, geometries = _copy_representation(document, representation_id, chunk_id, accessors)
        if representation is None:
            return None
        copied_id = representation['id']
        copied_representations[representation_id] = copied_id
        accessors.payload['representations'][copied_id] = representation
        for geometry_id, geometry in (geometries or {}).items():
            accessors.payload['geometries'][geometry_id] = geometry
    result['displayRepresentationId'] = copied_id
    return result

def _copy_extension_representations(document, extensions, chunk_id, accessors, copied_representations):
    presentation = extensions.get('org.cad-preview.annotation-presentation/1')
    if not isinstance(presentation, dict):
        return
    def resolve(representation_id):
        copied_id = copied_representations.get(representation_id)
        if copied_id is not None:
            return copied_id
        representation, geometries = _copy_representation(document, representation_id, chunk_id, accessors)
        if representation is None:
            raise ValueError('dwg-chunk-extension-representation:' + representation_id)
        copied_id = representation['id']
        copied_representations[representation_id] = copied_id
        accessors.payload['representations'][copied_id] = representation
        for geometry_id, geometry in (geometries or {}).items():
            accessors.payload['geometries'][geometry_id] = geometry
        return copied_id
    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == 'representationId' and isinstance(child, str):
                    value[key] = resolve(child)
                else:
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(presentation.get('items') or {})

def _pick_mapped(source, identifiers):
    if not isinstance(source, dict):
        return {}
    result = {}
    for key, value in source.items():
        matched = key in identifiers
        if not matched:
            parts = key.split('-')
            if len(parts) > 2 and parts[0] in ('entity', 'instance', 'annotation'):
                matched = '-'.join(parts[:2]) in identifiers
        if matched:
            result[key] = copy.deepcopy(value)
    return result


def _extension_subset(document, entity_ids, instance_ids, annotation_ids):
    extensions = document.get('extensions') if isinstance(document.get('extensions'), dict) else {}
    result = {}
    style = extensions.get('org.cad-preview.style-inheritance/1')
    if isinstance(style, dict):
        selected = {}
        for key in ('entityState', 'modes', 'drawOrder', 'annotationStyles'):
            values = style.get(key)
            if isinstance(values, dict):
                identifiers = entity_ids | instance_ids | annotation_ids
                selected[key] = _pick_mapped(values, identifiers)
            elif key in style:
                selected[key] = copy.deepcopy(style[key])
        if selected:
            result['org.cad-preview.style-inheritance/1'] = selected
    fill = extensions.get('org.cad-preview.fill/1')
    if isinstance(fill, dict) and isinstance(fill.get('fills'), dict):
        values = _pick_mapped(fill['fills'], entity_ids)
        if values:
            result['org.cad-preview.fill/1'] = {'fills': values}
    presentations = extensions.get('org.cad-preview.annotation-presentation/1')
    if isinstance(presentations, dict) and isinstance(presentations.get('items'), dict):
        picked = _pick_mapped(presentations['items'], entity_ids | annotation_ids)
        if picked:
            selected = {'items': picked}
            for key, value in presentations.items():
                if key != 'items':
                    selected[key] = copy.deepcopy(value)
            result['org.cad-preview.annotation-presentation/1'] = selected
    dwg = extensions.get('org.libiaolink.dwg/1')
    if isinstance(dwg, dict):
        selected = {}
        for key in ('nativeGeometry', 'hatchSemantics', 'meshPresentations', 'multiLeaderSemantics', 'opaque'):
            if isinstance(dwg.get(key), dict):
                values = _pick_mapped(dwg[key], entity_ids)
                if values:
                    selected[key] = values
        if isinstance(dwg.get('textAppearance'), dict):
            values = _pick_mapped(dwg['textAppearance'], annotation_ids)
            if values:
                selected['textAppearance'] = values
        if isinstance(dwg.get('dimensionSemantics'), dict):
            values = _pick_mapped(dwg['dimensionSemantics'], instance_ids)
            if values:
                selected['dimensionSemantics'] = values
        if selected:
            result['org.libiaolink.dwg/1'] = selected
    return result


def _base_extensions(document):
    extensions = copy.deepcopy(document.get('extensions') or {})
    style = extensions.get('org.cad-preview.style-inheritance/1')
    if isinstance(style, dict):
        for key in ('entityState', 'modes', 'drawOrder', 'annotationStyles'):
            if key in style:
                style[key] = {}
    fill = extensions.get('org.cad-preview.fill/1')
    if isinstance(fill, dict) and isinstance(fill.get('fills'), dict):
        fill['fills'] = {}
    presentations = extensions.get('org.cad-preview.annotation-presentation/1')
    if isinstance(presentations, dict) and isinstance(presentations.get('items'), dict):
        presentations['items'] = {}
    dwg = extensions.get('org.libiaolink.dwg/1')
    if isinstance(dwg, dict):
        for key in ('nativeGeometry', 'textAppearance', 'dimensionSemantics', 'hatchSemantics',
                    'meshPresentations', 'multiLeaderSemantics', 'opaque'):
            if key in dwg:
                dwg[key] = {}
    return extensions


def _merge_space(document, space_id, patch):
    target = document['drawing']['spaces'].get(space_id)
    if not isinstance(target, dict):
        target = copy.deepcopy(patch)
        document['drawing']['spaces'][space_id] = target
        return
    for key in ('entityIds', 'blockInstanceIds', 'annotationIds'):
        values = target.get(key)
        if not isinstance(values, list):
            values = target[key] = []
        for value in patch.get(key) or []:
            if value not in values:
                values.append(value)


def _base_document(document, overview_entities, overview_annotations, overview_accessors, overview_geometries,
                   overview_representations, overview_spaces, overview_annotation_spaces, overview_annotation_styles,
                   overview_bytes):
    base = {key: value for key, value in document.items() if key != 'drawing'}
    drawing = {key: value for key, value in document['drawing'].items()}
    drawing['entities'] = dict(overview_entities)
    drawing['annotations'] = dict(overview_annotations)
    for key in ('blockInstances', 'blocks'):
        drawing[key] = {}
    spaces = {}
    for space_id, space in document['drawing'].get('spaces', {}).items():
        if not isinstance(space, dict):
            continue
        copy_space = {key: value for key, value in space.items()}
        copy_space['entityIds'] = list(overview_spaces.get(space_id, []))
        copy_space['blockInstanceIds'] = []
        copy_space['annotationIds'] = list(overview_annotation_spaces.get(space_id, []))
        spaces[space_id] = copy_space
    drawing['spaces'] = spaces
    base['drawing'] = drawing
    base['accessors'] = overview_accessors
    base['geometries'] = overview_geometries
    base['representations'] = overview_representations
    base['extensions'] = _base_extensions(document)
    if overview_annotation_styles:
        style_ext = base['extensions'].setdefault('org.cad-preview.style-inheritance/1', {})
        style_ext.setdefault('annotationStyles', {}).update(copy.deepcopy(overview_annotation_styles))
    base['buffers'] = {OVERVIEW_BUFFER: {'id': OVERVIEW_BUFFER, 'sha256': _digest(overview_bytes),
                                         'byteLength': len(overview_bytes), 'endianness': 'little', 'alignment': 8,
                                         'storage': {'kind': 'resource', 'resourceId': OVERVIEW_BUFFER}}}
    base['revision'] = canonical_sha256({key: value for key, value in base.items() if key != 'revision'})
    return base


def build_dwg_chunks(document, positions, directory, snapshot=None, presentation=None):
    if not isinstance(document, dict) or document.get('schemaVersion') != '2.0.0':
        raise ValueError('dwg-chunk-document')
    drawing = document.get('drawing')
    if not isinstance(drawing, dict) or not isinstance(drawing.get('spaces'), dict):
        raise ValueError('dwg-chunk-drawing')
    if not isinstance(positions, (bytes, bytearray)):
        raise ValueError('dwg-chunk-positions')
    positions = bytes(positions)
    resources = _Resources(directory)
    entities_by_space, instances_by_space, annotations_by_space, block_spaces = _index(document)
    context = {'entities_by_space': entities_by_space, 'instances_by_space': instances_by_space,
               'annotations_by_space': annotations_by_space, 'entity_boxes': {},
               'block_boxes': {}, 'block_active': set(), 'overview_leaf_count': 0,
               'overview_fit_boxes': [], 'fill_entries': {}, 'hatch_triangles': {}}
    context['fill_entries'] = _prepare_fill_triangles(document)
    context['hatch_triangles'] = dict(context['fill_entries'])
    drawings = drawing.get('drawings') if isinstance(drawing.get('drawings'), dict) else {}
    model_space_id = None
    for row in drawings.values():
        if isinstance(row, dict) and isinstance(row.get('modelSpaceId'), str):
            model_space_id = row['modelSpaceId']
            break
    if model_space_id is None:
        model_space_id = next((key for key, value in drawing['spaces'].items()
                               if isinstance(value, dict) and value.get('kind') == 'model'), None)
    if model_space_id is None:
        raise ValueError('dwg-chunk-model-space')
    top_spaces = []
    for space_id, space in drawing['spaces'].items():
        if not isinstance(space, dict):
            continue
        if space_id == model_space_id or space.get('kind') in ('paper', 'layout'):
            top_spaces.append(space_id)
    items_by_space = {}
    all_top_items = []
    for space_id in top_spaces:
        values = _top_items(document, space_id, context)
        for value in values:
            value['spaceId'] = space_id
            value['estimate'] = _estimate(value['value']) + 256
        items_by_space[space_id] = values
        all_top_items.extend(values)
    model_items = items_by_space.get(model_space_id, [])
    bounded = [item for item in model_items if item['box'] is not None]
    unbounded = [item for item in model_items if item['box'] is None]
    groups = _kd_split(bounded, TILE_ITEMS, TILE_BYTES) if bounded else []
    tiles = []
    for index, group in enumerate(groups):
        tiles.append({'id': 'tile-' + str(index).zfill(3), 'spaceId': model_space_id, 'items': group,
                      'bounds': _box_array(item['box'] for item in group), 'always': False})
    layout_groups = []
    for space_id in top_spaces:
        if space_id == model_space_id:
            continue
        values = items_by_space.get(space_id, [])
        for group in (_kd_split(values, TILE_ITEMS, TILE_BYTES) if values else []):
            layout_groups.append({'id': 'layout-' + str(len(layout_groups)).zfill(3), 'spaceId': space_id,
                                  'items': group, 'bounds': _box_array(item['box'] for item in group),
                                  'always': False})
    if unbounded:
        tiles.append({'id': 'tile-unbounded', 'spaceId': model_space_id, 'items': unbounded,
                      'bounds': _box_array(item['box'] for item in model_items) or {'minX': 0, 'minY': 0, 'maxX': 0, 'maxY': 0},
                      'always': True})
    referenced_blocks = set()
    def visit(block_id, seen):
        if block_id in seen or block_id not in drawing.get('blocks', {}):
            return
        seen.add(block_id)
        referenced_blocks.add(block_id)
        block = drawing['blocks'][block_id]
        space_id = block.get('spaceId') if isinstance(block, dict) else None
        for instance_id in drawing.get('spaces', {}).get(space_id, {}).get('blockInstanceIds', []) or []:
            instance = drawing.get('blockInstances', {}).get(instance_id)
            if isinstance(instance, dict):
                visit(instance.get('definitionId'), seen)
    for values in items_by_space.values():
        for item in values:
            if item['kind'] == 'instance' and isinstance(item['value'], dict):
                visit(item['value'].get('definitionId'), set())
    all_blocks = set(drawing.get('blocks', {}))
    block_estimates = {}
    for block_id in all_blocks:
        block = drawing['blocks'].get(block_id)
        space_id = block.get('spaceId') if isinstance(block, dict) else None
        estimate = _estimate(block) + _estimate(drawing['spaces'].get(space_id, {})) + 128
        for entity_id in _space_entity_ids(document, space_id):
            entity = drawing.get('entities', {}).get(entity_id)
            estimate += _estimate(entity) + 256
            if isinstance(entity, dict) and entity.get('displayRepresentationId'):
                representation = document['representations'].get(entity['displayRepresentationId'])
                if isinstance(representation, dict):
                    estimate += _estimate(representation)
        for instance_id in drawing.get('spaces', {}).get(space_id, {}).get('blockInstanceIds', []) or []:
            estimate += _estimate(drawing.get('blockInstances', {}).get(instance_id, {})) + 128
        for annotation_id in drawing.get('spaces', {}).get(space_id, {}).get('annotationIds', []) or []:
            estimate += _estimate(drawing.get('annotations', {}).get(annotation_id, {})) + 128
        block_estimates[block_id] = estimate
    unreferenced = all_blocks - referenced_blocks
    def ordered(values):
        return sorted(values, key=lambda block_id: (
            (_block_box(document, block_id, context) or {'minX': 0, 'minY': 0, 'maxX': 0, 'maxY': 0})['minX'],
            block_id))
    packs = []
    for values in (ordered(referenced_blocks), ordered(unreferenced)):
        current = []
        current_bytes = 0
        for block_id in values:
            size = block_estimates.get(block_id, 0)
            if current and (current_bytes + size > PACK_BYTES or len(current) >= PACK_ITEMS):
                packs.append(current)
                current = []
                current_bytes = 0
            current.append(block_id)
            current_bytes += size
        if current:
            packs.append(current)
    # A packed block can reference a block in another pack, including a
    # circular dynamic-block chain. Condense every cyclic component into one
    # immutable pack; the resulting pack graph is a DAG that the browser can
    # fetch dependency-first without recursion loops.
    initial_pack = {}
    for index, pack in enumerate(packs):
        for block_id in pack:
            initial_pack[block_id] = index
    pack_edges = {}
    for index, pack in enumerate(packs):
        targets = set()
        for block_id in pack:
            block = drawing['blocks'].get(block_id)
            space_id = block.get('spaceId') if isinstance(block, dict) else None
            for instance_id in drawing.get('spaces', {}).get(space_id, {}).get('blockInstanceIds', []) or []:
                instance = drawing.get('blockInstances', {}).get(instance_id)
                target = initial_pack.get(instance.get('definitionId')) if isinstance(instance, dict) else None
                if target is not None and target != index:
                    targets.add(target)
        pack_edges[index] = sorted(targets)
    components = _strongly_connected(range(len(packs)), pack_edges)
    if any(len(component) > 1 for component in components):
        merged = []
        for component in components:
            members = []
            for index in sorted(component):
                members.extend(packs[index])
            merged.append((min(component), members))
        merged.sort(key=lambda item: item[0])
        packs = [members for _, members in merged]
    definition_pack = {}
    for index, pack in enumerate(packs):
        for block_id in pack:
            definition_pack[block_id] = 'block-pack-' + str(index).zfill(3)
    def dependencies_for_blocks(block_ids):
        result = set()
        for block_id in block_ids:
            block = drawing['blocks'].get(block_id)
            space_id = block.get('spaceId') if isinstance(block, dict) else None
            for instance_id in drawing.get('spaces', {}).get(space_id, {}).get('blockInstanceIds', []) or []:
                instance = drawing.get('blockInstances', {}).get(instance_id)
                dependency = definition_pack.get(instance.get('definitionId')) if isinstance(instance, dict) else None
                if dependency and dependency != definition_pack.get(block_id):
                    result.add(dependency)
        return sorted(result)
    if not tiles and not layout_groups and not packs:
        tiles.append({'id': 'tile-empty', 'spaceId': model_space_id, 'items': [],
                      'bounds': {'minX': 0.0, 'minY': 0.0, 'maxX': 0.0, 'maxY': 0.0}, 'always': True})
    chunk_specs = []
    for tile in tiles:
        dependencies = set()
        for item in tile['items']:
            if item['kind'] == 'instance' and isinstance(item['value'], dict):
                dependency = definition_pack.get(item['value'].get('definitionId'))
                if dependency:
                    dependencies.add(dependency)
        chunk_specs.append({**tile, 'kind': 'tile', 'dependencies': sorted(dependencies)})
    for layout in layout_groups:
        dependencies = set()
        for item in layout['items']:
            if item['kind'] == 'instance' and isinstance(item['value'], dict):
                dependency = definition_pack.get(item['value'].get('definitionId'))
                if dependency:
                    dependencies.add(dependency)
        chunk_specs.append({**layout, 'kind': 'layout', 'dependencies': sorted(dependencies)})
    for index, pack in enumerate(packs):
        pack_id = 'block-pack-' + str(index).zfill(3)
        bounds = _box_array(_block_box(document, block_id, context) for block_id in pack)
        chunk_specs.append({'id': pack_id, 'kind': 'block', 'items': [], 'blockIds': pack,
                            'spaceId': None, 'bounds': bounds or {'minX': 0, 'minY': 0, 'maxX': 0, 'maxY': 0},
                            'dependencies': dependencies_for_blocks(pack),
                            'always': all(block_id not in referenced_blocks for block_id in pack)})
    chunk_index = []
    overview_cache = {}
    overview_spaces = defaultdict(list)
    overview_accessors = {}
    overview_geometries = {}
    overview_representations = {}
    overview_bytes = bytearray()
    overview_bytes_offset = 0
    overview_order = {}
    overview_bindings = {}
    overview_fills = {}
    overview_annotations = {}
    overview_annotation_spaces = defaultdict(list)
    overview_annotation_styles = {}
    for item in model_items:
        if item['kind'] != 'annotation':
            continue
        annotation_id = item['key']
        source_annotation = drawing.get('annotations', {}).get(annotation_id)
        if not isinstance(source_annotation, dict):
            continue
        synthetic_id = 'overview-a-' + annotation_id
        synthetic = copy.deepcopy(source_annotation)
        synthetic['id'] = synthetic_id
        synthetic['ownerSpaceId'] = model_space_id
        synthetic.pop("ownerBlockInstanceId", None)
        overview_annotations[synthetic_id] = synthetic
        overview_annotation_spaces[model_space_id].append(synthetic_id)
        overview_annotation_styles[synthetic_id] = _overview_style(
            document, _annotation_style(document, annotation_id),
            source_annotation.get('layerId'), [])
    for spec in chunk_specs:
        if spec['kind'] == 'block':
            groups = []
        else:
            context['overview_leaf_count'] = 0
            overview_items = _overview_cell_items(document, spec['items'], context)
            groups = _overview_groups(overview_items, spec['id'])
        spec['overview'] = []
        for group in groups:
            group_id = group['id']
            overview_order[group_id] = group['order']
            accessor_id = 'overview-a-' + group_id
            geometry_id = 'overview-g-' + group_id
            representation_id = 'overview-r-' + group_id
            entity_id = 'overview-e-' + group_id
            spec['overview'].append(entity_id)
            segment = _segment_bytes([group])
            overview_bytes_offset = _align(overview_bytes_offset, 8)
            if len(overview_bytes) < overview_bytes_offset:
                overview_bytes.extend(b'\0' * (overview_bytes_offset - len(overview_bytes)))
            byte_offset = len(overview_bytes)
            overview_bytes.extend(segment)
            count = len(segment) // 24
            overview_accessors[accessor_id] = {'bufferId': OVERVIEW_BUFFER, 'byteOffset': byte_offset,
                                               'byteLength': len(segment), 'component': 'f64', 'components': 3,
                                               'count': count, 'normalized': False}
            box = group['box']
            overview_geometries[geometry_id] = {'id': geometry_id, 'coordinateSpace': 'geometry-local',
                                                'attributes': {'POSITION': accessor_id},
                                                'primitives': [{'id': 'p', 'topology': 'lines',
                                                                'range': {'first': 0, 'count': count}}],
                                                'bounds': {'min': [box['minX'], box['minY'], 0.0],
                                                           'max': [box['maxX'], box['maxY'], 0.0]},
                                                'normalOrigin': 'absent', 'sourceRefs': []}
            overview_representations[representation_id] = {
                'id': representation_id, 'kind': 'drawing',
                'bindings': [{'id': 'b', 'geometryId': geometry_id, 'localFromRepresentation': IDENTITY,
                              'materialSlots': {}}], 'sourceRefs': []}
            layer_id = group['layerId'] or next(iter(drawing.get('layers', {})), 'layer-0')
            geometry = ({'type': 'hatch', 'boundaryEntityIds': [entity_id], 'fillRule': 'nonzero'}
                        if group.get('fill') else
                        {'type': 'unsupported', 'sourceType': 'chunk-overview', 'reason': 'chunk-overview'})
            entity = {'id': entity_id, 'drawingId': (drawing['spaces'].get(spec['spaceId']) or {}).get('drawingId', 'drawing-dwg'),
                      'ownerSpaceId': spec['spaceId'], 'layerId': layer_id, 'localFromOwner': IDENTITY,
                      'geometry': geometry,
                      'style': group['style'] or {'color': {'mode': 'by-layer'}, 'plot': True},
                      'sourceRefs': [{'sourceId': 'source-0', 'objectKey': 'chunk-overview:' + group_id}],
                      'displayOrder': group['order']}
            if group.get('fill'):
                if group.get('triangles'):
                    overview_fills[entity_id] = {'fillRule': 'nonzero',
                                                 'triangles': copy.deepcopy(group.get('triangles') or [])}
                else:
                    overview_fills[entity_id] = {'fillRule': 'nonzero',
                                                 'rings': copy.deepcopy(group.get('rings') or [])}
            overview_cache[entity_id] = entity
            overview_bindings[entity_id] = representation_id
            overview_spaces[spec['spaceId']].append(entity_id)
            spec.setdefault('overviewEntities', []).append(entity)
    for spec in chunk_specs:
        chunk_id = spec['id']
        prefix = 'chunk-' + chunk_id
        chunk_document = {'schemaVersion': '2.0.0', 'drawing': {'spaces': {}, 'entities': {}, 'blockInstances': {},
                                                                 'annotations': {}, 'blocks': {}},
                          'accessors': {}, 'geometries': {}, 'representations': {}, 'extensions': {}}
        entity_ids = set()
        instance_ids = set()
        annotation_ids = set()
        block_ids = set(spec.get('blockIds') or [])
        space_ids = set()
        if spec['kind'] == 'block':
            for block_id in block_ids:
                block = drawing['blocks'].get(block_id)
                if not isinstance(block, dict):
                    continue
                space_id = block.get('spaceId')
                block_ids.add(block_id)
                chunk_document['drawing']['blocks'][block_id] = copy.deepcopy(block)
                chunk_document['drawing']['spaces'][space_id] = copy.deepcopy(drawing['spaces'].get(space_id, {}))
                space_ids.add(space_id)
                for entity_id in _space_entity_ids(document, space_id):
                    entity_ids.add(entity_id)
                for instance_id in drawing.get('spaces', {}).get(space_id, {}).get('blockInstanceIds', []) or []:
                    instance_ids.add(instance_id)
                for annotation_id in drawing.get('spaces', {}).get(space_id, {}).get('annotationIds', []) or []:
                    annotation_ids.add(annotation_id)
        else:
            space_id = spec['spaceId']
            space_ids.add(space_id)
            patch = {'entityIds': [], 'blockInstanceIds': [], 'annotationIds': []}
            for item in spec['items']:
                if item['kind'] == 'entity':
                    entity_ids.add(item['key'])
                    patch['entityIds'].append(item['key'])
                elif item['kind'] == 'instance':
                    instance_ids.add(item['key'])
                    patch['blockInstanceIds'].append(item['key'])
                else:
                    annotation_ids.add(item['key'])
                    patch['annotationIds'].append(item['key'])
            chunk_document['drawing']['spaces'][space_id] = patch
        accessors = _Accessors(chunk_document, document, positions, 'buffer-' + chunk_id, prefix)
        copied_representations = {}
        for entity_id in sorted(entity_ids):
            entity = _copy_entity_payload(document, entity_id, chunk_id, accessors, copied_representations)
            if entity is not None:
                chunk_document['drawing']['entities'][entity_id] = entity
        for instance_id in sorted(instance_ids):
            instance = drawing.get('blockInstances', {}).get(instance_id)
            if isinstance(instance, dict):
                chunk_document['drawing']['blockInstances'][instance_id] = copy.deepcopy(instance)
        for annotation_id in sorted(annotation_ids):
            annotation = drawing.get('annotations', {}).get(annotation_id)
            if isinstance(annotation, dict):
                chunk_document['drawing']['annotations'][annotation_id] = copy.deepcopy(annotation)
        chunk_document['extensions'] = _extension_subset(document, entity_ids, instance_ids, annotation_ids)
        _copy_extension_representations(document, chunk_document['extensions'], chunk_id, accessors, copied_representations)
        position_bytes = accessors.finish()
        buffer_id = 'buffer-' + chunk_id
        if position_bytes:
            chunk_document.setdefault('buffers', {})[buffer_id] = {'id': buffer_id, 'sha256': _digest(position_bytes),
                                                                   'byteLength': len(position_bytes), 'endianness': 'little',
                                                                   'alignment': 8, 'storage': {'kind': 'resource', 'resourceId': buffer_id}}
        chunk = {'version': CHUNK_VERSION, 'id': chunk_id, 'kind': spec['kind'], 'bounds': _box_values(spec['bounds']),
                 'dependencies': spec['dependencies'], 'removeOverview': spec['overview'],
                 'buffer': ({'id': buffer_id, 'sha256': _digest(position_bytes), 'byteLength': len(position_bytes)}
                            if position_bytes else None),
                 'counts': {'entities': len(entity_ids), 'instances': len(instance_ids),
                            'annotations': len(annotation_ids), 'blocks': len(block_ids), 'spaces': len(space_ids)},
                 'document': chunk_document}
        document_bytes = _bytes(chunk)
        resource_id = 'chunk-' + chunk_id
        # One immutable fetch per chunk: 12-byte framed JSON document plus its
        # little-endian position payload. The outer resource hash covers both.
        bundle = struct.pack('<4sII', CHUNK_BUNDLE_MAGIC, len(document_bytes), len(position_bytes)) + document_bytes + position_bytes
        resource = resources.put(resource_id, CHUNK_MIME, bundle)
        chunk_index.append({'id': chunk_id, 'kind': spec['kind'], 'spaceId': spec.get('spaceId'), 'bounds': _box_values(spec['bounds']),
                            'dependencies': spec['dependencies'], 'always': bool(spec.get('always')),
                            'removeOverview': spec['overview'], 'counts': chunk['counts'],
                            'resourceId': resource_id, 'resourceSHA256': resource['sha256'],
                            'resourceBytes': resource['byteLength'], 'documentBytes': len(document_bytes),
                            'positionBytes': len(position_bytes)})
    model_bounds = _box_array(item['box'] for item in model_items if item['box'] is not None)
    if model_bounds is None:
        model_bounds = {'minX': 0.0, 'minY': 0.0, 'maxX': 0.0, 'maxY': 0.0}
    fit_bounds = _overview_fit_bounds(context['overview_fit_boxes'], model_bounds)
    base = _base_document(document, overview_cache, overview_annotations, overview_accessors, overview_geometries,
                          overview_representations, overview_spaces, overview_annotation_spaces,
                          overview_annotation_styles, bytes(overview_bytes))
    if snapshot is not None:
        base_snapshot = copy.deepcopy(snapshot)
        base_snapshot['documentRevision'] = base['revision']
    else:
        base_snapshot = None
    chunking = {'version': VERSION, 'modelSpaceId': model_space_id, 'bounds': _box_values(model_bounds),
                'fitBounds': _box_values(fit_bounds),
                'detailScaleRatio': DETAIL_SCALE_RATIO, 'detailMinPixels': DETAIL_MIN_PIXELS,
                'tiles': [row for row in chunk_index if row['kind'] == 'tile'],
                'layouts': [row for row in chunk_index if row['kind'] == 'layout'],
                'blocks': [row for row in chunk_index if row['kind'] == 'block'],
                'overview': {'bufferId': OVERVIEW_BUFFER, 'entityIds': sorted(overview_cache),
                             'representations': dict(overview_bindings)},
                'resourceCount': len(resources.items),
                'resourceBytes': sum(item['byteLength'] for item in resources.items)}
    # The chunk index belongs to the base document so revision and snapshot
    # identity cover exactly the bytes the viewer will receive and defer.
    base['extensions'] = dict(base.get('extensions') or {})
    if overview_fills:
        fill_extension = base['extensions'].setdefault('org.cad-preview.fill/1', {})
        fill_extension['fills'] = overview_fills
    base['extensions'][CHUNK_EXTENSION] = copy.deepcopy(chunking)
    base['revision'] = canonical_sha256({key: value for key, value in base.items() if key != 'revision'})
    if base_snapshot is not None:
        base_snapshot['documentRevision'] = base['revision']
        base_snapshot.pop('id', None)
        base_snapshot['id'] = 'snapshot-' + _digest(_canonical(base_snapshot).encode('utf-8'))
    if presentation is not None:
        stats = dict(presentation.get('stats') or {})
        stats['overviewGeometry'] = len(overview_cache)
        stats['chunked'] = True
        presentation['stats'] = stats
    return base, bytes(overview_bytes), OVERVIEW_BUFFER, chunking, resources.items, base_snapshot
