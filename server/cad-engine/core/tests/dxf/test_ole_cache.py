"""Real CFB/DIB bytes through the same media contract as uploaded rasters."""
import io
import struct
import unittest
from PIL import Image
from ezdxf.entities import factory
from ezdxf.lldxf.tags import Tags
from ezdxf.lldxf.types import DXFTag, DXFVertex, DXFBinaryTag
from test_fonts_layout_xref import ezdxf,convert,raw_doc
from unified import dxf_ole,dxf_media


def compound(stream):
    # Small valid CFB v3: FAT sector, directory sector, 8 regular data sectors.
    stream=stream.ljust(4096,b'\0');header=bytearray(512)
    header[:8]=dxf_ole.SIGNATURE
    struct.pack_into('<6H',header,24,0x3e,3,0xfffe,9,6,0)
    struct.pack_into('<9L',header,40,0,1,1,0,4096,0xfffffffe,0,0xfffffffe,0)
    struct.pack_into('<109L',header,76,0,*([0xffffffff]*108))
    fat=[0xfffffffd,0xfffffffe,*range(3,10),0xfffffffe]+[0xffffffff]*118
    directory=bytearray(512)
    for offset,name,kind,child,start,size in ((0,'Root Entry',5,1,0xfffffffe,0),(128,'\x02OlePres000',2,0xffffffff,2,len(stream))):
        encoded=(name+'\0').encode('utf-16le');directory[offset:offset+len(encoded)]=encoded
        struct.pack_into('<HBB3L',directory,offset+64,len(encoded),kind,1,0xffffffff,0xffffffff,child)
        struct.pack_into('<LQ',directory,offset+116,start,size)
    return bytes(header)+struct.pack('<128L',*fat)+bytes(directory)+stream


def payload():
    image=Image.new('RGB',(2,2),(255,0,0));output=io.BytesIO();image.save(output,'BMP')
    dib=output.getvalue()[14:]
    return compound(struct.pack('<10L',0xffffffff,8,4,1,0xffffffff,2,0,2,2,len(dib))+dib)


def ole(doc,data):
    entity=factory.new('OLE2FRAME',doc=doc)
    entity.acdb_ole2frame=Tags([DXFTag(100,'AcDbOle2Frame'),DXFTag(70,2),
        DXFVertex(10,(10,20,0)),DXFVertex(11,(14,16,0)),DXFTag(90,len(data)),
        *[DXFBinaryTag(310,data[i:i+127]) for i in range(0,len(data),127)]])
    doc.modelspace().add_entity(entity)
    return entity


class OleCacheTest(unittest.TestCase):
    def test_xref_cached_ole_has_original_source_and_common_block_transform(self):
        from ezdxf import xref
        child=ezdxf.new('R2013');item=ole(child,payload())
        host=ezdxf.new('R2013');xref.attach(host,block_name='Child',filename='child.dxf',insert=(30,40))
        result=convert(host,{'child.dxf':raw_doc(child)})
        row=next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(row['status'],'ready',row)
        self.assertEqual(row['sourceRefs'][0]['objectKey'],item.dxf.handle)
        draw=next(iter(result['snapshot']['drawingProjection']['draws'].values()))
        self.assertEqual(draw['localToSpace'][12:14],[30,40])
        self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_saved_content_bitmap_has_source_identity_and_top_down_placement(self):
        doc=ezdxf.new('R2013');item=ole(doc,payload());result=convert(doc)
        media=next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
        self.assertEqual(media['status'],'ready',media)
        self.assertEqual(media['corners'],[[10,20,0],[14,20,0],[14,16,0],[10,16,0]])
        self.assertEqual(media['sourceRefs'][0]['objectKey'],item.dxf.handle)
        self.assertEqual(result['snapshot']['completeness'],'complete')

    def test_missing_or_broken_embedded_cache_is_explicit(self):
        for data in (b'bad',payload()[:1024]):
            doc=ezdxf.new('R2013');ole(doc,data);result=convert(doc)
            row=next(iter(result['document']['extensions'][dxf_media.EXTENSION]['items'].values()))
            self.assertEqual(row['status'],'missing')
            self.assertEqual(result['snapshot']['completeness'],'partial')


if __name__=='__main__':unittest.main()
