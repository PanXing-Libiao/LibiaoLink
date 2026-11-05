import struct
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.dwg_buffers import compact_display_buffers


def document(count):
    return {'accessors':{'a-line':{'bufferId':'buffer-0','byteOffset':0,'byteLength':count*24,
        'component':'f64','components':3,'count':count,'normalized':False}},
        'geometries':{'g-line':{'attributes':{'POSITION':'a-line'},
            'primitives':[{'id':'p','topology':'lines','range':{'first':0,'count':count}}]}}}


class DwgBuffersTest(unittest.TestCase):
    def test_indexing_preserves_exact_endpoint_bytes_and_order(self):
        points=[(0.,0.,0.),(1.,2.,3.),(1.,2.,3.),(-0.,0.,0.)]*6
        raw=b''.join(struct.pack('<3d',*p) for p in points)
        doc=document(len(points));packed,stats=compact_display_buffers(doc,raw)
        primitive=doc['geometries']['g-line']['primitives'][0]
        index=doc['accessors'][primitive['indices']];position=doc['accessors']['a-line']
        values=struct.unpack_from('<'+str(index['count'])+'I',packed,index['byteOffset'])
        rebuilt=b''.join(packed[position['byteOffset']+i*24:position['byteOffset']+(i+1)*24] for i in values)
        self.assertEqual(raw,rebuilt)
        self.assertLess(len(packed),len(raw))
        self.assertEqual(position['count'],3)  # signed zero stays byte-distinct
        self.assertEqual(stats['indexedGeometries'],1)

    def test_unique_vertices_stay_unindexed(self):
        raw=b''.join(struct.pack('<3d',i,i+1,i+2) for i in range(12))
        doc=document(12);packed,stats=compact_display_buffers(doc,raw)
        self.assertEqual(packed,raw)
        self.assertNotIn('indices',doc['geometries']['g-line']['primitives'][0])
        self.assertEqual(stats['indexedGeometries'],0)

    def test_existing_indexed_geometry_keeps_its_topology(self):
        raw=b''.join(struct.pack('<3d',i,i+1,i+2) for i in range(12))+struct.pack('<2I',1,0)
        doc=document(12);doc['accessors']['i-line']={'bufferId':'buffer-0','byteOffset':288,
            'byteLength':8,'component':'u32','components':1,'count':2,'normalized':False}
        primitive=doc['geometries']['g-line']['primitives'][0]
        primitive['indices']='i-line';primitive['range']['count']=2
        packed,stats=compact_display_buffers(doc,raw)
        self.assertEqual(packed,raw)
        self.assertEqual(primitive['range']['count'],2)
        self.assertEqual(stats['indexedGeometries'],0)

if __name__=='__main__':unittest.main()
