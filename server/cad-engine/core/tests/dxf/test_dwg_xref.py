"""The chosen DWG bytes, not a same-name DXF or stale block, own XREF geometry."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cad_paths import CORE
import hashlib
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

import ezdxf
from ezdxf import xref
from ezdxf.xclip import XClip
from test_fonts_layout_xref import convert, raw_doc, PRIMARY_SHP
from unified.dxf_adapter import read_dxf
from unified.validation import validate_envelope

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/dwg/line-r2000.dwg'


def host(cached=True):
    doc = ezdxf.new('R2013')
    insert = xref.attach(doc, block_name='Part', filename='parts/part.dwg', insert=(10, 20))
    if cached:
        doc.blocks.get('Part').add_line((0, 0), (200, 0))
    return doc, insert


def convert_bytes(raw, files):
    with tempfile.TemporaryDirectory() as folder:
        filename = Path(folder) / 'main.dxf'
        filename.write_bytes(raw)
        result = read_dxf(filename, raw, resources=files, logical_path='drawings/main.dxf')
    validate_envelope(result)
    return result


class DwgXrefTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which(os.environ.get('CAD_DWG_READER', 'dwgread')), 'LibreDWG native reader not installed')
    def test_selected_dwg_replaces_cache_and_keeps_original_format_handles_and_clip(self):
        doc, insert = host()
        XClip(insert).set_block_clipping_path([(0, -1), (15, -1), (15, 1), (0, 1)])
        raw = FIXTURE.read_bytes()
        main = raw_doc(doc)
        result = convert_bytes(main, {'drawings/parts/part.dwg': raw})
        extension = result['document']['extensions']['org.cad-preview.dxf-xref/1']
        ref = next(row for row in extension['references'] if row['blockName'] == 'Part')
        self.assertEqual(ref['status'], 'resolved', ref)
        self.assertEqual(ref['replacedCachedRecords'], 1)
        source = next(s for s in result['document']['sources'] if s['id'] == ref['resolvedSourceId'])
        self.assertEqual(source['format'], 'DWG')
        self.assertEqual(source['sha256'], hashlib.sha256(raw).hexdigest())
        report = extension['decoders'][0]
        self.assertEqual(report['status'], 'complete', report)
        self.assertEqual(report['reader']['version'], '0.13.3')
        self.assertEqual(report['sourceId'], source['id'])
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        imported = [entity for entity in result['document']['drawing']['entities'].values()
                    if any(r['sourceId'] == source['id'] for r in entity['sourceRefs'])]
        self.assertEqual(len(imported), 1)
        self.assertTrue(all(r['path'].startswith('DWG/') for r in imported[0]['sourceRefs']))
        self.assertEqual(imported[0]['geometry']['end'], [20.0, 0.0, 0.0])
        self.assertTrue(any(draw.get('clipRegions') for draw in result['snapshot']['drawingProjection']['draws'].values()))
        again = convert_bytes(main, {'drawings/parts/part.dwg': raw})
        self.assertEqual(result['document']['revision'], again['document']['revision'])

    def test_missing_decoder_and_wrong_bytes_remain_explicit_without_extension_substitution(self):
        substitute = ezdxf.new('R2000'); substitute.modelspace().add_line((0, 0), (999, 0))
        for raw, expected in ((raw_doc(substitute), 'dwg-signature-unsupported'),
                              (FIXTURE.read_bytes(), 'dwg-reader-unavailable')):
            doc, _ = host()
            with patch.dict(os.environ, {'CAD_DWG_READER': '/nonexistent/cad-dwg-reader'}):
                result = convert(doc, {'drawings/parts/part.dwg': raw, 'drawings/parts/part.dxf': raw_doc(substitute)})
            ext = result['document']['extensions']['org.cad-preview.dxf-xref/1']
            ref = ext['references'][0]
            self.assertEqual(ref['status'], 'blocked')
            self.assertIn(expected, ref['reason'])
            self.assertNotIn('resolvedSourceId', ref)
            self.assertEqual(result['snapshot']['completeness'], 'partial')

    @unittest.skipUnless(shutil.which(os.environ.get('CAD_DWG_READER', 'dwgread')), 'LibreDWG native reader not installed')
    def test_truncated_dwg_never_replaces_cache_with_empty_success(self):
        doc, _ = host()
        result = convert(doc, {'drawings/parts/part.dwg': FIXTURE.read_bytes()[:40]})
        ref = result['document']['extensions']['org.cad-preview.dxf-xref/1']['references'][0]
        self.assertEqual(ref['status'], 'blocked')
        self.assertIn('dwg-decode-failed', ref['reason'])
        self.assertNotIn('replacedCachedRecords', ref)

    @unittest.skipUnless(shutil.which(os.environ.get('CAD_DWG_READER', 'dwgread')), 'LibreDWG native reader not installed')
    def test_nested_dxf_and_font_resolve_relative_to_original_dwg(self):
        doc, _ = host(False)
        detail = ezdxf.new('R2000'); detail.styles.new('Original', dxfattribs={'font': 'fonts/primary.shp'})
        detail.modelspace().add_text('A', dxfattribs={'style': 'Original', 'height': 8})
        files = {'drawings/parts/part.dwg': FIXTURE.with_name('nested-r2000.dwg').read_bytes(),
                 'drawings/detail.dxf': raw_doc(detail), 'drawings/fonts/primary.shp': PRIMARY_SHP}
        result = convert(doc, files)
        ext = result['document']['extensions']['org.cad-preview.dxf-xref/1']
        self.assertTrue(all(r['status'] == 'resolved' for r in ext['references']), ext['references'])
        self.assertEqual({s['format'] for s in result['document']['sources']}, {'DXF', 'DWG'})
        self.assertEqual(len(result['document']['sources']), 3)
        report = ext['decoders'][0]
        self.assertEqual(report['read']['errorMask'], 0)
        self.assertTrue(report['normalizations'])
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(result['snapshot']['completeness'], 'complete')
        fonts = result['document']['extensions']['org.cad-preview.dxf-shx/1']
        self.assertEqual(fonts['coverage']['status'], 'complete', fonts)
        self.assertEqual(fonts['references'][0]['logicalPath'], 'drawings/fonts/primary.shp')
        # A cycle through a decoded intermediate is still a cycle of original
        # selected bytes. It cannot acquire a new identity as a generated DXF.
        xref.attach(detail, block_name='Cycle', filename='parts/part.dwg', insert=(0, 0))
        files['drawings/detail.dxf'] = raw_doc(detail)
        cyclic = convert(doc, files)['document']['extensions']['org.cad-preview.dxf-xref/1']
        self.assertTrue(any('xref-cycle' in r['reason'] for r in cyclic['references']))

    @unittest.skipUnless(shutil.which(os.environ.get('CAD_DWG_READER', 'dwgread')), 'LibreDWG native reader not installed')
    def test_noncritical_read_losses_survive_a_successful_dxf_write(self):
        doc, _ = host(False)
        damaged = bytearray(FIXTURE.read_bytes())
        # R2000: header locator begins at 0x19, six nine-byte entries, then
        # CRC16. Change only the checksum, not an entity or its geometry.
        damaged[0x19 + 6*9] ^= 1
        result = convert(doc, {'drawings/parts/part.dwg': bytes(damaged)})
        report = result['document']['extensions']['org.cad-preview.dxf-xref/1']['decoders'][0]
        self.assertEqual(report['read']['errorMask'], 1)
        self.assertEqual(report['write']['errorMask'], 0)
        self.assertEqual(report['status'], 'partial')
        self.assertEqual(result['snapshot']['completeness'], 'partial')
        self.assertTrue(any(d['code'] == 'dxf-dwg-decode-partial' for d in result['snapshot']['diagnostics']))


if __name__ == '__main__':
    unittest.main()
