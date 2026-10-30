"""Upload-only font/shape resources over pinned ezdxf; no global registration."""
import hashlib
import io
import math
import struct
from pathlib import PurePosixPath

from ezdxf import path
from ezdxf.fonts import fonts, shapefile
from ezdxf.fonts.ttfonts import TTFontRenderer
from ezdxf.fonts.glyphs import Glyphs
from fontTools.ttLib import TTFont, TTLibError
from .dxf_mtext import Renderer as MTextExplode
from ezdxf.math import Matrix44, OCS

from .adapter import identity
from .dxf_xref import match_file
from . import dxf_bigfont

EXTENSION = 'org.cad-preview.dxf-shx/1'
MAX_FONT_BYTES = 8 * 1024 * 1024
MAX_OUTLINE_FONT_BYTES = 32 * 1024 * 1024
MAX_SYMBOLS = 65536
MAX_CODES = 2000000
MAX_RENDER_CODES = 200000
MAX_SUBSHAPE_CALLS = 64


def strict_shape(font, number, stacked=False, primary=None):
    if isinstance(font, dxf_bigfont.BigFont):
        return font.render_glyph(number, stacked, primary)
    calls = codes = 0
    def get_codes(index):
        nonlocal calls, codes
        calls += 1
        symbol = font.shapes.get(index)
        if symbol is None:
            raise ValueError('shx-subshape-missing:' + str(index))
        codes += len(symbol.data)
        if calls > MAX_SUBSHAPE_CALLS or codes > MAX_RENDER_CODES:
            raise ValueError('shx-render-budget-or-cycle')
        return symbol.data
    # render_shapes otherwise swallows UnsupportedShapeNumber. Raising our own
    # error also prevents GlyphCache's tofu and stack-underflow fallbacks.
    return shapefile.render_shapes([number], get_codes, stacked=stacked)


class StrictGlyphCache(shapefile.GlyphCache):
    def _render_shape(self, number):
        return strict_shape(self.font, number)


class ShapeTextCache(Glyphs):
    """Select Unicode/code-page/Big-Font glyphs without tofu substitution."""
    def __init__(self, binding):
        self.binding = binding
        self.font = binding['_file']
        self.font_measurements = binding['_glyphs'].font_measurements
        self.space_width = binding['_glyphs'].space_width
        self.vertical = binding.get('_vertical', False)
        self.cache = {}

    def get_scaling_factor(self, cap_height):
        return cap_height / self.font_measurements.cap_height

    def encode(self, text):
        try:
            return text.encode(self.binding['_codepage'], errors='strict')
        except UnicodeError as error:
            raise ValueError('font-codepage-character-unrepresentable: ' + repr(text)) from error

    def select(self, char):
        big = self.binding.get('_bigfont')
        encoded = None
        if big or not self.binding['_unicode']:
            encoded = self.encode(char)
        if big and encoded and any(low <= encoded[0] <= high for low, high in big.ranges):
            if len(encoded) != 2:
                raise ValueError('bigfont-lead-byte-without-pair')
            font, n = big, int.from_bytes(encoded, 'big')
        else:
            font = self.font
            n = ord(char) if self.binding['_unicode'] else int.from_bytes(encoded, 'big')
        if n not in font.shapes:
            raise ValueError('shx-glyph-missing: ' + ' '.join('U+%04X' % ord(c) for c in char))
        return font, n

    def tokens(self, text):
        big = self.binding.get('_bigfont')
        index = 0
        while index < len(text):
            char = text[index]; index += 1
            if big and not char.isspace():
                encoded = self.encode(char)
                if len(encoded) == 1 and any(low <= encoded[0] <= high for low, high in big.ranges):
                    if index == len(text): raise ValueError('bigfont-lead-byte-without-pair')
                    following = self.encode(text[index])
                    if len(following) != 1: raise ValueError('bigfont-invalid-escape-pair')
                    char += text[index]; index += 1
            yield char

    def glyph(self, char):
        if char not in self.cache:
            font, n = self.select(char)
            glyph = strict_shape(font, n, self.vertical, self.font)
            # Primary and Big Fonts declare their own height units.
            ratio = self.font_measurements.cap_height / (font.above or self.font_measurements.cap_height)
            glyph.transform_inplace(Matrix44.scale(ratio, ratio, 1))
            self.cache[char] = glyph
        return self.cache[char].clone()

    def validate(self, text):
        for char in set(self.tokens(text)):
            if not char.isspace(): self.select(char)

    def get_text_glyph_paths(self, text, cap_height=1.0, width_factor=1.0):
        self.validate(text)
        sx = self.get_scaling_factor(cap_height) * width_factor
        sy = self.get_scaling_factor(cap_height)
        x = y = 0.0; result = []
        for char in self.tokens(text):
            if char.isspace():
                if self.vertical: y -= self.font_measurements.cap_height * sy
                else: x += self.space_width * sx
                continue
            glyph = self.glyph(char)
            advance = glyph.end
            glyph.transform_inplace(Matrix44.chain(Matrix44.scale(sx, sy, 1), Matrix44.translate(x, y, 0)))
            result.append(glyph)
            x += advance.x * sx
            if self.vertical: y += advance.y * sy
        return result

    def get_text_length(self, text, cap_height, width_factor=1.0):
        self.validate(text)
        factor = self.get_scaling_factor(cap_height)
        if self.vertical:
            return abs(sum(-self.font_measurements.cap_height if c.isspace() else self.glyph(c).end.y for c in self.tokens(text))) * factor
        return sum(self.space_width if c.isspace() else self.glyph(c).end.x for c in self.tokens(text)) * factor * width_factor


