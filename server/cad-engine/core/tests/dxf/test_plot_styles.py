import io
import struct
import unittest
import zlib
from ezdxf.addons import acadctb
from test_fonts_layout_xref import ezdxf,convert
from test_linetype_presentations import triangle_hit
from unified import dxf_plotstyles


def binary(table):
    # PIA's fixed little-endian 12-byte size/checksum header. The pinned
    # upstream writer uses native unsigned long sizes and is not used here.
    output=io.StringIO();table.write_content(output);text=output.getvalue().encode()+b'\0'
    body=zlib.compress(text)
    return b'PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec'+struct.pack('<3L',zlib.adler32(body),len(text),len(body))+body


class PlotStyleTest(unittest.TestCase):
    def test_failed_pen_geometry_is_partial_only_when_source_display_requires_it(self):
        from unittest.mock import patch
        doc=ezdxf.new('R2013');layout=doc.layouts.get('Model');layout.dxf.current_style_sheet='own.ctb'
        layout.dxf.plot_paper_units=1;layout.dxf.scale_numerator=layout.dxf.scale_denominator=1
        doc.modelspace().add_line((0,0),(100,0),dxfattribs={'color':1})
        table=acadctb.new_ctb();table[1].linetype=1;table[1].adaptive_linetype=False
        for enabled in (False,True):
            layout.dxf.plot_layout_flags=layout.dxf.plot_layout_flags|2 if enabled else layout.dxf.plot_layout_flags&~2
            with patch('unified.dxf_adapter.MAX_PATTERN_SEGMENTS',1):result=convert(doc,{'own.ctb':binary(table)})
            coverage=result['document']['extensions'][dxf_plotstyles.EXTENSION]['coverage']
            self.assertEqual(coverage['status'],'partial' if enabled else 'complete')
            self.assertEqual(result['snapshot']['completeness'],'partial' if enabled else 'complete')

    def test_source_enabled_missing_table_is_partial_and_viewport_aci_selects_pen(self):
        doc=ezdxf.new('R2013');layout=doc.layouts.get('Layout1')
        layout.dxf.current_style_sheet='source.ctb';layout.dxf.plot_layout_flags|=2
        doc.layers.new('Ink',dxfattribs={'color':1})
        doc.modelspace().add_line((0,0),(10,0),dxfattribs={'layer':'Ink'})
        vp=layout.add_viewport(center=(10,10),size=(20,20),view_center_point=(5,0),view_height=20)
        overrides=doc.layers.get('Ink').get_vp_overrides();overrides.set_color(vp.dxf.handle,3);overrides.commit()
        missing=convert(doc)
        self.assertEqual(missing['snapshot']['completeness'],'partial')
        table=acadctb.new_ctb();table[1].color=(255,0,0);table[3].color=(0,0,255)
        result=convert(doc,{'source.ctb':binary(table)})
        ext=result['document']['extensions'][dxf_plotstyles.EXTENSION]
        pens=[entry['root'] for context,rows in ext['resolved'].items() if context!='model' for entry in rows.values()]
        self.assertEqual(pens[0]['selector'],'3');self.assertEqual(pens[0]['style']['color'],[0,0,255])
        self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_ctb_bakes_fixed_paper_dash_with_original_wide_path(self):
        doc=ezdxf.new('R2013');doc.layouts.get('Model').dxf.current_style_sheet='own.ctb'
        doc.modelspace().add_lwpolyline([(0,0),(20,0)],dxfattribs={'const_width':1,'color':1})
        table=acadctb.new_ctb();table[1].color=(0,0,0);table[1].screen=50
        table[1].linetype=1;table[1].adaptive_linetype=False;table[1].set_lineweight(.7)
        result=convert(doc,{'own.ctb':binary(table)})
        extension=result['document']['extensions'][dxf_plotstyles.EXTENSION]
        self.assertEqual(extension['layouts']['model']['status'],'ready',extension['layouts'])
        draw_id,draw=next(iter(result['snapshot']['drawingProjection']['draws'].items()))
        pen=extension['resolved']['model'][draw_id]['root']['style']
        self.assertEqual(pen['color'],[0,0,0]);self.assertEqual(pen['screening'],50)
        part=next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))['parts'][0]
        variant=part['plotVariants']['model'][draw_id]
        self.assertEqual(variant['status'],'ready',variant)
        custom={**draw,'displayRepresentationId':variant['parts'][0]['representationId']}
        self.assertTrue(triangle_hit(result,custom,(1,0)))
        self.assertFalse(triangle_hit(result,custom,(5,0)))
        self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_named_styles_decode_and_byblock_selection_uses_original_name(self):
        doc=ezdxf.new('R2013');doc.header['$PSTYLEMODE']=0
        doc.layouts.get('Model').dxf.current_style_sheet='own.stb'
        table=acadctb.new_stb();style=table.new_style('Heavy');style.color=(0,0,255);style.set_lineweight(.9)
        placeholder=doc.objects.new_entity('ACDBPLACEHOLDER',dxfattribs={'owner':doc.plotstyles.dxf.handle})
        doc.plotstyles['Heavy']=placeholder
        block=doc.blocks.new('Part');block.add_line((0,0),(10,0),dxfattribs={'plotstyle_enum':1})
        doc.modelspace().add_blockref('Part',(0,0),dxfattribs={'plotstyle_enum':3,'plotstyle_handle':placeholder.dxf.handle})
        result=convert(doc,{'own.stb':binary(table)})
        ext=result['document']['extensions'][dxf_plotstyles.EXTENSION]
        self.assertEqual(ext['layouts']['model']['status'],'ready',ext['layouts'])
        row=next(iter(ext['resolved']['model'].values()))['root']
        self.assertEqual(row['selector'],'Heavy');self.assertEqual(row['style']['color'],[0,0,255])

    def test_missing_declared_table_is_reported_without_changing_normal_source_geometry(self):
        doc=ezdxf.new('R2013');doc.layouts.get('Model').dxf.current_style_sheet='missing.ctb'
        doc.modelspace().add_line((0,0),(1,0));result=convert(doc)
        ext=result['document']['extensions'][dxf_plotstyles.EXTENSION]
        self.assertEqual(ext['layouts']['model']['status'],'missing')
        self.assertEqual(result['snapshot']['completeness'],'complete')
        with self.assertRaisesRegex(ValueError,'decompression'):
            dxf_plotstyles.read(binary(acadctb.new_ctb())[:70],'ctb')


if __name__=='__main__':unittest.main()
