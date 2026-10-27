"""Uploaded DWF/DGN bytes, not source-declared filesystem paths."""
import base64
import io
import unittest
import zipfile
import ezdgn
from PIL import Image
from test_fonts_layout_xref import ezdxf, convert, font_bytes
from unified import dxf_media


W2D = b'(DWF V00.55)\n(Color 255,0,0,255)\n(Polyline 3 0,0 100,0 100,50)\n(EndOfDWF)'


def dwfx():
    entries={
        '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="fpage" ContentType="application/vnd.ms-package.xps-fixedpage+xml"/><Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/><Default Extension="fdoc" ContentType="application/vnd.ms-package.xps-fixeddocument+xml"/></Types>',
        '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/Documents/FixedDocSeq.fdseq"/></Relationships>',
        'Documents/FixedDocSeq.fdseq':'<FixedDocumentSequence xmlns="http://schemas.microsoft.com/xps/2005/06"><DocumentReference Source="1/FixedDoc.fdoc"/></FixedDocumentSequence>',
        'Documents/1/FixedDoc.fdoc':'<FixedDocument xmlns="http://schemas.microsoft.com/xps/2005/06"><PageContent Source="Pages/1.fpage"/></FixedDocument>',
        'Documents/1/Pages/1.fpage':'<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="192" Height="96" xml:lang="en-US"><Path Data="M 0,0 L 192,0 L 192,96 Z" Fill="#FFFF0000"/></FixedPage>'}
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as archive:
        for name,text in entries.items():archive.writestr(name,text)
    return stream.getvalue()


