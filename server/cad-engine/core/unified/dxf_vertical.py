"""Vertical text placement over uploaded glyphs, before the common WCS transform.

Alignment/flow observations: truedxf 019c2e5, research/notes/04-text-fonts.md
§11 (AutoCAD probes). TEXT group 72 moves along the column; 73 does not move
across it. MTEXT SHX paragraphs advance left to right; outline-font flow 3
retains horizontal glyphs. Complex flow uses the shared cell layout; inferred
flow geometry is recorded separately from missing geometry.
"""
import math

from ezdxf import path
from ezdxf.math import Matrix44, Vec3
from ezdxf.addons.mtxpl import FrameRenderer, get_base_attribs, get_color_attribs, make_bg_renderer
from ezdxf.tools.text import TokenType
from ezdxf.tools import text_layout as tl
from ezdxf.enums import MTextParagraphAlignment
from .dxf_mtext import MTextParser, StopTab, TrackedTextRenderer, layout_from_tokens, text_origins


def text_matrix(entity, font, outline):
    """Place an already sized path; width never changes column alignment length."""
    bounds = path.bbox([part for part in outline.sub_paths() if len(part)], fast=True)
    if not bounds.has_data:
        return entity.wcs_transformation_matrix()
    height = entity.dxf.height
    is_outline = font.font_render_type.name == 'OUTLINE'
    top = 0 if is_outline else bounds.extmax.y
    bottom = -font.vertical_descent(height) if is_outline else bounds.extmin.y
    halign, valign = entity.dxf.halign, entity.dxf.valign
    insert = entity.dxf.insert
    align = entity.dxf.get('align_point', Vec3(0, 0, insert.z))
    anchor, shift, scale = insert, 0.0, 1.0
    angle = math.radians(entity.dxf.rotation)
    width = entity.dxf.width
    if halign in (3, 5):
        delta = align - insert
        distance = math.hypot(delta.x, delta.y)
        length = top - bottom
        angle = math.atan2(delta.y, delta.x) + (-math.pi/2 if entity.is_backward else math.pi/2)
        if length > 1e-12 and distance > 1e-12:
            if halign == 3:
                scale = distance / length
            else:
                width = distance / length
        elif halign == 3:
            scale = entity.doc.header.get('$TEXTSIZE', 2.5) / height
        shift = top
    elif halign != 0 or valign != 0:
        anchor = align
        if halign in (1, 4):
            shift = bounds.center.y if is_outline else (top + bottom)/2
        elif halign == 2:
            shift = bottom
    matrix = Matrix44.chain(Matrix44.translate(0, -shift, 0), Matrix44.scale(scale, scale, 1))
    if entity.dxf.oblique:
        matrix *= Matrix44.shear_xy(angle_x=math.radians(entity.dxf.oblique))
    matrix *= Matrix44.scale(width * (-1 if entity.is_backward else 1), -1 if entity.is_upside_down else 1, 1)
    matrix *= Matrix44.z_rotate(angle)
    matrix *= Matrix44.translate(*anchor)
    if entity.ocs().transform:
        matrix *= entity.ocs().matrix
    return matrix


class FlowFrameRenderer(FrameRenderer):
    """Map layout strokes to the flow axes, without transforming glyph shapes."""
    def line(self, x1, y1, x2, y2, m=None):
        super().line(-y1, -x1, -y2, -x2, m)


class FlowTextRenderer(FlowFrameRenderer):
    def __init__(self, glyphs, attribs, line_attribs, layout, flow):
        super().__init__(line_attribs, layout)
        self.glyphs, self.attribs, self.flow = glyphs, attribs, flow

    def render(self, left, bottom, right, top, m=None):
        # Only the cell axes turn. Code-14 SHX glyphs already contain the
        # correct vertical drawing and pen advance; rotating them again is wrong.
        for char, x, y in self.glyphs:
            leaf = self.layout.add_text(char, dxfattribs=self.attribs)
            leaf.dxf.insert = (-top + x - self.flow.left, -left + y, 0)
            if m:
                leaf.transform(m)


