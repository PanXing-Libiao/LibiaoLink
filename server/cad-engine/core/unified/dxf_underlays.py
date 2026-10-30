"""Bounded, upload-only 2D underlay readers; raster derivatives share media placement.

Only the small parser APIs are reused. Their optional application/rendering stacks
are not imported. Unknown graphical records and parser truncation are failures,
never a successful rendering of the supported prefix.
"""
from collections import Counter
from dataclasses import replace
import io
import math
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET

MAX_BYTES = 16 * 1024 * 1024
MAX_RECORDS = 100_000
MAX_POINTS = 1_000_000
MAX_SVG_BYTES = 32 * 1024 * 1024


def sheet_bounds(sheet):
    if sheet.paper_bounds is not None:return sheet.paper_bounds
    bounds=sheet.entities.bbox()
    points=[value.point for item in sheet.entities for value in item.colored_points]
    if points:
        if bounds:points.extend([type(points[0])(bounds[0],bounds[1]),type(points[0])(bounds[2],bounds[3])])
        bounds=(min(p.x for p in points),min(p.y for p in points),max(p.x for p in points),max(p.y for p in points))
    return bounds


def vertex_colors(sheet,max_pixels):
    """The community SVG preview averages Gouraud colors. Preserve the source
    vertex colors with SVG line gradients and bounded triangle RGBA textures.
    """
    from ezdwf.document import (EntityQuery, Image, Point2D, GradientBrush, GradientStop)
    import numpy as np
    bounds=sheet_bounds(sheet)
    if bounds is None:raise ValueError('underlay-dwf-source-bounds-missing')
    span=max(bounds[2]-bounds[0],bounds[3]-bounds[1])
    if span<=0: return sheet
    scale=2048/span;result=[];pixels=0
    for item in sheet.entities:
        if item.kind not in ('GOURAUD_POLYLINE','GOURAUD_POLYTRIANGLE'):
            result.append(item);continue
        colors=item.colored_points
        count=2 if item.kind=='GOURAUD_POLYLINE' else 3
        if len(colors)<count:raise ValueError('underlay-dwf-gouraud-vertices-missing')
        offset=0
        for i in range(len(colors)-count+1):
            values=colors[i:i+count]
            if count==2:
                a,b=values
                gradient=GradientBrush('linear_gradient',a.point,b.point,None,None,None,None,
                    'Pad','Absolute',tuple(GradientStop(v.color,'#%02x%02x%02x%02x'%v.color,position) for v,position in zip(values,(0.,1.))),1.)
                style=replace(item.style,stroke_brush=gradient,stroke_dash_offset=item.style.stroke_dash_offset+offset)
                result.append(replace(item,kind='LINE',points=(a.point,b.point),style=style,colored_points=()))
                offset+=math.hypot(b.point.x-a.point.x,b.point.y-a.point.y)
                continue
            x0=min(v.point.x for v in values);x1=max(v.point.x for v in values)
            y0=min(v.point.y for v in values);y1=max(v.point.y for v in values)
            a,b,c=[v.point for v in values]
            determinant=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y)
            if determinant==0:continue  # a source degenerate triangle paints no area
            w,h=max(1,math.ceil((x1-x0)*scale)),max(1,math.ceil((y1-y0)*scale))
            pixels+=w*h
            if w*h>max_pixels or pixels>max_pixels*4:raise ValueError('underlay-dwf-gouraud-pixel-budget')
            x=x0+(np.arange(w)+.5)*(x1-x0)/w;y=y1-(np.arange(h)+.5)*(y1-y0)/h
            x,y=np.meshgrid(x,y)
            u=((b.y-c.y)*(x-c.x)+(c.x-b.x)*(y-c.y))/determinant
            v=((c.y-a.y)*(x-c.x)+(a.x-c.x)*(y-c.y))/determinant;t=1-u-v
            rgba=np.clip(np.rint(u[:,:,None]*values[0].color+v[:,:,None]*values[1].color+t[:,:,None]*values[2].color),0,255).astype(np.uint8)
            rgba[:,:,3][(u<0)|(v<0)|(t<0)]=0
            # W2D image samples are top-to-bottom, like the SVG/image and media contracts.
            image=Image('rgba',i,w,h,Point2D(x0,y0),Point2D(x1,y1),(),rgba.tobytes())
            result.append(replace(item,kind='IMAGE',points=(),colored_points=(),image=image))
    return replace(sheet,entities=EntityQuery(result))


