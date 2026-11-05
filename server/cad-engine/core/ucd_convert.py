"""Opt-in UCD worker; legacy parser/preview remain available."""
from unified import worker_trace

import json
import os
import sys
import time
from convert import convert
from unified.adapter import from_packet
from unified.migrate import migrate_bridge_v1
from unified.payload_sink import FileSink,from_environment
from unified.validation import ValidationError
from unified import stageprof

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(64*1024*1024+1)
        selection=json.loads(sys.argv[2]) if len(sys.argv)>2 else []
        if any(value is not None for value in selection):raise ValueError('UCD首路径未接入配置或显示状态实验')
        sink=from_environment()
        prof=stageprof.enable(os.environ['CAD_PROFILE_STAGES']) if os.environ.get('CAD_PROFILE_STAGES') else None
        started=time.perf_counter()
        worker_trace.mark('runtimeReady');worker_trace.mark('parseStart')
        packet=convert(raw,sys.argv[1],allow_experimental=False,binary=isinstance(sink,FileSink))
        if prof:prof.mark('worker.convert',seconds=round(time.perf_counter()-started,4))
        built=from_packet(packet,len(raw),sink)
        if prof:prof.mark('worker.adapter')
        envelope=migrate_bridge_v1(built,sink,validated=True)
        if prof:prof.mark('worker.migrate')
        sink.finish(envelope)
        if prof:prof.mark('worker.sink-finish',profile=sink.profile);prof.flush()
        worker_trace.mark('parseEnd')
        worker_trace.finish()
        print(json.dumps(envelope,ensure_ascii=False,allow_nan=False))
    except Exception as error:
        print(json.dumps({'error':str(error),'code':error.code if isinstance(error,ValidationError) else 'unsupported-or-invalid-input','stage':'validation' if isinstance(error,ValidationError) else 'conversion','scope':'ucd-single-configuration-bridge','sourceRefs':[],'recoverability':'choose-supported-input','details':{'path':error.path} if isinstance(error,ValidationError) else {}},ensure_ascii=False));sys.exit(1)
