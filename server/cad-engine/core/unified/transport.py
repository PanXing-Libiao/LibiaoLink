"""Bounded process-local binary leases. UCD document/snapshot remain unchanged."""
import base64,hashlib,re,secrets,threading,time

class ResourceStore:
    def __init__(self,limit=256*1024*1024,ttl=300):
        self.limit=limit;self.ttl=ttl;self.leases={};self.lock=threading.Lock()
    def _expire(self):
        now=time.monotonic()
        for key in list(self.leases):
            if self.leases[key][0]<=now:del self.leases[key]
    def publish(self,envelope):
        if envelope['transportProfile']!='ucd-base64-envelope/1' or envelope['document'].get('schemaVersion')!='2.0.0':raise ValueError('invalid transport')
        blobs={};refs={};token=secrets.token_hex(24)
        for bid,b in envelope['document']['buffers'].items():
            raw=base64.b64decode(envelope['bufferPayloads'][bid],validate=True)
            if len(raw)!=b['byteLength'] or hashlib.sha256(raw).hexdigest()!=b['sha256']:raise ValueError('buffer integrity mismatch')
            blobs[b['sha256']]=raw;refs[bid]={'url':f'/api/resources/{token}/{b["sha256"]}','sha256':b['sha256'],'byteLength':len(raw)}
        size=sum(map(len,blobs.values()))
        with self.lock:
            self._expire()
            if size+sum(sum(map(len,v[1].values())) for v in self.leases.values())>self.limit:raise ValueError('resource quota exceeded')
            self.leases[token]=(time.monotonic()+self.ttl,blobs)
        return {**{k:v for k,v in envelope.items() if k!='bufferPayloads'},'transportProfile':'ucd-binary-manifest/1','resourceLease':token,'bufferResources':refs}
    def publish_binary(self,envelope,blobs):
        """Publish a ucd-worker-binary manifest whose bytes were written by the worker.

        blobs maps bufferId -> bytes; the caller has already read the files and is
        responsible for removing them. Integrity is re-checked here so a worker bug
        cannot publish bytes that disagree with document.buffers.
        """
        profile=envelope.get('transportProfile')
        if profile not in ('ucd-worker-binary/1','ucd-worker-binary-compact/1') or envelope.get('document',{}).get('schemaVersion')!='2.0.0':raise ValueError('invalid transport')
        refs={};store={};token=secrets.token_hex(24)
        for bid,b in envelope['document']['buffers'].items():
            raw=blobs.get(bid)
            if not isinstance(raw,(bytes,bytearray)) or len(raw)!=b['byteLength'] or hashlib.sha256(raw).hexdigest()!=b['sha256']:raise ValueError('buffer integrity mismatch')
            store[b['sha256']]=bytes(raw);refs[bid]={'url':f'/api/resources/{token}/{b["sha256"]}','sha256':b['sha256'],'byteLength':len(raw)}
        size=sum(map(len,store.values()))
        with self.lock:
            self._expire()
            if size+sum(sum(map(len,v[1].values())) for v in self.leases.values())>self.limit:raise ValueError('resource quota exceeded')
            self.leases[token]=(time.monotonic()+self.ttl,store)
        return {**{k:v for k,v in envelope.items() if k not in ('bufferPayloads',)},'transportProfile':'ucd-binary-compact/1' if profile=='ucd-worker-binary-compact/1' else 'ucd-binary-manifest/1','resourceLease':token,'bufferResources':refs}
    def alive(self,token):
        with self.lock:self._expire();return token in self.leases
    def release(self,token):
        with self.lock:self.leases.pop(token,None)
    def get(self,token,sha):
        with self.lock:
            self._expire();return self.leases.get(token,(0,{}))[1].get(sha)

def read_worker_buffers(folder,entries):
    """Read worker-written buffers without leaving the temporary directory.

    The worker is a separate process: a bug must not be able to publish bytes from
    outside its directory, from a symlink, or from a non-regular file.
    """
    import os
    root=os.path.realpath(folder);blobs={}
    for entry in entries:
        raw=os.path.abspath(entry['path'])
        if os.path.islink(raw):raise ValueError('worker buffer path is a symlink')
        path=os.path.realpath(raw)
        if os.path.dirname(path)!=root or os.path.basename(path)!=f"{entry['id']}.bin":raise ValueError('worker buffer path escaped its directory')
        if not os.path.isfile(path):raise ValueError('worker buffer is not a regular file')
        with open(path,'rb') as handle:blobs[entry['id']]=handle.read()
    return blobs


def byte_range(value,length):
    """Single explicit byte range only. Unsupported/malformed ranges reject."""
    m=re.fullmatch(r'bytes=(\d+)-(\d*)',value or '')
    if not m:raise ValueError('unsupported range')
    start=int(m[1]);end=int(m[2]) if m[2] else length-1
    if start>=length or end<start:raise ValueError('unsatisfiable range')
    return start,min(end,length-1)
