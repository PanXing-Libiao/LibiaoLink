"""Bounded compiled SHX containers; font definitions are not drawing programs.

Shapes 1.0/1.1 and unifont 1.0 use the pinned ezdxf bytecode decoder, but
shape zero is decoded as metadata. Signature offsets follow the terminator,
including the LF-only headers accepted by truedxf 019c2e5 shx/parse.ts.
"""
import struct
from ezdxf.fonts import shapefile as sf


def signature(raw):
    marker = raw.find(b'\x1a', 0, 64)
    if marker < 0:
        raise ValueError('shx-signature-unterminated')
    header = raw[:marker]
    if header.endswith(b'\r\n'):
        header = header[:-2]
    elif header.endswith(b'\n'):
        header = header[:-1]
    else:
        raise ValueError('shx-signature-line-ending-invalid')
    supported = (b'AutoCAD-86 shapes 1.0', b'AutoCAD-86 shapes 1.1',
                 b'AutoCAD-86 unifont 1.0', b'AutoCAD-86 bigfont 1.0')
    if header not in supported:
        raise ValueError('shx-signature-unsupported')
    return header.split(b' ', 1)[1].decode('ascii'), marker+1


class Reader:
    def __init__(self, raw, offset):
        self.raw, self.offset = raw, offset

    def take(self, count):
        end = self.offset+count
        if end > len(self.raw):
            raise ValueError('shx-record-truncated')
        data = self.raw[self.offset:end]
        self.offset = end
        return data

    def unpack(self, fmt):
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))


def split_record(raw):
    name, separator, data = raw.partition(b'\0')
    if not separator or not data:
        raise ValueError('shx-record-name-or-data-missing')
    return name, data


def load(raw):
    kind, offset = signature(raw)
    reader = Reader(raw, offset)
    unicode = kind == 'unifont 1.0'
    records = {}
    if unicode:
        count, definition_size = reader.unpack('<IH')
        if not 1 <= count <= 65536:
            raise ValueError('shx-record-count-invalid')
        records[0] = split_record(reader.take(definition_size))
        for _ in range(count-1):
            number, size = reader.unpack('<HH')
            if number in records:
                raise ValueError('shx-record-duplicate')
            records[number] = split_record(reader.take(size))
        if reader.offset != len(raw):
            raise ValueError('shx-trailing-data')
    elif kind.startswith('shapes '):
        first, last, count = reader.unpack('<HHH')
        if count == 0:
            raise ValueError('shx-record-count-invalid')
        index = [reader.unpack('<HH') for _ in range(count)]
        if (first, last) != (index[0][0], index[-1][0]):
            raise ValueError('shx-directory-range-invalid')
        for number, size in index:
            if number in records:
                raise ValueError('shx-record-duplicate')
            records[number] = split_record(reader.take(size))
        # Some writers omit the optional ASCII EOF trailer. Nothing else is
        # padding: accepting arbitrary tails would mask wrong record lengths.
        if raw[reader.offset:] not in (b'', b'EOF'):
            raise ValueError('shx-trailing-data')
    else:
        raise ValueError('shx-bigfont-requires-indexed-loader')

    name, metrics = records.pop(0) if 0 in records else (b'', None)
    if metrics is None:
        font = sf.ShapeFile(b'', 0, 0)  # A genuine shape library, not a text font.
    else:
        if len(metrics) != (6 if unicode else 4) or metrics[-1] != 0:
            raise ValueError('shx-font-definition-invalid')
        above, below, mode = metrics[:3]
        if above == 0:
            raise ValueError('shx-font-height-undeclared')
        kwargs = {'encoding': sf.FontEncoding(metrics[3]), 'embed': sf.FontEmbedding(metrics[4])} if unicode else {}
        font = sf.ShapeFile(name, above, below, sf.FontMode(mode), **kwargs)
    for number, (label, data) in records.items():
        code_reader = sf.DataReader(data)
        codes = sf.parse_shape_codes(code_reader, unifont=unicode)
        if code_reader.index != len(data):
            raise ValueError('shx-glyph-trailing-program-data')
        font.shapes[number] = sf.Symbol(number, len(data), label, codes)
    font.metrics_profile = 'declared-'+kind.replace(' ', '-') if metrics else 'shape-library'
    return font
