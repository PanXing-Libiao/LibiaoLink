"""Lossless indexing and shared byte windows for native DWG display buffers."""
from array import array
import struct
import sys


def _index_bytes(values):
    maximum = max(values, default=0)
    component, code = ('u8', 'B') if maximum <= 255 else ('u16', 'H') if maximum <= 65535 else ('u32', 'I')
    result = array(code, values)
    if sys.byteorder != 'little': result.byteswap()
    return component, result.tobytes()


def compact_display_buffers(document, raw):
    candidates = {}; index_accessors = set()
    for key, geometry in document['geometries'].items():
        primitives = geometry['primitives']
        index_accessors.update(p['indices'] for p in primitives if 'indices' in p)
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
    result = bytearray(); windows = {}
    indexed = vertices_before = vertices_after = shared_bytes = narrowed = 0
    added_accessors = {}

    def append_window(data):
        nonlocal shared_bytes
        data = bytes(data)
        offset = windows.get(data)
        if offset is not None:
            shared_bytes += len(data)
            return offset
        offset = len(result); windows[data] = offset; result.extend(data)
        while len(result) % 8: result.append(0)
        return offset

    for aid, accessor in document['accessors'].items():
        start = accessor['byteOffset']
        source = memoryview(raw)[start:start + accessor['byteLength']]
        positions = source; indices = None; index_component = None
        unique_count = accessor['count']
        if aid in candidates:
            unique = bytearray(); seen = {}; order = array('I')
            for (point,) in struct.iter_unpack('<24s', source):
                index = seen.get(point)
                if index is None:
                    index = len(seen); seen[point] = index; unique.extend(point)
                order.append(index)
            index_component, candidate_indices = _index_bytes(order)
            if len(unique) + len(candidate_indices) < len(source):
                positions, indices, unique_count = unique, candidate_indices, len(seen)
        elif (aid in index_accessors and accessor['component'] == 'u32'
                and accessor['components'] == 1 and not accessor['normalized']
                and accessor.get('byteStride', 4) == 4 and accessor['byteLength'] == accessor['count'] * 4):
            component, positions = _index_bytes(memoryview(source).cast('I'))
            if component != 'u32': narrowed += 1
            accessor['component'] = component
            if 'byteStride' in accessor: accessor['byteStride'] = {'u8': 1, 'u16': 2, 'u32': 4}[component]
        accessor['byteOffset'] = append_window(positions)
        accessor['byteLength'] = len(positions)
        if indices is not None:
            indexed += 1; vertices_before += accessor['count']; vertices_after += unique_count
            accessor['count'] = unique_count
            index_id, primitive = candidates[aid]; primitive['indices'] = index_id
            if index_component != 'u32': narrowed += 1
            added_accessors[index_id] = {'bufferId': 'buffer-0', 'byteOffset': append_window(indices),
                'byteLength': len(indices), 'component': index_component, 'components': 1,
                'count': len(order), 'normalized': False}
    document['accessors'].update(added_accessors)
    return bytes(result), {'originalBytes': len(raw), 'compactedBytes': len(result),
        'indexedGeometries': indexed, 'verticesBefore': vertices_before, 'verticesAfter': vertices_after,
        'sharedWindowBytes': shared_bytes, 'narrowedIndexAccessors': narrowed}
