"""Spatial DWG chunk construction and worker validation regressions."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from unified.dwg_chunks import build_dwg_chunks  # noqa: E402
from unified.conversion_jobs import validate_worker_chunks  # noqa: E402

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
STYLE = {'color': {'mode': 'by-layer'}, 'plot': True}


def triangle_area(triangle):
    (ax, ay), (bx, by), (cx, cy) = triangle
    return abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5


def fill_triangle_area(fill):
    return sum(triangle_area(triangle) for triangle in fill.get('triangles') or [])


def empty_document():
    return {
        'schemaVersion': '2.0.0', 'revision': 'source-revision',
        'drawing': {
            'drawings': {'drawing-dwg': {'modelSpaceId': 'space-model'}},
            'spaces': {'space-model': {'id': 'space-model', 'drawingId': 'drawing-dwg',
                                       'kind': 'model', 'entityIds': [],
                                       'blockInstanceIds': [], 'annotationIds': []}},
            'entities': {}, 'blockInstances': {}, 'annotations': {}, 'blocks': {},
            'layers': {'layer-0': {'id': 'layer-0', 'drawingId': 'drawing-dwg', 'name': '0',
                                   'visible': True, 'plot': True, 'defaultStyle': STYLE}},
            'layouts': {}, 'viewports': {},
        },
        'accessors': {}, 'geometries': {}, 'representations': {},
        'extensions': {},
    }


def entity(entity_id, space_id, x):
    return {'id': entity_id, 'drawingId': 'drawing-dwg', 'ownerSpaceId': space_id,
            'layerId': 'layer-0', 'localFromOwner': IDENTITY,
            'geometry': {'type': 'line', 'start': [x, 0, 0], 'end': [x + 10, 10, 0]},
            'style': STYLE, 'sourceRefs': [{'sourceId': 'source-0', 'objectKey': entity_id}],
            'displayOrder': 1}


def instance(instance_id, space_id, definition_id):
    return {'id': instance_id, 'drawingId': 'drawing-dwg', 'ownerSpaceId': space_id,
            'definitionId': definition_id, 'layerId': 'layer-0',
            'localFromBlock': IDENTITY, 'style': STYLE, 'displayOrder': 1}


def polyline(entity_id, space_id, points, layer_id='layer-0'):
    row = entity(entity_id, space_id, 0.0)
    row['layerId'] = layer_id
    row['geometry'] = {'type': 'polyline', 'points': points, 'closed': True}
    return row


def hatch(entity_id, space_id, boundary_ids, layer_id='layer-0'):
    row = entity(entity_id, space_id, 0.0)
    row['layerId'] = layer_id
    row['geometry'] = {'type': 'hatch', 'boundaryEntityIds': boundary_ids,
                       'fillRule': 'even-odd'}
    return row


def cyclic_document():
    document = empty_document()
    drawing = document['drawing']
    drawing['spaces'].update({
        'space-a': {'id': 'space-a', 'drawingId': 'drawing-dwg', 'kind': 'block',
                    'entityIds': ['line-a'], 'blockInstanceIds': ['instance-b'], 'annotationIds': []},
        'space-b': {'id': 'space-b', 'drawingId': 'drawing-dwg', 'kind': 'block',
                    'entityIds': ['line-b'], 'blockInstanceIds': ['instance-a'], 'annotationIds': []},
    })
    drawing['spaces']['space-model']['blockInstanceIds'] = ['instance-root']
    drawing['blocks'] = {
        'block-a': {'id': 'block-a', 'spaceId': 'space-a', 'name': 'A'},
        'block-b': {'id': 'block-b', 'spaceId': 'space-b', 'name': 'B'},
    }
    drawing['entities'] = {
        'line-a': entity('line-a', 'space-a', 10),
        'line-b': entity('line-b', 'space-b', 20),
    }
    drawing['blockInstances'] = {
        'instance-root': instance('instance-root', 'space-model', 'block-a'),
        'instance-a': instance('instance-a', 'space-b', 'block-a'),
        'instance-b': instance('instance-b', 'space-a', 'block-b'),
    }
    drawing['layers']['layer-block-a'] = {'id': 'layer-block-a', 'drawingId': 'drawing-dwg',
                                          'name': 'A', 'visible': True, 'plot': True,
                                          'defaultStyle': STYLE}
    drawing['layers']['layer-block-b'] = {'id': 'layer-block-b', 'drawingId': 'drawing-dwg',
                                          'name': 'B', 'visible': True, 'plot': True,
                                          'defaultStyle': STYLE}
    return document


def layout_document():
    document = empty_document()
    drawing = document['drawing']
    drawing['spaces']['space-paper'] = {
        'id': 'space-paper', 'drawingId': 'drawing-dwg', 'kind': 'paper',
        'entityIds': ['line-paper'], 'blockInstanceIds': [], 'annotationIds': []}
    drawing['layouts'] = {
        'layout-1': {'id': 'layout-1', 'drawingId': 'drawing-dwg', 'name': 'Layout 1',
                     'paperSpaceId': 'space-paper'}}
    drawing['entities']['line-paper'] = entity('line-paper', 'space-paper', 100)
    return document


def represented_document():
    document = empty_document()
    drawing = document['drawing']
    drawing['spaces']['space-model']['entityIds'] = ['line-display', 'line-extension']
    document['accessors'] = {
        'accessor-display': {'bufferId': 'buffer-0', 'byteOffset': 0, 'byteLength': 48,
                           'component': 'f64', 'components': 3, 'count': 2, 'normalized': False},
        'accessor-index': {'bufferId': 'buffer-0', 'byteOffset': 96, 'byteLength': 2,
                         'component': 'u16', 'components': 1, 'count': 1, 'normalized': False},
        'accessor-extension': {'bufferId': 'buffer-0', 'byteOffset': 48, 'byteLength': 48,
                             'component': 'f64', 'components': 3, 'count': 2, 'normalized': False},
    }
    document['geometries'] = {
        'geometry-display': {'id': 'geometry-display', 'coordinateSpace': 'geometry-local',
                            'attributes': {'POSITION': 'accessor-display'},
                            'primitives': [{'id': 'p', 'topology': 'lines',
                                          'indices': 'accessor-index',
                                          'range': {'first': 0, 'count': 2}}],
                            'bounds': {'min': [0.0, 0.0, 0.0], 'max': [10.0, 10.0, 0.0]},
                            'normalOrigin': 'absent', 'sourceRefs': []},
        'geometry-extension': {'id': 'geometry-extension', 'coordinateSpace': 'geometry-local',
                              'attributes': {'POSITION': 'accessor-extension'},
                              'primitives': [{'id': 'p', 'topology': 'lines',
                                            'range': {'first': 0, 'count': 2}}],
                              'bounds': {'min': [20.0, 20.0, 0.0], 'max': [30.0, 30.0, 0.0]},
                              'normalOrigin': 'absent', 'sourceRefs': []},
    }
    document['representations'] = {
        'representation-display': {'id': 'representation-display', 'kind': 'drawing',
                                  'bindings': [{'id': 'b', 'geometryId': 'geometry-display',
                                               'localFromRepresentation': IDENTITY, 'materialSlots': {}}],
                                  'sourceRefs': []},
        'representation-extension': {'id': 'representation-extension', 'kind': 'drawing',
                                    'bindings': [{'id': 'b', 'geometryId': 'geometry-extension',
                                                 'localFromRepresentation': IDENTITY, 'materialSlots': {}}],
                                    'sourceRefs': []},
    }
    for entity_id, representation_id in (('line-display', 'representation-display'),
                                        ('line-extension', None)):
        row = entity(entity_id, 'space-model', 0)
        row['geometry'] = {'type': 'unsupported', 'sourceType': 'test-entity', 'reason': 'test-entity'}
        if representation_id:
            row['displayRepresentationId'] = representation_id
        drawing['entities'][entity_id] = row
    document['extensions']['org.cad-preview.annotation-presentation/1'] = {
        'schemaVersion': '1',
        'items': {'line-extension': {'status': 'ready', 'parts': [{
            'id': 'part-1', 'representationId': 'representation-extension',
            'layerId': 'layer-0', 'style': STYLE, 'ancestors': []}]}}
    }
    return document
class DwgChunkTests(unittest.TestCase):
    def test_empty_drawing_publishes_a_valid_overview_only_tile(self):
        document = empty_document()
        with tempfile.TemporaryDirectory() as directory:
            base, overview, buffer_id, chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory), presentation={'stats': {}})
            self.assertEqual(buffer_id, 'buffer-chunk-overview')
            self.assertEqual(overview, b'')
            self.assertEqual(chunking['resourceCount'], 1)
            self.assertEqual(len(resources), 1)
            self.assertEqual(chunking['tiles'][0]['id'], 'tile-empty')
            self.assertTrue((Path(directory) / resources[0]['file']).is_file())
            self.assertEqual(base['extensions']['org.cad-preview.server-chunks/1']['overview']['entityIds'], [])
            self.assertEqual(
                validate_worker_chunks(Path(directory), base, [dict(item) for item in resources]),
                chunking['tiles'])

    def test_overview_encodes_real_linework_instead_of_bounding_box_outlines(self):
        document = empty_document()
        document['drawing']['spaces']['space-model']['entityIds'] = ['line-model']
        document['drawing']['entities']['line-model'] = entity('line-model', 'space-model', 0)
        with tempfile.TemporaryDirectory() as directory:
            _base, overview, _buffer_id, _chunking, _resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            self.assertEqual(len(overview), 48)
            self.assertEqual(struct.unpack('<6d', overview), (0.0, 0.0, 0.0, 10.0, 10.0, 0.0))

    def test_overview_applies_nested_block_transforms_to_real_linework(self):
        document = empty_document()
        drawing = document['drawing']
        drawing['spaces']['space-model']['blockInstanceIds'] = ['instance-nested']
        drawing['spaces']['space-block'] = {
            'id': 'space-block', 'drawingId': 'drawing-dwg', 'kind': 'block',
            'entityIds': ['line-block'], 'blockInstanceIds': [], 'annotationIds': []}
        drawing['blocks'] = {'block-nested': {'id': 'block-nested', 'spaceId': 'space-block',
                                             'name': 'NESTED'}}
        drawing['entities']['line-block'] = entity('line-block', 'space-block', 0)
        drawing['blockInstances']['instance-nested'] = instance(
            'instance-nested', 'space-model', 'block-nested')
        drawing['blockInstances']['instance-nested']['localFromBlock'] = [
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 0, 1]
        with tempfile.TemporaryDirectory() as directory:
            _base, overview, _buffer_id, _chunking, _resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            self.assertEqual(struct.unpack('<6d', overview), (100.0, 200.0, 0.0, 110.0, 210.0, 0.0))

    def test_overview_geometry_bounds_cover_retained_segments(self):
        document = empty_document()
        document['drawing']['spaces']['space-model']['entityIds'] = ['line-model']
        document['drawing']['entities']['line-model'] = entity('line-model', 'space-model', 0)
        item = {'box': {'minX': 0.0, 'minY': 0.0, 'maxX': 10.0, 'maxY': 5.0},
                'style': STYLE, 'layerId': 'layer-0', 'order': 1,
                'segments': [(0.0, 0.0, 20.0, 12.0)]}
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch('unified.dwg_chunks._overview_cell_items', return_value=[item]):
            base, overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            self.assertEqual(struct.unpack('<6d', overview), (0.0, 0.0, 0.0, 20.0, 12.0, 0.0))
            geometry = next(iter(base['geometries'].values()))
            self.assertEqual(geometry['bounds'], {'min': [0.0, 0.0, 0.0],
                                                  'max': [20.0, 12.0, 0.0]})
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_overview_keeps_every_segment_in_a_dense_cell(self):
        document = empty_document()
        entity_ids = []
        for index in range(500):
            entity_id = 'dense-' + str(index)
            row = entity(entity_id, 'space-model', 0.0)
            row['geometry'] = {'type': 'line', 'start': [0.0, index * 0.02, 0.0],
                               'end': [0.01, index * 0.02 + 0.01, 0.0]}
            document['drawing']['entities'][entity_id] = row
            entity_ids.append(entity_id)
        document['drawing']['spaces']['space-model']['entityIds'] = entity_ids
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch('unified.dwg_chunks.OVERVIEW_SEGMENTS_PER_GROUP', 128):
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            accessors = list(base['accessors'].values())
            self.assertGreater(len(accessors), 1)
            self.assertEqual(sum(item['count'] for item in accessors), 1000)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_overview_keeps_every_block_array_copy(self):
        document = empty_document()
        drawing = document['drawing']
        drawing['spaces']['space-model']['blockInstanceIds'] = ['instance-array']
        drawing['spaces']['space-block'] = {
            'id': 'space-block', 'drawingId': 'drawing-dwg', 'kind': 'block',
            'entityIds': ['line-block'], 'blockInstanceIds': [], 'annotationIds': []}
        drawing['blocks'] = {'block-array': {'id': 'block-array', 'spaceId': 'space-block',
                                            'name': 'ARRAY'}}
        drawing['entities']['line-block'] = entity('line-block', 'space-block', 0)
        instance_row = instance('instance-array', 'space-model', 'block-array')
        instance_row['array'] = {'rows': 32, 'columns': 1,
                                 'rowOffset': [0.0, 1.0, 0.0], 'columnOffset': [0.0, 0.0, 0.0]}
        drawing['blockInstances']['instance-array'] = instance_row
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            self.assertEqual(sum(item['count'] for item in base['accessors'].values()), 64)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_overview_triangulates_independent_overlapping_hatches(self):
        document = empty_document()
        drawing = document['drawing']
        drawing['spaces']['space-model']['entityIds'] = [
            'hatch-a', 'hatch-b', 'boundary-a', 'boundary-b']
        drawing['entities'].update({
            'boundary-a': polyline('boundary-a', 'space-model',
                                   [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0],
                                    [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]]),
            'boundary-b': polyline('boundary-b', 'space-model',
                                   [[5.0, 5.0, 0.0], [15.0, 5.0, 0.0],
                                    [15.0, 15.0, 0.0], [5.0, 15.0, 0.0]]),
            'hatch-a': hatch('hatch-a', 'space-model', ['boundary-a']),
            'hatch-b': hatch('hatch-b', 'space-model', ['boundary-b']),
        })
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            fills = base['extensions']['org.cad-preview.fill/1']['fills']
            self.assertEqual(len(fills), 1)
            fill = next(iter(fills.values()))
            self.assertEqual(fill['fillRule'], 'nonzero')
            self.assertNotIn('rings', fill)
            self.assertEqual(len(fill['triangles']), 4)
            self.assertAlmostEqual(fill_triangle_area(fill), 200.0, places=6)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_overview_triangulation_preserves_hatch_holes(self):
        document = empty_document()
        drawing = document['drawing']
        drawing['spaces']['space-model']['entityIds'] = [
            'hatch-a', 'boundary-outer', 'boundary-inner']
        drawing['entities'].update({
            'boundary-outer': polyline('boundary-outer', 'space-model',
                                       [[0.0, 0.0, 0.0], [20.0, 0.0, 0.0],
                                        [20.0, 20.0, 0.0], [0.0, 20.0, 0.0]]),
            'boundary-inner': polyline('boundary-inner', 'space-model',
                                       [[5.0, 5.0, 0.0], [5.0, 15.0, 0.0],
                                        [15.0, 15.0, 0.0], [15.0, 5.0, 0.0]]),
            'hatch-a': hatch('hatch-a', 'space-model', ['boundary-outer', 'boundary-inner']),
        })
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            fill = next(iter(base['extensions']['org.cad-preview.fill/1']['fills'].values()))
            self.assertEqual(fill['fillRule'], 'nonzero')
            self.assertNotIn('rings', fill)
            self.assertAlmostEqual(fill_triangle_area(fill), 300.0, places=6)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_overview_triangulates_full_long_hatch_boundary(self):
        document = empty_document()
        drawing = document['drawing']
        points = [[float(index), float((index * index) % 101), 0.0] for index in range(1452)]
        drawing['spaces']['space-model']['entityIds'] = ['hatch-long', 'boundary-long']
        drawing['entities'].update({
            'boundary-long': polyline('boundary-long', 'space-model', points),
            'hatch-long': hatch('hatch-long', 'space-model', ['boundary-long']),
        })
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            fill = next(iter(base['extensions']['org.cad-preview.fill/1']['fills'].values()))
            self.assertNotIn('rings', fill)
            self.assertGreater(len(fill['triangles']), 1000)
            vertices = [point for triangle in fill['triangles'] for point in triangle]
            self.assertAlmostEqual(min(point[0] for point in vertices), 0.0)
            self.assertAlmostEqual(max(point[0] for point in vertices), 1451.0)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_detail_chunks_publish_triangle_fills(self):
        document = empty_document()
        drawing = document['drawing']
        drawing['spaces']['space-model']['entityIds'] = ['hatch-a', 'boundary-a']
        drawing['entities'].update({
            'boundary-a': polyline('boundary-a', 'space-model',
                                   [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0],
                                    [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]]),
            'hatch-a': hatch('hatch-a', 'space-model', ['boundary-a']),
        })
        document['extensions']['org.cad-preview.fill/1'] = {'fills': {'hatch-a': {
            'fillRule': 'even-odd',
            'rings': [[[0.0, 0.0, 0.0], [10.0, 0.0, 0.0],
                          [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]]]}}}
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            self.assertTrue(chunking['tiles'])
            row = chunking['tiles'][0]
            resource = next(item for item in resources if item['id'] == row['resourceId'])
            payload = (Path(directory) / resource['file']).read_bytes()
            json_bytes = struct.unpack('<I', payload[4:8])[0]
            chunk = json.loads(payload[12:12 + json_bytes])
            fill = chunk['document']['extensions']['org.cad-preview.fill/1']['fills']['hatch-a']
            self.assertEqual(fill['fillRule'], 'nonzero')
            self.assertNotIn('rings', fill)
            self.assertGreater(len(fill['triangles']), 0)
            self.assertAlmostEqual(fill_triangle_area(fill), 100.0, places=6)
            validate_worker_chunks(Path(directory), base, [dict(item) for item in resources])

    def test_hatch_triangulation_splits_repeated_vertices_into_simple_loops(self):
        document = empty_document()
        drawing = document['drawing']
        points = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0],
                  [0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [30.0, 0.0, 0.0], [30.0, 10.0, 0.0],
                  [20.0, 10.0, 0.0], [20.0, 0.0, 0.0]]
        drawing['spaces']['space-model']['entityIds'] = ['hatch-rings', 'boundary-rings']
        drawing['entities'].update({
            'boundary-rings': polyline('boundary-rings', 'space-model', points),
            'hatch-rings': hatch('hatch-rings', 'space-model', ['boundary-rings']),
        })
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            fill = next(iter(base['extensions']['org.cad-preview.fill/1']['fills'].values()))
            self.assertNotIn('rings', fill)
            self.assertEqual(len(fill['triangles']), 4)
            self.assertAlmostEqual(fill_triangle_area(fill), 200.0, places=6)
            from unified.validation import SCHEMA_V2, shape
            for row in base['drawing']['entities'].values():
                shape(row, SCHEMA_V2['$defs']['Entity'], root_schema=SCHEMA_V2)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_hatch_triangulation_does_not_treat_touching_outside_loop_as_hole(self):
        document = empty_document()
        drawing = document['drawing']
        points = [[0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [20.0, 20.0, 0.0], [0.0, 20.0, 0.0],
                  [0.0, 0.0, 0.0], [10.0, 20.0, 0.0], [10.0, 30.0, 0.0], [15.0, 30.0, 0.0],
                  [15.0, 20.0, 0.0], [10.0, 20.0, 0.0]]
        drawing['spaces']['space-model']['entityIds'] = ['hatch-touch', 'boundary-touch']
        drawing['entities'].update({
            'boundary-touch': polyline('boundary-touch', 'space-model', points),
            'hatch-touch': hatch('hatch-touch', 'space-model', ['boundary-touch']),
        })
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            fill = next(iter(base['extensions']['org.cad-preview.fill/1']['fills'].values()))
            self.assertNotIn('rings', fill)
            self.assertEqual(len(fill['triangles']), 4)
            self.assertAlmostEqual(fill_triangle_area(fill), 450.0, places=6)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_hatch_triangulation_runs_once_before_chunk_copying(self):
        from unified.hatch_triangulation import triangulate

        document = empty_document()
        drawing = document['drawing']
        drawing['spaces']['space-model']['entityIds'] = ['hatch-cache', 'boundary-cache']
        drawing['entities'].update({
            'boundary-cache': polyline('boundary-cache', 'space-model',
                                       [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0],
                                        [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]]),
            'hatch-cache': hatch('hatch-cache', 'space-model', ['boundary-cache']),
        })
        document['extensions']['org.cad-preview.fill/1'] = {'fills': {'hatch-cache': {
            'fillRule': 'even-odd',
            'rings': [[[0.0, 0.0, 0.0], [10.0, 0.0, 0.0],
                       [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]]]}}}
        with tempfile.TemporaryDirectory() as directory,                 mock.patch('unified.dwg_chunks._triangulate_hatch_rings', side_effect=triangulate) as mocked:
            _base, _overview, _buffer_id, _chunking, _resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            self.assertEqual(mocked.call_count, 1)

    def test_overview_annotation_drops_cleared_block_instance_owner(self):
        document = empty_document()
        drawing = document["drawing"]
        drawing["spaces"]["space-model"]["blockInstanceIds"] = ["instance-owner"]
        drawing["spaces"]["space-model"]["annotationIds"] = ["annotation-owned"]
        drawing["spaces"]["space-block"] = {
            "id": "space-block", "drawingId": "drawing-dwg", "kind": "block",
            "entityIds": [], "blockInstanceIds": [], "annotationIds": []}
        drawing["blocks"] = {"block-owner": {"id": "block-owner", "spaceId": "space-block",
                                             "name": "OWNER"}}
        drawing["blockInstances"] = {"instance-owner": instance(
            "instance-owner", "space-model", "block-owner")}
        drawing["annotations"] = {"annotation-owned": {
            "id": "annotation-owned", "drawingId": "drawing-dwg", "ownerSpaceId": "space-model",
            "ownerBlockInstanceId": "instance-owner", "layerId": "layer-0", "kind": "text",
            "position": [10.0, 20.0, 0.0], "text": "A", "sourceRefs": [],
            "associativeEntityIds": [], "presentationEntityIds": [], "annotationScales": [],
            "semantic": {"height": {"value": 2.0}}}}
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b"", Path(directory))
            annotation = base["drawing"]["annotations"]["overview-a-annotation-owned"]
            self.assertEqual(annotation["ownerSpaceId"], "space-model")
            self.assertNotIn("ownerBlockInstanceId", annotation)
            validate_worker_chunks(Path(directory), base, [dict(row) for row in resources])

    def test_cyclic_block_references_are_merged_into_one_dependency_free_pack(self):
        document = cyclic_document()
        with tempfile.TemporaryDirectory() as directory,                 mock.patch('unified.dwg_chunks.PACK_BYTES', 1):
            base, _overview, _buffer_id, chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            blocks = chunking['blocks']
            self.assertEqual(len(blocks), 1)
            self.assertEqual(blocks[0]['counts']['blocks'], 2)
            self.assertEqual(blocks[0]['dependencies'], [])
            tile = chunking['tiles'][0]
            self.assertEqual(tile['dependencies'], [blocks[0]['id']])
            index = {row['id']: row for row in chunking['tiles'] + chunking['layouts'] + blocks}
            states = {}
            def visit(chunk_id):
                self.assertNotEqual(states.get(chunk_id), 1, 'chunk dependency cycle')
                if states.get(chunk_id) == 2:
                    return
                states[chunk_id] = 1
                for dependency in index[chunk_id]['dependencies']:
                    visit(dependency)
                states[chunk_id] = 2
            for chunk_id in index:
                visit(chunk_id)
            validate_worker_chunks(Path(directory), base, [dict(item) for item in resources])

    def test_layout_space_items_get_their_own_chunk(self):
        document = layout_document()
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            self.assertEqual(len(chunking['layouts']), 1)
            layout = chunking['layouts'][0]
            self.assertEqual(layout['spaceId'], 'space-paper')
            self.assertEqual(layout['counts']['entities'], 1)
            self.assertTrue(layout['removeOverview'])
            self.assertIn(layout['removeOverview'][0],
                          base['extensions']['org.cad-preview.server-chunks/1']['overview']['entityIds'])
            overview = base['extensions']['org.cad-preview.server-chunks/1']['overview']
            self.assertEqual(set(overview['representations']), set(overview['entityIds']))
            for entity_id, representation_id in overview['representations'].items():
                self.assertNotIn('displayRepresentationId', base['drawing']['entities'][entity_id])
                self.assertEqual(base['drawing']['entities'][entity_id]['geometry']['sourceType'], 'chunk-overview')
                self.assertEqual(base['representations'][representation_id]['kind'], 'drawing')
            validate_worker_chunks(Path(directory), base, [dict(item) for item in resources])

    def test_representation_payloads_are_copied_and_extension_items_are_chunked(self):
        document = represented_document()
        positions = struct.pack('<12d', 0.0, 0.0, 0.0, 10.0, 10.0, 0.0,
                                20.0, 20.0, 0.0, 30.0, 30.0, 0.0) + struct.pack('<H', 0)
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, chunking, resources, _ = build_dwg_chunks(
                document, positions, Path(directory))
            presentation = base['extensions']['org.cad-preview.annotation-presentation/1']
            self.assertEqual(presentation['items'], {})
            entries = {item['id']: item for item in resources}
            copied = 0
            for row in chunking['tiles']:
                entry = entries[row['resourceId']]
                raw = (Path(directory) / entry['file']).read_bytes()
                document_bytes, position_bytes = struct.unpack('<II', raw[4:12])
                chunk_document = json.loads(raw[12:12 + document_bytes])['document']
                payload = raw[12 + document_bytes:]
                self.assertEqual(len(payload), position_bytes)
                for accessor in chunk_document['accessors'].values():
                    self.assertLessEqual(accessor.get('byteOffset', 0) + accessor['byteLength'], len(payload))
                entities = chunk_document['drawing']['entities']
                geometry_ids = []
                for representation in chunk_document['representations'].values():
                    geometry_ids.extend(binding['geometryId'] for binding in representation.get('bindings') or [])
                self.assertEqual(len(geometry_ids), len(set(geometry_ids)))
                self.assertEqual(set(geometry_ids), set(chunk_document['geometries']))
                if 'line-display' in entities:
                    self.assertIn(entities['line-display']['displayRepresentationId'], chunk_document['representations'])
                    copied += 1
                item = (chunk_document['extensions'].get('org.cad-preview.annotation-presentation/1') or {}).get('items', {}).get('line-extension')
                if item:
                    self.assertIn(item['parts'][0]['representationId'], chunk_document['representations'])
                    copied += 1
            self.assertEqual(copied, 2)
            validate_worker_chunks(Path(directory), base, [dict(item) for item in resources])
    def test_worker_validation_rejects_incomplete_overview_representation_map(self):
        document = layout_document()
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            overview = base['extensions']['org.cad-preview.server-chunks/1']['overview']
            entity_id = overview['entityIds'][0]
            overview['representations'].pop(entity_id)
            with self.assertRaisesRegex(ValueError, 'overview representation index'):
                validate_worker_chunks(Path(directory), base, [dict(item) for item in resources])
            overview['representations'][entity_id] = 'overview-r-missing'
            with self.assertRaisesRegex(ValueError, 'overview representation is missing'):
                validate_worker_chunks(Path(directory), base, [dict(item) for item in resources])

    def test_worker_validation_rejects_tampered_chunk_metadata(self):
        document = empty_document()
        with tempfile.TemporaryDirectory() as directory:
            base, _overview, _buffer_id, _chunking, resources, _ = build_dwg_chunks(
                document, b'', Path(directory))
            entries = [dict(item) for item in resources]
            entries[0]['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'metadata mismatch'):
                validate_worker_chunks(Path(directory), base, entries)


if __name__ == '__main__':
    unittest.main()
