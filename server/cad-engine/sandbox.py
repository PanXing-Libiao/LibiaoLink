"""Fail closed unless the Linux runtime enforces the CAD service boundary."""
import os
import resource
import socket
from pathlib import Path

MIB = 1024 * 1024
MEMORY_BYTES = 3 * 1024 * MIB
PIDS = 64
FILE_BYTES = 256 * MIB
ROOT = Path('/var/lib/cad')
SOCKET = '/run/cad/engine.sock'


def verify():
    if os.getpid() != 1 or os.getuid() == 0 or os.getgid() == 0:
        raise RuntimeError('CAD must run as non-root namespace init')
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    if any(int(status[key].strip(), 16) for key in ('CapEff', 'CapPrm', 'CapBnd')) or status['NoNewPrivs'].strip() != '1' or status['Seccomp'].strip() != '2':
        raise RuntimeError('CAD requires dropped capabilities, no-new-privileges and seccomp')
    cgroup = Path('/sys/fs/cgroup')
    memory = int((cgroup / 'memory.max').read_text())
    pids = int((cgroup / 'pids.max').read_text())
    quota, period = map(int, (cgroup / 'cpu.max').read_text().split())
    if not 0 < memory <= MEMORY_BYTES or not 0 < pids <= PIDS or not 0 < quota <= period:
        raise RuntimeError('CAD requires finite memory, CPU and PID cgroup limits')
    if (cgroup / 'memory.swap.max').read_text().strip() != '0':
        raise RuntimeError('CAD swap must be disabled')
    # Some kernels instantiate DOWN tunnel devices even with --network none.
    # No non-loopback link may be UP; dropped NET_ADMIN prevents enabling them.
    for _, name in socket.if_nameindex():
        flags = int((Path('/sys/class/net') / name / 'flags').read_text(), 16)
        if flags & 1 and not flags & 8:
            raise RuntimeError('CAD networking must be disabled')
    if any(line.split()[0] != 'lo' for line in Path('/proc/net/route').read_text().splitlines()[1:] if line.strip()):
        raise RuntimeError('CAD must not have outbound routes')
    mounts = {}
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        before, after = line.split(' - ', 1)
        fields, filesystem = before.split(), after.split()
        mounts[fields[4]] = (filesystem[0], set(fields[5].split(',')) | set(filesystem[2].split(',')))
    if 'ro' not in mounts['/'][1]:
        raise RuntimeError('CAD root filesystem must be read-only')
    if 'ro' not in mounts['/sys/fs/cgroup'][1]:
        raise RuntimeError('CAD cannot modify its cgroup limits')
    for path, budget in [('/var/lib/cad', 1536 * MIB), ('/tmp', 384 * MIB), ('/run/cad', MIB)]:
        kind, flags = mounts[path]
        space = os.statvfs(path)
        if kind != 'tmpfs' or not {'noexec', 'nosuid', 'nodev'} <= flags or space.f_blocks * space.f_frsize > budget:
            raise RuntimeError('CAD writable storage must be bounded tmpfs')
    for kind, maximum in [(resource.RLIMIT_FSIZE, FILE_BYTES), (resource.RLIMIT_NOFILE, 128), (resource.RLIMIT_CORE, 0)]:
        soft, hard = resource.getrlimit(kind)
        if soft == resource.RLIM_INFINITY or hard == resource.RLIM_INFINITY or not 0 <= soft <= hard <= maximum:
            raise RuntimeError('CAD file, descriptor and core limits are required')
    return {'memoryBytes': memory, 'cpuQuota': quota, 'cpuPeriod': period, 'pids': pids, 'swapBytes': 0,
            'fileBytes': FILE_BYTES, 'storageBytes': 1536 * MIB, 'network': 'none'}
