"""UCD's closed schema vocabulary plus cross-reference and binary validation.

This is not a general JSON Schema engine. Only the vocabulary used by our bundled
schema is supported; new schema keywords must be implemented explicitly.
"""
import base64
import hashlib
import json
import math
import re
import struct
from pathlib import Path
from .canonical import canonical_sha256

SCHEMA = json.loads((Path(__file__).parent/'schema/ucd-1.0.schema.json').read_text())
SCHEMA_V2 = json.loads((Path(__file__).parent/'schema/ucd-2.0.schema.json').read_text())
TYPES = {'object':dict,'array':list,'string':str,'boolean':bool,'integer':int}
COMPONENTS = {'f32':('f',4),'f64':('d',8),'u8':('B',1),'u16':('H',2),'u32':('I',4)}
SUPPORTED = {'$schema','$id','$defs','$ref','title','description','type','properties','required',
             'additionalProperties','items','minItems','maxItems','minLength','maxLength',
             'minimum','maximum','exclusiveMinimum','enum','const','anyOf','oneOf','pattern'}

class ValidationError(ValueError):
    def __init__(self,code,path,message):
        self.code,self.path,self.message=code,path,message
        super().__init__(f'{code} at {path}: {message}')

def require(condition,code,path,message):
    if not condition:raise ValidationError(code,path,message)

def _equal(a,b):
    return a==b and not (isinstance(a,bool)!=isinstance(b,bool))

# Per-schema caches. Only nodes of the bundled schema documents are registered, so
# ad-hoc dictionaries created while walking a value never accumulate here.
_EMPTY_SCHEMA={}
_SCHEMA_INFO={}
_REF_DEFS={}
_SCALAR_CHECKS={}

def _scalar_check(schema):
    """Compile only bundled scalar constraints; containers retain the same walker.

    The schema text is never executed. Only fixed statements below are selected,
    with constants held separately. Ad-hoc schemas never enter this cache.
    """
    kind=schema.get('type')
    if kind not in ('string','boolean','integer','number','null'):return None
    if set(schema)-SUPPORTED or any(k in schema for k in ('$ref','oneOf','anyOf')):return None
    lines=['def check(value,path):']
    conditions={'string':'type(value) is str','boolean':'type(value) is bool',
                'integer':'type(value) is int','number':'type(value) in (int,float) and math.isfinite(value)',
                'null':'value is None'}
    # Even a wrong-typed float must retain the generic non-finite rejection.
    lines+=[' if type(value) is float and not math.isfinite(value):',
            "  require(False,'invalid-schema',path,'Non-finite number')",
            ' if not ('+conditions[kind]+'):',
            "  require(False,'invalid-schema',path,'Expected "+kind+"')"]
    if 'const' in schema:
        lines += [" if not _equal(value,constants['const']): require(False,'invalid-schema',path,'Unexpected constant')"]
    if 'enum' in schema:
        # For scalar type-checked values, Python membership agrees with _equal
        # when the enum contains no booleans (True must never equal 1).
        if kind in ('string','null') or (kind in ('integer','number') and not any(isinstance(v,bool) for v in schema['enum'])) or (kind=='boolean' and all(type(v) is bool for v in schema['enum'])):
            lines += [" if value not in constants['enum']: require(False,'invalid-schema',path,'Unexpected enum')"]
        else:
            lines += [" if not any(_equal(value,v) for v in constants['enum']): require(False,'invalid-schema',path,'Unexpected enum')"]
    for key,op in [('minimum','>='),('maximum','<='),('exclusiveMinimum','>')]:
        if key in schema:lines += [f" if not value{op}constants['{key}']: require(False,'invalid-schema',path,'{key}')"]
    if kind=='string':
        if 'minLength' in schema:lines += [" if len(value)<constants['minLength']: require(False,'invalid-schema',path,'String length')"]
        if 'maxLength' in schema:lines += [" if len(value)>constants['maxLength']: require(False,'invalid-schema',path,'String length')"]
        if 'pattern' in schema:lines += [" if pattern.search(value) is None: require(False,'invalid-schema',path,'Pattern')"]
    # Schemas here are trusted bundled data, not request-controlled programs.
    namespace={'math':math,'require':require,'_equal':_equal,'constants':schema,
               'pattern':re.compile(schema['pattern']) if 'pattern' in schema else None}
    exec('\n'.join(lines),namespace)
    return namespace['check']

def _register_schema(schema,seen):
    if not isinstance(schema,dict) or id(schema) in seen:return
    seen.add(id(schema))
    _SCHEMA_INFO[id(schema)]=(schema,tuple(schema.get('required',())),set(schema)-SUPPORTED)
    check=_scalar_check(schema)
    if check is not None:_SCALAR_CHECKS[id(schema)]=(schema,check)
    for key in ('items','additionalProperties'):
        _register_schema(schema.get(key),seen)
    for child in (schema.get('properties') or {}).values():_register_schema(child,seen)
    for child in (schema.get('$defs') or {}).values():_register_schema(child,seen)
    for key in ('oneOf','anyOf'):
        for child in schema.get(key) or []:_register_schema(child,seen)

for _bundle in (SCHEMA,SCHEMA_V2):_register_schema(_bundle,set())

