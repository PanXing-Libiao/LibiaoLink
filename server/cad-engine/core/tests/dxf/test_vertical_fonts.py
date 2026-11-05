"""Vertical placement uses authored glyphs and source alignment, never rotation alone."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cad_paths import CORE
import unittest

import ezdxf
from unified import dxf_bigfont, dxf_shx
from unified.dxf_annotations import text_geometry, primitives
from unified.dxf_xref import load_references
from test_fonts_layout_xref import PRIMARY_SHP, BIG_SHP, font_bytes, raw_doc, convert


def resources(doc, files):
    state = load_references(doc, raw_doc(doc), 'main.dxf')
    return dxf_shx.Resources(doc, state, files)


class VerticalFontsTest(unittest.TestCase):
    def test_named_legacy_gbcbig_profile_has_eight_unit_cap_without_guessing_other_fonts(self):
        legacy = BIG_SHP.replace(b'Generated CJK', b'gbcbig').replace(b'8,2,2,0', b'0,64,2,0')
        font = dxf_bigfont.load(legacy)
        self.assertEqual((font.above, font.below, font.mode.value), (8, 0, 2))
        self.assertEqual(font.metrics_profile, 'gbcbig-legacy-0-64-2')
        for bad in (legacy.replace(b'gbcbig', b'unknown'), legacy.replace(b'0,64,2,0', b'0,32,2,0')):
            with self.assertRaisesRegex(ValueError, 'legacy-height-profile-unverified'):
                dxf_bigfont.load(bad)
        doc = ezdxf.new('R2013'); doc.encoding = 'gbk'
        doc.styles.new('CJK', dxfattribs={'font': 'primary.shp', 'bigfont': 'renamed.shp'})
        doc.modelspace().add_text('A中A', dxfattribs={'style': 'CJK', 'height': 8})
        result = convert(doc, {'primary.shp': PRIMARY_SHP, 'renamed.shp': legacy})
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        row = next(r for r in result['document']['extensions'][dxf_shx.EXTENSION]['references'] if r['role'] == 'bigfont')
        self.assertEqual(row['metricsProfile'], font.metrics_profile)

    def test_vertical_text_justifies_along_column_and_ignores_group_73(self):
        doc = ezdxf.new('R2013')
        doc.styles.new('V', dxfattribs={'font': 'primary.shp', 'flags': 4})
        fonts = resources(doc, {'primary.shp': PRIMARY_SHP})
        for halign in (0, 1, 2, 4):
            for valign in range(4):
                with self.subTest(halign=halign, valign=valign):
                    text = doc.modelspace().add_text('AAA', dxfattribs={'style': 'V', 'height': 8,
                        'width': 2, 'insert': (100, 200), 'align_point': (10, 20), 'halign': halign, 'valign': valign})
                    points, _, _, info = text_geometry(text, fonts, [{'sourceId': 'source', 'objectKey': text.dxf.handle}])
                    self.assertEqual(info['status'], 'resolved')
                    ys = [p[1] for p in points]
                    expected = 200 if halign == valign == 0 else 20
                    actual = min(ys) if halign == 2 else (min(ys) + max(ys))/2 if halign in (1, 4) else max(ys)
                    self.assertAlmostEqual(actual, expected)

    def test_vertical_aligned_follows_two_points_but_fit_only_changes_width(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp', 'flags': 4})
        fonts = resources(doc, {'primary.shp': PRIMARY_SHP})
        for halign in (3, 5):
            text = doc.modelspace().add_text('AAA', dxfattribs={'style': 'V', 'height': 8,
                'insert': (10, 20), 'align_point': (66, 20), 'halign': halign})
            points, _, _, _ = text_geometry(text, fonts, [{'sourceId': 'source'}])
            self.assertAlmostEqual(min(p[0] for p in points), 10)
            self.assertAlmostEqual(max(p[0] for p in points), 66 if halign == 3 else 38)
            self.assertAlmostEqual(max(p[1] for p in points) - min(p[1] for p in points), 8)

    def test_outline_vertical_style_keeps_horizontal_glyphs_with_column_alignment(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'font.ttf', 'flags': 4})
        text = doc.modelspace().add_text('AA', dxfattribs={'style': 'V', 'height': 7,
            'insert': (0, 0), 'align_point': (10, 20), 'halign': 1})
        fonts = resources(doc, {'font.ttf': font_bytes()})
        points, _, primitive, info = text_geometry(text, fonts, [{'sourceId': 'source'}])
        self.assertEqual(info['status'], 'resolved')
        self.assertEqual(primitive, 'triangles')
        self.assertAlmostEqual((min(p[1] for p in points) + max(p[1] for p in points))/2, 20)
        self.assertGreater(max(p[0] for p in points) - min(p[0] for p in points), 7)

    def test_outline_vertical_right_and_aligned_use_declared_typographic_descender(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'font.ttf', 'flags': 4})
        fonts = resources(doc, {'font.ttf': font_bytes()})
        right = doc.modelspace().add_text('AA', dxfattribs={'style': 'V', 'height': 7, 'halign': 2,
            'insert': (0, 0), 'align_point': (10, 20)})
        points = text_geometry(right, fonts, [{'sourceId': 'source'}])[0]
        # OS/2 descent=200, cap=700, so baseline is 2 above the anchor.
        # The generated p glyph has no descender: measuring its ink gives zero.
        self.assertAlmostEqual(min(p[1] for p in points), 22)
        aligned = doc.modelspace().add_text('AA', dxfattribs={'style': 'V', 'height': 7, 'halign': 3,
            'insert': (0, 0), 'align_point': (20, 0)})
        points = text_geometry(aligned, fonts, [{'sourceId': 'source'}])[0]
        self.assertAlmostEqual(max(p[0] for p in points) - min(p[0] for p in points), 70)

    def test_outline_style_ignores_shx_bigfont_without_requiring_an_unused_resource(self):
        for kind in ('TEXT', 'MTEXT'):
            doc = ezdxf.new('R2013')
            doc.styles.new('V', dxfattribs={'font': 'font.ttf', 'bigfont': 'not-used.shx'})
            if kind == 'TEXT':
                doc.modelspace().add_text('A中', dxfattribs={'style': 'V', 'height': 7})
            else:
                doc.modelspace().add_mtext('A中', dxfattribs={'style': 'V', 'char_height': 7})
            result = convert(doc, {'font.ttf': font_bytes()})
            self.assertEqual(result['snapshot']['completeness'], 'complete')
            fonts = result['document']['extensions'][dxf_shx.EXTENSION]
            self.assertEqual(len(fonts['references']), 1)
            self.assertEqual(fonts['coverage']['status'], 'complete')

    def test_vertical_mtext_uses_font_columns_and_preserves_wcs_and_inline_color(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp'})
        text = doc.modelspace().add_mtext(r'AA\P{\C1;A}', dxfattribs={'style': 'V', 'char_height': 8,
            'insert': (10, 20), 'flow_direction': 3, 'rotation': 90, 'width': 100})
        fonts = resources(doc, {'primary.shp': PRIMARY_SHP})
        leaves = list(primitives(text, doc, fonts, [{'sourceId': 'source'}]))
        self.assertEqual(len(leaves), 3)
        self.assertEqual(leaves[-1][0].dxf.color, 1)
        boxes = []
        for leaf, _ in leaves:
            points, _, _, info = text_geometry(leaf, fonts, [{'sourceId': 'source'}])
            self.assertEqual(info['status'], 'resolved')
            boxes.append((min(p[0] for p in points), max(p[0] for p in points), min(p[1] for p in points)))
        self.assertAlmostEqual(boxes[0][0], 10)
        self.assertAlmostEqual(boxes[1][0] - boxes[0][0], 10)
        self.assertAlmostEqual(boxes[2][2] - boxes[0][2], 8*4/3)

    def test_mtext_explicit_horizontal_overrides_vertical_style_and_by_style_inherits_it(self):
        for flow, vertical in ((1, False), (3, True), (5, True)):
            doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp', 'flags': 4})
            text = doc.modelspace().add_mtext('AA', dxfattribs={'style': 'V', 'char_height': 8, 'flow_direction': flow})
            fonts = resources(doc, {'primary.shp': PRIMARY_SHP})
            self.assertEqual(fonts.binding(text, [{'sourceId': 'source'}])['_vertical'], vertical)
            result = convert(doc, {'primary.shp': PRIMARY_SHP})
            self.assertEqual(result['snapshot']['completeness'], 'complete', result['snapshot']['diagnostics'])

    def test_mtext_orientation_does_not_poison_another_layout_using_the_same_font(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp'})
        vertical = doc.modelspace().add_mtext('AA', dxfattribs={'style': 'V', 'char_height': 8, 'flow_direction': 3})
        horizontal = doc.modelspace().add_mtext('AA', dxfattribs={'style': 'V', 'char_height': 8, 'flow_direction': 1})
        fonts = resources(doc, {'primary.shp': PRIMARY_SHP})
        refs = [{'sourceId': 'source'}]
        leaves = list(primitives(vertical, doc, fonts, refs))
        before = [text_geometry(leaf, fonts, refs)[0] for leaf, _ in leaves]
        list(primitives(horizontal, doc, fonts, refs))
        after = [text_geometry(leaf, fonts, refs)[0] for leaf, _ in leaves]
        self.assertEqual(before, after)

    def test_outline_mtext_flow_keeps_baseline_and_paragraph_gap(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'font.ttf'})
        text = doc.modelspace().add_mtext(r'AA\PA', dxfattribs={'style': 'V', 'char_height': 7,
            'flow_direction': 3, 'insert': (10, 20)})
        fonts = resources(doc, {'font.ttf': font_bytes()})
        leaves = list(primitives(text, doc, fonts, [{'sourceId': 'source'}]))
        self.assertEqual(len(leaves), 3)
        positions = [leaf.dxf.insert for leaf, _ in leaves]
        self.assertTrue(all(p.y == 20 for p in positions))
        self.assertAlmostEqual(positions[1].x - positions[0].x, 6)
        self.assertAlmostEqual(positions[2].x - positions[1].x, 6 + .55*7)
        result = convert(doc, {'font.ttf': font_bytes()})
        self.assertEqual(result['snapshot']['completeness'], 'complete')

    def test_complex_vertical_layout_renders_but_retains_source_cad_comparison_warning(self):
        for content, attributes, feature in ((r'A\SA/A;', {}, 'stack'),
                ('AA', {'attachment_point': 5}, 'attachment-frame'),
                ('AA', {'bg_fill': 1}, 'background-frame')):
            doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp'})
            doc.modelspace().add_line((0, 0), (1, 1))
            doc.modelspace().add_mtext(content, dxfattribs={'style': 'V', 'char_height': 8, 'flow_direction': 3, **attributes})
            result = convert(doc, {'primary.shp': PRIMARY_SHP})
            items = result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items']
            self.assertTrue(all(item['status'] == 'ready' for item in items.values()), items)
            layouts = result['document']['extensions']['org.cad-preview.dxf-mtext/1']['items']
            self.assertTrue(any(feature in row['verticalLayout']['features'] for row in layouts.values()))
            self.assertEqual(result['snapshot']['completeness'], 'partial')


if __name__ == '__main__':
    unittest.main()
