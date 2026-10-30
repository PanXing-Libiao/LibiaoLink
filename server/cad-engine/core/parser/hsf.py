"""HSF record reader, implemented against the public Tech Soft 3D HSF specification.

Unknown records stop conversion. Segment traversal and refinements share one stream;
there is no model-specific entry point, section offset, or configuration name.
"""
from collections import Counter
from dataclasses import dataclass, field
import math
import posixpath
import re
import struct
import zlib
from binary import BinaryReader, ConversionError, unpack_samples
from containers import HSF_HEADER, MAX_EXPANDED
from edgebreaker import decode as decode_connectivity, validate_point_residuals, decode_points


def legacy_root_header_stop(data, start, declared, limit):
    """Recognize one observed private layout; never search for an end marker.

    Some old headers undercount only their final RGB/reserved field. This is
    empirical application data, not an exception in the public HSF framing.
    """
    if not 9 < declared <= 4096:
        return None
    reader = BinaryReader(data[start:min(start + declared + 5, limit)])

    def text():
        value = reader.read(reader.u8()).decode('utf-8')
        if any(ord(char) < 32 for char in value):
            reader.fail('Invalid private header text')
        return value

    def flag():
        if reader.u8() not in (0, 1):
            reader.fail('Invalid private header flag')

    def key(widths):
        width = reader.u8()
        if width not in widths:
            reader.fail('Unknown private header key layout')
        reader.read(width)

    try:
        if reader.u8() != 0xbe:
            return None
        labels = [text() for _ in range(4)]
        if not labels[0] or not labels[1]:
            return None
        flag()
        matrix = reader.floats(16)
        if any(abs(matrix[j]) > 1e-6 for j in (3, 7, 11)) or abs(matrix[15] - 1) > 1e-6:
            return None
        reader.u32()  # Opaque application flags, not a sample identifier.
        flag()
        reader.read(3)
        flag()
        if any(reader.u32() not in (0, 1) for _ in range(3)):
            return None
        text()
        key((16, 24))
        key((16,))
        text()
        flag()
        flag()
        text()
        text()
        key((24,))
        footer = reader.p
        reader.read(3)
        if reader.u8() != 0:
            return None
        stop = reader.p
        if not footer <= declared <= stop or reader.u8() != ord(']'):
            return None
        return start + stop
    except (ConversionError, UnicodeError):
        return None


@dataclass
class Segment:
    path: str
    name: str
    children: list = field(default_factory=list)
    includes: list = field(default_factory=list)
    shapes: list = field(default_factory=list)
    attributes: dict = field(default_factory=dict)


@dataclass
class Shape:
    path: str
    levels: dict = field(default_factory=dict)


