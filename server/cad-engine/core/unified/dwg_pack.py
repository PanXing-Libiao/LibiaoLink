"""Lossless transport packer for native DWG documents.

The packed form keeps every source identity and the canonical document revision.
Standard drawing entities and display tables move into index rows; any row that
does not match the exact fast shape stays in the ordinary document tables, so
unpacking is lossless for both the formal drawing and the public sample.
"""
import json

from .canonical import canonical_sha256

PROFILE = 'ucd-dwg-packed/1'
VERSION = 'dwg-table/1'
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
ENTITY_FIELDS = {'id', 'drawingId', 'ownerSpaceId', 'layerId', 'localFromOwner',
                 'geometry', 'style', 'sourceRefs', 'displayOrder'}
STATE_FIELDS = {'drawOrder', 'invisible', 'lineTypeScale', 'nativeColor'}
REP_FIELDS = {'id', 'kind', 'bindings', 'sourceRefs'}
BINDING_FIELDS = {'id', 'geometryId', 'localFromRepresentation', 'materialSlots'}
GEOMETRY_FIELDS = {'id', 'coordinateSpace', 'attributes', 'primitives', 'bounds',
                   'normalOrigin', 'sourceRefs'}
ACCESSOR_FIELDS = {'bufferId', 'byteOffset', 'byteLength', 'component', 'components',
                   'count', 'normalized'}
EXTENSION = 'org.cad-preview.style-inheritance/1'


class _Strings:
    def __init__(self):
        self.values = []
        self.index = {}

    def __call__(self, value):
        if type(value) is not str:
            raise ValueError('packed string must be a string')
        found = self.index.get(value)
        if found is None:
            found = len(self.values)
            self.index[value] = found
            self.values.append(value)
        return found


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _fast_entity(key, row, drawing, states, modes):
    """Return (row, state_kind, mode_code) or None when the row must stay verbatim."""
    if not isinstance(row, dict) or set(row) != ENTITY_FIELDS:
        return None
    if row['id'] != key or row['localFromOwner'] != IDENTITY:
        return None
    space = drawing['spaces'].get(row['ownerSpaceId'])
    if not isinstance(space, dict) or row['drawingId'] != space.get('drawingId'):
        return None
    refs = row['sourceRefs']
    if not (isinstance(refs, list) and len(refs) == 1 and isinstance(refs[0], dict)
            and set(refs[0]) == {'sourceId', 'objectKey'} and refs[0]['sourceId'] == 'source-0'
            and isinstance(refs[0]['objectKey'], str)):
        return None
    state = states.get(key)
    if state is None:
        state_kind = 0
        state_values = (None, None, None, None, None)
    elif isinstance(state, dict) and set(state) == {'invisible'} and isinstance(state['invisible'], bool):
        state_kind = 1
        state_values = (int(state['invisible']), None, None, None, None)
    elif isinstance(state, dict) and set(state) == STATE_FIELDS and isinstance(state['invisible'], bool) \
            and isinstance(state['nativeColor'], dict) \
            and set(state['nativeColor']) == {'index', 'trueColor'}:
        state_kind = 2
        state_values = (int(state['invisible']), state['lineTypeScale'], state['drawOrder'],
                        state['nativeColor']['index'], state['nativeColor']['trueColor'])
    else:
        state_kind = 3
        state_values = (None, None, None, None, None)
    mode = modes.get(key)
    if mode is None:
        mode_code = 0
    elif isinstance(mode, dict) and set(mode) == {'lineType'} and mode['lineType'] in ('by-layer', 'by-block'):
        mode_code = 1 if mode['lineType'] == 'by-layer' else 2
    else:
        mode_code = 3
    return state_kind, mode_code, state_values


