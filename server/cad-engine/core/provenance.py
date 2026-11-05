"""Verify the runtime parser snapshot. Matching hashes do not approve CAD semantics."""
import hashlib
import json
from pathlib import Path

def verify(directory):
    root=Path(directory);manifest=json.loads((root/'parser-provenance.json').read_text())
    if set(manifest['files'])!={p.name for p in (root/'parser').glob('*.py')}:
        raise ValueError('Parser provenance does not cover the exact runtime file set')
    mismatched=[name for name,sha in manifest['files'].items() if hashlib.sha256((root/'parser'/name).read_bytes()).hexdigest()!=sha]
    if mismatched:raise ValueError('Parser provenance mismatch: '+', '.join(mismatched))
    return {'files':len(manifest['files']),'mismatched':0,'scope':'Snapshot integrity only; no extra CAD support claimed'}

if __name__=='__main__':print(json.dumps(verify(Path(__file__).resolve().parent)))