class FlowCells:
    """Adapt uploaded glyphs to the shared paragraph/fraction/tab layout cells."""
    def __init__(self, renderer, entity, stroked):
        self.renderer, self.entity, self.stroked = renderer, entity, stroked
        self.features = set()
        self.parts = 0
        self.left = 0.0
        self.first_contexts = set()

    def make_mtext_context(self, entity):
        ctx = self.renderer.make_mtext_context(entity)
        # Attachment refers to the physical frame, not alignment down a column.
        # Explicit \p paragraph formatting can override this initial alignment.
        ctx.paragraph = ctx.paragraph._replace(align=MTextParagraphAlignment.DEFAULT)
        return ctx

    def word(self, text, ctx):
        font = self.renderer.get_font(ctx)
        if not self.stroked:
            if font.font_render_type.name != 'OUTLINE':
                self.features.add('mixed-font-orientation')
            cell = self.renderer.word(text, ctx)
            offsets, _ = text_origins(font, text, ctx.char_tracking_factor)
            cell.renderer = TrackedTextRenderer(cell.renderer, offsets)
            self.parts += len(text)
            if self.parts > 20000:
                raise ValueError('annotation-presentation-budget')
            return cell
        tracking = ctx.char_tracking_factor
        if not math.isfinite(tracking) or tracking <= 0:
            raise ValueError('mtext-tracking-nonpositive-or-nonfinite-unsupported')
        glyphs = []
        x = y = left = 0.0
        cross_size = ctx.cap_height * ctx.width_factor
        stroke_font = font.font_render_type.name == 'STROKE'
        chars = font.uploaded_cache.tokens(text) if stroke_font else text
        for char in chars:
            font.validate_text(char)
            if stroke_font:
                cache = font.uploaded_cache
                advance = cache.glyph(char).end if not char.isspace() else Vec3(0, -cache.font_measurements.cap_height, 0)
                scale = cache.get_scaling_factor(ctx.cap_height)
                dx, dy = advance.x * scale * ctx.width_factor, advance.y * scale
                gx, gy = x, y
            else:
                # An inline outline font has no SHX vertical bytecode. Keep its
                # upright shape in a cap-height flow cell, centred across it.
                self.features.add('mixed-font-orientation')
                dx, dy = 0, -ctx.cap_height
                gx, gy = x-font.text_width(char)/2, y-ctx.cap_height
            if not char.isspace():
                glyphs.append((char, gx, gy))
                glyph = font.text_path_ex(char, ctx.cap_height).to_path()
                pose = Matrix44.chain(Matrix44.shear_xy(angle_x=math.radians(ctx.oblique)),
                    Matrix44.scale(ctx.width_factor, 1, 1), Matrix44.translate(gx, gy, 0))
                bounds = path.bbox([part.transform(pose) for part in glyph.sub_paths() if len(part)], fast=True)
                if bounds.has_data:
                    left = min(left, bounds.extmin.x)
                    cross_size = max(cross_size, bounds.extmax.x-left)
            x += dx * tracking
            y += dy * tracking
        if not math.isfinite(x+y+cross_size) or y > 1e-8 or cross_size <= 0:
            raise ValueError('vertical-mtext-glyph-advance-invalid')
        if id(ctx) in self.first_contexts:
            self.left = min(self.left, left)
        self.parts += len(glyphs)
        if self.parts > 20000:
            raise ValueError('annotation-presentation-budget')
        attribs = {**get_base_attribs(self.entity), **get_color_attribs(ctx), **self.renderer.get_text_attribs(ctx)}
        paint = FlowTextRenderer(glyphs, attribs, {**get_base_attribs(self.entity), **get_color_attribs(ctx)},
                                  self.renderer.layout, self)
        return tl.Text(width=-y, height=cross_size, valign=tl.CellAlignment(ctx.align),
            stroke=self.renderer.get_stroke(ctx), renderer=paint)

    def fraction(self, data, ctx):
        upper, lower, kind = data
        if not kind:
            return self.word(upper, ctx)
        paint = FlowFrameRenderer if self.stroked else FrameRenderer
        return tl.Fraction(top=self.word(upper, ctx), bottom=self.word(lower, ctx),
            stacking=self.renderer.get_stacking(kind), valign=tl.CellAlignment(ctx.align),
            renderer=paint({**get_base_attribs(self.entity), **get_color_attribs(ctx)}, self.renderer.layout))

    def space_width(self, ctx):
        return ctx.cap_height * ctx.char_tracking_factor if self.stroked else self.renderer.space_width(ctx)

    def space(self, ctx):
        return tl.Space(width=self.space_width(ctx))

    def non_breaking_space(self, ctx):
        return tl.NonBreakingSpace(width=self.space_width(ctx))

    def tabulator(self, ctx):
        return StopTab(width=self.space_width(ctx))

    def make_bg_renderer(self, entity):
        # Backgrounds are rendered after placement from the actual flow frame,
        # not the generous upper bound used to lay out an unbounded paragraph.
        return None


def frames(layout, bounded):
    """Get cell frames, excluding strokes and background padding from attachment."""
    result = []
    for column in layout:
        x, y = column.final_location()
        left, right = x, x + (column.total_width if bounded else 0)
        for paragraph in column:
            if isinstance(paragraph, tl.EmptyParagraph):
                continue
            for line in paragraph:
                lx, _ = line.final_location()
                left = min(left, lx)
                right = max(right, lx+line.total_width)
        height = column.content_height
        result.append((left, y-height, right, y))
    return result


