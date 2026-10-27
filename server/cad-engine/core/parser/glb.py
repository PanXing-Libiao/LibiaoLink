"""Resolve a selected HSF configuration and write a self-contained display GLB."""
from collections import Counter, defaultdict
import array
import json
import math
import re
import struct
import sys
from binary import ConversionError
from affine import factor

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
U32 = 0xffffffff
# Native visibility and visibility-lock words share one component layout. Bit0 is the face
# component: in 09_跨文件验证/native-unlock-chain-result.json face_before 0 / face_after 1 tracks
# the net word 0x7dff07fe / 0x7dff07ff, and HTK_Rendering_Options::Execute uses pair bit0 for
# "attribute lock=visibility=face=on/off".
FACE_BIT = 0x1


def lock_step(inherited, mask, value):
    """Native renderer lock propagation (libhoops_3dgs HD_Downwind_Rendition +9172..+9488).

    persistent_after = (persistent_before & ~M) | V ; current_effective = persistent_after & ~M.
    The persistent word is what descendants inherit; the effective word only filters this
    node's own visibility update. Field ranges and branch conditions are recorded in
    09_跨文件验证/native-render-lock-field-verification.json.
    """
    persistent = ((inherited & ~mask) | value) & U32
    return persistent, persistent & ~mask & U32


def lock_declaration(records, styled=()):
    """Local visibility-lock (mask, value) for one segment, from stream-ordered records.

    Native object model (09_跨文件验证/native-lock-option-parser.json): the option-string parser
    parse_locks writes the class pair at Lock_Masks+0x44/+0x48 and the per-component pair at
    +0x9c/+0xa0. "no attribute lock" zeroes the whole object and "no visibility" leaves the class
    value bit clear with zero component words, so either one drops what earlier records on the
    same segment declared. Only the component pair has a confirmed field mapping here.
    """
    if styled:
        raise ConversionError('Lock ordering relative to style segments is not established', stage='scene')
    mask = value = 0
    for record in records:
        if not record['enabled'] or record.get('visibilityCleared'):
            # Native clears operate on the segment's lock object, not on the inherited state.
            mask = value = 0
            continue
        if 'visibility' not in record:
            # Class-mask bit27 absent: this record declares no visibility lock at all.
            continue
        local_mask, local_value = record['visibility']
        mask |= local_mask
        value = (value & ~local_mask) | local_value
    return mask & U32, value & U32


def visibility_step(value, known, source_mask, source_value, effective_lock):
    """Native visibility merge (HD_Downwind_Rendition +5948..+5988 and +9672..+9728).

    delta = (old XOR source_value) & source_mask & ~effective_lock; new = old XOR delta.
    The masked-replacement form below is identical per bit, and keeps unset bits unknown.
    """
    updates = source_mask & ~effective_lock & U32
    return ((value & ~updates) | (source_value & updates)) & U32, known | updates


def matrix12(value):
    return [*value[:3], 0, *value[3:6], 0, *value[6:9], 0, *value[9:12], 1]


def multiply(a, b):
    return [sum(a[k * 4 + row] * b[column * 4 + k] for k in range(4)) for column in range(4) for row in range(4)]


def point(matrix, p):
    x, y, z = p
    return [matrix[j] * x + matrix[j + 4] * y + matrix[j + 8] * z + matrix[j + 12] for j in range(3)]


def instance_point(matrix, p):
    # HTK_Instance uses Float32 multiply/add steps, not a final-only cast.
    def f32(value):
        return struct.unpack('<f', struct.pack('<f', value))[0]
    x, y, z = map(f32, p)
    return [f32(f32(f32(f32(matrix[j] * x) + f32(matrix[j + 4] * y)) + f32(matrix[j + 8] * z)) + matrix[j + 12]) for j in range(3)]


def little_bytes(values, kind):
    result = array.array(kind, values)
    if sys.byteorder != 'little':
        result.byteswap()
    return result.tobytes()


def normals(points, indices):
    result = [0.0] * len(points)
    for k in range(0, len(indices), 3):
        a, b, c = [index * 3 for index in indices[k:k + 3]]
        u = [points[b + j] - points[a + j] for j in range(3)]
        v = [points[c + j] - points[a + j] for j in range(3)]
        cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        for base in (a, b, c):
            for j in range(3):
                result[base + j] += cross[j]
    for base in range(0, len(result), 3):
        length = math.sqrt(sum(x * x for x in result[base:base + 3]))
        if length:
            result[base:base + 3] = [x / length for x in result[base:base + 3]]
        else:
            result[base:base + 3] = [0, 0, 1]
    return result