def _fast_display(rep_id, rep, doc):
    if not isinstance(rep, dict) or set(rep) != REP_FIELDS or rep.get('kind') != 'drawing' or rep.get('id') != rep_id:
        return None
    bindings = rep['bindings']
    if not (isinstance(bindings, list) and len(bindings) == 1):
        return None
    binding = bindings[0]
    if not isinstance(binding, dict) or set(binding) != BINDING_FIELDS or binding['id'] != 'b' \
            or binding['localFromRepresentation'] != IDENTITY or binding['materialSlots'] != {}:
        return None
    geometry_id = binding['geometryId']
    if not isinstance(geometry_id, str) or not geometry_id.startswith('g-'):
        return None
    key = geometry_id[2:]
    if rep_id != 'representation-' + canonical_sha256([key]):
        return None
    geometry = doc['geometries'].get(geometry_id)
    if not isinstance(geometry, dict) or set(geometry) != GEOMETRY_FIELDS or geometry.get('id') != geometry_id:
        return None
    if geometry.get('coordinateSpace') != 'geometry-local' or geometry.get('normalOrigin') != 'absent':
        return None
    if not isinstance(geometry.get('attributes'), dict) or set(geometry['attributes']) != {'POSITION'}:
        return None
    accessor_id = geometry['attributes']['POSITION']
    if not isinstance(accessor_id, str) or accessor_id != 'a-' + key:
        return None
    accessor = doc['accessors'].get(accessor_id)
    if not isinstance(accessor, dict) or set(accessor) != ACCESSOR_FIELDS:
        return None
    if (accessor.get('bufferId'), accessor.get('component'), accessor.get('components'),
            accessor.get('normalized')) != ('buffer-0', 'f64', 3, False):
        return None
    count = accessor.get('count')
    if not isinstance(count, int) or count < 0:
        return None
    primitives = geometry.get('primitives')
    if not (isinstance(primitives, list) and len(primitives) == 1):
        return None
    primitive = primitives[0]
    if not isinstance(primitive, dict) or set(primitive) != {'id', 'topology', 'range'} \
            or primitive.get('id') != 'p' or primitive.get('range') != {'first': 0, 'count': count}:
        return None
    if not isinstance(primitive.get('topology'), str):
        return None
    refs = geometry.get('sourceRefs')
    if not (isinstance(refs, list) and len(refs) == 1 and isinstance(refs[0], dict)
            and set(refs[0]) == {'sourceId', 'objectKey'} and refs[0]['sourceId'] == 'source-0'
            and isinstance(refs[0]['objectKey'], str)):
        return None
    rep_refs = rep.get('sourceRefs')
    if rep_refs != refs:
        return None
    bounds = geometry.get('bounds')
    if not (isinstance(bounds, dict) and set(bounds) == {'min', 'max'}
            and isinstance(bounds['min'], list) and isinstance(bounds['max'], list)
            and len(bounds['min']) == 3 and len(bounds['max']) == 3):
        return None
    return {
        'key': key, 'accessor': accessor_id, 'geometry': geometry_id,
        'topology': primitive['topology'], 'bounds': bounds, 'handle': refs[0]['objectKey'],
        'byteOffset': accessor['byteOffset'], 'byteLength': accessor['byteLength'], 'count': count,
    }


