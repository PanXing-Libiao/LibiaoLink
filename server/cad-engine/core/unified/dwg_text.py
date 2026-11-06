"""Native DWG text -> original-font display geometry, without DXF entities.

The shared font caches and MTEXT cell layout supply both advances and glyphs.
Missing companions retain the existing substituted text and an explicit reason.
"""
from itertools import groupby
from pathlib import Path
from types import SimpleNamespace
import math
import struct
import sys

VENDOR = Path(__file__).resolve().parent.parent / 'vendor/ezdxf/src'
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

from ezdxf import colors, path
from ezdxf.fonts import fonts
from ezdxf.math import Matrix44, Vec3, OCS
from ezdxf.render.abstract_mtext_renderer import AbstractMTextRenderer, ATTACHMENT_POINT_TO_ALIGN
from ezdxf.tools import text_layout as tl
from ezdxf.tools.text import MTextContext, ParagraphProperties
from .dxf_shx import Resources, outline_triangles
from .dxf_mtext import MTextParser, StopTab, layout_from_tokens, text_origins


def read_font_files(directory):
    if not directory:
        return {}
    root = Path(directory)
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*')
            if p.is_file() and p.suffix.lower() in ('.shx', '.shp', '.ttf', '.otf', '.ttc')}


class LinkedOutlineFont:
    """Keep the requested outline face; link only its missing CJK to supplied SimSun."""
    font_render_type = fonts.FontRenderType.OUTLINE

    def __init__(self, primary, linked, on_link):
        self.primary, self.linked, self.on_link = primary, linked, on_link

    def spans(self, text):
        def needs_link(char):
            return ord(char) not in self.primary.uploaded_cache.cmap and (
                '\u2e80' <= char <= '\u9fff' or '\uf900' <= char <= '\ufaff' or '\uff01' <= char <= '\uff60')
        for linked, chars in groupby(text, needs_link):
            span = ''.join(chars)
            if linked: self.on_link(span)
            yield self.linked if linked else self.primary, span

    def text_width(self, text):
        return sum(font.text_width(span) for font, span in self.spans(text))

    def space_width(self):
        return self.primary.space_width()

    def text_path(self, text):
        result, cursor = path.Path(), 0.0
        for font, span in self.spans(text):
            result.extend_multi_path(font.text_path(span).to_path().transform(Matrix44.translate(cursor, 0, 0)))
            cursor += font.text_width(span)
        return SimpleNamespace(to_path=lambda: result)


class NativeFonts:
    def __init__(self, files):
        self.resources = Resources(SimpleNamespace(encoding='gbk'),
            SimpleNamespace(sources={'source-0': {'id': 'source-0'}}, name='source.dwg'), files)
        self.context = {'sourceRefs': [{'sourceId': 'source-0'}], 'chain': [],
                        'logicalSourcePath': 'source.dwg', 'codepage': 'gbk'}
        self.bindings = {}

    def binding(self, name, bigfont='', variant=None):
        key = (name, bigfont, variant)
        if key not in self.bindings:
            row = dict(self.resources.row(name or 'txt', 'font', self.context, [], variant))
            if row['status'] != 'resolved':
                raise ValueError('font-unavailable: ' + (name or 'txt') + ': ' + row['reason'])
            if bigfont and row['_kind'] == 'SHX/SHP':
                big = self.resources.row(bigfont, 'bigfont', self.context, [])
                if big['status'] != 'resolved':
                    raise ValueError('bigfont-unavailable: ' + bigfont + ': ' + big['reason'])
                row['_bigfont'] = big['_file']
                row['bigfont'] = {k: big[k] for k in ('requestedPath', 'logicalPath', 'sha256')}
            self.bindings[key] = row
        return self.bindings[key]

    def font(self, name, bigfont, height, width=1, variant=None):
        return self.resources.font(self.binding(name, bigfont, variant), height, width)


def values(annotation):
    return {k: v.get('value') for k, v in annotation['semantic'].items()}


def run_color(ctx):
    if ctx.rgb is not None:
        return {'mode': 'explicit', 'rgba': [c / 255 for c in ctx.rgb] + [1]}
    if ctx.aci in (0, 256):
        return {'mode': 'by-block'}
    rgb = (0, 0, 0) if ctx.aci == 7 else colors.aci2rgb(ctx.aci)
    return {'mode': 'explicit', 'rgba': [c / 255 for c in rgb] + [1]}


