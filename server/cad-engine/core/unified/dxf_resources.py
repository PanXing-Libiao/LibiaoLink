"""Bounded, upload-only DXF dependency package. Never resolve source paths on disk."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct

MAGIC = b'DXFRES1\n'
MAX_FILES = 128
MAX_BYTES = 64 * 1024 * 1024
MAX_HEADER = 128 * 1024
MAX_WIRE_BYTES = MAX_BYTES + MAX_HEADER + 12
EXTENSIONS = ('.dxf', '.dwg', '.shx', '.shp', '.ttf', '.otf', '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff', '.webp', '.pdf', '.dgn', '.dwf', '.dwfx', '.ctb', '.stb')


def logical_path(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError('dxf-resource-path: invalid logical path')
    value = value.replace('\\', '/')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('.', '..', '') for part in value.split('/')) or ':' in value or any(ord(char) < 32 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff for char in value):
        raise ValueError('dxf-resource-path: paths must stay inside the selected file set')
    if path.suffix.lower() not in EXTENSIONS:
        raise ValueError('dxf-resource-type: unsupported companion file extension')
    return str(path)


def decode_package(raw):
    if len(raw) < 12 or raw[:8] != MAGIC or len(raw) > MAX_WIRE_BYTES:
        raise ValueError('dxf-resource-package: invalid package')
    size = struct.unpack_from('<I', raw, 8)[0]
    if not 0 < size <= MAX_HEADER or 12 + size > len(raw):
        raise ValueError('dxf-resource-package: invalid metadata length')
    metadata = json.loads(raw[12:12 + size])
    if metadata.get('version') != 'dxf-resources/1':
        raise ValueError('dxf-resource-package: unsupported version')
    entries = metadata.get('files')
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_FILES:
        raise ValueError('dxf-resource-limit: at most 128 files')
    files = {}
    offset = 12 + size
    for entry in entries:
        name = logical_path(entry.get('path'))
        length = entry.get('byteLength')
        if type(length) is not int or length <= 0 or name in files or offset + length > len(raw):
            raise ValueError('dxf-resource-package: duplicate path or invalid file length')
        files[name] = raw[offset:offset + length]
        offset += length
    main = logical_path(metadata.get('main'))
    if offset != len(raw) or sum(map(len, files.values())) > MAX_BYTES or main not in files or not main.lower().endswith('.dxf'):
        raise ValueError('dxf-resource-package: invalid main file or total length')
    return {'main': main, 'files': files}


def fingerprint(package):
    rows = [(name, hashlib.sha256(raw).hexdigest()) for name, raw in sorted(package['files'].items())]
    return hashlib.sha256(json.dumps([package['main'], rows], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def write_manifest(package, folder):
    folder = Path(folder) / 'dxf-inputs'
    folder.mkdir()
    entries = []
    for index, (name, raw) in enumerate(sorted(package['files'].items())):
        filename = str(index) + PurePosixPath(name).suffix.lower()
        (folder / filename).write_bytes(raw)
        entries.append({'path': name, 'file': filename})
    manifest = folder / 'manifest.json'
    manifest.write_text(json.dumps({'main': package['main'], 'files': entries}))
    return str(manifest)


def read_manifest(path):
    path = Path(path)
    metadata = json.loads(path.read_text())
    files = {}
    for row in metadata['files']:
        name = logical_path(row['path'])
        physical = path.parent / row['file']
        if physical.resolve().parent != path.parent.resolve() or name in files:
            raise ValueError('dxf-resource-package: invalid worker manifest')
        files[name] = physical.read_bytes()
    if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_BYTES:
        raise ValueError('dxf-resource-limit: worker package exceeds limit')
    return metadata['main'], files
