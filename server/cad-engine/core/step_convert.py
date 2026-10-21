"""Isolated STEP worker; stdout contains only a validated UCD envelope."""
from unified import worker_trace

import json,os,sys,tempfile
from pathlib import Path
from unified.payload_sink import from_environment
from unified.step_adapter import read_step,PartialPreviewAvailable
from unified.input_policy import worker_input_bytes
from unified.compact_transport import pack_metadata

def write_binary_manifest(envelope):
    # Even without base64, assembly metadata can be large. Avoid simultaneously
    # retaining a full JSON string and its stdout UTF-8 copy. Batch encoder chunks
    # so the bounded output does not issue one write per scalar/token.
    chunks=[];size=0
    for chunk in json.JSONEncoder(ensure_ascii=False,allow_nan=False).iterencode(envelope):
        chunks.append(chunk);size+=len(chunk)
        if size>=1024*1024:
            sys.stdout.write(''.join(chunks));chunks.clear();size=0
    if chunks:sys.stdout.write(''.join(chunks))
    sys.stdout.write('\n');sys.stdout.flush()

if __name__=='__main__':
    try:
        selection=json.loads(sys.argv[2]) if len(sys.argv)>2 else []
        if any(value is not None for value in selection):raise ValueError('unsupported-step-selection: source configurations/display states are not supported')
        limit=worker_input_bytes()
        # Native OCCT diagnostics write to fd 1; keep them out of the JSON protocol.
        sink=from_environment()
        partial=os.environ.get('CAD_PARTIAL_PREVIEW')=='1'
        saved=os.dup(1);os.dup2(2,1)
        try:
            with tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/Path(sys.argv[1]).name;size=0
                with path.open('wb') as target:
                    while True:
                        chunk=sys.stdin.buffer.read(min(1024*1024,limit+1-size))
                        if not chunk:break
                        size+=len(chunk)
                        if size>limit:raise ValueError('STEP input exceeds worker input budget')
                        target.write(chunk)
                if not size:raise ValueError('STEP input is empty')
                worker_trace.mark('parseStart');envelope=read_step(path,sink,partial=partial,name_codepage=os.environ.get('CAD_STEP_NAME_CODEPAGE','UTF8'));worker_trace.mark('parseEnd')
        finally:os.dup2(saved,1);os.close(saved)
        if envelope.get('transportProfile')=='ucd-worker-binary/1':
            if os.environ.get('CAD_COMPACT_METADATA')=='1':envelope=pack_metadata(envelope)
            write_binary_manifest(envelope)
            worker_trace.mark('serializationCompleted')
        else:
            serialized=json.dumps(envelope,ensure_ascii=False,allow_nan=False)
            worker_trace.mark('serializationCompleted')
            print(serialized)
        worker_trace.finish()
    except PartialPreviewAvailable as error:worker_trace.mark('parseRejected');worker_trace.finish();print(json.dumps({'error':str(error),'code':'step-strict-incomplete','partialPreviewAvailable':True,'details':error.details,'stage':'step-xde'},ensure_ascii=False));sys.exit(1)
    except Exception as error:worker_trace.mark('workerFailed');worker_trace.finish();print(json.dumps({'error':str(error),'code':'unsupported-or-invalid-step','stage':'step-xde'},ensure_ascii=False));sys.exit(1)