def pack_document(document):
    """Return a packed copy of a DWG document; the input is not mutated."""
    drawing = document.get('drawing')
    extensions = document.get('extensions')
    if not isinstance(drawing, dict) or not isinstance(extensions, dict):
        raise ValueError('dwg-pack-document-shape')
    style_ext = extensions.get(EXTENSION)
    if not isinstance(style_ext, dict):
        raise ValueError('dwg-pack-style-extension')
    states = style_ext.get('entityState') or {}
    modes = style_ext.get('modes') or {}
    draw_order = style_ext.get('drawOrder') or {}
    if not (isinstance(states, dict) and isinstance(modes, dict) and isinstance(draw_order, dict)):
        raise ValueError('dwg-pack-style-maps')

    layers = list(drawing['layers'])
    layer_index = {key: index for index, key in enumerate(layers)}
    spaces = list(drawing['spaces'])
    space_index = {key: index for index, key in enumerate(spaces)}
    strings = _Strings()
    styles = []
    style_index = {}

    def intern_style(style):
        text = _canonical(style)
        found = style_index.get(text)
        if found is None:
            found = len(styles)
            style_index[text] = found
            styles.append(style)
        return found

    rows = []
    fast_state = {}
    fast_mode = {}
    fallback_entities = {}
    for key, row in drawing['entities'].items():
        fast = _fast_entity(key, row, drawing, states, modes)
        if fast is None or row['layerId'] not in layer_index or row['ownerSpaceId'] not in space_index:
            fallback_entities[key] = row
            continue
        state_kind, mode_code, state_values = fast
        try:
            row_values = [strings(key), layer_index[row['layerId']], space_index[row['ownerSpaceId']],
                          strings(row['sourceRefs'][0]['objectKey']), intern_style(row['style']),
                          row['displayOrder'], state_kind, *state_values, row['geometry'], mode_code]
        except (TypeError, ValueError):
            fallback_entities[key] = row
            continue
        rows.append(row_values)
        fast_state[key] = state_kind
        fast_mode[key] = mode_code

    accessors = {}
    geometries = {}
    representations = {}
    display_info = {}
    pending = []
    for rep_id, rep in document['representations'].items():
        fast = _fast_display(rep_id, rep, document)
        if fast is None:
            representations[rep_id] = rep
            binding = rep.get('bindings', [{}])[0] if isinstance(rep, dict) else {}
            geometry_id = binding.get('geometryId') if isinstance(binding, dict) else None
            if isinstance(geometry_id, str):
                geometry = document['geometries'].get(geometry_id)
                if isinstance(geometry, dict):
                    geometries[geometry_id] = geometry
                    accessor_id = (geometry.get('attributes') or {}).get('POSITION')
                    if isinstance(accessor_id, str) and accessor_id in document['accessors']:
                        accessors[accessor_id] = document['accessors'][accessor_id]
            pending.append(None)
            continue
        pending.append(fast)
    # A geometry/accessor shared with a fallback representation must stay in the
    # fallback tables; otherwise the unpacked graph would contain two definitions.
    fallback_geometries = set(geometries)
    fallback_accessors = set(accessors)
    display_rows = []
    for index, rep_id in enumerate(document['representations']):
        fast = pending[index]
        if fast is None:
            continue
        if fast['geometry'] in fallback_geometries or fast['accessor'] in fallback_accessors:
            rep = document['representations'][rep_id]
            representations[rep_id] = rep
            geometries[fast['geometry']] = document['geometries'][fast['geometry']]
            accessors[fast['accessor']] = document['accessors'][fast['accessor']]
            fallback_geometries.add(fast['geometry'])
            fallback_accessors.add(fast['accessor'])
            continue
        try:
            display_rows.append([strings(fast['key']), fast['byteOffset'], fast['byteLength'], fast['count'],
                                 strings(fast['topology']), *fast['bounds']['min'], *fast['bounds']['max'],
                                 strings(fast['handle'])])
        except (TypeError, ValueError):
            rep = document['representations'][rep_id]
            representations[rep_id] = rep
            geometries[fast['geometry']] = document['geometries'][fast['geometry']]
            accessors[fast['accessor']] = document['accessors'][fast['accessor']]
            fallback_geometries.add(fast['geometry'])
            fallback_accessors.add(fast['accessor'])
            continue
        display_info[fast['key']] = fast

    state_remainder = {key: value for key, value in states.items()
                       if key not in fast_state or fast_state[key] == 3}
    mode_remainder = {key: value for key, value in modes.items()
                      if key not in fast_mode or fast_mode[key] == 3}
    order_remainder = {key: value for key, value in draw_order.items()
                       if key not in fast_state or fast_state[key] != 2}

    packed_doc = {key: value for key, value in document.items()
                  if key not in ('drawing', 'extensions', 'accessors', 'geometries', 'representations')}
    packed_drawing = dict(drawing)
    packed_drawing['entities'] = fallback_entities
    packed_extensions = dict(extensions)
    packed_extensions[EXTENSION] = {**style_ext, 'modes': mode_remainder,
                                    'entityState': state_remainder, 'drawOrder': order_remainder}
    packed_doc['drawing'] = packed_drawing
    packed_doc['extensions'] = packed_extensions
    packed_doc['accessors'] = accessors
    packed_doc['geometries'] = geometries
    packed_doc['representations'] = representations
    packed_doc['packed'] = {
        'profile': PROFILE, 'version': VERSION,
        'strings': strings.values, 'layers': layers, 'spaces': spaces, 'styles': styles,
        'entities': rows, 'displays': display_rows,
    }
    return packed_doc


def _row_index(strings, value, context):
    if type(value) is not int or not 0 <= value < len(strings):
        raise ValueError('packed-' + context + '-index')
    return strings[value]


