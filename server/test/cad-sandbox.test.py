"""Live Docker probes, deliberately bounded; never runs against the company server."""
import json
import os
import subprocess
import time
import unittest
import urllib.request
import uuid

IMAGE = os.environ.get('CAD_SANDBOX_IMAGE', 'libiaolink/cad-sandbox:1.0.0')
CONTAINER = os.environ.get('CAD_TEST_CONTAINER', 'libiaolink-cad-cad-1')
ENDPOINT = os.environ.get('CAD_TEST_ENDPOINT', 'http://127.0.0.1:9910')


def docker(*args, check=True, timeout=30):
    return subprocess.run(['docker', *args], check=check, capture_output=True, text=True, timeout=timeout)


class SandboxTests(unittest.TestCase):
    def probe(self, code, *extra):
        name = 'libiaolink-cad-probe-' + uuid.uuid4().hex[:10]
        try:
            docker('create', '--name', name, '--platform', 'linux/amd64', '--network', 'none', '--read-only',
                   '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                   '--memory', '128m', '--memory-swap', '128m', '--cpus', '1', '--pids-limit', '16',
                   *extra, '--entrypoint', '/opt/ocp/bin/python', IMAGE, '-c', code)
            docker('start', name)
            result = docker('wait', name)
            state = json.loads(docker('inspect', '--format', '{{json .State}}', name).stdout)
            return int(result.stdout), state, docker('logs', name).stdout
        finally:
            docker('rm', '-f', name, check=False)

    def live(self, code):
        return docker('exec', CONTAINER, '/opt/ocp/bin/python', '-c', code).stdout

    def test_enforced_runtime_and_network_boundary(self):
        with urllib.request.urlopen(ENDPOINT + '/healthz', timeout=5) as response:
            limits = json.load(response)['limits']
        self.assertEqual(limits['memoryBytes'], 3 * 1024**3)
        self.assertEqual(limits['pids'], 64)
        self.assertEqual(limits['cpuQuota'], limits['cpuPeriod'])
        self.assertEqual(limits['swapBytes'], 0)
        config = json.loads(docker('inspect', '--format', '{{json .HostConfig}}', CONTAINER).stdout)
        self.assertEqual(config['NetworkMode'], 'none')
        self.assertEqual(config['CapDrop'], ['ALL'])
        self.assertTrue(config['ReadonlyRootfs'])
        self.live("""
import os, socket
from pathlib import Path
assert os.getuid() == 1000
assert not any(k.startswith(('S3_', 'AWS_', 'CASDOOR_', 'DATABASE_')) for k in os.environ)
assert not Path('/opt/libiaolink/secrets').exists()
assert not Path('/var/run/docker.sock').exists()
try:
    socket.create_connection(('192.0.2.1', 443), timeout=1)
except OSError:
    pass
else:
    raise AssertionError('unexpected outbound network')
""")

    def test_missing_sandbox_limits_fail_closed(self):
        result = docker('run', '--rm', '--platform', 'linux/amd64', '--network', 'none', IMAGE, check=False)
        self.assertNotEqual(result.returncode, 0)

    def test_file_size_and_readonly_root_are_kernel_enforced(self):
        self.live("""
import errno, os, tempfile
try:
    os.open('/opt/cad/forbidden', os.O_WRONLY | os.O_CREAT, 0o600)
except OSError as error:
    assert error.errno in (errno.EROFS, errno.EACCES)
else:
    raise AssertionError('writable root')
with tempfile.TemporaryFile() as file:
    try:
        os.ftruncate(file.fileno(), 512 * 1024**2 + 1)
    except OSError as error:
        assert error.errno == errno.EFBIG
    else:
        raise AssertionError('unbounded file')
""")

    def test_pid_limit_covers_descendants(self):
        self.live("""
import subprocess
children=[]
try:
    for _ in range(80):
        try:
            children.append(subprocess.Popen(['/bin/sleep', '20']))
        except BlockingIOError:
            break
    else:
        raise AssertionError('pids limit not enforced')
    assert 0 < len(children) < 64
finally:
    for child in children: child.kill()
    for child in children: child.wait()
""")

    def test_oom_kills_only_dedicated_container(self):
        code, state, _ = self.probe("value=bytearray(512*1024**2)")
        self.assertEqual(code, 137)
        self.assertTrue(state['OOMKilled'])
        with urllib.request.urlopen(ENDPOINT + '/healthz', timeout=5) as response:
            self.assertEqual(response.status, 200)

    def test_tmpfs_has_aggregate_hard_ceiling(self):
        code, _, _ = self.probe("""
import errno
from pathlib import Path
try:
    for i in range(32):
        Path('/tmp/'+str(i)).write_bytes(b'x'*1024**2)
except OSError as error:
    assert error.errno == errno.ENOSPC
else:
    raise AssertionError('unbounded tmpfs')
""", '--tmpfs', '/tmp:size=8m,uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev')
        self.assertEqual(code, 0)

    def test_cpu_quota_throttles_descendants(self):
        code, _, _ = self.probe("""
from pathlib import Path
import subprocess, sys
def throttled():
    values=dict(line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
    return int(values['nr_throttled'])
before=throttled()
code='import time; end=time.monotonic()+2\\nwhile time.monotonic()<end: pass'
children=[subprocess.Popen([sys.executable,'-c',code]) for _ in range(2)]
for child in children: assert child.wait() == 0
assert throttled() > before
""")
        self.assertEqual(code, 0)

    def test_watchdog_terminates_namespace_even_after_setsid(self):
        code, _, _ = self.probe("""
import subprocess, types
from service import watchdog
child=subprocess.Popen(['/bin/sleep','20'], start_new_session=True)
jobs=types.SimpleNamespace(active={'probe':child}, policy={'workerWallSeconds':-4})
watchdog(types.SimpleNamespace(jobs=jobs))
""")
        self.assertEqual(code, 124)

    def test_watchdog_cleans_orphan_outside_worker_group(self):
        code, _, _ = self.probe("""
import subprocess, sys, types
from service import watchdog
parent=subprocess.Popen([sys.executable,'-c',"import subprocess; subprocess.Popen(['/bin/sleep','20'],start_new_session=True)"],start_new_session=True)
assert parent.wait() == 0
jobs=types.SimpleNamespace(active={}, policy={'workerWallSeconds':600})
watchdog(types.SimpleNamespace(jobs=jobs))
""")
        self.assertEqual(code, 124)


if __name__ == '__main__':
    unittest.main(verbosity=2)
