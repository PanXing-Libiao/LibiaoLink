"""Private Unix HTTP transport; no business credentials, shared files or TCP listener."""
import base64
import hashlib
import json
import os
import signal
import socket
import stat
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from bridge import Gateway, JobLimit, CacheLimit
from sandbox import ROOT, SOCKET, FILE_BYTES, MIB, verify

CONTROL_BYTES = 16 * 1024
ACTIONS = {'lookup', 'status', 'cancel', 'manifest', 'buffer', 'release'}


class UnixHTTPServer(HTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        self.socket.bind(self.server_address)
        self.server_name, self.server_port = 'cad', 0

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def end_headers(self):
        super().end_headers()
        self.headers_sent = True

    def reject(self, status, code):
        if getattr(self, 'headers_sent', False):
            self.close_connection = True
        else:
            self.reply(status, {'code': code})

    def reply(self, status, data):
        raw = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('X-CAD-Engine-Version', self.server.engine_version)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == '/healthz':
            self.reply(200, {'protocol': 'libiaolink-cad-sandbox/1', 'limits': self.server.limits})
        else:
            self.reply(404, {'code': 'not-found'})

    def length(self, maximum):
        values = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(values) != 1 or not values[0].isdigit():
            raise ValueError('length required')
        length = int(values[0])
        if not 0 < length <= maximum:
            raise ValueError('body exceeds budget')
        return length

    def do_POST(self):
        try:
            if self.path == '/submit':
                self.submit()
                return
            if self.path != '/rpc':
                self.reply(404, {'code': 'not-found'})
                return
            length = self.length(CONTROL_BYTES)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('incomplete request')
            request = json.loads(raw)
            if not isinstance(request, dict) or request.get('action') not in ACTIONS or 'path' in request:
                raise ValueError('invalid operation')
            result = self.server.gateway.handle(request)
            if request['action'] in ('manifest', 'buffer'):
                self.file(result)
            else:
                self.reply(200, result)
        except KeyError:
            self.reject(404, 'not-found')
        except (JobLimit, CacheLimit):
            self.reject(503, 'busy')
        except (ValueError, TypeError, OSError):
            self.reject(503, 'unavailable')

    def submit(self):
        encoded = self.headers.get('X-CAD-Request', '')
        if len(encoded) > 8192:
            raise ValueError('metadata exceeds budget')
        request = json.loads(base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True))
        if not isinstance(request, dict) or request.get('action') != 'submit' or 'path' in request:
            raise ValueError('invalid source operation')
        self.server.gateway.results.key(request)
        maximum=self.server.gateway.jobs.policy['inputBytes']
        is_dxf=Path(request['name']).suffix.lower()=='.dxf'
        if is_dxf:maximum=min(maximum,64*1024*1024)+128*1024+12
        length = self.length(maximum)
        if request.get('payloadByteLength',request['sourceByteLength']) != length:
            raise ValueError('source size mismatch')
        deadline, digest, remaining = time.monotonic() + 85, hashlib.sha256(), length
        with tempfile.NamedTemporaryFile(dir=self.server.gateway.incoming) as source:
            while remaining:
                if time.monotonic() >= deadline:
                    raise ValueError('upload deadline exceeded')
                data = self.rfile.read(min(1024 * 1024, remaining))
                if not data:
                    raise ValueError('incomplete source')
                source.write(data)
                digest.update(data)
                remaining -= len(data)
            source.flush()
            if digest.hexdigest() != request.get('payloadSHA256',request['sourceSHA256']):
                raise ValueError('source hash mismatch')
            result = self.server.gateway.handle({**request, 'path': source.name})
        self.reply(200, result)

    def file(self, result):
        path = Path(result['path'])
        if not path.resolve().is_relative_to(ROOT):
            raise ValueError('invalid resource')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != result['bytes'] or info.st_size > FILE_BYTES:
                raise ValueError('invalid resource size')
            self.send_response(200)
            self.send_header('X-CAD-Engine-Version', self.server.engine_version)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(info.st_size))
            if 'artifactBytes' in result:
                self.send_header('X-CAD-Artifact-Bytes', str(result['artifactBytes']))
            self.end_headers()
            deadline = time.monotonic() + 85
            while data := source.read(1024 * 1024):
                if time.monotonic() >= deadline:
                    self.close_connection = True
                    return
                self.wfile.write(data)


def watchdog(gateway):
    deadlines, orphans = {}, {}
    while True:
        time.sleep(.2)
        active = dict(gateway.jobs.active)
        for job, proc in active.items():
            deadlines.setdefault(job, time.monotonic() + gateway.jobs.policy['workerWallSeconds'] + 5)
            if proc.poll() is None and time.monotonic() > deadlines[job]:
                # Namespace init exit also kills descendants that changed process groups.
                os._exit(124)
        deadlines = {job: deadline for job, deadline in deadlines.items() if job in active}
        owned = {proc.pid for proc in active.values()}
        observed = {}
        for path in Path('/proc').iterdir():
            if not path.name.isdigit() or int(path.name) in owned:
                continue
            try:
                # comm can contain spaces or parentheses. PPid is after the final ')'.
                fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                if fields[1] != '1':
                    continue
                pid = int(path.name)
                observed[pid] = orphans.get(pid, time.monotonic())
                if time.monotonic() - observed[pid] < 2:
                    continue
                if fields[0] == 'Z':
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
                else:
                    # A worker has exited but left a descendant outside its group.
                    os._exit(124)
            except (OSError, IndexError, ValueError):
                continue
        orphans = observed


def main():
    limits = verify()
    maximum = os.environ.get('CAD_STEP_MAX_INPUT_MIB', '64')
    dwg_python = os.environ.get('CAD_DWG_PYTHON', '/opt/dxf/bin/python')
    dxf_dwg_reader = os.environ.get('CAD_DXF_DWG_READER', '/opt/dwg/bin/dwgread')
    dwg_reader = os.environ.get('CAD_DWG_READER', '')
    dwg_dotnet = os.environ.get('CAD_DWG_DOTNET', '')
    os.environ.clear()
    os.environ.update(PATH='/usr/local/bin:/usr/bin:/bin', LANG='C.UTF-8', HOME='/tmp', TMPDIR='/tmp',
                      PYTHONDONTWRITEBYTECODE='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
                      CAD_GATEWAY_ROOT=str(ROOT), CAD_STEP_MAX_INPUT_MIB=maximum,
                      CAD_MEMORY_STOP_BYTES=str(limits['memoryBytes']-256*MIB),
                      CAD_STEP_MESHER_PYTHON='/opt/mesher/bin/python', CAD_DXF_PYTHON='/opt/dxf/bin/python',
                      CAD_DXF_IMPORT_MODE='installed', CAD_DWG_PYTHON=dwg_python,
                      CAD_DWG_READER=dwg_reader, CAD_DWG_DOTNET=dwg_dotnet,
                      CAD_DXF_DWG_READER=dxf_dwg_reader)
    gateway = Gateway()
    from release import load_release
    release = load_release()
    Path(SOCKET).unlink(missing_ok=True)
    os.umask(0o007)
    server = UnixHTTPServer(SOCKET, Handler)
    server.gateway, server.limits = gateway, limits
    server.engine_version = release['engineVersion']
    os.chmod(SOCKET, 0o660)
    # PID 1 must remain responsive even if native workers or HTTP handlers stall.
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    signal.signal(signal.SIGINT, lambda *_: os._exit(0))
    threading.Thread(target=watchdog, args=(gateway,), daemon=True).start()
    server.serve_forever(poll_interval=.2)


if __name__ == '__main__':
    main()
