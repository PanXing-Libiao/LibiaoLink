"""Lossless representation bridge for the existing single-configuration EASM packet.

No product identity, units or new HSF behavior is inferred. The legacy converter
remains the source of all CAD results; this module only changes their representation.
"""
import base64
import hashlib
import json
import struct
from pathlib import Path
from .payload_sink import Base64Sink
from .validation import validate_binary_envelope,validate_envelope
try:
    from . import stageprof
except Exception:
    stageprof=None

IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
ROOT=Path(__file__).resolve().parents[1]

def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def digest(value):return hashlib.sha256(canonical(value)).hexdigest()
def identity(kind,value):return kind+'-'+digest(value)
def code_hash():
    files=['convert.py','states.py','evidence-index.json','unified/adapter.py','unified/validation.py','unified/schema/ucd-1.0.schema.json']
    files += ['parser/'+p.name for p in sorted((ROOT/'parser').glob('*.py'))]
    return digest({name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in files})
def unknown():return {'knowledge':'unknown','validation':'not-applicable','evidenceIds':[]}

def from_packet(packet,source_byte_length,sink=None):
    prof=stageprof.profiler() if stageprof else None
    if prof:prof.mark('ucd.from-packet-start',meshDefinitions=len(packet.get('meshes',{})))
    sink=sink or Base64Sink()
    if packet.get('format')!='eDrawings' or packet.get('selection') is not None:
        raise ValueError('UCD首路径仅接入现有单配置EASM；配置/显示状态实验请用旧链路')
    if packet.get('limitations',{}).get('legacy_root_header_footer_length_recovered',0):
        raise ValueError('UCD严格桥接未接入缺少完整原生依据的经验头部恢复')
    source=packet['sourceSHA256'];sid='source-'+source;mesh_rep={}
    d={'schemaVersion':'1.0.0','serializationProfile':'ucd-json-python-sorted/1','documentId':'document-'+source,'revision':'0'*64,
       'sources':[{'id':sid,'name':packet['name'],'sha256':source,'byteLength':source_byte_length,'format':'EASM'}],
       'adapter':{'id':'easm-packet-bridge','version':'1.0.0','implementationHash':code_hash(),'ruleSetHash':hashlib.sha256((ROOT/'parser-provenance.json').read_bytes()).hexdigest(),'dependencies':[]},
       'coordinates':{'space':'source-unknown','lengthUnit':unknown(),'handedness':unknown(),'upAxis':unknown(),'sourceToDocument':IDENTITY,'conversionReason':'Preserve existing source coordinates exactly'},
       'products':{},'productOccurrences':{},'productRoots':[],'sceneOccurrences':{},'renderOwnership':{},'representations':{},'geometries':{},'accessors':{},'buffers':{},'resources':{},'materials':{},
       'configurations':[{'id':'configuration-0','sourceKey':packet['selectedConfiguration'],'name':packet['selectedConfiguration'],'stateIds':[],'validation':'candidate'}],
       'displayStates':[],'defaultSelection':{'value':{'configurationId':'configuration-0'},'knowledge':'source-declared','validation':'experimental','evidenceIds':['source-scene']},'properties':{},'externalReferences':[],
       'capabilities':[{'feature':f,'scope':scope,'mechanism':mechanism,'implementation':status,'evidenceIds':['source-scene'],'limitations':limits} for f,scope,mechanism,status,limits in [
           ('scene-geometry-placement-visibility','Existing single-configuration packet; acceptance is input-specific','native-confirmed','candidate',['Does not restore empty branches already omitted by legacy packet','Source color and normals fidelity not accepted']),
           ('product-structure','No business component mapping','unknown','unsupported',['Scene occurrences are not CAD products']),
           ('configurations-display-states','UCD route excludes experimental states','unknown','unsupported',['Use legacy experimental route for research'])]],
       'diagnostics':[],'evidence':[{'id':'source-scene','kind':'native','reference':'native-hierarchy-evidence.json; native-version-coverage.json; native-render-lock-field-verification.json','scope':'Existing HSF mechanism; no new grammar or product semantics'}],
       'drawing':{name:{} for name in ['drawings','spaces','sheets','layouts','viewports','entities','annotations','blocks','blockInstances','layers','lineTypes','textStyles','plotStyles','hatchPatterns']},
       'extensions':{'org.cad-preview.easm.packet/1':{'statistics':packet['stats'],'limitations':packet.get('limitations',{}),'identityStability':'document-revision','legacyRootId':packet['root']['id']}},'extensionsRequired':[]}
    evidence=json.loads((ROOT/'evidence-index.json').read_text())
    d['evidence'][0].update({key:evidence[key] for key in ('version','binaryHashes','artifacts')})
    def source_ref(path,**extra):return {'sourceId':sid,'path':path,**extra}
    def accessor(encoded,component,components,count,normalized=False):
        raw=encoded if isinstance(encoded,(bytes,bytearray)) else base64.b64decode(encoded,validate=True);h=hashlib.sha256(raw).hexdigest();bid='buffer-'+h
        d['buffers'][bid]={'id':bid,'sha256':h,'byteLength':len(raw),'endianness':'little','alignment':4,'storage':{'kind':'resource','resourceId':bid}};sink.put(bid,raw)
        a={'bufferId':bid,'byteOffset':0,'byteLength':len(raw),'component':component,'components':components,'count':count,'normalized':normalized};aid=identity('accessor',a);d['accessors'][aid]=a
        return aid,raw
    for path,mesh in packet['meshes'].items():
        gid=identity('geometry',[source,path]);rid=identity('representation',[source,path]);mesh_rep[path]=rid
        position,raw=accessor(mesh['positions'],'f32',3,mesh['vertices']);indices,_=accessor(mesh['indices'],'u32',1,mesh['triangles']*3)
        low=[float('inf')]*3;high=[-float('inf')]*3
        for point in struct.iter_unpack('<fff',raw):
            for j,v in enumerate(point):low[j]=min(low[j],v);high[j]=max(high[j],v)
        attrs={'POSITION':position}
        if 'colors' in mesh:attrs['COLOR_0']=accessor(mesh['colors'],'u8',3,mesh['vertices'],True)[0]
        d['geometries'][gid]={'id':gid,'coordinateSpace':'geometry-local','attributes':attrs,'primitives':[{'id':'primitive-0','topology':'triangles','indices':indices,'range':{'first':0,'count':mesh['triangles']*3}}],'bounds':{'min':low,'max':high},'normalOrigin':'recomputed','sourceRefs':[source_ref(path)]}
        d['representations'][rid]={'id':rid,'kind':'tessellation','bindings':[{'id':'binding-0','geometryId':gid,'localFromRepresentation':IDENTITY,'materialSlots':{}}],'sourceRefs':[source_ref(path)]}
    if prof:prof.mark('ucd.geometry-buffers',geometries=len(d['geometries']),buffers=len(d['buffers']),accessors=len(d['accessors']))
    s={'schemaVersion':'1.0.0','id':'pending','documentRevision':'pending','selection':{'configurationId':'configuration-0'},'sceneRoots':[],'occurrenceOverrides':{},'draws':{},'completeness':'candidate','diagnostics':[]}
    def visit(node,parent,chain,order):
        key=identity('scene',[source,chain,node.get('sourcePath'), 'mesh' in node])
        n={'id':key,'parentId':parent,'orderInParent':order,'sourceKind':'mesh-object' if 'mesh' in node else 'group','name':node['name'],'localFromParent':node.get('matrix16',IDENTITY),'sourceRefs':[source_ref(node.get('sourcePath',''),edgeChain=[str(i) for i in chain],legacyId=node['id'])],'propertySetIds':[]}
        if 'mesh' in node:
            n['representationId']=mesh_rep[node['mesh']]
            color=node.get('color',[.48,.51,.55]);mid=identity('material',color)
            d['materials'][mid]={'id':mid,'model':'viewer-default','baseColor':[*color,1],'metallic':.15 if 'colors' in packet['meshes'][node['mesh']] else .25,'roughness':.65 if 'colors' in packet['meshes'][node['mesh']] else .48,'alphaMode':'opaque','origin':'viewer-policy'}
            drawid=identity('draw',[key,'binding-0','primitive-0'])
            s['draws'][drawid]={'occurrenceId':key,'bindingId':'binding-0','primitiveId':'primitive-0','membership':'present','availability':'ready','suppression':'not-represented','visibility':'shown' if node.get('visible',True) else 'hidden','materialId':mid};d['renderOwnership'][drawid]=None
        d['sceneOccurrences'][key]=n
        for i,child in enumerate(node.get('children',[])):visit(child,key,chain+[i],i)
        return key
    s['sceneRoots']=[visit(packet['root'],None,[],0)]
    if prof:prof.mark('ucd.scene-visit',sceneOccurrences=len(d['sceneOccurrences']),draws=len(s['draws']))
    d['revision']=digest({k:v for k,v in d.items() if k!='revision'})
    if prof:prof.mark('ucd.revision-digest',buffers=len(d['buffers']))
    s['documentRevision']=d['revision'];s['id']=identity('snapshot',{k:v for k,v in s.items() if k!='id'})
    envelope={'transportProfile':sink.profile,'document':d,'snapshot':s,'presentation':{k:packet[k] for k in ['name','view','unit','sourceSHA256','stats']}}
    envelope['presentation'].update({'quality':'统一模型验证 · 单配置候选','candidate':True,'note':'产品语义未还原；保留已验证场景/几何/矩阵/源显隐。用户隐藏与源状态分开；此传输仍使用base64，未宣称性能优化。'})
    sink.attach(envelope)
    if isinstance(sink,Base64Sink):validate_envelope(envelope)
    else:validate_binary_envelope(d,s,envelope['presentation'],sink.get)
    if prof:prof.mark('ucd.validation-done',transport=sink.profile)
    return envelope
