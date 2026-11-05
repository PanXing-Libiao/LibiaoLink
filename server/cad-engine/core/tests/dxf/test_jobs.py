"""Real isolated DXF jobs, resource identity, partial results and cache integrity."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cad_paths import CORE, WORK
import hashlib
import io
import json
import signal
import os
import shutil
import struct
import tempfile
import threading
import time
import unittest

import ezdxf
from unified.conversion_jobs import ConversionJobs
from unified.dxf_resources import MAGIC
from test_fonts_layout_xref import font_bytes, raw_doc


def package(main, files):
    rows = sorted(files.items())
    header = json.dumps({'version': 'dxf-resources/1', 'main': main,
                         'files': [{'path': path, 'byteLength': len(raw)} for path, raw in rows]}).encode()
    return MAGIC + struct.pack('<I', len(header)) + header + b''.join(raw for _, raw in rows)


def stop(proc):
    if proc is not None and proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()


# These tests drive the isolated DXF worker through a provisioned local runtime
# (.cad-work/dxf venv). Without that interpreter they would only exercise the
# worker-failure path, so the class skips instead of asserting a fake contract.
WORKER = WORK / 'dxf/bin/python'


@unittest.skipUnless(WORKER.exists(), 'isolated DXF worker interpreter (.cad-work/dxf/bin/python) is not provisioned')
class DxfJobsTest(unittest.TestCase):
    def test_uploaded_dwfx_and_print_style_reach_the_isolated_worker(self):
        from test_underlays import dwfx
        from test_plot_styles import binary
        from ezdxf.addons import acadctb
        doc=ezdxf.new('R2013');definition=doc.add_underlay_def('page.dwfx','dwf','1')
        doc.modelspace().add_underlay(definition);doc.modelspace().add_line((0,0),(20,0))
        doc.layouts.get('Model').dxf.current_style_sheet='own.ctb'
        wire=package('drawings/main.dxf',{'drawings/main.dxf':raw_doc(doc),
            'drawings/page.dwfx':dwfx(),'drawings/own.ctb':binary(acadctb.new_ctb())})
        with tempfile.TemporaryDirectory() as folder:
            jobs=ConversionJobs(Path(folder)/'jobs',CORE,threading.Lock(),stop,'dxf-test',
                str(WORK/'occt/bin/python'),dxf_interpreter=str(WORK/'dxf/bin/python'))
            try:
                row,_=jobs.submit(wire,'main.dxf',False,'b'*32)
                deadline=time.monotonic()+20
                while row['state'] in ('queued','running') and time.monotonic()<deadline:
                    time.sleep(.05);row=jobs.status(row['id'])
                self.assertEqual(row['state'],'completed',row)
                result=json.loads(jobs.result(row['id'])[1])
                self.assertEqual(result['document']['extensions']['org.cad-preview.dxf-media/1']['coverage']['displayedObjects'],1)
                self.assertEqual(result['document']['extensions']['org.cad-preview.dxf-plot-styles/1']['layouts']['model']['status'],'ready')
            finally:jobs.close()

    @unittest.skipUnless(shutil.which(os.environ.get('CAD_DXF_DWG_READER', 'dwgread')), 'LibreDWG native reader not installed')
    def test_dwg_companion_keeps_original_identity_through_the_isolated_worker(self):
        from test_dwg_xref import host, FIXTURE
        doc, _ = host()
        wire = package('drawings/main.dxf', {'drawings/main.dxf': raw_doc(doc),
                       'drawings/parts/part.dwg': FIXTURE.read_bytes()})
        with tempfile.TemporaryDirectory() as folder:
            jobs = ConversionJobs(Path(folder) / 'jobs', CORE, threading.Lock(), stop, 'dxf-test',
                                  str(WORK / 'occt/bin/python'), dxf_interpreter=str(WORK / 'dxf/bin/python'))
            try:
                row, _ = jobs.submit(wire, 'main.dxf', False, 'f' * 32)
                deadline = time.monotonic() + 20
                while row['state'] in ('queued', 'running') and time.monotonic() < deadline:
                    time.sleep(.05); row = jobs.status(row['id'])
                self.assertEqual(row['state'], 'completed', row)
                envelope = json.loads(jobs.result(row['id'])[1])
                dwg = next(s for s in envelope['document']['sources'] if s['format'] == 'DWG')
                self.assertEqual(dwg['sha256'], hashlib.sha256(FIXTURE.read_bytes()).hexdigest())
                self.assertIn({'name': 'libredwg', 'version': '0.13.3'}, envelope['document']['adapter']['dependencies'])
            finally:
                jobs.close()

    def test_uploaded_font_package_reaches_the_isolated_dxf_worker(self):
        doc = ezdxf.new('R2013'); doc.styles.new('Uploaded', dxfattribs={'font': 'font.ttf'})
        doc.modelspace().add_text('A中', dxfattribs={'style': 'Uploaded', 'height': 2})
        wire = package('drawings/main.dxf', {'drawings/main.dxf': raw_doc(doc), 'drawings/font.ttf': font_bytes()})
        with tempfile.TemporaryDirectory() as folder:
            jobs = ConversionJobs(Path(folder) / 'jobs', CORE, threading.Lock(), stop, 'dxf-test',
                                  str(WORK / 'occt/bin/python'), dxf_interpreter=str(WORK / 'dxf/bin/python'))
            try:
                row, _ = jobs.submit(wire, 'main.dxf', False, 'e' * 32)
                deadline = time.monotonic() + 20
                while row['state'] in ('queued', 'running') and time.monotonic() < deadline:
                    time.sleep(.05); row = jobs.status(row['id'])
                self.assertEqual(row['state'], 'completed', row)
                envelope = json.loads(jobs.result(row['id'])[1])
                fonts = envelope['document']['extensions']['org.cad-preview.dxf-shx/1']
                self.assertEqual(fonts['coverage']['resolvedReferences'], 1)
                self.assertEqual(fonts['references'][0]['logicalPath'], 'drawings/font.ttf')
            finally:
                jobs.close()

    def test_empty_drawing_does_not_become_a_successful_partial_artifact(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'empty.dxf'
            ezdxf.new('R2013').saveas(path)
            wire = package(path.name, {path.name: path.read_bytes()})
            jobs = ConversionJobs(Path(folder) / 'jobs', CORE, threading.Lock(), stop, 'dxf-test',
                                  str(WORK / 'occt/bin/python'), dxf_interpreter=str(WORK / 'dxf/bin/python'))
            try:
                row, _ = jobs.submit(wire, path.name, False, 'd' * 32)
                deadline = time.monotonic() + 20
                while row['state'] in ('queued', 'running') and time.monotonic() < deadline:
                    time.sleep(.05); row = jobs.status(row['id'])
                self.assertEqual(row['state'], 'failed', row)
                self.assertIsNone(jobs.result(row['id'])[1])
            finally:
                jobs.close()

    def test_partial_artifact_is_explicit_reusable_and_integrity_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'main.dxf'
            doc = ezdxf.new('R2013')
            doc.modelspace().add_line((0, 0), (10, 20))
            doc.styles.new('Missing', dxfattribs={'font': 'not-provided.shx'})
            doc.modelspace().add_text('LABEL', dxfattribs={'style': 'Missing', 'height': 2})
            doc.saveas(path)
            raw = path.read_bytes()
            wire = package('drawings/main.dxf', {'drawings/main.dxf': raw})
            jobs = ConversionJobs(Path(folder) / 'jobs', CORE, threading.Lock(), stop, 'dxf-test',
                                  str(WORK / 'occt/bin/python'), dxf_interpreter=str(WORK / 'dxf/bin/python'))
            try:
                row, reused = jobs.submit(wire, path.name, False, 'a' * 32)
                self.assertFalse(reused)
                deadline = time.monotonic() + 20
                while row['state'] in ('queued', 'running') and time.monotonic() < deadline:
                    time.sleep(.05); row = jobs.status(row['id'])
                self.assertEqual(row['state'], 'partial', row)
                self.assertEqual(row['sourceSHA256'], hashlib.sha256(raw).hexdigest())
                self.assertEqual(row['sourceByteLength'], len(raw))
                verified, result = jobs.result(row['id'])
                self.assertIsNotNone(result)
                self.assertEqual(json.loads(result)['snapshot']['completeness'], 'partial')
                same, reused = jobs.submit(wire, path.name, False, 'b' * 32)
                self.assertTrue(reused); self.assertEqual(same['id'], row['id'])
                changed = package('other/main.dxf', {'other/main.dxf': raw})
                different, reused = jobs.submit(changed, path.name, False, 'c' * 32)
                self.assertFalse(reused); self.assertNotEqual(different['id'], row['id'])
                first = next(iter(json.loads(result)['document']['buffers'].values()))
                (jobs.root / 'buffers' / first['sha256']).write_bytes(b'broken')
                self.assertIsNone(jobs.result(row['id'])[1])
                self.assertEqual(jobs.status(row['id'])['state'], 'failed')
            finally:
                jobs.close()


if __name__ == '__main__':
    unittest.main()
