"""Bounded process-local binary leases. UCD document/snapshot remain unchanged."""
import base64,hashlib,json,re,secrets,threading,time

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
        name=entry.get('file')
        if not isinstance(name,str) or name!=f"{entry['id']}.bin":raise ValueError('worker buffer file name is invalid')
        raw=os.path.join(folder,name)
        if os.path.islink(raw):raise ValueError('worker buffer path is a symlink')
        path=os.path.realpath(raw)
        if os.path.dirname(path)!=root or os.path.basename(path)!=name:raise ValueError('worker buffer path escaped its directory')
        if not os.path.isfile(path):raise ValueError('worker buffer is not a regular file')
        with open(path,'rb') as handle:blobs[entry['id']]=handle.read()
    return blobs


def _json_value_end(data,start):
    '''Return the byte offset just after one JSON object/array value.'''
    if start>=len(data) or data[start] not in b"{[":raise ValueError('json value is missing')
    depth=0;in_string=False;escaped=False
    for index in range(start,len(data)):
        byte=data[index]
        if in_string:
            if escaped:escaped=False
            elif byte==92:escaped=True
            elif byte==34:in_string=False
        elif byte==34:in_string=True
        elif byte in b"{[":depth+=1
        elif byte in b"]}":
            depth-=1
            if depth==0:return index+1
    raise ValueError('json value is unterminated')

def public_worker_manifest(raw,token):
    '''Replace relative worker buffers with public refs without re-encoding the document.

    DWG's canonical worker manifest places bufferResources first. Only that small
    table is parsed; the 100 MB-scale document/snapshot bytes are copied verbatim.
    Returns None for other layouts so callers retain the general fallback.
    '''
    body=raw.rstrip();prefix=b'{\x22bufferResources\x22:'
    if not body.startswith(prefix) or not body.endswith(b'}'):return None
    start=len(prefix);end=_json_value_end(body,start)
    entries=json.loads(body[start:end].decode('utf-8'))
    if not isinstance(entries,list) or not entries:return None
    resources={}
    for entry in entries:
        if not isinstance(entry,dict):return None
        bid=entry.get('id');sha=entry.get('sha256');length=entry.get('byteLength');file=entry.get('file')
        if not isinstance(bid,str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}',bid) or bid in resources:return None
        if not isinstance(sha,str) or not re.fullmatch(r'[a-f0-9]{64}',sha):return None
        if type(length) is not int or not 0<=length<=256*1024*1024 or file!=f'{bid}.bin':return None
        resources[bid]={'url':f'/api/resources/{token}/{sha}','sha256':sha,'byteLength':length}
    suffix=body[end:]
    if b'\x22resourceLease\x22' in suffix:return None
    worker=b'\x22transportProfile\x22:\x22ucd-worker-binary/1\x22'
    compact=b'\x22transportProfile\x22:\x22ucd-worker-binary-compact/1\x22'
    if worker in suffix:suffix=suffix.replace(worker,b'\x22transportProfile\x22:\x22ucd-binary-manifest/1\x22',1)
    elif compact in suffix:suffix=suffix.replace(compact,b'\x22transportProfile\x22:\x22ucd-binary-compact/1\x22',1)
    else:return None
    public=json.dumps(resources,ensure_ascii=False,separators=(',',':'),sort_keys=True).encode()
    return body[:start]+public+suffix[:-1]+b',\x22resourceLease\x22:\x22'+token.encode('ascii')+b'\x22}',entries

def byte_range(value,length):
    """Single explicit byte range only. Unsupported/malformed ranges reject."""
    m=re.fullmatch(r'bytes=(\d+)-(\d*)',value or '')
    if not m:raise ValueError('unsupported range')
    start=int(m[1]);end=int(m[2]) if m[2] else length-1
    if start>=length or end<start:raise ValueError('unsatisfiable range')
    return start,min(end,length-1)
