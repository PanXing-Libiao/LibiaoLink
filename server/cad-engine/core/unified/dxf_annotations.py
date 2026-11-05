"""Display-only 2D presentations, primarily from the vendored ezdxf renderers.

LEADER uses render/leader.py, MULTILEADER uses its parameter renderer (never a
cached proxy picture), DIMENSION uses render() only if its source block is absent,
and MTEXT uses MTextExplode. Source records/handles are never replaced or saved.
Text is converted by ezdxf.text2path using the SAME font as the layout engine;
the browser receives glyph geometry, avoiding a second, inconsistent font layout.
Missing fonts can still be substituted by ezdxf; resolved font names are recorded.
MLINE, ACAD_TABLE and WIPEOUT use their library primitives/source display blocks;
GD&T delegates to the separately attributed MIT layout adaptation.
"""
import math
import logging
import re

from .dxf_mtext import Renderer as MTextExplode
from ezdxf.addons import text2path
from ezdxf.fonts import fonts
from ezdxf.layouts import VirtualLayout
from ezdxf import path
from ezdxf.math import Vec3, Matrix44

MAX_PARTS = 20000
MAX_VERTICES = 1000000
MAX_DEPTH = 16
MAX_TEXT_CHARACTERS = 100000


def primitives(entity, doc, shx=None, source_refs=None, resource_context=None, mtext=None):
    """Yield (leaf, INSERT ancestors), refusing incomplete recursive expansion."""
    count = 0

    class RendererWarnings(logging.Handler):
        def __init__(self):
            super().__init__(logging.WARNING)
            self.messages = []

        def emit(self, record):
            # A missing style/block/arrow in the parameter renderer otherwise
            # silently substitutes Standard or omits content. Font substitution is
            # separately recorded, so font-manager messages are not this failure.
            if '/render/' in record.pathname.replace('\\', '/') and len(self.messages) < 16:
                self.messages.append(record.getMessage())

    def walk(item, chain=(), blocks=(), prepared_text=False):
        nonlocal count
        count += 1
        if count > MAX_PARTS or len(chain) > MAX_DEPTH:
            raise ValueError('annotation-presentation-budget')
        kind = item.dxftype()
        if kind == 'INSERT':
            name = item.dxf.name
            if name in blocks or doc.blocks.get(name) is None:
                raise ValueError('annotation-block-cycle-or-missing:' + name)
            skipped = []
            placements = item.multi_insert() if item.mcount > 1 else [item]
            for placement in placements:
                definition = doc.blocks.get(name)
                if any(attdef.is_const for attdef in definition.attdefs()):
                    raise ValueError('annotation-constant-block-attribute-unsupported')
                children = list(placement.virtual_entities(
                    skipped_entity_callback=lambda child, reason: skipped.append(reason), redraw_order=True))
                if skipped or not (children or placement.attribs):
                    raise ValueError('annotation-block-incomplete:' + name)
                # Same WCS rule as ezdxf.disassemble.recursive_decompose():
                # virtual_entities() excludes ATTDEF and does not yield ATTRIB.
                for attrib in placement.attribs:
                    if not attrib.is_invisible:
                        child = attrib.virtual_mtext_entity() if attrib.has_embedded_mtext_entity else attrib
                        yield from walk(child, chain + (placement,), blocks + (name,))
                for child in children:
                    yield from walk(child, chain + (placement,), blocks + (name,))
        elif kind == 'MTEXT':
            if len(item.text) > MAX_TEXT_CHARACTERS:
                raise ValueError('annotation-text-budget')
            target = VirtualLayout()
            record = None
            if mtext:
                item, record = mtext.prepare(item, source_refs, resource_context)
            renderer = shx.mtext_renderer(target, item, source_refs, resource_context) if shx else MTextExplode(target, doc)
            renderer.explode(item, destroy=False)
            renderer.finalize()
            if record is not None:
                record.update(status='ready', reason='ezdxf 排版及源字段缓存静态显示')
            if mtext and hasattr(renderer, 'vertical_layout'):
                mtext.record_layout(item, source_refs, resource_context, record, renderer.vertical_layout)
            for child in target:
                child.doc = doc
                yield from walk(child, chain, blocks, prepared_text=True)
        elif kind in ('TEXT','ATTRIB','ATTDEF') and mtext and not prepared_text:
            item, record=mtext.prepare(item,source_refs,resource_context)
            if record is not None: record.update(status='ready',reason='原字段缓存或确定性内置字段只读显示')
            yield item,chain
        else:
            yield item, chain

    warnings = RendererWarnings()
    logger = logging.getLogger('ezdxf')
    logger.addHandler(warnings)
    try:
        kind = entity.dxftype()
        if kind == 'DIMENSION':
            if entity.is_dimensional_constraint:
                raise ValueError('dimension-constraint-without-presentation')
            entity.render()  # In-memory derived block only; caller keeps source identity.
            children = entity.virtual_entities()
        elif kind == 'REGION':
            from . import dxf_region
            children = dxf_region.primitives(entity)
        elif kind == 'MULTILEADER':
            from ezdxf.render.mleader import virtual_entities
            children = virtual_entities(entity, proxy_graphic=False)
        elif kind == 'LEADER':
            children = entity.virtual_entities()
        elif kind == 'ACAD_PROXY_ENTITY':
            from . import dxf_proxy
            children = dxf_proxy.primitives(entity, doc, MAX_PARTS, source_refs, resource_context)
        elif kind in ('MTEXT', 'TEXT', 'ATTRIB', 'ATTDEF', 'SHAPE'):
            children = [entity]
        elif kind == 'MLINE':
            if entity.style is None:
                raise ValueError('mline-style-missing')
            children = entity.virtual_entities()
        elif kind == 'ACAD_TABLE':
            block = doc.blocks.get(entity.get_block_name())
            if block is None:
                raise ValueError('table-presentation-block-missing')
            # ACAD_TABLE's header group 11 is distinct from repeated cell
            # directions. Read that source header, then transform the saved
            # block ourselves: the upstream method performs translation only.
            direction,normal=Vec3(1,0,0),Vec3(0,0,1)
            for subclass in entity.xtags.subclasses:
                name=subclass[0].value if subclass and subclass[0].code==100 else ''
                if name=='AcDbTable':
                    direction=Vec3(next((tag.value for tag in subclass if tag.code==11),(1,0,0)))
                if name in ('AcDbBlockReference','AcDbTable'):
                    normal=Vec3(next((tag.value for tag in subclass if tag.code==210),normal))
            if direction.magnitude<1e-12 or normal.magnitude<1e-12:
                raise ValueError('table-presentation-degenerate-pose')
            x,z=direction.normalize(),normal.normalize()
            if abs(x.dot(z))>1e-8: raise ValueError('table-presentation-nonorthogonal-pose')
            matrix=Matrix44.chain(Matrix44.translate(*(-block.block.dxf.base_point)),
                Matrix44.ucs(x,z.cross(x),z),Matrix44.translate(*entity.dxf.insert))
            children=[]
            for source in block.entities_in_redraw_order():
                child=source.copy()
                child.transform(matrix)
                children.append(child)
        elif kind == 'WIPEOUT':
            children = [entity]
        elif kind == 'TOLERANCE':
            from . import dxf_tolerance
            children = dxf_tolerance.primitives(entity, doc)
        elif getattr(entity,'proxy_graphic',None):
            from . import dxf_proxy
            children=dxf_proxy.primitives(entity,doc,MAX_PARTS,source_refs,resource_context)
        else:
            raise ValueError('annotation-renderer-unsupported:' + kind)
        for child in children:
            yield from walk(child)
        if warnings.messages:
            raise ValueError('annotation-renderer-warning:' + '; '.join(warnings.messages))
    finally:
        logger.removeHandler(warnings)


