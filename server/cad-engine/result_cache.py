"""Host cache of verified results; view ownership is separate from artifact identity."""
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path


class CacheLimit(ValueError):
    pass


class ResultCache:
    def __init__(self, path, jobs):
        self.jobs = jobs
        self.db = sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS results (job_id TEXT PRIMARY KEY, cache_key TEXT, created REAL)')
        self.db.execute('CREATE INDEX IF NOT EXISTS result_key ON results(cache_key)')
        self.db.execute('CREATE TABLE IF NOT EXISTS bindings (namespace TEXT, job_id TEXT, expires REAL, PRIMARY KEY(namespace,job_id))')
        self.db.commit()
        self.last_pruned = 0

    def key(self, request):
        for field in ('namespace', 'cacheScope', 'sourceSHA256'):
            if not re.fullmatch(r'[a-f0-9]{64}', request.get(field, '')):
                raise ValueError('Invalid cache identity')
        name, length = request.get('name'), request.get('sourceByteLength')
        if not isinstance(name, str) or Path(name).name != name or Path(name).suffix.lower() not in ('.step', '.stp', '.dxf'):
            raise ValueError('Invalid cache source name')
        if type(length) is not int or not 0 < length <= self.jobs.policy['inputBytes']:
            raise ValueError('Invalid cache source length')
        codepage = request.get('nameCodepage', 'UTF8')
        if codepage not in ('UTF8', 'GB'):
            raise ValueError('Invalid name encoding')
        is_dxf=Path(name).suffix.lower()=='.dxf'
        resource=request.get('resourceFingerprint')
        if is_dxf and (codepage!='UTF8' or not isinstance(resource,str) or not re.fullmatch(r'[a-f0-9]{64}',resource)):
            raise ValueError('Invalid DXF resource identity')
        # File/version/content, parser release, transport and name encoding determine
        # reusable bytes. Actor/view remain authorization bindings, never cache keys.
        identity = {key: request[key] for key in ('cacheScope', 'sourceSHA256', 'sourceByteLength', 'name')}
        identity.update(version='libiaolink-result-cache/1', rules=self.jobs.rule_version,
                        policy=self.jobs.policy['version'], binary=self.jobs.binary,
                        compact=self.jobs.compact, nameCodepage=codepage)
        if is_dxf:identity['resourceFingerprint']=resource
        return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    def prune(self, force=False):
        now = time.time()
        if not force and now - self.last_pruned < 60:
            return
        self.db.execute('DELETE FROM bindings WHERE expires<=?', (now,))
        age = self.jobs.policy['retentionSeconds'] + self.jobs.policy['workerWallSeconds'] + self.jobs.policy['queueWallSeconds']
        self.db.execute('DELETE FROM results WHERE created<?', (now - age,))
        self.db.commit()
        self.last_pruned = now

    def remember(self, request, row):
        self.db.execute('INSERT OR REPLACE INTO results VALUES (?,?,?)',
                        (row['id'], self.key(request), row['createdAt']))
        self.db.commit()

    def allows(self, namespace, job_id):
        return self.db.execute('SELECT 1 FROM bindings WHERE namespace=? AND job_id=? AND expires>?',
                               (namespace, job_id, time.time())).fetchone() is not None

    def revoke(self, namespace, job_id):
        self.db.execute('DELETE FROM bindings WHERE namespace=? AND job_id=?', (namespace, job_id))
        self.db.commit()

    def lookup(self, request):
        self.prune()
        key = self.key(request)
        candidates = self.db.execute('SELECT job_id FROM results WHERE cache_key=? ORDER BY created DESC', (key,)).fetchall()
        for (job_id,) in candidates:
            row = self.jobs.status(job_id)
            if row is None or row['state'] in ('failed', 'cancelled', 'timed-out'):
                self.db.execute('DELETE FROM results WHERE job_id=?', (job_id,)); self.db.commit()
                continue
            # Never share a running task: closing/cancelling one view must not stop another.
            if row['state'] not in ('completed','partial') or time.time() - row['updatedAt'] > self.jobs.policy['retentionSeconds']:
                continue
            if row.get('resourceFingerprint')!=request.get('resourceFingerprint'):
                continue
            if (row.get('sourceSHA256'), row.get('sourceByteLength'), row.get('name'), row.get('nameCodepage', 'UTF8')) != (
                    request['sourceSHA256'], request['sourceByteLength'], request['name'], request.get('nameCodepage', 'UTF8')):
                continue
            # The engine re-hashes the immutable manifest AND all binary buffers.
            # This is result validation, not another STEP parse or tessellation.
            verified, raw = self.jobs.result(job_id)
            if raw is None:
                self.db.execute('DELETE FROM results WHERE job_id=?', (job_id,)); self.db.commit()
                continue
            packet = json.loads(raw)
            completeness=packet.get('snapshot',{}).get('completeness')
            acceptable=completeness=='complete' or (row.get('sourceFormat')=='DXF' and completeness=='partial')
            if not acceptable or packet.get('transportProfile') not in (
                    'ucd-worker-binary/1', 'ucd-worker-binary-compact/1'):
                continue
            namespace = request['namespace']
            if verified.get('namespace') != namespace:
                self.prune(force=True)
                if not self.allows(namespace, job_id) and self.db.execute('SELECT count(*) FROM bindings').fetchone()[0] >= 128:
                    raise CacheLimit('Cached view limit')
                self.db.execute('INSERT OR REPLACE INTO bindings VALUES (?,?,?)', (namespace, job_id, time.time() + 300))
                self.db.commit()
            return verified
        return None

    def close(self):
        self.db.close()
