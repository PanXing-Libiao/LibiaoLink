"""Loopback-only local viewer. Isolated workers; STEP uses a temporary directory removed after conversion."""
import base64, hashlib, json, subprocess, sys, threading, os, re, signal, tempfile, secrets, time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
DEV = Path(__file__).resolve().parent
ENGINE = DEV.parent
REPO = ENGINE.parents[1]
BASE = ENGINE / 'core'
WORK = REPO / '.cad-work'
SAMPLE_ROOT = WORK / 'research/viewer/samples'
BROWSER = REPO / 'frontend/public/cad-viewer/core'
sys.path.insert(0, str(BASE))
from unified.transport import ResourceStore,byte_range,read_worker_buffers
from unified.http_encoding import encode_json
from unified.conversion_jobs import ConversionJobs,JobLimit
from unified.input_policy import SYNC_INPUT_BYTES,upload_limits
from unified.compact_transport import unpack_metadata
from unified.dxf_runtime import source_digest as dxf_source_digest
from unified import dxf_resources
SAMPLES={'assembly':'总成改版260707.easm','colibri':'Colibri.easm','verdin':'Verdin.easm','viola':'Viola.easm'}
DXF_SAMPLES={'dxf_flange':'QCAD_flange.dxf','dxf_byblock':'byblock_bylayer.dxf','dxf_r12':'frozen_layers_r12.dxf'}
LOCK=threading.Lock()
CACHE={}
ACTIVE={}
ACTIVE_LOCK=threading.Lock()
PARSE_TIMEOUT=60
RESOURCES=ResourceStore()

def stop_worker(proc):
    if proc is None or proc.poll() is not None:return
    for sig in (signal.SIGTERM,signal.SIGKILL):
        try:os.killpg(os.getpgid(proc.pid),sig)
        except (ProcessLookupError,PermissionError):return
        try:proc.wait(timeout=2);return
        except subprocess.TimeoutExpired:continue

def _rule_version():
    """Parse-affecting source digest; a cache entry from older rules must not be reused."""
    scope=['convert.py','step_convert.py','ucd_convert.py','dxf_convert.py']+['unified/'+p.name for p in sorted((BASE/'unified').glob('*.py'))]+['unified/'+p.name for p in sorted((BASE/'unified').glob('*.json'))]+['unified/schema/'+p.name for p in sorted((BASE/'unified/schema').glob('*.json'))]+['parser/'+p.name for p in sorted((BASE/'parser').glob('*.py'))]
    digest=hashlib.sha256()
    for name in scope:digest.update(name.encode());digest.update((BASE/name).read_bytes())
    digest.update(b'vendor/ezdxf');digest.update(dxf_source_digest().encode())
    for setting in ('CAD_STEP_EXTERNAL_MESH','CAD_STEP_MESHER_PYTHON','CAD_DXF_DWG_READER','CAD_DWG_READER','CAD_DWG_DOTNET','CAD_DWG_PYTHON','CAD_ACIS_PYTHON'):
        digest.update(setting.encode());digest.update(os.environ.get(setting,'').encode())
    return digest.hexdigest()[:16]
RULE_VERSION=_rule_version()
CACHE_UPLOAD_LIMIT=8*1024*1024
_JOBS=None
_JOBS_LOCK=threading.Lock()
_TRACE_LOCK=threading.Lock()

