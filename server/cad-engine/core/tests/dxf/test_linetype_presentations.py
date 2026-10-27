"""Actual ink, source arc-length phase, resources and projection parity."""
import base64
import copy
import math
import struct
import unittest

from test_fonts_layout_xref import ezdxf, convert, PRIMARY_SHP, font_bytes
import test_ownership as ownership
from test_wide_polylines import source_entity
from unified import dxf_shx


def primitive_data(result, representation_id):
    document = result['document']
    def values(key):
        accessor = document['accessors'][key]
        raw = base64.b64decode(result['bufferPayloads'][accessor['bufferId']])
        return struct.unpack_from('<' + ('d' if accessor['component'] == 'f64' else 'I') * accessor['count'] * accessor['components'], raw, accessor['byteOffset'])
    for binding in document['representations'][representation_id]['bindings']:
        geometry = document['geometries'][binding['geometryId']]
        flat = values(geometry['attributes']['POSITION'])
        points = [flat[i:i+3] for i in range(0, len(flat), 3)]
        for primitive in geometry['primitives']:
            yield points, values(primitive['indices']) if 'indices' in primitive else (), primitive['topology']


def triangle_hit(result, draw, point):
    for points, indices, topology in primitive_data(result, draw['displayRepresentationId']):
        if topology != 'triangles': continue
        for index in range(0, len(indices), 3):
            tri = [points[indices[index+k]] for k in range(3)]
            signs = [(b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0]) for a,b in zip(tri, tri[1:]+tri[:1])]
            if min(signs) >= -1e-9 or max(signs) <= 1e-9: return True
    return False


def draw_for(result, source):
    item = source_entity(result, source.dxf.handle)
    return next(row for row in result['snapshot']['drawingProjection']['draws'].values() if row['itemId'] == item['id'])


