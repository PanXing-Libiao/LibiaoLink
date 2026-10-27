"""Proxy pictures retain the original source identity and fail atomically."""
import struct
import unittest

from test_fonts_layout_xref import ezdxf, convert, font_bytes, raw_doc
from test_wide_polylines import source_entity, mesh
from ezdxf.entities import factory
from ezdxf.lldxf.tags import Tags
from unified import dxf_proxy, dxf_shx


def command(code, data=b''):
    return struct.pack('<2L', len(data) + 8, code) + data


def padded(value):
    value += b'\0'
    return value + bytes((-len(value)) % 4)


def proxy(doc, commands):
    data = bytes(8) + b''.join(commands)
    item = factory.new('ACAD_PROXY_ENTITY', doc=doc)
    item.acdb_proxy_entity = Tags.from_text('100\nAcDbProxyEntity\n90\n498\n91\n500\n160\n' + str(len(data)) + '\n')
    for offset in range(0, len(data), 127):
        item.acdb_proxy_entity.extend(Tags.from_text('310\n' + data[offset:offset+127].hex() + '\n'))
    item.proxy_graphic = data
    doc.modelspace().add_entity(item)
    return item


class ProxyGraphicsTest(unittest.TestCase):
    def test_proxy_filled_polygon_declares_solid_fill_without_factory_defaults(self):
        doc=ezdxf.new('R2013')
        item=proxy(doc,[command(20,struct.pack('<L',1)),command(7,struct.pack('<L12d',4,0,0,0,4,0,0,4,4,0,0,4,0))])
        result=convert(doc)
        entry=next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
        self.assertEqual(entry['status'],'ready',entry)
        self.assertEqual(result['snapshot']['completeness'],'complete')
        self.assertTrue(entry['parts'])
        representation=result['document']['representations'][entry['parts'][0]['representationId']]
        geometry=result['document']['geometries'][representation['bindings'][0]['geometryId']]
        self.assertEqual(geometry['primitives'][0]['topology'],'triangles')

    def test_native_text_percent_decorations_keep_their_authored_spans(self):
        from unified.dxf_annotations import text_geometry
        from unified.dxf_xref import load_references
        doc=ezdxf.new('R2013');doc.styles.get('Standard').dxf.font='custom.ttf'
        item=doc.modelspace().add_text('%%uA%%uA',dxfattribs={'height':1})
        refs=[{'sourceId':'source-test','objectKey':item.dxf.handle}]
        resources=dxf_shx.Resources(doc,load_references(doc,raw_doc(doc),'main.dxf',{}),{'custom.ttf':font_bytes()})
        points,indices,topology,_=text_geometry(item,resources,refs)
        bottom=[p for p in points if p[1]<0]
        self.assertEqual(topology,'triangles');self.assertTrue(bottom)
        self.assertLess(max(p[0] for p in bottom),max(p[0] for p in points))
        self.assertEqual(item.dxf.text,'%%uA%%uA')

    def test_proxy_tracking_and_decorations_are_not_ignored_by_upstream(self):
        def converted(tracking,underline,overline):
            doc=ezdxf.new('R2013')
            data=struct.pack('<9d',0,0,0,0,0,1,1,0,0)+padded(b'AA')
            data+=struct.pack('<2l4d5L',2,0,1,1,0,tracking,0,0,0,underline,overline)
            data+=padded(b'custom.ttf')+padded(b'')
            item=proxy(doc,[command(11,data)]);result=convert(doc,{'custom.ttf':font_bytes()})
            source=source_entity(result,item.dxf.handle);geometry,_,_=mesh(result,source)
            self.assertEqual(result['snapshot']['completeness'],'complete')
            return geometry['bounds']
        plain=converted(100,0,0);spaced=converted(200,0,0);decorated=converted(100,1,1)
        self.assertGreater(spaced['max'][0],plain['max'][0])
        self.assertLess(decorated['min'][1],plain['min'][1])
        self.assertGreater(decorated['max'][1],plain['max'][1])

    def test_proxy_clips_use_their_own_stack_and_compound_transform(self):
        doc=ezdxf.new('R2013')
        identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        inverse=[1,0,0,-10,0,1,0,-20,0,0,1,0,0,0,0,1]
        forward=[1,0,0,10,0,1,0,20,0,0,1,0,0,0,0,1]
        clip=struct.pack('<6dL4d32d2L2dL',0,0,1,0,0,0,2,-1,-1,1,1,*identity,*inverse,0,0,0,0,0)
        item=proxy(doc,[command(29,struct.pack('<16d',*forward)),command(27,clip),
            command(2,struct.pack('<7d',0,0,0,2,0,0,1)),command(31),command(28)])
        result=convert(doc)
        entry=next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
        self.assertEqual(entry['status'],'ready',entry)
        self.assertEqual(entry['parts'][0]['clipRegions'],[{'boundary':[[9,19],[11,19],[11,21],[9,21]],'inverted':False}])
        self.assertEqual(result['snapshot']['completeness'],'complete')
        doc=ezdxf.new('R2013');proxy(doc,[command(27,clip),command(2,struct.pack('<7d',0,0,0,2,0,0,1))])
        broken=convert(doc)
        entry=next(iter(broken['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
        self.assertEqual(entry['status'],'missing');self.assertEqual(entry['parts'],[])

    def test_nested_matrix2_composes_and_restores_the_parent(self):
        doc=ezdxf.new('R2013')
        def matrix(x,y): return struct.pack('<16d',1,0,0,x,0,1,0,y,0,0,1,0,0,0,0,1)
        item=proxy(doc,[command(29,matrix(10,20)),command(30,matrix(3,4)),
            command(2,struct.pack('<7d',0,0,0,1,0,0,1)), command(31),command(31)])
        result=convert(doc);source=source_entity(result,item.dxf.handle)
        geometry,_,_=mesh(result,source)
        self.assertAlmostEqual(geometry['bounds']['min'][0],12,delta=.003)
        self.assertAlmostEqual(geometry['bounds']['max'][1],25,delta=.003)

    def test_xref_proxy_keeps_source_layer_index_and_identity(self):
        from ezdxf import xref
        child=ezdxf.new('R2013');child.layers.new('Source',dxfattribs={'color':1})
        index=next(i for i,e in enumerate(child.layers) if e.dxf.name=='Source')
        item=proxy(child,[command(16,struct.pack('<L',index)),command(2,struct.pack('<7d',0,0,0,1,0,0,1))])
        host=ezdxf.new('R2013');host.layers.new('Host',dxfattribs={'color':3})
        xref.attach(host,block_name='Part',filename='part.dxf',insert=(10,20))
        result=convert(host,{'part.dxf':raw_doc(child)})
        self.assertEqual(result['snapshot']['completeness'],'complete')
        entry=next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
        self.assertEqual(entry['sourceKind'],'ACAD_PROXY_ENTITY')
        self.assertEqual(entry['sourceRefs'][0]['objectKey'],item.dxf.handle)
        part=entry['parts'][0]
        layer=result['document']['drawing']['layers'][part['layerId']]
        self.assertEqual(layer['name'],'Part|Source')
        self.assertEqual(result['document']['extensions']['org.cad-preview.dxf-xref/1']['copyFailures'],[])

    def test_embedded_font_name_has_proxy_provenance_without_a_fake_source_style(self):
        doc = ezdxf.new('R2013')
        doc.styles.new('custom.ttf', dxfattribs={'font':'other.ttf'})
        data = struct.pack('<9d', 0,0,0, 0,0,1, 1,0,0) + padded(b'A')
        data += struct.pack('<2l4d5L', 1,0, 1,1,0,100, 0,0,0,0,0)
        data += padded(b'custom.ttf') + padded(b'')
        item = proxy(doc, [command(11, data)])
        repeated = proxy(doc, [command(11, data)])
        result = convert(doc, {'custom.ttf': font_bytes()})
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        source_entity(result, item.dxf.handle)
        refs = result['document']['extensions'][dxf_shx.EXTENSION]['references']
        self.assertTrue(any(ref.get('objectKey') == item.dxf.handle for row in refs for ref in row['sourceRefs']))
        self.assertTrue(any(ref.get('objectKey') == repeated.dxf.handle for row in refs for ref in row['sourceRefs']))

    def test_invalid_unicode_is_atomic_even_after_a_valid_circle(self):
        doc = ezdxf.new('R2013')
        invalid = struct.pack('<12d', 0,0,0, 0,0,1, 1,0,0, 1,1,0) + b'\x00\xd8\0\0'
        proxy(doc, [command(2, struct.pack('<7d', 5,7,0,2,0,0,1)), command(36, invalid)])
        result = convert(doc, {'txt.shx': b'bad'})
        entry = next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
        self.assertEqual(entry['status'], 'missing')
        self.assertEqual(entry['parts'], [])

    def test_circle_is_displayed_under_the_proxy_identity(self):
        doc = ezdxf.new('R2013')
        item = proxy(doc, [command(2, struct.pack('<7d', 5, 7, 0, 2, 0, 0, 1))])
        result = convert(doc)
        source = source_entity(result, item.dxf.handle)
        geometry, _, _ = mesh(result, source)
        for key, expected in (('min', [3, 5, 0]), ('max', [7, 9, 0])):
            for actual, target in zip(geometry['bounds'][key], expected):
                self.assertAlmostEqual(actual, target, delta=.003)
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        self.assertEqual(len(result['document']['drawing']['entities']), 1)

    def test_valid_prefix_never_hides_an_unknown_or_broken_command(self):
        for tail in (command(999), struct.pack('<2L', 9999, 2), b'bad'):
            doc = ezdxf.new('R2013')
            item = proxy(doc, [command(2, struct.pack('<7d', 5, 7, 0, 2, 0, 0, 1)), tail])
            result = convert(doc)
            entry = next(iter(result['document']['extensions']['org.cad-preview.annotation-presentation/1']['items'].values()))
            self.assertEqual(entry['status'], 'missing')
            self.assertEqual(entry['parts'], [])
            self.assertEqual(result['snapshot']['completeness'], 'partial')
            self.assertEqual(next(iter(result['snapshot']['drawingProjection']['draws'].values()))['availability'], 'unsupported')

    def test_missing_stream_and_matrix_underflow_are_explicit(self):
        doc = ezdxf.new('R2013')
        item = proxy(doc, [command(31)])
        with self.assertRaisesRegex(ValueError, 'underflow'):
            list(dxf_proxy.primitives(item, doc))
        item.proxy_graphic = None
        with self.assertRaisesRegex(ValueError, 'not-stored'):
            list(dxf_proxy.primitives(item, doc))


if __name__ == '__main__': unittest.main()
