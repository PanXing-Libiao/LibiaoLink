"""Complex vertical layout keeps source glyphs, frames and uncertainty visible."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cad_paths import CORE
import unittest

import ezdxf
from ezdxf.entities.mtext import MTextColumns
from unified.dxf_annotations import primitives, text_geometry
from unified import dxf_mtext
from test_fonts_layout_xref import PRIMARY_SHP, BIG_SHP, font_bytes, convert
from test_vertical_fonts import resources


def presentation(doc, text, files):
    fonts = resources(doc, files)
    leaves = [leaf for leaf, _ in primitives(text, doc, fonts, [{'sourceId': 'source'}])]
    return fonts, leaves


class VerticalLayoutTest(unittest.TestCase):
    def test_all_attachments_translate_the_same_text_frame_without_rotating_glyphs(self):
        boxes = []
        for attachment in range(1, 10):
            doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp'})
            text = doc.modelspace().add_mtext(r'AA\PA', dxfattribs={'style': 'V', 'char_height': 8,
                'flow_direction': 3, 'attachment_point': attachment, 'insert': (10, 20)})
            fonts, leaves = presentation(doc, text, {'primary.shp': PRIMARY_SHP})
            points = [p for leaf in leaves for p in text_geometry(leaf, fonts, [{'sourceId': 'source'}])[0]]
            box = (min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points))
            boxes.append(box)
            self.assertEqual(len(leaves), 3)
            self.assertTrue(all(abs(leaf.dxf.rotation) < 1e-8 for leaf in leaves))
            self.assertEqual(text.dxf.insert, (10, 20, 0))
            self.assertIn(r'AA\PA', text.text)
            self.assertEqual(text.dxf.attachment_point, attachment)
        # Attachment is a frame translation: it cannot resize/reflow the body.
        self.assertTrue(all(abs((b[2]-b[0])-(boxes[0][2]-boxes[0][0])) < 1e-8 for b in boxes))
        self.assertTrue(all(abs((b[3]-b[1])-(boxes[0][3]-boxes[0][1])) < 1e-8 for b in boxes))
        self.assertLess(boxes[2][0], boxes[1][0]); self.assertLess(boxes[1][0], boxes[0][0])
        self.assertGreater(boxes[6][1], boxes[3][1]); self.assertGreater(boxes[3][1], boxes[0][1])

    def test_tabs_align_a_whole_vertical_field_and_preserve_tracking(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp'})
        text = doc.modelspace().add_mtext(r'\pxtr8;A^IAA AA', dxfattribs={
            'style': 'V', 'char_height': 8, 'flow_direction': 3})
        fonts, leaves = presentation(doc, text, {'primary.shp': PRIMARY_SHP})
        positions = [leaf.dxf.insert for leaf in leaves if leaf.dxftype() == 'TEXT']
        self.assertEqual(len(positions), 5)
        # Stop=64, field has four glyph advances of 10 and one 8-unit space.
        self.assertAlmostEqual(positions[1].y, -16)
        self.assertAlmostEqual(positions[-1].y, -54)
        self.assertTrue(all(abs(p.x-positions[0].x) < 1e-8 for p in positions))

    def test_separate_primary_and_bigfont_words_share_the_authored_pen_axis(self):
        doc = ezdxf.new('R2013'); doc.encoding = 'gbk'
        doc.styles.new('V', dxfattribs={'font': 'primary.shp', 'bigfont': 'big.shp'})
        text = doc.modelspace().add_mtext(r'A 中 {\C1;A}', dxfattribs={
            'style': 'V', 'char_height': 8, 'flow_direction': 3})
        fonts, leaves = presentation(doc, text, {'primary.shp': PRIMARY_SHP, 'big.shp': BIG_SHP})
        positions = [leaf.dxf.insert for leaf in leaves]
        self.assertEqual([p.y for p in positions], [0, -18, -36])
        self.assertEqual([p.x for p in positions], [4, 4, 4])
        boxes = [text_geometry(leaf, fonts, [{'sourceId': 'source'}])[0] for leaf in leaves]
        self.assertAlmostEqual(min(p[0] for p in boxes[0]), 2)
        self.assertAlmostEqual(min(p[0] for p in boxes[1]), 0)

    def test_a_later_paragraph_cannot_change_the_first_column_pen_offset(self):
        doc = ezdxf.new('R2013'); doc.encoding = 'gbk'
        doc.styles.new('V', dxfattribs={'font': 'primary.shp', 'bigfont': 'big.shp'})
        text = doc.modelspace().add_mtext(r'A\P中', dxfattribs={
            'style': 'V', 'char_height': 8, 'flow_direction': 3})
        fonts, leaves = presentation(doc, text, {'primary.shp': PRIMARY_SHP, 'big.shp': BIG_SHP})
        self.assertAlmostEqual(leaves[0].dxf.insert.x, 2)
        self.assertAlmostEqual(leaves[1].dxf.insert.x, 2+8*4/3)

    def test_stacks_decorations_background_and_wcs_emit_real_derived_geometry(self):
        for separator in ('/', '^ ', '#'):
            doc = ezdxf.new('R2013'); doc.encoding = 'gbk'
            doc.styles.new('V', dxfattribs={'font': 'primary.shp', 'bigfont': 'big.shp'})
            text = doc.modelspace().add_mtext(r'{\L\O\K\C1;A 中}\P\S中'+separator+'A;', dxfattribs={
                'style': 'V', 'char_height': 8, 'flow_direction': 3, 'rotation': 90,
                'insert': (10, 20), 'bg_fill': 17, 'bg_fill_color': 3, 'box_fill_scale': 1.25})
            files = {'primary.shp': PRIMARY_SHP, 'big.shp': BIG_SHP}
            fonts, leaves = presentation(doc, text, files)
            kinds = [leaf.dxftype() for leaf in leaves]
            self.assertEqual(kinds.count('TEXT'), 4)
            self.assertEqual(kinds.count('SOLID'), 1)
            self.assertEqual(kinds.count('LWPOLYLINE'), 1)
            self.assertGreaterEqual(kinds.count('LINE'), 3)
            self.assertEqual([leaf.dxf.color for leaf in leaves if leaf.dxftype() == 'TEXT'], [1, 1, 256, 256])
            result = convert(doc, files)
            self.assertEqual(result['snapshot']['completeness'], 'partial')
            coverage = result['document']['extensions']['org.cad-preview.drawing-coverage/1']
            self.assertEqual(coverage['displayGeometry']['withoutDisplayGeometry'], 0)
            layout = result['document']['extensions'][dxf_mtext.EXTENSION]
            self.assertEqual(layout['coverage']['missingObjects'], 0)
            self.assertGreater(layout['coverage']['approximateLayouts'], 0)
            self.assertTrue(any(d['code'] == 'dxf-mtext-partial' for d in result['snapshot']['diagnostics']))

    def test_outline_flow_keeps_one_baseline_with_tabs_fractions_and_background(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'font.ttf'})
        text = doc.modelspace().add_mtext(r'\LAA\l^I\S A/A;\P{\C1;A}', dxfattribs={
            'style': 'V', 'char_height': 7, 'flow_direction': 3, 'bg_fill': 1, 'bg_fill_color': 4})
        fonts, leaves = presentation(doc, text, {'font.ttf': font_bytes()})
        self.assertEqual(sum(len(leaf.dxf.text.strip()) for leaf in leaves if leaf.dxftype() == 'TEXT'), 5)
        self.assertEqual(sum(leaf.dxftype() == 'SOLID' for leaf in leaves), 1)
        texts = [leaf for leaf in leaves if leaf.dxftype() == 'TEXT']
        first, last = texts[0], texts[-1]
        self.assertAlmostEqual(first.dxf.insert.y, last.dxf.insert.y)
        self.assertGreater(last.dxf.insert.x, first.dxf.insert.x)

    def test_unbounded_outline_paragraph_gaps_never_force_a_new_baseline(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'font.ttf'})
        text = doc.modelspace().add_mtext(r'A A\PA A\PA A\PA A\PA A\PA A', dxfattribs={
            'style': 'V', 'char_height': 7, 'flow_direction': 3})
        fonts, leaves = presentation(doc, text, {'font.ttf': font_bytes()})
        self.assertEqual(len(leaves), 12)
        self.assertTrue(all(abs(leaf.dxf.insert.y) < 1e-8 for leaf in leaves))

    def test_inline_outline_fonts_keep_upright_outlines_inside_a_shx_column(self):
        for otf in (False, True):
            doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp'})
            text = doc.modelspace().add_mtext(r'A{\fUploadedTest;\H1.5x;\C1;中}A', dxfattribs={
                'style': 'V', 'char_height': 8, 'flow_direction': 3})
            files = {'primary.shp': PRIMARY_SHP, 'font.otf' if otf else 'font.ttf': font_bytes(otf=otf)}
            fonts, leaves = presentation(doc, text, files)
            self.assertEqual([text_geometry(leaf, fonts, [{'sourceId': 'source'}])[2] for leaf in leaves],
                             ['lines', 'triangles', 'lines'])
            self.assertEqual(leaves[1].dxf.color, 1)
            self.assertEqual(leaves[1].dxf.height, 12)
            result = convert(doc, files)
            self.assertEqual(result['snapshot']['completeness'], 'partial')
            rows = result['document']['extensions'][dxf_mtext.EXTENSION]['items'].values()
            self.assertTrue(any('mixed-font-orientation' in row['verticalLayout']['features'] for row in rows))

    def test_outline_base_with_inline_shx_preserves_both_original_glyph_kinds(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'font.ttf'})
        doc.modelspace().add_line((0, 0), (1, 1))
        doc.modelspace().add_mtext(r'A{\Fprimary.shp;A}', dxfattribs={
            'style': 'V', 'char_height': 8, 'flow_direction': 3})
        result = convert(doc, {'font.ttf': font_bytes(), 'primary.shp': PRIMARY_SHP})
        rows = list(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values())
        self.assertTrue(all(row['status']=='ready' for row in rows))
        self.assertEqual(result['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']['withoutDisplayGeometry'],0)
        layouts=result['document']['extensions'][dxf_mtext.EXTENSION]['items'].values()
        self.assertTrue(any('mixed-font-orientation' in row['verticalLayout']['features'] for row in layouts))
        self.assertEqual(result['snapshot']['completeness'], 'partial')

    def test_column_break_frames_progress_down_and_reverse_progresses_up(self):
        for kind, files in (('primary.shp', {'primary.shp': PRIMARY_SHP}), ('font.ttf', {'font.ttf': font_bytes()})):
            for reverse in (False, True):
                with self.subTest(kind=kind, reverse=reverse):
                    doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': kind})
                    text = doc.modelspace().add_mtext(r'AA\NA', dxfattribs={
                        'style': 'V', 'char_height': 8, 'flow_direction': 3})
                    columns = MTextColumns.new_static_columns(count=2, width=30, gutter_width=5, height=24)
                    columns.reversed_column_flow = reverse
                    text.setup_columns(columns, linked=False)
                    fonts, leaves = presentation(doc, text, files)
                    positions = [leaf.dxf.insert for leaf in leaves if leaf.dxftype() == 'TEXT']
                    self.assertEqual(len(positions), 3)
                    self.assertAlmostEqual(positions[2].y-positions[0].y, 35 if reverse else -35)
                    self.assertAlmostEqual(positions[2].x, positions[0].x)

    def test_a_missing_glyph_cannot_publish_a_background_and_half_a_vertical_label(self):
        doc = ezdxf.new('R2013'); doc.styles.new('V', dxfattribs={'font': 'primary.shp'})
        doc.modelspace().add_line((0, 0), (1, 1))
        doc.modelspace().add_mtext(r'{\LA}\P\SA/missing;', dxfattribs={
            'style': 'V', 'char_height': 8, 'flow_direction': 3, 'bg_fill': 1, 'bg_fill_color': 3})
        result = convert(doc, {'primary.shp': PRIMARY_SHP})
        items = result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items']
        self.assertEqual(len(items), 1)
        item = next(iter(items.values()))
        self.assertEqual(item['status'], 'missing')
        self.assertIn('glyph-missing', item['reason'])
        self.assertEqual(item['parts'], [])


if __name__ == '__main__':
    unittest.main()
