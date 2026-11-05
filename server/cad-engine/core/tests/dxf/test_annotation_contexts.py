import unittest
from ezdxf.entities import factory
from ezdxf.lldxf.extendedtags import ExtendedTags
from test_fonts_layout_xref import ezdxf,convert,font_bytes,project_drawing,raw_doc
from test_linetype_presentations import primitive_data
import test_ownership as ownership


def raw_object(doc,kind,body):
    handle=doc.entitydb.next_handle()
    entity=factory.load(ExtendedTags.from_text('0\n'+kind+'\n5\n'+handle+'\n'+body),doc)
    doc.objects.add_object(entity);return entity


def contexts(doc,entity):
    variables=doc.rootdict.add_new_dict('AcDbVariableDictionary')
    variables.add_dict_var('CANNOSCALE','1:4')
    manager=entity.new_extension_dict().dictionary.add_new_dict('AcDbContextDataManager')
    dictionary=manager.add_new_dict('ACDB_ANNOTATIONSCALES')
    scales=[]
    scale_dict=doc.rootdict.get_required_dict('ACAD_SCALELIST')
    for ratio in (1,4):
        scale=raw_object(doc,'SCALE','100\nAcDbScale\n300\n1:'+str(ratio)+'\n140\n1\n141\n'+str(ratio)+'\n')
        scale_dict[str(ratio)]=scale;scales.append(scale)
        leaf=raw_object(doc,'ACDB_TEXTOBJECTCONTEXTDATA_CLASS','100\nAcDbObjectContextData\n70\n4\n290\n'+str(int(ratio==1))+
            '\n100\nAcDbAnnotScaleObjectContextData\n340\n'+scale.dxf.handle+'\n70\n0\n50\n0\n10\n'+str((ratio-1)*10)+'\n20\n0\n11\n0\n21\n0\n')
        dictionary['*A'+str(ratio)]=leaf
    return scales


class AnnotationContextsTest(unittest.TestCase):
    assertTree=ownership.InstanceOwnership.assertTree
    assertBrowser=ownership.InstanceOwnership.assertBrowser

    def test_non_text_context_is_retained_and_cannot_claim_full_placement_coverage(self):
        doc=ezdxf.new('R2013');doc.blocks.new('Part').add_line((0,0),(10,0))
        item=doc.modelspace().add_blockref('Part',(10,20));contexts(doc,item)
        result=convert(doc)
        coverage=result['document']['extensions']['org.cad-preview.dxf-annotation-contexts/1']['coverage']
        self.assertEqual(coverage['sourceObjects'],1);self.assertEqual(coverage['status'],'partial')
        self.assertEqual(result['snapshot']['completeness'],'partial')
        self.assertTrue(any(d['code']=='dxf-annotation-context-partial' for d in result['snapshot']['diagnostics']))

    def test_mtext_context_uses_dxf_point_codes_and_saved_columns(self):
        from unified import dxf_scale
        doc=ezdxf.new('R2013');entity=doc.modelspace().add_mtext(r'A\NA',dxfattribs={'char_height':1})
        context={'sourceType':'ACDB_MTEXTOBJECTCONTEXTDATA_CLASS','scale':{'drawingPerPaper':4},
            'payload':[[70,1],[10,[30,40,0]],[11,[0,1,0]],[40,12],[41,20],[71,1],
                [72,2],[44,5],[45,2],[73,0],[74,1]]}
        copy=dxf_scale.apply_context(entity,context,1)
        self.assertEqual(tuple(copy.dxf.insert),(30,40,0));self.assertEqual(tuple(copy.dxf.text_direction),(0,1,0))
        self.assertEqual(copy.dxf.char_height,4);self.assertEqual(copy.columns.count,2)
        self.assertTrue(copy.columns.reversed_column_flow);self.assertEqual(copy.columns.width,5)
        self.assertEqual(copy.text,r'A\NA');self.assertEqual(entity.dxf.char_height,1)
        context['payload']=[row for row in context['payload'] if row[0] not in (71,73)]+[[71,2],[73,0],[46,10],[46,0]]
        copy=dxf_scale.apply_context(entity,context,1)
        self.assertEqual(copy.columns.heights,[10,0])

    def test_unmatched_scale_respects_source_visibility_and_xref_contexts_keep_fonts(self):
        from ezdxf import xref
        child=ezdxf.new('R2013');child.styles.get('Standard').dxf.font='custom.ttf'
        item=child.modelspace().add_text('A',dxfattribs={'height':1});contexts(child,item)
        host=ezdxf.new('R2013');xref.attach(host,block_name='Part',filename='part.dxf',insert=(100,0))
        variables=host.rootdict.add_new_dict('AcDbVariableDictionary')
        variables.add_dict_var('CANNOSCALE','1:1');variables.add_dict_var('ANNOALLVISIBLE','0')
        result=convert(host,{'part.dxf':raw_doc(child),'custom.ttf':font_bytes()})
        self.assertEqual(result['snapshot']['completeness'],'complete')
        entry=next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
        self.assertEqual(len(entry['scaleVariants']),2)
        self.assertTrue(all(row['status']=='ready' for row in entry['scaleVariants']))
        extension=result['document']['extensions']['org.cad-preview.dxf-annotation-contexts/1']
        extension['modelDrawingPerPaper']=2
        model=next(iter(result['document']['drawing']['drawings'].values()))['modelSpaceId']
        styles={}
        projection=project_drawing(result['document'],{'kind':'model','spaceId':model},presentation_styles=styles)
        self.assertEqual(next(iter(projection['draws'].values()))['visibility'],'hidden')
        self.assertTrue(all(row['visibility']=='hidden' for parts in styles.values() for row in parts))
        self.assertBrowser(result)

    def test_model_and_viewport_select_source_scale_and_source_position(self):
        doc=ezdxf.new('R2013');doc.styles.get('Standard').dxf.font='custom.ttf'
        item=doc.modelspace().add_text('A',dxfattribs={'height':1})
        scales=contexts(doc,item)
        vp=doc.layouts.get('Layout1').add_viewport(center=(20,20),size=(20,20),view_center_point=(0,0),view_height=40)
        vp.new_extension_dict().dictionary.add_xrecord('ASDK_XREC_ANNOTATION_SCALE_INFO').extend([(340,scales[0].dxf.handle)])
        result=convert(doc,{'custom.ttf':font_bytes()})
        self.assertEqual(result['snapshot']['completeness'],'complete')
        draw=next(iter(result['snapshot']['drawingProjection']['draws'].values()))
        points=[p for pts,_,_ in primitive_data(result,draw['displayRepresentationId']) for p in pts]
        self.assertAlmostEqual(min(p[0] for p in points),30)
        self.assertAlmostEqual(max(p[1] for p in points)-min(p[1] for p in points),4)
        viewport=next(iter(result['document']['drawing']['viewports'].values()))
        self.assertEqual(viewport['annotationScale'],1)
        projection=project_drawing(result['document'],{'kind':'layout','layoutId':viewport['layoutId']})
        paper=next(iter(projection['draws'].values()))
        points=[p for pts,_,_ in primitive_data(result,paper['displayRepresentationId']) for p in pts]
        self.assertAlmostEqual(min(p[0] for p in points),0)
        self.assertAlmostEqual(max(p[1] for p in points)-min(p[1] for p in points),1)
        self.assertBrowser(result)


if __name__=='__main__':unittest.main()
