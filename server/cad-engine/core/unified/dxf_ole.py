"""Read OLE's saved content bitmap, never instantiate its embedded application.

CFB is read by olefile 0.47; OlePres follows Microsoft MS-OLEDS 2.3.4.
Only device-independent CF_DIB content presentations are accepted. Icons,
native spreadsheets/documents and unrendered metafiles are not substitutes.
"""
import io
import struct
from importlib.metadata import version
from ezdxf.math import Matrix44, Vec3

MAX_BYTES = 16*1024*1024
SIGNATURE = bytes.fromhex('d0cf11e0a1b11ae1')


def presentation(raw):
    if len(raw)<40: raise ValueError('ole-presentation-truncated')
    marker,kind,device=struct.unpack_from('<3L',raw)
    if marker!=0xffffffff or kind!=8: raise ValueError('ole-cache-not-dib')
    if device<4 or device>len(raw)-36: raise ValueError('ole-target-device-invalid')
    if device!=4: raise ValueError('ole-device-specific-cache-unsupported')
    offset=8+device
    aspect,index,advf,reserved,width,height,size=struct.unpack_from('<7L',raw,offset)
    if aspect!=1: raise ValueError('ole-cache-not-content-aspect')
    if size<12 or size>MAX_BYTES or offset+28+size>len(raw): raise ValueError('ole-cache-size-invalid')
    return raw[offset+28:offset+28+size]


def read(entity, max_pixels):
    import olefile
    from PIL import Image
    if version('olefile')!='0.47': raise ValueError('ole-reader-version-mismatch')
    raw=entity.binary_data()
    if not raw or len(raw)>MAX_BYTES: raise ValueError('ole-payload-missing-or-too-large')
    start=raw.find(SIGNATURE,0,4096)
    if start<0: raise ValueError('ole-cfb-container-not-found')
    candidates=[];failures=[]
    with olefile.OleFileIO(io.BytesIO(raw[start:]),raise_defects=olefile.DEFECT_INCORRECT) as compound:
        paths=compound.listdir(streams=True,storages=False)
        if len(paths)>1024: raise ValueError('ole-stream-count-limit')
        for path in paths:
            if len(path)!=1 or not path[0].startswith('\x02OlePres'): continue
            if compound.get_size(path)>MAX_BYTES: raise ValueError('ole-cache-stream-limit')
            cache=compound.openstream(path).read()
            try: dib=presentation(cache)
            except ValueError as error: failures.append(str(error));continue
            with Image.open(io.BytesIO(dib)) as source:
                if source.format!='DIB': raise ValueError('ole-cache-dib-signature-invalid')
                w,h=source.size
                if min(w,h)<1 or w*h>max_pixels: raise ValueError('ole-cache-pixel-limit')
                candidates.append((source.convert('RGBA'),path[0]))
    if len(candidates)!=1:
        raise ValueError('ole-content-cache-'+('ambiguous' if candidates else 'unavailable')+': '+','.join(failures))
    image,name=candidates[0]
    tags=entity.acdb_ole2frame
    upper=tags.get_first_value(10,None);lower=tags.get_first_value(11,None)
    if upper is None or lower is None: raise ValueError('ole-placement-missing')
    upper,lower=Vec3(upper),Vec3(lower)
    if abs(upper.z-lower.z)>1e-9: raise ValueError('ole-nonplanar-bounds')
    matrix=Matrix44.chain(Matrix44.scale((lower.x-upper.x)/image.width,(lower.y-upper.y)/image.height,1),
                          Matrix44.translate(*upper))
    return image,matrix,{'on':True,'cacheStream':name,'format':'CF_DIB', 'displayOnly':True,
        'placementMethod':'source-declared WCS upper-left/lower-right; embedded application not executed',
        'sourceByteLength':len(raw)}
