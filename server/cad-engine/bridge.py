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
from unified import dxf_resources
from result_cache import ResultCache, CacheLimit
from release import load_release


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
        release = load_release()
        digest = hashlib.sha256()
        digest.update((release.get('engineDigest') or release['releaseDigest']).encode())
        digest.update(os.environ.get('CAD_STEP_MESHER_PYTHON', '').encode())
        self.jobs = ConversionJobs(self.root / 'jobs', CORE, threading.Lock(), stop_worker,
                                   digest.hexdigest(), sys.executable,
                                   dxf_interpreter=os.environ.get('CAD_DXF_PYTHON'),
                                   dwg_interpreter=os.environ.get('CAD_DWG_PYTHON'))
        self.results = ResultCache(self.root / 'result-cache.sqlite3', self.jobs)
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
        if row is None or (row.get('namespace') != namespace and not self.results.allows(namespace, jid)):
            raise KeyError('Job not found')
        return row

    def public(self, row):
        result = {key: row[key] for key in ('id', 'state', 'phase', 'sourceSHA256', 'sourceByteLength',
                  'artifactBytes', 'createdAt', 'updatedAt', 'workerPeakRSSBytes', 'workerWallSeconds', 'nameCodepage') if key in row}
        result['format']=row.get('sourceFormat','STEP')
        error = row.get('error')
        if error:
            message = str(error.get('error', '转换失败'))
            if str(self.root) in message or str(CORE) in message:
                message = 'CAD 转换未完成，请下载原文件查看'
            result['error'] = {'code': str(error.get('code', 'conversion-failed')), 'error': message[:500]}
        return result

    def prune(self):
        self.results.prune()
        for token, lease in list(self.leases.items()):
            if lease['expires'] <= time.monotonic():
                self.release(token)

    def release(self, token):
        lease = self.leases.pop(token, None)
        if lease:
            lease['path'].unlink(missing_ok=True)
            if not any(other['namespace'] == lease['namespace'] and other['jobId'] == lease['jobId'] for other in self.leases.values()):
                self.results.revoke(lease['namespace'], lease['jobId'])

    def retire(self, row, namespace):
        # Only the owning archival task may retire its result, after durable publication.
        # Existing views/aliases keep their temporary resources until released or expired.
        if row.get('namespace') != namespace or row['state'] not in ('completed','partial'):
            return
        if any(lease['jobId'] == row['id'] for lease in self.leases.values()):
            return
        if self.results.db.execute('SELECT 1 FROM bindings WHERE job_id=? AND expires>?',
                                   (row['id'], time.time())).fetchone():
            return
        with self.jobs.lock:
            self.jobs.db.execute("DELETE FROM jobs WHERE id=? AND state IN ('completed','partial')", (row['id'],))
            self.jobs.db.commit()
            self.jobs._prune()
        self.results.db.execute('DELETE FROM results WHERE job_id=?', (row['id'],))
        self.results.db.execute('DELETE FROM bindings WHERE job_id=?', (row['id'],))
        self.results.db.commit()

    def handle(self, request):
        self.prune()
        action = request['action']
        if action == 'lookup':
            row = self.results.lookup(request)
            return {'job': self.public(row), 'reused': True} if row else None
        if action == 'submit':
            namespace = request.get('namespace', '')
            path = Path(request['path'])
            if not re.fullmatch(r'[a-f0-9]{64}', namespace) or path.is_symlink() or path.resolve().parent != self.incoming:
                raise ValueError('Invalid source reference')
            is_dxf=Path(request['name']).suffix.lower()=='.dxf'
            if path.stat().st_size != request.get('payloadByteLength',request['sourceByteLength']):
                raise ValueError('Source size mismatch')
            if is_dxf:
                package=dxf_resources.decode_package(path.read_bytes())
                if dxf_resources.fingerprint(package)!=request['resourceFingerprint']:
                    raise ValueError('DXF resource identity mismatch')
            cached = self.results.lookup(request)
            if cached:
                return {'job': self.public(cached), 'reused': True}
            with path.open('rb') as source:
                row, reused = self.jobs.submit_stream(source, path.stat().st_size, request['name'], False,
                                                     secrets.token_hex(16), namespace=namespace, name_codepage=request.get('nameCodepage', 'UTF8'))
            if row['sourceSHA256'] != request['sourceSHA256'] or row['sourceByteLength'] != request['sourceByteLength']:
                self.jobs.cancel(row['id'])
                raise ValueError('Source hash mismatch')
            self.results.remember(request, row)
            return {'job': self.public(row), 'reused': reused}
        row = self.owned(request)
        if action == 'status':
            return self.public(row)
        if action == 'cancel':
            if row['state'] in ('completed','partial') and row.get('namespace') != request['namespace']:
                self.results.revoke(request['namespace'], row['id'])
                return self.public(row)
            return self.public(self.jobs.cancel(row['id']))
        if action == 'manifest':
            row, raw = self.jobs.result(row['id'])
            if raw is None:
                raise ValueError('No verified artifact')
            packet = json.loads(raw)
            completeness=packet['snapshot']['completeness']
            if completeness!='complete' and not (row.get('sourceFormat')=='DXF' and completeness=='partial'):
                raise ValueError('Artifact completeness is not accepted for this format')
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
            if request.get('retire') is True:
                self.retire(row, request['namespace'])
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
            except (JobLimit, CacheLimit):
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
        gateway.results.close()


if __name__ == '__main__':
    main()
