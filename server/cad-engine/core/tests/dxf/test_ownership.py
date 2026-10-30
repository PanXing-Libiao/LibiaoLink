"""Source-space placement and instance ownership, checked against ezdxf's INSERTs."""
import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_fonts_layout_xref import CORE, PRIMARY_SHP, convert, ezdxf, raw_doc
from unified.dxf_adapter import project_drawing, read_dxf
from unified.validation import ValidationError, validate_drawing, validate_drawing_projection


def apply(matrix, point):
    return [sum(matrix[c*4+r]*point[c] for c in range(3))+matrix[12+r] for r in range(3)]


def draws(result, kind):
    return [d for d in result['snapshot']['drawingProjection']['draws'].values() if d['kind'] == kind]


def labeled_array(**attributes):
    doc = ezdxf.new('R2013')
    doc.styles.get('Standard').dxf.font = 'primary.shp'
    doc.layers.new('Assembly', dxfattribs={'color': 3})
    block = doc.blocks.new('Part', base_point=(2, 3))
    block.add_line((3, 3), (4, 3), dxfattribs={'color': 0})
    insert = doc.modelspace().add_blockref('Part', (10, 20), dxfattribs={
        'color': 1, 'layer': 'Assembly', 'row_count': 2, 'column_count': 2,
        'row_spacing': 20, 'column_spacing': 10, **attributes})
    insert.add_attrib('A', 'A', (10, 20), dxfattribs={'color': 0})
    return doc, insert


class SourceNumbers(unittest.TestCase):
    def test_nonfinite_source_numbers_are_rejected_before_mapping(self):
        for value in (float('nan'), float('inf'), -float('inf')):
            for binary in (False, True):
                with self.subTest(value=value, binary=binary):
                    doc = ezdxf.new('R2013')
                    doc.modelspace().add_line((value, 2), (3, 4))
                    stream = io.BytesIO() if binary else io.StringIO()
                    doc.write(stream, fmt='bin' if binary else 'asc')
                    raw = stream.getvalue() if binary else stream.getvalue().encode(doc.output_encoding)
                    with tempfile.TemporaryDirectory() as folder:
                        path = Path(folder)/'source.dxf'; path.write_bytes(raw)
                        with self.assertRaisesRegex(ValueError, 'dxf-nonfinite-number'):
                            read_dxf(path, raw)

    def test_scalar_metadata_and_recovered_coordinates_use_the_same_boundary(self):
        for edit in (lambda doc: setattr(doc.modelspace().add_circle((0, 0), 2).dxf, 'radius', float('nan')),
                     lambda doc: doc.header.__setitem__('$LTSCALE', float('inf'))):
            doc = ezdxf.new('R2013'); edit(doc)
            with self.assertRaisesRegex(ValueError, 'dxf-nonfinite-number'):
                convert(doc)
        fragment = b'0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA\n100\nAcDbEntity\n8\n0\n100\nAcDbLine\n10\nnan\n20\n2\n11\n3\n21\n4\n0\nENDSEC\n0\nEOF\n'
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'fragment.dxf'; path.write_bytes(fragment)
            with self.assertRaisesRegex(ValueError, 'dxf-nonfinite-number'):
                read_dxf(path, fragment)

    def test_invalid_companion_is_reported_and_text_nan_is_not_a_number(self):
        from ezdxf import xref
        doc = ezdxf.new('R2013')
        doc.modelspace().add_text('NaN', dxfattribs={'insert': (3, 4)})
        doc.modelspace().add_line((1, 2), (3, 4))
        ordinary = convert(doc)
        self.assertEqual(draws(ordinary, 'entity')[0]['availability'], 'ready')
        child = ezdxf.new('R2013'); child.modelspace().add_line((float('inf'), 0), (1, 1))
        xref.attach(doc, block_name='Broken', filename='broken.dxf', insert=(0, 0))
        result = convert(doc, {'broken.dxf': raw_doc(child)})
        reference = result['document']['extensions']['org.cad-preview.dxf-xref/1']['references'][0]
        self.assertNotEqual(reference['status'], 'resolved')
        self.assertIn('dxf-nonfinite-number', reference['reason'])
        self.assertEqual(result['snapshot']['completeness'], 'partial')