def explode(renderer, entity, binding):
    """Render complex vertical flow, exposing inferred CAD placement as partial."""
    if binding['status'] != 'resolved':
        raise ValueError('vertical-mtext-font-unresolved: '+binding['reason'])
    renderer.current_base_attribs = get_base_attribs(entity)
    cells = FlowCells(renderer, entity, binding['_kind'] == 'SHX/SHP')
    tokens = list(MTextParser(entity.all_columns_raw_content(), cells.make_mtext_context(entity)))
    for token in tokens:
        if token.type in (TokenType.NEW_PARAGRAPH, TokenType.NEW_COLUMN):
            break
        # The parser may reuse a context across paragraph boundaries. Give
        # first-column measurements their own scope without mutating the
        # shared font/format context of later columns.
        token.ctx = token.ctx.copy()
        cells.first_contexts.add(id(token.ctx))
    features = cells.features
    if entity.dxf.attachment_point != 1:
        features.add('attachment-frame')
    if entity.has_columns:
        features.add('column-frames')
    if entity.dxf.get('bg_fill', 0):
        features.add('background-frame')
    for token in tokens:
        if token.type in (TokenType.STACK, TokenType.TABULATOR, TokenType.NEW_COLUMN):
            features.add(token.type.name.lower())
        if renderer.get_stroke(token.ctx):
            features.add('decorations')
        p = token.ctx.paragraph
        if p.left or p.right or p.indent or p.tab_stops or int(p.align) not in (0, 1):
            features.add('paragraph-format')
    height = entity.dxf.char_height
    width = entity.columns.width if entity.has_columns else entity.dxf.get('width', 0)
    if width > 1e-6:
        features.add('defined-flow-width')
    # ezdxf's horizontal leading uses its rounded 1.667 factor. Normalize by
    # that function so the established 4/3 vertical pitch remains exact.
    spacing = entity.dxf.line_spacing_factor * ((4/3)/tl.leading(1) if cells.stroked else 1)
    layout = layout_from_tokens(cells, entity, tokens, width, spacing,
        paragraph_gap=None if cells.stroked else .55*height)
    layout.place()
    if entity.has_columns:
        reverse = entity.columns.reversed_column_flow
        for column in layout:
            x, y = column.final_location()
            # AcDbMText::setColumnFlowReversed specifies below/above for flow
            # 3. That frame progression also applies to upright outline runs.
            if cells.stroked:
                column.place(-x if reverse else x, y)
            else:
                column.place(0, y+(x if reverse else -x))
    cell_frames = frames(layout, width > 1e-6 or entity.has_columns)
    if not cell_frames:
        raise ValueError('vertical-mtext-layout-empty')
    # The outline-font flow-3 baseline is the insertion baseline, as in the
    # simple AutoCAD probes. Fractions may enlarge the cross-flow cell height.
    baseline = 0 if cells.stroked else next(iter(layout)).used_content_height()
    physical = [(-top, -right, -bottom, -left) if cells.stroked else
                (left, bottom+baseline, right, top+baseline) for left, bottom, right, top in cell_frames]
    xmin = min(b[0] for b in physical); ymin = min(b[1] for b in physical)
    xmax = max(b[2] for b in physical); ymax = max(b[3] for b in physical)
    row, col = divmod(entity.dxf.attachment_point-1, 3)
    anchor_x = (xmin, (xmin+xmax)/2, xmax)[col]
    anchor_y = (ymax, (ymin+ymax)/2, ymin)[row]
    # Keep the established outline top-row baseline semantics.
    if not cells.stroked and row == 0:
        anchor_y = 0
    bg = make_bg_renderer(entity, renderer.layout)
    if bg.solid_attribs is not None and entity.dxf.hasattr('bg_fill_transparency'):
        bg.solid_attribs['transparency'] = entity.dxf.bg_fill_transparency
    for box in physical:
        bg.render(left=box[0], bottom=box[1]-baseline, right=box[2], top=box[3]-baseline)
    layout.render()
    leaves = list(renderer.layout)
    if len(leaves) > 20000:
        raise ValueError('annotation-presentation-budget')
    matrix = Matrix44.chain(Matrix44.translate(-anchor_x, baseline-anchor_y, 0), entity.ucs().matrix)
    for leaf in leaves:
        leaf.transform(matrix)
    # A successful geometry conversion does not establish pixel equivalence to
    # AutoCAD. Keep the rendering and its remaining uncertainty independently.
    return {'flow': 'vertical-shx' if cells.stroked else 'outline-flow-3',
        'features': sorted(features), 'frames': [list(box) for box in physical],
        'frameSpace': 'mtext-local-before-attachment-and-ucs', 'attachmentPoint': entity.dxf.attachment_point,
        'verification': 'cell-layout-regressions; complex flow awaits source-CAD comparison' if features else 'basic-flow-upstream-probes'}
