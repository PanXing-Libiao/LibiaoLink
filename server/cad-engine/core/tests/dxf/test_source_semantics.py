"""Source properties stay source facts, including graph cycles and xref identities."""
import unittest
from test_fonts_layout_xref import ezdxf, convert, raw_doc
from test_wide_polylines import source_entity
from unified import dxf_semantics


class SourceSemanticsTest(unittest.TestCase):
    def test_source_tag_budget_loss_is_separate_from_complete_geometry(self):
        from unittest.mock import patch
        doc=ezdxf.new('R2013');doc.modelspace().add_line((0,0),(3,4))
        with patch.object(dxf_semantics,'MAX_TAGS',1):result=convert(doc)
        coverage=result['document']['extensions']['org.cad-preview.drawing-coverage/1']
        self.assertEqual(coverage['displayGeometry']['status'],'complete')
        self.assertEqual(coverage['sourceFacts']['status'],'partial')
        self.assertEqual(result['snapshot']['completeness'],'partial')
        self.assertTrue(any(row['code']=='dxf-source-facts-partial' for row in result['snapshot']['diagnostics']))

    def test_reader_repairs_do_not_replace_declared_layer_or_dictionary_facts(self):
        from pathlib import Path
        from unified.dxf_adapter import read_dxf
        doc=ezdxf.new('R2013');doc.modelspace().add_line((0,0),(3,4))
        layer=doc.layers.get('Defpoints');layer.dxf.plot=1
        del doc.rootdict['ACAD_MATERIAL']
        result=read_dxf(Path('original.dxf'),raw_doc(doc))
        facts=next(iter(result['document']['extensions'][dxf_semantics.EXTENSION]['sources'].values()))
        # plot=1 is the source default and is omitted by the writer. Loading
        # repairs Defpoints to explicit plot=0; it is not an authored value.
        self.assertNotIn('plot',facts['objects'][layer.dxf.handle]['attributes'])
        self.assertNotIn('ACAD_MATERIAL',facts['objects'][doc.rootdict.dxf.handle]['entries'])

    def test_source_header_and_revision_do_not_acquire_reader_clock_or_guids(self):
        import io
        from datetime import datetime
        from pathlib import Path
        from unittest.mock import patch
        from unified.dxf_adapter import read_dxf
        doc=ezdxf.new('R2013');doc.modelspace().add_line((0,0),(3,4))
        doc.header['$TDCREATE']=2450000.5
        zero='{00000000-0000-0000-0000-000000000000}'
        doc.header['$FINGERPRINTGUID']=zero
        doc.header['$INSBASE']=(3,4,5)
        doc.header.custom_vars.append('Part','P-123')
        for binary in (False,True):
            stream=io.BytesIO() if binary else io.StringIO()
            doc.write(stream,fmt='bin' if binary else 'asc')
            raw=stream.getvalue() if binary else stream.getvalue().encode('utf-8')
            results=[]
            for moment in (datetime(2024,1,1),datetime(2026,1,1)):
                with patch('ezdxf.document.datetime') as clock:
                    clock.now.return_value=moment
                    results.append(read_dxf(Path('original.dxf'),raw))
            self.assertEqual(results[0]['document']['revision'],results[1]['document']['revision'])
            facts=next(iter(results[0]['document']['extensions'][dxf_semantics.EXTENSION]['sources'].values()))
            self.assertEqual(facts['header']['$TDCREATE'],2450000.5)
            self.assertEqual(facts['header']['$FINGERPRINTGUID'],zero)
            self.assertEqual(facts['header']['$INSBASE'],[3,4,5])
            self.assertEqual(facts['customProperties'],[['Part','P-123']])

    def test_r12_reader_management_records_are_not_claimed_as_source_objects(self):
        from pathlib import Path
        from unified.dxf_adapter import read_dxf
        doc=ezdxf.new('R12');doc.modelspace().add_line((0,0),(3,4))
        result=read_dxf(Path('r12-bytes.dxf'),raw_doc(doc))
        facts=next(iter(result['document']['extensions'][dxf_semantics.EXTENSION]['sources'].values()))
        self.assertNotIn('BLOCK_RECORD',{row['type'] for row in facts['objects'].values()})
        self.assertEqual(result['document']['sources'][0]['detectedVersion'],'AC1009')
    def test_parsed_facts_and_geometry_come_from_the_hashed_bytes(self):
        import tempfile
        from pathlib import Path
        from unified.dxf_adapter import read_dxf
        from test_fonts_layout_xref import raw_doc
        original=ezdxf.new('R2013');original.modelspace().add_line((0,0),(3,4))
        replacement=ezdxf.new('R2013');replacement.modelspace().add_circle((0,0),99)
        raw=raw_doc(original)
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'replaced.dxf';path.write_bytes(raw_doc(replacement))
            result=read_dxf(path,raw)
        kinds={row['type'] for row in next(iter(result['document']['extensions'][dxf_semantics.EXTENSION]['sources'].values()))['objects'].values()}
        self.assertIn('LINE',kinds);self.assertNotIn('CIRCLE',kinds)

    def test_crlf_and_cr_keep_the_source_version_and_model_records(self):
        from pathlib import Path
        from unified.dxf_adapter import read_dxf
        doc=ezdxf.new('R2000');doc.modelspace().add_line((0,0),(3,4))
        for newline in (b'\r\n',b'\r'):
            raw=raw_doc(doc).replace(b'\n',newline)
            result=read_dxf(Path('not-reopened.dxf'),raw)
            self.assertEqual(result['document']['sources'][0]['detectedVersion'],'AC1015')
            self.assertEqual(len(result['document']['drawing']['entities']),1)
    def test_dimension_custom_properties_and_dictionary_cycle_are_retained(self):
        doc = ezdxf.new('R2013')
        doc.header.custom_vars.append('Part', 'P-123')
        line = doc.modelspace().add_line((0,0), (10,0))
        line.set_xdata('APP', [(1000,'Part'), (1040,2.5), (1005,line.dxf.handle)])
        dictionary = line.new_extension_dict().dictionary
        dictionary['self'] = dictionary
        dictionary.add_xrecord('Info').extend([(1,'serial'), (90,12)])
        dimension = doc.modelspace().add_linear_dim(base=(0,2), p1=(0,0), p2=(10,0))
        dimension.render()
        dimension.dimension.dxf.actual_measurement = 10
        result = convert(doc)
        extension = result['document']['extensions'][dxf_semantics.EXTENSION]
        source = extension['sources'][result['document']['sources'][0]['id']]
        facts = source['objects'][line.dxf.handle]
        self.assertEqual(facts['xdata']['APP'][1], [1040,2.5])
        self.assertEqual(source['objects'][dictionary.dxf.handle]['entries']['self'], dictionary.dxf.handle)
        self.assertEqual(source['customProperties'], [['Part','P-123']])
        self.assertEqual(source['objects'][dimension.dimension.dxf.handle]['attributes']['actual_measurement'],10)
        self.assertEqual(extension['policy']['measurement'], 'source-declared; no geometry-derived inspection result')

    def test_xref_facts_are_captured_before_handle_remapping(self):
        from ezdxf import xref
        child = ezdxf.new('R2013')
        line = child.modelspace().add_line((0,0), (4,0))
        line.set_xdata('APP', [(1000,'child')])
        host = ezdxf.new('R2013')
        xref.attach(host, block_name='Part', filename='part.dxf', insert=(20,0))
        result = convert(host, {'part.dxf':raw_doc(child)})
        ext = result['document']['extensions'][dxf_semantics.EXTENSION]
        item = next(item for item in result['document']['drawing']['entities'].values() if item['geometry']['type']=='line')
        ref = item['sourceRefs'][0]
        self.assertEqual(ext['sources'][ref['sourceId']]['objects'][ref['objectKey']]['xdata']['APP'], [[1000,'child']])


if __name__ == '__main__': unittest.main()
