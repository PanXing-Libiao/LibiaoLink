"""Bounded local STEP jobs. Durable metadata/CAS, existing isolated worker and gate.

These jobs are a separate resource policy, not a larger synchronous timeout.
No native B-Rep is persisted and no exact-measurement capability is implied.
"""
import hashlib
import io
import fcntl
import json
import os
import re
import secrets
import signal
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from .validation import validate_envelope,validate_binary_envelope
from .transport import read_worker_buffers
from .input_policy import step_job_input_bytes
from .compact_transport import WORKER,VERSION,unpack_metadata
from .step_name_encoding import name_codepage as check_name_codepage
from . import dxf_resources

TERMINAL={'completed','partial','failed','cancelled','timed-out'}
POLICY={'version':'local-step-job/3','workerWallSeconds':600,'queueWallSeconds':900,'workerRSSBytes':2*1024**3,
        'concurrency':1,'maxQueued':8,'sourceBytes':256*1024**2,'artifactBytes':512*1024**2,
        'resultBytes':256*1024**2,'stderrBytes':8*1024**2,'logBytes':64*1024**2,'maxStoredJobs':1024,'retentionSeconds':86400,
        'synchronousWorkerSeconds':60,'restart':'queued/running jobs fail; explicit resubmission retries',
        'disconnect':'job continues until cancelled, terminal, resource limit, or server restart',
        'deduplication':'same content/name/mode/reader/rules returns same local job; cancellation is shared'}

class JobLimit(ValueError):pass

