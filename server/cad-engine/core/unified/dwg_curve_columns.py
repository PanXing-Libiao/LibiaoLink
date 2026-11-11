"""Optional binary projection of the verified DWG archive for an open preview."""
import array
import io
import re
import struct
import sys

_HANDLE = re.compile(r'entity-([0-9A-F]{1,16})\Z')


def _write_array(output, values):
    if sys.byteorder != 'little':
        values.byteswap()
    values.tofile(output)


def encode_curve_columns(document, source_sha256, limit):
    """Return source-bound little-endian columns, or None when the projection cannot fit."""
    entities = document['drawing']['entities']
    native = document['extensions'].get('org.libiaolink.dwg/1', {}).get('nativeGeometry', {})
    rows = {'line': [], 'arc': []}
    size = 40  # source SHA-256 followed by two uint32 row counts
    for key, entity in entities.items():
        kind = entity['geometry']['type']
        arc = native.get(key) if kind == 'arc' else None
        if kind != 'line' and not (isinstance(arc, dict) and arc.get('type') == 'arc'):
            continue
        handle = _HANDLE.fullmatch(key)
        if handle:
            size += 56 if kind == 'line' else 176
            if size > limit:
                return None
            rows[kind].append((int(handle[1], 16), key))
    if size == 40:
        return None

    output = io.BytesIO()
    output.write(bytes.fromhex(source_sha256))
    output.write(struct.pack('<II', len(rows['line']), len(rows['arc'])))
    for kind, ordered in rows.items():
        ordered.sort()
        _write_array(output, array.array('Q', (handle for handle, _ in ordered)))
        batch = array.array('d')
        for _, key in ordered:
            g = entities[key]['geometry']
            if kind == 'line':
                batch.extend((*g['start'], *g['end']))
            else:
                n = native[key]
                batch.extend((*g['center'], *g['normal'], *g['xAxis'], g['radius'], g['startAngle'], g['sweepAngle'],
                              *n['center'], *n['normal'], n['radius'], n['startAngle'], n['endAngle']))
            if len(batch) >= 8192:
                _write_array(output, batch)
                del batch[:]
        _write_array(output, batch)
    return output.getvalue() if output.tell() == size else None
