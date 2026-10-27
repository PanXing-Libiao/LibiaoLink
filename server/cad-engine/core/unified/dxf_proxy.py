"""Checked, display-only use of ezdxf's existing proxy graphics decoder.

The upstream decoder deliberately skips unknown commands. A document preview
must account for every graphical command before publishing a complete picture.
"""
import struct
import hashlib
import math

from ezdxf.proxygraphic import ProxyGraphic, ProxyGraphicTypes
from ezdxf.tools.binarydata import ByteStream
from ezdxf.math import Matrix44, Vec3


class CheckedProxyGraphic(ProxyGraphic):
    def __init__(self, data, doc, refs, context):
        super().__init__(data, doc)
        self.source_refs, self.context = refs, context
        self.font_styles = {}
        tables = (context or {}).get('proxyTables')
        if tables:
            self.layers, self.linetypes = tables['layers'], tables['linetypes']
            self.encoding = tables['encoding']
        self.name_maps = (tables or {}).get('nameMaps',{})
        self.clips=[]
        self.plot_style=None
        self.ignored_3d_commands=set()
        self.plot_names=(tables or {}).get('plotStyles',list(doc.plotstyles.keys()))

    def push_clip(self,data):
        # ODA spec 5.4.1 §29, PUSH_CLIP 27; ObjectARX ClipBoundary's
        # to-clip and inverse compound transforms define model -> clip space.
        from .dxf_clipping import polygon,MAX_CLIP_VERTICES
        if len(data)<336: raise ValueError('proxy-clip-truncated')
        normal=Vec3(struct.unpack_from('<3d',data));origin=Vec3(struct.unpack_from('<3d',data,24))
        count,=struct.unpack_from('<L',data,48)
        if not 2<=count<=MAX_CLIP_VERTICES: raise ValueError('proxy-clip-point-budget')
        offset=52+count*16
        if len(data)!=offset+284: raise ValueError('proxy-clip-length-mismatch')
        points=[struct.unpack_from('<2d',data,52+i*16) for i in range(count)]
        to_clip=Matrix44(struct.unpack_from('<16d',data,offset));to_clip.transpose()
        inverse_block=Matrix44(struct.unpack_from('<16d',data,offset+128));inverse_block.transpose()
        front,back,front_z,back_z,draw=struct.unpack_from('<2L2dL',data,offset+256)
        if front or back: raise ValueError('proxy-clip-depth-planes-outside-2d')
        if draw not in (0,1) or not all(math.isfinite(v) for v in [*normal,*origin,*to_clip,*inverse_block,front_z,back_z]):
            raise ValueError('proxy-clip-nonfinite-or-invalid-flags')
        if abs(normal.x)>1e-9 or abs(normal.y)>1e-9 or abs(normal.z)<1e-9:
            raise ValueError('proxy-clip-non-top-plane-outside-2d')
        to_clip.inverse();inverse_block.inverse()
        matrix=to_clip*inverse_block
        if count==2:
            (x,y),(a,b)=points;points=[(x,y),(a,y),(a,b),(x,b)]
        boundary=polygon([matrix.transform((x,y,0)) for x,y in points])
        self.clips.append({'boundary':boundary,'inverted':False})
        if len(self.clips)>16: raise ValueError('proxy-clip-stack-budget')
        if draw:
            from ezdxf.entities import factory
            leaf=factory.new('LWPOLYLINE',dxfattribs={**self._build_dxf_attribs(),'flags':1})
            leaf.set_points(boundary);leaf._cad_proxy_world=True
            return leaf

    def pop_clip(self,data):
        if data or not self.clips: raise ValueError('proxy-clip-stack-underflow-or-payload')
        self.clips.pop()

    def attribute_plot_style_name(self,data):
        mode,index=struct.unpack('<2L',data)
        if mode not in range(4) or mode==3 and index>=len(self.plot_names): raise ValueError('proxy-plot-style-index-invalid')
        self.plot_style={'plotStyleMode':mode,'plotStyleName':self.plot_names[index] if mode==3 else None}

    def unknown_37(self,data):
        if data: raise ValueError('proxy-command-37-payload-unknown')

    def attribute_material(self,data):
        if not data or len(data)!=(data[0]&15)+1: raise ValueError('proxy-material-handle-invalid')
        self.ignored_3d_commands.add(34)

    def attribute_mapper(self,data):
        struct.unpack('<7L',data)
        self.ignored_3d_commands.add(35)

    def unsafe_virtual_entities(self):
        # Keep upstream primitive decoding, add the independently scoped clip
        # stack to each derivative before later text/fill/pattern processing.
        offset=8
        while offset<len(self._buffer):
            size,code=struct.unpack_from('<2L',self._buffer,offset)
            name=ProxyGraphicTypes(code).name.lower();method=getattr(self,name,None)
            result=method(self._buffer[offset+8:offset+size]) if method else None
            for entity in result if isinstance(result,tuple) else [result] if result else []:
                if self.matrices and not getattr(entity,'_cad_proxy_world',False): entity.transform(self.matrices[-1])
                entity._cad_clip_regions=[dict(clip) for clip in self.clips]
                if self.plot_style: entity._cad_plot_style=dict(self.plot_style)
                yield entity
            if result: self.fill=False
            offset+=size
        if self.clips: raise ValueError('proxy-clip-stack-unclosed')

    def push_matrix(self, data):
        values = struct.unpack('<16d', data)
        if not all(math.isfinite(value) for value in values):
            raise ValueError('proxy-matrix-nonfinite')
        matrix = Matrix44(values); matrix.transpose()
        if self.matrices:
            matrix *= self.matrices[-1]
        self.matrices.append(matrix)

    push_matrix2 = push_matrix

    def unused_15(self, data):
        name = ByteStream(data).read_padded_string(self.encoding)
        self.layer = self.name_maps.get('layers',{}).get(name,name)
        if not self._doc.layers.has_entry(self.layer): raise ValueError('proxy-layer-name-missing:'+name)

    def unused_17(self, data):
        name = ByteStream(data).read_padded_string(self.encoding)
        self.linetype = self.name_maps.get('linetypes',{}).get(name,name)
        if not self._doc.linetypes.has_entry(self.linetype): raise ValueError('proxy-linetype-name-missing:'+name)

    def attribute_layer(self, data):
        index, = struct.unpack('<L',data)
        if index >= len(self.layers): raise ValueError('proxy-layer-index-out-of-range')
        self.layer = self.layers[index]

    def _filled_polygon(self,vertices,attribs):
        hatch=super()._filled_polygon(vertices,attribs)
        # The proxy FILL trait specifies a solid area. HATCH factory defaults
        # are not a source pattern definition and must not leak into it.
        hatch.dxf.solid_fill=1;hatch.dxf.pattern_name='SOLID';hatch.pattern=None;hatch.gradient=None
        return hatch

    def _get_style(self, font, bigfont):
        vertical=getattr(self,'_text_vertical',False)
        variant=getattr(self,'_text_variant',None)
        key = (font, bigfont, vertical, variant)
        self.required_fonts.add(font)
        if key in self.font_styles:
            name = self.font_styles[key]
        else:
            matches = [style for style in self._doc.styles if
                style.dxf.font.casefold() == font.casefold() and style.dxf.bigfont.casefold() == bigfont.casefold()
                and bool(style.dxf.flags&4)==vertical and variant is None]
            if matches:
                name = matches[0].dxf.name
            else:
                name = '_proxy_font_' + hashlib.sha256(repr(key).encode()).hexdigest()[:16]
                while self._doc.styles.has_entry(name): name += '_'
                self._doc.styles.new(name, dxfattribs={'font': font, 'bigfont': bigfont,'flags':4 if vertical else 0})
            self.font_styles[key] = name
        if self.context is not None and name not in self.context['sourceTextStyleNames']:
            # This style belongs to the proxy derivative, not to the original
            # DXF STYLE table. Its font request points to the actual source proxy.
            self.context.setdefault('virtualFontStyles', {})[name] = {
                'font': font, 'bigfont': bigfont, 'flags': 4 if vertical else 0, 'sourceRefs': self.source_refs,
                **({'variant':variant} if variant is not None else {})}
        return name

    def _text(self, data, unicode=False):
        stream = ByteStream(data)
        stream.read_struct('<12d')
        if unicode: stream.read_padded_unicode_string()
        else: stream.read_padded_string(self.encoding)
        return super()._text(data, unicode)

    def check_text2(self, data, unicode):
        # Upstream catches UnicodeDecodeError and continues with empty text or a
        # substitute font. Decode every source string strictly before delegation.
        stream = ByteStream(data)
        stream.read_struct('<9d')
        read = stream.read_padded_unicode_string if unicode else lambda: stream.read_padded_string(self.encoding)
        read()
        length,raw,height,width,oblique,tracking,backwards,upside,vertical,underline,overline=stream.read_struct('<2l4d5L')
        if raw not in (0,1) or any(flag not in (0,1) for flag in (backwards,upside,vertical,underline,overline)):
            raise ValueError('proxy-text-flags-invalid')
        if not all(math.isfinite(v) for v in (height,width,oblique,tracking)) or min(height,width,tracking)<=0:
            raise ValueError('proxy-text-metrics-invalid')
        self._text_vertical=bool(vertical);self._text_variant=None
        if unicode:
            bold,italic,charset,pitch=stream.read_struct('<4L')
            if bold not in (0,1) or italic not in (0,1): raise ValueError('proxy-text-face-flags-invalid')
            face=read()
            self._text_variant=(bool(bold),bool(italic))
        read(); read()
        return {'raw':raw==0,'tracking':tracking/100,'underline':bool(underline),'overline':bool(overline)}

    def text2(self, data):
        traits=self.check_text2(data, False)
        item=super().text2(data);item._cad_proxy_text=traits
        self._text_vertical=False;self._text_variant=None
        return item

    def unicode_text2(self, data):
        traits=self.check_text2(data, True)
        item=super().unicode_text2(data);item._cad_proxy_text=traits
        self._text_vertical=False;self._text_variant=None
        return item


