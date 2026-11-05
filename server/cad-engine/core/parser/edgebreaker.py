"""Bounded CLERS disk reconstruction for HSF connectivity blocks.

The topology kernel uses polygon boundaries and the Euler relation for a
triangulated disk. No SDK or third-party implementation is embedded here.
"""
from collections import deque
from dataclasses import dataclass
import struct
from binary import BinaryReader, ConversionError

MAX_POINTS = 2000000
MAX_OPS = 4000000


def invalid(message):
    raise ConversionError('EdgeBreaker: ' + message)


def disk_program(ops):
    """Parse the prefix grammar backwards; store only split right-disk sizes."""
    if not 0 < len(ops) <= MAX_OPS:
        invalid('invalid opcode count')
    regions = []
    splits = {}
    for i in range(len(ops) - 1, -1, -1):
        op = ops[i]
        if op == 2:  # E is a triangular disk.
            regions.append((i, i + 1, 3))
            continue
        if op not in (0, 1, 3, 4):
            invalid(f'unsupported topology opcode {op}')
        children = 2 if op == 4 else 1
        if len(regions) < children:
            invalid('unfinished topology region')
        child, end, size = regions.pop()
        if child != i + 1:
            invalid('noncontiguous topology region')
        if op == 4:
            left, left_end, left_size = regions.pop()
            if left != end:
                invalid('noncontiguous split branches')
            splits[i] = size
            size, end = size + left_size - 1, left_end
        else:
            size += -1 if op == 0 else 1
        if not 2 <= size <= MAX_POINTS:
            invalid('invalid disk boundary length')
        regions.append((i, end, size))
    return list(reversed(regions)), splits


def reconstruct(ops):
    regions, splits = disk_program(ops)
    triangles = []
    next_vertex = 0
    cursor = 0
    for start, end, boundary_size in regions:
        if start != cursor or next_vertex + boundary_size > MAX_POINTS:
            invalid('invalid component boundary')
        ring = deque(range(next_vertex, next_vertex + boundary_size))
        next_vertex += boundary_size
        waiting = []
        while cursor < end:
            if len(ring) < 2:
                invalid('collapsed boundary')
            op_index = cursor
            op = ops[cursor]
            cursor += 1
            a, b = ring[0], ring[1]
            if op == 0:  # Add a new tip; continue through the right gate.
                tip = next_vertex
                next_vertex += 1
                if next_vertex > MAX_POINTS:
                    invalid('topology vertex limit exceeded')
                ring.popleft()
                ring.append(a)
                ring.appendleft(tip)
            elif op == 1:
                if len(ring) < 3:
                    invalid('left join needs three boundary vertices')
                tip = ring.pop()
                ring.popleft()
                ring.appendleft(tip)
            elif op == 3:
                if len(ring) < 3:
                    invalid('right join needs three boundary vertices')
                ring.popleft()
                ring.popleft()
                tip = ring[0]
                ring.appendleft(a)
            elif op == 4:
                right = splits[op_index]
                left = len(ring) - right + 1
                if min(right, left) < 2:
                    invalid('split lies outside boundary')
                # Copy only the smaller disk; long, one-sided split chains
                # cannot turn boundary traversal into quadratic copying.
                if right <= left:
                    ring.popleft()
                    head = [ring.popleft() for _ in range(right - 1)]
                    tip = ring[0]
                    ring.appendleft(a)
                    waiting.append(ring)
                    ring = deque([tip, *head])
                else:
                    tail = [ring.pop() for _ in range(left - 1)]
                    tail.reverse()
                    tip = tail[0]
                    waiting.append(deque([a, *tail]))
                    ring.popleft()
                    ring.appendleft(tip)
            else:  # E consumes exactly one triangular region.
                if len(ring) != 3:
                    invalid('end opcode has a nontriangular boundary')
                tip = ring[2]
                ring = waiting.pop() if waiting else deque()
            if len({a, b, tip}) != 3:
                invalid('degenerate topology triangle')
            triangles.extend((a, b, tip))
            if op == 2 and not ring and cursor != end:
                invalid('early component termination')
        if ring or waiting:
            invalid('open topology region')
    if cursor != len(ops):
        invalid('trailing topology program')
    return triangles, next_vertex


class TableReader(BinaryReader):
    def __init__(self, data, base):
        super().__init__(data)
        self.base = base

    def fail(self, message):
        raise ConversionError('EdgeBreaker: ' + message, offset=self.base + self.p)