class UploadedFont(fonts.ShapeFileFont):
    def __init__(self, binding, height, width=1.0):
        self.binding = binding
        self.uploaded_cache = binding['_glyphs']
        super().__init__(binding['logicalPath'], height, width)

    def create_cache(self, name):
        return self.uploaded_cache

    def validate_text(self, text):
        if len(text) > 100000:
            raise ValueError('shx-text-budget')
        if isinstance(self.uploaded_cache, ShapeTextCache):
            self.uploaded_cache.validate(text)
            return
        for char in set(text):
            if char.isspace():
                continue
            if ord(char) not in self.uploaded_cache.cmap:
                raise ValueError('font-glyph-missing: U+%04X' % ord(char))

    def text_width_ex(self, text, cap_height, width_factor=1.0):
        self.validate_text(text)
        return super().text_width_ex(text, cap_height, width_factor)

    def text_path_ex(self, text, cap_height, width_factor=1.0):
        self.validate_text(text)
        return super().text_path_ex(text, cap_height, width_factor)


class UploadedOutlineFont(UploadedFont):
    font_render_type = fonts.FontRenderType.OUTLINE

    def vertical_descent(self, height):
        # Vertical STYLE alignment uses the font-wide OS/2 typo descender,
        # not the ink of a particular p glyph (truedxf AutoCAD probes §11).
        descent = -self.uploaded_cache.font['OS/2'].sTypoDescender
        if descent < 0:
            raise ValueError('outline-font-positive-typographic-descender')
        return descent * self.uploaded_cache.get_scaling_factor(height)


