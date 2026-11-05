"""Platform worker for native DWG -> UCD.

The API-side job service feeds the original bytes on stdin. The native ACadSharp
reader and UCD assembly remain the same repository implementation used by the
local DWG harness; this wrapper only joins that output to the platform worker
transport. Runtime paths are supplied by the sandbox environment.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from unified.dwg_adapter import assemble_native, run_reader


def fail(error):
    print(json.dumps({'error': str(error), 'code': 'dwg-conversion-failed',
                      'stage': 'conversion', 'scope': 'native-dwg'}, ensure_ascii=False))
    raise SystemExit(1)


def main():
    name = Path(sys.argv[1]).name
    reader = os.environ.get('CAD_DWG_READER')
    dotnet = os.environ.get('CAD_DWG_DOTNET')
    binary_dir = os.environ.get('CAD_BINARY_DIR')
    if not reader or not dotnet:
        fail('missing-dwg-runtime: CAD_DWG_READER and CAD_DWG_DOTNET are required')
    if not binary_dir:
        fail('dwg-binary-transport-required: CAD_BINARY_DIR is required for the DWG platform worker')
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR') or None) as folder:
        root = Path(folder)
        source = root / name
        with source.open('wb') as target:
            shutil.copyfileobj(sys.stdin.buffer, target, length=1024*1024)
        if not source.stat().st_size:
            fail('empty-dwg-source')
        result = root / 'result'
        native = result / 'native'
        try:
            run_reader(dotnet, reader, source, native)
            manifest_path = assemble_native(native, source, result, platform=True,
                                             binary_dir=binary_dir, packed=True)
            result_path = os.environ.get('CAD_RESULT_PATH')
            if not result_path:
                # conversion_jobs places trace.json next to result.json.
                trace_path = os.environ.get('CAD_TRACE_FILE')
                result_path = str(Path(trace_path).with_name('result.json')) if trace_path else None
            if result_path:
                # The parent owns this result file for the one-shot worker.
                # Avoid copying a large manifest through a second stdout pipe
                # before validation; the bytes are identical.
                shutil.copyfile(manifest_path, result_path)
                os._exit(0)
            with open(manifest_path, 'rb') as manifest:
                shutil.copyfileobj(manifest, sys.stdout.buffer)
            # stdout fallback for callers without a result file.
            sys.stdout.buffer.flush()
            os._exit(0)
        except Exception as error:
            fail(error)


if __name__ == '__main__':
    main()