class GlyphRenderer(tl.ContentRenderer):
    def __init__(self, owner, text, ctx):
        self.owner, self.text, self.ctx = owner, text, ctx
        self.baseline = 0.0

    def render(self, left, bottom, right, top, m=None):
        font = self.owner.get_font(self.ctx)
        paths = []
        offsets, _ = text_origins(font, self.text, self.ctx.char_tracking_factor)
        if self.ctx.char_tracking_factor == 1:
            paths = list(font.text_path(self.text).to_path().sub_paths())
        else:
            for char, offset in zip(self.text, offsets):
                paths.extend(p.transform(Matrix44.translate(offset, 0, 0))
                             for p in font.text_path(char).to_path().sub_paths())
        self.baseline = round(bottom, 9)
        if self.owner.measuring:
            bounds = path.bbox(paths, fast=False)
            line = self.owner.line_ink.setdefault(self.baseline, [0.0, 0.0, 0.0])
            line[0] = max(line[0], self.ctx.cap_height, bounds.extmax.y if bounds.has_data else 0)
            line[1] = min(line[1], bounds.extmin.y if bounds.has_data else 0)
            line[2] = max(line[2], self.ctx.cap_height)
            if bounds.has_data:
                horizontal = self.owner.line_horizontal.setdefault(self.baseline,
                    [left, right, left+bounds.extmin.x, left+bounds.extmax.x])
                horizontal[0] = min(horizontal[0], left); horizontal[1] = max(horizontal[1], right)
                horizontal[2] = min(horizontal[2], left+bounds.extmin.x)
                horizontal[3] = max(horizontal[3], left+bounds.extmax.x)
            return
        bottom += self.owner.baseline_shifts.get(self.baseline, 0)
        horizontal = self.owner.line_horizontal.get(self.baseline)
        if horizontal and int(self.ctx.paragraph.align) in (0, 1):
            left += horizontal[0] - horizontal[2]
            right += horizontal[0] - horizontal[2]
        matrix = Matrix44.chain(Matrix44.shear_xy(angle_x=math.radians(self.ctx.oblique)),
                               Matrix44.translate(left, bottom, 0), m or Matrix44())
        self.owner.glyphs(paths, font, self.ctx, matrix)
        self.owner.runs.append({'text': self.text, 'left': left, 'baseline': bottom,
                               'width': right-left, 'height': self.ctx.cap_height})

    def line(self, x1, y1, x2, y2, m=None):
        if self.owner.measuring: return
        shift = self.owner.baseline_shifts.get(self.baseline, 0)
        y1 += shift; y2 += shift
        matrix = m or Matrix44()
        self.owner.add('lines', run_color(self.ctx),
                       [matrix.transform((x1, y1, 0)), matrix.transform((x2, y2, 0))])