def primitives(entity, doc, max_commands=20000, refs=None, context=None):
    data = entity.proxy_graphic
    if not data:
        raise ValueError('proxy-graphics-not-stored')
    if len(data) < 8:
        raise ValueError('proxy-graphics-truncated-header')
    decoder = CheckedProxyGraphic(data, doc, refs, context)
    # Initial traits come from the actual custom object, before stream changes.
    decoder.color=entity.dxf.color;decoder.true_color=entity.dxf.get('true_color')
    decoder.layer=entity.dxf.layer;decoder.linetype=entity.dxf.linetype
    decoder.lineweight=entity.dxf.lineweight;decoder.ltscale=entity.dxf.ltscale
    offset, count, depth = 8, 0, 0
    # EXTENTS is descriptive metadata, not drawing content. Marker IDs are
    # handled by ezdxf. Every other command must have a real decoder method.
    while offset < len(data):
        count += 1
        if count > max_commands:
            raise ValueError('proxy-graphics-command-budget')
        if offset + 8 > len(data):
            raise ValueError('proxy-graphics-truncated-command')
        size, code = struct.unpack_from('<2L', data, offset)
        if size < 8 or offset + size > len(data):
            raise ValueError('proxy-graphics-invalid-command-length')
        try:
            name = ProxyGraphicTypes(code).name.lower()
        except ValueError as error:
            raise ValueError('proxy-graphics-unknown-command:' + str(code)) from error
        if name != 'extents' and not callable(getattr(decoder, name, None)):
            raise ValueError('proxy-graphics-undecoded-command:' + name)
        if name in ('push_matrix','push_matrix2'):
            depth += 1
            if depth > 16:
                raise ValueError('proxy-graphics-matrix-depth')
        elif name == 'pop_matrix':
            depth -= 1
            if depth < 0:
                raise ValueError('proxy-graphics-matrix-underflow')
        offset += size
    if depth:
        raise ValueError('proxy-graphics-unclosed-matrix')
    yield from decoder.virtual_entities()
    entity._cad_proxy_ignored_3d=sorted(decoder.ignored_3d_commands)
