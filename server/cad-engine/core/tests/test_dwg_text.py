"""Original-font DWG layout regressions; fixtures contain generated glyphs only."""
import io
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent / 'dxf'))
from unified.dwg_text import NativeFonts, TextLayout, add_text_displays
from test_fonts_layout_xref import PRIMARY_SHP, BIG_SHP, font_bytes
from fontTools.ttLib import TTFont, TTCollection


def annotation(text, **changes):
    semantic = dict(height=8, fontFilename='primary.shp', bigFontFilename='big.shp',
        rawText=text, rotation=0, attachmentPoint=1, rectangleWidth=100,
        lineSpacing=1, lineSpacingStyle='AtLeast')
    semantic.update(changes)
    return dict(id='annotation-test', kind='mtext', position=[0,0,0], direction=[1,0,0],
        semantic={key:{'value':value} for key,value in semantic.items()},
        text=text, layerId='layer-0', sourceRefs=[{'sourceId':'source-0','objectKey':'test'}])


def lines(layout):
    result={}
    for run in layout.runs:
        result.setdefault(round(run['baseline'],6),[]).append(run['text'])
    return [''.join(words) for words in result.values()]


class NativeTextTest(unittest.TestCase):
    def setUp(self):
        self.fonts=NativeFonts({'primary.shp':PRIMARY_SHP,'big.shp':BIG_SHP})

    def layout(self, text, **changes):
        result=TextLayout(self.fonts,annotation(text,**changes));result.render();return result

    def test_unicode_primary_symbols_with_bigfont_keep_cjk_routing(self):
        primary = PRIMARY_SHP.replace(b'*0,4,Generated primary\n8,2,2,0',
            b'*UNIFONT,6,Generated Unicode\n8,2,2,0,0,0')
        for code in (0x2205, 0xb2):
            primary += ('*%d,9,symbol\n1,8,4,4,2,8,2,-4,0\n' % code).encode()
        registry = NativeFonts({'unicode.shp': primary, 'big.shp': BIG_SHP})
        font = registry.font('unicode.shp', 'big.shp', 8)
        self.assertEqual(font.text_width('A∅中²'), 28)
        self.assertGreater(len(font.text_path('A∅中²').to_path()), 0)
        with self.assertRaisesRegex(ValueError, 'shx-glyph-missing'):
            font.text_width('☃')
        with self.assertRaisesRegex(ValueError, 'font-codepage-character-unrepresentable'):
            self.fonts.font('primary.shp', 'big.shp', 8).text_width('∅')

    def test_empty_mirrored_attribute_needs_no_font_or_geometry(self):
        a = annotation('', mirror=4, fontFilename='not-provided.shx')
        a['kind'] = 'text'
        displays, extras, buffer = {}, {}, bytearray()
        records = add_text_displays({a['id']: a}, displays, extras, buffer, {})
        self.assertEqual(records[a['id']]['status'], 'ready')
        self.assertEqual(records[a['id']]['fonts'], [])
        self.assertEqual((len(displays), len(buffer)), (0, 0))
        a['text'] = 'A'
        records = add_text_displays({a['id']: a}, displays, {}, buffer, {})
        self.assertEqual(records[a['id']]['reason'], 'native-text-mirrored-layout-unavailable')

    def test_fit_and_aligned_use_source_baseline_with_companion_glyphs(self):
        def layout(mode, endpoint):
            a=annotation('AA',height=8,widthFactor=2,insertPoint=[10,20,0],
                alignmentPoint=endpoint,horizontalAlignment=mode,rotation=0,normal=[0,0,1])
            a['kind']='text'
            result=TextLayout(self.fonts,a)
            return [p for b in result.render() for p in b['points']]
        ordinary=layout('Left',[10,20,0])
        width=self.fonts.font('primary.shp','big.shp',8,2).text_width('AA')
        for mode in ('Fit','Aligned'):
            fitted=layout(mode,[10,20+width*2,0])
            self.assertEqual(len(ordinary),len(fitted))
            for before,after in zip(ordinary,fitted):
                self.assertAlmostEqual(after.y,20+(before.x-10)*2)
                self.assertAlmostEqual(after.x,10-(before.y-20)*(2 if mode=='Aligned' else 1))

    def test_unbounded_center_and_right_use_ink_not_flow_estimate(self):
        for attachment in (2, 3, 5, 6):
            for width in (0, .8):
                result = self.layout(r'A\PAA', attachmentPoint=attachment, rectangleWidth=width)
                points = [p for b in result.batches.values() for p in b['points']]
                left, right = min(p.x for p in points), max(p.x for p in points)
                self.assertAlmostEqual((left+right)/2 if attachment % 3 == 2 else right, 0)
        fixed = self.layout('AA', attachmentPoint=2, rectangleWidth=100)
        self.assertAlmostEqual(fixed.runs[0]['left'] + fixed.runs[0]['width']/2, 0)

    def test_attachment_sets_default_alignment_and_inline_paragraph_can_override(self):
        for attachment in range(1, 10):
            result = self.layout('AA', attachmentPoint=attachment, rectangleWidth=100)
            run = result.runs[0]
            anchor = (attachment - 1) % 3
            self.assertAlmostEqual(run['left'] + run['width'] * anchor / 2, 0)
        right = self.layout(r'\pql;AA', attachmentPoint=3, rectangleWidth=100)
        self.assertAlmostEqual(right.runs[0]['left'], -100)
        left = self.layout(r'\pqr;AA', attachmentPoint=1, rectangleWidth=100)
        self.assertAlmostEqual(left.runs[0]['left'] + left.runs[0]['width'], 100)

    def test_cjk_breaks_but_latin_word_overflows_intact(self):
        self.assertEqual(lines(self.layout('中中中中',rectangleWidth=21)),['中中','中中'])
        self.assertEqual(lines(self.layout('中AAAA中',rectangleWidth=11)),['中','AAAA','中'])

    def test_tiny_frame_is_unbounded_but_preserves_explicit_paragraphs(self):
        self.assertEqual(lines(self.layout(r'中中\P中中',rectangleWidth=.8)),['中中','中中'])
        self.assertEqual(lines(self.layout('中中',rectangleWidth=.80001)),['中','中'])

    def test_tabs_and_hanging_indent_share_font_advances(self):
        result=self.layout(r'\pxi-1,l2,t2;A'+ '\t'+r'中\PA'+'\t'+'中')
        self.assertEqual(lines(result),['A中','A中'])
        self.assertEqual([r['left'] for r in result.runs],[8,16,8,16])

    def test_width_rotation_and_stored_insert_are_not_aligned_twice(self):
        a=annotation('A中A',widthFactor=2,insertPoint=[10,20,0],rotation=1.5707963267948966,
                     horizontalAlignment='Center')
        a['kind']='text';a['position']=[500,600,0]
        layout=TextLayout(self.fonts,a);parts=layout.render()
        self.assertEqual(layout.runs[0]['width'],44)
        points=[p for b in parts for p in b['points']]
        self.assertAlmostEqual(min(p.x for p in points),2)
        self.assertAlmostEqual(min(p.y for p in points),20)

    def test_missing_font_keeps_explicit_substituted_record_without_partial_geometry(self):
        a=annotation('A',fontFilename='missing.shx');displays={};extras={};buffer=bytearray()
        records=add_text_displays({a['id']:a},displays,extras,buffer,{})
        self.assertEqual(records[a['id']]['status'],'substituted')
        self.assertEqual((len(displays),len(buffer)),(0,0))

    def test_empty_text_does_not_publish_an_empty_ready_presentation(self):
        a=annotation('');extras={}
        result=add_text_displays({a['id']:a},{},extras,bytearray(),
                                {'primary.shp':PRIMARY_SHP,'big.shp':BIG_SHP})
        self.assertEqual(result[a['id']]['status'],'ready')
        self.assertNotIn(a['id'],extras.get('meshPresentations',{}))

    def test_concave_glyph_does_not_swallow_an_independent_stroke(self):
        from ezdxf.path import Path as GlyphPath
        from unified.dxf_shx import outline_triangles
        contours=[]
        for points in [[(0,0),(6,0),(6,1),(1,1),(1,5),(6,5),(6,6),(0,6)],
                       [(3,2),(5,2),(5,4),(3,4)]]:
            contour=GlyphPath(points[0])
            for point in points[1:]:contour.line_to(point)
            contour.close();contours.append(contour)
        area=sum(abs((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y))/2
                 for a,b,c in outline_triangles(contours,.001))
        self.assertAlmostEqual(area,20)

    def test_touching_letters_are_not_nested_from_one_boundary_point(self):
        from ezdxf.path import Path as GlyphPath
        from unified.dxf_shx import outline_triangles
        contours=[]
        for points in [[(0,0),(4,0),(2,4)],[(3,0),(7,0),(5,4)]]:
            contour=GlyphPath(points[0])
            for point in points[1:]:contour.line_to(point)
            contour.close();contours.append(contour)
        area=sum(abs((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y))/2
                 for a,b,c in outline_triangles(contours,.001))
        self.assertAlmostEqual(area,16)

    def test_true_type_baseline_and_collection_family(self):
        font=TTFont(io.BytesIO(font_bytes()))
        glyph=font['glyf']['x'];glyph.coordinates.translate((0,40))
        collection=TTCollection();collection.fonts=[font];data=io.BytesIO();collection.save(data)
        registry=NativeFonts({'generated.ttc':data.getvalue()})
        binding=registry.binding('UploadedTest')
        self.assertEqual(binding['_glyphs'].font_measurements.baseline,0)
        self.assertEqual(binding['_glyphs'].font_measurements.cap_height,700)
        a=annotation('AA',fontFilename='',fontFamily='UploadedTest',bigFontFilename='')
        result=TextLayout(registry,a);result.render()
        self.assertEqual(lines(result),['AA'])

    def test_at_least_uses_ink_ascent_while_exact_keeps_pitch(self):
        font=TTFont(io.BytesIO(font_bytes()))
        glyph=font['glyf']['uni4E2D'];glyph.coordinates.scale((1,10/7))
        data=io.BytesIO();font.save(data)
        registry=NativeFonts({'generated.ttf':data.getvalue()})
        for style,pitch in [('AtLeast',14+2/3),('Exact',11+2/3)]:
            a=annotation(r'中\P中',height=7,fontFilename='generated.ttf',bigFontFilename='',lineSpacingStyle=style)
            result=TextLayout(registry,a);result.render()
            self.assertAlmostEqual(result.runs[0]['baseline'],-10)
            self.assertAlmostEqual(result.runs[0]['baseline']-result.runs[1]['baseline'],pitch)


if __name__=='__main__':unittest.main()
