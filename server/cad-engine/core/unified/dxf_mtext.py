"""Bounded MTEXT layout over ezdxf 1.4.2; source fields remain read-only.

Layout assembly adapts ezdxf's MIT AbstractMTextRenderer. Tracking advances
follow MIT @mlightcad/mtext-renderer 0.12.4 MTextProcessor (see docs/dxf-mtext).
The glyph, font, paragraph, fraction, stroke and WCS implementations stay ezdxf's.
"""
import math
import re

from ezdxf.addons.mtxpl import MTextExplode, TextRenderer, get_base_attribs
from ezdxf.render import abstract_mtext_renderer as am
from ezdxf.tools import text_layout as tl
from ezdxf.tools.text import MTextParser as BaseParser, TokenType
from ezdxf.enums import TextEntityAlignment

from .adapter import identity

EXTENSION = 'org.cad-preview.dxf-mtext/1'
MAX_FIELD_OBJECTS = 128
MAX_FIELD_DEPTH = 16
MAX_TEXT = 100000
VERTICAL_FEATURES = {'attachment-frame': '附着点', 'column-frames': '分栏',
    'background-frame': '背景框', 'stack': '分数', 'tabulator': '制表', 'new_column': '强制换栏',
    'decorations': '装饰线', 'paragraph-format': '段落格式', 'mixed-font-orientation': '混合字体方向',
    'defined-flow-width': '固定文字宽度'}


class MTextParser(BaseParser):
    def parse_char_tracking(self, ctx):
        # Fixed ezdxf's shared height parser loses a leading decimal point and
        # takes abs(), masking negative tracking. Keep its scanner and scopes.
        match = re.match(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?x?', self.scanner.tail())
        if match is None:
            raise ValueError('mtext-tracking-format-unsupported')
        expr = match.group(); self.scanner.consume(len(expr))
        value = float(expr[:-1] if expr.endswith('x') else expr)
        if not math.isfinite(value) or value <= 0:
            raise ValueError('mtext-tracking-nonpositive-or-nonfinite-unsupported')
        ctx.char_tracking_factor = ctx.char_tracking_factor * value if expr.endswith('x') else value
        self.consume_optional_terminator()


def tag_value(value):
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (tuple, list)) or hasattr(value, 'xyz'):
        return [tag_value(part) for part in value]
    return str(value) if isinstance(value, float) and not math.isfinite(value) else value


