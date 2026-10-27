"""Authored polyline widths are geometry, independent of plotted lineweight."""
import copy
import struct
import base64
import re
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import test_ownership as ownership
from test_fonts_layout_xref import convert, ezdxf, raw_doc
from unified.dxf_adapter import read_dxf
from unified.validation import ValidationError, validate_drawing


def source_entity(result, handle):
    return next(item for item in result['document']['drawing']['entities'].values()
                if any(ref.get('objectKey') == handle for ref in item['sourceRefs']))


def mesh(result, item):
    document = result['document']
    representation = next(row for row in document['representations'].values()
                          if row['sourceRefs'] == item['sourceRefs'])
    geometry = document['geometries'][representation['bindings'][0]['geometryId']]

    def values(accessor_id):
        accessor = document['accessors'][accessor_id]
        raw = base64.b64decode(result['bufferPayloads'][accessor['bufferId']])
        count = accessor['count'] * accessor['components']
        return struct.unpack_from('<' + ('d' if accessor['component'] == 'f64' else 'I') * count,
                                  raw, accessor.get('byteOffset', 0))

    positions = values(geometry['attributes']['POSITION'])
    primitive = geometry['primitives'][0]
    indices = values(primitive['indices'])
    return geometry, [positions[i:i + 3] for i in range(0, len(positions), 3)], indices


