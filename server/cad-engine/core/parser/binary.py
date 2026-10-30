"""Bounded little-endian primitives for the local HSF converter."""
import math
import struct


class ConversionError(Exception):
    def __init__(self, message, *, stage='hsf', offset=None):
        super().__init__(message)
        self.stage = stage
        self.offset = offset


class BinaryReader:
    def __init__(self, data):
        self.data = data
        self.p = 0

    def fail(self, message):
        raise ConversionError(message, offset=self.p)

    def read(self, size):
        if size < 0 or size > len(self.data) - self.p:
            self.fail(f'Truncated record: requested {size} bytes')
        result = self.data[self.p:self.p + size]
        self.p += size
        return result

    def u8(self):
        return self.read(1)[0]

    def u16(self):
        return struct.unpack('<H', self.read(2))[0]

    def u32(self):
        return struct.unpack('<I', self.read(4))[0]

    def floats(self, count):
        values = struct.unpack('<' + 'f' * count, self.read(count * 4))
        if not all(math.isfinite(x) for x in values):
            self.fail('Non-finite floating point value')
        return list(values)

    def text8(self):
        return self.read(self.u8()).decode('utf-8', 'replace')

    def text16(self, unicode=False):
        length = self.u16()
        if length == 65535:
            length = self.u32()
        return self.read(length * (2 if unicode else 1)).decode('utf-16le' if unicode else 'utf-8', 'replace')


def unpack_samples(data, count, bits):
    if not 1 <= bits <= 32 or len(data) * 8 < count * bits:
        raise ConversionError('Invalid packed sample array')
    # Samples run MSB-first within little-endian 32-bit words (including word padding).
    if len(data) % 4:
        raise ConversionError('Packed sample data is not word aligned')
    data = b''.join(data[i:i + 4][::-1] for i in range(0, len(data), 4))
    result = []
    accumulator = available = 0
    cursor = 0
    mask = (1 << bits) - 1
    for _ in range(count):
        while available < bits:
            accumulator = (accumulator << 8) | data[cursor]
            cursor += 1
            available += 8
        available -= bits
        result.append((accumulator >> available) & mask)
        accumulator &= (1 << available) - 1
    return result