def field_info(entity, source_id):
    """Read the original dictionary/FIELD graph before xref.Loader remaps handles."""
    if not entity.has_extension_dict or 'ACAD_FIELD' not in entity.extension_dict:
        return None
    result = {'roots': [], 'objects': [], 'sourceText': entity.text if entity.dxftype()=='MTEXT' else entity.dxf.text, 'status': 'ready'}
    seen, active = set(), set()

    def walk(obj, depth):
        handle = str(getattr(getattr(obj, 'dxf', None), 'handle', ''))
        if not handle or obj.dxftype() not in ('FIELD', 'ACAD_FIELD'):
            raise ValueError('mtext-field-object-missing')
        if handle in active:
            raise ValueError('mtext-field-cycle')
        if handle in seen:
            return
        if len(seen) >= MAX_FIELD_OBJECTS or depth > MAX_FIELD_DEPTH:
            raise ValueError('mtext-field-budget')
        seen.add(handle); active.add(handle)
        tags = list(obj.xtags.get_subclass('AcDbField'))
        boundary = next(i for i, tag in enumerate(tags) if tag.code == 90)
        code = ''.join(str(tag.value) for tag in tags[1:boundary] if tag.code in (2, 3))
        evaluator = next(str(tag.value) for tag in tags[:boundary] if tag.code == 1)
        cache = None
        start = next((i for i, tag in enumerate(tags) if tag.code == 7 and tag.value == 'ACFD_FIELD_VALUE'), None)
        if start is not None:
            end = next((i for i in range(start + 1, len(tags)) if tags[i].code == 304 and tags[i].value == 'ACVALUE_END'), start)
            value = tags[start + 1:end]
            kind = next((tag.value for tag in value if tag.code == 90), None)
            if kind == 4 and sum(tag.code == 1 for tag in value) == 1:
                cache = ''.join(str(tag.value) for tag in value if tag.code in (1, 2))
        children = [str(tag.value) for tag in tags[boundary + 1:] if tag.code == 360]
        if tags[boundary].value != len(children):
            raise ValueError('mtext-field-child-count-mismatch')
        row = {'sourceRefs': [{'sourceId': source_id, 'objectKey': handle, 'path': 'DXF/FIELD/' + handle}],
               'evaluator': evaluator, 'code': code, 'cachedText': cache, 'children': children,
               'tags': [[tag.code, tag_value(tag.value)] for tag in tags]}
        if len(code) + len(cache or '') > MAX_TEXT:
            raise ValueError('mtext-field-text-budget')
        result['objects'].append(row)
        for child in children:
            walk(entity.doc.entitydb.get(child), depth + 1)
        active.remove(handle)

    try:
        dictionary = entity.extension_dict.get('ACAD_FIELD')
        result['dictionarySourceRefs'] = [{'sourceId': source_id, 'objectKey': str(dictionary.dxf.handle),
                                         'path': 'DXF/DICTIONARY/' + str(dictionary.dxf.handle)}]
        for key, obj in dictionary.items():
            result['roots'].append({'key': key, 'handle': str(obj.dxf.handle)})
            walk(obj, 0)
    except Exception as error:
        result.update(status='missing', reason=type(error).__name__ + ': ' + str(error))
    return result


class TrackedTextRenderer(TextRenderer):
    def __init__(self, base, origins):
        super().__init__(base.text, base.text_attribs, base.line_attribs, base.layout)
        self.origins = origins

    def render(self, left, bottom, right, top, m=None):
        for char, offset in zip(self.text, self.origins):
            text = self.layout.add_text(char, dxfattribs=self.text_attribs)
            text.set_placement((left + offset, bottom), align=TextEntityAlignment.LEFT)
            if m:
                text.transform(m)


class StopTab(tl.Tabulator):
    def to_space(self):
        # The upstream fallback silently converts an exhausted tab stop to a space.
        raise ValueError('mtext-tab-stop-exhausted')


def text_origins(font, text, factor):
    """Preserve pair kerning while applying tracking to advances, not outlines."""
    if not math.isfinite(factor) or factor <= 0:
        raise ValueError('mtext-tracking-nonpositive-or-nonfinite-unsupported')
    advance = {char: font.space_width() if char.isspace() else font.text_width(char) for char in text}
    offsets, cursor, previous = [], 0.0, ''
    for char in text:
        if previous and not (previous.isspace() and char.isspace()):
            cursor += (font.text_width(previous+char)-advance[previous]-advance[char])*factor
        offsets.append(cursor)
        cursor += advance[char]*factor
        previous = char
    if not math.isfinite(cursor) or cursor < 0:
        raise ValueError('mtext-tracking-advance-invalid')
    return offsets, cursor