def text_traits(entity):
    from ezdxf.tools.text import caret_decode,plain_text
    from ezdxf.lldxf.validator import fix_one_line_text
    traits=dict(getattr(entity,'_cad_proxy_text',{}) or {})
    if traits.get('raw'):return entity.dxf.text,traits
    raw=fix_one_line_text(caret_decode(entity.dxf.text))
    active={};decorations=[];offset=0
    for fragment in re.split(r'(%%[kou])',raw,flags=re.IGNORECASE):
        if re.fullmatch(r'%%[kou]',fragment,re.IGNORECASE):
            kind={'k':'strike','o':'overline','u':'underline'}[fragment[-1].lower()]
            if kind in active:decorations.append((kind,active.pop(kind),offset))
            else:active[kind]=offset
        else:offset+=len(plain_text(fragment))
    decorations.extend((kind,start,offset) for kind,start in active.items())
    if decorations:traits['decorations']=decorations
    return entity.plain_text(),traits


def tracked_outline(font,text,height,traits,binding):
    """Tracking changes pen advances; glyph outlines keep their original shape."""
    if not traits or traits.get('tracking',1)==1 and not (traits.get('underline') or traits.get('overline') or traits.get('decorations')):
        return font.text_path_ex(text,cap_height=height).to_path()
    from .dxf_mtext import text_origins
    cache=getattr(font,'uploaded_cache',None)
    tokens=list(cache.tokens(text)) if hasattr(cache,'tokens') else list(text)
    factor=traits.get('tracking',1)
    result=path.Path();vertical=bool(binding and binding.get('_vertical') and hasattr(cache,'glyph'))
    if vertical:
        x=y=0.;origins=[]
        for char in tokens:
            origins.append((x,y))
            advance=Vec3(0,-cache.font_measurements.cap_height,0) if char.isspace() else cache.glyph(char).end
            x+=advance.x*cache.get_scaling_factor(height)*factor
            y+=advance.y*cache.get_scaling_factor(height)*factor
        length=abs(y)
    else:
        offsets,length=text_origins(font,tokens,factor)
        origins=[(offset*height,0) for offset in offsets];length*=height
    for char,(x,y) in zip(tokens,origins):
        result.extend_multi_path(font.text_path_ex(char,cap_height=height).to_path().transform(Matrix44.translate(x,y,0)))
    # Same baseline offsets as the pinned MTEXT renderer. These are display
    # strokes, not source font outlines or engineering measurements.
    decorations=list(traits.get('decorations',[]))+[(kind,0,len(tokens)) for kind in ('underline','overline') if traits.get(kind)]
    for kind,start,end in decorations:
        if start==end:continue
        offset={'underline':-.2,'strike':.5,'overline':1.2}[kind]*height
        if end>len(tokens):raise ValueError('text-decoration-token-offset-unsupported')
        start_at=origins[start][1 if vertical else 0]
        end_at=origins[end][1 if vertical else 0] if end<len(origins) else -length if vertical else length
        if vertical:
            a,b=(offset,start_at),(offset,end_at)
        else: a,b=(start_at,offset),(end_at,offset)
        if font.font_render_type==fonts.FontRenderType.STROKE:
            line=path.Path(a);line.line_to(b)
        else:
            thick=.025*height
            points=[(a[0]-thick,a[1]),(a[0]+thick,a[1]),(b[0]+thick,b[1]),(b[0]-thick,b[1])] if vertical else [
                (a[0],a[1]-thick),(b[0],b[1]-thick),(b[0],b[1]+thick),(a[0],a[1]+thick)]
            line=path.Path(points[0])
            for point in points[1:]:line.line_to(point)
            line.close()
        result.extend_multi_path(line)
    return result


