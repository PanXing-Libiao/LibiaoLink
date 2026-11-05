"""Upload-only CTB/STB decoding using the already pinned ezdxf acadctb parser.

This is a screen print-preview contract, not a printer/PC3 or halftone driver.
Source display stays independent of a user's explicit print-preview choice.
"""
import hashlib
import math
import zlib
from pathlib import PurePosixPath
from ezdxf.addons import acadctb
from .dxf_xref import match_file

EXTENSION='org.cad-preview.dxf-plot-styles/1'
MAX_BYTES=4*1024*1024


def read(raw,kind):
    if len(raw)<60 or len(raw)>MAX_BYTES or not raw.startswith(b'PIAFILEVERSION_2.0,'):
        raise ValueError('plot-style-header-or-size-invalid')
    decoder=zlib.decompressobj();text=decoder.decompress(raw[60:],MAX_BYTES+1)
    if len(text)>MAX_BYTES or not decoder.eof or decoder.unused_data:
        raise ValueError('plot-style-decompression-invalid-or-limit')
    table=acadctb.new_ctb() if kind=='ctb' else acadctb.new_stb()
    table.parse(text.rstrip(b'\0').decode('utf-8'))
    styles={}
    for index,style in enumerate(table if kind=='ctb' else table.values()):
        if index>4096: raise ValueError('plot-style-count-limit')
        if not 0<=style.screen<=100 or not 0<=style.lineweight<len(table.lineweights):
            raise ValueError('plot-style-screen-or-lineweight-invalid')
        weight=float(table.lineweights[style.lineweight])
        if not math.isfinite(weight) or weight<0: raise ValueError('plot-style-lineweight-invalid')
        if style.linetype not in range(32) or style.end_style not in range(5) or style.join_style not in (0,1,2,3,5) or style.fill_style not in range(64,74):
            raise ValueError('plot-style-appearance-enum-invalid')
        styles[str(index+1) if kind=='ctb' else style.name]={'name':style.name,'color':list(style.color) if style.color is not None else None,
            'screening':style.screen, 'grayscale':bool(style.grayscale),'dither':bool(style.dithering),
            'lineWeightMm':weight if style.lineweight else None,'lineType':style.linetype,
            'adaptive':bool(style.adaptive_linetype),'end':style.end_style,'join':style.join_style,'fill':style.fill_style}
    return {'kind':kind,'description':table.description,'styles':styles,
            'fidelity':'screen approximation; device halftone/dither and physical pen hardware are not reproduced'}


def trait(entity):
    doc=entity.doc
    attributes=entity.dxf.all_existing_dxf_attribs()
    names={str(obj.dxf.handle):name for name,obj in doc.plotstyles.items()} if doc is not None else {}
    handle=attributes.get('plotstyle_handle')
    return {'colorIndex':abs(int(attributes.get('color',7 if entity.dxftype()=='LAYER' else 256))), 'trueColor':'true_color' in attributes,
        'plotStyleMode':int(attributes.get('plotstyle_enum',3 if handle else 2 if entity.dxftype()=='LAYER' else 1)),
        'plotStyleName':names.get(str(handle)), 'layer':attributes.get('layer','0'),**getattr(entity,'_cad_plot_style',{})}