def raster(svg, bounds, max_pixels, fonts=None):
    from PIL import Image
    import resvg_py
    if len(svg.encode()) > MAX_SVG_BYTES or '<!DOCTYPE' in svg.upper() or '<!ENTITY' in svg.upper():
        raise ValueError('underlay-svg-size-or-declaration')
    root = ET.fromstring(svg)
    count = 0
    # This SVG is generated from parser data, not executed source markup. Keep
    # resvg independent of the host filesystem/network and installed fonts.
    for node in root.iter():
        count += 1
        if count > MAX_RECORDS * 4:
            raise ValueError('underlay-svg-node-limit')
        kind=node.tag.rsplit('}', 1)[-1]
        if kind in ('script', 'foreignObject') or kind=='text' and node.text and not fonts:
            raise ValueError('underlay-unresolved-text-or-active-svg')
        if node.attrib.get('data-preview') in ('unsupported-raster-placeholder','unsupported-brush','vertex-color-average'):
            raise ValueError('underlay-incomplete-community-preview:'+node.attrib['data-preview'])
        for key, value in node.attrib.items():
            if key.rsplit('}', 1)[-1] in ('href', 'src') and not value.startswith(('#', 'data:image/png;base64,', 'data:image/jpeg;base64,')):
                raise ValueError('underlay-svg-external-resource')
            if 'url(' in value and not value.lstrip().startswith('url(#'):
                raise ValueError('underlay-svg-external-paint')
    x0, y0, x1, y1 = bounds
    width, height = x1 - x0, y1 - y0
    if not all(math.isfinite(v) for v in bounds) or width <= 0 or height <= 0:
        raise ValueError('underlay-source-bounds-invalid')
    scale = min(2048 / max(width, height), math.sqrt((max_pixels - 8192) / (width * height)))
    w, h = max(1, math.ceil(width * scale)), max(1, math.ceil(height * scale))
    with tempfile.TemporaryDirectory(prefix='cad-underlay-fonts-') as folder:
        files=[]
        for index,(name,raw) in enumerate(fonts or []):
            filename=Path(folder)/(str(index)+Path(name).suffix.lower());filename.write_bytes(raw);files.append(str(filename))
        png = resvg_py.svg_to_bytes(svg_string=svg, width=w, height=h, skip_system_fonts=True, font_files=files)
    with Image.open(io.BytesIO(png)) as image:
        if image.width * image.height > max_pixels:
            raise ValueError('underlay-raster-pixel-limit')
        return image.convert('RGBA')


