"""Lossless indexing of native DWG display lines before platform publication."""
from array import array
import struct
import sys


def compact_display_buffers(document, raw):
    candidates = {}
    for key, geometry in document['geometries'].items():
        primitives = geometry['primitives']
        if len(primitives) != 1:
            continue
        primitive = primitives[0]
        aid = geometry['attributes']['POSITION']
        accessor = document['accessors'][aid]
        if (primitive['topology'] == 'lines' and 'indices' not in primitive
                and primitive['range'] == {'first': 0, 'count': accessor['count']}
                and accessor['count'] >= 8 and accessor['component'] == 'f64'
                and accessor['components'] == 3 and accessor['byteLength'] == accessor['count'] * 24):
            candidates[aid] = ('i-' + key[2:], primitive)
    result = bytearray()
    indexed = vertices_before = vertices_after = 0
    added_accessors = {}
    for aid, accessor in document['accessors'].items():
        start = accessor['byteOffset']
        source = memoryview(raw)[start:start + accessor['byteLength']]
        positions = source
        indices = None
        unique_count = accessor['count']
        if aid in candidates:
            unique = bytearray()
            seen = {}
            order = array('I')
            for (point,) in struct.iter_unpack('<24s', source):
                index = seen.get(point)
                if index is None:
                    index = len(seen)
                    seen[point] = index
                    unique.extend(point)
                order.append(index)
            if len(unique) + len(order) * 4 < len(source):
                if sys.byteorder != 'little':
                    order.byteswap()
                positions, indices, unique_count = unique, order.tobytes(), len(seen)
        accessor['byteOffset'] = len(result)
        result.extend(positions)
        accessor['byteLength'] = len(positions)
        if indices is not None:
            indexed += 1
            vertices_before += accessor['count']
            vertices_after += unique_count
            accessor['count'] = unique_count
            index_id, primitive = candidates[aid]
            primitive['indices'] = index_id
            added_accessors[index_id] = {'bufferId': 'buffer-0', 'byteOffset': len(result),
                'byteLength': len(indices), 'component': 'u32', 'components': 1,
                'count': len(indices) // 4, 'normalized': False}
            result.extend(indices)
        while len(result) % 8:
            result.append(0)
    document['accessors'].update(added_accessors)
    return bytes(result), {'originalBytes': len(raw), 'compactedBytes': len(result),
        'indexedGeometries': indexed, 'verticesBefore': vertices_before, 'verticesAfter': vertices_after}