def shape(value,schema,path='$',root_schema=None):
    root_schema=SCHEMA if root_schema is None else root_schema
    scalar=_SCALAR_CHECKS.get(id(schema))
    if scalar is not None and scalar[0] is schema:return scalar[1](value,path)
    info=_SCHEMA_INFO.get(id(schema))
    if info is None or info[0] is not schema:
        required=tuple(schema.get('required',()))
        unsupported=set(schema)-SUPPORTED
    else:
        _schema,required,unsupported=info
    if type(value) is float:require(math.isfinite(value),'invalid-schema',path,'Non-finite number')
    require(not unsupported,'invalid-schema',path,'Unsupported schema vocabulary')
    ref=schema.get('$ref')
    if ref is not None:
        name=ref.removeprefix('#/$defs/')
        if name=='Fact' and isinstance(value,dict) and value.get('knowledge')=='unknown':
            require('value' not in value,'invalid-schema',path,'Unknown fact cannot invent a value')
        key=(id(root_schema),name)
        target=_REF_DEFS.get(key)
        if target is None:
            target=(root_schema,root_schema['$defs'][name])
            _REF_DEFS[key]=target
        return shape(value,target[1],path,root_schema)
    for op in ('oneOf','anyOf'):
        if op in schema:
            matches=0
            for choice in schema[op]:
                try:shape(value,choice,path,root_schema);matches+=1
                except ValidationError:pass
            require(matches==1 if op=='oneOf' else matches>0,'invalid-schema',path,op+' mismatch')
            # Each successful branch already walked every descendant, including
            # unconstrained values and non-finite numbers. A union-only wrapper
            # adds no further constraints, so do not walk that value again.
            if set(schema)<={op,'title','description','$schema','$id','$defs'}:return
    kind=schema.get('type')
    if kind:
        valid=(type(value) in (int,float) and math.isfinite(value)) if kind=='number' else (
            value is None if kind=='null' else type(value) is TYPES[kind])
        require(valid,'invalid-schema',path,'Expected '+kind)
    if 'const' in schema:require(_equal(value,schema['const']),'invalid-schema',path,'Unexpected constant')
    if 'enum' in schema:require(any(_equal(value,v) for v in schema['enum']),'invalid-schema',path,'Unexpected enum')
    for key in ('minimum','maximum','exclusiveMinimum'):
        if key in schema:
            valid=value>=schema[key] if key=='minimum' else value<=schema[key] if key=='maximum' else value>schema[key]
            require(valid,'invalid-schema',path,key)
    if isinstance(value,str):
        require(len(value)>=schema.get('minLength',0) and len(value)<=schema.get('maxLength',float('inf')),'invalid-schema',path,'String length')
        if 'pattern' in schema:require(re.search(schema['pattern'],value) is not None,'invalid-schema',path,'Pattern')
    if isinstance(value,list):
        require(len(value)>=schema.get('minItems',0) and len(value)<=schema.get('maxItems',float('inf')),'invalid-schema',path,'Array length')
        items=schema.get('items',_EMPTY_SCHEMA)
        for i,item in enumerate(value):shape(item,items,f'{path}/{i}',root_schema)
    if isinstance(value,dict):
        if required:
            for key in required:
                if key not in value:require(False,'invalid-schema',path,'Missing required fields')
        properties=schema.get('properties',{})
        if properties:
            for key,item in value.items():
                child=properties.get(key)
                if child is None:
                    child=schema.get('additionalProperties',_EMPTY_SCHEMA)
                    require(child is not False,'invalid-schema',path+'/'+key,'Unexpected property')
                    child=_EMPTY_SCHEMA
                shape(item,child,path+'/'+key,root_schema)
        else:
            for key,item in value.items():
                child=schema.get('additionalProperties',_EMPTY_SCHEMA)
                require(child is not False,'invalid-schema',path+'/'+key,'Unexpected property')
                shape(item,child if isinstance(child,dict) else _EMPTY_SCHEMA,path+'/'+key,root_schema)

def affine(matrix,path):
    require(all(math.isfinite(x) for x in matrix) and all(abs(matrix[i])<1e-12 for i in (3,7,11)) and abs(matrix[15]-1)<1e-12,'invalid-matrix',path,'Expected finite affine column-major matrix')

def tree(nodes,path):
    for key,n in nodes.items():
        require(key==n['id'],'invalid-reference',path,'Table identity mismatch')
        if n['parentId'] is not None:require(n['parentId'] in nodes,'invalid-reference',path,'Missing parent')
    finished=set()
    for key in nodes:
        visiting=set();p=key
        while p is not None and p not in finished:
            require(p not in visiting,'invalid-reference',path,'Occurrence cycle')
            visiting.add(p);p=nodes[p]['parentId']
        finished.update(visiting)
    orders=set()
    for n in nodes.values():
        order=(n['parentId'],n['orderInParent'])
        require(order not in orders,'invalid-reference',path,'Duplicate sibling order');orders.add(order)

def _column_values(accessor,blob):
    """Contiguous accessor bytes as a shared typed view (None if the window is short)."""
    code,width=COMPONENTS[accessor['component']];element=width*accessor['components']
    start=accessor['byteOffset'];end=start+accessor['byteLength']
    if end>len(blob) or accessor['byteLength']%element:return None
    return memoryview(blob)[start:end].cast(code)


def values(accessor,raw,first=0,count=None):
    code,width=COMPONENTS[accessor['component']];element=width*accessor['components'];stride=accessor.get('byteStride',element)
    count=accessor['count']-first if count is None else count
    start=accessor['byteOffset']+first*stride
    if stride==element:
        yield from struct.iter_unpack('<'+code*accessor['components'],memoryview(raw)[start:start+count*element])
    else:
        for i in range(count):yield struct.unpack_from('<'+code*accessor['components'],raw,start+i*stride)

def _envelope_shape(envelope,schema):
    document=envelope.get('document')
    adapter=document.get('adapter') if isinstance(document,dict) else None
    extensions=document.get('extensions') if isinstance(document,dict) else None
    snapshot=envelope.get('snapshot')
    draws=snapshot.get('draws') if isinstance(snapshot,dict) else None
    # Small STEP envelopes cost less to walk than loading the native runtime.
    large_step=isinstance(adapter,dict) and adapter.get('id')=='occt-xde-step' and isinstance(draws,dict) and len(draws)>=2048
    native=large_step or (isinstance(extensions,dict) and 'org.libiaolink.dwg/1' in extensions)
    if schema is SCHEMA_V2 and native:
        from .native_schema import accepts
        if accepts(envelope):return
        # Invalid inputs use the original walker for stable error codes/paths.
        # A native rejection can never become acceptance through this path.
        shape(envelope,schema['$defs']['Envelope'],root_schema=schema)
        raise ValidationError('invalid-schema','$','CAD structure rejected')
    shape(envelope,schema['$defs']['Envelope'],root_schema=schema)


def validate_envelope(envelope,max_decoded=256*1024*1024):
    version=envelope.get('document',{}).get('schemaVersion')
    require(version in ('1.0.0','2.0.0'),'unsupported-version','document','Unknown UCD major version')
    schema=SCHEMA if version=='1.0.0' else SCHEMA_V2
    _envelope_shape(envelope,schema)
    return _validate_core(envelope,version,schema,max_decoded)