def unpack_document(packed_doc):
    """Rebuild the ordinary DWG document from a packed document."""
    if not isinstance(packed_doc, dict) or 'packed' not in packed_doc:
        return packed_doc
    payload = packed_doc['packed']
    if not isinstance(payload, dict) or payload.get('profile') != PROFILE or payload.get('version') != VERSION:
        raise ValueError('packed-profile')
    strings = payload.get('strings')
    layers = payload.get('layers')
    spaces = payload.get('spaces')
    styles = payload.get('styles')
    if not (isinstance(strings, list) and isinstance(layers, list) and isinstance(spaces, list) and isinstance(styles, list)):
        raise ValueError('packed-table')
    if any(type(value) is not str for value in strings) or len(set(strings)) != len(strings):
        raise ValueError('packed-strings')
    if not all(type(value) is str for value in layers) or not all(type(value) is str for value in spaces):
        raise ValueError('packed-groups')
    drawing = dict(packed_doc['drawing'])
    spaces_by_id = drawing.get('spaces')
    if not isinstance(spaces_by_id, dict):
        raise ValueError('packed-spaces')
    extension = (packed_doc.get('extensions') or {}).get(EXTENSION)
    if not isinstance(extension, dict):
        raise ValueError('packed-style-extension')
    states = dict(extension.get('entityState') or {})
    modes = dict(extension.get('modes') or {})
    orders = dict(extension.get('drawOrder') or {})
    entities = dict(drawing.get('entities') or {})
    for row in payload.get('entities') or []:
        if not isinstance(row, list) or len(row) != 14:
            raise ValueError('packed-entity-row')
        key = _row_index(strings, row[0], 'entity-id')
        if key in entities:
            raise ValueError('packed-duplicate-entity')
        layer = layers[row[1]] if type(row[1]) is int and 0 <= row[1] < len(layers) else None
        space = spaces[row[2]] if type(row[2]) is int and 0 <= row[2] < len(spaces) else None
        if not isinstance(layer, str) or not isinstance(space, str):
            raise ValueError('packed-entity-ref')
        space_row = spaces_by_id.get(space)
        if not isinstance(space_row, dict):
            raise ValueError('packed-entity-space')
        handle = _row_index(strings, row[3], 'entity-handle')
        style = styles[row[4]] if type(row[4]) is int and 0 <= row[4] < len(styles) else None
        if not isinstance(style, dict):
            raise ValueError('packed-style')
        state_kind = row[6]
        if state_kind == 1:
            states[key] = {'invisible': bool(row[7])}
        elif state_kind == 2:
            states[key] = {'drawOrder': row[9], 'invisible': bool(row[7]),
                           'lineTypeScale': row[8], 'nativeColor': {'index': row[10], 'trueColor': row[11]}}
            orders[key] = row[9]
        elif state_kind != 0 and state_kind != 3:
            raise ValueError('packed-state-kind')
        mode_code = row[13]
        if mode_code == 1:
            modes[key] = {'lineType': 'by-layer'}
        elif mode_code == 2:
            modes[key] = {'lineType': 'by-block'}
        elif mode_code != 0 and mode_code != 3:
            raise ValueError('packed-mode-code')
        entities[key] = {
            'id': key, 'drawingId': space_row['drawingId'], 'ownerSpaceId': space,
            'layerId': layer, 'localFromOwner': IDENTITY, 'geometry': row[12],
            'style': style, 'sourceRefs': [{'sourceId': 'source-0', 'objectKey': handle}],
            'displayOrder': row[5],
        }
    accessors = dict(packed_doc.get('accessors') or {})
    geometries = dict(packed_doc.get('geometries') or {})
    representations = dict(packed_doc.get('representations') or {})
    for row in payload.get('displays') or []:
        if not isinstance(row, list) or len(row) != 12:
            raise ValueError('packed-display-row')
        key = _row_index(strings, row[0], 'display-key')
        accessor_id = 'a-' + key
        geometry_id = 'g-' + key
        representation_id = 'representation-' + canonical_sha256([key])
        if accessor_id in accessors or geometry_id in geometries or representation_id in representations:
            raise ValueError('packed-duplicate-display')
        count = row[3]
        if type(row[1]) is not int or type(row[2]) is not int or type(count) is not int:
            raise ValueError('packed-display-range')
        topology = _row_index(strings, row[4], 'display-topology')
        handle = _row_index(strings, row[11], 'display-handle')
        refs = [{'sourceId': 'source-0', 'objectKey': handle}]
        accessors[accessor_id] = {'bufferId': 'buffer-0', 'byteOffset': row[1], 'byteLength': row[2],
                                  'component': 'f64', 'components': 3, 'count': count, 'normalized': False}
        geometries[geometry_id] = {'id': geometry_id, 'coordinateSpace': 'geometry-local',
                                   'attributes': {'POSITION': accessor_id},
                                   'primitives': [{'id': 'p', 'topology': topology,
                                                   'range': {'first': 0, 'count': count}}],
                                   'bounds': {'min': row[5:8], 'max': row[8:11]},
                                   'normalOrigin': 'absent', 'sourceRefs': refs}
        representations[representation_id] = {'id': representation_id, 'kind': 'drawing',
                                              'bindings': [{'id': 'b', 'geometryId': geometry_id,
                                                            'localFromRepresentation': IDENTITY,
                                                            'materialSlots': {}}],
                                              'sourceRefs': refs}
    drawing['entities'] = entities
    extensions = dict(packed_doc.get('extensions') or {})
    extensions[EXTENSION] = {**extension, 'modes': modes, 'entityState': states, 'drawOrder': orders}
    document = {key: value for key, value in packed_doc.items() if key != 'packed'}
    document['drawing'] = drawing
    document['extensions'] = extensions
    document['accessors'] = accessors
    document['geometries'] = geometries
    document['representations'] = representations
    return document