def layout_from_tokens(renderer, mtext, tokens, width, line_spacing, paragraph_gap=None):
    """Shared cell assembly: horizontal and vertical flow use identical tab fields,
    paragraph formatting, fractions, wrapping and column overflow rules.
    A zero width is unbounded; its upper bound includes authored tab stops.
    """
    height = mtext.dxf.char_height
    # Width=0 is unbounded. The ordinary text estimate does not account for
    # tab advances; bound the entire token stream instead of wrapping it.
    token_cells = {}
    if width < 1e-6:
        width = height
        stop_extent = indent_extent = 0
        for index, token in enumerate(tokens):
            if token.type in (TokenType.WORD, TokenType.STACK):
                cell = renderer.word(token.data, token.ctx) if token.type == TokenType.WORD else renderer.fraction(token.data, token.ctx)
                token_cells[index] = cell
                width += cell.total_width
            elif token.type in (TokenType.SPACE, TokenType.NBSP):
                width += renderer.space_width(token.ctx)
            elif token.type == TokenType.TABULATOR:
                width += 4 * height
            elif token.type == TokenType.NEW_PARAGRAPH and paragraph_gap is not None:
                width += paragraph_gap
            p = token.ctx.paragraph
            indent_extent = max(indent_extent, height * (abs(p.left) + abs(p.right) + abs(p.indent)))
            for stop in p.tab_stops:
                stop_extent = max(stop_extent, (float(stop[1:]) if isinstance(stop, str) else float(stop)) * height)
        width += stop_extent + indent_extent
    default_stops = am.make_default_tab_stops(height, width)
    layout = tl.Layout(width=width)
    bg = renderer.make_bg_renderer(mtext)
    if mtext.has_columns:
        columns = mtext.columns
        for h in am.column_heights(columns):
            layout.append_column(width=columns.width, height=h, gutter=columns.gutter_width, renderer=bg)
    else:
        layout.append_column(renderer=bg)
    ctx = renderer.make_mtext_context(mtext)
    cells = []

    def append_paragraph():
        nonlocal cells
        tabs = any(isinstance(cell, StopTab) for cell in cells)
        align = am.ALIGN.get(ctx.paragraph.align, tl.ParagraphAlignment.LEFT)
        if tabs and align not in (tl.ParagraphAlignment.LEFT, tl.ParagraphAlignment.JUSTIFIED):
            raise ValueError('mtext-tab-paragraph-alignment-unsupported')
        p = ctx.paragraph
        stops = am.make_tab_stops(height, width, p.tab_stops, []) if p.tab_stops else default_stops
        grouped = []
        index = 0
        while index < len(cells):
            cell = cells[index]; grouped.append(cell); index += 1
            if not isinstance(cell, StopTab):
                continue
            if index == len(cells) or isinstance(cells[index], StopTab):
                # A separate zero-width cell makes every consecutive tab advance one stop.
                grouped.append(tl.ContentCell(0, height))
        if grouped:
            paragraph = tl.Paragraph(align=align,
                indent=((p.left + p.indent) * height, p.left * height, p.right * height),
                line_spacing=line_spacing, tab_stops=stops,
                align_tab_fields=True)
            paragraph.append_content(grouped)
        else:
            paragraph = tl.EmptyParagraph(cap_height=ctx.cap_height, line_spacing=line_spacing)
        layout.append_paragraphs([paragraph]); cells = []

    for token_index, token in enumerate(tokens):
        ctx = token.ctx
        if token.type == TokenType.NEW_PARAGRAPH and paragraph_gap is not None:
            cells.append(tl.NonBreakingSpace(width=paragraph_gap))
        elif token.type in (TokenType.NEW_PARAGRAPH, TokenType.NEW_COLUMN):
            append_paragraph()
            if token.type == TokenType.NEW_COLUMN:
                layout.next_column()
        elif token.type in (TokenType.WORD, TokenType.STACK):
            if cells and isinstance(cells[-1], (tl.Text, tl.Fraction)):
                cells.append(am.super_glue())
            cell = token_cells.get(token_index)
            if cell is None:
                cell = renderer.word(token.data, ctx) if token.type == TokenType.WORD else renderer.fraction(token.data, ctx)
            cells.append(cell)
        elif token.type == TokenType.SPACE:
            cells.append(renderer.space(ctx))
        elif token.type == TokenType.NBSP:
            cells.append(renderer.non_breaking_space(ctx))
        elif token.type == TokenType.TABULATOR:
            cells.append(renderer.tabulator(ctx))
    if cells:
        append_paragraph()
    return layout


