"""Display-only GD&T frames over ezdxf's TOLERANCE records.

Parser/layout/symbol primitives adapted from CADCraft gdt.rs at
0cf3bdea83ebbe02fb2e674b23f07de4acfa73da, Copyright (c) 2026 ArtCraft Team
and the CADCraft contributors, MIT (vendor/cadcraft-display/LICENSE-MIT).
The DXF reader, text measurement, glyph generation and WCS transforms use ezdxf.
Unlike the upstream permissive parser, unsupported formatting/unknown GDT glyphs
and budget overflow refuse the entire derivative, never truncate a callout.
"""
# MIT License
#
# Copyright (c) 2026 ArtCraft Team and the CADCraft contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import math
import re

from ezdxf.entities import factory
from ezdxf.fonts import fonts
from ezdxf.math import Matrix44, Vec3

MAX_CHARS, MAX_ROWS, MAX_CELLS = 4096, 8, 12
SYMBOL_CODES = 'jrifbagceudkhtnmlsp'


def parse_frame(text):
    if len(text) > MAX_CHARS:
        raise ValueError('tolerance-text-budget')
    # Some DXF writers escape the font backslash in group 1. Accept the same
    # explicit GDT font switch with either spelling, without unescaping content.
    text = re.sub(r'\\{2}(?=[Ff][Gg][Dd][Tt](?:\||;))', r'\\', text)
    rows, stack, gdt, i = [[[]]], [], False, 0

    def push(kind, value):
        cell = rows[-1][-1]
        if kind == 'text' and cell and cell[-1][0] == 'text':
            cell[-1] = ('text', cell[-1][1] + value)
        else:
            cell.append((kind, value))

    while i < len(text):
        c, n = text[i], text[i + 1:i + 2]
        if text[i:i + 2] in ('^J', '^j', '\\P') or c == '\n':
            if len(rows) >= MAX_ROWS:
                raise ValueError('tolerance-row-budget')
            rows.append([[]]); i += 1 if c == '\n' else 2
        elif c == '\r':
            i += 1
        elif text[i:i + 2] == '%%':
            code = text[i + 2:i + 3].lower()
            if code == 'v':
                if len(rows[-1]) >= MAX_CELLS:
                    raise ValueError('tolerance-cell-budget')
                rows[-1].append([])
            elif code in ('c', 'd', 'p', '%'):
                push('symbol' if code == 'c' else 'text', {'c': 'n', 'd': '°', 'p': '±', '%': '%'}[code])
            else:
                raise ValueError('tolerance-percent-code-unsupported:' + code)
            i += 3
        elif c == '{':
            if len(stack) >= 64:
                raise ValueError('tolerance-format-depth')
            stack.append(gdt); i += 1
        elif c == '}':
            if not stack:
                raise ValueError('tolerance-unbalanced-format')
            gdt = stack.pop(); i += 1
        elif c == '\\':
            if n in ('\\', '{', '}'):
                push('text', n); i += 2
            elif n in ('F', 'f'):
                end = text.find(';', i + 2)
                if end < 0:
                    raise ValueError('tolerance-unterminated-font')
                name = text[i + 2:end].split('|')[0].strip().lower()
                if name not in ('gdt', 'gdt.shx', 'gdt.ttf'):
                    raise ValueError('tolerance-font-switch-unsupported:' + name)
                gdt = True; i = end + 1
            elif n == '~':
                push('text', ' '); i += 2
            else:
                raise ValueError('tolerance-format-code-unsupported:' + n)
        else:
            if gdt and c not in SYMBOL_CODES:
                raise ValueError('tolerance-gdt-symbol-unsupported:' + c)
            push('symbol' if gdt else 'text', c); i += 1
    if stack:
        raise ValueError('tolerance-unbalanced-format')
    # Upstream layout omits unused compartments/rows, as in the native dialog's
    # six empty optional %%v fields. It never supplies a missing tolerance value.
    return [cells for row in rows if (cells := [cell for cell in row
            if any(kind == 'symbol' or value.strip() for kind, value in cell)])]


def symbol_primitives(code):
    """The upstream unit-box symbol geometry, without a proprietary GDT font."""
    def line(*points):
        return ('line', points)

    def circle(x=.5, y=.5, r=.5):
        return ('circle', (x, y), r)

    def arc(x, y, r, start, end):
        return ('arc', (x, y), r, start, end)

    def arrow(tip, direction):
        size = math.hypot(*direction)
        dx, dy = (v / size for v in direction)
        x, y = tip[0] - dx * .3, tip[1] - dy * .3
        return ('fill', (tip, (x - dy * .1, y + dx * .1), (x + dy * .1, y - dx * .1)))

    shapes = {
        'j': [circle(r=.3), line((0, .5), (1, .5)), line((.5, 0), (.5, 1))],
        'r': [circle(r=.45), circle(r=.25)],
        'i': [line((0, .5), (1, .5)), line((.2, .2), (.8, .2)), line((.2, .8), (.8, .8))],
        'f': [line((.1, .05), (.5, .95)), line((.5, .05), (.9, .95))],
        'b': [line((.05, .05), (.95, .05)), line((.5, .05), (.5, .95))],
        'a': [line((.95, .05), (.05, .05), (.85, .75))],
        'c': [line((0, .25), (.7, .25), (1, .75), (.3, .75), (0, .25))],
        'e': [circle(r=.45)], 'u': [line((0, .5), (1, .5))],
        'd': [arc(.5, .2, .45, 0, 180), line((.05, .2), (.95, .2))],
        'k': [arc(.5, .2, .45, 0, 180)],
        'h': [line((.2, .05), (.7, .95)), arrow((.7, .95), (.5, .9))],
        't': [line((.05, .05), (.5, .05)), line((.05, .05), (.45, .95)),
              line((.5, .05), (.9, .95)), arrow((.45, .95), (.4, .9)), arrow((.9, .95), (.4, .9))],
        'n': [circle(r=.35), line((.1, 0), (.9, 1))],
        'm': [circle(), line((.3, .25), (.3, .75), (.5, .45), (.7, .75), (.7, .25))],
        'l': [circle(), line((.38, .75), (.38, .25), (.65, .25))],
        's': [circle(), arc(.5, .625, .125, 20, 270), arc(.5, .375, .125, 200, 90)],
        'p': [circle(), line((.5, .5), (.38, .5), (.38, .75), (.5, .75)),
              arc(.5, .625, .125, -90, 90), line((.38, .5), (.38, .25))],
    }
    if code == 'g':
        dx, dy, r = math.cos(math.radians(65)), math.sin(math.radians(65)), .3
        shapes['g'] = [circle(r=r)] + [line((.5 - sign * dy * r - dx * .5, .5 + sign * dx * r - dy * .5),
                                          (.5 - sign * dy * r + dx * .5, .5 + sign * dx * r + dy * .5)) for sign in (1, -1)]
    return shapes[code]