class SceneExporter:
    def __init__(self, source, *, source_unit='source', up_axis='preserve'):
        self.source = source
        # Display-state activation (states.py) records the native unlock/relock of the face
        # component per segment here; it is applied on top of the stream declaration.
        self.state_locks = dict(getattr(source, 'state_locks', None) or {})
        self.unit = source_unit
        self.up_axis = up_axis
        self.binary = bytearray()
        self.document = {'asset': {'version': '2.0', 'generator': 'LibiaoLink local eDrawings converter 0.1'}, 'scene': 0, 'scenes': [], 'nodes': [], 'meshes': [], 'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': [{'byteLength': 0}]}
        self.meshes = {}
        self.materials = {}
        self.geometry = {}
        self.stats = Counter()
        self.bounds = [[float('inf')] * 3, [-float('inf')] * 3]
        self.display_bounds = [[float('inf')] * 3, [-float('inf')] * 3]
        self.instances = []
        self.components = {}
        self.attribute_cache = {}
        self.configurations = [p for p, n in source.nodes.items() if n.name == '3dmodel']
        if not self.configurations:
            raise ConversionError('No eDrawings 3D model configuration found', stage='scene')
        # Preserve source coordinates unless an explicit presentation axis is supplied.
        self.root_matrix = list(IDENTITY)
        if up_axis == 'x':
            self.root_matrix = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
        elif up_axis == 'z':
            self.root_matrix = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
        scale = 0.001 if source_unit == 'mm' else 1
        self.root_matrix = [v * scale if index < 12 else v for index, v in enumerate(self.root_matrix)]
        self.validate_references()
        self.configurations = [p for p in self.configurations if self.has_surfaces(p)]
        for path in source.nodes:
            self.attributes(path)
        # Lock operations stay in stream order per segment (parser/hsf.py lock_records).
        self.lock_records = {}
        for record in getattr(source, 'lock_records', ()):
            self.lock_records.setdefault(record['path'], []).append(record)

    def validate_references(self):
        for node in self.source.nodes.values():
            for reference in node.includes:
                if reference.get('condition'):
                    raise ConversionError('Conditional scene references require an explicit supported condition evaluator', stage='scene')
                if 'tag' in reference:
                    index = reference['tag']
                    if index >= len(self.source.tags) or self.source.tags[index][0] != 'segment':
                        raise ConversionError('Non-segment or missing scene reference', stage='scene')
                    reference['path'] = self.source.tags[index][1]
                if reference['path'] not in self.source.nodes:
                    raise ConversionError('Unresolved include reference', stage='scene')
        for index, shape in enumerate(self.source.shapes):
            if 0 not in shape.levels:
                raise ConversionError(f'Full-resolution geometry missing for object {index}', stage='scene')

    def has_surfaces(self, path, ancestors=frozenset()):
        if path in ancestors or len(ancestors) > 256:
            raise ConversionError('Cyclic scene graph', stage='scene')
        node = self.source.nodes[path]
        return bool(node.shapes) or any(self.has_surfaces(p, ancestors | {path}) for p in node.children + [r['path'] for r in node.includes])

    def attributes(self, path, ancestors=frozenset()):
        if path in self.attribute_cache:
            return self.attribute_cache[path]
        if path not in self.source.nodes or path in ancestors or len(ancestors) > 128:
            raise ConversionError('Missing or cyclic style segment', stage='scene')
        attributes = self.source.nodes[path].attributes
        layers = []
        merged = {}
        for style in attributes.get('styles', []):
            if style.get('condition'):
                raise ConversionError('Conditional style expressions are unsupported', stage='scene')
            layers.append(self.attributes(style['path'], ancestors | {path}))
        for layer in layers + [attributes]:
            combined = {}
            for key in ('visibility', 'visibilityLocks'):
                if key in merged and key in layer:
                    old_mask, old_value = merged[key]
                    mask, value = layer[key]
                    combined[key] = old_mask | mask, (old_value & ~mask) | (value & mask)
            merged.update(layer)
            merged.update(combined)
        self.attribute_cache[path] = merged
        return merged

    def lock_declaration(self, path):
        """Local visibility-lock (mask, value) declared by this segment's own records.

        A display-state activation may override the face component (native unlock of the
        activated configuration root, relock of the others); see states.py.
        """
        styled = [style['path'] for style in self.source.nodes[path].attributes.get('styles', [])
                  if self.lock_records.get(style['path'])]
        mask, value = lock_declaration(self.lock_records.get(path, ()), styled)
        override = (getattr(self, 'state_locks', None) or {}).get(path)
        if override:
            clear, set_bits = override
            mask = (mask & ~clear) | set_bits
            value = (value & ~clear) | set_bits
        return mask & U32, value & U32

    def visibility_state(self, path, persistent, value, known):
        """Apply this segment's lock declaration, then its visibility attribute."""
        mask, declared = self.lock_declaration(path)
        persistent, effective = lock_step(persistent, mask, declared)
        source_mask, source_value = self.attributes(path).get('visibility', (0, 0))
        value, known = visibility_step(value, known, source_mask, source_value, effective)
        return persistent, value, known

    def face_visible(self, value, known):
        """Face visibility from the accumulated native visibility word."""
        return bool(value & FACE_BIT) if known & FACE_BIT else True

    def configuration_gates(self, configuration, explicit):
        if not explicit or len(self.configurations) < 2:
            return []
        gates = []
        parent = configuration.rsplit('/', 1)[0] or '/'
        while parent != '/':
            node = self.source.nodes[parent]
            owned = [p for p in self.configurations if p.startswith(parent + '/')]
            attributes = self.attributes(parent)
            mask, value = attributes.get('visibility', (0, 0))
            lock_mask, lock_value = attributes.get('visibilityLocks', (0, 0))
            # Activating one published configuration removes only its exclusive
            # hidden/locked presentation envelope, never a component below it.
            if owned == [configuration] and not node.shapes and not node.includes and mask & 1 and not value & 1 and lock_mask & lock_value & 1:
                gates.append(parent)
            parent = parent.rsplit('/', 1)[0] or '/'
        return gates

    def resolved_geometry(self, index, lod=0, ancestors=frozenset()):
        key = index, lod
        if key in self.geometry:
            return self.geometry[key]
        if key in ancestors or len(ancestors) > 128:
            raise ConversionError('Cyclic or excessively deep repeated geometry', stage='scene')
        geometry = self.source.shapes[index].levels[lod]
        if 'repeat' in geometry:
            original = self.resolved_geometry(geometry['repeat'], geometry['sourceLod'], ancestors | {key})
            matrix = matrix12(geometry['matrix'])
            points = [value for k in range(0, len(original['points']), 3) for value in instance_point(matrix, original['points'][k:k + 3])]
            indices = list(original['indices'])
            # HTK_Instance transforms points and reuses the source face order.
            geometry = {**original, 'points': points, 'indices': indices}
            geometry.pop('normals', None)
        self.geometry[key] = geometry
        return geometry

    def accessor(self, values, dimensions, *, indices=False, bounds=None):
        if not values or len(values) % dimensions:
            raise ConversionError('Invalid output accessor', stage='export')
        self.binary.extend(b'\0' * (-len(self.binary) % 4))
        raw = little_bytes(values, 'I' if indices else 'f')
        view = len(self.document['bufferViews'])
        self.document['bufferViews'].append({'buffer': 0, 'byteOffset': len(self.binary), 'byteLength': len(raw), 'target': 34963 if indices else 34962})
        self.binary.extend(raw)
        if len(self.binary) > 512 * 1024 * 1024:
            raise ConversionError('GLB binary size limit exceeded', stage='export')
        accessor = {'bufferView': view, 'componentType': 5125 if indices else 5126, 'count': len(values) // dimensions, 'type': {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3'}[dimensions]}
        if bounds is not None:
            accessor.update(min=bounds[0], max=bounds[1])
        self.document['accessors'].append(accessor)
        return len(self.document['accessors']) - 1

    def material(self, rgb):
        rgb = tuple(rgb)
        if rgb not in self.materials:
            self.materials[rgb] = len(self.document['materials'])
            self.document['materials'].append({'pbrMetallicRoughness': {'baseColorFactor': [*rgb, 1], 'metallicFactor': 0.05, 'roughnessFactor': 0.7}, 'doubleSided': True})
        return self.materials[rgb]

    def mesh(self, path, inherited_color):
        key = path, tuple(inherited_color)
        if key in self.meshes:
            return self.meshes[key]
        groups = defaultdict(list)
        for index in self.source.nodes[path].shapes:
            geometry = self.resolved_geometry(index)
            color = (1, 1, 1) if 'colors' in geometry else tuple(geometry['attributes'].get('color', inherited_color))
            groups[(color, 'colors' in geometry)].append(geometry)
        primitives = []
        for (color, has_colors), geometries in groups.items():
            points, indices, normal_values, colors = [], [], [], []
            for geometry in geometries:
                offset = len(points) // 3
                points.extend(geometry['points'])
                indices.extend(index + offset for index in geometry['indices'])
                normal_values.extend(geometry.get('normals') or normals(geometry['points'], geometry['indices']))
                if has_colors:
                    colors.extend(geometry['colors'])
            if not indices:
                raise ConversionError('Selected surface has no triangles', stage='export')
            bounds = [[min(points[j::3]) for j in range(3)], [max(points[j::3]) for j in range(3)]]
            # Accessor bounds describe the actual Float32 output, not Python Float64 values.
            float_points = array.array('f', points)
            bounds = [[min(float_points[j::3]) for j in range(3)], [max(float_points[j::3]) for j in range(3)]]
            attributes = {'POSITION': self.accessor(points, 3, bounds=bounds), 'NORMAL': self.accessor(normal_values, 3)}
            if has_colors:
                attributes['COLOR_0'] = self.accessor(colors, 3)
            primitives.append({'attributes': attributes, 'indices': self.accessor(indices, 1, indices=True), 'material': self.material(color), 'mode': 4})
            self.stats['uniqueVertices'] += len(points) // 3
            self.stats['uniqueTriangles'] += len(indices) // 3
        mesh = len(self.document['meshes'])
        self.document['meshes'].append({'name': self.source.nodes[path].name, 'primitives': primitives})
        self.meshes[key] = mesh
        return mesh

    def component_name(self, node):
        def option(key):
            for value in node.attributes.get('labels', []) + node.attributes.get('options', []):
                found = re.search(r'''(?:^|,)\s*''' + key + r'''\s*=\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)'|([^,`"']+))''', value)
                if found:
                    name = next((part for part in found.groups() if part is not None), '').strip('\0')
                    if name.strip():
                        return name.strip() if found[4] is not None else name
            return None
        name = option('name')
        if name:
            return name
        name_node = self.source.nodes.get(node.path + '/name')
        if name_node and name_node.attributes.get('text'):
            name = name_node.attributes['text'][0].strip('\0')
            if name.strip():
                return name
        return option('mbd_comp_name')

    def name(self, node):
        return self.component_name(node) or node.name

    def visit(self, path, parent_world, inherited_color, persistent, value, known, ancestors, component=None):
        if path in ancestors or len(ancestors) > 256:
            raise ConversionError('Cyclic or excessively deep scene graph', stage='scene')
        self.stats['visitedInstances'] += 1
        if self.stats['visitedInstances'] > 500000:
            raise ConversionError('Scene expansion limit exceeded', stage='scene')
        node = self.source.nodes[path]
        name = self.component_name(node)
        if name:
            # Identity belongs to this traversal occurrence, not the shared
            # definition path or its possibly duplicated display name.
            component = {'schema': 1, 'id': f'component-{self.stats["visitedInstances"]}', 'name': name, 'sourcePath': path, 'named': True}
        attributes = self.attributes(path)
        matrix = matrix12(attributes['matrix']) if 'matrix' in attributes else IDENTITY
        world = multiply(parent_world, matrix)
        color = attributes.get('color', inherited_color)
        persistent, value, known = self.visibility_state(path, persistent, value, known)
        children = []
        for child in node.children + [reference['path'] for reference in node.includes]:
            result = self.visit(child, world, color, persistent, value, known, ancestors | {path}, component)
            if result is not None:
                children.append(result)
        has_mesh = bool(node.shapes) and self.face_visible(value, known)
        if not children and not has_mesh:
            return None
        output = {'name': self.name(node), 'extras': {'hsfPath': path}}
        if children:
            output['children'] = children
        if has_mesh:
            output['mesh'] = self.mesh(path, color)
            self.stats['geometryInstances'] += 1
            if component is None:
                component = {'schema': 1, 'id': f'geometry-{self.stats["geometryInstances"]}', 'name': node.name, 'sourcePath': path, 'named': False}
            output['extras']['libiaolinkCadPart'] = component
            self.components[component['id']] = component
            self.instances.append({'path': path, 'worldMatrix': world, 'component': component})
            display_world = multiply(self.root_matrix, world)
            for index in node.shapes:
                geometry = self.resolved_geometry(index)
                self.stats['instanceTriangles'] += len(geometry['indices']) // 3
                for k in range(0, len(geometry['points']), 3):
                    vertex = geometry['points'][k:k + 3]
                    for bounds, transform in ((self.bounds, world), (self.display_bounds, display_world)):
                        transformed = point(transform, vertex)
                        for j, value in enumerate(transformed):
                            if not math.isfinite(value):
                                raise ConversionError('Non-finite transformed vertex', stage='scene')
                            bounds[0][j] = min(bounds[0][j], value)
                            bounds[1][j] = max(bounds[1][j], value)
        if matrix != IDENTITY:
            outer, inner = factor(matrix)
            output.update(inner)
            self.document['nodes'].append(output)
            outer.update(name=output['name'], children=[len(self.document['nodes'])-1])
            self.document['nodes'].append(outer)
            self.stats['affineTransformsFactored'] += 1
        else:
            self.document['nodes'].append(output)
        return len(self.document['nodes']) - 1

    def build(self, configuration=None):
        explicit = configuration is not None
        if configuration is None:
            if len(self.configurations) != 1:
                raise ConversionError('Multiple 3D configurations; use --configuration with a listed path', stage='scene')
            configuration = self.configurations[0]
        if configuration not in self.configurations:
            raise ConversionError('Unknown 3D configuration', stage='scene')
        # Inherit attributes from the actual ancestors, rather than assuming a fixed root.
        ancestors = []
        parent = configuration
        while parent != '/':
            parent = parent.rsplit('/', 1)[0] or '/'
            ancestors.append(parent)
        activated = self.configuration_gates(configuration, explicit)
        world, rgb, persistent, value, known = IDENTITY, [0.48, 0.51, 0.55], 0, 0, 0
        for path in reversed(ancestors):
            attributes = self.attributes(path)
            if 'matrix' in attributes:
                world = multiply(world, matrix12(attributes['matrix']))
            rgb = attributes.get('color', rgb)
            if path not in activated:
                persistent, value, known = self.visibility_state(path, persistent, value, known)
        child = self.visit(configuration, world, rgb, persistent, value, known, frozenset())
        if child is None or not self.stats['geometryInstances']:
            raise ConversionError('Selected configuration contains no visible surfaces', stage='scene')
        # Ancestor matrices must also appear in GLB; world bounds and hierarchy agree.
        presentation = multiply(self.root_matrix, world)
        outer, inner = factor(presentation)
        inner.update(name='Source coordinate rotation',children=[child])
        self.document['nodes'].append(inner)
        outer.update(name='Source coordinate frame',children=[len(self.document['nodes'])-1])
        self.document['nodes'].append(outer)
        default_view = next((v for v in self.source.views if v['name'] == 'default'), None)
        metadata = {'schema': 1, 'format': 'eDrawings-HSF', 'unit': 'm' if self.unit in ('m', 'mm') else 'source', 'sourceUnit': self.unit, 'upAxis': self.up_axis, 'configuration': configuration, 'sourceView': default_view, 'completeness': 'geometry-checked-source-comparison-pending', 'appearance': 'diffuse-colors; unsupported textures and annotations are diagnosed'}
        self.document['scenes'].append({'nodes': [len(self.document['nodes']) - 1], 'extras': {'libiaolinkCad': metadata}})
        header_outside = 0
        if self.source.header_bounds:
            header = self.source.header_bounds
            header_outside = max(0, *[header[j]-self.bounds[0][j] for j in range(3)], *[self.bounds[1][j]-header[j+3] for j in range(3)])
            extent = max(header[j+3]-header[j] for j in range(3))
            if header_outside > max(extent*1e-5, 1e-8):
                raise ConversionError('Resolved geometry lies outside the source header bounds',stage='scene')
        self.document['buffers'][0]['byteLength'] = len(self.binary)
        self.stats['displayComponents'] = len(self.components)
        self.stats['unnamedDisplayComponents'] = sum(not c['named'] for c in self.components.values())
        header = json.dumps(self.document, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        header += b' ' * (-len(header) % 4)
        self.binary.extend(b'\0' * (-len(self.binary) % 4))
        size = 12 + 8 + len(header) + 8 + len(self.binary)
        content = struct.pack('<4sII', b'glTF', 2, size) + struct.pack('<I4s', len(header), b'JSON') + header + struct.pack('<I4s', len(self.binary), b'BIN\0') + self.binary
        report = {'configuration': configuration, 'availableConfigurations': self.configurations, 'activatedConfigurationAncestors': activated, 'statistics': dict(self.stats), 'sourceBounds': self.bounds, 'sourceSpan': [self.bounds[1][j] - self.bounds[0][j] for j in range(3)], 'displayBounds': self.display_bounds, 'sourceHeaderBounds': self.source.header_bounds, 'headerBoundsOutsideDelta': header_outside, 'geometryObjects': len(self.source.shapes), 'geometryObjectsWithLod0': sum(0 in s.levels for s in self.source.shapes), 'unresolvedReferences': 0, 'sourceUnit': self.unit, 'upAxis': self.up_axis, 'sourceComparison': 'not_verified', 'appearanceLimitations': dict(self.source.notes), 'glbBytes': size}
        return content, report