class Renderer(MTextExplode):
    def word(self, text, ctx):
        cell = super().word(text, ctx)
        factor = ctx.char_tracking_factor
        if not math.isfinite(factor) or factor <= 0:
            raise ValueError('mtext-tracking-nonpositive-or-nonfinite-unsupported')
        if math.isclose(factor, 1.0, rel_tol=0, abs_tol=1e-12):
            return cell
        offsets, cursor = text_origins(self.get_font(ctx), text, factor)
        # Width drives wrapping and alignment; each unchanged glyph is placed separately.
        cell = tl.Text(width=cursor, height=ctx.cap_height, valign=tl.CellAlignment(ctx.align),
            stroke=self.get_stroke(ctx), renderer=TrackedTextRenderer(cell.renderer, offsets))
        return cell

    def space_width(self, ctx):
        factor = ctx.char_tracking_factor
        if not math.isfinite(factor) or factor <= 0:
            raise ValueError('mtext-tracking-nonpositive-or-nonfinite-unsupported')
        return super().space_width(ctx) * factor

    def tabulator(self, ctx):
        return StopTab(width=self.space_width(ctx))

    def layout_engine(self, mtext):
        self.current_base_attribs = get_base_attribs(mtext)
        content = mtext.all_columns_raw_content()
        if '\t' not in content and '^I' not in content and '\\T' not in content:
            return super().layout_engine(mtext)
        tokens = list(MTextParser(content, self.make_mtext_context(mtext)))
        return layout_from_tokens(self, mtext, tokens, mtext.dxf.get("width", 0), mtext.dxf.line_spacing_factor)