class Resources:
    def __init__(self, doc, xrefs, files):
        self.doc, self.xrefs, self.files = doc, xrefs, dict(files or {})
        self.root = next(iter(xrefs.sources.values()))
        self.rows = {}
        self.loaded = {}
        self.virtual_styles = {}
        self.faces = {}
        self.failures = []
        self.fallbacks = {}
        self.outline_names = None
        self.outline_variants = {}

    def outline_candidates(self, requested):
        if self.outline_names is None:
            self.outline_names = {}
            for logical, raw in self.files.items():
                if not logical.lower().endswith(('.ttf', '.otf')) or len(raw) > MAX_OUTLINE_FONT_BYTES:
                    continue
                try:
                    with TTFont(io.BytesIO(raw), lazy=True) as font:
                        names = {entry.toUnicode().casefold() for entry in font['name'].names if entry.nameID in (1, 4, 6, 16)}
                        self.outline_variants[logical] = (font['OS/2'].usWeightClass > 400, bool(font['head'].macStyle & 2))
                    names.add(PurePosixPath(logical).stem.casefold())
                    for name in names:
                        self.outline_names.setdefault(name, []).append(logical)
                except (ValueError, KeyError, UnicodeError, OSError, TTLibError, struct.error, IndexError):
                    # Invalid uploaded bytes remain a blocked reference when
                    # requested by file name; they supply no usable family alias.
                    continue
        return sorted(set(self.outline_names.get(requested.casefold(), [])))

    def context(self, entity, refs):
        return self.xrefs.origins.get(str(entity.dxf.handle), {
            'sourceRefs': refs, 'chain': [], 'logicalSourcePath': self.xrefs.name})

    def row(self, requested, role, context, refs, variant=None):
        sid = context['sourceRefs'][0]['sourceId']
        key = identity('shx', [sid, context['chain'], requested, role, refs, variant])
        if key not in self.rows:
            row = {'id': key, 'ownerSourceId': sid, 'requestedPath': requested, 'role': role,
                   'status': 'missing', 'required': True, 'reason': '字体/形状配套文件未提供',
                   'sourceRefs': list(refs), 'usedSourceRefs': [], 'chain': context['chain'], '_used': set()}
            row['_codepage'] = context.get('codepage', self.doc.encoding)
            self.rows[key] = row
            lookup = requested.replace('\\', '/')
            if not PurePosixPath(lookup).suffix and self.outline_candidates(lookup):
                candidates = self.outline_candidates(lookup)
                if variant is not None:
                    candidates = [name for name in candidates if self.outline_variants[name] == variant]
                logical, method = (candidates[0], 'uploaded-font-family') if len(candidates) == 1 else (None, 'ambiguous' if candidates else 'missing')
            else:
                if not PurePosixPath(lookup).suffix: lookup += '.shx'
                logical, method, candidates = match_file(lookup, context['logicalSourcePath'], self.files)
            row['match'] = method
            if logical is None:
                if candidates:
                    row.update(status='ambiguous', reason='同名字体/形状库不唯一，请保留相对目录', candidates=candidates)
            else:
                row['logicalPath'] = logical
                try:
                    suffix = PurePosixPath(logical).suffix.lower()
                    if suffix not in ('.shx', '.shp', '.ttf', '.otf'):
                        raise ValueError('shx-resource-type-unsupported')
                    raw = self.files[logical]
                    row.update(sha256=hashlib.sha256(raw).hexdigest(), byteLength=len(raw))
                    outline = suffix in ('.ttf', '.otf')
                    if len(raw) > (MAX_OUTLINE_FONT_BYTES if outline else MAX_FONT_BYTES):
                        raise ValueError('shx-file-byte-limit')
                    row['_kind'] = suffix[1:].upper() if outline else 'SHX/SHP'
                    if outline:
                        if role != 'font':
                            raise ValueError('outline-font-cannot-be-bigfont-or-shape-library')
                        if logical not in self.loaded:
                            cache = TTFontRenderer(TTFont(io.BytesIO(raw), fontNumber=0))
                            if len(cache.glyph_set) > MAX_SYMBOLS or cache.font_measurements.cap_height <= 0:
                                raise ValueError('font-symbol-or-metrics-limit')
                            self.loaded[logical] = cache
                        row['_glyphs'] = self.loaded[logical]
                        font = row['_glyphs'].font
                        row['_weight'] = font['OS/2'].usWeightClass
                        row['_italic'] = bool(font['head'].macStyle & 2)
                        if variant is not None and variant != (row['_weight'] > 400, row['_italic']):
                            raise ValueError('font-requested-bold-italic-face-not-provided')
                        row.update(status='resolved', reason='上传原字体字形已加载',
                                   resourceId=identity('font', ['uploaded-outline', row['sha256']]),
                                   symbols=len(row['_glyphs'].glyph_set))
                        return row
                    if logical not in self.loaded:
                        is_big = raw.startswith(b'AutoCAD-86 bigfont') or b'*BIGFONT' in raw[:1024]
                        from . import dxf_shxfont
                        font = dxf_bigfont.load(raw) if is_big else (dxf_shxfont.load(raw) if logical.lower().endswith('.shx') else shapefile.shp_load(raw))
                        if len(font.shapes) > MAX_SYMBOLS or sum(len(s.data) for s in font.shapes.values()) > MAX_CODES:
                            raise ValueError('shx-symbol-or-code-limit')
                        self.loaded[logical] = font
                    font = self.loaded[logical]
                    row['_file'] = font
                    row['_unicode'] = (raw.startswith(b'AutoCAD-86 unifont') or raw.lstrip().startswith(b'*UNIFONT') or b'\n*UNIFONT' in raw) and font.encoding == shapefile.FontEncoding.UNICODE
                    if role == 'font' and font.is_shape_file:
                        raise ValueError('font-resource-is-shape-library')
                    if role == 'font' and isinstance(font, dxf_bigfont.BigFont):
                        raise ValueError('bigfont-requires-primary-font-style')
                    if role == 'font':
                        row['_glyphs'] = StrictGlyphCache(font)
                        if row['_glyphs'].font_measurements.cap_height <= 0:
                            raise ValueError('shx-font-metrics-invalid')
                    if role == 'bigfont' and not isinstance(font, dxf_bigfont.BigFont):
                        raise ValueError('bigfont-resource-is-not-bigfont')
                    row.update(status='resolved', reason='ezdxf 1.4.2 SHX/SHP 原字形已加载',
                               resourceId=identity('font', ['uploaded-shx', row['sha256']]), symbols=len(font.shapes))
                    if hasattr(font, 'metrics_profile'):
                        row['metricsProfile'] = font.metrics_profile
                except Exception as error:
                    row.update(status='blocked', reason=type(error).__name__ + ': ' + str(error))
        return self.rows[key]

    def use(self, row, refs):
        for ref in refs:
            key = (ref.get('sourceId'), ref.get('objectKey'), ref.get('path'), ref.get('recordOffset'))
            if key not in row['_used']:
                row['_used'].add(key)
                row['usedSourceRefs'].append(ref)

    def binding(self, entity, refs, context=None):
        context = context or self.context(entity, refs)
        style_name = entity.dxf.get('style', 'Standard')
        if style_name in self.virtual_styles:
            row = self.virtual_styles[style_name]
            self.use(row, refs)
            return row
        original = context.get('virtualFontStyles', {}).get(style_name)
        if original is None and entity.dxf.handle:
            original = context.get('fontStyle')
        if original is None:
            style = self.doc.styles.get(style_name) if self.doc.styles.has_entry(style_name) else None
            if style is None:
                return None
            original = {'font': style.dxf.get('font', 'txt'), 'bigfont': style.dxf.get('bigfont', ''),
                'flags': style.dxf.get('flags', 0), 'sourceRefs': self.xrefs.origins.get(str(style.dxf.handle), {}).get('sourceRefs',
                    [{'sourceId': context['sourceRefs'][0]['sourceId'], 'objectKey': str(style.dxf.handle), 'path': 'DXF/STYLE/' + str(style.dxf.handle)}])}
        requested = original['font'] or 'txt'
        bigfont = original.get('bigfont')
        row = self.row(requested, 'font', context, original['sourceRefs'], original.get('variant'))
        self.use(row, refs)
        binding = dict(row)
        binding['_codepage'] = context.get('codepage', self.doc.encoding)
        binding['_vertical'] = bool(original.get('flags', 0) & 4)
        if entity.dxftype() == 'MTEXT':
            flow = entity.dxf.get('flow_direction', 1)
            binding['_vertical'] = flow == 3 or flow == 5 and binding['_vertical']
        if bigfont and row.get('_kind') in ('TTF', 'OTF'):
            # AutoCAD ignores a STYLE Big Font for outline fonts. Requiring an
            # unused SHX would discard the provided TTF/OTF or substitute it.
            binding['bigfontPolicy'] = {'declared': bigfont, 'action': 'ignored-for-outline-font'}
            bigfont = None
        if bigfont:
            big = self.row(bigfont, 'bigfont', context, original['sourceRefs'])
            self.use(big, refs)
        if bigfont and big['status'] != 'resolved':
            binding.update(status='blocked', reason=big['reason'])
        elif bigfont:
            binding['_bigfont'] = big['_file']
        if binding['status'] == 'resolved' and row['_kind'] == 'SHX/SHP':
            if binding['_vertical'] and (row['_file'].mode != shapefile.FontMode.BIDIRECT or
                    bigfont and big['_file'].mode != shapefile.FontMode.BIDIRECT):
                binding.update(status='blocked', reason='shx-font-does-not-declare-vertical-mode')
            else:
                binding['_glyphs'] = ShapeTextCache(binding)
        return binding

    def font(self, binding, height=1.0, width=1.0):
        if binding['_kind'] == 'SHX/SHP' and not isinstance(binding['_glyphs'], ShapeTextCache):
            binding = {**binding, '_codepage': binding.get('_codepage', self.doc.encoding)}
            binding['_glyphs'] = ShapeTextCache(binding)
        cls = UploadedOutlineFont if binding['_kind'] in ('TTF', 'OTF') else UploadedFont
        return cls(binding, height, width)

    def face(self, row):
        family = 'cadshx_' + row['id'].split('-', 1)[1] + ('_vertical' if row.get('_vertical') else '')
        self.faces[family] = row
        return fonts.FontFace(filename=row['logicalPath'], family=family,
            style='Italic' if row.get('_italic') else 'Regular', weight=row.get('_weight', 400))

    def mtext_renderer(self, layout, entity, refs, context=None):
        resources, context = self, context or self.context(entity, refs)
        binding = self.binding(entity, refs, context)
        if binding and binding['status'] != 'resolved' and context.get('itemId'):
            self.fallback(context['itemId'], refs, binding)
        class Renderer(MTextExplode):
            def explode(self, mtext, destroy=True):
                if binding and binding.get('_vertical'):
                    from .dxf_vertical import explode
                    self.vertical_layout = explode(self, mtext, binding)
                    if destroy:
                        mtext.destroy()
                else:
                    super().explode(mtext, destroy)

            def get_font_face(self, unused):
                if binding and binding['status'] == 'resolved':
                    return resources.face(binding)
                return super().get_font_face(entity)

            def get_font(self, ctx):
                row = resources.faces.get(ctx.font_face.family)
                if row:
                    return resources.font(row, ctx.cap_height, ctx.width_factor)
                # Do not let an explicitly formatted SHX name silently resolve
                # to a TTF inside an otherwise loaded SHX paragraph.
                name = ctx.font_face.filename or ctx.font_face.family
                if name:
                    row = resources.row(name, 'font', context, refs,
                                        (ctx.font_face.is_bold, ctx.font_face.is_italic))
                    resources.use(row, refs)
                    if row['status'] != 'resolved':
                        if binding and binding.get('_vertical'):
                            raise ValueError('vertical-mtext-font-unresolved: ' + row['reason'])
                        if context.get('itemId'):
                            resources.fallback(context['itemId'], refs, row)
                        return super().get_font(ctx)
                    if binding and binding.get('_vertical'):
                        # Flow axes belong to the base MTEXT run. Outline base
                        # flow-3 lays out upright horizontal runs; use the SHX
                        # horizontal glyph/advance in that same cell contract.
                        vertical = binding['_kind'] == 'SHX/SHP'
                        row = {**row, '_vertical': vertical, '_codepage': binding['_codepage']}
                        if vertical and row['_kind'] == 'SHX/SHP' and row['_file'].mode != shapefile.FontMode.BIDIRECT:
                            raise ValueError('shx-font-does-not-declare-vertical-mode')
                        if binding.get('_bigfont') and row['_kind'] == 'SHX/SHP':
                            row['_bigfont'] = binding['_bigfont']
                    ctx.font_face = resources.face(row)
                    return resources.font(row, ctx.cap_height, ctx.width_factor)
                return super().get_font(ctx)

            def mtext_exploded_text_style(self, face):
                if face.family not in resources.faces:
                    name = face.family or face.filename
                    row = resources.row(name, 'font', context, refs, (face.is_bold, face.is_italic))
                    resources.use(row, refs)
                    if row['status'] == 'resolved':
                        face = resources.face(row)
                name = super().mtext_exploded_text_style(face)
                if face.family in resources.faces:
                    resources.virtual_styles[name] = resources.faces[face.family]
                return name
        return Renderer(layout, self.doc)

    def shape_geometry(self, entity, refs, context=None):
        context = context or self.context(entity, refs)
        libraries = [r for r in self.xrefs.shape_libraries if r['sourceId'] == refs[0]['sourceId'] and r['chain'] == context['chain']]
        name = entity.dxf.name
        if not name.isascii():
            raise ValueError('shx-shape-name-encoding-unsupported')
        matches = []
        probes = []
        for library in libraries:
            row = self.row(library['font'], 'shape-library', context, library['sourceRefs'])
            probes.append(row)
            if row['status'] == 'resolved':
                symbol = row['_file'].find(name.encode('ascii'))
                if symbol is not None:
                    matches.append((row, symbol))
        if len(matches) != 1:
            for row in probes:
                self.use(row, refs)
            reason = 'ambiguous' if matches else 'missing-file-or-name'
            raise ValueError('shx-shape-' + reason + ': ' + name)
        row, symbol = matches[0]
        self.use(row, refs)
        if entity.dxf.get('thickness', 0):
            raise ValueError('shx-shape-3d-thickness-unsupported')
        size = float(entity.dxf.size)
        ocs = OCS(entity.dxf.get('extrusion', (0, 0, 1)))
        matrix = Matrix44.chain(Matrix44.shear_xy(angle_x=math.radians(entity.dxf.get('oblique', 0))),
            Matrix44.scale(size * entity.dxf.get('xscale', 1), size, size),
            Matrix44.z_rotate(math.radians(entity.dxf.get('rotation', 0))),
            Matrix44.ucs(ocs.ux, ocs.uy, ocs.uz),
            Matrix44.translate(*entity.dxf.insert))
        outlines = strict_shape(row['_file'], symbol.number).to_path()
        points, indices = stroke_paths(outlines.sub_paths(), matrix, max(abs(size) * 1e-3, 1e-9))
        if not points:
            raise ValueError('shx-shape-output-empty')
        return points, indices, 'lines', self.info(row, shapeName=name, shapeNumber=symbol.number,
            sourcePlacement={'insert': list(entity.dxf.insert), 'size': size,
                'xscale': entity.dxf.get('xscale', 1), 'rotationDegrees': entity.dxf.get('rotation', 0),
                'obliqueDegrees': entity.dxf.get('oblique', 0), 'extrusion': list(entity.dxf.get('extrusion', (0,0,1)))})

    def info(self, row, **extra):
        return {'requested': row['requestedPath'], 'resolved': row.get('logicalPath'), 'status': row['status'],
            'referenceId': row['id'], 'resourceId': row.get('resourceId'), 'sha256': row.get('sha256'), 'fontKind': row.get('_kind', 'SHX/SHP'),
            **({'bigfontPolicy': row['bigfontPolicy']} if 'bigfontPolicy' in row else {}), **extra}

    def failure(self, item_id, refs, reason):
        self.failures.append({'itemId': item_id, 'sourceRefs': refs, 'reason': reason})

    def fallback(self, item_id, refs, row):
        self.fallbacks[item_id] = {'sourceRefs': refs, 'referenceId': row['id'], 'reason': row['reason'],
                                  'rendering': 'existing substitute preview; not uploaded original font glyphs'}

    def commit(self, document):
        presentations = document['extensions'].get('org.cad-preview.annotation-presentation/1', {}).get('items', {})
        self.fallbacks = {key: value for key, value in self.fallbacks.items()
                          if presentations.get(key, {}).get('status') != 'missing'}
        rows = [row for row in self.rows.values() if row['usedSourceRefs']]
        for row in rows:
            document['externalReferences'].append({key: row[key] for key in
                ('id', 'ownerSourceId', 'requestedPath', 'status', 'required', 'reason', 'logicalPath', 'resourceId', 'candidates') if key in row})
            if row['status'] == 'resolved':
                rid = row['resourceId']
                document['resources'][rid] = {'id': rid, 'sha256': row['sha256'], 'byteLength': row['byteLength'],
                    'role': 'font', 'mediaType': {'TTF': 'font/ttf', 'OTF': 'font/otf'}.get(row['_kind'], 'application/vnd.autodesk.shx'), 'resourceId': row['logicalPath']}
        unresolved = sum(row['status'] != 'resolved' for row in rows)
        extension = {'version': '1.0.0', 'references': [{k: v for k, v in row.items() if not k.startswith('_')} for row in rows],
            'failures': self.failures, 'substitutePreviews': self.fallbacks,
            'coverage': {'status': 'partial' if unresolved or self.failures or self.fallbacks else 'complete',
                'references': len(rows), 'resolvedReferences': len(rows) - unresolved, 'unresolvedReferences': unresolved,
                'missingObjects': len(self.failures), 'substitutedObjects': len(self.fallbacks)},
            'policy': 'uploaded bytes only; exact source-relative match then unique basename; no global font cache or silent glyph/tofu fallback',
            'limits': {'fileBytes': MAX_FONT_BYTES, 'symbols': MAX_SYMBOLS, 'codes': MAX_CODES,
                       'outlineFileBytes': MAX_OUTLINE_FONT_BYTES,
                       'renderCodes': MAX_RENDER_CODES, 'subshapeCalls': MAX_SUBSHAPE_CALLS}}
        document['extensions'][EXTENSION] = extension
        return extension['coverage']

    def assign_text_styles(self, drawing, style_ids):
        for style in self.doc.styles:
            # Proxy TEXT2 can declare a font absent from the source STYLE table.
            # Its derived style/font is recorded on the proxy presentation only.
            if style.dxf.name not in style_ids:
                continue
            origin = self.xrefs.origins.get(str(style.dxf.handle), {})
            sid = origin.get('sourceRefs', [{'sourceId': self.root['id']}])[0]['sourceId']
            key = str(style.dxf.handle)
            if origin.get('sourceRefs'):
                key = origin['sourceRefs'][0]['objectKey']
            for row in self.rows.values():
                if row['role'] == 'font' and row['status'] == 'resolved' and row['usedSourceRefs'] and row['chain'] == origin.get('chain', []):
                    if any(ref.get('sourceId') == sid and ref.get('objectKey') == key for ref in row['sourceRefs']):
                        drawing['textStyles'][style_ids[style.dxf.name]]['fontResourceId'] = row['resourceId']


def stroke_paths(outlines, matrix, tolerance):
    points, indices = [], []
    for outline in outlines:
        vertices = list(outline.flattening(tolerance, segments=2))
        first = len(points)
        points.extend(list(matrix.transform(point)) for point in vertices)
        indices.extend((first + i, first + i + 1) for i in range(len(vertices) - 1))
        if len(points) > 1000000:
            raise ValueError('shx-presentation-vertex-budget')
    if any(not math.isfinite(value) for point in points for value in point):
        raise ValueError('shx-presentation-nonfinite')
    return points, indices
