"""Decode selected DWG companions in a bounded, independent LibreDWG process.

The CLI is GPL-3.0-or-later and is not linked into the Python reader. Source,
version and license are pinned in dwg-reader.json. No DWG path can select a
local file, executable or network resource. Intermediate DXF is never a source.
"""
from functools import lru_cache
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

SPEC = json.loads(Path(__file__).with_name('dwg-reader.json').read_text())
VERSION = SPEC['version']
MAX_OUTPUT = 128 * 1024 * 1024
MAX_LOG = 8 * 1024 * 1024
WALL_SECONDS = 15
SIGNATURES = {b'AC1012', b'AC1014', b'AC1015', b'AC1018', b'AC1021', b'AC1024', b'AC1027', b'AC1032'}


@lru_cache(maxsize=8)
def reader(command):
    executable = shutil.which(command)
    if executable is None:
        raise ValueError('dwg-reader-unavailable: LibreDWG ' + VERSION + ' dwgread is required')
    version = subprocess.run([executable, '--version'], capture_output=True, timeout=3, check=True)
    if version.stdout.strip() != ('dwgread ' + VERSION).encode():
        raise ValueError('dwg-reader-version-mismatch: requires ' + VERSION)
    return executable, {'name': 'libredwg', 'version': VERSION,
        'executableSHA256': hashlib.sha256(Path(executable).read_bytes()).hexdigest(),
        'license': SPEC['license'], 'sourceSHA256': SPEC['sha256']}


def run(executable, arguments, folder, phase, deadline, output=None):
    log = folder / (phase + '.log')
    with log.open('wb') as stderr:
        proc = subprocess.Popen([executable, '-v2', *arguments], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=stderr, cwd=folder)
        # Keep the worker's process group: cancellation/timeout must also stop
        # this native descendant. It creates no further processes.
        try:
            while proc.poll() is None:
                if time.monotonic() > deadline:
                    raise ValueError('dwg-decode-timeout')
                if log.stat().st_size > MAX_LOG or output and output.exists() and output.stat().st_size > MAX_OUTPUT:
                    raise ValueError('dwg-decode-output-limit')
                time.sleep(.02)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
    if log.stat().st_size > MAX_LOG or output and output.exists() and output.stat().st_size > MAX_OUTPUT:
        raise ValueError('dwg-decode-output-limit')
    raw = log.read_bytes()
    # Native diagnostics include the random working directory. It is not source
    # data and must not make identical input sets produce different revisions.
    raw = raw.replace(os.fsencode(folder), b'<dwg-work>')
    matches = re.findall(rb'(?:SUCCESS|ERROR) 0x([0-9a-fA-F]+)', raw)
    if proc.returncode or not matches:
        raise ValueError('dwg-decode-failed: ' + phase + ' exit=' + str(proc.returncode))
    mask = int(matches[-1], 16)
    if mask >= 128:
        raise ValueError('dwg-decode-failed: ' + phase + ' error=0x%x' % mask)
    diagnostics = sum(bool(re.match(rb'\s*(?:ERROR|Warning|WARN)', line)) for line in raw.splitlines())
    return {'errorMask': mask, 'diagnosticLines': diagnostics, 'reportSHA256': hashlib.sha256(raw).hexdigest()}


def decode(raw):
    signature = raw[:6]
    if signature not in SIGNATURES:
        raise ValueError('dwg-signature-unsupported: requires R13–R2018 DWG bytes')
    executable, implementation = reader(os.environ.get('CAD_DWG_READER', 'dwgread'))
    deadline = time.monotonic() + WALL_SECONDS
    with tempfile.TemporaryDirectory(prefix='cad-dwg-') as name:
        folder = Path(name)
        source, target = folder / 'source.dwg', folder / 'decoded.dxf'
        source.write_bytes(raw)
        # dwgread overwrites its read error mask when writing a derivative. A
        # separate no-output read is necessary to retain noncritical losses.
        read_report = run(executable, [str(source)], folder, 'read', deadline)
        write_report = run(executable, ['-O', 'DXF', '-o', str(target), str(source)], folder, 'write', deadline, target)
        if not target.is_file() or not target.stat().st_size:
            raise ValueError('dwg-decode-failed: DXF output missing')
        decoded = target.read_bytes()
    decoded, normalizations = prepare_dxf(decoded)
    partial = any(r['errorMask'] or r['diagnosticLines'] for r in (read_report, write_report))
    return decoded, {'reader': implementation, 'sourceVersion': signature.decode('ascii'),
        'decodedSHA256': hashlib.sha256(decoded).hexdigest(), 'decodedByteLength': len(decoded),
        'normalizations': normalizations,
        'read': read_report, 'write': write_report, 'status': 'partial' if partial else 'complete',
        'objectIdentity': 'DWG handles exported by LibreDWG; derivative DXF is not an uploaded source'}


def prepare_dxf(raw):
    """Keep original handles unique while the downstream library allocates copies.

    LibreDWG can export a stale $HANDSEED below existing handles. ezdxf then
    allocates derived objects on original identities. Advance that allocator
    cursor in the intermediate only; never renumber an original DWG object.
    """
    from ezdxf.recover import bytes_loader
    from ezdxf.lldxf.tags import group_tags
    seen = set()
    for record in group_tags(bytes_loader(io.BytesIO(raw)), 0):
        if record[0].value in (b'SECTION', b'ENDSEC', b'EOF'):
            continue
        handle = next((tag.value for tag in record if tag.code in (5, 105)), None)
        if handle is None:
            continue
        number = int(handle, 16)
        if number in seen:
            raise ValueError('dwg-decoded-handle-duplicate')
        seen.add(number)
    match = re.search(rb'(?m)(^[ \t]*9\r?\n\$HANDSEED\r?\n[ \t]*5\r?\n)([0-9A-Fa-f]+)(\r?\n)', raw)
    if not match:
        raise ValueError('dwg-decoded-handseed-missing')
    seed = int(match[2], 16)
    maximum = max(seen, default=0)
    normalizations = []
    if seed <= maximum:
        replacement = ('%X' % (maximum + 1)).encode()
        raw = raw[:match.start(2)] + replacement + raw[match.end(2):]
        normalizations.append({'kind': 'derived-handseed-advanced', 'from': match[2].decode(), 'to': replacement.decode()})
    return raw, normalizations