def collect(doc,xrefs,files,layouts,layer_ids):
    def layer_trait(name):
        layer=doc.layers.get(name);origin=xrefs.origin(layer.dxf.handle)
        return origin['plotTrait'] if origin and 'plotTrait' in origin else trait(layer)
    result={'version':'1.0.0','mode':'ctb' if doc.header.get('$PSTYLEMODE',1) else 'stb',
        'layouts':{},'tables':{},'traits':{},'resolved':{},'viewportLayers':{},'layers':{key:{**layer_trait(name),
            'name':name} for name,key in layer_ids.items()},
        'policy':'source page setup or explicit screen print preview; uploaded bytes only'}
    for layout,key in layouts:
        filename=layout.dxf.current_style_sheet
        flags=int(layout.dxf.plot_layout_flags)
        row={'requestedPath':filename,'displayPlotStyles':bool(flags&2),'plotWithStyles':bool(flags&32),
            'status':'unused' if not filename else 'missing','sourceHandle':str(layout.dxf.handle)}
        numerator,denominator=float(layout.dxf.scale_numerator),float(layout.dxf.scale_denominator)
        valid_metric=all(math.isfinite(v) and v>0 for v in (numerator,denominator)) and layout.dxf.plot_paper_units in (0,1)
        row['drawingToPaperMm']=((25.4 if layout.dxf.plot_paper_units==0 else 1.0)*(
            numerator/denominator if key=='model' else 1)) if valid_metric else None
        result['layouts'][key]=row
        if not filename: continue
        logical,method,candidates=match_file(filename,xrefs.name,files or {})
        row['match']=method
        if logical is None:
            row['status']='ambiguous' if candidates else 'missing';row['candidates']=candidates;continue
        raw=files[logical];sha=hashlib.sha256(raw).hexdigest();kind=PurePosixPath(logical).suffix.lower().lstrip('.')
        row.update(logicalPath=logical,sha256=sha,byteLength=len(raw))
        try:
            if kind!=result['mode']: raise ValueError('plot-style-mode-mismatch')
            if row['drawingToPaperMm'] is None:raise ValueError('plot-style-page-metric-invalid')
            if sha not in result['tables']: result['tables'][sha]=read(raw,kind)
            row.update(status='ready',tableId=sha)
        except (ValueError,IndexError,KeyError,UnicodeError,zlib.error) as error:
            row.update(status='invalid',reason=str(error))
    return result


def select(extension,context,item_id,layer_id,parents,viewport_id=None):
    setup=extension['layouts'].get(context)
    if not setup or setup['status']!='ready': return None
    table=extension['tables'][setup['tableId']]
    traits=extension['traits'];layers=extension['layers']
    def layer_for(own,chain):
        if layers.get(own,{}).get('name')!='0': return own
        return next((traits[key]['layerId'] for key in reversed(chain)
            if layers.get(traits.get(key,{}).get('layerId'),{}).get('name')!='0' and key in traits),own)
    def selector(key,layer,chain):
        own=traits.get(key,{})
        layer=layer_for(layer,chain)
        layer_trait={**layers.get(layer,{}),**extension.get('viewportLayers',{}).get(viewport_id,{}).get(layer,{})}
        if table['kind']=='ctb':
            index=own.get('colorIndex',256)
            if own.get('trueColor'): return None
            if index==256:
                return None if layer_trait.get('trueColor') else str(layer_trait.get('colorIndex',7))
            if index==0:
                return selector(chain[-1],traits[chain[-1]]['layerId'],chain[:-1]) if chain else '7'
            return str(index)
        mode=own.get('plotStyleMode',0)
        if mode==0: return layer_trait.get('plotStyleName') or 'Normal'
        if mode==1: return selector(chain[-1],traits[chain[-1]]['layerId'],chain[:-1]) if chain else 'Normal'
        if mode==2: return 'Normal'
        return own.get('plotStyleName')
    key=selector(item_id,layer_id,parents)
    if key is None and table['kind']=='ctb': return None  # source true color bypasses ACI pens
    style=table['styles'].get(key)
    return {'status':'ready','selector':key,'style':style} if style is not None else {
        'status':'missing','selector':key,'reason':'plot-style-name-not-in-table'}