def text_geometry(entity, shx=None, source_refs=None, parent_context=None):
    """Return filled/stroked glyphs, font provenance and ezdxf's text transform.

    Bézier sagitta <= 0.001 * cap height, minimum 2 segments per curve. These
    display triangles are not source CAD curves or engineering measurements.
    Triangulate before applying the TEXT WCS matrix so mirrored/tilted text and
    holes keep the same layout as MTextExplode, including width and obliqueness.
    """
    text,traits=text_traits(entity)
    if len(text) > MAX_TEXT_CHARACTERS:
        raise ValueError('annotation-text-budget')
    binding = shx.binding(entity, source_refs, parent_context) if shx else None
    matrix = entity.wcs_transformation_matrix()
    if binding and binding['status'] == 'resolved':
        font = shx.font(binding)
        outline = tracked_outline(font,text,entity.dxf.height,traits,binding)
        if binding.get('_vertical'):
            from .dxf_vertical import text_matrix
            matrix = text_matrix(entity, font, outline)
        elif text.strip():
            bounds = path.bbox([outline], fast=True)
            alignment = text2path.alignment_transformation(
                font.measurements.scale_from_baseline(entity.dxf.height), bounds,
                entity.get_align_enum(), entity.fit_length())
            outline = outline.transform(alignment)
        paths = list(outline.sub_paths())
        provenance = shx.info(binding)
    else:
        face = fonts.get_font_face(binding['requestedPath'] if binding else entity.font_name())
        resolved = fonts.font_manager.find_font_name(face)
        font = fonts.make_font(resolved, cap_height=1.0)
        paths = text2path.make_paths_from_str(
            text, face, size=entity.dxf.height, align=entity.get_align_enum(),
            length=entity.fit_length())
        provenance = {'requested': binding['requestedPath'] if binding else entity.font_name(),
            'resolved': resolved, 'fontKind': type(font).__name__,
            'status': 'substituted' if binding else 'system-font'}
        if binding:
            provenance['referenceId'] = binding['id']
            if parent_context and parent_context.get('itemId'):
                shx.fallback(parent_context['itemId'], source_refs, binding)
    tolerance = max(abs(entity.dxf.height) * 1e-3, 1e-9)
    points, indices, vertices = [], [], {}
    def vertex(point):
        key = tuple(point)
        if key not in vertices:
            vertices[key] = len(points)
            points.append(list(point))
        return vertices[key]
    filled = font.font_render_type != fonts.FontRenderType.STROKE
    if filled:
        for triangle in path.triangulate(paths, max_sagitta=tolerance, min_segments=2):
            indices.append(tuple(vertex(matrix.transform((v.x, v.y, 0))) for v in triangle))
            if len(points) > MAX_VERTICES:
                raise ValueError('annotation-glyph-budget')
    else:
        for outline in paths:
            vertices = list(outline.flattening(tolerance, segments=2))
            first = len(points)
            points.extend(list(matrix.transform(v)) for v in vertices)
            indices.extend((first + i, first + i + 1) for i in range(len(vertices) - 1))
            if len(points) > MAX_VERTICES:
                raise ValueError('annotation-glyph-budget')
    if text.strip() and not points:
        raise ValueError('annotation-glyph-output-empty')
    if any(not math.isfinite(v) for point in points for v in point):
        raise ValueError('annotation-glyph-nonfinite')
    return points, indices, 'triangles' if filled else 'lines', provenance