class WidePolylinesTest(unittest.TestCase):
    assertTree = ownership.InstanceOwnership.assertTree
    assertBrowser = ownership.InstanceOwnership.assertBrowser

    def test_constant_width_preserves_source_curve_and_fills_the_band(self):
        for width in (0, 2):
            with self.subTest(width=width):
                doc = ezdxf.new('R2013')
                source = doc.modelspace().add_lwpolyline([(0, 0), (10, 0)],
                                                       dxfattribs={'const_width': width, 'lineweight': 211})
                result = convert(doc)
                item = source_entity(result, source.dxf.handle)
                self.assertEqual(item['geometry']['points'], [[0, 0, 0], [10, 0, 0]])
                geometry, points, indices = mesh(result, item)
                self.assertEqual(geometry['bounds'], {'min': [0, -width / 2, 0], 'max': [10, width / 2, 0]})
                self.assertEqual(geometry['primitives'][0]['topology'], 'triangles' if width else 'lines')
                self.assertEqual(result['snapshot']['completeness'], 'complete')
                if width:
                    self.assertEqual(item['geometry']['widths'], [[2, 2]])
                    area = sum(abs((points[b][0] - points[a][0]) * (points[c][1] - points[a][1])
                                   - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0])) / 2
                               for a, b, c in zip(indices[::3], indices[1::3], indices[2::3]))
                    self.assertAlmostEqual(area, 20)

    def test_variable_widths_use_each_segment_and_legacy_defaults(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                doc = ezdxf.new('R2013')
                if legacy:
                    source = doc.modelspace().add_polyline2d([(0, 0), (10, 0)], dxfattribs={
                        'default_start_width': 2, 'default_end_width': 4})
                else:
                    source = doc.modelspace().add_lwpolyline([(0, 0, 2, 4), (10, 0, 0, 0)], format='xyse')
                result = convert(doc); item = source_entity(result, source.dxf.handle)
                self.assertEqual(item['geometry']['widths'], [[2, 4]])
                geometry, points, _ = mesh(result, item)
                self.assertEqual(geometry['bounds'], {'min': [0, -2, 0], 'max': [10, 2, 0]})
                self.assertEqual({tuple(p) for p in points}, {(0, -1, 0), (0, 1, 0), (10, -2, 0), (10, 2, 0)})

    def test_closed_segments_and_constant_width_override_are_preserved(self):
        doc = ezdxf.new('R2013')
        source = doc.modelspace().add_lwpolyline([(0, 0, 1, 3), (10, 0, 2, 4), (5, 10, 3, 5)],
                                               format='xyse', close=True, dxfattribs={'const_width': 2})
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        self.assertEqual(item['geometry']['widths'], [[2, 2]] * 3)
        self.assertEqual(item['geometry']['bulges'], [0, 0, 0])
        self.assertEqual(mesh(result, item)[0]['primitives'][0]['topology'], 'triangles')

    def test_bulge_width_has_the_annular_extent_instead_of_a_centerline(self):
        doc = ezdxf.new('R2013')
        source = doc.modelspace().add_lwpolyline([(-5, 0, 1), (5, 0, 0)], format='xyb',
                                               dxfattribs={'const_width': 2})
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        geometry, _, _ = mesh(result, item)
        self.assertEqual(item['geometry']['bulges'], [1])
        self.assertAlmostEqual(geometry['bounds']['min'][0], -6, delta=.01)
        self.assertAlmostEqual(geometry['bounds']['max'][0], 6, delta=.01)
        self.assertAlmostEqual(geometry['bounds']['min'][1], -6, delta=.01)
        self.assertEqual(result['snapshot']['completeness'], 'complete')

    def test_block_transform_applies_to_the_band_once_and_both_projectors_agree(self):
        doc = ezdxf.new('R2013'); block = doc.blocks.new('Wide')
        source = block.add_lwpolyline([(0, 0), (10, 0)], dxfattribs={'const_width': 2})
        doc.modelspace().add_blockref('Wide', (100, 200), dxfattribs={'rotation': 90, 'xscale': 2, 'yscale': 3})
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        _, points, _ = mesh(result, item)
        draw = next(row for row in result['snapshot']['drawingProjection']['draws'].values() if row['itemId'] == item['id'])
        world = [ownership.apply(draw['localToSpace'], point) for point in points]
        for axis, expected in ((0, (97, 103)), (1, (200, 220))):
            self.assertAlmostEqual(min(p[axis] for p in world), expected[0])
            self.assertAlmostEqual(max(p[axis] for p in world), expected[1])
        self.assertBrowser(result)

    def test_noncontinuous_wide_style_is_generated_after_instance_inheritance(self):
        doc = ezdxf.new('R2013'); doc.linetypes.new('Dash', dxfattribs={'pattern': [1, .6, -.4]})
        block = doc.blocks.new('Wide')
        source = block.add_lwpolyline([(0, 0), (10, 0)], dxfattribs={'const_width': 2, 'linetype': 'BYBLOCK'})
        doc.modelspace().add_blockref('Wide', (0, 0))
        doc.modelspace().add_blockref('Wide', (0, 10), dxfattribs={'linetype': 'Dash'})
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        draws = [row for row in result['snapshot']['drawingProjection']['draws'].values() if row['itemId'] == item['id']]
        self.assertEqual([row['availability'] for row in draws], ['ready', 'ready'])
        self.assertNotEqual(draws[0]['displayRepresentationId'], draws[1]['displayRepresentationId'])
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        from test_linetype_presentations import triangle_hit
        dashed = next(row for row in draws if row['style'].get('lineTypeId') in result['document']['extensions']['org.cad-preview.style-inheritance/1']['lineTypePatterns']
                      and result['document']['extensions']['org.cad-preview.style-inheritance/1']['lineTypePatterns'][row['style']['lineTypeId']])
        self.assertTrue(triangle_hit(result, dashed, (.2, .8)))
        self.assertFalse(triangle_hit(result, dashed, (.5, .8)))
        self.assertBrowser(result)

    def test_width_segment_count_is_validated(self):
        doc = ezdxf.new('R2013'); source = doc.modelspace().add_lwpolyline([(0, 0), (10, 0)])
        result = convert(doc); broken = copy.deepcopy(result['document'])
        item = next(row for row in broken['drawing']['entities'].values() if row['sourceRefs'][0].get('objectKey') == source.dxf.handle)
        item['geometry']['widths'] = [[1, 1], [1, 1]]
        with self.assertRaises(ValidationError): validate_drawing(broken)

    def test_a_viewport_override_selects_its_own_dashed_width_representation(self):
        from unified.dxf_adapter import project_drawing
        doc = ezdxf.new('R2013'); doc.layers.new('Outline')
        doc.linetypes.new('Dash', dxfattribs={'pattern': [1, .6, -.4]})
        source = doc.modelspace().add_lwpolyline([(0, 0), (10, 0)],
                                               dxfattribs={'const_width': 2, 'layer': 'Outline'})
        layout = doc.layouts.get('Layout1')
        vp = layout.add_viewport(center=(50, 50), size=(20, 20), view_center_point=(5, 0), view_height=20)
        override = doc.layers.get('Outline').get_vp_overrides(); override.set_linetype(vp.dxf.handle, 'Dash'); override.commit()
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        model_draw = next(row for row in result['snapshot']['drawingProjection']['draws'].values() if row['itemId'] == item['id'])
        viewport = next(iter(result['document']['drawing']['viewports'].values()))
        projection = project_drawing(result['document'], {'kind': 'layout', 'layoutId': viewport['layoutId']})
        layout_draw = next(row for row in projection['draws'].values() if row['itemId'] == item['id'])
        self.assertEqual(model_draw['availability'], 'ready')
        self.assertEqual(layout_draw['availability'], 'ready')
        self.assertNotEqual(model_draw['displayRepresentationId'], layout_draw['displayRepresentationId'])
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        self.assertBrowser(result)

    def test_zero_width_segments_remain_lines_beside_the_filled_band(self):
        doc = ezdxf.new('R2013')
        source = doc.modelspace().add_lwpolyline([(0, 0, 0, 0), (10, 0, 2, 2), (20, 0, 0, 0)], format='xyse')
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        entry = result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'][item['id']]
        topologies = [result['document']['geometries'][result['document']['representations'][part['representationId']]['bindings'][0]['geometryId']]['primitives'][0]['topology']
                      for part in entry['parts']]
        self.assertEqual(item['geometry']['widths'], [[0, 0], [2, 2]])
        self.assertEqual(topologies, ['triangles', 'lines'])
        self.assertEqual(result['snapshot']['completeness'], 'complete')

    def test_explicit_legacy_zero_width_overrides_the_default(self):
        doc = ezdxf.new('R2013')
        source = doc.modelspace().add_polyline2d([(0, 0), (10, 0), (20, 0)], dxfattribs={
            'default_start_width': 2, 'default_end_width': 2})
        # ezdxf's writer omits optional zero tags. Keep explicit source tags so
        # this exercises an authored zero instead of an absent/default field.
        source.vertices[0].dxf.start_width = .123456789; source.vertices[0].dxf.end_width = .123456789
        raw, count = re.subn(rb'(?m)^( *4[01]\r?\n)0\.123456789\r?$', rb'\g<1>0.0', raw_doc(doc))
        self.assertEqual(count, 2)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'main.dxf'; path.write_bytes(raw); result = read_dxf(path, raw)
        item = source_entity(result, source.dxf.handle)
        self.assertEqual(item['geometry']['widths'], [[0, 0], [2, 2]])

    def test_exhausted_display_budget_keeps_source_facts_without_a_fake_centerline(self):
        doc = ezdxf.new('R2013')
        source = doc.modelspace().add_lwpolyline([(0, 0), (10, 0)], dxfattribs={'const_width': 2})
        doc.modelspace().add_line((0, 10), (10, 10))
        with patch('unified.dxf_annotations.MAX_VERTICES', 3): result = convert(doc)
        item = source_entity(result, source.dxf.handle)
        self.assertEqual(item['geometry']['widths'], [[2, 2]])
        draw = next(row for row in result['snapshot']['drawingProjection']['draws'].values() if row['itemId'] == item['id'])
        self.assertEqual(draw['availability'], 'unsupported')
        self.assertNotIn('displayRepresentationId', draw)
        self.assertEqual(result['snapshot']['completeness'], 'partial')
        self.assertBrowser(result)

    def test_ocs_and_mirror_preserve_local_widths_and_world_elevation(self):
        doc = ezdxf.new('R2013'); block = doc.blocks.new('Wide')
        source = block.add_lwpolyline([(0, 0), (10, 0)], dxfattribs={
            'const_width': 2, 'elevation': 3, 'extrusion': (0, .6, .8)})
        insert = doc.modelspace().add_blockref('Wide', (100, 200), dxfattribs={'xscale': -2, 'yscale': 3})
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        _, points, _ = mesh(result, item)
        draw = next(row for row in result['snapshot']['drawingProjection']['draws'].values() if row['itemId'] == item['id'])
        actual = [ownership.apply(draw['localToSpace'], point) for point in points]
        expected = [insert.matrix44().transform(source.ocs().to_wcs(point)) for point in points]
        self.assertTree(actual, [list(point) for point in expected])
        self.assertEqual(item['geometry']['points'], [[0, 0, 3], [10, 0, 3]])
        self.assertBrowser(result)

    def test_a_wide_custom_leader_arrow_uses_the_same_pattern_generation(self):
        doc = ezdxf.new('R2013'); doc.linetypes.new('Dash', dxfattribs={'pattern': [1, .6, -.4]})
        block = doc.blocks.new('WideArrow')
        block.add_lwpolyline([(0, 0), (1, 0)], dxfattribs={'const_width': .2, 'linetype': 'BYBLOCK'})
        source = doc.modelspace().add_leader([(0, 0), (10, 0)], dxfattribs={'linetype': 'Dash'})
        override = source.override(); override.set_arrows(ldrblk='WideArrow'); override.commit()
        result = convert(doc); item = source_entity(result, source.dxf.handle)
        draw = next(row for row in result['snapshot']['drawingProjection']['draws'].values() if row['itemId'] == item['id'])
        self.assertEqual(draw['availability'], 'ready')
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        self.assertBrowser(result)

    def test_trace_and_solid_keep_the_same_ordered_elevated_polygon(self):
        for kind in ('trace', 'solid'):
            with self.subTest(kind=kind):
                doc = ezdxf.new('R2013')
                source = getattr(doc.modelspace(), 'add_' + kind)([(0, 0, 5), (10, 0, 5), (0, 2, 5), (10, 2, 5)])
                result = convert(doc); item = source_entity(result, source.dxf.handle)
                geometry, _, _ = mesh(result, item)
                self.assertEqual(geometry['bounds'], {'min': [0, 0, 5], 'max': [10, 2, 5]})
                self.assertEqual(geometry['primitives'][0]['topology'], 'triangles')
                self.assertEqual(result['snapshot']['completeness'], 'complete')


if __name__ == '__main__': unittest.main()