def conversion_jobs():
    global _JOBS
    with _JOBS_LOCK:
        if _JOBS is None:
            _JOBS=ConversionJobs(os.environ.get('CAD_JOB_DIR',str(WORK/'conversion-jobs')),
                                 BASE,LOCK,stop_worker,RULE_VERSION,
                                 os.environ.get('CAD_OCCT_PYTHON',str(WORK/'occt/bin/python')))
        return _JOBS


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(BROWSER),**kw)
    def translate_path(self,path):
        if urlsplit(path).path in ('/','/index.html'):return str(DEV/'index.html')
        if urlsplit(path).path=='/reference.jpg':return str(WORK/'research/viewer/public/reference.jpg')
        return super().translate_path(path)
    def end_headers(self):
        # Entry HTML must revalidate so accepted omissions cannot retain an old UI.
        if urlsplit(self.path).path in ('/','/index.html'):self.send_header('Cache-Control','no-cache')
        super().end_headers()
    def log_message(self,*a): pass
    def allowed(self):
        host=self.headers.get('Host',''); port=self.server.server_port
        return host in (f'127.0.0.1:{port}',f'localhost:{port}') and self.headers.get('Origin',f'http://{host}')==f'http://{host}'
    def reply(self,status,result,headers=None):
        raw=result if isinstance(result,bytes) else json.dumps(result,ensure_ascii=False).encode()
        headers=dict(headers or {})
        headers['Vary']='Accept-Encoding'
        headers['X-CAD-Unencoded-Bytes']=str(len(raw))
        requested=parse_qs(urlsplit(self.path).query).get('compression',[None])[0]
        compressed=(os.environ.get('CAD_HTTP_COMPRESSION','1')=='1' if requested is None else requested=='gzip') or getattr(self,'compression_override',False)
        raw,coding=encode_json(raw,self.headers.get('Accept-Encoding','') if compressed else '')
        headers['X-CAD-Encoded-Bytes']=str(len(raw))
        if coding:headers['Content-Encoding']=coding
        if getattr(self,'trace',None) is not None:
            self.trace['server']['responseReady']=round((time.perf_counter()-self.trace_started)*1000,3)
            self.trace['cache']=headers.get('X-Cache',self.trace.get('cache','none'))
            headers['X-CAD-Trace']=json.dumps(self.trace,separators=(',',':'))

        try:
            self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store')
            for key,value in (headers or {}).items():self.send_header(key,value)
            self.end_headers();self.wfile.write(raw)
            self.wfile.flush()
            if getattr(self,'trace',None) is not None:
                self.trace['server']['responseCompleted']=round((time.perf_counter()-self.trace_started)*1000,3)
                self.trace['responseBytes']=len(raw)
                if os.environ.get('CAD_HTTP_TRACE_FILE'):
                    with _TRACE_LOCK:
                        with open(os.environ['CAD_HTTP_TRACE_FILE'],'a') as out:out.write(json.dumps(self.trace,separators=(',',':'))+'\n')
        except (BrokenPipeError,ConnectionResetError):pass
    def run_parse(self,data,name,key=None,selection=None,model='legacy',transport='base64',request_id=None,partial=False,dxf_package=None):
        if transport not in ('base64','binary') or transport=='binary' and model!='ucd':return self.reply(400,{'error':'unsupported transport'})
        if model not in ('legacy','ucd'):return self.reply(400,{'error':'未知模型接口','code':'unsupported-model'})
        request_id=request_id or secrets.token_hex(12)
        self.trace_started=getattr(self,'accepted_at',time.perf_counter())
        self.trace={'id':request_id,'clock':'server-relative-ms','server':{'requestAccepted':0.0},'worker':None}
        self.trace['server']['uploadCompleted']=round((time.perf_counter()-self.trace_started)*1000,3)
        self.trace['server']['cacheLookup']=round((time.perf_counter()-self.trace_started)*1000,3)
        suffix=Path(name).suffix.lower()
        is_dxf=suffix=='.dxf'
        if is_dxf and model!='ucd':return self.reply(415,{'error':'DXF只能通过统一模型入口','code':'dxf-requires-ucd'})

        if is_dxf and any(value is not None for value in (selection or [])):return self.reply(422,{'error':'DXF没有源配置/显示状态参数','code':'dxf-selection-unsupported'})
        if key is None and len(data)<=CACHE_UPLOAD_LIMIT:key='upload-'+hashlib.sha256(data).hexdigest()
        # Every parameter that changes the parsed artifact is part of the key: file identity,
        # bridge model, input format, strict/partial and legacy configuration/display-state selection.
        # The display name reaches the document (source/drawing names), so it must be part
        # of the key: identical bytes uploaded under another name are a different artifact.
        resource_key=dxf_resources.fingerprint(dxf_package) if dxf_package else None
        cache_key=(key,model,suffix,Path(name).name,partial,tuple(value or '' for value in (selection or [None,None])),resource_key,RULE_VERSION) if key else None
        if cache_key in CACHE:
            raw,cached_manifest=CACHE[cache_key]
            self.trace['server']['cacheHit']=round((time.perf_counter()-self.trace_started)*1000,3)
            try:cached_profile=json.loads(raw).get('transportProfile')
            except ValueError:cached_profile=None
            if transport=='base64':
                # A worker-binary cache entry has no bufferPayloads; serving it as base64
                # would hand the client a manifest it cannot hydrate.
                if cached_profile=='ucd-base64-envelope/1':return self.reply(200,raw,{'X-Cache':'hit','X-Parse-Ms':'0'})
            elif cached_manifest is not None:
                try:lease=json.loads(cached_manifest)['resourceLease']
                except (ValueError,KeyError):lease=None
                if lease and RESOURCES.alive(lease):return self.reply(200,cached_manifest,{'X-Cache':'hit','X-Parse-Ms':'0'})
            elif cached_profile=='ucd-base64-envelope/1':return self.deliver(raw,'binary',{'X-Cache':'hit','X-Parse-Ms':'0'})
            # A worker-binary cache entry has no encoded payloads left; its files were
            # temporary, so an expired lease means the sample must be parsed again.
        self.trace['server'].pop('cacheHit',None)
        self.trace['server']['queueEntered']=round((time.perf_counter()-self.trace_started)*1000,3)
        if not LOCK.acquire(blocking=False): return self.reply(429,{'error':'另一个文件正在解析，请稍后重试','code':'parse-busy'})
        self.trace['server']['queueExited']=round((time.perf_counter()-self.trace_started)*1000,3)
        try:
            is_step=suffix in ('.step','.stp')
            if is_step and model!='ucd':return self.reply(415,{'error':'STEP必须通过统一模型入口'})
            worker='step_convert.py' if is_step else 'dxf_convert.py' if is_dxf else 'ucd_convert.py' if model=='ucd' else 'convert.py'
            if is_step:interpreter=os.environ.get('CAD_OCCT_PYTHON',str(WORK/'occt/bin/python'))
            elif is_dxf:interpreter=os.environ.get('CAD_DXF_PYTHON',str(WORK/'dxf/bin/python'))
            else:interpreter=sys.executable
            if is_step and not Path(interpreter).is_file():return self.reply(422,{'error':'未配置固定版本OCCT环境；请设置CAD_OCCT_PYTHON','code':'missing-occt-runtime'})
            if is_dxf and not Path(interpreter).is_file():return self.reply(422,{'error':'未配置固定版本ezdxf环境；请设置CAD_DXF_PYTHON','code':'missing-dxf-runtime'})
            binary=transport=='binary' and model=='ucd' and not is_step and os.environ.get('CAD_WORKER_BINARY','1')!='0'
            with tempfile.TemporaryDirectory() as folder:
                env=dict(os.environ);env['CAD_TRACE_FILE']=str(Path(folder)/'trace.json');env['CAD_TRACE_LIVE']='1'
                env.pop('CAD_STEP_INPUT_BYTES',None)
                env.pop('CAD_DXF_RESOURCES',None)
                if dxf_package:env['CAD_DXF_RESOURCES']=dxf_resources.write_manifest(dxf_package,folder)
                if binary:env['CAD_BINARY_DIR']=folder
                else:env.pop('CAD_BINARY_DIR',None)
                if partial:env['CAD_PARTIAL_PREVIEW']='1'
                else:env.pop('CAD_PARTIAL_PREVIEW',None)
                parse_started=time.perf_counter()
                self.trace['server']['workerStart']=round((parse_started-self.trace_started)*1000,3)
                proc=subprocess.Popen([interpreter,str(BASE/worker),name,json.dumps(selection or [])],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env=env)
                with ACTIVE_LOCK:ACTIVE[request_id]=proc
                try:
                    try:out,err=proc.communicate(data,timeout=PARSE_TIMEOUT)
                    except subprocess.TimeoutExpired:
                        stop_worker(proc);proc.communicate()
                        trace_file=Path(env['CAD_TRACE_FILE'])
                        if trace_file.exists():self.trace['worker']=json.loads(trace_file.read_text())
                        self.trace['server']['workerStopped']=round((time.perf_counter()-self.trace_started)*1000,3)
                        return self.reply(422,{'error':'解析超过60秒，已停止；本文件尚未支持','code':'parse-timeout'})
                finally:
                    with ACTIVE_LOCK:ACTIVE.pop(request_id,None)
                if proc.returncode and proc.returncode<0:return self.reply(499,{'error':'本次解析已取消','code':'parse-cancelled'})
                self.trace['server']['workerEnd']=round((time.perf_counter()-self.trace_started)*1000,3)
                trace_file=Path(env['CAD_TRACE_FILE'])
                if trace_file.exists():self.trace['worker']=json.loads(trace_file.read_text())
                result=json.loads(out)
                if proc.returncode or 'error' in result:return self.reply(422,result)
                if binary:
                    if result.get('transportProfile')!='ucd-worker-binary/1':raise ValueError('worker did not emit binary buffers')
                    blobs=read_worker_buffers(folder,result.get('bufferResources',[]))
                    manifest=RESOURCES.publish_binary(result,blobs)
                    manifest_raw=json.dumps(manifest,ensure_ascii=False).encode()
                    if cache_key:CACHE[cache_key]=(out,manifest_raw)
                    return self.reply(200,manifest,{'X-Parse-Ms':f'{round((time.perf_counter()-parse_started)*1000,1)}','X-Cache':'miss'})
                if cache_key:CACHE[cache_key]=(out,None)
                self.deliver(out,transport,{'X-Parse-Ms':f'{round((time.perf_counter()-parse_started)*1000,1)}','X-Cache':'miss'})
        except subprocess.TimeoutExpired: self.reply(422,{'error':'解析超过60秒，已停止；本文件尚未支持','code':'parse-timeout'})
        except (ValueError,OSError): self.reply(500,{'error':'本地解析进程异常，请检查Python环境','code':'worker-failed'})
        finally: LOCK.release()
    def deliver(self,raw,transport,headers=None,blobs=None):
        if blobs is not None:
            envelope=raw if isinstance(raw,dict) else json.loads(raw)
            if transport=='base64':
                envelope=unpack_metadata(envelope)
                envelope.update(transportProfile='ucd-base64-envelope/1',
                                bufferPayloads={bid:base64.b64encode(blob).decode('ascii') for bid,blob in blobs.items()})
                return self.reply(200,envelope,headers)
            try:manifest=RESOURCES.publish_binary(envelope,blobs)
            except ValueError as error:return self.reply(422,{'error':str(error),'code':'invalid-or-unavailable-resources'})
            try:self.reply(200,manifest,headers)
            except (BrokenPipeError,ConnectionResetError):RESOURCES.release(manifest['resourceLease'])
            return
        if transport=='base64':return self.reply(200,raw,headers)
        try:manifest=RESOURCES.publish(json.loads(raw))
        except ValueError as error:return self.reply(422,{'error':str(error),'code':'invalid-or-unavailable-resources'})
        try:self.reply(200,manifest,headers)
        except (BrokenPipeError,ConnectionResetError):RESOURCES.release(manifest['resourceLease'])
    def do_DELETE(self):
        if not self.allowed():return self.reply(403,{'error':'origin denied'})
        m=re.fullmatch(r'/api/resources/([a-f0-9]{48})',self.path)
        if not m:return self.reply(404,{'error':'invalid lease'})
        RESOURCES.release(m[1]);return self.reply(200,{'released':True})
    def resource(self,path):
        m=re.fullmatch(r'/api/resources/([a-f0-9]{48})/([a-f0-9]{64})',path)
        raw=RESOURCES.get(m[1],m[2]) if m else None
        if raw is None:return self.reply(404,{'error':'resource missing or expired'})
        start,end=0,len(raw)-1;status=200
        if self.headers.get('Range'):
            try:start,end=byte_range(self.headers['Range'],len(raw));status=206
            except ValueError:
                self.send_response(416);self.send_header('Content-Range',f'bytes */{len(raw)}');self.send_header('Content-Length','0');self.end_headers();return
        self.send_response(status);self.send_header('Content-Type','application/octet-stream');self.send_header('Accept-Ranges','bytes');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(end-start+1))
        if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{len(raw)}')
        self.end_headers()
        try:self.wfile.write(raw[start:end+1])
        except (BrokenPipeError,ConnectionResetError):pass
    def do_GET(self):
        if not self.allowed(): return self.reply(403,{'error':'仅允许同源本地访问'})
        parsed=urlsplit(self.path)
        if parsed.path=='/api/limits':return self.reply(200,upload_limits())
        match=re.fullmatch(r'/api/jobs/([a-f0-9]{32})(/result)?',parsed.path)
        if match:
            try:jobs=conversion_jobs()
            except JobLimit as error:return self.reply(503,{'error':str(error),'code':'job-store-busy'})
            jid=match[1]
            if not match[2]:
                row=jobs.status(jid)
                return self.reply(200,row) if row else self.reply(404,{'error':'job not found','code':'job-not-found'})
            row,raw=jobs.result(jid)
            if row is None:return self.reply(404,{'error':'job not found','code':'job-not-found'})
            if raw is None:return self.reply(409,{'error':'job has no verified artifact','code':'job-result-unavailable','job':row})
            transport=parse_qs(parsed.query).get('transport',['binary'])[0]
            if transport not in ('base64','binary'):return self.reply(400,{'error':'unsupported transport'})
            self.trace_started=time.perf_counter();self.trace={'id':parse_qs(parsed.query).get('requestId',[row['requestId']])[0],
                'clock':'server-relative-ms','server':{'requestAccepted':0.,'cacheLookup':0.},'worker':row.get('workerTrace'),
                'jobId':jid,'jobTrace':row['trace']}
            try:
                blobs=None
                if row.get('artifactTransport')=='binary':
                    envelope=json.loads(raw);blobs=jobs.buffers(envelope)
                    if parse_qs(parsed.query).get('metadata')==['full']:envelope=unpack_metadata(envelope)
            except (ValueError,OSError) as error:return self.reply(409,{'error':str(error),'code':'job-result-unavailable'})
            return self.deliver(envelope if blobs is not None else raw,transport,{'X-Cache':'job-verified','X-Parse-Ms':'0',
                               'X-CAD-Artifact-Bytes':str(row.get('artifactBytes',len(raw)))},blobs)
        if parsed.path.startswith('/api/resources/'):return self.resource(parsed.path)
        if parsed.path=='/api/sample':
            key=parse_qs(parsed.query).get('id',[''])[0]
            if key in DXF_SAMPLES:
                name=DXF_SAMPLES[key]
                return self.run_parse((SAMPLE_ROOT/name).read_bytes(),name,key,model='ucd',transport='base64',
                                      request_id=parse_qs(parsed.query).get('requestId',[None])[0])
            if key not in SAMPLES: return self.reply(404,{'error':'样本不存在'})
            query=parse_qs(parsed.query)
            model=query.get('model',['legacy'])[0]
            name=SAMPLES[key];return self.run_parse((SAMPLE_ROOT/name).read_bytes(),name,key,model=model,transport=query.get('transport',['base64'])[0],request_id=query.get('requestId',[None])[0],partial=query.get('partial',['0'])[0]=='1')
        if parsed.path=='/api/schema':
            version=parse_qs(parsed.query).get('version',['2.0.0'])[0]
            if version not in ('1.0.0','2.0.0'):return self.reply(400,{'error':'未知Schema版本'})
            return self.reply(200,(BASE/('unified/schema/ucd-'+version[:3]+'.schema.json')).read_bytes())
        if parsed.path.startswith('/api/'): return self.reply(404,{'error':'接口不存在'})
        return super().do_GET()
    def do_POST(self):
        if not self.allowed(): return self.reply(403,{'error':'仅允许同源本地访问'})
        parsed=urlsplit(self.path)
        query=parse_qs(parsed.query)
        match=re.fullmatch(r'/api/jobs/([a-f0-9]{32})/cancel',parsed.path)
        if match:
            try:row=conversion_jobs().cancel(match[1])
            except JobLimit as error:return self.reply(503,{'error':str(error),'code':'job-store-busy'})
            return self.reply(200,row) if row else self.reply(404,{'error':'job not found'})
        if parsed.path=='/api/cancel':
            request_id=query.get('requestId',[None])[0]
            if not request_id or not re.fullmatch(r'[a-f0-9]{8,64}',request_id):return self.reply(400,{'error':'invalid request id'})
            with ACTIVE_LOCK:proc=ACTIVE.get(request_id)
            stop_worker(proc)
            try:cancelled_job=conversion_jobs().cancel_request(request_id)
            except JobLimit:cancelled_job=False
            return self.reply(200,{'cancelled':bool(proc) or cancelled_job,'requestId':request_id})
        if parsed.path not in ('/api/parse','/api/parse-dxf-bundle','/api/jobs'): return self.reply(404,{'error':'接口不存在'})
        try: n=int(self.headers.get('Content-Length','0'))
        except ValueError: return self.reply(400,{'error':'文件长度无效'})
        name=Path(query.get('name',[''])[0]).name
        limit=upload_limits()['stepJobInputBytes'] if parsed.path=='/api/jobs' else dxf_resources.MAX_WIRE_BYTES if parsed.path=='/api/parse-dxf-bundle' else SYNC_INPUT_BYTES
        if not 0<n<=limit:return self.reply(413,{'error':f'请选择不超过{limit//(1024*1024)} MiB的非空文件','code':'input-limit-exceeded','maxBytes':limit})
        if Path(name).suffix.lower() not in ('.easm','.step','.stp','.dxf'): return self.reply(415,{'error':'不支持此文件类型','code':'unsupported-file-type'})
        self.connection.settimeout(30)
        self.accepted_at=time.perf_counter()
        selection=[query.get('configuration',[None])[0],query.get('displayState',[None])[0]]
        if any(v is not None and len(v)>4096 for v in selection):return self.reply(400,{'error':'状态参数过长'})
        if parsed.path=='/api/jobs':
            if query.get('model',[''])[0]!='ucd' or any(v is not None for v in selection) or Path(name).suffix.lower() not in ('.step','.stp'):
                return self.reply(422,{'error':'后台转换只接受无配置参数的 STEP 统一模型','code':'unsupported-job-input'})
            interpreter=os.environ.get('CAD_OCCT_PYTHON',str(WORK/'occt/bin/python'))
            if not Path(interpreter).is_file():return self.reply(422,{'error':'未配置固定版本 OCCT 环境','code':'missing-occt-runtime'})
            request_id=query.get('requestId',[''])[0] or secrets.token_hex(12)
            if not re.fullmatch(r'[a-f0-9]{8,64}',request_id):return self.reply(400,{'error':'invalid request id'})
            request_trace={'clock':'upload-server-relative-ms','events':{'requestReceived':0.}}
            try:
                row,reused=conversion_jobs().submit_stream(self.rfile,n,name,query.get('partial',['0'])[0]=='1',request_id,request_trace,self.accepted_at)
            except JobLimit as error:return self.reply(429,{'error':str(error),'code':'job-quota'})
            except ValueError as error:return self.reply(400,{'error':str(error),'code':'invalid-job'})
            except (TimeoutError,ConnectionError):return self.reply(408,{'error':'文件传输中断或超时','code':'upload-interrupted'})
            return self.reply(200 if reused else 202,{'job':row,'reused':reused})
        data=self.rfile.read(n)
        if len(data)!=n:return self.reply(400,{'error':'文件传输不完整'})
        package=None
        if parsed.path=='/api/parse-dxf-bundle':
            if Path(name).suffix.lower()!='.dxf' or query.get('model',[''])[0]!='ucd' or any(v is not None for v in selection):
                return self.reply(422,{'error':'配套文件入口只接受 DXF 统一模型','code':'invalid-dxf-package'})
            try:
                package=dxf_resources.decode_package(data)
                if Path(package['main']).name!=name:raise ValueError('主文件名与资源包不一致')
                data=package['files'][package['main']]
            except (ValueError,TypeError,KeyError,AttributeError) as error:
                return self.reply(400,{'error':str(error),'code':'invalid-dxf-package'})
        self.run_parse(data,name,selection=selection,model=query.get('model',['legacy'])[0],transport=query.get('transport',['base64'])[0],request_id=query.get('requestId',[None])[0],partial=query.get('partial',['0'])[0]=='1',dxf_package=package)
if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description='LibiaoLink CAD local workbench')
    parser.add_argument('port',type=int,nargs='?',default=8795)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if args.check:
        checks=[('occt','from OCP.STEPCAFControl import STEPCAFControl_Reader'),
                ('step-mesher','import gmsh, numpy'),
                ('dxf','from unified.dxf_runtime import require_engine; require_engine()')]
        for role,code in checks:
            subprocess.run([str(WORK/role/'bin/python'),'-c',code],cwd=BASE,check=True)
        missing=[name for name in [*SAMPLES.values(),*DXF_SAMPLES.values()] if not (SAMPLE_ROOT/name).is_file()]
        if missing:raise SystemExit('Missing local samples: '+', '.join(missing))
        print('OCP, mesher, editable DXF source and local samples: ready')
        raise SystemExit(0)
    port=args.port
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    print(f'CAD验证版：http://127.0.0.1:{port}  按Ctrl+C停止',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        if _JOBS is not None:_JOBS.close()
