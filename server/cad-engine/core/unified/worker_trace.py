"""Request-local timings, never serialized into the revisioned CAD document."""
import json,os,resource,sys,time
from pathlib import Path
_STARTED=time.perf_counter()
_EVENTS={'workerEntry':0.0}
_METRICS={}
def mesher_finished(peak,wall_ms):
    _METRICS['externalMesherProcesses']=_METRICS.get('externalMesherProcesses',0)+1
    _METRICS['externalMesherWallMS']=round(_METRICS.get('externalMesherWallMS',0)+wall_ms,3)
    if peak is not None:_METRICS['externalMesherPeakRSSBytes']=max(_METRICS.get('externalMesherPeakRSSBytes',0),peak)
    if os.environ.get('CAD_TRACE_LIVE')=='1':_write()
def mark(name):
    _EVENTS[name]=round((time.perf_counter()-_STARTED)*1000,3)
    if os.environ.get('CAD_TRACE_LIVE')=='1':_write()
def _write():
    path=os.environ.get('CAD_TRACE_FILE')
    if path:
        target=Path(path);temporary=target.with_suffix('.tmp')
        temporary.write_text(json.dumps({'clock':'worker-relative-ms','events':_EVENTS,**_METRICS}));temporary.replace(target)
def finish():
    rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    _METRICS['peakRSSBytes']=rss if sys.platform=='darwin' else rss*1024
    mark('workerResultReady')
    _write()