def validate_binary_envelope(document,snapshot,presentation,reader,max_decoded=256*1024*1024):
    """Validate a document/snapshot whose buffer bytes live outside the envelope.

    reader(bufferId) must return the exact bytes recorded in document.buffers.
    Structural checks are identical to validate_envelope; only the payload
    encoding is replaced by a caller-supplied binary source.
    """
    version=document.get('schemaVersion')
    require(version in ('1.0.0','2.0.0'),'unsupported-version','document','Unknown UCD major version')
    schema=SCHEMA if version=='1.0.0' else SCHEMA_V2
    wrapper={'transportProfile':'ucd-base64-envelope/1','document':document,'snapshot':snapshot,'bufferPayloads':{},'presentation':presentation}
    _envelope_shape(wrapper,schema)
    raw={}
    for key,b in document['buffers'].items():
        blob=reader(key)
        require(isinstance(blob,(bytes,bytearray)),'invalid-buffer',key,'Binary payload is not bytes')
        require(b['id']==key and len(blob)==b['byteLength'] and hashlib.sha256(blob).hexdigest()==b['sha256'] and b['storage']['resourceId']==key,'invalid-buffer',key,'Buffer identity/length/hash mismatch')
        raw[key]=bytes(blob)
    require(sum(b['byteLength'] for b in document['buffers'].values())<=max_decoded,'limit-exceeded','buffers','Decoded buffer budget')
    return _validate_core(wrapper,version,schema,max_decoded,raw)