class TextLayout(AbstractMTextRenderer):
    def __init__(self, registry, annotation):
        super().__init__()
        self.registry, self.annotation = registry, annotation
        self.source = values(annotation)
        self.batches, self.runs, self.used = {}, [], {}
        self.measuring = False
        self.line_ink, self.baseline_shifts, self.line_horizontal = {}, {}, {}
        self.linked = set()

    def get_font_face(self, unused):
        name = self.source.get('fontFilename') or self.source.get('fontFamily') or 'txt'
        return fonts.FontFace(filename=name, family=name)

    def make_bg_renderer(self, unused):
        return None

    def make_mtext_context(self, unused):
        ctx = MTextContext()
        ctx.cap_height = self.source['height']
        ctx.font_face = self.get_font_face(None)
        # Attachment supplies the default paragraph alignment; inline \\p can override it.
        ctx.paragraph = ParagraphProperties(align=ATTACHMENT_POINT_TO_ALIGN.get(
            self.source.get('attachmentPoint', 1), tl.ParagraphAlignment.LEFT))
        ctx.aci = 0
        ctx.width_factor = self.source.get('styleWidthFactor', 1)
        ctx.oblique = math.degrees(self.source.get('styleOblique', 0))
        return ctx

    def get_font(self, ctx):
        name = ctx.font_face.filename or ctx.font_face.family
        base = name == (self.source.get('fontFilename') or self.source.get('fontFamily') or 'txt')
        big = self.source.get('bigFontFilename', '') if base else ''
        variant = None if base else (ctx.font_face.is_bold, ctx.font_face.is_italic)
        binding = self.registry.binding(name, big, variant)
        self.used[binding['id']] = {k: binding[k] for k in
            ('requestedPath', 'logicalPath', 'sha256', '_kind', 'bigfont') if k in binding}
        font = self.registry.resources.font(binding, ctx.cap_height, ctx.width_factor)
        if binding['_kind'] in ('TTF', 'OTF', 'TTC') and self.registry.resources.outline_candidates('SimSun'):
            linked_binding = self.registry.binding('SimSun')
            if linked_binding['sha256'] != binding['sha256']:
                linked_font = self.registry.resources.font(linked_binding, ctx.cap_height, ctx.width_factor)
                def mark_link(span):
                    self.linked.update(span)
                    self.used[linked_binding['id']] = {k: linked_binding[k] for k in
                        ('requestedPath', 'logicalPath', 'sha256', '_kind')}
                return LinkedOutlineFont(font, linked_font, mark_link)
        return font

    def space_width(self, ctx):
        return super().space_width(ctx) * ctx.char_tracking_factor

    def tabulator(self, ctx):
        return StopTab(width=self.space_width(ctx))

    def word(self, text, ctx):
        _, width = text_origins(self.get_font(ctx), text, ctx.char_tracking_factor)
        return tl.Text(width=width, height=ctx.cap_height, valign=tl.CellAlignment(ctx.align),
                       stroke=self.get_stroke(ctx), renderer=GlyphRenderer(self, text, ctx))

    def fraction(self, data, ctx):
        top, bottom, divider = data
        return tl.Fraction(self.word(top, ctx), self.word(bottom, ctx),
                           stacking=self.get_stacking(divider), renderer=GlyphRenderer(self, '', ctx))

    def add(self, topology, color, points):
        key = (topology, str(color))
        if key not in self.batches:
            self.batches[key] = {'topology': topology, 'color': color, 'points': []}
        self.batches[key]['points'].extend(points)

    def glyphs(self, paths, font, ctx, matrix):
        tolerance = max(ctx.cap_height * .001, 1e-9)
        points = []
        if font.font_render_type == fonts.FontRenderType.STROKE:
            topology = 'lines'
            for outline in paths:
                vertices = list(outline.flattening(tolerance, segments=2))
                for a, b in zip(vertices, vertices[1:]):
                    points.extend((matrix.transform(a), matrix.transform(b)))
        else:
            topology = 'triangles'
            for triangle in outline_triangles(paths, tolerance):
                points.extend(matrix.transform((p.x, p.y, 0)) for p in triangle)
        self.add(topology, run_color(ctx), points)

    def render_mtext(self, layout, matrix):
        self.measuring = True
        layout.render()
        self.measuring = False
        baselines = sorted(self.line_ink, reverse=True)
        spacing = self.source.get('lineSpacing', 1)
        expansion = correction = 0.0
        previous_height = 0.0
        for index, baseline in enumerate(baselines):
            ascent, descent, height = self.line_ink[baseline]
            # At-least spacing pushes each tall line down by its ink above cap.
            if index == 0 or self.source.get('lineSpacingStyle', 'AtLeast') == 'AtLeast':
                expansion += ascent - height
            if index: correction += previous_height * spacing * (1.667 - 5/3)
            self.baseline_shifts[baseline] = correction - expansion
            previous_height = height
        if baselines:
            last = baselines[-1]
            extra_height = -self.baseline_shifts[last] - self.line_ink[last][1]
            anchor = ((self.source.get('attachmentPoint', 1)-1)//3) * .5
            self.baseline_shifts = {key: shift + anchor*extra_height
                                    for key, shift in self.baseline_shifts.items()}
        horizontal_anchor = (self.source.get('attachmentPoint', 1)-1) % 3
        if horizontal_anchor and self.source.get('rectangleWidth', 0) <= self.source['height'] * .1:
            # The unbounded-flow estimate prevents wrapping; it is not the frame
            # width. Center/right attachments anchor the actual rendered extent.
            layout.render()
            points = [p for batch in self.batches.values() for p in batch['points']]
            if points:
                left, right = min(p.x for p in points), max(p.x for p in points)
                shift = -(left+right)/2 if horizontal_anchor == 1 else -right
                matrix = Matrix44.chain(Matrix44.translate(shift, 0, 0), matrix)
                for batch in self.batches.values():
                    batch['points'] = [matrix.transform(p) for p in batch['points']]
                for run in self.runs:
                    run['left'] += shift
        else:
            layout.render(matrix)

    def render(self):
        s, a = self.source, self.annotation
        # Empty attributes have no glyphs, even when their generation flags mirror.
        if a['kind'] == 'text' and not a['text']:
            return []
        if s.get('hasColumns') or s.get('drawingDirection') == 'TopToBottom':
            raise ValueError('native-text-column-or-vertical-layout-unavailable')
        normal = Vec3(s.get('normal', (0, 0, 1)))
        if a['kind'] == 'mtext':
            x = Vec3(a['direction']).normalize()
            matrix = Matrix44.ucs(x, normal.cross(x).normalize(), normal,
                                  origin=Vec3(a['position']))
            proxy = SimpleNamespace(dxf=SimpleNamespace(char_height=s['height']), has_columns=False)
            tokens = list(MTextParser(s['rawText'], self.make_mtext_context(None)))
            width = s.get('rectangleWidth', 0)
            # FastView probes: at height 150, width 15 is unbounded; 15.001 wraps.
            if width <= s['height'] * .1: width = 0
            layout = layout_from_tokens(self, proxy, tokens, width,
                                        s.get('lineSpacing', 1), cjk=True)
            layout.place(align=tl.LayoutAlignment(s.get('attachmentPoint', 1)))
            self.render_mtext(layout, matrix)
        else:
            # Native DWG already stores the positioned baseline insertion point.
            # Re-applying DXF alignment would shift centered/right text twice.
            if s.get('mirror', 0) or s.get('horizontalAlignment') in ('Fit', 'Aligned'):
                raise ValueError('native-text-mirrored-or-fit-layout-unavailable')
            ctx = self.make_mtext_context(None)
            ctx.width_factor = s.get('widthFactor', 1)
            ctx.oblique = math.degrees(s.get('oblique', 0))
            point = Vec3(s.get('insertPoint', a['position']))
            ocs = OCS(normal)
            matrix = Matrix44.chain(Matrix44.z_rotate(s['rotation']),
                                     Matrix44.translate(*point),
                                     Matrix44.ucs(ocs.ux, ocs.uy, ocs.uz))
            font = self.get_font(ctx)
            GlyphRenderer(self, a['text'], ctx).render(0, 0, font.text_width(a['text']), ctx.cap_height, matrix)
        return list(self.batches.values())


def add_text_displays(annotations, displays, extras, buffer_bytes, font_files):
    registry = NativeFonts(font_files)
    records = {}
    for key, annotation in annotations.items():
        if annotation['kind'] not in ('text', 'mtext'):
            continue
        layout = TextLayout(registry, annotation)
        try:
            batches = layout.render()
        except ValueError as error:
            records[key] = {'status': 'substituted', 'reason': str(error)}
            continue
        parts = []
        for index, batch in enumerate(batches):
            points = batch['points']
            if not points:
                continue
            part = key + '-text-' + str(index)
            vertices, indices, lookup = [], [], {}
            for point in points:
                vertex = tuple(point)
                if vertex not in lookup:
                    lookup[vertex] = len(vertices); vertices.append(vertex)
                indices.append(lookup[vertex])
            points = vertices
            offset = len(buffer_bytes)
            for point in points:
                buffer_bytes.extend(struct.pack('<3d', *point))
            displays[part] = {'offset': offset, 'byteLength': len(points)*24, 'count': len(points),
                'topology': batch['topology'], 'sourceRefs': annotation['sourceRefs'], 'indices': indices,
                'min': [min(p[i] for p in points) for i in range(3)],
                'max': [max(p[i] for p in points) for i in range(3)]}
            parts.append({'id': part, 'role': 'fill' if batch['topology'] == 'triangles' else 'stroke',
                          'color': batch['color']})
        if parts:
            extras.setdefault('meshPresentations', {})[key] = {
                'sourceKind': annotation['kind'].upper(), 'textParts': parts}
        records[key] = {'status': 'ready', 'fonts': list(layout.used.values()), 'runs': layout.runs,
                        'linkedCharacters': ''.join(sorted(layout.linked))}
        extras.setdefault('textAppearance', {}).setdefault(key, {})['fontStatus'] = 'linked-glyphs' if layout.linked else 'original-glyphs'
    return records
