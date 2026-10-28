"""Uploaded rasters/underlays and OLE caches; bounded display derivatives."""
import hashlib
import io
import math
import warnings
from importlib.metadata import version
from contextlib import closing

from ezdxf.math import Matrix44
from ezdxf import units

from .adapter import identity
from .dxf_xref import match_file

EXTENSION = 'org.cad-preview.dxf-media/1'
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 8 * 1024 * 1024
MAX_DOCUMENT_PIXELS = 32 * 1024 * 1024
MAX_PDF_PAGES = 1000
PDF_RENDER_SCALE = 2.0
MAX_PDF_SIDE = 4096
VERSIONS = {'Pillow': '13.0.0', 'pypdfium2': '5.14.0', 'pypdf': '6.21.2', 'olefile':'0.47',
    'ezdgn':'0.3.0', 'ezdwf':'0.0.9', 'resvg-py':'0.5.0'}


def finite(values):
    if any(not math.isfinite(float(value)) for value in values):
        raise ValueError('media-nonfinite-placement')


def size_limit(size):
    w, h = size
    if w < 1 or h < 1 or w * h > MAX_PIXELS:
        raise ValueError('media-pixel-limit')


class Resources:
    def __init__(self, doc, xrefs, files, fonts=None):
        self.doc, self.xrefs, self.files = doc, xrefs, dict(files or {})
        self.references, self.items, self.payloads = {}, {}, {}
        self.pixels = 0
        self.fonts=fonts

    def context(self, entity, refs):
        origin = self.xrefs.origins.get(str(entity.dxf.handle), {})
        definition = origin.get('mediaDefinition')
        if definition is None:
            obj = entity.image_def if entity.dxftype() == 'IMAGE' else entity.get_underlay_def()
            if obj is None:
                raise ValueError('media-definition-missing')
            definition = {'filename': obj.dxf.filename, 'sourceUnits': self.doc.units,
                'name': obj.dxf.get('name', '') if entity.dxftype() != 'IMAGE' else '',
                'sourceRefs': [{'sourceId': refs[0]['sourceId'], 'objectKey': str(obj.dxf.handle),
                                'path': 'DXF/' + obj.dxftype() + '/' + str(obj.dxf.handle)}]}
        return {**definition, 'chain': origin.get('chain', []),
                'ownerPath': origin.get('logicalSourcePath', self.xrefs.name)}

    def reference(self, context, refs, kind):
        key = identity('media-reference', [context['sourceRefs'], context['chain'], context['filename'], kind])
        if key not in self.references:
            row = {'id': key, 'ownerSourceId': refs[0]['sourceId'], 'kind': kind,
                'requestedPath': context['filename'], 'sourceRefs': context['sourceRefs'],
                'usedSourceRefs': [], 'chain': context['chain'], 'status': 'missing', 'required': True,
                'reason': '图片/底图配套文件未提供'}
            logical, method, candidates = match_file(context['filename'], context['ownerPath'], self.files)
            row['match'] = method
            if logical is None:
                if candidates:
                    row.update(status='ambiguous', reason='配套文件重名，请用文件夹保留相对目录', candidates=candidates)
            else:
                raw = self.files[logical]
                sha = hashlib.sha256(raw).hexdigest()
                row.update(logicalPath=logical, sha256=sha, byteLength=len(raw),
                           resourceId=identity('resource', ['source-media', sha]), status='resolved',
                           reason='已收集原配套字节；逐对象显示状态另行记录', _raw=raw)
                if len(raw) > MAX_FILE_BYTES:
                    row.update(status='blocked', reason='media-file-byte-limit')
            self.references[key] = row
        row = self.references[key]
        for ref in refs:
            if ref not in row['usedSourceRefs']:
                row['usedSourceRefs'].append(ref)
        return row

    def read_image(self, raw):
        from PIL import Image
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in ('PNG', 'JPEG', 'BMP', 'GIF', 'TIFF', 'WEBP'):
                    raise ValueError('media-image-format-unsupported')
                size_limit(image.size)
                if getattr(image, 'n_frames', 1) != 1:
                    raise ValueError('media-multiframe-image-unsupported')
                # Same raw pixel orientation as ezdxf drawing.Frontend; EXIF is
                # preserved in the source bytes, never applied a second time.
                return image.convert('RGBA'), {'format': image.format, 'pixelSize': list(image.size)}

    def read_pdf(self, raw, number):
        import pypdf
        import pypdfium2 as pdfium
        if not raw.startswith(b'%PDF-'):
            raise ValueError('media-pdf-signature-invalid')
        if not number.isascii() or not number.isdecimal() or int(number) < 1:
            raise ValueError('media-pdf-page-name-unsupported: ' + number)
        reader = pypdf.PdfReader(io.BytesIO(raw), strict=True)
        if reader.is_encrypted:
            raise ValueError('media-pdf-encrypted-unsupported')
        count = len(reader.pages)
        if count > MAX_PDF_PAGES:
            raise ValueError('media-pdf-page-limit')
        index = int(number) - 1
        if index >= count:
            raise ValueError('media-pdf-page-missing: ' + number)
        page = reader.pages[index]
        root = reader.trailer['/Root']
        if root.get('/AcroForm') or root.get('/OCProperties') or page.get('/Annots'):
            raise ValueError('media-pdf-forms-annotations-or-layers-unsupported')
        unit = float(page.user_unit)
        if not math.isfinite(unit) or unit <= 0:
            raise ValueError('media-pdf-user-unit-invalid')
        with pdfium.PdfDocument(raw) as pdf:
            with closing(pdf[index]) as pdf_page:
                width, height = pdf_page.get_size()
                finite((width, height))
                if width <= 0 or height <= 0:
                    raise ValueError('media-pdf-page-size-invalid')
                scale = min(PDF_RENDER_SCALE, MAX_PDF_SIDE / max(width, height),
                            math.sqrt((MAX_PIXELS - 8192) / (width * height)))
                size_limit((math.ceil(width * scale), math.ceil(height * scale)))
                bitmap = pdf_page.render(scale=scale, fill_color=(0, 0, 0, 0),
                    draw_annots=False, may_draw_forms=False)
                try:
                    image = bitmap.to_pil().convert('RGBA')
                finally:
                    bitmap.close()
                details = {'pageNumber': index + 1, 'pageCount': count, 'pageSizePoints': [width, height],
                    'userUnit': unit, 'cropBox': list(page.cropbox), 'pageRotation': page.rotation,
                    'pixelSize': list(image.size), 'renderScale': scale,
                    'renderer': 'pypdfium2 ' + str(pdfium.PYPDFIUM_INFO) + ' / PDFium ' + str(pdfium.PDFIUM_INFO)}
        return image, details

    def image_display(self, entity, raw):
        from ezdxf.addons.drawing.backend import ImageData
        from ezdxf.addons.drawing.pipeline import _mask_image
        from ezdxf.npshapes import NumpyPoints2d
        import numpy as np
        from PIL import Image, ImageEnhance
        if any(not 0<=value<=100 for value in (entity.dxf.brightness,entity.dxf.contrast,entity.dxf.fade)):
            raise ValueError('media-image-adjustments-out-of-range')
        image, details = self.read_image(raw)
        if tuple(list(entity.dxf.image_size)[:2]) != tuple(image.size):
            raise ValueError('media-image-size-mismatch')
        # Same explicitly approximate display policy as pinned ezdxf Frontend;
        # preserve the source alpha while changing RGB against white paper.
        alpha=image.getchannel('A')
        if entity.dxf.contrast!=50: image=ImageEnhance.Contrast(image).enhance(entity.dxf.contrast/50)
        if entity.dxf.fade: image=Image.blend(image,Image.new('RGBA',image.size,(255,255,255,255)),entity.dxf.fade/100)
        if entity.dxf.brightness!=50:
            amount=entity.dxf.brightness/50-1
            target=(255,255,255,255) if amount>0 else (0,0,0,255)
            image=Image.blend(image,Image.new('RGBA',image.size,target),abs(amount))
        image.putalpha(alpha)
        if not entity.dxf.flags & entity.USE_TRANSPARENCY:
            image.putalpha(255)
        data = ImageData(image=np.array(image), transform=entity.get_wcs_transform(),
            pixel_boundary_path=NumpyPoints2d(entity.pixel_boundary_path()),
            use_clipping_boundary=bool(entity.dxf.flags & entity.USE_CLIPPING_BOUNDARY),
            remove_outside=entity.dxf.clip_mode == 0)
        if data.use_clipping_boundary:
            _mask_image(data, [])
            from PIL import Image
            image = Image.fromarray(data.image)
        matrix = data.flip_matrix() * data.transform
        # UCD numbers are JSON floats; ezdxf matrices expose numpy.float64,
        # which the schema validator intentionally rejects.
        matrix = [float(value) for value in matrix]
        return image, matrix, {**details, 'on': bool(entity.dxf.flags & entity.SHOW_IMAGE),
            'displayAdjustments':{'brightness':entity.dxf.brightness,'contrast':entity.dxf.contrast,
                'fade':entity.dxf.fade,'fidelity':'ezdxf Frontend screen approximation; original settings retained'},
            'clipBoundary': [list(p) for p in entity.pixel_boundary_path()],
            'clipping': data.use_clipping_boundary, 'removeOutside': data.remove_outside,
            'placementMethod': 'ezdxf ImageData.flip_matrix * Image.get_wcs_transform'}

    def pdf_display(self, entity, row, context):
        image, details = self.read_pdf(row['_raw'], str(context['name']))
        width, height = details['pageSizePoints']
        source_units = context['sourceUnits']
        if source_units == 0:
            physical_w, physical_h = 1.0, height / width
            policy = 'unitless source: scale defines page width, per PDFATTACH'
        else:
            factor = units.conversion_factor(units.IN, source_units) * details['userUnit'] / 72
            physical_w, physical_h = width * factor, height * factor
            policy = 'PDF points * UserUnit / 72 inch converted to original source CAD units'
        image = self.underlay_pixels(image, entity, (0, 0, physical_w, physical_h))
        matrix = self.underlay_matrix(entity, image, physical_w, physical_h)
        return image, matrix, {**details, 'on': entity.on, 'sourceUnits': source_units,
            'pageSizeInSourceUnits': [physical_w, physical_h], 'unitPolicy': policy,
            'clipping': bool(entity.dxf.flags & 1), 'displayAdjustments': self.underlay_adjustments(entity),
            'displayOnly': True, 'placementMethod': 'PDF physical page, source scale/rotation and OCS insert/extrusion'}

    @staticmethod
    def underlay_adjustments(entity):
        return {'contrast': entity.dxf.contrast, 'fade': entity.dxf.fade,
            'monochrome': bool(entity.dxf.flags & 4), 'background': 'white',
            'fidelity': 'HLS fit to pinned truedxf AutoCAD plot probes; screen raster derivative'}

    def underlay_pixels(self, image, entity, bounds):
        import numpy as np
        from PIL import Image, ImageDraw
        if entity.dxf.flags & ~31:
            raise ValueError('media-underlay-display-flags-unsupported')
        if not 0 <= entity.dxf.contrast <= 100 or not 0 <= entity.dxf.fade <= 100:
            raise ValueError('media-underlay-display-adjustments-invalid')
        if entity.dxf.contrast != 100 or entity.dxf.fade or entity.dxf.flags & 4:
            # Vectorized colorsys HLS formulas. Alpha is never faded to opaque.
            rgba = np.asarray(image).copy(); rgb = rgba[:,:,:3].astype(np.float64)/255
            hi, lo = rgb.max(axis=2), rgb.min(axis=2); delta = hi-lo
            light = (hi+lo)/2; saturation = np.zeros_like(light)
            np.divide(delta, np.where(light<=.5, hi+lo, 2-hi-lo), out=saturation, where=delta!=0)
            hue = np.zeros_like(light)
            for channel, offset in ((0,0),(1,2),(2,4)):
                mask = (hi==rgb[:,:,channel]) & (delta!=0)
                quotient = np.zeros_like(light)
                np.divide(rgb[:,:,(channel+1)%3]-rgb[:,:,(channel+2)%3],delta,out=quotient,where=delta!=0)
                hue[mask] = ((quotient[mask]+offset)/6)%1
            light = np.clip(.3+(light-.3)*entity.dxf.contrast/100,0,1)
            fade = entity.dxf.fade/100
            faded = rgb+(1-rgb)*fade; fh,fl=faded.max(axis=2),faded.min(axis=2)
            if fade:
                np.divide(fh-fl,np.where(fh+fl<=1,fh+fl,2-fh-fl),out=saturation,where=fh!=fl)
                saturation[fh==fl]=0
            if entity.dxf.flags & 4: saturation.fill(0)
            light += (1-light)*fade
            m2 = np.where(light<=.5,light*(1+saturation),light+saturation-light*saturation);m1=2*light-m2
            for channel, offset in ((0,1/3),(1,0),(2,-1/3)):
                h=(hue+offset)%1
                component=np.where(h<1/6,m1+(m2-m1)*h*6,np.where(h<.5,m2,np.where(h<2/3,m1+(m2-m1)*(2/3-h)*6,m1)))
                rgba[:,:,channel]=np.clip(np.rint(component*255),0,255).astype(np.uint8)
            image=Image.fromarray(rgba)
        if entity.dxf.flags & 1:
            from .dxf_clipping import polygon
            boundary = [tuple(p[:2]) for p in entity.boundary_path]
            if len(boundary)==2:
                (x0,y0),(x1,y1)=boundary;boundary=[(x0,y0),(x1,y0),(x1,y1),(x0,y1)]
            boundary=polygon(boundary)
            x0,y0,x1,y1=bounds
            pixels=[((x-x0)/(x1-x0)*image.width,(y1-y)/(y1-y0)*image.height) for x,y in boundary]
            mask=Image.new('L',image.size,0);ImageDraw.Draw(mask).polygon(pixels,fill=255)
            alpha=np.asarray(image.getchannel('A')).astype(np.uint16)*np.asarray(mask).astype(np.uint16)//255
            image.putalpha(Image.fromarray(alpha.astype(np.uint8)))
        return image

    @staticmethod
    def underlay_matrix(entity, image, physical_w, physical_h, offset=(0,0)):
        ocs = entity.ocs()
        matrix = Matrix44.chain(
            Matrix44.scale(physical_w / image.width, -physical_h / image.height, 1),
            Matrix44.translate(offset[0], offset[1]+physical_h, 0),
            Matrix44.scale(*entity.scaling), Matrix44.z_rotate(math.radians(entity.dxf.rotation)),
            Matrix44.ucs(ocs.ux, ocs.uy, ocs.uz), Matrix44.translate(*ocs.to_wcs(entity.dxf.insert)))
        return matrix

    def cad_underlay_display(self, entity, row, context, refs):
        from . import dxf_underlays
        reader = dxf_underlays.dwf if entity.dxftype()=='DWFUNDERLAY' else dxf_underlays.dgn
        def font_resolver(item):
            if self.fonts is None: raise ValueError('underlay-font-resolver-unavailable')
            name=item.style.font_name or item.style.font_canonical_name
            if not name: raise ValueError('underlay-font-name-missing')
            font_context={**self.fonts.context(entity,refs),'logicalSourcePath':row['logicalPath']}
            font=self.fonts.row(name,'font',font_context,refs,(bool(item.style.font_bold),bool(item.style.font_italic)))
            self.fonts.use(font,refs)
            if font['status']!='resolved':raise ValueError('underlay-font-unresolved: '+font['reason'])
            if font.get('_kind') not in ('TTF','OTF'):raise ValueError('underlay-font-requires-outline-face')
            for char in item.text:
                if not char.isspace() and ord(char) not in font['_glyphs'].cmap:
                    raise ValueError('underlay-font-glyph-missing: U+%04X'%ord(char))
            if not item.style.font_height or len(item.text)>100000 or not item.points:
                raise ValueError('underlay-font-text-metrics-or-budget')
            from ezdxf import path
            face=self.fonts.font(font)
            height=item.style.font_height*font['_glyphs'].font_measurements.cap_height/font['_glyphs'].font['head'].unitsPerEm
            outline=face.text_path_ex(item.text,cap_height=height).to_path()
            outline=outline.transform(Matrix44.chain(Matrix44.z_rotate(math.radians(item.style.font_rotation_degrees or 0)),
                Matrix44.translate(item.points[0].x,item.points[0].y,0)))
            box=path.bbox([outline],fast=False)
            bounds=(box.extmin.x,box.extmin.y,box.extmax.x,box.extmax.y) if box.has_data else None
            return font['logicalPath'],self.files[font['logicalPath']],bounds
        image, details = (reader(row['_raw'],str(context['name']),MAX_PIXELS,font_resolver)
            if entity.dxftype()=='DWFUNDERLAY' else reader(row['_raw'],str(context['name']),MAX_PIXELS))
        x0,y0,x1,y1 = details['sourceBounds']; width,height=x1-x0,y1-y0
        source_unit = str(details['sourceUnits'] or '').lower()
        inch = {'in':1,'inch':1,'inches':1,'mm':1/25.4,'millimeters':1/25.4,
            'cm':1/2.54,'centimeters':1/2.54,'m':1000/25.4,'meters':1000/25.4,
            'ft':12,'feet':12,'dip':1/96}.get(source_unit)
        if context['sourceUnits']==0 or inch is None:
            # AutoCAD's documented attach rule for unitless/no-resolution
            # underlays. Preserve the original units and page extents as facts.
            factor=1/width; offset=(0,0); policy='unitless/no source resolution: scale defines page width'
        else:
            factor=inch*units.conversion_factor(units.IN,context['sourceUnits'])
            offset=(x0*factor,y0*factor) if entity.dxftype()=='DGNUNDERLAY' else (0,0)
            policy='source physical unit converted to original DXF units before saved placement'
        display_bounds=(offset[0],offset[1],offset[0]+width*factor,offset[1]+height*factor)
        image=self.underlay_pixels(image,entity,display_bounds)
        return image,self.underlay_matrix(entity,image,width*factor,height*factor,offset),{
            **details,'on':entity.on,'clipping':bool(entity.dxf.flags&1),'unitPolicy':policy,
            'displayAdjustments':self.underlay_adjustments(entity), 'pageSizeInSourceUnits':[width*factor,height*factor],
            'placementMethod':'source sheet/model bounds, saved scale/rotation and OCS insert/extrusion'}

    def map(self, entity, item_id, refs):
        record = {'sourceKind': entity.dxftype(), 'sourceRefs': refs, 'status': 'missing',
            'sourceProperties': {key: list(value) if hasattr(value, 'xyz') else value
                for key, value in entity.dxf.all_existing_dxf_attribs().items()}}
        self.items[item_id] = record
        try:
            kind=entity.dxftype()
            packages={'IMAGE':('Pillow',),'PDFUNDERLAY':('Pillow','pypdfium2','pypdf'),
                'OLE2FRAME':('Pillow','olefile'),'DGNUNDERLAY':('Pillow','ezdgn','resvg-py'),
                'DWFUNDERLAY':('Pillow','ezdwf','resvg-py')}[kind]
            for package in packages:
                if version(package) != VERSIONS[package]:
                    raise ValueError('media-runtime-version-mismatch: ' + package)
            if kind=='OLE2FRAME':
                from . import dxf_ole
                image,matrix,details=dxf_ole.read(entity,MAX_PIXELS)
                record['embeddedSource']=True
            else:
                record['sourceBoundary'] = [list(point) for point in entity.boundary_path]
                context = self.context(entity, refs)
                row = self.reference(context, refs, kind)
                record.update(referenceId=row['id'], definitionSourceRefs=context['sourceRefs'], chain=context['chain'])
                if row['status'] != 'resolved':
                    raise ValueError('media-' + row['status'] + ': ' + row['reason'])
                if kind=='IMAGE': image,matrix,details=self.image_display(entity,row['_raw'])
                elif kind=='PDFUNDERLAY': image,matrix,details=self.pdf_display(entity,row,context)
                else: image,matrix,details=self.cad_underlay_display(entity,row,context,refs)
            values = list(matrix)
            finite(values)
            if abs(values[0] * values[5] - values[1] * values[4]) < 1e-20:
                raise ValueError('media-edge-on-or-degenerate-plane-unsupported')
            encoded = io.BytesIO()
            image.save(encoded, format='PNG')
            png = encoded.getvalue()
            sha = hashlib.sha256(png).hexdigest()
            bid, rid = 'buffer-' + sha, identity('resource', ['display-png', sha])
            if rid not in self.payloads:
                if image.width * image.height + self.pixels > MAX_DOCUMENT_PIXELS:
                    raise ValueError('media-document-pixel-limit')
                self.pixels += image.width * image.height
                self.payloads[rid] = (bid, png)
            corners = [list(matrix.transform((x, y, 0))) for x, y in
                       [(0, 0), (image.width, 0), (image.width, image.height), (0, image.height)]]
            record.update(status='ready', reason='原配套已解析为二维图片显示', bufferId=bid,
                resourceId=rid, details=details,
                pixelSize=list(image.size), imageToEntity=list(matrix), corners=corners)
            if kind!='OLE2FRAME': record['sourceResourceId']=row['resourceId']
            return {'type': 'image', 'resourceId': rid, 'pixelSize': list(image.size),
                    'imageToEntity': list(matrix), 'clipBoundary': []}, corners, details['on']
        except Exception as error:
            record['reason'] = type(error).__name__ + ': ' + str(error)
            return {'type': 'unsupported', 'sourceType': entity.dxftype(), 'reason': record['reason']}, [], True

    def commit(self, document, sink):
        for rid, (bid, png) in self.payloads.items():
            sha = hashlib.sha256(png).hexdigest()
            document['buffers'][bid] = {'id': bid, 'sha256': sha, 'byteLength': len(png),
                'endianness': 'little', 'alignment': 1, 'storage': {'kind': 'resource', 'resourceId': bid}}
            sink.put(bid, png)
            document['resources'][rid] = {'id': rid, 'sha256': sha, 'byteLength': len(png),
                'role': 'image', 'mediaType': 'image/png', 'resourceId': bid}
        references = [{key: value for key, value in row.items() if not key.startswith('_')}
                      for row in self.references.values()]
        for row in references:
            document['externalReferences'].append({key: row[key] for key in
                ('id', 'ownerSourceId', 'requestedPath', 'status', 'required', 'reason', 'logicalPath', 'resourceId', 'candidates') if key in row})
            if 'resourceId' in row:
                rid = row['resourceId']
                document['resources'][rid] = {'id': rid, 'sha256': row['sha256'], 'byteLength': row['byteLength'],
                    'role': 'image' if row['kind'] == 'IMAGE' else 'opaque',
                    'mediaType': 'application/pdf' if row['kind'] == 'PDFUNDERLAY' else 'application/octet-stream',
                    'resourceId': row['logicalPath']}
        missing = sum(item['status'] != 'ready' for item in self.items.values())
        unresolved = sum(row['status'] != 'resolved' for row in references)
        coverage = {'status': 'partial' if missing or unresolved else 'complete', 'sourceObjects': len(self.items),
            'displayedObjects': len(self.items) - missing, 'missingObjects': missing,
            'references': len(references), 'unresolvedReferences': unresolved}
        document['extensions'][EXTENSION] = {'version': '1.1.0', 'references': references,
            'items': self.items, 'coverage': coverage, 'limits': {'fileBytes': MAX_FILE_BYTES,
                'pixelsPerImage': MAX_PIXELS, 'pixelsPerDocument': MAX_DOCUMENT_PIXELS,
                'pdfPages': MAX_PDF_PAGES, 'pdfRenderScale': PDF_RENDER_SCALE, 'pdfMaxSide': MAX_PDF_SIDE},
            'policy': 'uploaded bytes only; original source/definition references retained; PNG is a bounded display derivative'}
        return coverage