def _validate_core(envelope,version,schema,max_decoded,raw=None):
    if version=='2.0.0':validate_v2(envelope)
    d,s=envelope['document'],envelope['snapshot']
    if 'drawingProjection' in s:validate_drawing_projection(d,s['drawingProjection'])
    require(d['serializationProfile']=='ucd-json-python-sorted/1','unsupported-feature','serializationProfile','This bridge validator has not implemented RFC8785')
    require(not d['extensionsRequired'],'unsupported-feature','extensionsRequired','Required extensions have no registered consumer in v1')
    require(s['documentRevision']==d['revision'],'invalid-reference','snapshot','Document revision mismatch')
    sources={x['id'] for x in d['sources']}
    require(len(sources)==len(d['sources']),'invalid-reference','sources','Duplicate source identity')
    for tab in ('products','representations','geometries','buffers','materials','properties','resources'):
        require(all(key==row['id'] for key,row in d[tab].items()),'invalid-reference',tab,'Table identity mismatch')
    for p in d['products'].values():require(all(k in d['representations'] for k in p['representationIds']) and all(k in d['properties'] for k in p['propertySetIds']),'invalid-reference','products','Missing representation/property')
    configs={c['id']:c for c in d['configurations']};states={x['id']:x for x in d['displayStates']}
    require(len(configs)==len(d['configurations']) and len(states)==len(d['displayStates']),'invalid-reference','selection','Duplicate selection identity')
    selection=s['selection']
    if version=='1.0.0':
        config=selection['configurationId'];require(config in configs,'invalid-reference','selection','Missing configuration')
    else:
        context=next(c for c in d['viewContexts'] if c['id']==selection['viewContextId']);config=context.get('configurationId')
    if 'displayStateId' in selection:
        st=selection['displayStateId'];require(config in configs and st in states and st in configs[config]['stateIds'] and config in states[st]['configurationIds'],'invalid-reference','selection','Unassociated display state')
    for c in configs.values():require(set(c['stateIds'])<=set(states),'invalid-reference','configurations','Missing display state')
    for st in states.values():require(set(st['configurationIds'])<=set(configs),'invalid-reference','displayStates','Missing configuration')
    for feature in d['capabilities']:require(set(feature['evidenceIds'])<={x['id'] for x in d['evidence']},'invalid-reference','capabilities','Missing evidence')
    tree(d['sceneOccurrences'],'sceneOccurrences');tree(d['productOccurrences'],'productOccurrences')
    affine(d['coordinates']['sourceToDocument'],'coordinates')
    for n in d['sceneOccurrences'].values():
        affine(n['localFromParent'],'scene/'+n['id'])
        if 'representationId' in n:require(n['representationId'] in d['representations'],'invalid-reference','scene','Missing representation')
        require(all(r['sourceId'] in sources for r in n['sourceRefs']),'invalid-reference','scene','Missing source')
    require(set(d['productRoots'])=={k for k,n in d['productOccurrences'].items() if n['parentId'] is None},'invalid-reference','productRoots','Wrong roots')
    for n in d['productOccurrences'].values():
        require(n['definitionId'] in d['products'] and all(k in d['sceneOccurrences'] for k in n['sceneAnchorIds']),'invalid-reference','products','Missing product or scene anchor')
    expected_buffers=set(d['buffers'])
    if raw is None:
        require(set(envelope['bufferPayloads'])==expected_buffers,'invalid-buffer','buffers','Missing or extra payload')
        require(sum(b['byteLength'] for b in d['buffers'].values())<=max_decoded,'limit-exceeded','buffers','Decoded buffer budget')
        raw={}
        for key,b in d['buffers'].items():
            payload=envelope['bufferPayloads'][key]
            require(len(payload)==4*((b['byteLength']+2)//3),'invalid-buffer',key,'Encoded length mismatch')
            try:blob=base64.b64decode(payload,validate=True)
            except ValueError as error:raise ValidationError('invalid-buffer',key,'Invalid base64') from error
            require(b['id']==key and len(blob)==b['byteLength'] and hashlib.sha256(blob).hexdigest()==b['sha256'] and b['storage']['resourceId']==key,'invalid-buffer',key,'Buffer identity/length/hash mismatch')
            raw[key]=blob
    else:
        require(set(raw)==expected_buffers,'invalid-buffer','buffers','Missing or extra payload')
    for key,a in d['accessors'].items():
        require(a['bufferId'] in raw,'invalid-buffer',key,'Missing buffer')
        _,width=COMPONENTS[a['component']];element=width*a['components'];stride=a.get('byteStride',element)
        required=0 if a['count']==0 else (a['count']-1)*stride+element
        require(stride>=element and stride%width==0 and a['byteOffset']%width==0 and required<=a['byteLength'] and a['byteOffset']+a['byteLength']<=len(raw[a['bufferId']]),'invalid-buffer',key,'Accessor alignment/stride/window overflow')
        require(not(a['component'].startswith('f') and a['normalized']),'invalid-buffer',key,'Float normalization')
    for key,g in d['geometries'].items():
        require(g['id']==key and 'POSITION' in g['attributes'],'invalid-geometry',key,'Missing POSITION or wrong identity')
        require(all(aid in d['accessors'] for aid in g['attributes'].values()),'invalid-reference',key,'Missing attribute accessor')
        position=d['accessors'][g['attributes']['POSITION']]
        require(position['component'] in ('f32','f64') and position['components']==3 and not position['normalized'] and position['count']>0,'invalid-geometry',key,'Invalid POSITION')
        low,high=g['bounds']['min'],g['bounds']['max']
        require(all(a<=b for a,b in zip(low,high)),'invalid-geometry',key,'Invalid bounds')
        for semantic,aid in g['attributes'].items():
            a=d['accessors'][aid]
            require(a['count']==position['count'] and a['byteOffset']%4==0,'invalid-geometry',aid,'Vertex counts/alignment differ')
            if semantic=='NORMAL':require(a['components']==3 and a['component'] in ('f32','f64'),'invalid-geometry',aid,'Invalid NORMAL')
            if semantic=='COLOR_0':require(a['components'] in (3,4) and a['component'] in ('f32','f64','u8') and (a['component']!='u8' or a['normalized']),'invalid-geometry',aid,'Invalid color')
            blob=raw[a['bufferId']];code,width=COMPONENTS[a['component']];element=width*a['components']
            if a.get('byteStride',element)==element:
                column=_column_values(a,blob);require(column is not None,'invalid-buffer',aid,'Accessor window overflow')
                if a['component'].startswith('f'):require(all(map(math.isfinite,column)),'invalid-geometry',aid,'Non-finite attribute')
                if semantic=='POSITION':
                    for axis in range(a['components']):require(min(column[axis::a['components']])>=low[axis] and max(column[axis::a['components']])<=high[axis],'invalid-geometry',key,'Bounds do not contain vertices')
            else:
                for row in values(a,blob):
                    require(all(math.isfinite(v) for v in row),'invalid-geometry',aid,'Non-finite attribute')
                    if semantic=='POSITION':require(all(lo<=v<=hi for lo,v,hi in zip(low,row,high)),'invalid-geometry',key,'Bounds do not contain vertices')
        primitive_ids=set()
        for p in g['primitives']:
            require(p['id'] not in primitive_ids,'invalid-reference',key,'Duplicate primitive');primitive_ids.add(p['id'])
            first,count=p['range']['first'],p['range']['count'];limit=position['count']
            if 'indices' in p:
                require(p['indices'] in d['accessors'],'invalid-reference',key,'Missing indices')
                a=d['accessors'][p['indices']];limit=a['count']
                require(a['component'] in ('u8','u16','u32') and a['components']==1 and not a['normalized'] and a.get('byteStride',COMPONENTS[a['component']][1])==COMPONENTS[a['component']][1],'invalid-geometry',key,'Invalid indices type')
            require(first+count<=limit and count%{'triangles':3,'lines':2,'points':1}[p['topology']]==0,'invalid-geometry',key,'Primitive range/arity')
            if 'indices' in p:
                blob=raw[a['bufferId']];code,width=COMPONENTS[a['component']];start=a['byteOffset']+first*width
                window=memoryview(blob)[start:start+count*width].cast(code)
                require(len(window)==count and (not window or max(window)<position['count']),'invalid-geometry',key,'Index exceeds vertex count')
    for key,r in d['representations'].items():
        require(r['id']==key and len({b['id'] for b in r['bindings']})==len(r['bindings']),'invalid-reference',key,'Representation identity/binding collision')
        for b in r['bindings']:
            affine(b['localFromRepresentation'],key)
            require(b['geometryId'] in d['geometries'] and all(mid in d['materials'] for mid in b['materialSlots'].values()),'invalid-reference',key,'Missing geometry/material')
            for p in d['geometries'][b['geometryId']]['primitives']:
                if 'materialSlot' in p:require(p['materialSlot'] in b['materialSlots'],'invalid-reference',key,'Unbound material slot')
    active=set();stack=list(s['sceneRoots'])
    require(len(stack)==len(set(stack)),'invalid-reference','snapshot','Duplicate root')
    children={k:[] for k in d['sceneOccurrences']}
    for k,n in d['sceneOccurrences'].items():
        if n['parentId'] is not None:children[n['parentId']].append(k)
    for root in stack:require(root in children and d['sceneOccurrences'][root]['parentId'] is None,'invalid-reference','snapshot','Invalid scene root')
    while stack:
        key=stack.pop();active.add(key);stack.extend(children[key])
    for key,over in s['occurrenceOverrides'].items():
        require(key in d['sceneOccurrences'],'invalid-reference','snapshot','Unknown override target')
        if 'localFromParent' in over:affine(over['localFromParent'],key)
        if 'representationId' in over:require(over['representationId'] in d['representations'],'invalid-reference',key,'Missing override representation')
    expected=set()
    for key in active:
        n=d['sceneOccurrences'][key];rid=s['occurrenceOverrides'].get(key,{}).get('representationId',n.get('representationId'))
        if rid:
            for b in d['representations'][rid]['bindings']:
                for p in d['geometries'][b['geometryId']]['primitives']:expected.add((key,b['id'],p['id']))
    actual=set()
    for key,draw in s['draws'].items():
        triple=(draw['occurrenceId'],draw['bindingId'],draw['primitiveId'])
        require(triple in expected and triple not in actual and draw['materialId'] in d['materials'],'invalid-reference',key,'Invalid or duplicate draw binding')
        actual.add(triple)
    require(actual==expected and set(d['renderOwnership'])==set(s['draws']),'invalid-reference','draws','Draw coverage/ownership mismatch')
    require(all(v is None or v in d['productOccurrences'] for v in d['renderOwnership'].values()),'invalid-reference','ownership','Unknown product occurrence')
    if version=='2.0.0':
        for did,owner in d['renderOwnership'].items():
            if owner is None:continue
            anchors=set(d['productOccurrences'][owner]['sceneAnchorIds']);node=s['draws'][did]['occurrenceId'];chain=set()
            while node is not None:chain.add(node);node=d['sceneOccurrences'][node]['parentId']
            require(bool(anchors & chain),'invalid-reference','ownership','Draw must descend from an owner scene anchor')
    validate_drawing(d)
    require(d['revision']==canonical_sha256({k:v for k,v in d.items() if k!='revision'}),'invalid-revision','document','Revision does not bind content')
    require(s['id']=='snapshot-'+canonical_sha256({k:v for k,v in s.items() if k!='id'}),'invalid-revision','snapshot','Snapshot identity does not bind content')
    return raw

def validate_drawing_projection(d,projection):
    """Resolved 2D projection: schema shape plus cross-reference and coverage checks."""
    shape(projection,SCHEMA_V2['$defs']['DrawingProjection'],'drawingProjection',root_schema=SCHEMA_V2)
    m=d['drawing']
    require(projection['drawingId'] in m['drawings'],'invalid-reference','drawingProjection','Missing drawing')
    drawing=m['drawings'][projection['drawingId']]
    target=projection['target']
    if target['kind']=='model':
        space=m['spaces'].get(target['spaceId'])
        require(space is not None and space['kind']=='model' and space['drawingId']==projection['drawingId'],'invalid-reference','drawingProjection.target','Invalid model space')
        layout_id=None
    else:
        layout=m['layouts'].get(target['layoutId'])
        require(layout is not None and layout['drawingId']==projection['drawingId'],'invalid-reference','drawingProjection.target','Invalid layout')
        space=m['spaces'][layout['paperSpaceId']];layout_id=layout['id']
    layers=set(drawing['layerIds'])
    extension=d.get('extensions',{}).get('org.cad-preview.drawing-layers/1')
    if extension and extension.get('target')==projection['target']:
        mapping=extension.get('byDraw',{})
        require(set(mapping)==set(projection['draws']),'invalid-reference','drawing-layers/1','Layer map must cover projection draws')
        require(set(mapping.values())<=layers,'invalid-reference','drawing-layers/1','Unknown effective layer')
    require(set(projection['layerStates'])==layers,'invalid-reference','drawingProjection.layerStates','Layer states must cover exactly the drawing layers')
    for vid,viewport in projection['viewports'].items():
        require(vid==viewport['id'],'invalid-reference','drawingProjection.viewports','Viewport identity mismatch')
        require(viewport['layoutId']==layout_id,'invalid-reference',vid,'Viewport belongs to another layout')
        require(viewport['sourceSpaceId'] in m['spaces'] and m['spaces'][viewport['sourceSpaceId']]['kind']=='model','invalid-reference',vid,'Viewport source space is not a model space')
        require(set(viewport['frozenLayerIds'])<=layers and set(viewport['layerOverrides'])<=layers,'invalid-reference',vid,'Viewport references unknown layer')
        if viewport.get('projection')=='orthographic':affine(viewport['modelToPaper'],vid)
        for point in viewport['clipBoundary']:require(len(point)==2,'invalid-reference',vid,'Clip boundary is not 2D')
    entities,annotations,instances=m['entities'],m['annotations'],m['blockInstances']
    draw_orders={}
    for draw in projection['draws'].values():
        order=draw['drawOrder']
        draw_orders[order]=draw_orders.get(order,0)+1
    seen=set()
    for draw_id,draw in projection['draws'].items():
        require(draw_id not in seen,'invalid-reference','drawingProjection.draws','Duplicate draw identity');seen.add(draw_id)
        require(draw_orders[draw['drawOrder']]==1,'invalid-reference',draw_id,'Duplicate draw order')
        require(draw['itemId'] in (entities if draw['kind']=='entity' else annotations),'invalid-reference',draw_id,'Missing draw item')
        require(draw['localToSpace'],'invalid-reference',draw_id,'Missing transform')
        affine(draw['localToSpace'],draw_id)
        visibility_layers=draw.get('visibilityLayerIds',[])
        require(set(visibility_layers)<=layers and len(set(visibility_layers))==len(visibility_layers),
                'invalid-reference',draw_id,'Unknown or duplicate visibility layer')
        if 'viewportId' in draw:
            require(draw['viewportId'] in projection['viewports'],'invalid-reference',draw_id,'Unknown viewport')
            require(layout_id is not None,'invalid-reference',draw_id,'Model projection must not carry a viewport')
        if draw['kind']=='entity':
            item=entities[draw['itemId']]
            expected='unsupported' if item['geometry']['type']=='unsupported' else draw['availability']
            require(expected=='unsupported' or expected in ('ready','missing-reference'),'invalid-reference',draw_id,'Availability contradicts geometry')
            if item['geometry']['type']=='unsupported' and draw['availability']!='unsupported':
                # Analytic LEADER semantics are outside Entity's union. Only a
                # complete, explicit display derivative can make that draw ready.
                entry=d.get('extensions',{}).get('org.cad-preview.annotation-presentation/1',{}).get('items',{}).get(draw['itemId'],{})
                require(draw['availability']=='ready' and entry.get('status')=='ready' and entry.get('parts'),
                        'invalid-reference',draw_id,'Unsupported geometry has no complete presentation')
                for part in entry['parts']:
                    require(part.get('representationId') in d['representations'] or valid_infinite_part(part,entry),
                            'invalid-reference',draw_id,'Missing annotation presentation part')
        else:
            require(draw['availability']!='unsupported','invalid-reference',draw_id,'Mapped annotation cannot be unsupported')
        if 'displayRepresentationId' in draw:
            representation=d.get('representations',{}).get(draw['displayRepresentationId'])
            require(representation is not None and representation['kind']=='drawing','invalid-reference',draw_id,'Missing drawing representation')
        style=draw['style']
        if 'lineTypeId' in style:require(style['lineTypeId'] in m['lineTypes'],'invalid-reference',draw_id,'Unknown line type')
        if 'fontResourceId' in style:require(style['fontResourceId'] in d['resources'],'invalid-reference',draw_id,'Unknown font resource')
        owner_space=(projection['viewports'][draw['viewportId']]['sourceSpaceId']
                     if 'viewportId' in draw else space['id'])
        for depth,step in enumerate(draw['blockPath']):
            require(step['instanceId'] in instances,'invalid-reference',draw_id,'Unknown block instance')
            instance=instances[step['instanceId']]
            require(instance['ownerSpaceId']==owner_space,'invalid-reference',draw_id,'Block path does not follow block spaces')
            array=instance.get('array')
            rows=array['rows'] if array and any(array['rowOffset']) else 1
            columns=array['columns'] if array and any(array['columnOffset']) else 1
            require(0<=step['row']<rows and 0<=step['column']<columns,'invalid-reference',draw_id,'Array placement is outside its instance')
            owner_space=m['blocks'][instance['definitionId']]['spaceId']
        item=(entities if draw['kind']=='entity' else annotations)[draw['itemId']]
        owner=item.get('ownerBlockInstanceId')
        if owner:
            require(bool(draw['blockPath']) and draw['blockPath'][-1]['instanceId']==owner,
                    'invalid-reference',draw_id,'Attached annotation path omits its instance owner')
            require(item['ownerSpaceId']==instances[owner]['ownerSpaceId'],
                    'invalid-reference',draw_id,'Attached annotation has the wrong coordinate space')
        else:
            require(item['ownerSpaceId']==owner_space,'invalid-reference',draw_id,'Draw item does not belong to its block path')
    def items_of(space_id):
        row=m['spaces'][space_id]
        return set(row['entityIds'])|set(row['annotationIds'])|set(row['blockInstanceIds'])
    def walk(space_id,covered,visited):
        for item in items_of(space_id):
            covered.add(item)
            if item in instances and item not in visited:
                visited.add(item)
                walk(m['blocks'][instances[item]['definitionId']]['spaceId'],covered,visited)
    covered=set()
    if layout_id is None:
        walk(space['id'],covered,set())
    else:
        for viewport in projection['viewports'].values():
            if viewport['enabled']:walk(viewport['sourceSpaceId'],covered,set())
        walk(space['id'],covered,set())
    drawn={draw['itemId'] for draw in projection['draws'].values()}
    # Only entity/annotation items can be draw items; every space member must be represented.
    members={item for item in covered if item in entities or item in annotations}
    require(members<=drawn,'invalid-reference','drawingProjection.draws','Projection omits space members')
    require(drawn<=covered,'invalid-reference','drawingProjection.draws','Draw item is not reachable from the target space')

def valid_infinite_part(part,entry):
    if entry.get('mode')!='view-dependent' or part.get('role')!='infinite' or 'representationId' in part:
        return False
    line=part.get('line',{})
    def vector(value):
        return isinstance(value,list) and len(value)==3 and all(isinstance(v,(int,float)) and math.isfinite(v) for v in value)
    return (entry.get('sourceKind') in ('RAY','XLINE') and line.get('kind')==entry['sourceKind'].lower() and vector(line.get('origin'))
            and vector(line.get('direction')) and sum(v*v for v in line['direction'])>1e-24)

def validate_drawing(d):
    """Referential checks for the 2D contract, not a DXF/DWG parser."""
    m=d['drawing']
    fills=d.get('extensions',{}).get('org.cad-preview.fill/1',{}).get('fills',{})
    for item_id,fill in fills.items():
        if 'rings' in fill:
            require(item_id in m['entities'] and m['entities'][item_id]['geometry']['type']=='hatch',
                    'invalid-reference',item_id,'Retained fill has no hatch')
            require(fill.get('fillRule') in ('even-odd','nonzero') and len(fill['rings'])>0,
                    'invalid-geometry',item_id,'Invalid retained fill rule/rings')
            require(all(len(ring)>=3 and all(len(point)==3 and all(type(v) in (int,float) and math.isfinite(v) for v in point)
                    for point in ring) for ring in fill['rings']), 'invalid-geometry',item_id,'Invalid retained fill coordinates')
        gradient=fill.get('gradient')
        if gradient is None:continue
        require(item_id in m['entities'] and m['entities'][item_id]['geometry']['type']=='hatch',
                'invalid-reference',item_id,'Gradient has no hatch')
        require(gradient.get('profile')=='truedxf-gradient-field/1' and gradient.get('shift') in (0,1)
                and gradient.get('name') in ('LINEAR','CYLINDER','INVCYLINDER','SPHERICAL','INVSPHERICAL',
                                               'HEMISPHERICAL','INVHEMISPHERICAL','CURVED','INVCURVED'),
                'invalid-geometry',item_id,'Unknown gradient field')
        colors=gradient.get('colors',[])
        require(len(colors)==2 and all(len(c)==3 and all(type(v)==int and 0<=v<=255 for v in c) for c in colors),
                'invalid-geometry',item_id,'Invalid gradient stops')
        for field in ('domain','frameBounds'):
            bounds=gradient.get(field,[])
            require(len(bounds)==4 and all(type(v) in (int,float) and math.isfinite(v) for v in bounds)
                    and bounds[0]<bounds[2] and bounds[1]<bounds[3], 'invalid-geometry',item_id,'Invalid gradient bounds')
        require(type(gradient.get('angleRadians')) in (int,float) and math.isfinite(gradient['angleRadians']),
                'invalid-geometry',item_id,'Invalid gradient angle')
        require(len(gradient.get('localToOwner',[]))==16,'invalid-matrix',item_id,'Missing gradient basis')
        affine(gradient['localToOwner'],item_id)
    presentations=d.get('extensions',{}).get('org.cad-preview.annotation-presentation/1',{}).get('items',{})
    for item_id,entry in presentations.items():
        require(item_id in m['entities'] or item_id in m['annotations'],'invalid-reference',item_id,'Missing annotation source item')
        require(entry.get('status') in ('ready','missing'),'invalid-reference',item_id,'Unknown annotation presentation status')
        parts=entry.get('parts',[])
        require(bool(parts)==(entry['status']=='ready'),'invalid-reference',item_id,'Incomplete annotation presentation')
        for context in entry.get('scaleVariants',[]):
            require(context.get('status') in ('ready','missing'),'invalid-reference',item_id,'Unknown annotation context status')
            require(bool(context.get('parts'))==(context['status']=='ready'),'invalid-reference',item_id,'Incomplete annotation context presentation')
            require(type(context.get('drawingPerPaper')) in (int,float) and context['drawingPerPaper']>0,'invalid-geometry',item_id,'Invalid annotation scale')
        parts=parts+[part for context in entry.get('scaleVariants',[]) for part in context.get('parts',[])]
        seen_parts=set()
        for part in parts:
            require(part['id'] not in seen_parts,'invalid-reference',item_id,'Duplicate annotation part');seen_parts.add(part['id'])
            representation=d['representations'].get(part.get('representationId'))
            require((representation is not None and representation['kind']=='drawing') or valid_infinite_part(part,entry),
                    'invalid-reference',item_id,'Missing annotation representation')
            if 'fillRule' in part:
                require(part['fillRule'] in ('evenodd','nonzero'),'invalid-geometry',item_id,'Unknown presentation fill rule')
            for clip in part.get('clipRegions',[]):
                boundary=clip.get('boundary',[])
                require(type(clip.get('inverted'))==bool and 3<=len(boundary)<=16384,
                        'invalid-geometry',item_id,'Invalid presentation clip')
                require(all(len(point)==2 and all(type(v) in (int,float) and math.isfinite(v) for v in point) for point in boundary),
                        'invalid-geometry',item_id,'Invalid presentation clip points')
            for context in part.get('plotVariants',{}).values():
                for variant in context.values():
                    require(variant.get('status') in ('ready','missing'),'invalid-reference',item_id,'Unknown plot presentation status')
                    require(variant['status']=='ready' or not variant.get('parts'),'invalid-reference',item_id,'Failed plot variant has geometry')
                    for child in variant.get('parts',[]):
                        require(child.get('representationId') in d['representations'],'invalid-reference',item_id,'Missing plot representation')
            variants=list(part.get('lineTypeVariants',{}).items())+[(variant.get('lineTypeId'),variant) for variant in part.get('drawVariants',{}).values()]
            for line_type,variant in variants:
                require(line_type in m['lineTypes'],'invalid-reference',item_id,'Missing presentation linetype')
                require(variant.get('status') in ('ready','missing'),'invalid-reference',item_id,'Unknown linetype presentation status')
                require(variant['status']=='ready' or not variant.get('parts'),'invalid-reference',item_id,'Failed linetype has geometry')
                for child in variant.get('parts',[]):
                    require(child.get('representationId') in d['representations'],'invalid-reference',item_id,'Missing linetype representation')
                    require(child.get('fillRule','evenodd') in ('evenodd','nonzero'),'invalid-geometry',item_id,'Unknown linetype fill rule')
            for row in [part]+part['ancestors']:
                require(row['layerId'] in m['layers'],'invalid-reference',item_id,'Missing annotation part layer')
                validate_style(row['style'],m,item_id)
    for table in m.values():
        for key,row in table.items():require(key==row['id'],'invalid-reference','drawing','Identity mismatch')
    for drawing in m['drawings'].values():
        require(drawing['modelSpaceId'] in m['spaces'] and m['spaces'][drawing['modelSpaceId']]['kind']=='model','invalid-reference','drawing','Missing model space')
        for field,tab in [('sheetIds','sheets'),('layoutIds','layouts'),('layerIds','layers')]:require(set(drawing[field])<=set(m[tab]),'invalid-reference','drawing','Missing '+tab)
    member_tables={tab:set(m[tab]) for tab in ('entities','annotations','blockInstances')}
    space_members={}
    for space in m['spaces'].values():
        require(space['drawingId'] in m['drawings'],'invalid-reference','space','Missing drawing')
        members=space_members[space['id']]={}
        for field,tab in [('entityIds','entities'),('annotationIds','annotations'),('blockInstanceIds','blockInstances')]:
            members[field]=set(space[field])
            require(members[field]<=member_tables[tab] and len(space[field])==len(members[field]),'invalid-reference','space','Missing/duplicate members')
            require(all(m[tab][key]['ownerSpaceId']==space['id'] for key in space[field]),'invalid-reference','space','Wrong member owner')
    for tab in ('entities','annotations','blockInstances'):
        for item in m[tab].values():
            owner=item['ownerSpaceId'];require(owner in m['spaces'] and item['layerId'] in m['layers'],'invalid-reference',tab,'Missing owner/layer')
            field={'entities':'entityIds','annotations':'annotationIds','blockInstances':'blockInstanceIds'}[tab]
            require(item['id'] in space_members[owner][field] and m['layers'][item['layerId']]['drawingId']==m['spaces'][owner]['drawingId'],'invalid-reference',tab,'Wrong drawing/member relation')
            if tab=='entities':
                require(item['drawingId']==m['spaces'][owner]['drawingId'],'invalid-reference',tab,'Wrong drawing');affine(item['localFromOwner'],item['id'])
                g=item['geometry'];t=g['type']
                if t=='polyline':
                    count=len(g['points']) if g['closed'] else len(g['points'])-1
                    require(len(g['bulges'])==count,'invalid-geometry',item['id'],'Bulge segment count')
                    if 'widths' in g:
                        require(len(g['widths'])==count and all(len(pair)==2 and all(type(v) in (int,float) and math.isfinite(v) and v>=0 for v in pair) for pair in g['widths']),
                                'invalid-geometry',item['id'],'Invalid segment widths')
                if t=='spline':
                    if g.get('fitPointsOnly'):
                        # R13/R14-era splines can store only fit points; the NURBS
                        # dimension rules apply to the control-polygon form.
                        require(len(g['controlPoints'])==0 and len(g.get('fitPoints') or [])>=2,'invalid-geometry',item['id'],'Fit-point spline dimensions')
                    else:
                        require(g['degree']<len(g['controlPoints']) and len(g['weights'])==len(g['controlPoints']) and len(g['knots'])==len(g['controlPoints'])+g['degree']+1 and g['knots']==sorted(g['knots']),'invalid-geometry',item['id'],'Spline dimensions/knots')
                if t=='hatch':require(set(g['boundaryEntityIds'])<=member_tables['entities'],'invalid-reference',item['id'],'Missing hatch boundary')
                if t=='image':require(g['resourceId'] in d['resources'],'invalid-reference',item['id'],'Missing image')
            elif tab=='annotations':
                require(set(item['associativeEntityIds']+item['presentationEntityIds'])<=member_tables['entities'],'invalid-reference',item['id'],'Missing annotation entities')
                instance_id=item.get('ownerBlockInstanceId')
                if instance_id:
                    instance=m['blockInstances'].get(instance_id)
                    require(instance is not None and instance['ownerSpaceId']==owner,
                            'invalid-reference',item['id'],'Attached annotation must share its instance owner space')
            else:
                require(item['definitionId'] in m['blocks'],'invalid-reference',item['id'],'Missing block');affine(item['localFromBlock'],item['id'])
            if 'style' in item:validate_style(item['style'],m,item['id'])
            if 'fontResourceId' in item:require(item['fontResourceId'] in d['resources'],'invalid-reference',item['id'],'Missing font')
    for sheet in m['sheets'].values():
        require(sheet['drawingId'] in m['drawings'] and set(sheet['layoutIds'])<=set(m['layouts']),'invalid-reference','sheet','Missing drawing/layout')
        w,h=sheet['paperSize'];l,b,r,t=sheet['margins'];require(w>0 and h>0 and min(l,b,r,t)>=0 and l+r<=w and b+t<=h,'invalid-geometry','sheet','Paper size/margins')
        if 'plotStyleId' in sheet:require(sheet['plotStyleId'] in m['plotStyles'],'invalid-reference','sheet','Missing plot style')
    for layout in m['layouts'].values():
        require(layout['drawingId'] in m['drawings'] and layout['paperSpaceId'] in m['spaces'] and m['spaces'][layout['paperSpaceId']]['kind']=='paper' and set(layout['viewportIds'])<=set(m['viewports']),'invalid-reference','layout','Invalid paper space/viewports')
        if 'sheetId' in layout:require(layout['sheetId'] in m['sheets'],'invalid-reference','layout','Missing sheet')
        affine(layout['paperToSheet'],layout['id'])
    for v in m['viewports'].values():
        require(v['layoutId'] in m['layouts'] and v['sourceSpaceId'] in m['spaces'] and set(v['frozenLayerIds'])<=set(m['layers']) and set(v['layerOverrides'])<=set(m['layers']),'invalid-reference','viewport','Missing layout/space/layer')
        if v['projection']=='orthographic':affine(v['modelToPaper'],v['id'])
        else:
            affine(v['camera']['worldToView'],v['id']);affine(v['camera']['ndcToPaper'],v['id'])
        for style in v['layerOverrides'].values():validate_style(style,m,v['id'])
        if 'clipEntityId' in v:require(v['clipEntityId'] in m['entities'],'invalid-reference','viewport','Missing clip entity')
        if 'modelReference' in v:
            model=v['modelReference']
            require(model['sourceRef']['sourceId'] in {a['id'] for a in d['sources']},'invalid-reference',v['id'],'Missing drawing view source')
            if 'externalReferenceId' in model:require(model['externalReferenceId'] in {r['id'] for r in d['externalReferences']},'invalid-reference',v['id'],'Missing drawing view dependency')
            if 'sourceSceneOccurrenceId' in model:require(model['sourceSceneOccurrenceId'] in d['sceneOccurrences'],'invalid-reference',v['id'],'Missing model anchor')
            if 'parentViewportId' in model:require(model['parentViewportId'] in m['viewports'] and model['parentViewportId']!=v['id'],'invalid-reference',v['id'],'Invalid parent view')
    for layer in m['layers'].values():
        require(layer['drawingId'] in m['drawings'],'invalid-reference','layer','Missing drawing');validate_style(layer['defaultStyle'],m,layer['id'])
    for style in m['textStyles'].values():require(style['fontResourceId'] in d['resources'],'invalid-reference','textStyles','Missing font')
    for style in m['plotStyles'].values():
        if 'resourceId' in style:require(style['resourceId'] in d['resources'],'invalid-reference','plotStyles','Missing resource')
    edges={key:[] for key in m['blocks']}
    for key,b in m['blocks'].items():
        require(b['drawingId'] in m['drawings'] and b['spaceId'] in m['spaces'] and m['spaces'][b['spaceId']]['kind']=='block','invalid-reference','blocks','Missing block space')
        edges[key]=[m['blockInstances'][i]['definitionId'] for i in m['spaces'][b['spaceId']]['blockInstanceIds']]
    visited=set()
    def visit(key,ancestors):
        require(key not in ancestors and len(ancestors)<256,'invalid-reference','blocks','Block cycle/depth')
        if key in visited:return
        for child in edges[key]:visit(child,ancestors|{key})
        visited.add(key)
    for key in edges:visit(key,set())

def validate_style(style,model,path):
    if 'lineTypeId' in style:require(style['lineTypeId'] in model['lineTypes'],'invalid-reference',path,'Missing line type')
    require(style['color']['mode']!='explicit' or 'rgba' in style['color'],'invalid-reference',path,'Explicit color requires RGBA')


def validate_v2(e):
    d,s=e['document'],e['snapshot']
    require(s['schemaVersion']=='2.0.0','invalid-reference','snapshot','Version mismatch')
    evidence={x['id']:x for x in d['evidence']}
    require(len(evidence)==len(d['evidence']),'invalid-reference','evidence','Duplicate evidence')
    contexts={c['id']:c for c in d['viewContexts']};configs={c['id']:c for c in d['configurations']}
    require(len(contexts)==len(d['viewContexts']),'invalid-reference','viewContexts','Duplicate context')
    for c in contexts.values():
        if c['origin']=='source-configuration':require(c['configurationId'] in configs,'invalid-reference','viewContexts','Missing source configuration')
    def selection(v):
        require(v['viewContextId'] in contexts,'invalid-reference','selection','Missing view context')
        if 'displayStateId' in v:
            config=contexts[v['viewContextId']].get('configurationId')
            states={x['id']:x for x in d['displayStates']}
            require(config in configs and v['displayStateId'] in configs[config]['stateIds'] and v['displayStateId'] in states and config in states[v['displayStateId']]['configurationIds'],'invalid-reference','selection','Display state requires associated source configuration')
    selection(s['selection'])
    if 'value' in d['defaultSelection']:selection(d['defaultSelection']['value'])
    def walk(v,path):
        if isinstance(v,dict):
            if 'knowledge' in v and 'evidenceIds' in v:
                require(set(v['evidenceIds'])<=set(evidence),'invalid-reference',path,'Fact evidence missing')
                require(v['knowledge']!='hypothesis' or v['validation']!='verified-scope','invalid-fact',path,'Hypothesis cannot be verified')
            for k,a in v.items():
                if k not in ('extensions',):walk(a,path+'/'+k)
        elif isinstance(v,list):
            for i,a in enumerate(v):walk(a,path+'/'+str(i))
    walk(d,'document')
    for c in d['capabilities']:
        require(c['validation']!='verified-scope' or (c['implementation']=='implemented' and c['mechanism'] not in ('unknown','hypothesis') and c['evidenceIds']),'invalid-capability',c['feature'],'Verified capability needs implementation and evidence')
        require(c['implementation'] not in ('unsupported','not-implemented') or c['validation'] in ('not-implemented','not-applicable'),'invalid-capability',c['feature'],'Unimplemented capability cannot be validated')
    coords=d['coordinates']
    require(coords['space']!='metric' or coords['lengthUnit']['knowledge']!='unknown','invalid-fact','coordinates','Metric space needs a known unit')