def commit(document,extension,source_id):
    from .adapter import identity
    missing=[]
    for context,setup in extension['layouts'].items():
        if setup['requestedPath']:
            reference={'id':identity('plot-style-reference',[source_id,context,setup['requestedPath']]),
                'ownerSourceId':source_id,'requestedPath':setup['requestedPath'],
                'status':'resolved' if setup['status']=='ready' else 'blocked' if setup['status']=='invalid' else setup['status'],
                'required':setup['displayPlotStyles'],'reason':setup.get('reason','source layout print style'),
                **{key:setup[key] for key in ('logicalPath','candidates') if key in setup}}
            if 'sha256' in setup:
                rid=identity('resource',['source-plot-style',setup['sha256']]);reference['resourceId']=rid
                document['resources'][rid]={'id':rid,'sha256':setup['sha256'],'byteLength':setup['byteLength'],
                    'role':'opaque','mediaType':'application/octet-stream','resourceId':setup['logicalPath']}
            document['externalReferences'].append(reference)
        if not setup['displayPlotStyles'] or setup['status']=='unused': continue
        if setup['status']!='ready':missing.append({'context':context,'reason':setup.get('reason',setup['status'])});continue
        for draw_id,entry in extension['resolved'].get(context,{}).items():
            for pen in [entry.get('root'),*entry.get('parts',{}).values()]:
                if pen and pen['status']!='ready':missing.append({'context':context,'drawId':draw_id,'reason':pen['reason']})
    for entry in document['extensions'].get('org.cad-preview.annotation-presentation/1',{}).get('items',{}).values():
        for presentation in [entry,*entry.get('scaleVariants',[])]:
            for part in presentation['parts']:
                for context,variants in part.get('plotVariants',{}).items():
                    if not extension['layouts'][context]['displayPlotStyles']:continue
                    for draw_id,variant in variants.items():
                        if variant['status']!='ready':missing.append({'context':context,'drawId':draw_id,'reason':variant['reason']})
    extension['coverage']={'status':'partial' if missing else 'complete','sourceDisplayFailures':missing,
        'policy':'source-enabled plot styles affect completeness; optional print preview does not alter ordinary geometry'}
    return extension['coverage']

# Selective data adaptation: truedxf packages/plot/src/pen-linetype.ts,
# 019c2e504738965c (MIT); measured paper-inch pattern definitions.
PEN_PATTERNS = [[],[.15,-.1],[0,-.1],[.13,-.06,0,-.06],[.125,-.375],
 [.25,-.25],[.375,-.125],[.25,-.75],[.5,-.5],[.75,-.25],[.3,-.2],
 [.2,-.06,.06,-.06,.06,-.06],[.35,-.05,.05,-.05],[.35,-.05,0,-.05,0,-.05],
 [.4,-.05,0,-.05],[.25,-.05,0,-.05,.05,-.05,0,-.05],[0,-.5],
 [.235,-.06],[.235,-.355],[.47,-.06,0,-.06],[.47,-.06,0,-.06,0,-.06],
 [.47,-.06,0,-.06,0,-.06,0,-.06],[0,-.395],[.47,-.06,.12,-.06],
 [.47,-.06,.12,-.06,.12,-.06],[.235,-.06,0,-.06],
 [.235,-.06,.235,-.06,0,-.06],[.235,-.06,0,-.06,0,-.06],
 [.235,-.06,.235,-.06,0,-.06,0,-.06],[.235,-.06,0,-.06,0,-.06,0,-.06],
 [.235,-.06,.235,-.06,0,-.06,0,-.06,0,-.06]]


def pen_events(total,groups,lengths,period,closed,budget,adaptive=False):
    factor=1.0
    if adaptive and total>0:
        count=max(1,math.floor(total/period+.5))
        factor=total/(count*period)
    position=-lengths[0]*factor/2 if adaptive else 0
    events=[];count=0;index=0
    while position<=total+1e-9:
        count+=1
        if count>budget: raise ValueError('plot-style-pattern-segment-budget')
        length=lengths[index]*factor;positive=groups[index][49]>=0
        if positive and position+length>=0:
            if length==0: events.append(('dot',max(0,min(total,position)),None))
            elif position<total-1e-9: events.append(('dash',max(0,position),min(total,position+length)))
        position+=length;index=(index+1)%len(groups)
    return events,count
