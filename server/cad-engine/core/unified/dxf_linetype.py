"""Bounded linetype presentations using existing curves, fonts and TraceBuilder.

Source patterns stay separate from generated geometry. Variants are requested
after layer/block/viewport inheritance, then selected by both UCD projectors.
Arc dash positions use arc length, not the display polyline's chord lengths.

Fitting/complex placement rules adapted from truedxf (MIT), pinned at
019c2e504738965c17818a5780097fef0e7a52f4; see vendor/truedxf-display/NOTICE.
"""
import math
from bisect import bisect_right
from dataclasses import dataclass

from ezdxf.entities import factory
from ezdxf.math import Matrix44

from . import dxf_annotations, dxf_shx, dxf_stroke

CURVES = ('LINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'LWPOLYLINE', 'POLYLINE')


def definition(linetype):
    groups = []
    for tag in linetype.pattern_tags.tags:
        if tag.code == 49:
            groups.append({49: float(tag.value)})
        elif groups and tag.code in (74, 75, 340, 46, 50, 44, 45, 9):
            groups[-1][tag.code] = tag.value
    return groups


@dataclass
class Segment:
    start: tuple
    end: tuple
    widths: tuple = (0.0, 0.0)
    bulge: float = 0.0

    def __post_init__(self):
        self.sweep = 4 * math.atan(self.bulge)
        self.length = math.dist(self.start, self.end)
        self.center = None
        if self.bulge and self.length > 1e-12:
            dx, dy = self.end[0] - self.start[0], self.end[1] - self.start[1]
            offset = (1 - self.bulge ** 2) / (4 * self.bulge)
            self.center = ((self.start[0] + self.end[0]) / 2 - dy * offset,
                           (self.start[1] + self.end[1]) / 2 + dx * offset)
            self.radius = math.hypot(self.start[0] - self.center[0], self.start[1] - self.center[1])
            self.angle = math.atan2(self.start[1] - self.center[1], self.start[0] - self.center[0])
            self.length = self.radius * abs(self.sweep)

    def point(self, t):
        if self.center:
            angle = self.angle + self.sweep * t
            return (self.center[0] + self.radius * math.cos(angle),
                    self.center[1] + self.radius * math.sin(angle), self.start[2])
        return tuple(a + (b - a) * t for a, b in zip(self.start, self.end))

    def tangent(self, t):
        if self.center:
            angle = self.angle + self.sweep * t
            sign = 1 if self.sweep > 0 else -1
            return (-math.sin(angle) * sign, math.cos(angle) * sign)
        length = math.hypot(self.end[0] - self.start[0], self.end[1] - self.start[1])
        return ((self.end[0] - self.start[0]) / length, (self.end[1] - self.start[1]) / length) if length else (1, 0)

    def width(self, t):
        return self.widths[0] + (self.widths[1] - self.widths[0]) * t

    def measure(self, vector):
        self.metric = None
        if not self.center:
            self.length = math.sqrt(sum(v*v for v in vector(tuple(b-a for a,b in zip(self.start,self.end)))))
            return
        steps = max(16, math.ceil(abs(self.sweep)/math.tau*256))
        def speed(t):
            angle = self.angle+self.sweep*t
            v = vector((-math.sin(angle)*self.radius*self.sweep, math.cos(angle)*self.radius*self.sweep, 0))
            return math.sqrt(sum(x*x for x in v))
        self.metric = [0.0]
        for index in range(steps):
            lo, hi = index/steps, (index+1)/steps
            self.metric.append(self.metric[-1]+(hi-lo)/6*(speed(lo)+4*speed((lo+hi)/2)+speed(hi)))
        self.length = self.metric[-1]

    def parameter(self, distance):
        if not getattr(self,'metric',None): return max(0,min(1,distance/self.length))
        index = max(0,min(len(self.metric)-2,bisect_right(self.metric,distance)-1))
        fraction = (distance-self.metric[index])/(self.metric[index+1]-self.metric[index])
        return max(0,min(1,(index+fraction)/(len(self.metric)-1)))


def path_segments(entity, points, indices):
    kind = entity.dxftype()
    if kind in ('LWPOLYLINE', 'POLYLINE') and not (kind == 'POLYLINE' and entity.is_3d_polyline):
        if kind == 'LWPOLYLINE':
            elevation = float(entity.dxf.elevation)
            vertices = [(float(x), float(y), elevation) for x, y in entity.get_points('xy')]
            bulges = [float(b) for b, in entity.get_points('b')]
            closed = entity.closed
        else:
            elevation = float(entity.dxf.elevation.z)
            vertices = [(float(v.dxf.location.x), float(v.dxf.location.y), elevation) for v in entity.vertices]
            bulges = [float(v.dxf.bulge) for v in entity.vertices]
            closed = entity.is_closed
        count = len(vertices) if closed else max(0, len(vertices) - 1)
        widths = dxf_stroke.segment_widths(entity, count) or [(0, 0)] * count
        segments = [Segment(vertices[i], vertices[(i+1) % len(vertices)], tuple(widths[i]), bulges[i]) for i in range(count)]
        return segments, bool(entity.dxf.flags & 128), closed
    if kind in ('ARC', 'CIRCLE'):
        radius, center = float(entity.dxf.radius), entity.dxf.center
        start = math.radians(entity.dxf.start_angle) if kind == 'ARC' else 0
        sweep = ((math.radians(entity.dxf.end_angle) - start) % math.tau or math.tau) if kind == 'ARC' else math.tau
        count = max(1, math.ceil(sweep / (math.pi / 2)))
        vertices = [(center.x + radius * math.cos(start + sweep*i/count),
                     center.y + radius * math.sin(start + sweep*i/count), center.z) for i in range(count+1)]
        return [Segment(vertices[i], vertices[i+1], bulge=math.tan(sweep/count/4)) for i in range(count)], True, kind == 'CIRCLE'
    return [Segment(tuple(points[a]), tuple(points[b])) for a, b in indices], True, False


def symbol(group, doc, shx, refs, context):
    flags = int(group.get(74, 0))
    if flags & ~15 or flags & 6 == 6:
        raise ValueError('linetype-invalid-element-flags')
    if not flags & 6:
        return None
    style = doc.entitydb.get(str(group.get(340, '0')))
    if style is None or style.dxftype() != 'STYLE':
        raise ValueError('linetype-element-style-missing')
    size = float(group.get(46, 1))
    if not math.isfinite(size):
        raise ValueError('linetype-element-scale-invalid')
    layout = {}
    if flags & 2:
        text = factory.new('TEXT', dxfattribs={'text': str(group.get(9, '')), 'style': style.dxf.name,
            'height': (float(style.dxf.height) or 1) * (abs(size) or 1), 'width': float(style.dxf.width),
            'oblique': float(style.dxf.oblique)}, doc=doc)
        binding = shx.binding(text, refs, context)
        if not binding or binding['status'] != 'resolved':
            raise ValueError('linetype-font-unresolved:' + (binding['reason'] if binding else style.dxf.name))
        outline_font = binding['_kind'] in ('TTF', 'OTF')
        if size == 0 and outline_font: return None
        points, indices, topology, font = dxf_annotations.text_geometry(text, shx, refs, context)
        if outline_font:
            cache = binding['_glyphs']
            metrics = cache.font['OS/2']
            layout['cell'] = (shx.font(binding).text_width_ex(text.plain_text(), text.dxf.height, text.dxf.width)/2,
                (metrics.sTypoAscender+metrics.sTypoDescender)*cache.get_scaling_factor(text.dxf.height)/2)
        else:
            layout['turn'] = math.pi if size < 0 else 0
            if points:
                layout['ink'] = tuple((min(p[k] for p in points)+max(p[k] for p in points))/2 for k in (0,1))
    else:
        row = shx.row(style.dxf.font, 'shape-library', context, refs)
        shx.use(row, refs)
        if row['status'] != 'resolved':
            raise ValueError('linetype-shape-unresolved:' + row['reason'])
        number = int(group.get(75, 0))
        outline = dxf_shx.strict_shape(row['_file'], number).to_path()
        points, indices = dxf_shx.stroke_paths(outline.sub_paths(), Matrix44.scale(size, size or 1, 1), max(abs(size)*1e-3, 1e-9))
        topology, font = 'lines', shx.info(row, shapeNumber=number)
    return points, indices, topology, font, layout


def fitted_events(total, groups, lengths, period, closed, budget):
    """A-type end fitting and end-of-element anchors (truedxf note 06 §2.6.1)."""
    actual = sum(lengths)
    if period <= 0 or actual <= 1e-12 or total < period and (groups[0][49] != 0 or any(group[49] > 0 for group in groups)):
        return [('dash', 0, total)], 1
    events, scans = [], 0
    if closed:
        stretch = total / (max(2, math.floor(total/period+.5))*period)
        lengths = [v*stretch for v in lengths]
        actual = sum(lengths)
        head, end, tail, phase, dots = 0, total, 0, 0, False
    else:
        count = math.floor(total/period)
        remainder = total-count*period
        first = math.copysign(lengths[0], groups[0][49]) if groups[0][49] else 0
        raw_head = (first+remainder)/2
        head = min(total, max(0, raw_head))
        end = min(total, max(head, raw_head+count*actual-lengths[0]))
        tail = min(total, end+max(0, first+remainder))
        phase, dots = lengths[0]-raw_head, first == 0
        if dots: events.append(('dot', 0, None))
        elif head: events.append(('dash', 0, head))
    prefix = [0.0]
    for length in lengths: prefix.append(prefix[-1]+length)
    cycle = math.floor((head+phase)/actual)
    while cycle*actual-phase <= end+1e-12:
        base = cycle*actual-phase
        for index, group in enumerate(groups):
            scans += 1
            if scans > budget: raise ValueError('linetype-pattern-segment-budget')
            start, stop = base+prefix[index], base+prefix[index+1]
            if group[49] > 0 and stop > head and start < end:
                events.append(('dash', max(start,head), min(stop,end)))
            elif group[49] == 0 and head+1e-10 < start < end-1e-10:
                events.append(('dot', start, None))
            if int(group.get(74,0)) & 6 and head-1e-10 <= stop <= end+1e-10:
                events.append(('symbol', min(total,max(0,stop)), index))
        cycle += 1
    if not closed:
        if dots: events.append(('dot', tail, None))
        elif tail > end: events.append(('dash', end, tail))
    return events, scans


def display_parts(entity, groups, scale, points, indices, doc, shx, refs, context, vertex_budget, max_runs, declared_period=None, metric_matrix=None, pen=None):
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError('linetype-scale-invalid')
    lengths = [abs(float(group[49])) * scale for group in groups]
    if not lengths or any(not math.isfinite(v) for v in lengths) or sum(lengths) <= 1e-12:
        raise ValueError('linetype-pattern-zero-or-invalid-length')
    segments, continuous, closed = path_segments(entity, points, indices)
    if pen is not None:
        continuous = not (pen['adaptive'] and entity.dxftype() in ('LINE','LWPOLYLINE','POLYLINE'))
    def vector(v):
        return tuple(sum(metric_matrix[c*4+r]*v[c] for c in range(3)) for r in range(3))
    def cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
    if metric_matrix is not None:
        x,y,z=(vector(v) for v in ((1,0,0),(0,1,0),(0,0,1)))
        inverse_rows=(cross(y,z),cross(z,x),cross(x,y))
        det=sum(a*b for a,b in zip(x,inverse_rows[0]))
        if abs(det)<1e-15: raise ValueError('linetype-instance-matrix-singular')
        normal=cross(x,y);length=math.sqrt(sum(v*v for v in normal));normal=tuple(v/length for v in normal)
        def basis(angle):
            u=vector((math.cos(angle),math.sin(angle),0));length=math.sqrt(sum(v*v for v in u));u=tuple(v/length for v in u)
            v=cross(normal,u)
            return [tuple(sum(a*b for a,b in zip(row,w))/det for row in inverse_rows) for w in (u,v)]
        for segment in segments: segment.measure(vector)
    else:
        def basis(angle): return ((math.cos(angle),math.sin(angle),0),(-math.sin(angle),math.cos(angle),0))
    segments = [segment for segment in segments if segment.length > 1e-12]
    if not segments:
        raise ValueError('linetype-path-no-length')
    if pen is None and continuous and closed and entity.dxftype() in ('LWPOLYLINE', 'POLYLINE'):
        segments = segments[1:]+segments[:1]
    paths = [segments] if continuous else [[segment] for segment in segments]
    glyphs = {}
    batches, fonts, vertices, runs = {}, [], 0, 0

    def append(positions, elements, topology, role):
        nonlocal vertices
        vertices += len(positions)
        if vertices > vertex_budget:
            raise ValueError('linetype-document-vertex-budget')
        if not elements: return
        target_points, target_indices = batches.setdefault((topology, role), ([], []))
        offset = len(target_points)
        target_points.extend(positions)
        target_indices.extend(tuple(i + offset for i in element) for element in elements)

    def measures(path):
        offsets = [0.0]
        for segment in path: offsets.append(offsets[-1] + segment.length)
        return offsets

    def locate(path, offsets, distance):
        index = min(len(path)-1, bisect_right(offsets, distance)-1)
        segment = path[index]
        return segment, segment.parameter(distance-offsets[index])

    def band(path, offsets, start, end, close=False):
        sliced, center_points, center_lines = [], [], []
        first = max(0, bisect_right(offsets, start)-1)
        last = min(len(path), bisect_right(offsets, end))
        for index in range(first, last):
            segment, distance = path[index], offsets[index]
            lo, hi = max(0, start-distance), min(segment.length, end-distance)
            if hi > lo + 1e-12:
                a, b = segment.parameter(lo), segment.parameter(hi)
                position = segment.point(a)
                sliced.append((*position[:2], segment.width(a), segment.width(b), math.tan(segment.sweep*(b-a)/4)))
                endpoint = segment.point(b)
                steps = max(1, math.ceil(abs(segment.sweep*(b-a))/math.tau*72))
                count = len(center_points)
                center_points.extend(list(segment.point(a+(b-a)*step/steps)) for step in range(steps+1))
                center_lines.extend((count+step, count+step+1) for step in range(steps))
        if not sliced: return
        if not any(max(vertex[2:4]) for vertex in sliced):
            append(center_points, center_lines, 'lines', 'stroke')
            return
        virtual = factory.new('LWPOLYLINE', dxfattribs={'elevation': endpoint[2]}, doc=doc)
        virtual.set_points(sliced if close else sliced + [(*endpoint[:2], 0, 0, 0)], format='xyseb')
        virtual.closed = close
        for p, i, topology in dxf_stroke.display_parts(virtual, 72, vertex_budget-vertices):
            append(p, i, topology, 'stroke')

    for path in paths:
        offsets = measures(path)
        total = offsets[-1]
        period=sum(lengths) if declared_period is None else declared_period*scale
        if pen is None:
            events,scanned=fitted_events(total,groups,lengths,period,continuous and closed,max_runs-runs)
        else:
            from .dxf_plotstyles import pen_events
            events,scanned=pen_events(total,groups,lengths,period,continuous and closed,max_runs-runs,
                adaptive=pen['adaptive'] and entity.dxftype() in ('LINE','LWPOLYLINE','POLYLINE'))
        runs += scanned
        strokes = []
        for kind, start, end in sorted((event for event in events if event[0]=='dash'), key=lambda event:event[1]):
            if strokes and start <= strokes[-1][1]+1e-10:
                strokes[-1] = (strokes[-1][0], max(end,strokes[-1][1]))
            else: strokes.append((start,end))
        for kind, distance, element in events:
            if kind=='dash': continue
            segment, t = locate(path, offsets, distance)
            origin, tangent = segment.point(t), segment.tangent(t)
            if kind=='dot':
                width = segment.width(t)
                if width > 0:
                    ring = [[origin[0]+math.cos(a*math.tau/24)*width/2,
                             origin[1]+math.sin(a*math.tau/24)*width/2, origin[2]] for a in range(24)]
                    append([list(origin)] + ring, [(0, i+1, (i+1)%24+1) for i in range(24)], 'triangles', 'stroke')
                else: append([list(origin)], [(0,)], 'points', 'stroke')
                continue
            group = groups[element]
            if element not in glyphs: glyphs[element] = symbol(group, doc, shx, refs, context)
            glyph = glyphs[element]
            if glyph is None: continue
            p, i, topology, font, layout = glyph
            flags = int(group.get(74,0))
            direction = math.atan2(tangent[1],tangent[0])
            rotation = math.radians(float(group.get(50,0)))
            angle = rotation + (0 if flags & 1 else direction)
            flipped = bool(flags & 8 and not flags & 1 and tangent[0] < -1e-9)
            if flipped: angle += math.pi
            dx, dy = float(group.get(44,0))*scale, float(group.get(45,0))*scale
            direction_u,direction_v=basis(direction)
            origin = [origin[k]+direction_u[k]*dx+direction_v[k]*dy for k in range(3)]
            if flags & 8:
                if 'cell' in layout:
                    px, py = (v*scale for v in layout['cell'])
                    u,v=basis(angle)
                    origin=[origin[k]+(direction_u[k]-u[k])*px+(direction_v[k]-v[k])*py for k in range(3)]
                else:
                    if flipped:
                        before = max((b for a,b in strokes if b <= distance+1e-10), default=0)
                        after = min((a for a,b in strokes if a >= distance-1e-10), default=total)
                        middle, fraction = locate(path, offsets, (before+after)/2)
                        center = middle.point(fraction)
                        origin[:2] = [2*center[k]-origin[k] for k in (0,1)]
                    if rotation and 'ink' in layout:
                        px, py = (v*scale for v in layout['ink'])
                        base = angle-rotation
                        bu,bv=basis(base);u,v=basis(angle)
                        origin=[origin[k]+(bu[k]-u[k])*px+(bv[k]-v[k])*py for k in range(3)]
            angle += layout.get('turn',0)
            u,v=basis(angle)
            append([[origin[k]+(x*u[k]+y*v[k])*scale for k in range(3)] for x,y,z in p],i,topology,'symbol')
            if font not in fonts: fonts.append(font)
        if continuous and closed and len(strokes)>1 and strokes[0][0]==0 and abs(strokes[-1][1]-total)<1e-10:
            # Join a dash spanning the closing vertex instead of capping its
            # two halves separately; TraceBuilder owns the corner mitre.
            lo, hi = strokes[-1][0], total+strokes[0][1]
            doubled = path+path
            band(doubled, measures(doubled), lo, hi)
            strokes = strokes[1:-1]
        for lo, hi in strokes:
            band(path, offsets, lo, hi, continuous and closed and lo==0 and hi==total)
    return [(p, i, topology, role) for (topology, role), (p, i) in batches.items()], fonts, runs
