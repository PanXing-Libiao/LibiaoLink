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
        self.blobs={};self.entries={}
    def put(self,bid,blob):
        if bid in self.blobs:return
        self.blobs[bid]=blob
        self.entries[bid]={'id':bid,'sha256':hashlib.sha256(blob).hexdigest(),'byteLength':len(blob),'file':f'{bid}.bin'}
    def get(self,bid):
        return self.blobs[bid]
    def attach(self,envelope):
        envelope['transportProfile']=self.profile
    def finish(self,envelope):
        resources=[]
        for bid in envelope['document']['buffers']:
            entry=self.entries[bid];path=self.directory/entry['file']
            path.write_bytes(self.blobs[bid])
            resources.append({**entry,'path':str(path)})
        envelope['bufferResources']=resources
        self.blobs.clear()
        return resources

def from_environment(directory_variable='CAD_BINARY_DIR'):
    directory=os.environ.get(directory_variable)
    return FileSink(directory) if directory else Base64Sink()