def dwf(raw, name, max_pixels, font_resolver=None):
    import ezdwf
    from ezdwf.document import UnsupportedBrush, VisualBrush, ImageBrush
    limits = ezdwf.ParseLimits(max_file_size=MAX_BYTES, max_archive_entries=1024,
        max_entry_size=32*1024*1024, max_total_uncompressed_size=64*1024*1024,
        max_compression_ratio=1000, max_xml_size=16*1024*1024, max_xml_depth=64,
        max_w2d_records=MAX_RECORDS, max_w2d_points_per_entity=100_000,
        max_w2d_total_points=MAX_POINTS, max_w2d_entities=MAX_RECORDS,
        max_w2d_string_size=1024*1024, max_w2d_nesting_depth=64,
        max_w2d_decompressed_size=64*1024*1024, max_w2d_compression_depth=4,
        max_xps_visuals=MAX_RECORDS, max_xps_path_segments=MAX_POINTS)
    doc = ezdwf.read(raw, limits=limits)
    if doc.diagnostics:
        raise ValueError('underlay-dwf-diagnostics: ' + '; '.join(str(item) for item in doc.diagnostics)[:2048])
    sheet = doc.sheet(name)
    if not sheet.entities:
        raise ValueError('underlay-dwf-empty-sheet')
    kinds = {'LINE', 'POLYMARKER', 'POLYLINE', 'POLYGON', 'POLYBEZIER', 'PATH',
        'CIRCLE', 'ARC', 'ELLIPSE', 'POLYTRIANGLE', 'CONTOUR_SET',
        'GOURAUD_POLYLINE', 'GOURAUD_POLYTRIANGLE', 'IMAGE', 'TEXT'}
    fonts={};text_bounds=[]
    def check_image(data,columns=None,rows=None):
        from PIL import Image
        if columns is not None and (min(columns,rows)<=0 or columns*rows>max_pixels):
            raise ValueError('underlay-dwf-image-pixel-budget')
        if data.startswith((b'\x89PNG',b'\xff\xd8',b'II*\0',b'MM\0*')):
            with Image.open(io.BytesIO(data)) as image:
                if image.width*image.height>max_pixels:raise ValueError('underlay-dwf-image-pixel-budget')
    def check_brush(brush):
        if isinstance(brush, UnsupportedBrush):
            raise ValueError('underlay-dwf-brush-unsupported: ' + brush.brush_type)
        if isinstance(brush, VisualBrush):
            for item in brush.entities: check(item)
        if isinstance(brush, ImageBrush):check_image(brush.data,brush.pixel_width,brush.pixel_height)
    def check(item):
        if not item.style.visible: return
        if item.kind not in kinds:
            raise ValueError('underlay-dwf-entity-unsupported: ' + item.kind)
        if item.kind == 'TEXT' and item.text and not item.glyph_outline:
            if font_resolver is None:
                raise ValueError('underlay-dwf-source-font-outline-missing: ' + str(item.style.font_name))
            filename,font,bounds=font_resolver(item)
            fonts[filename]=font
            if bounds is not None:text_bounds.append(bounds)
        if item.style.color is None and item.style.color_index is not None:
            raise ValueError('underlay-dwf-source-palette-missing')
        if item.image is not None:check_image(item.image.data,item.image.columns,item.image.rows)
        for brush in (item.style.fill_brush, item.style.stroke_brush, *item.opacity_masks): check_brush(brush)
        for group in item.compositing_groups: check_brush(group.opacity_mask)
    for item in sheet.entities: check(item)
    bounds = sheet_bounds(sheet)
    if sheet.paper_bounds is None and text_bounds:
        if bounds is not None:text_bounds.append(bounds)
        bounds=(min(b[0] for b in text_bounds),min(b[1] for b in text_bounds),
            max(b[2] for b in text_bounds),max(b[3] for b in text_bounds))
    if bounds is None: raise ValueError('underlay-dwf-source-bounds-missing')
    x0, y0, x1, y1 = bounds
    # Match the generator's explicit degenerate one-dimensional page expansion.
    if x1 == x0: x0 -= .5; x1 += .5
    if y1 == y0: y0 -= .5; y1 += .5
    bounds = (x0, y0, x1, y1)
    # No implicit clipping to the old point-only TEXT bbox from the reader.
    rendered_sheet=vertex_colors(replace(sheet,paper_bounds=bounds),max_pixels)
    svg = ezdwf.render_svg(rendered_sheet, background='transparent', precision=12, curve_segments=256)
    image = raster(svg, bounds, max_pixels, list(fonts.items()))
    return image, {'reader': 'ezdwf 0.0.9 / resvg-py 0.5.0', 'sheetName': sheet.name,
        'sourceUnits': sheet.units, 'sourceBounds': list(bounds),
        'sourceEntityTypes': dict(Counter(e.kind for e in sheet.entities)),
        'coordinatePolicy': 'normalized source sheet paper coordinates; embedded outlines or exact uploaded outline fonts',
        'uploadedFonts':list(fonts),
        'displayOnly': True}


