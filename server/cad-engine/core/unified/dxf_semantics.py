"""Read-only source facts. Handles belong to their original source, never the host.

The object graph is a graph, not a recursive dictionary expansion: cycles,
shared objects and dangling handles retain their meaning. Geometry remains in
the drawing contract; these facts do not assert CAD constraint solving.
"""
import math
import io
from ezdxf.lldxf.tagwriter import TagCollector

EXTENSION = 'org.cad-preview.dxf-source-facts/1'
MAX_TAGS = 2000000
MAX_OBJECTS = 100000


def value(item):
    if isinstance(item, dict):
        return {key:value(val) for key,val in item.items()}
    if isinstance(item, bytes):
        return {'encoding':'hex', 'data':item.hex()}
    if isinstance(item,str) and any(0xd800<=ord(c)<=0xdfff for c in item):
        return {'encoding':'unicode-escape','data':item.encode('unicode_escape').decode('ascii')}
    if isinstance(item, float) and not math.isfinite(item):
        return {'invalidNumber':str(item)}
    if isinstance(item, (tuple,list)) or hasattr(item, 'xyz'):
        return [value(part) for part in item]
    return item


def tags_of(entity):
    return TagCollector.dxftags(entity, dxfversion=entity.doc.dxfversion)


def snapshot(doc, source_id, raw=None, source_format='DXF'):
    from ezdxf.entities import is_graphic_entity, DimStyle, factory
    from ezdxf.lldxf.const import DXFError
    rows, issues, budget = {}, [], 0
    original_handles,original_tags=set(),{}
    original_entities,decode_errors={},{}
    source_header=doc.header
    if raw is not None:
        from ezdxf import recover
        from ezdxf.lldxf.tagger import binary_tags_loader, tag_compiler
        from ezdxf.lldxf.tags import group_tags
        from ezdxf.lldxf.extendedtags import ExtendedTags
        from ezdxf.sections.header import HeaderSection
        loader=(tag_compiler(binary_tags_loader(raw)) if raw.startswith(b'AutoCAD Binary DXF')
            else recover.safe_tag_loader(io.BytesIO(raw),errors='surrogateescape'))
        source_header=HeaderSection()
        for tags in group_tags(loader):
            kind=tags[0].value
            if kind=='SECTION' and any(t.code==2 and t.value=='HEADER' for t in tags):
                # Drawing._setup_metadata replaces even a declared TDCREATE
                # and zero GUIDs on load. Facts and FIELD must use source tags,
                # not those reader-generated values or absent defaults.
                source_header=HeaderSection.load(tags)
                continue
            if kind in ('SECTION','ENDSEC','EOF'):continue
            handle=next((str(t.value) for t in tags if t.code in (5,105)),None)
            if handle is None:continue
            original_handles.add(handle)
            entity=doc.entitydb.get(handle)
            if entity is not None and len(original_entities)+len(decode_errors)<MAX_OBJECTS:
                try:original_entities[handle]=factory.load(ExtendedTags(tags),doc)
                except (DXFError,ValueError,IndexError) as error:
                    # A recovered document can contain repaired records which
                    # the ordinary entity decoder cannot read in isolation.
                    # Preserve its raw tags and name this loss, rather than
                    # presenting repaired attributes as original declarations.
                    decode_errors[handle]=type(error).__name__+': '+str(error)
                    issues.append('source-attribute-decode-failed:'+handle)
            if entity is not None and (not is_graphic_entity(entity) or kind in ('ACAD_TABLE','TOLERANCE') or handle in decode_errors):
                if budget+len(tags)>MAX_TAGS:
                    if 'source-facts-tag-budget' not in issues:issues.append('source-facts-tag-budget')
                    continue
                budget+=len(tags)
                original_tags[handle]=[[t.code,value(t.value)] for t in tags]
    for loaded in doc.entitydb.values():
        if loaded is None or not loaded.is_alive or not loaded.dxf.handle:
            continue
        if len(rows) >= MAX_OBJECTS:
            issues.append('source-facts-object-budget'); break
        handle=str(loaded.dxf.handle)
        entity=original_entities.get(handle,loaded);kind=entity.dxftype()
        if raw is not None and handle not in original_handles and not is_graphic_entity(loaded):
            continue  # reader-created management objects are not original source records
        row = {'type':kind, 'attributes':{key:value(val) for key,val in entity.dxf.all_existing_dxf_attribs().items()},
               'handleOrigin':'source-declared' if raw is None or handle in original_handles else 'reader-assigned-for-anonymous-record',
               'sourceRefs':[{'sourceId':source_id, 'objectKey':handle, 'path':source_format+'/'+kind+'/'+handle}]}
        if handle in decode_errors:
            row['attributeStatus']='reader-repaired'
            row['attributeDecodeError']=decode_errors[handle]
        if entity.xdata:
            row['xdata'] = {name:[[tag.code,value(tag.value)] for tag in tags[1:]]
                            for name,tags in entity.xdata.data.items()}
        if entity.extension_dict is not None and entity.extension_dict.is_alive:
            collector=TagCollector(dxfversion=doc.dxfversion)
            entity.extension_dict.export_dxf(collector)
            row['extensionDictionary'] = next(tag.value for tag in collector.tags if tag.code==360)
        if kind in ('DICTIONARY','ACDBDICTIONARYWDFLT'):
            row['entries'] = {key:str(obj.dxf.handle) if hasattr(obj,'dxf') else str(obj)
                              for key,obj in entity.items()}
        # Non-graphical/custom records carry application data, association graphs,
        # table cells and dynamic-block state which the DXF namespace cannot read.
        if not is_graphic_entity(entity) or kind in ('ACAD_TABLE','TOLERANCE') or handle in decode_errors:
            if raw is not None:
                if handle in original_tags:row['tags']=original_tags[handle]
                else:row['tagStatus']='budget-exceeded'
            else:
                tags = tags_of(entity)
                budget += len(tags)
                if budget > MAX_TAGS:
                    issues.append('source-facts-tag-budget'); break
                row['tags'] = [[tag.code,value(tag.value)] for tag in tags]
        if kind == 'DIMENSION':
            row['dimension'] = {'type':int(entity.dxf.dimtype) & 15,
                'style':entity.dxf.dimstyle, 'text':entity.dxf.text,
                'measurement':value(entity.dxf.get('actual_measurement')),
                'overrides':value(entity.get_acad_dstyle(DimStyle))}
        if kind == 'INSERT':
            block = doc.blocks.get(entity.dxf.name)
            row['blockState'] = {'name':entity.dxf.name,
                'definitionHandle':str(block.block_record_handle) if block is not None else None,
                'attributes':{attr.dxf.tag:original_entities.get(str(attr.dxf.handle),attr).dxf.text for attr in loaded.attribs},
                'geometryPolicy':'stored-current-state', 'parameterEvaluation':'not-executed'}
        rows[handle] = row
    return {'status':'partial' if issues else 'ready', 'issues':issues,
            'header':{key:value(source_header[key]) for key in source_header.varnames()},
            'customProperties':value(list(source_header.custom_vars)), 'objects':rows}


def extension(sources):
    return {'version':'1.0.0', 'sources':sources, 'policy':{
        'measurement':'source-declared; no geometry-derived inspection result',
        'references':'sourceId + original handle; cycles and dangling references retained',
        'dynamicBlocks':'stored current state and original parameter/object graph; no block editing or regeneration',
        'customObjects':'source attributes/tags; application-specific interpretation not asserted'}}
