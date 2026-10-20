"""Private stdio gateway. No HTTP listener, credentials, or CAD interpretation.

The vendored engine owns conversion, validation, quotas and durable job recovery.
The host owns authorization; namespace binds each operation to actor/file/version.
"""
import hashlib
import json
import os
import re
import secrets
import signal
import sys
import threading
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
CORE = BASE / 'core'
sys.path.insert(0, str(CORE))
from unified.conversion_jobs import ConversionJobs, JobLimit


def stop_worker(proc):
    if proc is None or proc.poll() is not None:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=2)
            return
        except __import__('subprocess').TimeoutExpired:
            continue


class Gateway:
    def __init__(self):
        self.root = Path(os.environ['CAD_GATEWAY_ROOT']).resolve()
        self.manifests = self.root / 'manifests'
        self.manifests.mkdir(parents=True, exist_ok=True)
        self.incoming = (self.root / 'incoming').resolve()
        self.incoming.mkdir(parents=True, exist_ok=True)
        release = json.loads((BASE / 'source.json').read_text())
        digest = hashlib.sha256()
        digest.update(release['sourceCommit'].encode())
        for name, expected in sorted(release['engineFiles'].items()):
            raw = (CORE / name).read_bytes()
            if hashlib.sha256(raw).hexdigest() != expected:
                raise ValueError('CAD engine release mismatch')
            digest.update(name.encode()); digest.update(raw)
        digest.update(b'libiaolink-cad-gateway/1')
        digest.update(os.environ.get('CAD_STEP_MESHER_PYTHON', '').encode())
        self.jobs = ConversionJobs(self.root / 'jobs', CORE, threading.Lock(), stop_worker,
                                   digest.hexdigest(), sys.executable)
        self.leases = {}
        for path in self.manifests.iterdir():
            if re.fullmatch(r'[a-f0-9]{48}\.json', path.name):
                path.unlink()

    def owned(self, request):
        namespace = request.get('namespace', '')
        jid = request.get('jobId', '')
        if not re.fullmatch(r'[a-f0-9]{64}', namespace) or not re.fullmatch(r'[a-f0-9]{32}', jid):
            raise ValueError('Invalid job reference')
        row = self.jobs.status(jid)
        if row is None or row.get('namespace') != namespace:
            raise KeyError('Job not found')
        return row

    def public(self, row):
        result = {key: row[key] for key in ('id', 'state', 'phase', 'sourceSHA256', 'sourceByteLength',
                  'artifactBytes', 'createdAt', 'updatedAt', 'workerPeakRSSBytes', 'workerWallSeconds') if key in row}
        error = row.get('error')
        if error:
            message = str(error.get('error', '转换失败'))
            if str(self.root) in message or str(CORE) in message:
                message = 'CAD 转换未完成，请下载原文件查看'
            result['error'] = {'code': str(error.get('code', 'conversion-failed')), 'error': message[:500]}
        return result

    def prune(self):
        for token, lease in list(self.leases.items()):
            if lease['expires'] <= time.monotonic():
                self.release(token)

    def release(self, token):
        lease = self.leases.pop(token, None)
        if lease:
            lease['path'].unlink(missing_ok=True)

    def handle(self, request):
        self.prune()
        action = request['action']
        if action == 'submit':
            namespace = request.get('namespace', '')
            path = Path(request['path'])
            if not re.fullmatch(r'[a-f0-9]{64}', namespace) or path.is_symlink() or path.resolve().parent != self.incoming:
                raise ValueError('Invalid source reference')
            with path.open('rb') as source:
                row, reused = self.jobs.submit_stream(source, path.stat().st_size, request['name'], False,
                                                     secrets.token_hex(16), namespace=namespace)
            if row['sourceSHA256'] != request['sourceSHA256']:
                self.jobs.cancel(row['id'])
                raise ValueError('Source hash mismatch')
            return {'job': self.public(row), 'reused': reused}
        row = self.owned(request)
        if action == 'status':
            return self.public(row)
        if action == 'cancel':
            return self.public(self.jobs.cancel(row['id']))
        if action == 'manifest':
            row, raw = self.jobs.result(row['id'])
            if raw is None:
                raise ValueError('No verified artifact')
            packet = json.loads(raw)
            if packet['snapshot']['completeness'] != 'complete':
                raise ValueError('Partial artifacts are not accepted')
            profile = packet.get('transportProfile')
            if profile not in ('ucd-worker-binary/1', 'ucd-worker-binary-compact/1'):
                raise ValueError('Expected binary artifact')
            if len(self.leases) >= 64:
                raise JobLimit('Manifest lease limit')
            token = secrets.token_hex(24)
            definitions = packet['document']['buffers']
            paths = {b['sha256']: self.jobs._buffer_path(b) for b in definitions.values()}
            packet.update(transportProfile='ucd-binary-compact/1' if 'compact' in profile else 'ucd-binary-manifest/1',
                          resourceLease=token,
                          bufferResources={bid: {'url': f'/api/resources/{token}/{b["sha256"]}',
                                                'sha256': b['sha256'], 'byteLength': b['byteLength']}
                                           for bid, b in definitions.items()})
            path = self.manifests / (token + '.json')
            with path.open('x') as output:
                json.dump(packet, output, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            self.leases[token] = {'namespace': request['namespace'], 'jobId': row['id'], 'paths': paths,
                                  'expires': time.monotonic() + 300, 'path': path}
            return {'path': str(path), 'bytes': path.stat().st_size, 'artifactBytes': row.get('artifactBytes', 0)}
        token = request.get('lease', '')
        lease = self.leases.get(token)
        if lease is None or lease['namespace'] != request['namespace'] or lease['jobId'] != row['id']:
            raise KeyError('Resource not found')
        if action == 'release':
            self.release(token)
            return {'released': True}
        if action == 'buffer':
            sha = request.get('sha256', '')
            path = lease['paths'].get(sha)
            if path is None or path.is_symlink() or not path.is_file():
                raise KeyError('Resource not found')
            return {'path': str(path), 'bytes': path.stat().st_size}
        raise ValueError('Unknown gateway action')


def main():
    gateway = Gateway()
    def shutdown(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, shutdown)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            rid = request.get('id')
            try:
                result = gateway.handle(request)
                response = {'id': rid, 'result': result}
            except KeyError:
                response = {'id': rid, 'error': {'code': 'not-found', 'message': '模型资源不存在或不可访问'}}
            except JobLimit:
                response = {'id': rid, 'error': {'code': 'busy', 'message': '转换服务繁忙，请稍后重试'}}
            except (ValueError, OSError):
                response = {'id': rid, 'error': {'code': 'unavailable', 'message': '模型产物不可用，请重新转换或下载原文件'}}
            print(json.dumps(response, ensure_ascii=False), flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        gateway.jobs.close()
        for token in list(gateway.leases):
            gateway.release(token)


if __name__ == '__main__':
    main()
