"""Big Font containers and extended subshapes over the pinned ezdxf renderer.

SHP semantics: Autodesk Customization, Big Font / Extended Big Font descriptions.
Indexed SHX layout independently checked against truedxf's original MIT test
fonts: https://github.com/tth05/truedxf/tree/master/packages/fonts
No system font discovery or lossy character-code conversion is used.
"""
import struct
from ezdxf import path
from ezdxf.math import Matrix44
from ezdxf.fonts import shapefile
from ezdxf.fonts.glyphs import GlyphPath


def number(value):
    value = value.strip()
    return int(value, 16 if value.startswith(b'0') and len(value) > 1 else 10)


class BigFont(shapefile.ShapeFile):
    def __init__(self, records, ranges, binary):
        name, params = records.pop(0)
        if binary:
            metrics = list(params)
        else:
            metrics = [number(v) for v in params.split(b',')]
        if len(metrics) not in (4, 5) or metrics[-1] != 0:
            raise ValueError('bigfont-metrics-invalid')
        above, below, mode = metrics[:3]
        self.metrics_profile = 'declared'
        if above == 0:
            # This named legacy profile was measured against AutoCAD by truedxf
            # (019c2e5, research/notes/04-text-fonts.md §10). 64 is NOT its
            # cap height. Do not extrapolate the eight-unit cap to other headers
            # or trust the uploaded filename (which can legitimately be renamed).
            if name.strip().lower() not in (b'gbcbig', b'gbcbig.shx') or metrics != [0, 64, 2, 0]:
                raise ValueError('bigfont-legacy-height-profile-unverified')
            above, below = 8, 0
            self.metrics_profile = 'gbcbig-legacy-0-64-2'
        self.cell_width = metrics[3] if len(metrics) == 5 else above
        if above <= 0 or self.cell_width <= 0:
            raise ValueError('bigfont-cell-invalid')
        super().__init__(name, above, below, shapefile.FontMode(mode))
        self.ranges = ranges
        self.binary = binary
        self.programs = records
        # Resource budgets and shape coverage share the same contract as SHX.
        self.shapes = {n: shapefile.Symbol(n, len(data), label, data) for n, (label, data) in records.items()}

    def commands(self, shape):
        data = self.programs[shape][1]
        if not self.binary:
            # ezdxf parses the ASCII syntax, including signed displacements.
            data = self.shapes[shape].data
        index = 0
        def take(signed=False):
            nonlocal index
            value = data[index]; index += 1
            return value - 256 if self.binary and signed and value > 127 else value
        while index < len(data):
            code = take(); args = []
            if code == 0:
                if index != len(data):
                    raise ValueError('bigfont-trailing-program-data')
                yield code, args
                return
            if code in (3, 4): args = [take()]
            elif code == 7:
                sub = take()
                if sub == 0:
                    sub = (take() << 8) | take() if self.binary else take()
                    args = [0, sub, take(), take(), take(), take()]
                else: args = [sub]
            elif code == 8: args = [take(True), take(True)]
            elif code in (9, 13):
                while True:
                    x, y = take(True), take(True); args.extend([x, y])
                    if x == y == 0: break
                    if code == 13: args.append(take(True))
            elif code == 10:
                radius, octant = take(), take()
                args = [radius, -(octant & 127) if self.binary and octant & 128 else octant]
            elif code == 11:
                args = [take(), take(), take(), take(), take()]
                if self.binary and args[-1] & 128: args[-1] = -(args[-1] & 127)
            elif code == 12: args = [take(True), take(True), take(True)]
            yield code, args
        raise ValueError('bigfont-program-unterminated')

    def render_glyph(self, shape, stacked=False, primary=None):
        calls = codes = 0
        def render(n, ctx, ancestors=()):
            nonlocal calls, codes
            calls += 1
            if n in ancestors or calls > 64:
                raise ValueError('bigfont-subshape-cycle-or-limit')
            if n not in self.programs:
                if primary is None:
                    raise ValueError('bigfont-subshape-missing:' + str(n))
                def primary_codes(index):
                    nonlocal calls, codes
                    calls += 1
                    symbol = primary.shapes.get(index)
                    if symbol is None: raise ValueError('bigfont-primary-subshape-missing:' + str(index))
                    codes += len(symbol.data)
                    if calls > 64 or codes > 200000: raise ValueError('bigfont-render-code-or-call-limit')
                    return symbol.data
                ctx._get_codes = primary_codes; ctx.render(n)
                return
            skip = False
            for code, args in self.commands(n):
                codes += 1 + len(args)
                if codes > 200000:
                    raise ValueError('bigfont-render-code-limit')
                if skip: skip = False; continue
                if code == 14:
                    skip = not stacked; continue
                if code == 7:
                    if args[0] != 0:
                        render(args[0], ctx, ancestors + (n,))
                    else:
                        _, sub, x, y, width, height = args
                        child = shapefile.ShapeRenderer(path.Path(), lambda _: (), stacked=stacked)
                        render(sub, child, ancestors + (n,))
                        origin = ctx.current_location
                        matrix = Matrix44.chain(Matrix44.scale(width / self.cell_width * ctx.vector_length,
                            height / self.above * ctx.vector_length, 1),
                            Matrix44.translate(origin.x + x * ctx.vector_length, origin.y + y * ctx.vector_length, 0))
                        ctx.p.extend_multi_path(child.p.transform(matrix)); ctx.p.move_to(origin)
                    continue
                if code == 0: return
                if code == 5 and len(ctx._location_stack) >= 4:
                    raise ValueError('bigfont-position-stack-limit')
                # Delegate line/arc opcodes to ezdxf, preserving pen, scale and
                # position stack between commands. A one-command program has
                # an explicit terminator; malformed input cannot run past it.
                command = ([] if ctx.pen_down else [2]) + [code] + args + [0]
                ctx._get_codes = lambda _, command=command: command
                ctx.render(n)
        ctx = shapefile.ShapeRenderer(path.Path(), lambda _: (), stacked=stacked)
        render(shape, ctx)
        return GlyphPath(ctx.p)


