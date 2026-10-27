import unittest
from test_fonts_layout_xref import ezdxf, convert, font_bytes
from unified import dxf_fields, dxf_mtext


class FieldsTest(unittest.TestCase):
    def test_nested_formula_format_and_declared_object_reference(self):
        source={'header':{'$LTSCALE':2},'objects':{'AF':{'type':'LINE','attributes':{'start':[0,0,0],'end':[3,4,0]}}}}
        text=r'%<\AcExpr (2 + %<\AcVar LTSCALE>%) * 3 \f "%lu2%pr2%ps[, mm]">%'
        self.assertEqual(dxf_fields.expand(text,source),'12.00 mm')
        code=r'\AcObjProp Object(%<\_ObjIdx 0>%).Length \f "%lu2%pr1"'
        self.assertEqual(dxf_fields.evaluate(code,source,current={'tags':[[331,'AF']]}),'5.0')
        with self.assertRaisesRegex(ValueError,'reference-unresolved'):
            dxf_fields.evaluate(code.replace('_ObjIdx','_ObjId'),source,current={'tags':[[331,'AF']]})

    def test_arbitrary_operations_and_unknown_variables_do_not_become_zero(self):
        for text in ('__import__("os")','2**2000','1/0','x.y','[1,2]'):
            with self.assertRaises((ValueError,TypeError)):
                dxf_fields.arithmetic(text)
        with self.assertRaisesRegex(ValueError,'unsupported'):
            dxf_fields.expand(r'%<\AcVar UNKNOWN>%',{'header':{}})

    def test_inline_document_field_uses_uploaded_font_and_shared_layout(self):
        doc=ezdxf.new('R2013');doc.header.custom_vars.append('Part','A')
        doc.styles.get('Standard').dxf.font='custom.ttf'
        doc.modelspace().add_mtext(r'%<\AcDocProp CustomDP.Part>%',dxfattribs={'char_height':2})
        result=convert(doc,{'custom.ttf':font_bytes()})
        row=next(iter(result['document']['extensions'][dxf_mtext.EXTENSION]['items'].values()))
        self.assertEqual(row['displayText'],'A')
        self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_text_and_block_attribute_use_the_same_field_policy(self):
        doc=ezdxf.new('R2013');doc.styles.get('Standard').dxf.font='custom.ttf'
        doc.modelspace().add_text(r'%<\AcExpr 2+3>%',dxfattribs={'height':1})
        block=doc.blocks.new('Part');block.add_attdef('SIZE',(0,0))
        insert=doc.modelspace().add_blockref('Part',(10,0))
        insert.add_attrib('SIZE',r'%<\AcExpr 3*4>%')
        result=convert(doc,{'custom.ttf':font_bytes()})
        rows=result['document']['extensions'][dxf_mtext.EXTENSION]['items'].values()
        self.assertEqual({row['displayText'] for row in rows},{'5','12'})
        self.assertEqual(result['snapshot']['completeness'],'complete')


if __name__=='__main__': unittest.main()
