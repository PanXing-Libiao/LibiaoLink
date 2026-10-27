"""Lifecycle and cache isolation using a controlled worker, never CAD evidence."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path
APP=Path(__file__).resolve().parents[1];sys.path.insert(0,str(APP))
from unified.conversion_jobs import ConversionJobs,JobLimit
from server import stop_worker
from convert import convert
from unified.adapter import from_packet
from unified.migrate import migrate_bridge_v1

class JobTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source=SAMPLE_ROOT / 'Viola.easm';raw=source.read_bytes()
        cls.envelope=migrate_bridge_v1(from_packet(convert(raw,source.name,allow_experimental=False),len(raw)))
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.app=self.root/'app';self.app.mkdir()
        (self.app/'fixture.json').write_text(json.dumps(self.envelope))
        (self.app/'step_convert.py').write_text("import sys\nsys.path.insert(0,"+repr(str(APP))+')\n'+'''import json,time,hashlib,os,base64
from pathlib import Path
from unified.migrate import seal
from unified.payload_sink import FileSink
from unified.compact_transport import pack_metadata
if sys.argv[1]=='no-read.step':time.sleep(10)
if sys.argv[1]=='delayed-read.step':time.sleep(.5)
data=sys.stdin.buffer.read()
if data==b'hang':time.sleep(10)
if data==b'fail':print(json.dumps({'error':'controlled failure','code':'controlled'}));sys.exit(1)
if data==b'crash':sys.exit(9)
e=json.loads((Path(__file__).parent/'fixture.json').read_text())
e['document']['sources'][0].update(sha256=hashlib.sha256(data).hexdigest(),format='STEP',name=sys.argv[1],byteLength=len(data))
e['document']['adapter'].update(id='occt-xde-step',dependencies=[{'name':'cadquery-ocp','version':'7.8.1.1'}])
e['snapshot']['completeness']='complete'
e['document']['extensions']['controlledNameCodepage']=os.environ.get('CAD_STEP_NAME_CODEPAGE')
if data==b'wrong-source':e['document']['sources'][0]['sha256']='0'*64
if data==b'partial-output':e['snapshot']['completeness']='partial'
seal(e)
if os.environ.get('CAD_BINARY_DIR'):
 sink=FileSink(os.environ['CAD_BINARY_DIR'])
 for bid,value in e.pop('bufferPayloads').items():sink.put(bid,base64.b64decode(value))
 sink.attach(e);sink.finish(e)
 if data==b'bad-buffer':Path(e['bufferResources'][0]['path']).write_bytes(b'corrupt')
 if os.environ.get('CAD_COMPACT_METADATA')=='1':e=pack_metadata(e)
print(json.dumps(e))
''')
        self.gate=threading.Lock();self.jobs=self.create()
    def create(self,rule='rules-v1',policy=None):return ConversionJobs(self.root/'store',self.app,self.gate,stop_worker,rule,sys.executable,policy)
    def tearDown(self):self.jobs.close();self.tmp.cleanup()
    def wait(self,jid,state=None):
        start=time.monotonic()
        while time.monotonic()-start<8:
            row=self.jobs.status(jid)
            if row['state'] in ('completed','failed','cancelled','timed-out') and (state is None or row['state']==state):return row
            time.sleep(.025)
        self.fail(str(self.jobs.status(jid)))
    def submit(self,data=b'ok',partial=True):return self.jobs.submit(data,'controlled.step',partial,'a'*32)[0]
    def test_success_dedup_and_corruption(self):
        row=self.submit();self.wait(row['id'],'completed');same,reused=self.jobs.submit(b'ok','controlled.step',True,'b'*32)
        self.assertTrue(reused);self.assertEqual(same['id'],row['id'])
        status,raw=self.jobs.result(row['id']);self.assertEqual(json.loads(raw)['document']['sources'][0]['sha256'],hashlib.sha256(b'ok').hexdigest())
        artifact=next((self.root/'store/artifacts').iterdir());artifact.write_bytes(b'corrupt')
        status,raw=self.jobs.result(row['id']);self.assertIsNone(raw);self.assertEqual(status['state'],'failed')
        again=self.submit();self.assertNotEqual(again['id'],row['id']);self.wait(again['id'],'completed')
    def test_host_namespace_isolates_jobs_without_changing_cad_identity(self):
        first,_=self.jobs.submit(b'ok','controlled.step',False,'a'*32,namespace='1'*64)
        self.wait(first['id'],'completed')
        same,reused=self.jobs.submit(b'ok','controlled.step',False,'b'*32,namespace='1'*64)
        other,_=self.jobs.submit(b'ok','controlled.step',False,'c'*32,namespace='2'*64)
        self.wait(other['id'],'completed')
        self.assertTrue(reused);self.assertEqual(first['id'],same['id']);self.assertNotEqual(first['id'],other['id'])
        self.assertEqual(self.jobs.status(other['id'])['namespace'],'2'*64)
        one=json.loads(self.jobs.result(first['id'])[1]);two=json.loads(self.jobs.result(other['id'])[1])
        self.assertEqual(one['document'],two['document']);self.assertEqual(one['snapshot'],two['snapshot'])
    def test_modes_and_rules_isolate_and_restart_reuses_verified_only(self):
        first=self.submit();self.wait(first['id'],'completed')
        strict=self.submit(partial=False);self.assertNotEqual(first['id'],strict['id']);self.wait(strict['id'],'completed')
        self.jobs.close();self.jobs=self.create();again=self.submit();self.assertEqual(again['id'],first['id'])
        self.jobs.close();self.jobs=self.create('rules-v2');changed=self.submit();self.assertNotEqual(changed['id'],first['id']);self.wait(changed['id'],'completed')
    def test_name_codepage_isolates_cache_and_reaches_worker(self):
        first=self.submit();self.wait(first['id'],'completed')
        gb,_=self.jobs.submit(b'ok','controlled.step',True,'b'*32,name_codepage='GB');self.wait(gb['id'],'completed')
        self.assertNotEqual(first['id'],gb['id'])
        self.assertEqual(json.loads(self.jobs.result(gb['id'])[1])['document']['extensions']['controlledNameCodepage'],'GB')
        same,reused=self.jobs.submit(b'ok','controlled.step',True,'c'*32,name_codepage='GB')
        self.assertTrue(reused);self.assertEqual(same['id'],gb['id'])
        with self.assertRaisesRegex(ValueError,'unsupported-step-name-codepage'):
            self.jobs.submit(b'ok','controlled.step',True,'d'*32,name_codepage='guess')
    def test_binary_bundle_and_corrupt_buffer_after_restart(self):
        row=self.submit();done=self.wait(row['id'],'completed');_,raw=self.jobs.result(row['id']);e=json.loads(raw)
        self.assertEqual(e['transportProfile'],'ucd-worker-binary-compact/1')
        self.assertNotIn('bufferPayloads',e);self.assertNotIn('bufferResources',e)
        blobs=self.jobs.buffers(e);self.assertEqual(set(blobs),set(e['document']['buffers']))
        self.assertEqual(done['artifactBytes'],len(raw)+sum(len(b) for b in {hashlib.sha256(b).hexdigest():b for b in blobs.values()}.values()))
        self.jobs.close();self.jobs=self.create();self.assertIsNotNone(self.jobs.result(row['id'])[1])
        buffer=next((self.root/'store/buffers').iterdir());raw=buffer.read_bytes();buffer.write_bytes(bytes([raw[0]^1])+raw[1:])
        state,result=self.jobs.result(row['id']);self.assertIsNone(result);self.assertEqual(state['error']['code'],'cache-integrity-failed')
    def test_bad_worker_buffer_never_publishes(self):
        row=self.submit(b'bad-buffer');self.assertEqual(self.wait(row['id'])['state'],'failed')
        self.assertFalse(list((self.root/'store/artifacts').iterdir()));self.assertFalse(list((self.root/'store/buffers').iterdir()))
    def test_base64_override_is_separate_and_remains_available(self):
        first=self.submit();self.wait(first['id'],'completed');self.jobs.close()
        with patch.dict(os.environ,{'CAD_STEP_JOB_BINARY':'0'}):self.jobs=self.create()
        second=self.submit();self.wait(second['id'],'completed');self.assertNotEqual(first['id'],second['id'])
        self.assertEqual(json.loads(self.jobs.result(second['id'])[1])['transportProfile'],'ucd-base64-envelope/1')
    def test_full_metadata_override_has_separate_cache_identity(self):
        first=self.submit();self.wait(first['id'],'completed');self.jobs.close()
        with patch.dict(os.environ,{'CAD_STEP_JOB_COMPACT':'0'}):self.jobs=self.create()
        second=self.submit();self.wait(second['id'],'completed');self.assertNotEqual(first['id'],second['id'])
        self.assertEqual(json.loads(self.jobs.result(second['id'])[1])['transportProfile'],'ucd-worker-binary/1')
    def test_binary_storage_quota_counts_buffers(self):
        row=self.submit();done=self.wait(row['id'],'completed');self.jobs.close()
        self.jobs=self.create('new-rules',policy={'artifactBytes':done['manifestBytes']})
        row=self.submit(b'other');self.assertEqual(self.wait(row['id'])['state'],'failed')
    def test_failure_and_crash_never_publish(self):
        for data in (b'fail',b'crash'):
            row=self.submit(data);state=self.wait(row['id']);self.assertEqual(state['state'],'failed');self.assertIsNone(self.jobs.result(row['id'])[1])
        self.assertFalse(list((self.root/'store/artifacts').iterdir()))
    def test_cancel_queued_and_running(self):
        self.gate.acquire()
        try:
            row=self.submit();self.assertEqual(self.jobs.cancel(row['id'])['state'],'cancelled')
        finally:self.gate.release()
        row=self.submit(b'hang')
        start=time.monotonic()
        while not self.jobs.active and time.monotonic()-start<2:time.sleep(.01)
        self.assertEqual(self.jobs.cancel(row['id'])['state'],'cancelled');self.wait(row['id'],'cancelled')
        self.assertIsNone(self.jobs.result(row['id'])[1])
    def test_timeout_and_memory_quota(self):
        self.jobs.close();self.jobs=self.create(policy={'workerWallSeconds':.3})
        row=self.submit(b'hang');self.wait(row['id'],'timed-out')
        self.jobs.close();self.jobs=self.create(policy={'workerRSSBytes':1})
        row=self.submit(b'hang');state=self.wait(row['id'],'failed');self.assertEqual(state['error']['code'],'job-memory-quota')
    def test_queue_quota_and_restart_failure(self):
        self.jobs.policy['maxQueued']=1;self.gate.acquire()
        try:
            row=self.submit()
            with self.assertRaises(JobLimit):self.submit(b'other')
        finally:self.jobs.close();self.gate.release()
        # Controlled crash-state fixture: durable queued metadata without a live worker.
        connection=sqlite3.connect(self.root/'store/jobs.sqlite3');record=json.loads(connection.execute('SELECT record FROM jobs WHERE id=?',(row['id'],)).fetchone()[0]);record['state']='running'
        connection.execute('UPDATE jobs SET state=?,record=? WHERE id=?',('running',json.dumps(record),row['id']));connection.commit();connection.close()
        self.jobs=self.create();state=self.jobs.status(row['id']);self.assertEqual(state['state'],'failed');self.assertEqual(state['error']['code'],'server-restarted')
    def test_output_quota(self):
        self.jobs.close();self.jobs=self.create(policy={'resultBytes':10})
        row=self.submit();self.assertEqual(self.wait(row['id'])['state'],'failed');self.assertIsNone(self.jobs.result(row['id'])[1])
    def test_exclusive_owner_and_cancel_before_creation(self):
        with self.assertRaises(JobLimit):self.create()
        self.jobs.cancel_request('a'*32);row=self.submit();self.assertEqual(row['state'],'cancelled')
    def test_source_and_strict_output_mismatch_rejected(self):
        for data in (b'wrong-source',b'partial-output'):
            row=self.submit(data,partial=False);self.assertEqual(self.wait(row['id'])['state'],'failed');self.assertIsNone(self.jobs.result(row['id'])[1])
    def test_queue_timeout(self):
        self.jobs.policy['queueWallSeconds']=.1;self.gate.acquire()
        try:row=self.submit();self.wait(row['id'],'timed-out')
        finally:self.gate.release()
    def test_timeout_while_worker_does_not_read_input(self):
        self.jobs.policy['workerWallSeconds']=.3
        row,_=self.jobs.submit(b'N'*1024*1024,'no-read.step',True,'d'*32)
        self.wait(row['id'],'timed-out')
    def test_large_input_survives_delayed_worker_read(self):
        row,_=self.jobs.submit(b'R'*2*1024*1024,'delayed-read.step',True,'e'*32)
        self.wait(row['id'],'completed')
    def test_stream_truncation_and_limits_release_upload_reservation(self):
        with self.assertRaisesRegex(ValueError,'incomplete'):
            self.jobs.submit_stream(io.BytesIO(b'no'),5,'truncated.step',False,'f'*32)
        self.assertEqual(self.jobs.upload_reserved,0)
        self.assertFalse(list((self.jobs.root/'temporary').iterdir()))
        self.jobs.policy['inputBytes']=1
        with self.assertRaises(ValueError):self.submit(b'ok')
        self.jobs.policy['inputBytes']=1024
        self.jobs.policy['sourceBytes']=1
        with self.assertRaises(JobLimit):self.submit(b'ok')
        self.assertEqual(self.jobs.upload_reserved,0)
    def test_stream_upload_reads_in_bounded_chunks_and_reuses_source(self):
        class Upload(io.BytesIO):
            def read(stream,size=-1):
                self.assertGreater(size,0);self.assertLessEqual(size,1024*1024)
                return super().read(size)
        data=b'S'*(3*1024*1024)
        row,_=self.jobs.submit_stream(Upload(data),len(data),'stream.step',False,'f'*32)
        self.wait(row['id'],'completed')
        repeated,reused=self.jobs.submit_stream(Upload(data),len(data),'stream.step',False,'e'*32)
        self.assertTrue(reused);self.assertEqual(row['id'],repeated['id'])
        self.assertEqual(self.jobs.upload_reserved,0)
    def test_unclean_restart_stops_orphan_and_cleans_temporary_directory(self):
        self.jobs.close()
        program='\n'.join([
            'import sys,time,threading',f'sys.path[:0]=[{str(APP)!r},{str(APP.parent / "dev")!r}]',
            'from unified.conversion_jobs import ConversionJobs','from server import stop_worker',
            f'j=ConversionJobs({str(self.root/"store")!r},{str(self.app)!r},threading.Lock(),stop_worker,"rules-v1",sys.executable)',
            'r,_=j.submit(b"hang","controlled.step",True,"c"*32)',
            f'open({str(self.root/"child-job-id")!r},"w").write(r["id"])','time.sleep(30)'])
        child=subprocess.Popen([sys.executable,'-c',program],start_new_session=True)
        try:
            deadline=time.monotonic()+5;row=None
            while time.monotonic()<deadline:
                f=self.root/'child-job-id'
                if f.exists():
                    c=sqlite3.connect(self.root/'store/jobs.sqlite3');text=c.execute('SELECT record FROM jobs WHERE id=?',(f.read_text(),)).fetchone();c.close()
                    if text:
                        row=json.loads(text[0])
                        if row.get('workerPid'):break
                time.sleep(.02)
            self.assertTrue(row and row.get('workerPid'));child.kill();child.wait(timeout=3)
            self.jobs=self.create();recovered=self.jobs.status(row['id'])
            self.assertEqual(recovered['state'],'failed');self.assertEqual(recovered['error']['code'],'server-restarted')
            self.assertFalse(list((self.root/'store/temporary').iterdir()))
            state=subprocess.run(['ps','-o','stat=','-p',str(row['workerPid'])],capture_output=True,text=True).stdout.strip()
            self.assertTrue(not state or state.startswith('Z'),state)
        finally:
            if child.poll() is None:child.kill();child.wait()

if __name__=='__main__':unittest.main()
