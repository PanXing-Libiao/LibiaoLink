"""Bounded independent face meshing after the existing native repair routes."""
import hashlib,json,math,os,subprocess,sys,tempfile,time
from pathlib import Path

ENGINE='4.15.2'
MAX_OUTPUT_BYTES=16*1024*1024
CHILD_RSS_BYTES=768*1024*1024
FACE_SECONDS=30.
DOCUMENT_SECONDS=90.

def _execute(interpreter,source,target,size,timeout):
    from . import worker_trace
    start=time.monotonic();proc=None;usage=None
    try:
        with target.with_suffix('.log').open('wb') as log:
            env=dict(os.environ,PYTHONNOUSERSITE='1');env.pop('PYTHONPATH',None)
            # Inherit the worker group so cancellation ends both CAD processes.
            proc=subprocess.Popen([str(interpreter),str(Path(__file__).with_name('step_mesher_worker.py')),str(source),str(target),'--size',str(size)],stdout=log,stderr=subprocess.STDOUT,env=env)
            next_rss=0.
            while True:
                pid,status,observed_usage=os.wait4(proc.pid,os.WNOHANG)
                if pid:proc.returncode=os.waitstatus_to_exitcode(status);usage=observed_usage;break
                elapsed=time.monotonic()-start
                if elapsed>=timeout:raise TimeoutError('independent-mesher-timeout')
                if log.tell()>256*1024 or target.exists() and target.stat().st_size>MAX_OUTPUT_BYTES:raise ValueError('independent-mesher-output-budget')
                if elapsed>=next_rss:
                    observed=subprocess.run(['ps','-o','rss=','-p',str(proc.pid)],capture_output=True,text=True,timeout=2)
                    if observed.stdout.strip() and int(observed.stdout.strip())*1024>CHILD_RSS_BYTES:raise ValueError('independent-mesher-memory-limit')
                    next_rss=elapsed+.25
                time.sleep(.04)
            if proc.returncode!=0:raise ValueError('independent-mesher-process-exit-'+str(proc.returncode))
        if not target.is_file() or target.stat().st_size>MAX_OUTPUT_BYTES:raise ValueError('independent-mesher-output-unavailable')
        result=json.loads(target.read_text())
        if not isinstance(result,dict):raise ValueError('invalid-independent-mesher-output')
        if result.get('error'):raise ValueError('independent-mesher: '+str(result['error'])[:512])
        return result
    finally:
        if proc is not None and proc.returncode is None:
            proc.terminate();deadline=time.monotonic()+2
            while proc.returncode is None:
                pid,status,observed_usage=os.wait4(proc.pid,os.WNOHANG)
                if pid:proc.returncode=os.waitstatus_to_exitcode(status);usage=observed_usage;break
                if time.monotonic()>=deadline:
                    proc.kill();_,status,usage=os.wait4(proc.pid,0);proc.returncode=os.waitstatus_to_exitcode(status);break
                time.sleep(.04)
        peak=(usage.ru_maxrss if sys.platform=='darwin' else usage.ru_maxrss*1024) if usage else None
        worker_trace.mesher_finished(peak,(time.monotonic()-start)*1000)

class ExternalMeshContext:
    def __init__(self):
        self.enabled=os.environ.get('CAD_STEP_EXTERNAL_MESH','1')=='1'
        root=Path(__file__).resolve().parents[2]
        self.interpreter=Path(os.environ.get('CAD_STEP_MESHER_PYTHON',str(root/'.phase-work/step-mesher/bin/python')))
        self.remaining=DOCUMENT_SECONDS;self.attempts=[];self.used=False

    def recover(self,face):
        from OCP.BRepBndLib import BRepBndLib
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.BRepGProp import BRepGProp
        from OCP.BRepTools import BRepTools
        from OCP.Bnd import Bnd_Box
        from OCP.GProp import GProp_GProps
        from .step_mesh_validation import validate_external_mesh
        from .step_repair_quality import MICRO_FACE_AREA_MM2
        if not self.enabled:return None
        base={'method':'independent-gmsh-source-face','engine':'gmsh','engineVersion':ENGINE}
        if not self.interpreter.is_file():
            self.attempts.append({**base,'status':'unavailable','reason':'fixed-version-mesher-runtime-not-configured'});return None
        try:
            if not BRepCheck_Analyzer(face).IsValid():raise ValueError('invalid-source-brep')
            props=GProp_GProps();BRepGProp.SurfaceProperties_s(face,props);area=abs(props.Mass())
            if not math.isfinite(area) or area<=1e-9:raise ValueError('numerically-degenerate-source-area')
            box=Bnd_Box();BRepBndLib.AddOptimal_s(face,box,False,False)
            if box.IsVoid() or box.IsOpen():raise ValueError('source-bounds-unavailable')
            bounds=box.Get();diag2=sum((bounds[i+3]-bounds[i])**2 for i in range(3))
            if not math.isfinite(diag2) or diag2<=0 or area/diag2<1e-9:raise ValueError('numerically-degenerate-source-domain')
        except Exception as error:
            self.attempts.append({**base,'status':'not-applicable','reason':str(error)[:512]});return None
        # Local fallback settings depend on geometry size, never file identity.
        sizes=(.002,.0005) if area<=MICRO_FACE_AREA_MM2 else (.08,.02)
        # The server removes this parent even when the worker group is killed.
        trace=os.environ.get('CAD_TRACE_FILE');parent=Path(trace).parent if trace else None
        with tempfile.TemporaryDirectory(prefix='cad-face-mesh-',dir=parent) as folder:
            source=Path(folder)/'face.brep';target=Path(folder)/'mesh.json'
            if not BRepTools.Write_s(face,str(source)) or source.stat().st_size>MAX_OUTPUT_BYTES:
                self.attempts.append({**base,'status':'failed','reason':'source-face-export-budget'});return None
            source_sha=hashlib.sha256(source.read_bytes()).hexdigest()
            for size in sizes:
                row={**base,'maxElementSizeMM':size,'sourceFaceBRepSHA256':source_sha};self.attempts.append(row)
                if self.remaining<=0:row.update(status='budget-exhausted',reason='document-independent-mesher-budget');break
                began=time.monotonic()
                try:
                    target.unlink(missing_ok=True)
                    raw=_execute(self.interpreter,source,target,size,min(FACE_SECONDS,self.remaining))
                    if raw.get('engine')!='gmsh' or raw.get('version')!=ENGINE or raw.get('sourceSHA256')!=source_sha:raise ValueError('independent-mesher-source-or-version-mismatch')
                    result=validate_external_mesh(face,raw)
                    result['validation']['duplicateNodeRowsCollapsed']=raw.get('duplicateNodeRowsCollapsed',0)
                    row['status']='accepted';self.used=True
                    result['validation'].update(engine='gmsh',engineVersion=ENGINE,sourceFaceBRepSHA256=source_sha,maxElementSizeMM=size,algorithm=2)
                    return result
                except Exception as error:row.update(status='rejected',reason=str(error)[:512])
                finally:self.remaining-=time.monotonic()-began
        return None