@dataclass
class Connectivity:
    point_count: int
    indices: list
    points: bytes
    normals: bytes
    points_scheme: int
    bounds: list
    quantization: list
    layout: str
    scheme: int
    predictors: list


def decode(data):
    if len(data) < 20:
        invalid('truncated block header')
    scheme, table_scheme, points_scheme, normals_scheme, ops_len, table_len, points_len, count = struct.unpack_from('<4B4I', data)
    if scheme not in (0, 1, 2) or table_scheme != 0 or points_scheme not in (0, 1) or normals_scheme != 0:
        invalid('unsupported block encoding')
    if not 0 < count <= MAX_POINTS or not 0 < ops_len <= MAX_OPS:
        invalid('invalid block counts')
    aligned = lambda n: (n + 3) // 4 * 4
    sizes = (ops_len, table_len, points_len)
    candidates = []
    if scheme == 0 and 20 + sum(map(aligned, sizes)) == len(data):
        candidates.append((20, 0))
    if len(data) >= 24:
        normals_len = struct.unpack_from('<I', data, 20)[0]
        if 24 + sum(map(aligned, (*sizes, normals_len))) == len(data):
            candidates.append((24, normals_len))
    if len(candidates) != 1:
        invalid('unknown or ambiguous block lengths')
    header, normals_len = candidates[0]
    parts = []
    cursor = header
    for size in (*sizes, normals_len):
        parts.append(data[cursor:cursor + size])
        if any(data[cursor + size:cursor + aligned(size)]):
            invalid('nonzero block alignment padding')
        cursor += aligned(size)
    ops, table_bytes, point_bytes, normal_bytes = parts
    table = TableReader(table_bytes, header + aligned(ops_len))
    flags = table.u32()
    if flags & ~0xf8:
        invalid('unsupported auxiliary table flags')
    dummy_count = table.u32() if flags & 8 else 0
    patch_count = table.u32() if flags & 16 else 0
    if max(dummy_count, patch_count) > MAX_POINTS:
        invalid('oversized auxiliary table')
    fixed = (24 if flags & 32 else 0) + (12 if flags & 64 else 0) + (12 if flags & 128 else 0)
    available = len(table_bytes) - table.p - fixed - dummy_count * 4
    if available < 0 or available % 8:
        invalid('invalid patch table length')
    entries = available // 4
    if entries not in (patch_count, patch_count * 2):
        invalid('patch declaration does not match table structure')
    removed = set()
    value = 0
    for i in range(dummy_count):
        delta = table.u32()
        if i and not delta:
            invalid('duplicate dummy vertex')
        value += delta
        removed.add(value)
    aliases = {}
    value = 0
    for i in range(entries // 2):
        delta, target = table.u32(), table.u32()
        if i and not delta:
            invalid('duplicate patch vertex')
        value += delta
        if value in removed or target >= count:
            invalid('conflicting or out-of-range patch')
        aliases[value] = target
    bounds = table.floats(6) if flags & 32 else None
    if bounds and any(bounds[i] > bounds[i + 3] for i in range(3)):
        invalid('reversed point bounds')
    quantization = [table.u32() for _ in range(3)] if flags & 64 else [11] * 3
    normal_quantization = [table.u32() for _ in range(3)] if flags & 128 else [11] * 3
    if any(not 1 <= bits <= 32 for bits in quantization + normal_quantization) or table.p != len(table_bytes):
        invalid('invalid auxiliary table suffix')
    triangles, total = reconstruct(ops)
    if any(i >= total for i in removed | aliases.keys()):
        invalid('auxiliary vertex outside topology')
    if total - len(removed) - len(aliases) != count:
        invalid('topology and unique point count disagree')
    mapping = []
    next_point = 0
    for vertex in range(total):
        if vertex in removed:
            mapping.append(None)
        elif vertex in aliases:
            mapping.append(aliases[vertex])
        else:
            mapping.append(next_point)
            next_point += 1
    indices = []
    for at in range(0, len(triangles), 3):
        face = [mapping[v] for v in triangles[at:at + 3]]
        if None in face:
            continue
        if len(set(face)) != 3:
            invalid('patch collapses a surface triangle')
        indices.extend(face)
    if not indices:
        invalid('no surface remains after dummy removal')
    predictors = []
    if point_bytes and scheme < 2:
        raw_refs = prediction_references(ops, triangles)
        # Dummy rows disappear; patch rows remain in the prediction recipe.
        # Recipes refer to the compact point array after alias resolution.
        for vertex, refs in enumerate(raw_refs):
            if vertex not in removed:
                predictors.append(tuple(mapping[v] if v is not None else None for v in refs))
                if len(predictors) == count:
                    break
        if len(predictors) != count:
            invalid('incomplete prediction recipe')
        for vertex, refs in enumerate(predictors):
            if any(v is not None and not 0 <= v < vertex for v in refs):
                invalid('prediction references an unavailable point')
    return Connectivity(count, indices, point_bytes, normal_bytes, points_scheme, bounds, quantization, f'{header}-byte', scheme, predictors)


def validate_point_residuals(block):
    """Check known residual framing without presenting unselected coarse points."""
    n = block.point_count * 3
    data = block.points
    if block.bounds is None:
        invalid('compressed points lack bounds')
    if block.points_scheme == 0:
        if len(data) != n * 2:
            invalid('wrong short residual count')
        return
    if len(data) % 4:
        invalid('residual words are unaligned')
    reader = ResidualBits(data)
    for _ in range(n):
        for bits in (2, 6, 10, 14, 18, 22, 26, 31):
            value = reader.get(bits)
            if value != (1 << bits) - 1:
                break
        else:
            invalid('residual escape overflow')
    reader.finish()


class ResidualBits:
    def __init__(self, data):
        self.data = data
        self.cursor = 0

    def get(self, bits):
        value = 0
        while bits:
            word = self.cursor // 32
            used = self.cursor % 32
            if word * 4 + 4 > len(self.data):
                invalid('truncated residual bitstream')
            take = min(bits, 32 - used)
            sample = struct.unpack_from('<I', self.data, word * 4)[0]
            value = value << take | (sample >> (32 - used - take) & ((1 << take) - 1))
            bits -= take
            self.cursor += take
        return value

    def finish(self):
        remaining = len(self.data) * 8 - self.cursor
        if remaining >= 32 or self.get(remaining):
            invalid('trailing residual data')


def prediction_references(ops, triangles):
    """Build dependencies from the decoded disks and each traversal gate."""
    regions, _ = disk_program(ops)
    result = []
    for start, end, boundary in regions:
        first = len(result)
        result.extend((v - 1 if v > first else None, None, None) for v in range(first, first + boundary))
        opposite = None
        waiting = []
        for i in range(start, end):
            a, b, tip = triangles[i * 3:i * 3 + 3]
            op = ops[i]
            if op == 0:
                if tip != len(result):
                    invalid('prediction vertex order disagrees with topology')
                result.append((a, b, opposite))
            if op == 4:
                waiting.append(b)
            if op == 2:
                opposite = waiting.pop() if waiting else None
            else:
                opposite = b if op == 3 else a
        if waiting:
            invalid('unfinished prediction branch')
    return result


def point_residuals(block):
    n = block.point_count * 3
    if block.points_scheme == 0:
        if len(block.points) != n * 2:
            invalid('wrong short residual count')
        return [value[0] for value in struct.iter_unpack('<h', block.points)]
    if len(block.points) % 4:
        invalid('residual words are unaligned')
    reader = ResidualBits(block.points)
    values = []
    for _ in range(n):
        for width in (2, 6, 10, 14, 18, 22, 26, 31):
            raw = reader.get(width)
            if raw != (1 << width) - 1:
                values.append(raw - ((1 << (width - 1)) - 1))
                break
        else:
            invalid('residual escape overflow')
    reader.finish()
    return values


def decode_points(block):
    if block.scheme not in (0, 1):
        invalid('unsupported predictive point scheme')
    if block.bounds is None or len(block.predictors) != block.point_count:
        invalid('compressed points lack bounds or prediction recipe')
    residuals = point_residuals(block)
    quantized = []
    maxima = [(1 << bits) - 1 for bits in block.quantization]
    for vertex, refs in enumerate(block.predictors):
        if all(v is not None for v in refs):
            a, b, c = (quantized[v] for v in refs)
            prediction = [a[k] + b[k] - c[k] for k in range(3)]
        else:
            prediction = next((quantized[v] for v in refs if v is not None), (0, 0, 0))
        point = [prediction[k] + residuals[vertex * 3 + k] for k in range(3)]
        if any(not 0 <= point[k] <= maxima[k] for k in range(3)):
            invalid('predicted point is outside quantization bounds')
        quantized.append(point)
    return [block.bounds[k] + point[k] * (block.bounds[k + 3] - block.bounds[k]) / maxima[k]
            for point in quantized for k in range(3)]
