"""DXF source fidelity across uploaded fonts, layouts and external references."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cad_paths import CORE, DATA
import io
import json
import subprocess
import tempfile
import unittest

import ezdxf
from ezdxf import xref
from ezdxf.xclip import XClip
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from unified.dxf_adapter import read_dxf, project_drawing
from unified.validation import validate_envelope
from unified import dxf_bigfont, dxf_shx
from unified.dxf_xref import load_references
from ezdxf.fonts import shapefile

PRIMARY_SHP = b'''*0,4,Generated primary
8,2,2,0
*32,5,space
2,8,6,0,0
*65,27,A
2,14,8,-2,-8,1,8,4,0,8,0,8,8,-4,0,8,0,-8,2,8,6,0,14,8,-4,-2,0
*120,9,x
1,8,4,4,2,8,2,-4,0
*112,9,p
1,8,4,-2,2,8,2,2,0
'''
BIG_SHP = b'''*BIGFONT 1,1,080,0FF
*0,4,Generated CJK
8,2,2,0
*0D6D0,27,zhong
2,14,8,-4,-8,1,8,8,0,8,0,8,8,-8,0,8,0,-8,2,8,10,0,14,8,-6,-2,0
'''


def font_bytes(width=600, otf=False, bold=False):
    builder = FontBuilder(1000, isTTF=not otf)
    names = ['.notdef', 'space', 'A', 'x', 'p', 'uni4E2D', *['digit'+str(i) for i in range(10)]]
    builder.setupGlyphOrder(names)
    builder.setupCharacterMap({32: 'space', 65: 'A', 120: 'x', 112: 'p', 0x4e2d: 'uni4E2D', **{48+i:'digit'+str(i) for i in range(10)}})
    glyphs = {}
    for name in names:
        pen = T2CharStringPen(width, None) if otf else TTGlyphPen(None)
        if name != 'space':
            pen.moveTo((0, 0)); pen.lineTo((width-100, 0)); pen.lineTo((width-100, 700)); pen.lineTo((0, 700)); pen.closePath()
        glyphs[name] = pen.getCharString() if otf else pen.glyph()
    if otf: builder.setupCFF('UploadedTest', {'FullName': 'UploadedTest', 'FamilyName': 'UploadedTest', 'Weight': 'Regular'}, glyphs, {})
    else: builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (width, 0) for name in names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({'familyName': 'UploadedTest', 'styleName': 'Regular', 'uniqueFontIdentifier': 'UploadedTest', 'fullName': 'UploadedTest', 'psName': 'UploadedTest'})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, usWeightClass=700 if bold else 400)
    builder.setupPost(); builder.setupMaxp()
    output = io.BytesIO(); builder.save(output)
    return output.getvalue()


def raw_doc(doc):
    output = io.StringIO(); doc.write(output)
    return output.getvalue().encode(doc.output_encoding)


def convert(doc, files=None):
    raw = raw_doc(doc)
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'main.dxf'; path.write_bytes(raw)
        result = read_dxf(path, raw, resources=files, logical_path='drawings/main.dxf')
    validate_envelope(result)
    return result


class FontsLayoutsXrefTest(unittest.TestCase):
    def test_unchanged_upstream_bigfonts_render_extended_and_primary_subshapes(self):
        fixtures=Path(__file__).resolve().parents[1]/'fixtures/fonts'
        primary=shapefile.shp_load(PRIMARY_SHP+b'*49,9,one\n1,8,0,8,2,8,6,-8,0\n')
        expected={'truedxf-big.shx':13,'truedxf-extbig.shx':7}
        for name,count in expected.items():
            font=dxf_bigfont.load((fixtures/name).read_bytes())
            self.assertEqual(len(font.shapes),count)
            for shape in font.shapes:
                glyph=font.render_glyph(shape,primary=primary)
                self.assertGreater(len(glyph),0)
            with self.assertRaises(ValueError):
                if name=='truedxf-big.shx':font.render_glyph(0x8740)
                else:dxf_bigfont.load((fixtures/name).read_bytes()[:-1])
    def test_bigfont_uses_declared_codepage_and_vertical_cursor(self):
        for vertical in (False, True):
            doc = ezdxf.new('R2013'); doc.encoding = 'gbk'
            doc.styles.new('CJK', dxfattribs={'font': 'primary.shp', 'bigfont': 'big.shp', 'flags': 4 if vertical else 0})
            doc.modelspace().add_text('A中A', dxfattribs={'style': 'CJK', 'height': 8})
            result = convert(doc, {'primary.shp': PRIMARY_SHP, 'big.shp': BIG_SHP})
            self.assertEqual(result['snapshot']['completeness'], 'complete', result['document']['extensions'][dxf_shx.EXTENSION])
            items = result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items']
            self.assertTrue(all(row['status'] == 'ready' for row in items.values()), items)
            state = load_references(doc, raw_doc(doc), 'main.dxf')
            resources = dxf_shx.Resources(doc, state, {'primary.shp': PRIMARY_SHP, 'big.shp': BIG_SHP})
            text = next(iter(doc.modelspace()))
            binding = resources.binding(text, [{'sourceId': state.sid, 'objectKey': text.dxf.handle}])
            glyph = resources.font(binding).text_path_ex('A中A', 8)
            self.assertAlmostEqual(glyph.end.x, 0 if vertical else 22)
            self.assertAlmostEqual(glyph.end.y, -30 if vertical else 0)

    def test_family_named_true_type_and_explicit_inline_font_are_resolved(self):
        doc = ezdxf.new('R2013')
        doc.styles.new('Family', dxfattribs={'font': 'UploadedTest'})
        doc.modelspace().add_mtext(r'A{\fUploadedTest;中}', dxfattribs={'style': 'Family', 'char_height': 2, 'width': 20})
        result = convert(doc, {'fonts/custom.ttf': font_bytes()})
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        ambiguous = convert(doc, {'a.ttf': font_bytes(), 'b.ttf': font_bytes(900)})
        self.assertEqual(ambiguous['snapshot']['completeness'], 'partial')
        self.assertTrue(any(row['status'] == 'ambiguous' for row in ambiguous['document']['extensions'][dxf_shx.EXTENSION]['references']))

    def test_uploaded_open_type_outlines_and_missing_glyph(self):
        doc = ezdxf.new('R2013'); doc.styles.new('OTF', dxfattribs={'font':'custom.otf'})
        text=doc.modelspace().add_text('A中',dxfattribs={'style':'OTF','height':2})
        self.assertEqual(convert(doc, {'custom.otf':font_bytes(otf=True)})['snapshot']['completeness'],'complete')
        text.dxf.text='A字'
        result=convert(doc, {'custom.otf':font_bytes(otf=True)})
        self.assertEqual(result['snapshot']['completeness'],'partial')
        self.assertEqual(result['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']['withoutDisplayGeometry'],1)
        self.assertEqual(result['document']['extensions'][dxf_shx.EXTENSION]['coverage']['missingObjects'],1)

    def test_inline_bold_requires_and_uses_the_actual_uploaded_face(self):
        doc=ezdxf.new('R2013');doc.styles.new('Custom',dxfattribs={'font':'regular.ttf'})
        doc.modelspace().add_mtext(r'A{\fUploadedTest|b1;A}',dxfattribs={'style':'Custom','char_height':2,'width':20})
        regular={'regular.ttf':font_bytes()}
        self.assertEqual(convert(doc,regular)['snapshot']['completeness'],'partial')
        result=convert(doc,{**regular,'bold.ttf':font_bytes(width=800,bold=True)})
        self.assertEqual(result['snapshot']['completeness'],'complete')
        self.assertTrue(any(r['logicalPath']=='bold.ttf' and r['status']=='resolved' for r in result['document']['extensions'][dxf_shx.EXTENSION]['references']))

    def test_block_attribute_inherits_its_insert_clip(self):
        doc=ezdxf.new('R2013'); block=doc.blocks.new('Label')
        block.add_line((0,0),(10,0))
        insert=doc.modelspace().add_blockref('Label',(10,20))
        insert.add_attrib('NAME','A',(40,20))
        XClip(insert).set_block_clipping_path([(0,-1),(5,1)])
        result=convert(doc)
        attr=next(d for d in result['snapshot']['drawingProjection']['draws'].values() if d['kind']=='annotation')
        self.assertEqual(attr['clipRegions'][0]['boundary'][0],[10,19])
        self.assert_browser_parity(result)

    def test_binary_bigfont_index_and_extended_subshape_are_bounded(self):
        import struct
        signature = b'AutoCAD-86 bigfont 1.0\r\n\x1a'
        records = {0: b'Generated\0'+bytes([8,0,2,8,0]),
                   1: b'primitive\0'+bytes([1,8,8,0,8,0,8,0]),
                   0xd6d0: b'CJK\0'+bytes([7,0,0,1,0,0,8,8,2,8,10,0,0])}
        start = len(signature)+6+4+len(records)*8
        entries = []; payload = b''
        for n, raw in records.items():
            entries.append(struct.pack('<HHI', n, len(raw), start+len(payload))); payload += raw
        binary = signature+struct.pack('<HHH',8,len(records),1)+struct.pack('<HH',128,255)+b''.join(entries)+payload
        font = dxf_bigfont.load(binary)
        glyph = font.render_glyph(0xd6d0)
        self.assertEqual(list(glyph.end), [10, 0])
        self.assertGreater(len(glyph), 2)
        with self.assertRaises((ValueError, IndexError, struct.error)):
            dxf_bigfont.load(binary[:-4])
        with self.assertRaisesRegex(ValueError,'bigfont-legacy-height-profile-unverified'):
            dxf_bigfont.load(BIG_SHP.replace(b'8,2,2,0',b'0,64,2,0'))

    def test_uploaded_true_type_is_used_for_text_and_mtext_without_global_cache(self):
        doc = ezdxf.new('R2013')
        doc.styles.new('Custom', dxfattribs={'font': 'fonts/custom.ttf'})
        doc.modelspace().add_text('A中', dxfattribs={'style': 'Custom', 'height': 2})
        doc.modelspace().add_mtext('A中', dxfattribs={'style': 'Custom', 'char_height': 2, 'width': 20})
        first = convert(doc, {'drawings/fonts/custom.ttf': font_bytes()})
        second = convert(doc, {'drawings/fonts/custom.ttf': font_bytes(900)})
        for result in (first, second):
            rows = result['document']['extensions']['org.cad-preview.dxf-shx/1']
            self.assertEqual(rows['coverage']['unresolvedReferences'], 0, rows)
            self.assertTrue(any(row['logicalPath'].endswith('.ttf') for row in rows['references']))
            self.assertEqual(result['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']['withoutDisplayGeometry'], 0)
        resources = lambda r: sorted(row['sha256'] for row in r['document']['resources'].values() if row.get('mediaType') == 'font/ttf')
        self.assertNotEqual(resources(first), resources(second))
        width = lambda r: max(g['bounds']['max'][0]-g['bounds']['min'][0] for g in r['document']['geometries'].values())
        self.assertGreater(width(second), width(first))

    def test_missing_or_invalid_uploaded_font_stays_partial(self):
        doc = ezdxf.new('R2013')
        doc.styles.new('Custom', dxfattribs={'font': 'custom.ttf'})
        doc.modelspace().add_text('A中', dxfattribs={'style': 'Custom', 'height': 2})
        for files in ({}, {'custom.ttf': b'broken-font'}):
            result = convert(doc, files)
            self.assertEqual(result['snapshot']['completeness'], 'partial')
            self.assertGreater(result['document']['extensions']['org.cad-preview.dxf-shx/1']['coverage']['unresolvedReferences'], 0)

    def test_nonrectangular_viewport_keeps_curve_boundary_and_layer_overrides(self):
        doc = ezdxf.new('R2013'); doc.layers.new('Outline', dxfattribs={'color': 1})
        doc.modelspace().add_line((-20, 0), (20, 0), dxfattribs={'layer': 'Outline'})
        layout = doc.layouts.get('Layout1')
        boundary = layout.add_circle((50, 50), 5)
        vp = layout.add_viewport(center=(50, 50), size=(20, 20), view_center_point=(0, 0), view_height=20)
        vp.dxf.flags |= 65536; vp.dxf.clipping_boundary_handle = boundary.dxf.handle
        override = doc.layers.get('Outline').get_vp_overrides()
        override.set_color(vp.dxf.handle, 3); override.set_lineweight(vp.dxf.handle, 70); override.commit()
        result = convert(doc); drawing = result['document']['drawing']
        viewport = next(iter(drawing['viewports'].values()))
        self.assertGreater(len(viewport['clipBoundary']), 8)
        projection = project_drawing(result['document'], {'kind': 'layout', 'layoutId': viewport['layoutId']})
        draw = next(row for row in projection['draws'].values() if row.get('viewportId'))
        self.assertEqual(draw['style']['color'], [0, 1, 0, 1])
        self.assertAlmostEqual(draw['style']['lineWeight']['value'], .7)
        self.assert_browser_parity(result)

    def test_viewport_transparency_keeps_entity_and_byblock_overrides(self):
        doc=ezdxf.new('R2013');layer=doc.layers.new('Steel');layer.transparency=.2
        doc.modelspace().add_line((0,0),(1,0),dxfattribs={'layer':'Steel'})
        explicit=doc.modelspace().add_line((0,1),(1,1),dxfattribs={'layer':'Steel'});explicit.transparency=.8
        block=doc.blocks.new('Part');block.add_line((0,2),(1,2),dxfattribs={'layer':'Steel','transparency':0x1000000})
        insert=doc.modelspace().add_blockref('Part',(0,0));insert.transparency=.7
        vp=doc.layouts.get('Layout1').add_viewport(center=(5,5),size=(10,10),view_center_point=(0,0),view_height=10)
        override=layer.get_vp_overrides();override.set_transparency(vp.dxf.handle,.4);override.commit()
        result=convert(doc);viewport=next(iter(result['document']['drawing']['viewports'].values()))
        projected=project_drawing(result['document'],{'kind':'layout','layoutId':viewport['layoutId']})
        opacities=sorted(d['style']['opacity'] for d in projected['draws'].values())
        self.assertAlmostEqual(opacities[0],1-explicit.transparency)
        self.assertAlmostEqual(opacities[1],1-insert.transparency)
        self.assertAlmostEqual(opacities[2],.6)
        self.assert_browser_parity(result)

    def test_generated_text_glyphs_keep_explicit_object_transparency(self):
        doc=ezdxf.new('R2013');doc.styles.new('Custom',dxfattribs={'font':'font.ttf'})
        text=doc.modelspace().add_mtext('A中',dxfattribs={'style':'Custom','char_height':2,'width':20})
        text.transparency=.4
        result=convert(doc,{'font.ttf':font_bytes()});drawing=result['document']['drawing']
        styles={};space=next(iter(drawing['drawings'].values()))['modelSpaceId']
        project_drawing(result['document'],{'kind':'model','spaceId':space},presentation_styles=styles)
        self.assertTrue(styles)
        for rows in styles.values():
            for row in rows:self.assertAlmostEqual(row['style']['opacity'],1-text.transparency)
        self.assert_browser_parity(result)

    def test_table_tag_storage_uses_the_same_transparency_contract_as_graphics(self):
        from ezdxf.entities import factory
        from ezdxf.lldxf.extendedtags import ExtendedTags
        from ezdxf.colors import float2transparency
        doc=ezdxf.new('R2013');block=doc.blocks.new('*T1');block.add_line((0,0),(5,0),dxfattribs={'color':0})
        tags=ExtendedTags.from_text('0\nACAD_TABLE\n100\nAcDbEntity\n8\n0\n420\n3368601\n440\n'+str(float2transparency(.4))+
            '\n100\nAcDbBlockReference\n2\n*T1\n10\n0\n20\n0\n30\n0\n100\nAcDbTable\n280\n0\n')
        doc.modelspace().add_entity(factory.load(tags,doc))
        result=convert(doc);self.assertEqual(result['snapshot']['completeness'],'complete')
        styles={};space=next(iter(result['document']['drawing']['drawings'].values()))['modelSpaceId']
        project_drawing(result['document'],{'kind':'model','spaceId':space},presentation_styles=styles)
        self.assertTrue(styles)
        self.assertTrue(all(abs(row['style']['opacity']-.6)<1e-8 for rows in styles.values() for row in rows))
        self.assertTrue(all(row['style']['color']==[.2,.4,.6,1] for rows in styles.values() for row in rows))
        self.assert_browser_parity(result)

    def test_missing_clip_entity_is_partial_and_never_becomes_a_rectangle(self):
        doc = ezdxf.new('R2013'); doc.modelspace().add_line((0,0), (5,5))
        vp = doc.layouts.get('Layout1').add_viewport(center=(5,5), size=(10,10), view_center_point=(0,0), view_height=10)
        vp.dxf.flags |= 65536
        for handle in ('0', 'DEADBEEF'):
            vp.dxf.clipping_boundary_handle = handle
            result = convert(doc)
            self.assertEqual(result['snapshot']['completeness'], 'partial')
            self.assertFalse(result['document']['drawing']['viewports'])

    def test_xclip_and_host_layer_override_load_real_companion(self):
        leaf = ezdxf.new('R2013'); leaf.layers.new('Steel', dxfattribs={'color': 1})
        leaf.modelspace().add_line((-10, 0), (10, 0), dxfattribs={'layer': 'Steel'})
        doc = ezdxf.new('R2013')
        insert = xref.attach(doc, block_name='Part', filename='refs/part.dxf', insert=(10, 20))
        XClip(insert).set_block_clipping_path([(-2, -2), (2, -2), (0, 2)])
        doc.layers.new('Part|Steel', dxfattribs={'color': 3})
        result = convert(doc, {'drawings/refs/part.dxf': raw_doc(leaf)})
        refs = result['document']['extensions']['org.cad-preview.dxf-xref/1']['references']
        self.assertEqual(refs[0]['status'], 'resolved', refs)
        draw = next(iter(result['snapshot']['drawingProjection']['draws'].values()))
        self.assertEqual(draw['style']['color'], [0, 1, 0, 1])
        self.assertEqual(len(draw['clipRegions']), 1)
        self.assertEqual(draw['clipRegions'][0]['boundary'], [[8, 18], [12, 18], [10, 22]])
        self.assert_browser_parity(result)

    def test_nested_external_and_array_clips_keep_each_placement(self):
        leaf = ezdxf.new('R2013'); leaf.modelspace().add_line((-10,0),(10,0))
        mid = ezdxf.new('R2013')
        nested = xref.attach(mid, block_name='Leaf', filename='leaf.dxf', insert=(2,0))
        XClip(nested).set_block_clipping_path([(-1,-1),(1,1)])
        doc = ezdxf.new('R2013')
        root = xref.attach(doc, block_name='Mid', filename='refs/mid.dxf', insert=(20,30))
        root.dxf.column_count=2; root.dxf.column_spacing=15
        XClip(root).set_block_clipping_path([(-5,-5),(5,5)])
        result=convert(doc, {'drawings/refs/mid.dxf':raw_doc(mid), 'drawings/refs/leaf.dxf':raw_doc(leaf)})
        draws=list(result['snapshot']['drawingProjection']['draws'].values())
        self.assertEqual(len(draws),2)
        self.assertEqual([len(d['clipRegions']) for d in draws],[2,2])
        self.assertEqual(draws[0]['clipRegions'][1]['boundary'][0],[21,29])
        self.assertEqual(draws[1]['clipRegions'][1]['boundary'][0],[36,29])
        self.assert_browser_parity(result)

    def test_disabled_inverted_and_depth_clips_have_distinct_semantics(self):
        doc=ezdxf.new('R2013');block=doc.blocks.new('Part');block.add_line((-10,0),(10,0))
        insert=doc.modelspace().add_blockref('Part',(20,30));clip=XClip(insert)
        clip.set_block_clipping_path([(-2,-2),(2,2)])
        clip.disable_clipping()
        self.assertTrue(all('clipRegions' not in d for d in convert(doc)['snapshot']['drawingProjection']['draws'].values()))
        clip.enable_clipping();clip.invert_clipping_path(ignore_acad_compatibility=True)
        result=convert(doc)
        self.assertTrue(next(iter(result['snapshot']['drawingProjection']['draws'].values()))['clipRegions'][0]['inverted'])
        self.assert_browser_parity(result)
        clip.get_spatial_filter().dxf.has_front_clipping_plane=1
        blocked=convert(doc)
        self.assertEqual(blocked['snapshot']['completeness'],'partial')
        self.assertTrue(any('depth-planes' in e['geometry'].get('reason','') for e in blocked['document']['drawing']['entities'].values()))

    def assert_browser_parity(self, result):
        module=(CORE.parents[2]/'frontend/public/cad-viewer/core/drawing-projection.js').resolve().as_uri()
        drawing=result['document']['drawing']
        space=next(iter(drawing['drawings'].values()))['modelSpaceId']
        targets=[{'kind':'model','spaceId':space}]+[{'kind':'layout','layoutId':key} for key in drawing['layouts']]
        script="import {projectDrawing} from "+json.dumps(module)+";let raw='';for await(const chunk of process.stdin)raw+=chunk;const {document,targets}=JSON.parse(raw);process.stdout.write(JSON.stringify(targets.map(t=>{const layers={},styles={};return {projection:projectDrawing(document,t,layers,styles),layers,styles};})));"
        proc=subprocess.run(['node','--input-type=module','-e',script], input=json.dumps({'document':result['document'],'targets':targets}), text=True,capture_output=True,check=True)
        js=json.loads(proc.stdout)
        for target, actual in zip(targets,js):
            layers,styles={},{}
            projection=project_drawing(result['document'],target,layers,styles)
            self.assertEqual(actual,{'projection':projection,'layers':layers,'styles':styles})

    def test_cached_external_block_is_reloaded_from_selected_version(self):
        leaf = ezdxf.new('R2013'); leaf.modelspace().add_line((0, 0), (20, 0))
        doc = ezdxf.new('R2013')
        xref.attach(doc, block_name='Part', filename='part.dxf', insert=(0, 0))
        doc.blocks['Part'].add_line((0, 0), (999, 0))
        result = convert(doc, {'part.dxf': raw_doc(leaf)})
        refs = result['document']['extensions']['org.cad-preview.dxf-xref/1']['references']
        self.assertEqual(refs[0]['status'], 'resolved', refs)
        geometries = [row['geometry'] for row in result['document']['drawing']['entities'].values()]
        self.assertTrue(any(row.get('end') == [20, 0, 0] for row in geometries), geometries)
        self.assertFalse(any(row.get('end') == [999, 0, 0] for row in geometries), geometries)


if __name__ == '__main__':
    unittest.main()