def dgn(raw, name, max_pixels):
    import ezdgn
    from ezdxf.math import BSpline, open_uniform_knot_vector
    info = ezdgn.detect_format(raw)
    if info.kind != 'V7' or info.dimension != 2:
        raise ValueError('underlay-dgn-requires-v7-2d: ' + str(info))
    if name.casefold() not in ('default', 'model'):
        raise ValueError('underlay-dgn-model-not-found: ' + name)
    doc = ezdgn.read(raw, max_file_size=MAX_BYTES, max_records=MAX_RECORDS, max_record_size=1024*1024)
    if doc.repaired_containers:
        raise ValueError('underlay-dgn-repaired-container-unverified')
    paths, point_count = [], 0
    def add(points, style, closed=False):
        nonlocal point_count
        if not points: raise ValueError('underlay-dgn-empty-geometry')
        if style is None or style.rgb is None: raise ValueError('underlay-dgn-source-color-missing')
        if style.line_style != 0: raise ValueError('underlay-dgn-custom-line-style-unresolved: ' + str(style.line_style))
        points = [tuple(p[:2]) for p in points]
        if any(not math.isfinite(c) for p in points for c in p): raise ValueError('underlay-dgn-nonfinite-geometry')
        point_count += len(points)
        if point_count > MAX_POINTS: raise ValueError('underlay-dgn-point-limit')
        paths.append((points, style, closed))
    def visit(item):
        kind = item.kind
        if item.record.deleted: return
        if kind == 'UNSUPPORTED':
            # Defined non-graphical V7 control records: TCB, digitizer setup,
            # level symbology, application data. Unknown record types fail.
            if item.record.element_type in (8, 9, 10, 66): return
            raise ValueError('underlay-dgn-record-unsupported: ' + str(item.record.element_type))
        if kind == 'COLOR_TABLE': return
        if kind in ('CELL', 'COMPLEX_CHAIN', 'TEXT_NODE'):
            for child in doc.children(item): visit(child)
        elif kind == 'LINE': add([item.start_master, item.end_master], item.style)
        elif kind in ('LINE_STRING', 'SHAPE'):
            add(item.vertices_master, item.style, kind == 'SHAPE')
        elif kind in ('ELLIPSE', 'ARC'):
            center = item.center_master
            if center is None or item.primary_axis_master is None or item.secondary_axis_master is None:
                raise ValueError('underlay-dgn-source-units-missing')
            a, b = item.primary_axis_master, item.secondary_axis_master
            if min(a, b) <= 0: raise ValueError('underlay-dgn-degenerate-ellipse')
            rotation = math.radians(item.rotation_degrees)
            start = math.radians(item.start_angle_degrees) if kind == 'ARC' else 0
            sweep = math.radians(item.sweep_angle_degrees) if kind == 'ARC' else 2*math.pi
            count = max(8, math.ceil(abs(sweep) / (2*math.pi) * 512))
            points=[]
            for i in range(count + 1):
                t = start + sweep*i/count; x, y = a*math.cos(t), b*math.sin(t)
                points.append((center[0]+x*math.cos(rotation)-y*math.sin(rotation),
                               center[1]+x*math.sin(rotation)+y*math.cos(rotation)))
            add(points, item.style, kind == 'ELLIPSE')
        elif kind == 'BSPLINE_CURVE':
            children = doc.children(item)
            if any(c.kind not in ('BSPLINE_POLE','BSPLINE_KNOT','BSPLINE_WEIGHT') for c in children):
                raise ValueError('underlay-dgn-spline-child-unsupported')
            poles = [p for c in children if c.kind=='BSPLINE_POLE' for p in c.vertices_master]
            knots = [v for c in children if c.kind=='BSPLINE_KNOT' for v in c.values]
            weights = [v for c in children if c.kind=='BSPLINE_WEIGHT' for v in c.values]
            if len(poles)!=item.num_poles or not 2<=item.order<=16 or item.is_closed:
                raise ValueError('underlay-dgn-spline-definition-unresolved')
            if knots and len(knots)!=len(poles)+item.order:
                raise ValueError('underlay-dgn-spline-knots-unresolved')
            if not knots and item.num_knots: raise ValueError('underlay-dgn-spline-knots-missing')
            if item.is_rational and len(weights)!=len(poles): raise ValueError('underlay-dgn-spline-weights-missing')
            curve = BSpline(poles, order=item.order,
                knots=knots or open_uniform_knot_vector(len(poles), item.order), weights=weights or None)
            if item.curve_display:
                add([tuple(p) for p in curve.approximate(512)], item.style)
            if item.polygon_display: add(poles, item.style)
        else:
            # TEXT requires the actual RSC font ID mapping, CURVE is not a
            # polyline, shared cells require definition-instance transforms.
            raise ValueError('underlay-dgn-entity-unsupported: ' + kind)
    for item in doc.root_elements: visit(item)
    if not paths: raise ValueError('underlay-dgn-empty-model')
    all_points = [p for points, _, _ in paths for p in points]
    x0, y0 = min(p[0] for p in all_points), min(p[1] for p in all_points)
    x1, y1 = max(p[0] for p in all_points), max(p[1] for p in all_points)
    if x1 == x0: x0 -= .5; x1 += .5
    if y1 == y0: y0 -= .5; y1 += .5
    width, height = x1-x0, y1-y0
    svg = ET.Element('svg', xmlns='http://www.w3.org/2000/svg', viewBox=f'0 0 {width} {height}', width=str(width), height=str(height))
    for points, style, closed in paths:
        rgb = '#%02x%02x%02x' % style.rgb
        fill = '#%02x%02x%02x' % style.fill_rgb if closed and style.fill_rgb is not None else 'none'
        ET.SubElement(svg, 'polygon' if closed else 'polyline', points=' '.join(f'{x-x0},{y1-y}' for x,y in points),
            stroke=rgb, fill=fill, **{'stroke-width':str(max(width,height)/2048*(1+style.line_weight)), 'stroke-linejoin':'round'})
    image = raster(ET.tostring(svg, encoding='unicode'), (x0,y0,x1,y1), max_pixels)
    return image, {'reader':'ezdgn 0.3.0 / resvg-py 0.5.0', 'modelName':'default',
        'sourceUnits':doc.design_settings.master_unit_name, 'sourceBounds':[x0,y0,x1,y1],
        'sourceEntityTypes':dict(Counter(e.kind for e in doc.all_entities)),
        'displayOnly':True, 'strokeFidelity':'screen approximation; original DGN line weights retained in source',
        'coordinatePolicy':'original master-unit coordinates; no control-polygon replacement for native curves'}