class InstanceOwnership(unittest.TestCase):
    def assertPoint(self, actual, expected):
        for a, b in zip(actual, expected): self.assertAlmostEqual(a, b, places=8)

    def assertBrowser(self, result):
        module = (CORE.parents[2]/'frontend/public/cad-viewer/core/drawing-projection.js').resolve().as_uri()
        target = result['snapshot']['drawingProjection']['target']
        targets = [target]+[{'kind': 'layout', 'layoutId': key} for key in result['document']['drawing']['layouts']]
        script = 'import {projectDrawing} from '+json.dumps(module)+";let raw='';for await(const c of process.stdin)raw+=c;const {document,targets}=JSON.parse(raw);process.stdout.write(JSON.stringify(targets.map(t=>{const layers={},styles={};return {projection:projectDrawing(document,t,layers,styles),layers,styles};})));"
        proc = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps({'document': result['document'], 'targets': targets}), text=True, capture_output=True, check=True)
        for target, actual in zip(targets, json.loads(proc.stdout)):
            layers, styles = {}, {}
            projection = project_drawing(result['document'], target, layers, styles)
            validate_drawing_projection(result['document'], projection)
            self.assertTree(actual, {'projection': projection, 'layers': layers, 'styles': styles})

    def assertTree(self, actual, expected):
        if isinstance(expected, dict):
            self.assertEqual(set(actual), set(expected))
            for key in expected: self.assertTree(actual[key], expected[key])
        elif isinstance(expected, list):
            self.assertEqual(len(actual), len(expected))
            for a, b in zip(actual, expected): self.assertTree(a, b)
        elif isinstance(expected, (float, int)) and not isinstance(expected, bool):
            self.assertAlmostEqual(actual, expected, places=8)
        else: self.assertEqual(actual, expected)

    def test_array_and_attached_text_follow_source_placements(self):
        for attributes in ({'rotation': 90, 'xscale': 2, 'yscale': 3},
                           {'rotation': 37, 'xscale': -2, 'yscale': .5, 'extrusion': (0, .6, .8)},
                           {'row_spacing': 0, 'column_spacing': 0}):
            with self.subTest(attributes=attributes):
                doc, insert = labeled_array(**attributes)
                expected = list(insert.multi_insert())
                result = convert(doc, {'primary.shp': PRIMARY_SHP})
                geometry, text = draws(result, 'entity'), draws(result, 'annotation')
                self.assertEqual(len(geometry), len(expected))
                self.assertEqual(len(text), len(expected))
                model = result['document']['drawing']
                for g, a, source in zip(geometry, text, expected):
                    self.assertPoint(apply(g['localToSpace'], (3, 3, 0)), source.matrix44().transform((3, 3, 0)))
                    annotation = model['annotations'][a['itemId']]
                    # An attached text can have a different OCS from its INSERT.
                    # Every array copy receives the same owner-space translation.
                    delta = source.ocs().to_wcs(source.dxf.insert)-insert.ocs().to_wcs(insert.dxf.insert)
                    anchor = insert.attribs[0].ocs().to_wcs(insert.attribs[0].dxf.insert)
                    self.assertPoint(apply(a['localToSpace'], annotation['position']), anchor+delta)
                    self.assertEqual(a['blockPath'], g['blockPath'])
                    self.assertEqual(annotation['ownerBlockInstanceId'], a['blockPath'][-1]['instanceId'])
                    self.assertEqual(a['style']['color'], [1, 0, 0, 1])
                self.assertBrowser(result)

    def test_parent_visibility_and_layer_are_inherited_without_coordinate_rewrite(self):
        doc, insert = labeled_array(rotation=90, invisible=1)
        result = convert(doc, {'primary.shp': PRIMARY_SHP})
        self.assertEqual({a['visibility'] for a in draws(result, 'annotation')}, {'hidden'})
        annotation = next(iter(result['document']['drawing']['annotations'].values()))
        self.assertEqual(annotation['position'], [10, 20, 0])
        flags = result['document']['extensions']['org.cad-preview.style-inheritance/1']['entityState']
        self.assertTrue(all('clipOwnerId' not in row and 'inheritedLayerId' not in row for row in flags.values()))
        effective = result['document']['extensions']['org.cad-preview.drawing-layers/1']['byDraw']
        layer = next(k for k, row in result['document']['drawing']['layers'].items() if row['name'] == 'Assembly')
        self.assertEqual(set(effective.values()), {layer})
        self.assertBrowser(result)

    def test_explicit_attribute_layer_still_depends_on_the_parent_layer(self):
        doc, insert = labeled_array()
        doc.layers.new('Labels', dxfattribs={'color': 5})
        insert.attribs[0].dxf.layer = 'Labels'
        result = convert(doc, {'primary.shp': PRIMARY_SHP})
        names = {key: row['name'] for key, row in result['document']['drawing']['layers'].items()}
        for annotation in draws(result, 'annotation'):
            self.assertEqual({names[key] for key in annotation['visibilityLayerIds']}, {'Labels', 'Assembly'})
            self.assertEqual(annotation['style']['color'], [1, 0, 0, 1])
        self.assertBrowser(result)

    def test_nested_attributes_use_owner_space_then_outer_placement_and_viewport(self):
        from ezdxf.xclip import XClip
        doc, inner = labeled_array(rotation=90, xscale=-2, yscale=.5)
        outer_definition = doc.blocks.new('Assembly')
        doc.modelspace().unlink_entity(inner); outer_definition.add_entity(inner)
        outer = doc.modelspace().add_blockref('Assembly', (100, 200), dxfattribs={'rotation': 30, 'xscale': 2, 'yscale': 3})
        XClip(inner).set_block_clipping_path([(-10, -10), (30, 30)])
        layout = doc.layouts.new('Sheet')
        layout.add_viewport(center=(20, 30), size=(40, 40), view_center_point=(100, 200), view_height=80)
        result = convert(doc, {'primary.shp': PRIMARY_SHP})
        model = result['document']['drawing']
        for draw, source in zip(draws(result, 'annotation'), inner.multi_insert()):
            annotation = model['annotations'][draw['itemId']]
            self.assertEqual(len(draw['blockPath']), 2)
            self.assertPoint(apply(draw['localToSpace'], annotation['position']), outer.matrix44().transform(source.attribs[0].dxf.insert))
            sibling = next(g for g in draws(result, 'entity') if g['blockPath'] == draw['blockPath'])
            self.assertEqual(draw['clipRegions'], sibling['clipRegions'])
        self.assertBrowser(result)

    def test_contract_rejects_wrong_attribute_owner_and_projection_path(self):
        doc, _ = labeled_array()
        result = convert(doc, {'primary.shp': PRIMARY_SHP})
        broken = copy.deepcopy(result['document'])
        annotation = next(iter(broken['drawing']['annotations'].values()))
        annotation['ownerBlockInstanceId'] = 'absent'
        with self.assertRaises(ValidationError): validate_drawing(broken)
        projection = copy.deepcopy(result['snapshot']['drawingProjection'])
        attr = next(d for d in projection['draws'].values() if d['kind'] == 'annotation')
        attr['blockPath'] = []
        with self.assertRaises(ValidationError): validate_drawing_projection(result['document'], projection)

    def test_disabled_viewports_do_not_make_model_members_reachable(self):
        doc = ezdxf.new('R2013'); doc.modelspace().add_line((0, 0), (10, 10))
        sheet = doc.layouts.new('Disabled')
        paper = sheet.add_line((0, 0), (1, 1))
        viewport = sheet.add_viewport(center=(5, 5), size=(10, 10), view_center_point=(0, 0), view_height=10)
        viewport.dxf.status = 0
        result = convert(doc)
        layout_id = next(k for k, row in result['document']['drawing']['layouts'].items() if row['name'] == 'Disabled')
        projection = project_drawing(result['document'], {'kind': 'layout', 'layoutId': layout_id})
        validate_drawing_projection(result['document'], projection)
        model = result['document']['drawing']
        self.assertEqual([model['entities'][draw['itemId']]['sourceRefs'][0]['objectKey'] for draw in projection['draws'].values()], [paper.dxf.handle])
        self.assertBrowser(result)


if __name__ == '__main__': unittest.main()