class UnderlayTest(unittest.TestCase):
    def test_gouraud_uses_vertex_colors_instead_of_a_flat_average(self):
        from dataclasses import replace
        import ezdwf
        from ezdwf.document import EntityQuery,ColoredPoint,Point2D
        from unified import dxf_underlays
        sheet=ezdwf.read(W2D).modelspace();original=sheet.entities[0]
        colors=(ColoredPoint(Point2D(0,0),(255,0,0,255)),ColoredPoint(Point2D(100,0),(0,255,0,255)),ColoredPoint(Point2D(100,50),(0,0,255,255)))
        entity=replace(original,kind='GOURAUD_POLYTRIANGLE',colored_points=colors,points=())
        converted=dxf_underlays.vertex_colors(replace(sheet,entities=EntityQuery([entity])),8*1024*1024)
        image=converted.entities[0].image
        pixels=Image.frombytes('RGBA',(image.columns,image.rows),image.data)
        low=pixels.getpixel((int(image.columns*.9),int(image.rows*.9)))
        high=pixels.getpixel((int(image.columns*.9),int(image.rows*.2)))
        self.assertGreater(low[1],190);self.assertGreater(high[2],190)
        self.assertEqual(pixels.getpixel((100,100))[3],0)
        line=replace(entity,kind='GOURAUD_POLYLINE',colored_points=colors[:2])
        converted=dxf_underlays.vertex_colors(replace(sheet,entities=EntityQuery([line]),paper_bounds=(0,0,100,50)),8*1024*1024)
        self.assertEqual(converted.entities[0].style.stroke_brush.gradient_stops[0].color,(255,0,0,255))
        self.assertEqual(converted.entities[0].style.stroke_brush.gradient_stops[1].color,(0,255,0,255))

    def test_dwfx_fixed_page_uses_source_units_and_real_path_fill(self):
        doc=ezdxf.new('R2013');doc.units=1
        definition=doc.add_underlay_def('part.dwfx','dwf','1');doc.modelspace().add_underlay(definition)
        result=convert(doc,{'part.dwfx':dwfx()})
        row=next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'],'ready',row);self.assertEqual(row['details']['pageSizeInSourceUnits'],[2,1])
        with Image.open(io.BytesIO(base64.b64decode(result['bufferPayloads'][row['bufferId']]))) as pixels:
            self.assertEqual(pixels.getpixel((1800,200)),(255,0,0,255))
            self.assertEqual(pixels.getpixel((200,900))[3],0)
        self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_w2d_font_is_exact_uploaded_face_and_missing_face_is_explicit(self):
        raw=W2D.replace(b'(EndOfDWF)',b"(Font (Name 'UploadedTest') (Height 10))\n(Text 110,10 'A')\n(EndOfDWF)")
        doc=ezdxf.new('R2013');definition=doc.add_underlay_def('part.dwf','dwf','Model')
        doc.modelspace().add_underlay(definition)
        missing=convert(doc,{'part.dwf':raw})
        row=next(iter(missing['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'],'missing');self.assertIn('font-unresolved',row['reason'])
        loaded=convert(doc,{'part.dwf':raw,'original.ttf':font_bytes()})
        row=next(iter(loaded['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'],'ready',row)
        self.assertEqual(row['details']['uploadedFonts'],['original.ttf'])
        with Image.open(io.BytesIO(base64.b64decode(loaded['bufferPayloads'][row['bufferId']]))) as image:
            self.assertIsNotNone(image.getchannel('A').crop((int(image.width*.965),int(image.height*.66),image.width,int(image.height*.8))).getbbox())
        self.assertEqual(loaded['snapshot']['completeness'],'complete')
    def test_w2d_content_source_placement_and_clip_share_media_contract(self):
        doc = ezdxf.new('R2013'); doc.units = 0
        definition = doc.add_underlay_def('part.dwf', 'dwf', 'Model')
        item = doc.modelspace().add_underlay(definition, insert=(10, 20), scale=2, rotation=90)
        item.set_boundary_path([(0, 0), (.5, 0), (.5, .5), (0, .5)])
        item.dxf.flags |= 2
        result = convert(doc, {'part.dwf': W2D})
        row = next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'], 'ready', row)
        self.assertEqual(row['sourceRefs'][0]['objectKey'], item.dxf.handle)
        self.assertEqual(row['details']['sheetName'], 'Model')
        self.assertTrue(row['details']['clipping'])
        self.assertAlmostEqual(row['corners'][0][0], 9)
        self.assertAlmostEqual(row['corners'][0][1], 20)
        self.assertAlmostEqual(row['corners'][1][1], 22)
        self.assertEqual(result['snapshot']['completeness'], 'complete')

    def test_v7_source_line_not_control_polygon_or_guessed_font(self):
        source = ezdgn.new(); source.modelspace().add_line((0, 0), (10, 5), dgnattribs={'color': 3})
        doc = ezdxf.new('R2013'); doc.units = 0
        definition = doc.add_underlay_def('part.dgn', 'dgn', 'default')
        doc.modelspace().add_underlay(definition)
        result = convert(doc, {'part.dgn': source.to_bytes()})
        row = next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'], 'ready', row)
        self.assertEqual(row['details']['sourceEntityTypes'], {'LINE': 1})
        self.assertEqual(row['details']['sourceUnits'], 'ft')

    def test_truncated_stream_is_missing_instead_of_successful_prefix(self):
        doc = ezdxf.new('R2013')
        definition = doc.add_underlay_def('part.dwf', 'dwf', 'Model')
        doc.modelspace().add_underlay(definition)
        result = convert(doc, {'part.dwf': W2D.replace(b'(EndOfDWF)', b'L 2 0,0')})
        row = next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'], 'missing', row)
        self.assertIn('W2D', row['reason'])
        self.assertEqual(result['snapshot']['completeness'], 'partial')

    def test_unknown_dgn_record_cannot_publish_a_successful_line_prefix(self):
        source=ezdgn.new();source.modelspace().add_line((0,0),(10,5))
        source.modelspace().add_text('A',(2,2))
        doc=ezdxf.new('R2013');definition=doc.add_underlay_def('part.dgn','dgn','default')
        doc.modelspace().add_underlay(definition)
        result=convert(doc,{'part.dgn':source.to_bytes()})
        row=next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'],'missing',row);self.assertIn('TEXT',row['reason'])
        self.assertEqual(result['snapshot']['completeness'],'partial')


if __name__ == '__main__': unittest.main()