class ConversionJobs:
    def __init__(self,root,app,gate,stop_worker,rule_version,interpreter,policy=None,dxf_interpreter=None,
                 dwg_interpreter=None):
        self.root=Path(root);self.app=Path(app);self.gate=gate;self.stop_worker=stop_worker
        self.rule_version=rule_version;self.interpreter=interpreter;self.policy={**POLICY,'inputBytes':step_job_input_bytes(),**(policy or {})}
        self.dxf_interpreter=dxf_interpreter
        self.dwg_interpreter=dwg_interpreter
        self.dwg_policy={'workerRSSBytes':3*1024**3,'resultBytes':512*1024**2,'artifactBytes':512*1024**2}
        self.binary=os.environ.get('CAD_STEP_JOB_BINARY','1')!='0'
        self.compact=self.binary and os.environ.get('CAD_STEP_JOB_COMPACT','1')!='0'
        self.upload_reserved=0
        self.lock=threading.RLock();self.active={};self.threads={};self.cancelled_requests={};self.closed=False;self.db_closed=False
        for name in ('sources','artifacts','buffers','temporary','logs'):(self.root/name).mkdir(parents=True,exist_ok=True)
        self.owner=(self.root/'owner.lock').open('a')
        try:fcntl.flock(self.owner,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            self.owner.close();raise JobLimit('another server owns this conversion store')
        self.db=sqlite3.connect(self.root/'jobs.sqlite3',check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, cache_key TEXT, state TEXT, updated REAL, record TEXT)')
        self.db.execute('CREATE INDEX IF NOT EXISTS cache_key ON jobs(cache_key)');self.db.commit()
        with self.lock:
            for (text,) in self.db.execute("SELECT record FROM jobs WHERE state IN ('queued','running')").fetchall():
                row=json.loads(text)
                pid=row.get('workerPid')
                if pid and row.get('workerProcessIdentity'):
                    observed=subprocess.run(['ps','-o','lstart=','-o','command=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
                    birth=subprocess.run(['ps','-o','lstart=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
                    worker='dxf_convert.py' if row.get('sourceFormat')=='DXF' else 'dwg_platform_convert.py' if row.get('sourceFormat')=='DWG' else 'step_convert.py'
                    same_process=observed==row['workerProcessIdentity'] or (row.get('workerBirth')==birth and str(self.app/worker) in observed)
                    if same_process:
                        try:os.killpg(pid,signal.SIGKILL)
                        except ProcessLookupError:pass
                        # Signal delivery/reaping is asynchronous on macOS.
                        for _ in range(40):
                            state=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
                            if not state or state.startswith('Z'):break
                            time.sleep(.05)
                        else:
                            self.db.close();self.owner.close();raise JobLimit('previous worker has not stopped')
                self._update(row,state='failed',error={'code':'server-restarted','error':'服务重启中断了转换，请重新提交'})
        # All workers in this store are terminal after recovery. Orphan temporary
        # files cannot be mistaken for verified artifacts.
        for file in (self.root/'temporary').iterdir():
            if file.is_symlink() or file.is_file():file.unlink()
            elif file.is_dir():shutil.rmtree(file)

    def _update(self,row,**fields):
        row.update(fields);row['updatedAt']=time.time()
        self.db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?,?)',
                        (row['id'],row['cacheKey'],row['state'],row['updatedAt'],json.dumps(row,ensure_ascii=False)))
        self.db.commit();return row

    def _get(self,jid):
        r=self.db.execute('SELECT record FROM jobs WHERE id=?',(jid,)).fetchone()
        return json.loads(r[0]) if r else None

    def _prune(self):
        cutoff=time.time()-self.policy['retentionSeconds']
        self.db.execute("DELETE FROM jobs WHERE state NOT IN ('queued','running') AND updated<?",(cutoff,));self.db.commit()
        rows=[json.loads(r[0]) for r in self.db.execute('SELECT record FROM jobs')]
        sources={r.get('inputSHA256',r['sourceSHA256']) for r in rows};artifacts={r.get('artifactSHA256') for r in rows}
        buffers={sha for r in rows for sha in r.get('artifactBufferSHA256',[])}
        for directory,keep in [('sources',sources),('artifacts',artifacts),('buffers',buffers)]:
            for f in (self.root/directory).iterdir():
                if f.name not in keep:f.unlink()
        logs={r['id']+'.log' for r in rows}
        for f in (self.root/'logs').iterdir():
            if f.name not in logs:f.unlink()

    def submit(self,data,name,partial,request_id,request_trace=None,namespace=None,name_codepage='UTF8'):
        return self.submit_stream(io.BytesIO(data),len(data),name,partial,request_id,request_trace,namespace=namespace,name_codepage=name_codepage)

    def submit_stream(self,stream,length,name,partial,request_id,request_trace=None,upload_started=None,namespace=None,name_codepage='UTF8'):
        # Host integration isolates deduplication/cancellation between users and
        # file versions. This changes job ownership, never source CAD identities.
        name_codepage=check_name_codepage(name_codepage)
        is_dxf=Path(name).suffix.lower()=='.dxf'
        is_dwg=Path(name).suffix.lower()=='.dwg'
        maximum=min(self.policy['inputBytes'],dxf_resources.MAX_BYTES)+dxf_resources.MAX_HEADER+12 if is_dxf else self.policy['inputBytes']
        if namespace is not None and not re.fullmatch(r'[a-f0-9]{64}',namespace):raise ValueError('invalid job namespace')
        if not 0<length<=maximum:raise ValueError('CAD input exceeds the job input budget')
        if Path(name).name!=name or Path(name).suffix.lower() not in ('.step','.stp','.dxf','.dwg'):raise ValueError('jobs accept STEP, DXF or DWG only')
        if is_dxf and not self.dxf_interpreter:raise ValueError('missing-dxf-runtime: DXF job interpreter is not configured')
        if is_dwg and not self.dwg_interpreter:raise ValueError('missing-dwg-runtime: DWG job interpreter is not configured')
        with self.lock:
            if self.closed:raise JobLimit('job service is stopping')
            self._prune()
            stored=sum(f.stat().st_size for f in (self.root/'sources').iterdir())
            if stored+self.upload_reserved+length>self.policy['sourceBytes']:raise JobLimit('source upload storage quota exceeded')
            self.upload_reserved+=length
        temporary=None
        try:
            digest=hashlib.sha256();remaining=length
            with tempfile.NamedTemporaryFile(dir=self.root/'temporary',prefix='upload-',delete=False) as target:
                temporary=Path(target.name)
                while remaining:
                    chunk=stream.read(min(1024*1024,remaining))
                    if not chunk:raise ValueError('incomplete STEP upload')
                    if len(chunk)>remaining:raise ValueError('STEP upload exceeded declared length')
                    target.write(chunk);digest.update(chunk);remaining-=len(chunk)
            if request_trace is not None and upload_started is not None:
                request_trace['events']['uploadCompleted']=round((time.perf_counter()-upload_started)*1000,3)
            return self._submit_source(temporary,digest.hexdigest(),length,name,partial,request_id,request_trace,namespace,name_codepage)
        finally:
            if temporary is not None:temporary.unlink(missing_ok=True)
            with self.lock:self.upload_reserved-=length

    def _submit_source(self,temporary,sha,length,name,partial,request_id,request_trace,namespace=None,name_codepage='UTF8'):
        is_dxf=Path(name).suffix.lower()=='.dxf'
        is_dwg=Path(name).suffix.lower()=='.dwg'
        extra={}
        if is_dxf:
            package=dxf_resources.decode_package(temporary.read_bytes())
            main=package['files'][package['main']]
            if Path(package['main']).name!=name or sum(map(len,package['files'].values()))>min(self.policy['inputBytes'],dxf_resources.MAX_BYTES):
                raise ValueError('DXF package main or byte budget mismatch')
            extra={'inputSHA256':sha,'resourceFingerprint':dxf_resources.fingerprint(package)}
            sha=hashlib.sha256(main).hexdigest();length=len(main);name_codepage='UTF8'
        source_format='DXF' if is_dxf else 'DWG' if is_dwg else 'STEP'
        identity={'sourceSHA256':sha,'sourceByteLength':length,'name':name,'partial':bool(partial),
                  'reader':'acadsharp/3.8.30' if is_dwg else 'cadquery-ocp/7.8.1.1',
                  'rules':self.rule_version,'schema':'2.0.0','policy':self.policy['version'],'nameCodepage':name_codepage,
                  'artifactTransport':'binary' if self.binary else 'base64',
                  'artifactMetadata':VERSION if self.compact and not is_dxf and not is_dwg else 'full'}
        identity.update(sourceFormat=source_format,**extra)
        if is_dxf:identity['reader']='ezdxf/1.4.2'
        if namespace is not None:identity['namespace']=namespace
        key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
        with self.lock:
            if self.closed:raise JobLimit('job service is stopping')
            self.cancelled_requests={k:v for k,v in self.cancelled_requests.items() if time.monotonic()-v<60}
            for (text,) in self.db.execute('SELECT record FROM jobs WHERE cache_key=? ORDER BY updated DESC',(key,)):
                row=json.loads(text)
                if row['state'] in ('queued','running'):
                    requests=row.setdefault('requestIds',[row['requestId']])
                    if request_id not in requests:
                        if len(requests)>=64:raise JobLimit('job subscriber quota exceeded')
                        requests.append(request_id);self._update(row)
                    if request_id in self.cancelled_requests:self.cancel(row['id'])
                    return self._public(row),True
                if row['state'] in ('completed','partial') and self._artifact(row) is not None:return self._public(row),True
            queued=self.db.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]
            if queued>=self.policy['maxQueued']:raise JobLimit('conversion queue quota exceeded')
            if self.db.execute('SELECT count(*) FROM jobs').fetchone()[0]>=self.policy['maxStoredJobs']:raise JobLimit('stored job quota exceeded')
            source=self.root/'sources'/extra.get('inputSHA256',sha)
            if not source.exists():
                size=sum(f.stat().st_size for f in source.parent.iterdir())
                if size+length>self.policy['sourceBytes']:raise JobLimit('source storage quota exceeded')
                temporary.replace(source)
            jid=secrets.token_hex(16)
            row={'id':jid,'cacheKey':key,'state':'queued','phase':'queue-entered','createdAt':time.time(),
                 'requestId':request_id,'requestIds':[request_id],'requestTrace':request_trace,**identity,'policy':self.policy,'trace':{'clock':'job-relative-ms','events':{'queueEntered':0.}}}
            if request_id in self.cancelled_requests:row.update(state='cancelled',phase='cancelled')
            self._update(row)
            thread=threading.Thread(target=self._run,args=(jid,),daemon=True,name='cad-job-'+jid[:8]);self.threads[jid]=thread;thread.start()
            return self._public(row),False

    def _public(self,row):
        return {k:v for k,v in row.items() if k not in ('cacheKey','artifactSHA256','artifactBufferSHA256')}

    def status(self,jid):
        with self.lock:
            row=self._get(jid)
            return self._public(row) if row else None

    def _artifact(self,row):
        sha=row.get('artifactSHA256');path=self.root/'artifacts'/(sha or 'missing')
        if sha and path.is_file():
            raw=path.read_bytes()
            if hashlib.sha256(raw).hexdigest()==sha:
                try:
                    if row.get('artifactTransport')=='binary':
                        # Reuse verifies every immutable buffer, including after restart.
                        # Stream hashes here; do not retain a second geometry-sized copy.
                        for key in row['artifactBufferSHA256']:
                            path=self._buffer_path({'sha256':key});digest=hashlib.sha256()
                            with path.open('rb') as handle:
                                for chunk in iter(lambda:handle.read(1024*1024),b''):digest.update(chunk)
                            if digest.hexdigest()!=key:raise ValueError('artifact buffer hash mismatch')
                    return raw
                except (OSError,ValueError):pass
        if row['state'] in ('completed','partial'):self._update(row,state='failed',error={'code':'cache-integrity-failed','error':'已验证产物缺失或已损坏，需重新转换'})
        return None

    def _buffer_path(self,definition):
        sha=definition['sha256']
        if not re.fullmatch('[a-f0-9]{64}',sha):raise ValueError('invalid artifact buffer hash')
        path=self.root/'buffers'/sha
        if path.is_symlink() or not path.is_file() or ('byteLength' in definition and path.stat().st_size!=definition['byteLength']):
            raise ValueError('artifact buffer missing or wrong length')
        return path

    def buffers(self,envelope):
        blobs={}
        for bid,b in envelope['document']['buffers'].items():
            raw=self._buffer_path(b).read_bytes()
            if hashlib.sha256(raw).hexdigest()!=b['sha256']:raise ValueError('artifact buffer hash mismatch')
            blobs[bid]=raw
        return blobs

    def result(self,jid):
        with self.lock:
            row=self._get(jid)
            if not row:return None,None
            raw=self._artifact(row) if row['state'] in ('completed','partial') else None
            return self._public(row),raw

    def cancel(self,jid):
        with self.lock:
            row=self._get(jid)
            if not row:return None
            if row['state'] not in TERMINAL:
                self._update(row,state='cancelled',phase='cancelled');proc=self.active.get(jid)
            else:proc=None
        self.stop_worker(proc);return self.status(jid)

    def cancel_request(self,request_id):
        with self.lock:
            self.cancelled_requests[request_id]=time.monotonic()
            ids=[json.loads(text)['id'] for (text,) in self.db.execute("SELECT record FROM jobs WHERE state IN ('queued','running')")
                 if request_id in json.loads(text).get('requestIds',[json.loads(text)['requestId']])]
        for jid in ids:self.cancel(jid)
        return bool(ids)

    def _run(self,jid):
        started=time.perf_counter();gate=False;proc=None
        def event(row,name):row['trace']['events'][name]=round((time.perf_counter()-started)*1000,3)
        def fail(state,code,message):
            with self.lock:
                row=self._get(jid)
                if row['state'] not in TERMINAL:self._update(row,state=state,phase=state,error={'code':code,'error':message})
        try:
            while not self.gate.acquire(timeout=.1):
                if time.perf_counter()-started>self.policy['queueWallSeconds']:
                    fail('timed-out','job-queue-timeout','转换等待超过队列预算');return
                with self.lock:
                    if self.closed or self._get(jid)['state'] in TERMINAL:return
            gate=True
            with self.lock:
                row=self._get(jid)
                if self.closed or row['state'] in TERMINAL:return
                event(row,'queueExited');self._update(row,state='running',phase='worker-starting')
            is_dxf=row.get('sourceFormat')=='DXF'
            is_dwg=row.get('sourceFormat')=='DWG'
            source=self.root/'sources'/row.get('inputSHA256',row['sourceSHA256'])
            worker_seconds=min(self.policy['workerWallSeconds'],60) if is_dxf else self.policy['workerWallSeconds']
            result_limit=self.dwg_policy['resultBytes'] if is_dwg else self.policy['resultBytes']
            rss_limit=self.dwg_policy['workerRSSBytes'] if is_dwg else self.policy['workerRSSBytes']
            artifact_limit=self.dwg_policy['artifactBytes'] if is_dwg else self.policy['artifactBytes']
            if sum(f.stat().st_size for f in (self.root/'logs').iterdir())+self.policy['stderrBytes']>self.policy['logBytes']:raise JobLimit('log storage quota exceeded')
            with tempfile.TemporaryDirectory(dir=self.root/'temporary') as folder:
                folder=Path(folder);out=folder/'result.json';trace=folder/'trace.json'
                binary_dir=folder/'buffers';binary_dir.mkdir()
                env=dict(os.environ);env.pop('CAD_BINARY_DIR',None);env.pop('CAD_PROFILE_STAGES',None)
                if self.binary:env['CAD_BINARY_DIR']=str(binary_dir)
                env.pop('CAD_COMPACT_METADATA',None)
                if self.compact and not is_dxf and not is_dwg:env['CAD_COMPACT_METADATA']='1'
                env['CAD_TRACE_FILE']=str(trace);env['CAD_TRACE_LIVE']='1'
                env['CAD_STEP_INPUT_BYTES']=str(self.policy['inputBytes'])
                env['CAD_STEP_NAME_CODEPAGE']=row.get('nameCodepage','UTF8')
                if row['partial']:env['CAD_PARTIAL_PREVIEW']='1'
                else:env.pop('CAD_PARTIAL_PREVIEW',None)
                env.pop('CAD_DXF_RESOURCES',None)
                worker_source=source
                allowed_sources={row['sourceSHA256']:row['sourceByteLength']}
                if is_dxf:
                    package_raw=source.read_bytes()
                    if hashlib.sha256(package_raw).hexdigest()!=row['inputSHA256']:
                        raise ValueError('DXF package source integrity mismatch')
                    package=dxf_resources.decode_package(package_raw)
                    if dxf_resources.fingerprint(package)!=row['resourceFingerprint']:
                        raise ValueError('DXF package integrity mismatch')
                    env['CAD_DXF_RESOURCES']=dxf_resources.write_manifest(package,folder)
                    worker_source=folder/'main.dxf';worker_source.write_bytes(package['files'][package['main']])
                    allowed_sources={hashlib.sha256(raw).hexdigest():len(raw) for raw in package['files'].values()}
                wall=time.perf_counter();peak_rss=0
                with worker_source.open('rb') as stdin,out.open('wb') as stdout,(self.root/'logs'/(jid+'.log')).open('wb') as stderr:
                    digest=hashlib.sha256()
                    for chunk in iter(lambda:stdin.read(1024*1024),b''):digest.update(chunk)
                    if digest.hexdigest()!=row['sourceSHA256']:raise ValueError('source integrity mismatch')
                    stdin.seek(0)
                    with self.lock:
                        row=self._get(jid)
                        if row['state'] in TERMINAL:return
                        proc=subprocess.Popen([self.dxf_interpreter if is_dxf else self.dwg_interpreter if is_dwg else self.interpreter,
                                              str(self.app/('dxf_convert.py' if is_dxf else 'dwg_platform_convert.py' if is_dwg else 'step_convert.py')),row['name'],'[]'],
                                              stdin=stdin,stdout=stdout,stderr=stderr,start_new_session=True,env=env)
                        self.active[jid]=proc;event(row,'workerStarted')
                        process_identity=subprocess.run(['ps','-o','lstart=','-o','command=','-p',str(proc.pid)],capture_output=True,text=True).stdout.strip()
                        birth=subprocess.run(['ps','-o','lstart=','-p',str(proc.pid)],capture_output=True,text=True).stdout.strip()
                        self._update(row,phase='worker-started',workerPid=proc.pid,workerProcessIdentity=process_identity,workerBirth=birth)
                    while proc.poll() is None:
                        with self.lock:
                            row=self._get(jid)
                            if self.closed or row['state']=='cancelled':self.stop_worker(proc);return
                        if time.perf_counter()-wall>worker_seconds:
                            self.stop_worker(proc);fail('timed-out','job-timeout','转换超过后台任务计算预算');return
                        size=out.stat().st_size+sum(f.stat().st_size for f in binary_dir.iterdir())
                        if size>result_limit or stderr.tell()>self.policy['stderrBytes']:
                            self.stop_worker(proc);fail('failed','job-output-quota','转换产物或日志超过配额');return
                        usage=subprocess.run(['ps','-o','rss=','-p',str(proc.pid)],capture_output=True,text=True,timeout=2)
                        rss=int(usage.stdout.strip() or 0)*1024;peak_rss=max(peak_rss,rss)
                        if rss>rss_limit:
                            self.stop_worker(proc);fail('failed','job-memory-quota','转换超过后台任务内存预算');return
                        if trace.exists():
                            try:progress=json.loads(trace.read_text())
                            except (ValueError,OSError):progress=None
                            if progress:
                                with self.lock:
                                    current=self._get(jid)
                                    if current['state']=='running' and current.get('workerTrace')!=progress:self._update(current,workerTrace=progress,phase=next(reversed(progress['events'])))
                        time.sleep(.2)
                if out.stat().st_size+sum(f.stat().st_size for f in binary_dir.iterdir())>result_limit:raise JobLimit('result output quota exceeded')
                if time.perf_counter()-wall>worker_seconds:
                    fail('timed-out','job-timeout','转换超过后台任务计算预算');return
                raw=out.read_bytes();envelope=json.loads(raw)
                with self.lock:
                    current=self._get(jid);event(current,'workerCompleted')
                    if current['state'] not in TERMINAL:
                        self._update(current,workerTrace=json.loads(trace.read_text()) if trace.exists() else None)
                if proc.returncode or 'error' in envelope:
                    with self.lock:
                        current=self._get(jid)
                        if current['state'] not in TERMINAL:self._update(current,state='failed',phase='failed',error=envelope,workerPeakRSSBytes=peak_rss)
                    return
                wire_envelope=envelope;envelope=unpack_metadata(wire_envelope)
                document=envelope['document'];sources=document['sources']
                main=next((item for item in sources if item['sha256']==row['sourceSHA256'] and item['name']==row['name']),None)
                expected_format='DWG' if is_dwg else 'DXF' if is_dxf else 'STEP'
                if main is None or main['format']!=expected_format or main['byteLength']!=row['sourceByteLength'] or (not is_dxf and not is_dwg and len(sources)!=1):
                    raise ValueError('worker source identity mismatch')
                if any(allowed_sources.get(item['sha256'])!=item['byteLength'] for item in sources):
                    raise ValueError('worker companion identity mismatch')
                if is_dwg:
                    adapter,dependency='libiaolink-acadsharp-dwg',{'name':'ACadSharp','version':'3.8.30+intersection-field-separation'}
                else:
                    adapter,dependency=('ezdxf-dxf',{'name':'ezdxf','version':'1.4.2'}) if is_dxf else ('occt-xde-step',{'name':'cadquery-ocp','version':'7.8.1.1'})
                if document['adapter']['id']!=adapter or dependency not in document['adapter']['dependencies']:
                    raise ValueError('worker reader identity mismatch')
                completeness=envelope['snapshot']['completeness']
                if is_dxf and completeness not in ('complete','partial'):raise ValueError('DXF job has no installable artifact')
                if is_dwg and completeness!='partial':raise ValueError('DWG job must declare a partial artifact')
                if is_dxf and document['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']['withDisplayGeometry']<1:
                    raise ValueError('DXF has no display geometry')
                if not is_dxf and not is_dwg and not row['partial'] and completeness!='complete':raise ValueError('strict job requires complete geometry')
                blobs={}
                if self.binary:
                    if envelope.get('transportProfile')!='ucd-worker-binary/1':raise ValueError('binary worker transport mismatch')
                    if self.compact and not is_dxf and wire_envelope.get('transportProfile')!=WORKER:raise ValueError('compact worker transport mismatch')
                    entries=envelope.get('bufferResources',[])
                    definitions=document['buffers']
                    if len(entries)!=len(definitions) or {e['id'] for e in entries}!=set(definitions):raise ValueError('worker buffer inventory mismatch')
                    for entry in entries:
                        b=definitions[entry['id']]
                        if entry['byteLength']!=b['byteLength'] or entry['sha256']!=b['sha256']:raise ValueError('worker buffer metadata mismatch')
                    blobs=read_worker_buffers(binary_dir,entries)
                    # Same schema, complete geometry and revision validation as base64.
                    validate_binary_envelope(document,envelope['snapshot'],envelope.get('presentation',{}),blobs.__getitem__)
                    del wire_envelope['bufferResources']  # Temporary paths are never durable/public metadata.
                    raw=json.dumps(wire_envelope,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()
                    out.write_bytes(raw)
                else:validate_envelope(envelope)
                sha=hashlib.sha256(raw).hexdigest()
                with self.lock:
                    current=self._get(jid)
                    if self.closed or current['state'] in TERMINAL:return
                    event(current,'validationCompleted')
                    unique={document['buffers'][bid]['sha256']:blob for bid,blob in blobs.items()}
                    stored=sum(f.stat().st_size for name in ('artifacts','buffers') for f in (self.root/name).iterdir())
                    added=sum(len(blob) for key,blob in unique.items() if not (self.root/'buffers'/key).exists())
                    if stored+len(raw)+added>artifact_limit:raise JobLimit('artifact storage quota exceeded')
                    # Publish buffers first, then the manifest, then terminal metadata.
                    # Interrupted/orphan writes remain unreachable and are pruned.
                    for key,blob in unique.items():
                        temporary=binary_dir/'commit';temporary.write_bytes(blob)
                        temporary.replace(self.root/'buffers'/key)
                    target=self.root/'artifacts'/sha;out.replace(target)
                    event(current,'artifactCommitted')
                    self._update(current,state='partial' if (is_dxf or is_dwg) and completeness=='partial' else 'completed',phase='verified-artifact',artifactSHA256=sha,
                                 artifactBufferSHA256=list(unique),
                                 documentRevision=envelope['document']['revision'],completeness=envelope['snapshot']['completeness'],
                                 artifactBytes=len(raw)+sum(map(len,unique.values())),manifestBytes=len(raw),
                                 workerPeakRSSBytes=peak_rss,workerWallSeconds=time.perf_counter()-wall)
        except Exception as error:
            fail('failed','job-worker-failed',str(error))
        finally:
            if proc is not None and proc.poll() is None:self.stop_worker(proc)
            if proc is not None and proc.stdin is not None and not proc.stdin.closed:
                try:proc.stdin.close()
                except (BrokenPipeError,OSError):pass
            with self.lock:self.active.pop(jid,None);self.threads.pop(jid,None)
            if gate:self.gate.release()

    def close(self):
        with self.lock:
            if self.db_closed:return
            self.closed=True;processes=list(self.active.values());threads=list(self.threads.values())
            for (text,) in self.db.execute("SELECT record FROM jobs WHERE state IN ('queued','running')").fetchall():
                row=json.loads(text);self._update(row,state='failed',phase='server-stopped',error={'code':'server-stopped','error':'服务停止，转换未完成'})
        for proc in processes:self.stop_worker(proc)
        for thread in threads:thread.join(timeout=3)
        with self.lock:
            if not self.threads:
                self.db.close();self.db_closed=True;fcntl.flock(self.owner,fcntl.LOCK_UN);self.owner.close()
