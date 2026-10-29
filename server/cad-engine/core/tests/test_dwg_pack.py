"""Lossless DWG packed transport: fast rows, fallback rows and revision identity."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from unified.canonical import canonical_sha256  # noqa: E402
from unified.dwg_pack import pack_document, unpack_document  # noqa: E402

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
STYLE = {'color': {'mode': 'by-layer'}, 'plot': True}


def entity(key, layer, geometry, state, mode, order):
    return key, {'id': key, 'drawingId': 'drawing-1', 'ownerSpaceId': 'space-1',
                 'layerId': layer, 'localFromOwner': IDENTITY, 'geometry': geometry,
                 'style': STYLE, 'sourceRefs': [{'sourceId': 'source-0', 'objectKey': key}],
                 'displayOrder': order}, state, mode, order


def display(key, indices=None):
    geometry = {'id': 'g-' + key, 'coordinateSpace': 'geometry-local',
                'attributes': {'POSITION': 'a-' + key},
                'primitives': [{'id': 'p', 'topology': 'lines',
                               **({'indices': 'i-' + key} if indices else {}),
                               'range': {'first': 0, 'count': 2}}],
                'bounds': {'min': [0, 0, 0], 'max': [1, 1, 0]}, 'normalOrigin': 'absent',
                'sourceRefs': [{'sourceId': 'source-0', 'objectKey': key}]}
    accessor = {'bufferId': 'buffer-0', 'byteOffset': 0, 'byteLength': 48, 'component': 'f64',
                'components': 3, 'count': 2, 'normalized': False}
    rep_id = 'representation-' + canonical_sha256([key])
    rep = {'id': rep_id, 'kind': 'drawing',
           'bindings': [{'id': 'b', 'geometryId': 'g-' + key,
                         'localFromRepresentation': IDENTITY, 'materialSlots': {}}],
           'sourceRefs': [{'sourceId': 'source-0', 'objectKey': key}]}
    return rep_id, rep, 'g-' + key, geometry, 'a-' + key, accessor


def fixture():
    rows = [entity('entity-1', 'layer-0', {'type': 'unsupported'}, None, {'lineType': 'by-layer'}, 1),
            entity('entity-2', 'layer-1', 'geometry-ref-2',
                   {'drawOrder': 2, 'invisible': False, 'lineTypeScale': 1,
                    'nativeColor': {'index': 256, 'trueColor': -1}, 'presentationGeometry': 'missing'},
                   {'lineType': 'by-layer'}, 2),
            entity('entity-3', 'layer-0', {'type': 'unsupported'}, {'invisible': True}, None, 3)]
    drawing_entities = {}
    states = {}
    modes = {}
    orders = {}
    for key, row, state, mode, order in rows:
        drawing_entities[key] = row
        if state is not None:
            states[key] = state
        if mode is not None:
            modes[key] = mode
        if order is not None:
            orders[key] = order
    fallback = entity('entity-4', 'layer-0', {'type': 'unsupported'}, None, None, 4)[1]
    fallback['extra'] = 'kept verbatim'
    drawing_entities['entity-4'] = fallback
    reps = {}
    geometries = {}
    accessors = {}
    for builder in (display('1'), display('2', indices=True)):
        rep_id, rep, gid, geometry, aid, accessor = builder
        reps[rep_id] = rep
        geometries[gid] = geometry
        accessors[aid] = accessor
    document = {
        'schemaVersion': '2.0.0', 'sources': [{'id': 'source-0'}], 'adapter': {'id': 'test'},
        'buffers': {'buffer-0': {'id': 'buffer-0'}},
        'drawing': {'layers': {'layer-0': {'id': 'layer-0'}, 'layer-1': {'id': 'layer-1'}},
                    'spaces': {'space-1': {'drawingId': 'drawing-1'}},
                    'entities': drawing_entities},
        'extensions': {'org.cad-preview.style-inheritance/1': {
            'entityState': states, 'modes': modes, 'drawOrder': orders}},
        'accessors': accessors, 'geometries': geometries, 'representations': reps,
    }
    document['revision'] = canonical_sha256({k: v for k, v in document.items() if k != 'revision'})
    return document


class PackedDwgTest(unittest.TestCase):
    def test_round_trip_preserves_canonical_revision(self):
        document = fixture()
        packed = pack_document(document)
        payload = packed['packed']
        self.assertEqual(payload['profile'], 'ucd-dwg-packed/1')
        self.assertEqual(set(packed['drawing']['entities']), {'entity-4'})
        self.assertEqual(len(payload['entities']), 3)
        self.assertEqual(len(payload['displays']), 1)
        self.assertIn('entity-2', packed['extensions']['org.cad-preview.style-inheritance/1']['entityState'])
        unpacked = unpack_document(packed)
        self.assertNotIn('packed', unpacked)
        revision = canonical_sha256({k: v for k, v in unpacked.items() if k != 'revision'})
        self.assertEqual(revision, document['revision'])
        self.assertEqual(set(unpacked['drawing']['entities']), set(document['drawing']['entities']))
        self.assertEqual(unpacked['accessors'], document['accessors'])
        self.assertEqual(unpacked['geometries'], document['geometries'])
        self.assertEqual(unpacked['representations'], document['representations'])

    def test_fallback_entity_and_display_stay_verbatim(self):
        document = fixture()
        packed = pack_document(document)
        self.assertIn('entity-4', packed['drawing']['entities'])
        self.assertIn('g-2', packed['geometries'])
        self.assertIn('a-2', packed['accessors'])
        unpacked = unpack_document(packed)
        self.assertEqual(unpacked['drawing']['entities']['entity-4'], document['drawing']['entities']['entity-4'])
        self.assertEqual(unpacked['drawing']['entities']['entity-2'],
                         document['drawing']['entities']['entity-2'])
        self.assertEqual(unpacked['geometries']['g-2'], document['geometries']['g-2'])


if __name__ == '__main__':
    unittest.main()