class Resources:
    def __init__(self, xrefs):
        self.xrefs, self.items = xrefs, {}

    def new_record(self, refs, context, raw, fields=None):
        parent = context['itemId']
        key = identity('mtext-layout', [parent, sum(row['itemId'] == parent for row in self.items.values())])
        row = {'itemId': parent, 'sourceRefs': refs, 'chain': context.get('chain', []), 'rawText': raw,
               'status': 'missing', 'fields': fields, 'dynamicEvaluationsUnsupported': 0}
        self.items[key] = row
        return row

    def record_layout(self, entity, refs, context, row, layout):
        if row is None:
            row = self.new_record(refs, context, entity.all_columns_raw_content())
        row.update(status='ready', verticalLayout=layout)
        row['layoutWarnings'] = (['复杂竖排已生成预览，排版规则待原 CAD 对照：'+'、'.join(VERTICAL_FEATURES[feature] for feature in layout['features'])]
                                 if layout['features'] else [])

    def prepare(self, entity, refs, context):
        if getattr(entity,'_cad_proxy_text',{}).get('raw'):
            return entity,None
        source = entity
        # Block/table virtual entities lose handles and FIELD extension data in
        # ezdxf's copy operation. Recover metadata from its recorded source;
        # keep the transformed virtual entity for the actual layout.
        for _ in range(MAX_FIELD_DEPTH):
            original = source.source_of_copy
            if not source.is_virtual or original is None or original.dxftype() != entity.dxftype():
                break
            source = original
        origin = self.xrefs.origins.get(str(source.dxf.handle), {})
        fields = origin.get('mtextFields')
        if fields is None:
            fields = field_info(source, refs[0]['sourceId'])
        is_mtext=entity.dxftype()=='MTEXT'
        raw = entity.all_columns_raw_content() if is_mtext else entity.dxf.text
        if fields is None and not any(trigger in raw for trigger in (('\\T', '\t', '^I', '%<') if is_mtext else ('%<',))):
            return entity, None
        row = self.new_record(refs, context, raw, fields)
        if source is not entity and source.dxf.handle:
            row['mtextSourceRefs'] = origin.get('sourceRefs', [{'sourceId': refs[0]['sourceId'],
                'objectKey': str(source.dxf.handle), 'path': 'DXF/MTEXT/' + str(source.dxf.handle)}])
        try:
            from . import dxf_fields
            source_facts = self.xrefs.source_facts[refs[0]['sourceId']]
            display = raw
            if fields is not None:
                if fields['status'] != 'ready':
                    raise ValueError(fields['reason'])
                roots = [obj for obj in fields['objects'] if any(root['handle'] == obj['sourceRefs'][0]['objectKey'] for root in fields['roots'])]
                if len(roots) != 1:
                    raise ValueError('mtext-field-root-count-unsupported')
                root = roots[0]
                if raw not in (root['cachedText'], root['code']):
                    raise ValueError('mtext-field-cache-source-conflict')
                objects={obj['sourceRefs'][0]['objectKey']:obj for obj in fields['objects']}
                try:
                    computed=(dxf_fields.expand(root['code'],source_facts,objects,current=root)
                              if root['evaluator']=='_text' else dxf_fields.evaluate(root['code'],source_facts,objects,current=root))
                    row['evaluatedText']=computed
                    row['cacheDiffersFromEvaluation']=root['cachedText'] is not None and root['cachedText']!=computed
                except ValueError as error:
                    if root['cachedText'] is None: raise
                    row.update(evaluationReason=str(error),dynamicEvaluationsUnsupported=1)
                    computed=None
                display=root['cachedText'] if root['cachedText'] is not None else computed
                row.update(fieldPolicy='source-cache-preferred; bounded deterministic built-ins when cache absent')
            elif re.search(r'%<[\s\S]*?>%', display):
                try: display=dxf_fields.expand(display,source_facts)
                except ValueError as error: raise ValueError('mtext-field-expression-unresolved: '+str(error)) from error
                row.update(fieldPolicy='bounded deterministic built-in evaluation',evaluatedText=display)
            if len(display) > MAX_TEXT:
                raise ValueError('mtext-text-budget')
            tokens = list(MTextParser(display)) if is_mtext else []
            factors = sorted({token.ctx.char_tracking_factor for token in tokens})
            if any(not math.isfinite(value) or value <= 0 for value in factors):
                raise ValueError('mtext-tracking-nonpositive-or-nonfinite-unsupported')
            row.update(displayText=display, trackingFactors=factors,
                tabCount=sum(token.type == TokenType.TABULATOR for token in tokens))
            copy = entity.copy()
            if is_mtext and copy.has_columns and display != raw:
                raise ValueError('mtext-field-column-cache-unsupported')
            if display != raw:
                if is_mtext: copy.text = display
                else: copy.dxf.text = display
            return copy, row
        except Exception as error:
            row['reason'] = type(error).__name__ + ': ' + str(error)
            raise

    def fail(self, item_id, reason):
        for row in self.items.values():
            if row['itemId'] == item_id:
                row.update(status='missing', reason=reason)

    def commit(self, document):
        missing = {row['itemId'] for row in self.items.values() if row['status'] != 'ready'}
        dynamic = sum(row['dynamicEvaluationsUnsupported'] for row in self.items.values())
        approximate = sum(bool(row.get('layoutWarnings')) for row in self.items.values())
        coverage = {'status': 'partial' if missing or dynamic or approximate else 'complete',
            'sourceObjects': len({row['itemId'] for row in self.items.values()}), 'mtextLayouts': len(self.items),
            'missingObjects': len(missing), 'trackingLayouts': sum(any(f != 1 for f in row.get('trackingFactors', [])) for row in self.items.values()),
            'tabLayouts': sum(row.get('tabCount', 0) > 0 for row in self.items.values()),
            'cachedFieldLayouts': sum(row.get('fieldPolicy') is not None for row in self.items.values()),
            'verticalLayouts': sum('verticalLayout' in row for row in self.items.values()),
            'approximateLayouts': approximate,
            'dynamicEvaluationsUnsupported': dynamic}
        document['extensions'][EXTENSION] = {'version': '1.2.0', 'items': self.items, 'coverage': coverage,
            'policy': 'Original source text and FIELD identity retained; source cache preferred; bounded deterministic built-ins evaluated read-only; custom/application/time-dependent evaluators are explicit'}
        return coverage
