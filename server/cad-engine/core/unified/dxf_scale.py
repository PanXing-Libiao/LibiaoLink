"""Annotation scale source records and model-space linetype metric.

AutoCAD stores these variables in AcDbVariableDictionary, not HEADER.
Annotation object contexts are retained by the source-facts graph; they are
not equivalent to scaling the base entity's entire geometry.
"""
import math
from .dxf_semantics import tags_of


def read(doc):
    dictionary = doc.rootdict.get('AcDbVariableDictionary')
    variables = {name:str(obj.value) for name,obj in dictionary.items()
                 if obj.dxftype() == 'DICTIONARYVAR'} if dictionary is not None else {}
    scales = {}
    for entity in doc.objects:
        if entity.dxftype() != 'SCALE': continue
        tags = {tag.code:tag.value for tag in tags_of(entity)}
        paper, model = float(tags.get(140,0)), float(tags.get(141,0))
        name = str(tags.get(300,''))
        if not name or not all(math.isfinite(v) and v>0 for v in (paper,model)):
            raise ValueError('annotation-scale-invalid:'+str(entity.dxf.handle))
        scales[str(entity.dxf.handle)] = {'name':name, 'paperUnits':paper, 'drawingUnits':model,
            'drawingPerPaper':model/paper, 'sourceHandle':str(entity.dxf.handle)}
    current = variables.get('CANNOSCALE','1:1')
    matches = [scale for scale in scales.values() if scale['name']==current or scale['sourceHandle']==current]
    if matches:
        ratio = matches[0]['drawingPerPaper']
    else:
        # A named scale without a corresponding SCALE record has no ratio. Only
        # the documented default 1:1 has an unambiguous missing-record meaning.
        ratio = 1.0 if current == '1:1' else None
    msltscale = int(variables.get('MSLTSCALE','1' if doc.dxfversion >= 'AC1021' else '0'))
    if msltscale not in (0,1): raise ValueError('msltscale-invalid')
    return {'variables':variables, 'scales':scales, 'currentName':current,
            'currentDrawingPerPaper':ratio, 'modelLineTypesScaled':bool(msltscale),
            'modelLineTypeFactor':ratio if msltscale else 1.0,
            'contextPolicy':'original object contexts retained in source-facts; no fabricated per-scale placement'}


def object_contexts(entity,scale_state):
    if not entity.has_extension_dict: return []
    manager=entity.extension_dict.get('AcDbContextDataManager')
    dictionary=manager.get('ACDB_ANNOTATIONSCALES') if manager is not None else None
    if dictionary is None: return []
    contexts=[]
    if len(dictionary)>128: raise ValueError('annotation-context-count-limit')
    for key,obj in dictionary.items():
        # DXFTagStorage has already compiled point groups into DXFVertex;
        # exporting through TagCollector would split them back to X/Y/Z tags.
        tags=list(obj.xtags);index=next((i for i,t in enumerate(tags) if t.code==340),None)
        if index is None: raise ValueError('annotation-context-scale-pointer-missing')
        handle=str(tags[index].value);scale=scale_state['scales'].get(handle)
        if scale is None: raise ValueError('annotation-context-scale-missing:'+handle)
        contexts.append({'key':key,'sourceHandle':str(obj.dxf.handle),'sourceType':obj.dxftype(),
            'scale':scale,'default':any(t.code==290 and t.value for t in tags[:index]),
            'payload':[[t.code,list(t.value) if isinstance(t.value,tuple) else t.value] for t in tags[index+1:]]})
    return contexts


def viewport_scale(entity,state):
    if entity.has_extension_dict:
        record=entity.extension_dict.get('ASDK_XREC_ANNOTATION_SCALE_INFO')
        if record is not None:
            handles=[str(t.value) for t in record.tags if t.code in (330,340)]
            scales=[state['scales'][h] for h in handles if h in state['scales']]
            if len(scales)!=1: raise ValueError('viewport-annotation-scale-reference-invalid')
            return scales[0]['drawingPerPaper']
    # A viewport with no saved annotation-scale XRECORD uses the drawing's
    # current annotation context, not its geometric zoom factor.
    return state['currentDrawingPerPaper'] or 1.0


def apply_context(entity,context,default_ratio):
    from ezdxf.math import Vec3
    data=dict(context['payload']);copy=entity.copy();kind=entity.dxftype()
    factor=context['scale']['drawingPerPaper']/default_ratio
    if kind in ('TEXT','ATTRIB','ATTDEF') and context['sourceType']=='ACDB_TEXTOBJECTCONTEXTDATA_CLASS':
        copy.dxf.height*=factor
        if 10 not in data or 11 not in data: raise ValueError('annotation-text-context-placement-missing')
        z=entity.dxf.insert.z
        copy.dxf.insert=(*data[10][:2],z);copy.dxf.align_point=(*data[11][:2],z)
        copy.dxf.halign=int(data[70]);copy.dxf.rotation=float(data[50])
    elif kind=='MTEXT' and context['sourceType']=='ACDB_MTEXTOBJECTCONTEXTDATA_CLASS':
        from ezdxf.entities.mtext import MTextColumns
        copy.dxf.char_height*=factor
        # DXF emits insertion as 10 and direction as 11. The binary DWG
        # payload reverses their order; it is not the DXF tag contract.
        copy.dxf.insert=Vec3(data[10]);copy.dxf.text_direction=Vec3(data[11])
        copy.dxf.attachment_point=int(data[70]);copy.dxf.width=float(data[40])
        copy.dxf.defined_height=float(data.get(41,0))
        copy.text=entity.all_columns_raw_content();copy._columns=None
        column_type=int(data.get(71,0))
        if column_type:
            count=int(data[72]);width=float(data[44]);gutter=float(data[45]);height=float(data[41])
            if column_type not in (1,2) or not 1<=count<=128 or min(width,height)<=0 or gutter<0:
                raise ValueError('annotation-mtext-context-columns-invalid')
            if column_type==1:
                columns=MTextColumns.new_static_columns(count,width,gutter,height)
            elif data[73]:
                columns=MTextColumns.new_dynamic_auto_height_columns(count,width,gutter,height)
            else:
                heights=[float(value) for code,value in context['payload'] if code==46]
                if len(heights)!=count or min(heights)<0 or not any(heights):
                    raise ValueError('annotation-mtext-context-column-heights-invalid')
                columns=MTextColumns.new_dynamic_manual_height_columns(width,gutter,heights)
            columns.reversed_column_flow=bool(data[74]);copy.setup_columns(columns,linked=False)
        values=[copy.dxf.char_height,copy.dxf.width,copy.dxf.defined_height,*copy.dxf.insert,*copy.dxf.text_direction]
        if not all(math.isfinite(value) for value in values) or copy.dxf.text_direction.magnitude<1e-12:
            raise ValueError('annotation-mtext-context-metrics-invalid')
    else: raise ValueError('annotation-context-placement-type-unimplemented:'+context['sourceType'])
    return copy