def primitives(entity, doc):
    """Emit ezdxf LINE/ARC/CIRCLE/SOLID/TEXT for the original source frame."""
    rows = parse_frame(entity.dxf.content)
    style = doc.dimstyles.get(entity.dxf.dimstyle)
    if style is None:
        raise ValueError('tolerance-dimstyle-missing')
    text_style = doc.styles.get(style.dxf.get('dimtxsty', 'Standard') or 'Standard')
    if text_style is None:
        raise ValueError('tolerance-text-style-missing')
    scale = float(style.dxf.dimscale or doc.header.get('$DIMSCALE', 1) or 1)
    h = float(text_style.dxf.height or style.dxf.dimtxt * scale)
    gap = abs(float(style.dxf.dimgap) * scale)
    if not all(math.isfinite(v) for v in (h, gap)) or not 0 < h <= 1e12:
        raise ValueError('tolerance-invalid-text-size')
    gap = max(h * .25, min(h * 2, gap))
    font = fonts.make_font(text_style.dxf.font, h, width_factor=text_style.dxf.width)
    origin = Vec3(entity.dxf.insert)
    x = Vec3(entity.dxf.x_axis_vector).normalize()
    z = Vec3(entity.dxf.extrusion).normalize()
    if abs(x.dot(z)) > 1e-8:
        raise ValueError('tolerance-inconsistent-plane')
    y = z.cross(x).normalize()
    matrix = Matrix44.ucs(x, y, z, origin)
    previous_width = 0

    def make(kind, attributes, color):
        item = factory.new(kind, dxfattribs={'layer': entity.dxf.layer, 'color': color, **attributes}, doc=doc)
        # DIMCLRD / DIMCLRT = BYBLOCK inherits this source frame's own colour.
        # Its source identity still belongs to TOLERANCE, never these leaves.
        item.transform(matrix)
        return item

    line_color, text_color = style.dxf.dimclrd, style.dxf.dimclrt

    def line(points, color):
        for a, b in zip(points, points[1:]):
            yield make('LINE', {'start': (*a, 0), 'end': (*b, 0)}, color)

    for row_index, row in enumerate(rows):
        top, bottom, cursor = h - row_index * h * 2, -h - row_index * h * 2, 0
        mid = top - h
        for cell in row:
            widths = [h if kind == 'symbol' else font.text_width(value) for kind, value in cell]
            width = sum(widths) + .25 * h * max(0, len(cell) - 1)
            cell_width = max(2 * h, width + 2 * gap)
            yield from line([(cursor, top), (cursor, bottom)], line_color)
            content_x = cursor + (cell_width - width) / 2
            for (kind, value), run_width in zip(cell, widths):
                base_y = mid - h / 2
                if kind == 'text':
                    yield make('TEXT', {'text': value, 'height': h, 'width': text_style.dxf.width,
                               'style': text_style.dxf.name, 'oblique': text_style.dxf.oblique,
                               'insert': (content_x, base_y, 0)}, text_color)
                else:
                    def point(p):
                        return (content_x + p[0] * h, base_y + p[1] * h)
                    for shape in symbol_primitives(value):
                        if shape[0] in ('line', 'fill'):
                            points = [point(p) for p in shape[1]]
                            if shape[0] == 'line':
                                yield from line(points, text_color)
                            else:
                                yield make('SOLID', {'vtx0': (*points[0], 0), 'vtx1': (*points[1], 0),
                                           'vtx2': (*points[2], 0), 'vtx3': (*points[2], 0)}, text_color)
                        else:
                            center = point(shape[1])
                            attributes = {'center': (*center, 0), 'radius': shape[2] * h}
                            if shape[0] == 'arc':
                                attributes.update(start_angle=shape[3], end_angle=shape[4])
                            yield make('ARC' if shape[0] == 'arc' else 'CIRCLE', attributes, text_color)
                content_x += run_width + .25 * h
            cursor += cell_width
        yield from line([(cursor, top), (cursor, bottom)], line_color)
        if row_index == 0:
            yield from line([(0, top), (cursor, top)], line_color)
        elif cursor > previous_width:
            yield from line([(previous_width, top), (cursor, top)], line_color)
        yield from line([(0, bottom), (cursor, bottom)], line_color)
        previous_width = cursor
