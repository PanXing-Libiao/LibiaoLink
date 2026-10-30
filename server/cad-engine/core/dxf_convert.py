"""Isolated DXF worker; stdout contains only a validated UCD 2.0 envelope.

The editable repository ezdxf runtime (CAD_DXF_PYTHON, default
.cad-work/dxf/bin/python) is selected by dev/server.py. This module never imports
ezdxf at the top level so the base Python can still report configuration errors cleanly.
"""
from unified import worker_trace

import json, os, sys, tempfile, traceback
from pathlib import Path

if __name__ == '__main__':
    try:
        selection = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
        if any(value is not None for value in selection):
            raise ValueError('unsupported-dxf-selection: DXF has no source configurations or display states')
        raw = sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
        if not raw or len(raw) > 64 * 1024 * 1024:
            raise ValueError('DXF input must be 1 byte to 64 MiB')
        from unified.payload_sink import from_environment
        from unified.dxf_adapter import read_dxf
        from unified.dxf_resources import read_manifest
        logical_path, resources = read_manifest(os.environ['CAD_DXF_RESOURCES']) if os.environ.get('CAD_DXF_RESOURCES') else (None, None)
        sink = from_environment()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / Path(sys.argv[1]).name
            path.write_bytes(raw)
            worker_trace.mark('parseStart')
            envelope = read_dxf(path, raw, sink, name=Path(sys.argv[1]).name, resources=resources, logical_path=logical_path)
        worker_trace.mark('parseEnd')
        worker_trace.finish()
        print(json.dumps(envelope, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        code = 'dxf-parse-error'
        message = str(error)
        if 'unsupported-dxf-version' in message or 'unsupported-dxf-selection' in message:
            code = message.split(':', 1)[0]
        elif 'DXFStructureError' in type(error).__name__ or 'DXFValueError' in type(error).__name__:
            code = 'dxf-structure-error'
        elif 'entities-over-limit' in message or 'drawing-projection-over-limit' in message:
            code = 'dxf-limit-exceeded'
        elif message.startswith('missing-dxf-runtime:'):
            code = 'missing-dxf-runtime'
        print(json.dumps({'error': message, 'code': code, 'stage': 'conversion',
                          'scope': 'dxf-drawing', 'sourceRefs': [],
                          'recoverability': 'configure-runtime' if code == 'missing-dxf-runtime'
                                            else 'choose-supported-input'}, ensure_ascii=False))
        sys.exit(1)