class LineTypePresentationsTest(unittest.TestCase):
    assertTree = ownership.InstanceOwnership.assertTree
    assertBrowser = ownership.InstanceOwnership.assertBrowser

    def test_model_annotation_scale_changes_model_metric_only(self):
        from ezdxf.entities import factory
        from ezdxf.lldxf.extendedtags import ExtendedTags
        from unified.dxf_adapter import project_drawing
        doc=ezdxf.new('R2013')
        variables=doc.rootdict.add_new_dict('AcDbVariableDictionary')
        variables.add_dict_var('CANNOSCALE','1:4')
        variables.add_dict_var('MSLTSCALE','1')
        scale=factory.load(ExtendedTags.from_text('0\nSCALE\n5\nFA01\n100\nAcDbScale\n300\n1:4\n140\n1\n141\n4\n'))
        doc.objects.add_object(scale)
        doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
        source=doc.modelspace().add_lwpolyline([(0,0),(64,0)],dxfattribs={'const_width':1,'linetype':'Dash'})
        result=convert(doc); draw=draw_for(result,source)
        self.assertTrue(triangle_hit(result,draw,(2,0)))
        self.assertFalse(triangle_hit(result,draw,(7,0)))
        self.assertBrowser(result)

    def test_dot_patterns_keep_every_point_and_both_endpoints(self):
        doc=ezdxf.new('R2013');doc.linetypes.new('Dots',dxfattribs={'pattern':[4,0,-4]})
        doc.linetypes.new('Unused',dxfattribs={'length':4,'pattern':'A,1,-1,[65,missing.shp,S=.5],-2'})
        source=doc.modelspace().add_line((0,0),(20,0),dxfattribs={'linetype':'Dots'})
        result=convert(doc);draw=draw_for(result,source)
        positions=[p for points,_,topology in primitive_data(result,draw['displayRepresentationId']) if topology=='points' for p in points]
        self.assertEqual(sorted(p[0] for p in positions),[0,4,8,12,16,20])
        self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_instance_scaling_changes_width_but_not_the_world_dash_length(self):
        doc=ezdxf.new('R2013');doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
        block=doc.blocks.new('Band')
        source=block.add_lwpolyline([(0,0),(10,0)],dxfattribs={'const_width':1,'linetype':'Dash'})
        doc.modelspace().add_blockref('Band',(0,0),dxfattribs={'xscale':2,'yscale':3})
        result=convert(doc);draw=draw_for(result,source)
        self.assertTrue(triangle_hit(result,draw,(.25,.4)))
        self.assertFalse(triangle_hit(result,draw,(.75,0)))
        self.assertTrue(triangle_hit(result,draw,(2,0)))
        self.assertBrowser(result)

    def test_psltscale_selects_paper_or_model_pattern_lengths(self):
        from unified.dxf_adapter import project_drawing
        for psltscale in (0,1):
            doc=ezdxf.new('R2013');doc.header['$PSLTSCALE']=psltscale
            doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
            source=doc.modelspace().add_lwpolyline([(0,0),(10,0)],dxfattribs={'const_width':1,'linetype':'Dash'})
            doc.layouts.get('Layout1').add_viewport(center=(50,50),size=(10,10),view_center_point=(5,0),view_height=20)
            result=convert(doc);item=source_entity(result,source.dxf.handle)
            viewport=next(iter(result['document']['drawing']['viewports'].values()))
            projection=project_drawing(result['document'],{'kind':'layout','layoutId':viewport['layoutId']})
            draw=next(row for row in projection['draws'].values() if row['itemId']==item['id'])
            self.assertEqual(triangle_hit(result,draw,(4.5,0)),psltscale==0)
            self.assertBrowser(result)

    def test_nonuniformly_scaled_bulge_uses_the_transformed_arc_length(self):
        doc=ezdxf.new('R2013');doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
        block=doc.blocks.new('Curve')
        source=block.add_lwpolyline([(5,0,0,0,1),(-5,0,0,0,0)],format='xyseb',dxfattribs={'const_width':.5,'linetype':'Dash','flags':128})
        doc.modelspace().add_blockref('Curve',(0,0),dxfattribs={'xscale':2})
        result=convert(doc);draw=draw_for(result,source)
        self.assertTrue(triangle_hit(result,draw,(5*math.cos(.2),5*math.sin(.2))))
        self.assertFalse(triangle_hit(result,draw,(5*math.cos(.3),5*math.sin(.3))))
        self.assertBrowser(result)

    def test_a_type_end_dashes_and_short_units_follow_the_cad_rules(self):
        doc=ezdxf.new('R2013');doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
        source=doc.modelspace().add_lwpolyline([(0,0),(8,0)],dxfattribs={'const_width':1,'linetype':'Dash'})
        result=convert(doc);draw=draw_for(result,source)
        for point,ink in (((.5,0),True),((1.5,0),False),((4,0),True),((6,0),False),((7.5,0),True)):
            self.assertEqual(triangle_hit(result,draw,point),ink)
        doc=ezdxf.new('R2013')
        doc.styles.new('Pipe',dxfattribs={'font':'missing.ttf'})
        doc.linetypes.new('Pipe',dxfattribs={'length':4,'pattern':'A,1,-1,["A",Pipe,S=.5],-2'})
        doc.modelspace().add_line((0,0),(.5,0),dxfattribs={'linetype':'Pipe'})
        short=convert(doc)
        self.assertEqual(short['snapshot']['completeness'],'complete')
        self.assertEqual(short['document']['extensions'][dxf_shx.EXTENSION]['references'],[])

    def test_source_degrees_and_upright_flag_use_the_community_cad_probes(self):
        from ezdxf.lldxf.types import DXFTag
        doc=ezdxf.new('R2013')
        doc.styles.new('Pipe',dxfattribs={'font':'custom.ttf'})
        ltype=doc.linetypes.new('Pipe',dxfattribs={'length':4,'pattern':'A,1,-1,["A",Pipe,S=.5,X=.25,Y=.2],-2'})
        ltype.pattern_tags.tags[:]=[DXFTag(74,10) if tag.code==74 and tag.value else tag for tag in ltype.pattern_tags.tags]
        source=doc.modelspace().add_line((12,0),(0,0),dxfattribs={'linetype':'Pipe'})
        result=convert(doc,{'custom.ttf':font_bytes()});draw=draw_for(result,source)
        parts=result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'][draw['itemId']]['parts']
        glyph=next(part for part in parts[0]['lineTypeVariants'][draw['style']['lineTypeId']]['parts'] if part['role']=='symbol')
        positions=[p for points,_,_ in primitive_data(result,glyph['representationId']) for p in points]
        self.assertAlmostEqual(min(p[1] for p in positions),-.2-3/7)
        self.assertEqual(result['snapshot']['completeness'],'complete')
        doc=ezdxf.new('R2013')
        doc.linetypes.new('Shapes',dxfattribs={'length':4,'pattern':'A,1,-1,[65,pipe.shp,S=.5,R=180],-2'})
        source=doc.modelspace().add_line((0,0),(4,0),dxfattribs={'linetype':'Shapes'})
        result=convert(doc,{'pipe.shp':b'*65,8,BOX\n1,8,1,1,8,-1,-1,0\n'});draw=draw_for(result,source)
        parts=result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'][draw['itemId']]['parts']
        glyph=next(part for part in parts[0]['lineTypeVariants'][draw['style']['lineTypeId']]['parts'] if part['role']=='symbol')
        positions=[p for points,_,_ in primitive_data(result,glyph['representationId']) for p in points]
        self.assertAlmostEqual(min(p[0] for p in positions),1)
        self.assertAlmostEqual(min(p[1] for p in positions),-.5)

    def test_unrelated_missing_geometry_is_not_counted_twice_by_the_pattern_pass(self):
        doc=ezdxf.new('R2013');doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
        doc.modelspace().add_lwpolyline([(0,0),(10,0)],dxfattribs={'const_width':1,'linetype':'Dash'})
        doc.modelspace().add_shape('Missing',insert=(0,10),size=1)
        result=convert(doc)
        coverage=result['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']
        self.assertEqual(coverage['withDisplayGeometry'],1)
        self.assertEqual(coverage['withoutDisplayGeometry'],1)

    def test_missing_selected_variant_cannot_fall_back_to_the_solid_band(self):
        from unified.dxf_adapter import project_drawing
        doc=ezdxf.new('R2013');doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
        source=doc.modelspace().add_lwpolyline([(0,0),(10,0)],dxfattribs={'const_width':1,'linetype':'Dash'})
        result=copy.deepcopy(convert(doc));draw=draw_for(result,source)
        entry=result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'][draw['itemId']]
        entry['parts'][0]['lineTypeVariants'].clear()
        projection=project_drawing(result['document'],result['snapshot']['drawingProjection']['target'])
        broken=next(row for row in projection['draws'].values() if row['itemId']==draw['itemId'])
        self.assertEqual(broken['availability'],'unsupported')
        self.assertNotIn('displayRepresentationId',broken)
        self.assertBrowser(result)

    def test_a_dash_crossing_the_closed_seam_keeps_the_mitre(self):
        doc = ezdxf.new('R2013');doc.linetypes.new('Dash',dxfattribs={'pattern':[6,2,-2,2]})
        source=doc.modelspace().add_lwpolyline([(0,0),(5,0),(5,5),(0,5)],close=True,
            dxfattribs={'const_width':1,'linetype':'Dash','flags':128})
        result=convert(doc);draw=draw_for(result,source)
        self.assertTrue(triangle_hit(result,draw,(5.4,-.4)))
        self.assertFalse(triangle_hit(result,draw,(5,3.3)))

    def test_mixed_zero_width_and_wide_segments_replace_both_original_batches(self):
        doc=ezdxf.new('R2013');doc.linetypes.new('Dash',dxfattribs={'pattern':[4,2,-2]})
        source=doc.modelspace().add_lwpolyline([(0,0,0,0),(3,0,1,1),(8,0,0,0)],format='xyse',
            dxfattribs={'linetype':'Dash','flags':128})
        result=convert(doc);draw=draw_for(result,source)
        self.assertTrue(triangle_hit(result,draw,(5,.4)))
        self.assertFalse(triangle_hit(result,draw,(2.5,0)))
        lines=[positions for positions,_,topology in primitive_data(result,draw['displayRepresentationId']) if topology=='lines']
        self.assertEqual(max(p[0] for positions in lines for p in positions),1)
        self.assertBrowser(result)

    def test_variable_width_is_interpolated_at_dash_boundaries(self):
        doc = ezdxf.new('R2013')
        doc.linetypes.new('Dash', dxfattribs={'pattern': [4, 2, -2]})
        source = doc.modelspace().add_lwpolyline([(0,0,1,3), (8,0,0,0)], format='xyse', dxfattribs={'linetype':'Dash'})
        result = convert(doc); draw = draw_for(result, source)
        self.assertTrue(triangle_hit(result, draw, (.5, .55)))
        self.assertFalse(triangle_hit(result, draw, (2, 0)))
        self.assertTrue(triangle_hit(result, draw, (4, .9)))
        self.assertFalse(triangle_hit(result, draw, (4, 1.1)))
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        self.assertBrowser(result)

    def test_wide_arc_dash_phase_uses_true_arc_length_for_both_bulge_signs(self):
        for sign in (1, -1):
            doc = ezdxf.new('R2013')
            doc.linetypes.new('Dash', dxfattribs={'pattern': [math.pi, math.pi/2, -math.pi/2]})
            source = doc.modelspace().add_lwpolyline([(5,0,0,0,sign), (-5,0,0,0,0)], format='xyseb',
                dxfattribs={'const_width':1, 'linetype':'Dash', 'flags':128})
            result = convert(doc); draw = draw_for(result, source)
            for distance, ink in ((.7, True), (2.3, False), (3.8, True)):
                angle = distance/5*sign
                self.assertEqual(triangle_hit(result, draw, (5*math.cos(angle), 5*math.sin(angle))), ink)
            self.assertEqual(result['snapshot']['completeness'], 'complete')

    def test_plinegen_controls_phase_across_vertices_and_mixed_width_parts(self):
        for flags in (0, 128):
            doc = ezdxf.new('R2013'); doc.linetypes.new('Dash', dxfattribs={'pattern':[4,2,-2]})
            source = doc.modelspace().add_lwpolyline([(0,0),(3,0),(3,5)],
                dxfattribs={'const_width':.4,'linetype':'Dash','flags':flags})
            result = convert(doc); draw = draw_for(result, source)
            self.assertEqual(triangle_hit(result, draw, (3,1.8)), flags == 128)
            self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_embedded_text_uses_uploaded_glyphs_offset_and_resolved_style(self):
        for font, raw in (('primary.shp', PRIMARY_SHP), ('custom.ttf', font_bytes())):
            doc = ezdxf.new('R2013'); doc.styles.new('Pipe',dxfattribs={'font':font})
            doc.linetypes.new('Pipe',dxfattribs={'length':4,'pattern':'A,1,-1,["A",Pipe,S=.5,X=.25,Y=.2],-2'})
            source = doc.modelspace().add_line((0,0),(12,0),dxfattribs={'linetype':'Pipe'})
            result = convert(doc,{font:raw}); draw=draw_for(result,source)
            self.assertEqual(result['snapshot']['completeness'],'complete')
            entry=result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'][draw['itemId']]
            self.assertTrue(entry['fonts'])
            variant=entry['parts'][0]['lineTypeVariants'][draw['style']['lineTypeId']]
            symbol_part=next(part for part in variant['parts'] if part['role']=='symbol')
            glyph_points=[p for positions,_,_ in primitive_data(result,symbol_part['representationId']) for p in positions]
            self.assertAlmostEqual(min(p[0] for p in glyph_points),1.75)
            self.assertGreaterEqual(min(p[1] for p in glyph_points),.2-1e-8)
            self.assertBrowser(result)

    def test_shape_library_numbers_are_decoded_and_unused_fonts_are_not_required(self):
        shape=b'*65,7,BOX\n1,8,1,1,8,-1,-1,0\n'
        doc=ezdxf.new('R2013')
        doc.linetypes.new('Shapes',dxfattribs={'length':3,'pattern':'A,1,-1,[65,pipe.shp,S=.5,Y=.25],-1'})
        ordinary=doc.modelspace().add_line((0,3),(10,3))
        unused=convert(doc)
        self.assertEqual(unused['snapshot']['completeness'],'complete')
        self.assertEqual(unused['document']['extensions'][dxf_shx.EXTENSION]['references'],[])
        ordinary.dxf.linetype='Shapes'
        missing=convert(doc)
        self.assertEqual(draw_for(missing,ordinary)['availability'],'unsupported')
        self.assertEqual(missing['snapshot']['completeness'],'partial')
        resolved=convert(doc,{'pipe.shp':shape})
        self.assertEqual(resolved['snapshot']['completeness'],'complete')
        self.assertBrowser(resolved)


if __name__ == '__main__': unittest.main()
