"""Buffer payload sinks for the UCD adapters.

Base64Sink keeps the existing JSON envelope contract. FileSink keeps raw bytes
in memory only until the adapter has validated them, then writes one file per
buffer so the worker never builds base64 strings or a payload-sized JSON body.
"""
import base64,hashlib,os
from pathlib import Path

class Base64Sink:
    profile='ucd-base64-envelope/1'
    def __init__(self):
        self.payloads={}
    def put(self,bid,blob):
        self.payloads[bid]=base64.b64encode(blob).decode('ascii')
    def get(self,bid):
        return base64.b64decode(self.payloads[bid],validate=True)
    def attach(self,envelope):
        envelope['transportProfile']=self.profile;envelope['bufferPayloads']=self.payloads
    def finish(self,envelope):
        return None

class FileSink:
    profile='ucd-worker-binary/1'
    def __init__(self,directory):
        self.directory=Path(directory);self.directory.mkdir(parents=True,exist_ok=True)
        self.blobs={};self.files={};self.entries={}
    def put(self,bid,blob):
        if bid in self.blobs or bid in self.files:return
        self.blobs[bid]=blob
        self.entries[bid]={'id':bid,'sha256':hashlib.sha256(blob).hexdigest(),'byteLength':len(blob),'file':f'{bid}.bin'}
    def put_file(self,bid,path,sha256,byteLength):
        """Publish bytes the adapter already wrote, without a second write."""
        if bid in self.blobs or bid in self.files:return
        path=Path(path);target=self.directory/f'{bid}.bin'
        if path.resolve()!=target.resolve() or not path.is_file() or path.stat().st_size!=byteLength:
            raise ValueError('file-sink-prewritten-path')
        self.files[bid]=path
        self.entries[bid]={'id':bid,'sha256':sha256,'byteLength':byteLength,'file':f'{bid}.bin'}
    def get(self,bid):
        return self.files[bid].read_bytes() if bid in self.files else self.blobs[bid]
    def attach(self,envelope):
        envelope['transportProfile']=self.profile
    def finish(self,envelope):
        resources=[]
        for bid in envelope['document']['buffers']:
            entry=self.entries[bid]
            if bid in self.files:
                if self.files[bid].stat().st_size!=entry['byteLength']:
                    raise ValueError('file-sink-prewritten-length')
            else:
                path=self.directory/entry['file']
                path.write_bytes(self.blobs[bid])
            resources.append({**entry})
        envelope['bufferResources']=resources
        self.blobs.clear();self.files.clear()
        return resources

def from_environment(directory_variable='CAD_BINARY_DIR'):
    directory=os.environ.get(directory_variable)
    return FileSink(directory) if directory else Base64Sink()