class HsfReader(BinaryReader):
    def __init__(self, data):
        super().__init__(data)
        header = HSF_HEADER.match(data)
        if not header:
            self.fail('Missing HSF header')
        self.version = int(header[1]) * 100 + int(header[2])
        if not 700 <= self.version <= 1910:
            self.fail(f'Unsupported HSF version {self.version}')
        self.p = header.end()
        self.nodes = {'/': Segment('/', 'root')}
        self.stack = ['/']
        self.tags = []
        self.shapes = []
        self.last = None
        self.views = []
        self.header_bounds = None
        self.histogram = Counter()
        self.notes = Counter()
        self.texture_names = set()
        self.active_compression_end = None
        self.total_expanded = 0
        self.vertices = 0
        self.terminated = False
        self.history = []
        self.lock_records = []

    @property
    def current(self):
        return self.nodes[self.stack[-1]]

    def path(self, name):
        if name.startswith('?Include Library'):
            name = '/include library' + name[len('?Include Library'):]
        return posixpath.normpath(name if name.startswith('/') else self.stack[-1].rstrip('/') + '/' + name)

    def segment(self, name):
        if len(self.stack) >= 256:
            self.fail('Segment nesting limit exceeded')
        path = self.path(name)
        if path not in self.nodes:
            if len(self.nodes) >= 500000:
                self.fail('Segment limit exceeded')
            self.nodes[path] = Segment(path, posixpath.basename(path))
            parent = posixpath.dirname(path) or '/'
            if parent in self.nodes and path != parent:
                self.nodes[parent].children.append(path)
        self.stack.append(path)
        self.last = ('segment', path)

    def tag(self, index, kind):
        if index >= len(self.tags) or self.tags[index][0] != kind:
            self.fail(f'Invalid {kind} tag {index}')
        return self.tags[index][1]

    def mask(self):
        value = self.u8()
        for shift in (8, 16, 24):
            if value & (1 << (shift - 1)):
                value |= self.u8() << shift
        return value

    def visibility(self):
        mask, value = self.u8(), self.u8()
        if mask & 0x80:
            mask |= self.u16() << 8
            value |= self.u16() << 8
        if mask & 0x800000:
            mask |= self.u8() << 24
            value |= self.u8() << 24
        return mask, value

    def count(self, maximum, kind):
        count = self.u32()
        if count > maximum:
            self.fail(f'{kind} count exceeds limit: {count}')
        return count

    def color(self, target):
        mask = self.mask()
        channels = self.u8()
        if channels & 0x80:
            channels |= self.u8() << 8
        for bit in (1, 2, 4, 8, 16):
            if channels & bit:
                length = self.u8()
                if length == 255:
                    length = self.u32()
                value = self.read(length) if length else self.read(3)
                if bit == 1 and mask & 1:
                    if length:
                        found = re.search(rb'r=([\d.eE+\-]+) g=([\d.eE+\-]+) b=([\d.eE+\-]+)', value, re.IGNORECASE)
                        if found:
                            rgb = [float(x) for x in found.groups()]
                            if not all(math.isfinite(x) and 0 <= x <= 1 for x in rgb):
                                self.fail('Invalid material RGB')
                            target['color'] = rgb
                        elif value in self.texture_names:
                            self.notes['diffuse_texture_not_exported'] += 1
                        else:
                            self.fail('Unsupported diffuse material expression')
                    else:
                        target['color'] = [x / 255 for x in value]
        for bit in (0x20, 0x40):
            if channels & bit:
                self.read(4)
        for bit in (0x100, 0x200):
            if channels & bit:
                self.read(self.u8())
        if channels & ~0x3ff:
            self.fail('Unsupported material channels')

    def camera(self, named):
        projection = self.u8()
        values = self.floats(11)
        for bit in (4, 8, 16):
            if projection & bit:
                self.floats(1)
        name = self.text8() if named else ''
        self.views.append({'name': name, 'projection': projection, 'values': values, 'path': self.stack[-1]})
        self.last = ('view', len(self.views) - 1)

    def new_shape(self):
        if len(self.shapes) >= 200000:
            self.fail('Geometry object limit exceeded')
        index = len(self.shapes)
        self.shapes.append(Shape(self.stack[-1]))
        self.current.shapes.append(index)
        return index

    def quantized(self, count, dimensions, bounds, bits, payload):
        if any(bounds[j] > bounds[j + dimensions] for j in range(dimensions)):
            self.fail('Reversed quantization bounds')
        if bits == 8:
            if len(payload) != count * dimensions:
                self.fail('Invalid byte quantization payload length')
            values = payload
        else:
            values = unpack_samples(payload, count * dimensions, bits)
        scale = (1 << bits) - 1
        return [bounds[j % dimensions] + value * (bounds[j % dimensions + dimensions] - bounds[j % dimensions]) / scale for j, value in enumerate(values)]

    def shell(self, in_collection=False):
        flags = self.u8()
        extra = self.u16() if flags & 0x80 else 0
        if extra & ~7:
            self.fail(f'Unsupported shell extended flags {extra:#x}')
        if extra & 1 and in_collection:
            self.fail('Nested shell collections are unsupported')
        if in_collection and not flags & 0x10:
            self.fail('Refinements inside shell collections are unsupported')
        index = self.new_shape() if flags & 0x10 else self.tag(self.u32(), 'shape')
        lod = self.u8()
        if in_collection:
            lod = 0  # The public collection format ignores a child shell's LOD.
        self.last = ('shape', index)
        if extra & 2:
            self.notes['null_shell_placeholders'] += 1
            return
        if flags & 0x20:
            self.floats(6)
            self.notes['bounding_shells'] += 1
            return
        if flags & 0x40:
            self.connectivity_shell(flags, lod, index, coarse=in_collection or lod > 0)
            return
        if extra & 1:
            self.coarse_collection(index, lod)
            return
        if flags & 1:
            scheme = self.u8()
            count = self.count(2000000, 'Vertex')
            if scheme != 1:
                self.fail(f'Unsupported point compression scheme {scheme}')
            bounds = self.floats(6)
            bits = self.u8()
            length = self.count(MAX_EXPANDED, 'Point payload')
            points = self.quantized(count, 3, bounds, bits, self.read(length))
        else:
            count = self.count(2000000, 'Vertex')
            points = self.floats(count * 3)
        empty_coarse = not count and not flags & 9 and lod > 0
        if not count and not empty_coarse:
            self.fail('Empty shell vertices')
        self.vertices += count
        if self.vertices > 4000000:
            self.fail('Total vertex limit exceeded')
        scheme = self.u8()
        if scheme != 1:
            self.fail(f'Unsupported face compression scheme {scheme}')
        payload = self.read(self.count(MAX_EXPANDED, 'Face payload'))
        if not payload or payload[0] not in (8, 16, 32) or (len(payload) - 1) % (payload[0] // 8):
            self.fail('Invalid face list storage')
        code = {8: 'b' if extra & 4 else 'B', 16: 'h' if extra & 4 else 'H', 32: 'i' if extra & 4 else 'I'}[payload[0]]
        faces = [x[0] for x in struct.iter_unpack('<' + code, payload[1:])]
        triangles = []
        cursor = face_count = 0
        while cursor < len(faces):
            size = faces[cursor]
            cursor += 1
            length = abs(size)
            if length < 3 or cursor + length > len(faces):
                self.fail('Invalid face list arity')
            sequence = faces[cursor:cursor + length]
            cursor += length
            if min(sequence) < 0 or max(sequence) >= count:
                self.fail('Out-of-range face index')
            if flags & 4 and size > 0:
                for j in range(length - 2):
                    triangle = (sequence[j], sequence[j + 1], sequence[j + 2]) if not j % 2 else (sequence[j + 1], sequence[j], sequence[j + 2])
                    if len(set(triangle)) == 3:
                        triangles.extend(triangle)
                    face_count += 1
            elif size > 0 or flags & 4:
                if not flags & 4 and length != 3:
                    self.fail('General polygons require a verified polygon triangulator')
                for j in range(1, length - 1):
                    triangles.extend((sequence[0], sequence[j], sequence[j + 1]))
                    face_count += 1
            else:
                self.fail('Polygon holes are unsupported; refusing to fill holes')
        if empty_coarse:
            self.notes['empty_coarse_refinements'] += 1
            return
        geometry = {'points': points, 'indices': triangles, 'sourceFaces': face_count, 'attributes': {}}
        if flags & 8:
            self.optionals(geometry)
        shape = self.shapes[index]
        if lod in shape.levels:
            self.fail(f'Duplicate geometry level {index}/{lod}')
        shape.levels[lod] = geometry
        self.notes['decoded_shells'] += 1

    def connectivity_shell(self, flags, lod, index, coarse):
        if lod in self.shapes[index].levels:
            self.fail('Duplicate connectivity geometry level')
        if self.u8() != 5:
            self.fail('Unsupported connectivity wrapper')
        length = self.count(MAX_EXPANDED, 'Connectivity payload')
        start = self.p
        data = self.read(length)
        try:
            block = decode_connectivity(data)
        except ConversionError as error:
            raise ConversionError(str(error), offset=start + (error.offset or 0)) from error
        self.vertices += block.point_count
        if self.vertices > 4000000:
            self.fail('Total vertex limit exceeded')
        if flags & 1:
            try:
                if coarse:
                    validate_point_residuals(block)
                    points = []
                    self.notes['coarse_predictive_points_not_exported'] += 1
                else:
                    points = decode_points(block)
                    self.notes['decoded_predictive_point_shells'] += 1
            except ConversionError as error:
                raise ConversionError(str(error), offset=start) from error
        else:
            if block.points:
                self.fail('Conflicting connectivity point encoding')
            points = self.floats(block.point_count * 3)
        geometry = {'points': points, 'indices': block.indices, 'sourceFaces': len(block.indices) // 3, 'attributes': {}}
        if flags & 8:
            self.optionals(geometry, vertex_count=block.point_count)
        if block.normals:
            self.notes['connectivity_normals_recomputed'] += 1
        self.shapes[index].levels[lod] = geometry
        self.notes['decoded_connectivity_shells'] += 1
        self.notes['connectivity_header_' + block.layout] += 1

    def repeat_shell(self, in_collection=False):
        source, source_lod, destination, destination_lod = self.u32(), self.u32(), self.u32(), self.u32()
        options, matrix = self.u8(), self.floats(12)
        if in_collection and destination != 0xffffffff:
            self.fail('Collection repeat cannot refine an external shell')
        source_id = self.tag(source, 'shape')
        destination_id = self.new_shape() if destination == 0xffffffff else self.tag(destination, 'shape')
        self.notes[f'repeat_unused_options_{options}'] += 1
        if source_lod not in self.shapes[source_id].levels or destination_lod in self.shapes[destination_id].levels:
            self.fail(f'Invalid or unsupported repeated shell: {source}/{source_lod} -> {destination}/{destination_lod}, options={options}, existing={list(self.shapes[source_id].levels)}')
        self.shapes[destination_id].levels[destination_lod] = {'repeat': source_id, 'sourceLod': source_lod, 'matrix': matrix}
        self.notes['repeated_shells'] += 1

    def coarse_collection(self, index, lod):
        if lod == 0:
            self.fail('Full-resolution shell collections are unsupported')
        if lod in self.shapes[index].levels:
            self.fail('Duplicate shell collection level')
        first = len(self.shapes)
        linked = len(self.current.shapes)
        members = 0
        while True:
            offset, opcode = self.p, self.u8()
            if self.active_compression_end is not None and offset >= self.active_compression_end:
                self.fail('Shell collection crosses compression boundary')
            self.histogram[f'{opcode:02x}'] += 1
            self.history.append((offset, opcode, self.stack[-1]))
            self.history = self.history[-8:]
            if sum(self.histogram.values()) > 5000000:
                self.fail('Record limit exceeded')
            if opcode == 0:
                break
            if opcode == ord('S'):
                self.shell(in_collection=True)
            elif opcode == ord('&'):
                self.repeat_shell(in_collection=True)
                self.notes['coarse_collection_repeats'] += 1
            else:
                self.fail('Only shell and repeat primitives in coarse collections are supported')
            members += 1
        # Collection children are untagged first-pass primitives, never scene
        # objects. Only the outer object's independently read LOD 0 is exported.
        del self.shapes[first:]
        del self.current.shapes[linked:]
        self.shapes[index].levels[lod] = {'coarse_collection_members': members}
        self.last = ('shape', index)
        self.notes['coarse_shell_collections'] += 1

    def polygon_triangle(self):
        count = self.count(2000000, 'Polygon vertex')
        if count != 3:
            self.fail('Nontriangular standalone polygons are unsupported')
        points = self.floats(9)
        index = self.new_shape()
        self.shapes[index].levels[0] = {'points': points, 'indices': [0, 1, 2], 'sourceFaces': 1, 'attributes': {}}
        self.vertices += 3
        if self.vertices > 4000000:
            self.fail('Total vertex limit exceeded')
        self.last = ('shape', index)
        self.notes['decoded_polygon_triangles'] += 1

    def regular_mesh(self):
        flags = self.u8()
        if flags & ~8:
            self.fail('Compressed or extended regular mesh points are unsupported')
        rows, columns = self.count(2000000, 'Mesh row'), self.count(2000000, 'Mesh column')
        count = rows * columns
        if min(rows, columns) < 2 or count > 2000000 or self.vertices + count > 4000000:
            self.fail('Invalid or oversized regular mesh dimensions')
        points = self.floats(count * 3)
        self.vertices += count
        indices = []
        for row in range(rows - 1):
            for column in range(columns - 1):
                a = row * columns + column
                b, c, d = a + 1, a + columns, a + columns + 1
                indices.extend((a, b, d, a, d, c))
        geometry = {'points': points, 'indices': indices, 'sourceFaces': (rows - 1) * (columns - 1), 'attributes': {}}
        if flags & 8:
            self.optionals(geometry)
        index = self.new_shape()
        self.shapes[index].levels[0] = geometry
        self.last = ('shape', index)
        self.notes['decoded_regular_meshes'] += 1

    def optionals(self, geometry, vertex_count=None):
        nv = len(geometry['points']) // 3 if vertex_count is None else vertex_count
        while True:
            option = self.u8()
            self.notes[f'optional_{option}'] += 1
            if option == 0:
                return
            if option in (1, 5, 7, 9, 33):
                compression, bits = self.u8(), self.u8()
                payload = self.read(self.count(MAX_EXPANDED, 'Attribute payload'))
                if option == 5:
                    if compression not in (1, 2):
                        self.fail('Unsupported vertex color compression')
                    geometry['colors'] = self.quantized(nv, 3, [0, 0, 0, 1, 1, 1], bits, payload)
                elif option == 33:
                    self.fail('Per-face color handling is not implemented')
                elif option == 1:
                    self.notes[f'normal_encoding_{compression}'] += 1
                    self.notes['recomputed_normal_arrays'] += 1
                else:
                    self.notes['non_face_vertex_colors'] += 1
            elif option == 3:
                compression, width = self.u8(), self.u8()
                if compression != 1:
                    self.fail('Unsupported texture coordinate compression')
                if not 1 <= width <= 64:
                    self.fail('Invalid texture coordinate width')
                bounds = self.floats(2 * width)
                if any(bounds[j] > bounds[j + width] for j in range(width)):
                    self.fail('Reversed texture coordinate bounds')
                bits = self.u8()
                length = self.count(MAX_EXPANDED, 'Texture coordinate payload')
                if not 1 <= bits <= 32 or length != ((nv * width * bits + 31) // 32) * 4:
                    self.fail('Invalid texture coordinate payload length')
                self.read(length)
                self.notes[f'vertex_parameter_width_{width}'] += 1
                self.notes['texture_coordinates_not_exported'] += 1
            elif option in (17, 19):
                values = self.floats(nv * (3 if option == 17 else 2))
                if option == 17:
                    geometry['normals'] = values
                else:
                    self.notes['recomputed_normal_arrays'] += 1
            elif option == 28:
                width = self.u8()
                if not 1 <= width <= 64:
                    self.fail('Invalid parameter width')
                remaining = width * nv
                while remaining:
                    chunk = min(remaining, 4096)
                    self.floats(chunk)
                    remaining -= chunk
                self.notes[f'vertex_parameter_width_{width}'] += 1
                self.notes['texture_coordinates_not_exported'] += 1
            elif option == 99:
                while True:
                    opcode = self.u8()
                    if opcode == 0:
                        break
                    if opcode == ord('U'):
                        self.text16()
                    elif opcode == 0x16:
                        self.text16(True)
                    elif opcode == ord('"'):
                        self.color(geometry['attributes'])
                    else:
                        self.fail(f'Unsupported polyhedron attribute {opcode:#x}')
            else:
                self.fail(f'Unsupported geometry attribute {option:#x}')

    def polypolyline(self):
        flags = self.u16()
        count = self.count(2000000, 'Polyline point')
        if not count or flags & ~0x3f0f or flags & 6 == 6:
            self.fail('Unsupported polyline flags')
        if flags & 4:
            primitives = 1
        elif flags & 2:
            primitives = self.count(2000000, 'Polyline primitive')
            lengths = [self.u32() for _ in range(primitives)]
            if sum(lengths) != count:
                self.fail('Polyline lengths do not match point count')
        else:
            total = primitives = 0
            while total < count:
                length = self.u32()
                if not 1 <= length <= count-total:
                    self.fail('Invalid polyline length')
                total += length
                primitives += 1
        dimensions = 3
        leftovers = 0
        for shift in (8,10,12):
            restriction = (flags >> shift) & 3
            if restriction:
                dimensions -= 1
                leftovers += 1 if restriction == 2 else primitives if restriction == 3 else 0
        if flags & 1:
            compression = self.u8()
            if compression != 1 or flags & 8:
                self.fail('Unsupported polyline compression')
            bounds = self.floats(2*dimensions)
            if any(bounds[j] > bounds[j + dimensions] for j in range(dimensions)):
                self.fail('Reversed polyline bounds')
            # Both byte and legacy Long sample widths occur in HSF streams.
            # Select only an unambiguous header with the exact packed length.
            candidates = []
            for width in (1, 4):
                if self.p + width + 4 > len(self.data):
                    continue
                bits = int.from_bytes(self.data[self.p:self.p + width], 'little')
                length = struct.unpack_from('<I', self.data, self.p + width)[0]
                expected = ((count * dimensions * bits + 31) // 32) * 4
                if 1 <= bits <= 32 and length == expected and length <= MAX_EXPANDED and self.p + width + 4 + length <= len(self.data):
                    candidates.append((width, bits, length))
            if len(candidates) != 1:
                self.fail('Invalid or ambiguous polyline sample header')
            width, bits, length = candidates[0]
            self.read(width + 4 + length)
            self.notes[f'polyline_sample_width_{width * 8}bit'] += 1
        else:
            self.floats(count*dimensions)
        if leftovers:
            if flags & 1 and leftovers>1:
                if self.u8() != 1:
                    self.fail('Unsupported polyline remainder compression')
                bounds = self.floats(2)
                if bounds[0] > bounds[1]:
                    self.fail('Reversed polyline remainder bounds')
                length = self.count(MAX_EXPANDED,'Polyline remainder')
                if length != ((leftovers * bits + 31) // 32) * 4:
                    self.fail('Invalid polyline remainder length')
                self.read(length)
            else:
                self.floats(leftovers)
        self.last = ('annotation',self.stack[-1])
        self.notes['polyline_annotations_not_exported'] += primitives

    def image(self):
        self.floats(3)
        flags = self.u32() if self.version >= 1900 else self.u8()
        if flags & ~0xff:
            self.fail('Unsupported image format flags')
        if flags & 0x80:
            self.text8()
        width, height = self.u32(), self.u32()
        if width * height > 64000000 or (flags & 0xf) > 4:
            self.fail('Image dimensions or format unsupported')
        compression = self.u8()
        if compression == 0:
            self.read(width * height * [1, 2, 3, 4, 4][flags & 0xf])
        elif compression in (1, 2):
            self.read(self.count(MAX_EXPANDED, 'Image payload'))
        elif compression == 99:
            self.read(self.u16())
            self.notes['external_images_not_fetched'] += 1
        else:
            self.fail(f'Unsupported image compression {compression}')
        if compression == 2 and flags & 0xf in (3, 4) and self.version >= 1340:
            alpha_format = self.u8()
            if alpha_format not in (0, 1):
                self.fail('Unsupported image alpha compression')
            self.read(self.count(MAX_EXPANDED, 'Alpha payload') if alpha_format else 1)
        if flags & 0x10:
            self.floats(2)
            self.read(2)
        self.last = ('annotation', self.stack[-1])
        self.notes['image_definitions_not_exported'] += 1

    def rendering(self):
        record_offset = self.p
        masks = [self.u32()]
        while masks[-1] & 0x80000000:
            if len(masks) >= 3:
                self.fail('Unsupported rendering option mask')
            masks.append(self.u32())
        values = [self.u32() for _ in masks]
        mask, value = masks[0], values[0]
        if mask & ~0x81111000:
            self.fail(f'Unsupported rendering fields {mask:#x}')
        if mask & 0x7000:
            self.read(1)
        lock_record = None
        if mask & 0x100000:
            # Native Read/Execute mapping: ../../09_跨文件验证/native-hsf-lock-field-mapping.json
            # and native-render-lock-field-verification.json. Class bit20 selects the
            # attribute-lock record; a set mask bit with a clear value bit20 makes the
            # native Execute path send the explicit "no attribute lock" clear
            # (libhoops_stream HTK_Rendering_Options::Execute 0x102d83ec4..0x102d83ed4).
            # Keep operations in stream order; an explicit clear is not an absent setting.
            lock_record = {'path': self.stack[-1], 'offset': record_offset,
                           'kind': 'lock' if value & 0x100000 else 'clear_all',
                           'enabled': bool(value & 0x100000)}
        if mask & value & 0x100000:
            lock_mask, lock_value = self.u32(), self.u32()
            lock_record['mask'] = lock_mask
            lock_record['value'] = lock_value
            # Class bit27 is the visibility class. A set mask bit with a clear value bit
            # makes the native path send "attribute lock=no visibility"
            # (0x102d84414..0x102d84424) instead of reading the component pair.
            if lock_mask & 0x8000000 and not lock_value & 0x8000000:
                lock_record['visibilityCleared'] = True
            if lock_mask & lock_value & 4:
                self.u32()
                contents = self.u32()
                for bit in (0x1001, 0x2000, 2, 4, 16, 8, 0x4000, 0x20, 0x400, 0x10000, 0x20000, 0x100000, 0x40000, 0x80000, 0x800, 0x200000, 0x400000, 0x100000):
                    if contents & bit:
                        self.read(4)
            if lock_mask & lock_value & 0x8000000:
                visibility_locks = (self.u32(), self.u32())
                lock_record['kind'] = 'visibilityLock'
                lock_record['visibility'] = visibility_locks
                self.current.attributes['visibilityLocks'] = visibility_locks
        if self.version >= 1515 and mask & value & 0x10000:
            self.read(1)
        if mask & value & 0x1000000:
            hidden = self.u8()
            if hidden & 0x80:
                hidden |= self.u8() << 8
            if hidden & 0x8000:
                hidden |= self.u16() << 16
            if hidden & 4:
                self.u32()
            if hidden & 0x10:
                self.floats(1)
            if hidden & 8:
                self.floats(1)
            if hidden & 0x100000:
                self.u8()
            if hidden & ~0x1083ff:
                self.fail('Unsupported hidden line options')
        for j in range(1, len(masks)):
            if j == 1 and masks[j] & values[j] & 0x10:
                self.floats(2)
            if j == 1 and masks[j] & values[j] & 0x100:
                shadow = self.u8()
                if shadow & 0x80:
                    shadow |= self.u8() << 8
                if shadow & ~0x3ff:
                    self.fail('Unsupported simple shadow fields')
                if shadow & 4:
                    self.floats(4)
                if shadow & 8:
                    self.floats(3)
                if shadow & 0x10:
                    self.read(3)
                if shadow & 0x20:
                    self.u8()
                if shadow & 0x40:
                    self.u16()
                if shadow & 0x200:
                    self.floats(1)
                self.notes['simple_shadow_not_exported'] += 1
            if j == 1 and masks[j] & values[j] & 0x4000:
                if self.version < 1335:
                    self.fail('General displacement predates supported HSF layout')
                self.u32()
                self.notes['depth_displacement_not_exported'] += 1
            allowed = 0x80004110 if j == 1 else 2
            if masks[j] & values[j] & ~allowed:
                self.fail('Unsupported extended rendering fields')
        if lock_record is not None:
            self.lock_records.append(lock_record)

    def heuristics(self):
        mask = self.u16()
        if mask & 0x8000:
            mask |= self.u16() << 16
        value = self.u16()
        if mask & 0x8000:
            value |= self.u16() << 16
        if mask & value & 0x40:
            self.read(4)
        if mask & value & 0x80:
            self.read(4)
        if mask & value & 0xc:
            self.read(1)
        if mask & value & 0x01fd0000:
            self.fail('Unsupported heuristic fields')

    def user_data(self):
        payload_start = self.p + 4
        payload = self.read(self.count(MAX_EXPANDED, 'User data'))
        trailer = len(payload) == 9 and payload[0] == 0xbe and payload[5:] == bytes(4)
        trailer_version = struct.unpack_from('<I', payload, 1)[0] if trailer else None

        def at_scene_end(offset):
            if self.active_compression_end is not None:
                return offset == self.active_compression_end and self.data[offset:offset + 2] == b'z\0'
            return self.data[offset:offset + 1] == b'\0'

        padding_end = self.p
        if payload.startswith(b'\xbe'):
            while padding_end - self.p < 16 and self.data[padding_end:padding_end + 1] == b'\0':
                padding_end += 1
        standard_stop = self.data[padding_end:padding_end + 1] == b']'
        if self.stack == ['/'] and len(self.nodes) == 1 and not self.shapes and not self.tags:
            limit = self.active_compression_end if self.active_compression_end is not None else len(self.data)
            stop = legacy_root_header_stop(self.data, payload_start, len(payload), limit)
            if stop is not None and stop != padding_end:
                self.p = stop + 1
                self.notes['legacy_root_header_footer_length_recovered'] += 1
                self.notes['opaque_user_data'] += 1
                return
        # Root records ending the scene use the trailer version layout even
        # when every optional-array count is zero; do not swallow them as padding.
        terminal_trailer = standard_stop and self.stack == ['/'] and at_scene_end(padding_end + 1)
        if trailer and (not standard_stop or terminal_trailer):
            # TK_SW_Trailer::Read gates previews at version 17 and color mappings
            # at version 27. This implementation covers empty application chunks
            # and empty color mappings; unsupported fields are not padding.
            if self.stack != ['/']:
                self.fail('Preview bitmap trailer is outside the root segment')
            count = self.count(128, 'Preview bitmap') if trailer_version >= 17 else 0
            for _ in range(count):
                wrapper_size = self.u32()
                dib_offset = {84: 24, 96: 32}.get(wrapper_size)
                if dib_offset is None:
                    self.fail('Unsupported preview bitmap wrapper size')
                header = self.read(wrapper_size)
                size, width, height, planes, bits, compression, image_size, _, _, colors, _ = struct.unpack_from('<IiiHHIIiiII', header, dib_offset)
                if size != 40 or width <= 0 or height == 0 or width * abs(height) > 64000000:
                    self.fail('Invalid preview bitmap dimensions')
                if planes != 1 or bits != 24 or compression != 0 or colors:
                    self.fail('Unsupported preview bitmap format')
                # The bounded wrapper also contains opaque application fields;
                # only the BITMAPINFOHEADER defines how pixels are interpreted.
                if any(header[dib_offset + 40:]):
                    self.notes['preview_opaque_wrapper_suffixes'] += 1
                bitmap_type, bitmap_width, bitmap_height, row_bytes, bitmap_planes, bitmap_bits = struct.unpack_from('<iiiiHH', header)
                stride = ((width * bits + 31) // 32) * 4
                if (bitmap_type, bitmap_width, bitmap_height, bitmap_planes, bitmap_bits) != (0, width, height, planes, bits) or row_bytes not in (0, stride):
                    self.fail('Conflicting preview bitmap headers')
                length = self.count(MAX_EXPANDED, 'Preview pixel payload')
                if length != stride * abs(height) or image_size not in (0, length):
                    self.fail('Preview bitmap pixel length mismatch')
                self.read(length)
                self.notes['preview_bitmaps_not_exported'] += 1
                self.notes['preview_bitmap_bytes'] += length
                self.notes[f'preview_bitmap_wrapper_{wrapper_size}'] += 1
            if trailer_version >= 27 and self.u32() != 0:
                self.fail('Unsupported nonempty trailer color mappings')
            if self.u8() != ord(']'):
                self.fail('Invalid preview bitmap stop boundary')
            if not at_scene_end(self.p):
                self.fail('Preview bitmap trailer must end the scene stream')
            self.notes['preview_bitmap_trailers'] += 1
            self.notes[f'trailer_version_{trailer_version}'] += 1
        else:
            padding = 0
            while self.p < len(self.data) and self.data[self.p] == 0 and padding < (16 if payload.startswith(b'\xbe') else 0):
                self.read(1)
                padding += 1
            if self.u8() != ord(']'):
                self.fail('Invalid user-data stop boundary')
            self.notes['user_data_zero_padding'] += padding
        self.notes['opaque_user_data'] += 1

    def text_font(self):
        # Public TKE_Text_Font: extension flags widen paired mask/value fields;
        # only attributes that are both masked and enabled carry operands.
        mask, value = self.u8(), self.u8()
        if mask & 0x80:
            mask |= self.u8() << 8
            value |= self.u8() << 8
        if mask & 0x8000:
            mask |= self.u16() << 16
            value |= self.u16() << 16
        if mask & ~0x3fffff:
            self.fail('Unsupported text font mask')
        enabled = mask & value
        if enabled & 1:
            self.text8()
        for bit in (2, 4):
            if enabled & bit:
                self.floats(1)
                # World-space units (6) extend the older opcode table. Percent
                # remains valid only for the size tolerance operand.
                units = self.u8()
                if units not in (0, 1, 2, 3, 4, 6) and not (bit == 4 and units == 5):
                    self.fail('Unsupported text font size units')
        if enabled & 8 and self.u8() > 3:
            self.fail('Unsupported text font transform mode')
        for bit in (0x10, 0x20, 0x40, 0x100, 0x200, 0x10000):
            if enabled & bit:
                self.floats(1)
                if bit in (0x100, 0x10000) and self.u8() not in (0, 1, 2, 3, 4, 6):
                    self.fail('Unsupported text font spacing units')
        if enabled & 0x200000 and self.u8() > 2:
            self.fail('Unsupported text font greeking mode')
        if enabled & 0x100000 and self.u8() > 3:
            self.fail('Unsupported text font renderer')
        self.notes['text_font_attributes_not_exported'] += 1

    def run(self):
        while self.p < len(self.data):
            offset, opcode = self.p, self.u8()
            self.histogram[f'{opcode:02x}'] += 1
            self.history.append((offset, opcode, self.stack[-1]))
            self.history = self.history[-8:]
            if sum(self.histogram.values()) > 5000000:
                self.fail('Record limit exceeded')
            target = self.current.attributes
            if opcode == ord('I'):
                self.file_flags = self.u32()
            elif opcode == ord('B'):
                if self.u8() != 0:
                    self.fail('Unsupported global bounding format')
                self.header_bounds = self.floats(6)
            elif opcode == ord('Z'):
                if self.active_compression_end is not None:
                    self.fail('Nested global compression')
                decompressor = zlib.decompressobj()
                try:
                    expanded = decompressor.decompress(self.data[self.p:], MAX_EXPANDED - self.total_expanded + 1)
                except zlib.error as error:
                    self.fail(f'Invalid compressed stream: {error}')
                self.total_expanded += len(expanded)
                if self.total_expanded > MAX_EXPANDED or not decompressor.eof or not expanded.endswith(b'z'):
                    self.fail('Truncated or oversized global compression')
                self.active_compression_end = self.p + len(expanded) - 1
                self.data = self.data[:self.p] + expanded + decompressor.unused_data
            elif opcode == ord('z'):
                if offset != self.active_compression_end:
                    self.fail('Invalid compression stop boundary')
                self.active_compression_end = None
            elif opcode == ord('['):
                self.user_data()
            elif opcode == ord('('):
                self.segment(self.text8())
            elif opcode == ord(')'):
                if len(self.stack) == 1:
                    self.fail('Unbalanced segment close')
                self.last = ('segment', self.stack.pop())
            elif opcode == ord('s'):
                path = self.tag(self.u32(), 'segment')
                self.stack.append(path)
                self.last = ('segment', path)
            elif opcode == ord('q'):
                if self.last is None:
                    self.fail('Tag without an object')
                self.tags.append(self.last)
            elif opcode == ord('S'):
                self.shell()
            elif opcode == ord('G'):
                self.polygon_triangle()
            elif opcode == ord('M'):
                self.regular_mesh()
            elif opcode == ord('&'):
                self.repeat_shell()
            elif opcode in (ord('%'), ord('$')):
                matrix = self.floats(12)
                if opcode == ord('%'):
                    target['matrix'] = matrix
            elif opcode == ord('~'):
                mask, values = self.mask(), self.read(3)
                if mask & 1:
                    target['color'] = [x / 255 for x in values]
            elif opcode == ord('"'):
                self.color(target)
            elif opcode == ord('V'):
                target['visibility'] = self.visibility()
            elif opcode in (ord('U'), 0x16):
                target.setdefault('options' if opcode == ord('U') else 'labels', []).append(self.text16(opcode == 0x16))
            elif opcode in (ord('<'), ord('{')):
                length = self.u8()
                conditional = length == 0
                if conditional:
                    length = self.u8()
                name = self.read(length).decode('utf-8', 'replace')
                condition = self.text8() if conditional else ''
                if opcode == ord('<'):
                    self.current.includes.append({'path': self.path(name), 'condition': condition})
                    self.last = ('include', (self.stack[-1], len(self.current.includes) - 1))
                else:
                    self.current.attributes.setdefault('styles', []).append({'path': self.path(name), 'condition': condition})
                    self.notes['style_segments'] += 1
            elif opcode == ord('r'):
                reference = self.u32()
                condition = self.text8()
                self.current.includes.append({'tag': reference, 'condition': condition})
                self.last = ('include', (self.stack[-1], len(self.current.includes) - 1))
            elif opcode in (ord('}'), ord('>')):
                self.camera(opcode == ord('}'))
            elif opcode == ord('?'):
                length = self.u8()
                if length == 254:
                    length = self.u16()
                elif length == 255:
                    length = self.u32()
                target['condition'] = self.read(length).decode('utf-8', 'replace')
            elif opcode == 0x10:
                self.polypolyline()
            elif opcode == ord('i'):
                self.image()
            elif opcode in (ord('C'), ord('c')):
                kind = 'circle' if opcode == ord('C') else 'circular_arc'
                self.floats(9)
                flags = self.u8() if self.version >= 1215 else 0
                if flags & ~1:
                    self.fail(f'Unsupported {kind} flags')
                if flags & 1:
                    self.floats(3)
                # Reopened segment tags can jump directly to an existing path;
                # the stream stack then omits its natural parents.
                if '2dmodel' not in self.stack[-1].split('/'):
                    self.fail('Circular primitives outside a 2D view require tessellation')
                self.last = ('annotation', self.stack[-1])
                self.notes[f'{kind}_annotations_not_exported'] += 1
            elif opcode in (ord('L'), ord('X')):
                self.floats(self.count(2000000, 'Polyline point') * 3 if opcode == ord('L') else 3)
                self.last = ('annotation', self.stack[-1])
                self.notes['polyline_or_marker_annotations'] += 1
            elif opcode == ord('l'):
                self.floats(6)
                self.last = ('annotation', self.stack[-1])
                self.notes['line_annotations'] += 1
            elif opcode == ord('R'):
                self.rendering()
            elif opcode == ord('H'):
                self.heuristics()
            elif opcode == ord('J'):
                self.text8()
                self.read(self.u16())
            elif opcode == ord('|'):
                self.floats(3)
                self.notes['text_paths_not_exported'] += 1
            elif opcode in (ord('.'), ord('d')):
                self.floats(3)
                if self.u8() & ~1:
                    self.fail('Unsupported light options')
                self.last = ('light', self.stack[-1])
                self.notes['lights_not_exported'] += 1
            elif opcode == 0x0c:
                if self.u8() != 0:
                    self.fail('Unsupported color map format')
                self.read(self.count(1000000, 'Color map entry') * 3)
                self.notes['color_maps_not_exported'] += 1
            elif opcode in (ord('-'), 0x0d):
                pattern = self.u8()
                if pattern == 255:
                    self.text8()
                else:
                    self.u8()
            elif opcode == 7:
                self.text16()
                self.notes['callbacks_not_executed'] += 1
            elif opcode in (ord('x'), ord('T')):
                self.floats(3)
                encoding = self.u8() if opcode == ord('x') else 0
                length = self.u8()
                if length == 254:
                    length = self.u16()
                elif length == 255:
                    length = self.u32()
                value = self.read(length)
                target.setdefault('text', []).append(value.decode('utf-16le' if encoding == 5 else 'utf-8', 'replace'))
                if self.version >= 1002:
                    options = self.u8()
                    if options & 1:
                        self.u8()
                        self.floats(self.u8() * 3)
                    if options & ~1:
                        self.fail('Unsupported text options')
                self.last = ('text', (self.stack[-1], len(target['text']) - 1))
                self.notes['text_metadata'] += 1
            elif opcode == ord('f'):
                self.u8()
                self.text8()
                self.u8()
                self.text8()
                self.read(self.count(MAX_EXPANDED, 'Font data'))
                self.notes['font_definitions'] += 1
            elif opcode == ord('F'):
                self.text_font()
            elif opcode in (ord('h'), ord('*'), ord('#'), ord('P'), ord('@')):
                self.read(1)
            elif opcode in (ord('='), 0x0e, ord('+'), ord(' ')):
                value = self.floats(1)[0]
                if value < 0 and opcode in (ord('='), 0x0e):
                    self.u8()
            elif opcode in (ord('0'), ord('K'), ord('k')):
                self.read(4)
            elif opcode == ord('n'):
                self.read(self.count(1000000, 'User index') * 8)
            elif opcode == ord('t'):
                self.notes['texture_definitions_not_exported'] += 1
                for index in range(2):
                    length = self.u8()
                    name = self.read(self.u32() if length == 255 else length)
                    if index == 0:
                        self.texture_names.add(name)
                flags = self.u16()
                if flags & 0x8000:
                    flags |= self.u16() << 16
                for bit in (1, 2, 4, 8, 16, 32, 64, 128, 256, 512):
                    if flags & bit:
                        self.read(1)
                if flags & 0x800:
                    self.read(8)
                if flags & 0x400:
                    self.read(self.u8())
                if flags & 0x30000:
                    self.read(1)
                if flags & 0x40000:
                    self.read(1)
            elif opcode == 0:
                self.terminated = True
                break
            elif opcode == 1:
                self.notes['pause'] += 1
            else:
                self.fail(f'Unsupported opcode {opcode:#x}, context {self.data[offset:offset + 28]!r}')
        if not self.terminated or self.active_compression_end is not None:
            self.fail('Missing HSF termination')
        if len(self.stack) != 1:
            self.fail('Unclosed HSF segments')
        return self