def load(raw):
    if raw.startswith(b'AutoCAD-86 bigfont 1.0'):
        marker = raw.find(b'\x1a', 0, 64)
        if marker < 0: raise ValueError('bigfont-signature-invalid')
        offset = marker + 1
        word, count, nranges = struct.unpack_from('<HHH', raw, offset); offset += 6
        if word != 8 or count > 65535 or nranges > 256:
            raise ValueError('bigfont-directory-invalid')
        ranges = [struct.unpack_from('<HH', raw, offset + i*4) for i in range(nranges)]
        offset += nranges * 4
        end = offset + count * 8
        if end > len(raw): raise ValueError('bigfont-directory-truncated')
        records, spans = {}, []
        for i in range(count):
            n, length, pos = struct.unpack_from('<HHI', raw, offset + i*8)
            if n == length == pos == 0: continue
            if n in records or length < 2 or pos < end or pos + length > len(raw):
                raise ValueError('bigfont-record-invalid')
            label, separator, data = raw[pos:pos+length].partition(b'\0')
            if not separator: raise ValueError('bigfont-record-name-invalid')
            records[n] = (label, data); spans.append((pos, pos+length))
        spans.sort()
        if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
            raise ValueError('bigfont-record-overlap')
        binary = True
    else:
        lines = raw.splitlines()
        header = next((line for line in lines if line.strip().startswith(b'*BIGFONT')), None)
        if header is None: raise ValueError('bigfont-header-missing')
        values = [number(v) for v in header.strip()[8:].strip().split(b',')]
        if len(values) < 2 or len(values) != 2 + values[1]*2:
            raise ValueError('bigfont-ranges-invalid')
        ranges = list(zip(values[2::2], values[3::2]))
        filtered = b'\n'.join(line for line in lines if line != header)
        source = shapefile.shp_load(filtered)
        string_records = shapefile.parse_string_records(shapefile.merge_lines(shapefile.filter_noise(filtered.splitlines())))
        params = string_records[b'*0']
        records = {0: (params[0].split(b',', 2)[2], params[1])}
        records.update({n: (s.name, s.data) for n, s in source.shapes.items()})
        binary = False
    if 0 not in records or not ranges or any(not 0 <= low <= high <= 255 for low, high in ranges):
        raise ValueError('bigfont-definition-invalid')
    font = BigFont(records, ranges, binary)
    return font
