import unittest
from ezdxf.entities import factory
from ezdxf.lldxf.extendedtags import ExtendedTags
from test_fonts_layout_xref import ezdxf,convert
from test_linetype_presentations import primitive_data


class TablePoseTest(unittest.TestCase):
    def test_native_saved_table_block_has_priority_over_its_proxy_cache(self):
        from unified.dxf_annotations import primitives
        import struct
        doc=ezdxf.new('R2013');doc.blocks.new('*T1').add_line((0,0),(5,0))
        tags=ExtendedTags.from_text('0\nACAD_TABLE\n100\nAcDbEntity\n8\n0\n100\nAcDbBlockReference\n2\n*T1\n10\n10\n20\n20\n30\n0\n100\nAcDbTable\n280\n0\n11\n1\n21\n0\n31\n0\n')
        item=factory.load(tags,doc);doc.modelspace().add_entity(item)
        item.proxy_graphic=bytes(8)+struct.pack('<2L',8,51)
        leaves=list(primitives(item,doc))
        self.assertEqual(len(leaves),1);self.assertEqual(leaves[0][0].dxftype(),'LINE')
        self.assertEqual(tuple(leaves[0][0].dxf.start),(10,20,0))

    def test_saved_cell_block_uses_header_direction_and_source_plane(self):
        for normal,direction,expected in (('0\n230\n1','0\n21\n1\n31\n0',[(10,20,0),(10,25,0)]),
                                           ('1\n230\n0','0\n21\n0\n31\n1',[(10,20,0),(10,20,5)])):
            doc=ezdxf.new('R2013');doc.blocks.new('*T1').add_line((0,0),(5,0))
            tags=ExtendedTags.from_text('0\nACAD_TABLE\n100\nAcDbEntity\n8\n0\n100\nAcDbBlockReference\n2\n*T1\n10\n10\n20\n20\n30\n0\n100\nAcDbTable\n280\n0\n210\n0\n220\n'+normal+'\n11\n'+direction+'\n')
            doc.modelspace().add_entity(factory.load(tags,doc));result=convert(doc)
            entry=next(row for row in result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values() if row['sourceKind']=='ACAD_TABLE')
            self.assertEqual(entry['status'],'ready',entry)
            points=[tuple(p) for pts,_,_ in primitive_data(result,entry['parts'][0]['representationId']) for p in pts]
            self.assertEqual(points,expected)


if __name__=='__main__':unittest.main()
