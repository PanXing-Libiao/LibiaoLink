"""Build the independent DWG CLI from pinned corresponding source (builder only)."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


def build(spec_file, destination):
    spec = json.loads(spec_file.read_text())
    with tempfile.TemporaryDirectory(prefix='build-dwg-') as name:
        folder = Path(name)
        archive = folder / ('libredwg-' + spec['version'] + '.tar.xz')
        with urllib.request.urlopen(spec['url'], timeout=60) as source, archive.open('wb') as target:
            shutil.copyfileobj(source, target)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != spec['sha256']:
            raise ValueError('LibreDWG source checksum mismatch')
        with tarfile.open(archive) as source:
            source.extractall(folder, filter='data')
        source = folder / ('libredwg-' + spec['version'])
        subprocess.run(['./configure', '--disable-bindings', '--disable-docs', '--disable-shared', '--enable-static'], cwd=source, check=True)
        subprocess.run(['make', '-j2'], cwd=source, check=True)
        binary = destination / 'bin/dwgread'
        binary.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / 'programs/dwgread', binary)
        subprocess.run([str(binary), '--version'], check=True)
        notices = destination / 'share/libredwg'
        notices.mkdir(parents=True, exist_ok=True)
        # Carry the exact source and build recipe with the GPL tool; no reliance
        # on a mutable download link when this image is later redistributed.
        for path in (archive, source / 'COPYING', spec_file, Path(__file__).resolve()):
            shutil.copy2(path, notices / path.name)


if __name__ == '__main__':
    build(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
