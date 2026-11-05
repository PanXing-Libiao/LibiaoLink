import unittest
from ezdxf.acis import api,sat
from ezdxf.render import MeshBuilder
from test_fonts_layout_xref import ezdxf,convert
from test_wide_polylines import source_entity,mesh
from test_linetype_presentations import primitive_data
from unified import dxf_region


def region(version='R2010'):
    doc=ezdxf.new(version)
    builder=MeshBuilder();builder.vertices=[(0,0,0),(2,0,0),(2,2,0),(0,2,0)];builder.faces=[(0,1,2,3)]
    body=api.body_from_mesh(builder)
    entity=doc.modelspace().add_region()
    api.export_dxf(entity,[body])
    return doc,entity


class RegionTest(unittest.TestCase):
    def test_sat_and_sab_planar_boundaries_are_read_under_the_region_identity(self):
        for version in ('R2010','R2013'):
            doc,item=region(version)
            result=convert(doc);source=source_entity(result,item.dxf.handle)
            self.assertEqual(result['snapshot']['completeness'],'complete')
            draw=next(iter(result['snapshot']['drawingProjection']['draws'].values()))
            points=[p for pts,_,_ in primitive_data(result,draw['displayRepresentationId']) for p in pts]
            self.assertEqual([min(p[i] for p in points) for i in range(3)],[0,0,0])
            self.assertEqual([max(p[i] for p in points) for i in range(3)],[2,2,0])

    def test_ellipse_is_not_replaced_by_its_chord(self):
        doc,item=region();builder=sat.parse_sat(item.sat)
        edge=next(e for e in builder.entities if e.name=='edge')
        curve=next(e for e in dxf_region.refs(edge) if e.name=='straight-curve')
        curve.name='ellipse-curve';curve.data=[sat.NULL_PTR,'0','-1','0','0','0','1','1','0','0','1','I','I']
        item.sat=builder.dump_sat()
        result=convert(doc);source=source_entity(result,item.dxf.handle)
        geometry,_,_=mesh(result,source)
        self.assertEqual(result['snapshot']['completeness'],'complete')
        self.assertLess(geometry['bounds']['min'][1],-.99)

    def test_unknown_curve_refuses_the_whole_derivative(self):
        doc,item=region();builder=sat.parse_sat(item.sat)
        curve=next(e for e in builder.entities if e.name=='straight-curve');curve.name='unknown-curve'
        item.sat=builder.dump_sat()
        result=convert(doc)
        entry=next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
        self.assertEqual(entry['status'],'missing')
        self.assertEqual(entry['parts'],[])
        self.assertEqual(result['snapshot']['completeness'],'partial')

    def test_inner_loop_keeps_all_source_boundary_edges(self):
        from ezdxf.acis.entities import NONE_REF
        builder=MeshBuilder();builder.vertices=[(0,0,0),(10,0,0),(10,10,0),(0,10,0),
            (3,3,0),(3,7,0),(7,7,0),(7,3,0)];builder.faces=[(0,1,2,3),(4,5,6,7)]
        body=api.body_from_mesh(builder)
        faces=[face for lump in body.lumps() for shell in lump.shells() for face in shell.faces()]
        outer,inner=faces
        outer.loop.next_loop=inner.loop;inner.loop.face=outer
        outer.next_face=NONE_REF;outer.shell.next_shell=NONE_REF
        body.lump.next_lump=NONE_REF
        for version in ('R2010','R2013'):
            doc=ezdxf.new(version);item=doc.modelspace().add_region();api.export_dxf(item,[body])
            result=convert(doc)
            entry=next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
            self.assertEqual(entry['status'],'ready',entry);self.assertEqual(len(entry['parts']),8)

    def test_explicit_spline_keeps_its_curve_shape(self):
        doc,item=region();builder=sat.parse_sat(item.sat)
        edge=next(e for e in builder.entities if e.name=='edge')
        curve=next(e for e in dxf_region.refs(edge) if e.name=='straight-curve')
        curve.name='intcurve-curve'
        curve.data=[sat.NULL_PTR,'nubs','2','open','2','0','2','1','2',
                    '-1','-1','0','0','-2','0','1','-1','0']
        item.sat=builder.dump_sat();result=convert(doc)
        self.assertEqual(result['snapshot']['completeness'],'complete')
        draw=next(iter(result['snapshot']['drawingProjection']['draws'].values()))
        points=[p for pts,_,_ in primitive_data(result,draw['displayRepresentationId']) for p in pts]
        self.assertLess(min(p[1] for p in points),-.49)


if __name__=='__main__':unittest.main()
