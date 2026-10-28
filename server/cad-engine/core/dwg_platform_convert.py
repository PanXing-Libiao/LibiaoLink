"""Platform worker for native DWG -> UCD.

The API-side job service feeds the original bytes on stdin. The native ACadSharp
reader and UCD assembly remain the same repository implementation used by the
local DWG harness; this wrapper only joins that output to the platform worker
transport. Runtime paths are supplied by the sandbox environment.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from unified.dwg_adapter import assemble_native
from unified.payload_sink import from_environment


def fail(error):
    print(json.dumps({'error': str(error), 'code': 'dwg-conversion-failed',
                      'stage': 'conversion', 'scope': 'native-dwg'}, ensure_ascii=False))
    raise SystemExit(1)


def main():
    name = Path(sys.argv[1]).name
    reader = os.environ.get('CAD_DWG_READER')
    dotnet = os.environ.get('CAD_DWG_DOTNET')
    if not reader or not dotnet:
        fail('missing-dwg-runtime: CAD_DWG_READER and CAD_DWG_DOTNET are required')
    raw = sys.stdin.buffer.read()
    if not raw:
        fail('empty-dwg-source')
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR') or None) as folder:
        root = Path(folder)
        source = root / name
        source.write_bytes(raw)
        result = root / 'result'
        native = result / 'native'
        try:
            subprocess.run([dotnet, reader, str(source), str(native)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            manifest_path = assemble_native(native, source, result)
            envelope = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
            payloads = envelope.pop('bufferPayloads', {})
            sink = from_environment()
            for bid, path in payloads.items():
                payload = Path(path)
                if not payload.is_absolute():
                    payload = result / payload
                sink.put(bid, payload.read_bytes())
            sink.attach(envelope)
            sink.finish(envelope)
            print(json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(',', ':')))
        except Exception as error:
            fail(error)


if __name__ == '__main__':
    main()
