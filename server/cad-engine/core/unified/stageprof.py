"""Opt-in stage profiler for adapter work. Disabled unless CAD_PROFILE_STAGES is set.

It records wall time, process peak RSS (ru_maxrss) and current RSS (ps) at named
stage boundaries. It must not alter CAD results; every record is measurement only.
"""
import json,os,resource,subprocess,threading,time

_LOCK=threading.Lock()

def current_rss():
    try:
        out=subprocess.run(['ps','-o','rss=','-p',str(os.getpid())],capture_output=True,text=True,timeout=5).stdout.strip()
        return int(out)*1024 if out else None
    except (OSError,ValueError,subprocess.SubprocessError):
        return None

class StageProfiler:
    def __init__(self,path):
        self.path=path;self.started=time.perf_counter();self.counts={};self._sums={};self._hits={};self._last=self.started;self.leaf=None;self.leaf_started=None;self.leaf_stages={}
        open(path,'w').close()
    def bump(self,name,seconds,count=1):
        """Accumulate inner-loop time without writing a line per call."""
        self._sums[name]=self._sums.get(name,0.0)+seconds
        self._hits[name]=self._hits.get(name,0)+count
    def flush(self):
        for name in sorted(self._sums):
            self.mark(name,count=self._hits[name],seconds=round(self._sums[name],4))
    def memory(self):
        return {'peakRSS':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'currentRSS':None}
    def mark(self,stage,count=1,**fields):
        now=time.perf_counter()
        if self.leaf is not None and 'seconds' in fields:self.leaf_stages[stage]=self.leaf_stages.get(stage,0)+fields['seconds']
        record={'leaf':self.leaf,'stage':stage,'atSeconds':round(now-self.started,4),'deltaSeconds':round(now-self._last,4),'count':count,**self.memory(),**fields}
        self._last=now
        with _LOCK:
            with open(self.path,'a') as log:log.write(json.dumps(record,ensure_ascii=False)+'\n')

_PROFILER=None

def profiler():
    return _PROFILER

def enable(path):
    global _PROFILER
    _PROFILER=StageProfiler(path)
    return _PROFILER

def mark(stage,count=1,**fields):
    if _PROFILER is not None:_PROFILER.mark(stage,count,**fields)

class context:
    """Accumulating stage timer for hot inner loops such as tessellation."""
    def __init__(self,stage):
        self.stage=stage
    def __enter__(self):
        self.t0=time.perf_counter();return self
    def __exit__(self,*exc):
        self.seconds=time.perf_counter()-self.t0
        if _PROFILER is not None:_PROFILER.mark(self.stage,seconds=round(self.seconds,4))
        return False

def begin_leaf(key,name):
    if _PROFILER is not None:
        _PROFILER.leaf={'entry':key,'name':name}
        _PROFILER.leaf_started=time.perf_counter()
        _PROFILER.leaf_stages={}

def end_leaf(**fields):
    if _PROFILER is not None:
        elapsed=time.perf_counter()-_PROFILER.leaf_started
        stages=dict(_PROFILER.leaf_stages)
        _PROFILER.mark('leaf-total',inclusiveSeconds=elapsed,
                       exclusiveOtherSeconds=max(0,elapsed-sum(stages.values())),
                       childStageSeconds=stages,**fields)
        _PROFILER.leaf=None
