"""Content-based, bounded extraction. Never executes programs or contacts a network."""
from dataclasses import dataclass
import hashlib
import io
from pathlib import PurePosixPath
import re
import struct
import zipfile
from binary import ConversionError

MAX_INPUT = 256 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
HSF_HEADER = re.compile(rb';; HSF V([0-9]+)\.([0-9]{2})[ \r]*\n')


@dataclass
class ModelInput:
    hsf: bytes
    source_hash: str
    containers: list
    entries: dict


def extract_model(data, depth=0, chain=None):
    if len(data) > MAX_INPUT or depth > 3:
        raise ConversionError('Input size or nesting limit exceeded', stage='container')
    chain = list(chain or [])
    if HSF_HEADER.match(data):
        return ModelInput(data, hashlib.sha256(data).hexdigest(), chain + ['HSF'], {})
    is_pe = data.startswith(b'MZ')
    if is_pe:
        if len(data) < 64:
            raise ConversionError('Truncated executable header', stage='container')
        pe = struct.unpack_from('<I', data, 60)[0]
        if data[pe:pe + 4] != b'PE\0\0':
            raise ConversionError('Invalid executable header', stage='container')
        chain.append('PE (read only)')
    candidates = []
    # ZIP central-directory offsets are interpreted by zipfile, including SFX prefixes.
    # Enumerating bounded EOCD records also handles a model archive before a runtime tail.
    cursor = 0
    for _ in range(64):
        at = data.find(b'PK\x05\x06', cursor)
        if at < 0:
            break
        cursor = at + 4
        if at + 22 > len(data):
            continue
        end = at + 22 + struct.unpack_from('<H', data, at + 20)[0]
        if end > len(data):
            continue
        recognized = False
        try:
            with zipfile.ZipFile(io.BytesIO(data[:end])) as archive:
                infos = archive.infolist()
                if len(infos) > 128 or sum(i.file_size for i in infos) > MAX_EXPANDED:
                    raise ConversionError('Archive expansion limit exceeded', stage='container')
                names = set()
                for info in infos:
                    path = PurePosixPath(info.filename.replace('\\', '/'))
                    if path.is_absolute() or '..' in path.parts or info.filename in names:
                        raise ConversionError('Unsafe or duplicate archive entry', stage='container')
                    names.add(info.filename)
                    if info.flag_bits & 1:
                        raise ConversionError('Encrypted archive is unsupported', stage='container')
                direct = [i for i in infos if PurePosixPath(i.filename).name == 'eModel']
                nested = [i for i in infos if i.filename.lower().endswith(('.easm', '.eprt', '.edrw', '.hsf', '.exe'))]
                recognized = bool(direct or nested)
                if direct:
                    if len(direct) != 1:
                        raise ConversionError('Ambiguous eModel archive', stage='container')
                    content = archive.read(direct[0])  # Includes CRC verification.
                    if not HSF_HEADER.match(content):
                        raise ConversionError('eModel is not a supported HSF stream', stage='container')
                    entries = {PurePosixPath(i.filename).name: archive.read(i) for i in infos if PurePosixPath(i.filename).name in ('preview.jpg', 'scene.xml')}
                    candidates.append(ModelInput(content, hashlib.sha256(data).hexdigest(), chain + ['eDrawings ZIP'], entries))
                elif nested:
                    if len(nested) != 1:
                        raise ConversionError('Archive contains multiple candidate models; select one explicitly', stage='container')
                    child = extract_model(archive.read(nested[0]), depth + 1, chain + ['ZIP'])
                    child.source_hash = hashlib.sha256(data).hexdigest()
                    candidates.append(child)
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError) as error:
            if not recognized:
                continue
            raise ConversionError(f'Invalid model archive: {error}', stage='container') from error
    if not candidates and is_pe:
        # Older self-contained eDrawings embed a bare HSF rather than a ZIP.
        matches = list(HSF_HEADER.finditer(data))
        if len(matches) > 8:
            raise ConversionError('Too many embedded HSF candidates', stage='container')
        for match in matches:
            candidates.append(ModelInput(data[match.start():], hashlib.sha256(data).hexdigest(), chain + [f'embedded HSF at {match.start()}'], {}))
    unique = {hashlib.sha256(item.hsf).hexdigest(): item for item in candidates}
    if len(unique) != 1:
        raise ConversionError('No unique supported eDrawings model found', stage='container')
    return next(iter(unique.values()))
