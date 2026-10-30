"""Generate the normative UCD 1.0.0 schema; no CAD parsing rules live here."""
import json
from pathlib import Path

def ref(name):return {'$ref':'#/$defs/'+name}
def enum(*values):return {'enum':list(values)}
def arr(item,minimum=0):return {'type':'array','items':item,'minItems':minimum}
def obj(properties,required=None):return {'type':'object','properties':properties,'required':list(properties) if required is None else required,'additionalProperties':False}
def table(item):return {'type':'object','additionalProperties':item}
def vec(n):return {'type':'array','items':{'type':'number'},'minItems':n,'maxItems':n}
ID={'type':'string','minLength':1,'maxLength':256};TEXT={'type':'string'};UINT={'type':'integer','minimum':0,'maximum':9007199254740991};BOOL={'type':'boolean'}
NULLABLE={'anyOf':[ID,{'type':'null'}]};SHA={'type':'string','pattern':'^[0-9a-f]{64}$'}
D={}
D['Fact']=obj({'value':{},'knowledge':enum('native-confirmed','standard-confirmed','official-declared','source-declared','hypothesis','unknown'),'validation':enum('experimental','verified-scope','not-implemented','not-applicable'),'evidenceIds':arr(ID)},['knowledge','validation','evidenceIds'])
D['SourceRef']=obj({'sourceId':ID,'objectKey':TEXT,'path':TEXT,'edgeChain':arr(TEXT),'legacyId':TEXT,'tagIndex':UINT,'recordOffset':UINT},['sourceId'])
D['SourceAsset']=obj({'id':ID,'name':TEXT,'sha256':SHA,'byteLength':UINT,'format':TEXT,'detectedVersion':TEXT},['id','name','sha256','byteLength','format'])
D['Adapter']=obj({'id':ID,'version':TEXT,'implementationHash':SHA,'ruleSetHash':SHA,'dependencies':arr(obj({'name':TEXT,'version':TEXT}))})
D['Capability']=obj({'feature':TEXT,'scope':TEXT,'mechanism':enum('native-confirmed','standard-confirmed','official-declared','unknown','not-applicable'),'implementation':enum('candidate','verified-scope','experimental','unsupported'),'evidenceIds':arr(ID),'limitations':arr(TEXT)})
D['Evidence']=obj({'id':ID,'kind':enum('native','standard','official','independent-test','engineering-contract'),'reference':TEXT,'scope':TEXT,'version':TEXT,'binaryHashes':table(SHA),'artifacts':arr(obj({'reference':TEXT,'sha256':SHA}))},['id','kind','reference','scope'])
D['Diagnostic']=obj({'code':TEXT,'severity':enum('info','warning','error'),'stage':TEXT,'message':TEXT,'sourceRefs':arr(ref('SourceRef'))})
D['Coordinates']=obj({'space':enum('metric','source-unknown'),'lengthUnit':ref('Fact'),'handedness':ref('Fact'),'upAxis':ref('Fact'),'sourceToDocument':vec(16),'conversionReason':TEXT})
D['SceneOccurrence']=obj({'id':ID,'parentId':NULLABLE,'orderInParent':UINT,'sourceKind':enum('group','mesh-object','layer','block','unknown'),'name':TEXT,'localFromParent':vec(16),'representationId':ID,'sourceRefs':arr(ref('SourceRef')),'propertySetIds':arr(ID)},['id','parentId','orderInParent','sourceKind','name','localFromParent','sourceRefs','propertySetIds'])
D['ProductDefinition']=obj({'id':ID,'kind':enum('part','assembly','drawing'),'name':ref('Fact'),'partNumber':ref('Fact'),'representationIds':arr(ID),'propertySetIds':arr(ID),'sourceRefs':arr(ref('SourceRef'))},['id','kind','representationIds','propertySetIds','sourceRefs'])
D['ProductOccurrence']=obj({'id':ID,'definitionId':ID,'parentId':NULLABLE,'orderInParent':UINT,'memberSlotId':TEXT,'sceneAnchorIds':arr(ID),'sourceRefs':arr(ref('SourceRef'))},['id','definitionId','parentId','orderInParent','sceneAnchorIds','sourceRefs'])
D['Accessor']=obj({'bufferId':ID,'byteOffset':UINT,'byteLength':UINT,'component':enum('f32','f64','u8','u16','u32'),'components':{'type':'integer','minimum':1,'maximum':4},'count':UINT,'byteStride':{'type':'integer','minimum':1},'normalized':BOOL},['bufferId','byteOffset','byteLength','component','components','count','normalized'])
D['Primitive']=obj({'id':ID,'topology':enum('triangles','lines','points'),'indices':ID,'range':obj({'first':UINT,'count':UINT}),'materialSlot':TEXT},['id','topology','range'])
D['Geometry']=obj({'id':ID,'coordinateSpace':enum('geometry-local'),'attributes':table(ID),'primitives':arr(ref('Primitive'),1),'bounds':obj({'min':vec(3),'max':vec(3)}),'normalOrigin':enum('source','recomputed','absent'),'sourceRefs':arr(ref('SourceRef'))})
D['Representation']=obj({'id':ID,'kind':enum('tessellation','wire','points','drawing'),'bindings':arr(obj({'id':ID,'geometryId':ID,'localFromRepresentation':vec(16),'materialSlots':table(ID)}),1),'sourceRefs':arr(ref('SourceRef'))})
D['Buffer']=obj({'id':ID,'sha256':SHA,'byteLength':UINT,'endianness':enum('little'),'alignment':enum(1,2,4,8),'storage':obj({'kind':enum('resource'),'resourceId':ID})})
D['Resource']=obj({'id':ID,'sha256':SHA,'byteLength':UINT,'mediaType':TEXT,'role':enum('font','image','opaque','plot-style'),'resourceId':ID})
D['Material']=obj({'id':ID,'model':enum('viewer-default','unlit','pbr','unknown'),'baseColor':vec(4),'metallic':{'type':'number','minimum':0,'maximum':1},'roughness':{'type':'number','minimum':0,'maximum':1},'alphaMode':enum('opaque','blend','mask'),'origin':enum('source','viewer-policy','unknown')})
D['Configuration']=obj({'id':ID,'sourceKey':TEXT,'name':TEXT,'stateIds':arr(ID),'validation':enum('candidate','verified-scope','experimental','unsupported'),'reason':TEXT},['id','sourceKey','name','stateIds','validation'])
D['DisplayState']=obj({'id':ID,'name':TEXT,'configurationIds':arr(ID,1),'validation':enum('candidate','verified-scope','experimental','unsupported'),'reason':TEXT},['id','name','configurationIds','validation'])
D['Selection']=obj({'configurationId':ID,'displayStateId':ID},['configurationId'])
D['PropertySet']=obj({'id':ID,'namespace':TEXT,'values':table(obj({'type':enum('string','number','boolean','quantity'),'value':{},'unit':TEXT,'sourceRefs':arr(ref('SourceRef'))},['type','value','sourceRefs']))})
D['ExternalReference']=obj({'id':ID,'ownerSourceId':ID,'requestedPath':TEXT,'logicalPath':TEXT,'configuration':TEXT,'status':enum('resolved','missing','ambiguous','blocked','embedded'),'resourceId':ID,'expectedIdentity':TEXT,'candidates':arr(ID),'required':BOOL,'reason':TEXT},['id','ownerSourceId','requestedPath','status','required','reason'])
# Drawing geometry is analytic source information, not inferred product structure.
D['Line']=obj({'type':enum('line'),'start':vec(3),'end':vec(3)})
D['Arc']=obj({'type':enum('arc'),'center':vec(3),'normal':vec(3),'xAxis':vec(3),'radius':{'type':'number','exclusiveMinimum':0},'startAngle':{'type':'number'},'sweepAngle':{'type':'number'}})
D['Ellipse']=obj({'type':enum('ellipse'),'center':vec(3),'majorAxis':vec(3),'minorAxis':vec(3),'startAngle':{'type':'number'},'sweepAngle':{'type':'number'}})
D['Polyline']=obj({'type':enum('polyline'),'points':arr(vec(3),2),'closed':BOOL,'bulges':arr({'type':'number'})})
D['Spline']=obj({'type':enum('spline'),'degree':{'type':'integer','minimum':1},'controlPoints':arr(vec(3),0),'knots':arr({'type':'number'}),'weights':arr({'type':'number','exclusiveMinimum':0}),'periodic':BOOL,'fitPointsOnly':BOOL,'fitPoints':arr(vec(3),2)},['type','degree','controlPoints','knots','weights','periodic'])
D['Point']=obj({'type':enum('point'),'position':vec(3)})
D['Hatch']=obj({'type':enum('hatch'),'boundaryEntityIds':arr(ID,1),'fillRule':enum('even-odd','nonzero'),'patternId':ID,'scale':{'type':'number','exclusiveMinimum':0},'angle':{'type':'number'}},['type','boundaryEntityIds','fillRule'])
D['Image']=obj({'type':enum('image'),'resourceId':ID,'pixelSize':vec(2),'imageToEntity':vec(16),'clipBoundary':arr(vec(2))})
D['UnsupportedEntity']=obj({'type':enum('unsupported'),'sourceType':TEXT,'opaqueResourceId':ID,'reason':TEXT},['type','sourceType','reason'])
D['Entity']=obj({'id':ID,'drawingId':ID,'ownerSpaceId':ID,'layerId':ID,'localFromOwner':vec(16),'geometry':{'oneOf':[ref(n) for n in ['Line','Arc','Ellipse','Polyline','Spline','Point','Hatch','Image','UnsupportedEntity']]},'style':ref('EntityStyle'),'sourceRefs':arr(ref('SourceRef')),'displayOrder':UINT})
D['EntityStyle']=obj({'color':obj({'mode':enum('explicit','by-layer','by-block','unknown'),'rgba':vec(4)},['mode']),'lineTypeId':ID,'lineWeight':ref('Fact'),'opacity':ref('Fact'),'plot':BOOL},['color','plot'])
D['Drawing']=obj({'id':ID,'name':TEXT,'sourceIds':arr(ID,1),'modelSpaceId':ID,'sheetIds':arr(ID),'layoutIds':arr(ID),'layerIds':arr(ID),'units':ref('Fact')})
D['Space']=obj({'id':ID,'drawingId':ID,'kind':enum('model','paper','block'),'ownerId':ID,'entityIds':arr(ID),'annotationIds':arr(ID),'blockInstanceIds':arr(ID)})
D['Sheet']=obj({'id':ID,'drawingId':ID,'name':TEXT,'paperSize':vec(2),'paperUnit':enum('mm','inch','unknown'),'margins':vec(4),'layoutIds':arr(ID),'plotStyleId':ID},['id','drawingId','name','paperSize','paperUnit','margins','layoutIds'])
D['Layout']=obj({'id':ID,'drawingId':ID,'name':TEXT,'sheetId':ID,'paperSpaceId':ID,'viewportIds':arr(ID),'paperToSheet':vec(16)},['id','drawingId','name','paperSpaceId','viewportIds','paperToSheet'])
D['Viewport']=obj({'id':ID,'layoutId':ID,'sourceSpaceId':ID,'modelToPaper':vec(16),'projection':enum('orthographic','perspective'),'clipBoundary':arr(vec(2),3),'clipEntityId':ID,'frontClip':{'type':'number'},'backClip':{'type':'number'},'enabled':BOOL,'frozenLayerIds':arr(ID),'layerOverrides':table(ref('EntityStyle')),'annotationScale':{'type':'number','exclusiveMinimum':0}},['id','layoutId','sourceSpaceId','modelToPaper','projection','clipBoundary','enabled','frozenLayerIds','layerOverrides','annotationScale'])
orthographic=D['Viewport'];orthographic['properties']['projection']=enum('orthographic')
perspective=obj({k:v for k,v in orthographic['properties'].items() if k!='modelToPaper'},[k for k in orthographic['required'] if k!='modelToPaper'])
perspective['properties']['projection']=enum('perspective')
perspective['properties']['camera']=obj({'worldToView':vec(16),'projectionMatrix':vec(16),'ndcToPaper':vec(16)})
perspective['required'].append('camera');D['Viewport']={'oneOf':[orthographic,perspective]}
model_reference=obj({'sourceRef':ref('SourceRef'),'externalReferenceId':ID,'sourceSceneOccurrenceId':ID,'configurationSourceKey':TEXT,'displayStateSourceKey':TEXT,'viewKind':enum('base','projected','section','detail','auxiliary','named'),'parentViewportId':ID,'sectionPlanes':arr(vec(4)),'detailBoundary':arr(vec(2))},['sourceRef','viewKind'])
for branch in D['Viewport']['oneOf']:branch['properties']['modelReference']=model_reference
D['Layer']=obj({'id':ID,'drawingId':ID,'name':TEXT,'visible':BOOL,'frozen':BOOL,'lockedForEditing':BOOL,'plot':BOOL,'defaultStyle':ref('EntityStyle'),'sourceRefs':arr(ref('SourceRef'))})
D['BlockDefinition']=obj({'id':ID,'drawingId':ID,'name':TEXT,'spaceId':ID,'basePoint':vec(3),'units':ref('Fact'),'externalReferenceId':ID,'dynamicParameters':table(ref('Fact'))},['id','drawingId','name','spaceId','basePoint','units','dynamicParameters'])
D['BlockInstance']=obj({'id':ID,'ownerSpaceId':ID,'definitionId':ID,'layerId':ID,'localFromBlock':vec(16),'array':obj({'rows':{'type':'integer','minimum':1},'columns':{'type':'integer','minimum':1},'rowOffset':vec(3),'columnOffset':vec(3)}),'attributes':table(TEXT),'style':ref('EntityStyle'),'sourceRefs':arr(ref('SourceRef'))},['id','ownerSpaceId','definitionId','layerId','localFromBlock','attributes','style','sourceRefs'])
D['Annotation']=obj({'id':ID,'ownerSpaceId':ID,'layerId':ID,'kind':enum('text','mtext','dimension','leader','tolerance','table','symbol','unsupported'),'position':vec(3),'direction':vec(3),'text':TEXT,'fontResourceId':ID,'measuredValue':ref('Fact'),'units':ref('Fact'),'precision':UINT,'associativeEntityIds':arr(ID),'semantic':table(ref('Fact')),'presentationEntityIds':arr(ID),'annotationScales':arr({'type':'number','exclusiveMinimum':0}),'sourceRefs':arr(ref('SourceRef'))},['id','ownerSpaceId','layerId','kind','position','direction','text','associativeEntityIds','semantic','presentationEntityIds','annotationScales','sourceRefs'])
D['LineType']=obj({'id':ID,'name':TEXT,'segments':arr(obj({'kind':enum('dash','gap','dot','text','shape'),'length':{'type':'number','minimum':0},'resourceId':ID},['kind','length'])),'unit':TEXT})
D['TextStyle']=obj({'id':ID,'name':TEXT,'fontResourceId':ID,'height':{'type':'number','minimum':0},'widthFactor':{'type':'number','exclusiveMinimum':0},'obliqueAngle':{'type':'number'}})
D['PlotStyle']=obj({'id':ID,'name':TEXT,'resourceId':ID,'scale':{'type':'number','exclusiveMinimum':0},'rotation':{'type':'number'},'plotHiddenLayers':BOOL},['id','name','scale','rotation','plotHiddenLayers'])
D['HatchPattern']=obj({'id':ID,'name':TEXT,'lines':arr(obj({'angle':{'type':'number'},'origin':vec(2),'offset':vec(2),'dashes':arr({'type':'number'})}))})
D['DrawingModel']=obj({k:table(ref(v)) for k,v in {'drawings':'Drawing','spaces':'Space','sheets':'Sheet','layouts':'Layout','viewports':'Viewport','entities':'Entity','annotations':'Annotation','blocks':'BlockDefinition','blockInstances':'BlockInstance','layers':'Layer','lineTypes':'LineType','textStyles':'TextStyle','plotStyles':'PlotStyle','hatchPatterns':'HatchPattern'}.items()})
D['Document']=obj({'schemaVersion':{'const':'1.0.0'},'documentId':ID,'revision':SHA,'sources':arr(ref('SourceAsset'),1),'adapter':ref('Adapter'),'coordinates':ref('Coordinates'),'products':table(ref('ProductDefinition')),'productOccurrences':table(ref('ProductOccurrence')),'productRoots':arr(ID),'sceneOccurrences':table(ref('SceneOccurrence')),'renderOwnership':table(NULLABLE),'representations':table(ref('Representation')),'geometries':table(ref('Geometry')),'accessors':table(ref('Accessor')),'buffers':table(ref('Buffer')),'materials':table(ref('Material')),'configurations':arr(ref('Configuration'),1),'displayStates':arr(ref('DisplayState')),'defaultSelection':ref('Fact'),'properties':table(ref('PropertySet')),'externalReferences':arr(ref('ExternalReference')),'capabilities':arr(ref('Capability')),'diagnostics':arr(ref('Diagnostic')),'evidence':arr(ref('Evidence')),'drawing':ref('DrawingModel'),'extensions':table({}),'extensionsRequired':arr(TEXT)})
D['Document']['properties']['resources']=table(ref('Resource'))
D['Document']['required'].append('resources')
D['Document']['properties']['serializationProfile']=enum('ucd-json-python-sorted/1','rfc8785')
D['Document']['required'].append('serializationProfile')
D['Draw']=obj({'occurrenceId':ID,'bindingId':ID,'primitiveId':ID,'membership':enum('present','absent','unknown'),'availability':enum('ready','missing-reference','unsupported'),'suppression':enum('active','suppressed','not-represented','unknown'),'visibility':enum('shown','hidden','unknown'),'materialId':ID})
D['Snapshot']=obj({'schemaVersion':{'const':'1.0.0'},'id':ID,'documentRevision':SHA,'selection':ref('Selection'),'sceneRoots':arr(ID),'occurrenceOverrides':table(obj({'localFromParent':vec(16),'representationId':ID},[])),'draws':table(ref('Draw')),'completeness':enum('candidate','verified-scope','partial','experimental'),'diagnostics':arr(ref('Diagnostic'))})
# The contract includes resolved 2D state; the first EASM consumer rejects it.
D['Resolved2DStyle']=obj({'color':vec(4),'opacity':{'type':'number','minimum':0,'maximum':1},'plot':BOOL,'lineWeight':ref('Fact'),'lineTypeId':ID,'fontResourceId':ID},['color','opacity','plot'])
D['DrawingDraw']=obj({'kind':enum('entity','annotation'),'itemId':ID,'blockPath':arr(obj({'instanceId':ID,'row':UINT,'column':UINT})),'viewportId':ID,'localToSpace':vec(16),'visibility':enum('shown','hidden','unknown'),'availability':enum('ready','missing-reference','unsupported'),'style':ref('Resolved2DStyle'),'drawOrder':UINT,'displayRepresentationId':ID},['kind','itemId','blockPath','localToSpace','visibility','availability','style','drawOrder'])
D['DrawingProjection']=obj({'drawingId':ID,'target':{'oneOf':[obj({'kind':enum('model'),'spaceId':ID}),obj({'kind':enum('layout'),'layoutId':ID})]},'viewports':table(ref('Viewport')),'layerStates':table(obj({'visible':BOOL,'frozen':BOOL,'plot':BOOL})),'draws':table(ref('DrawingDraw'))})
D['Snapshot']['properties']['drawingProjection']=ref('DrawingProjection')
D['Envelope']=obj({'transportProfile':{'const':'ucd-base64-envelope/1'},'document':ref('Document'),'snapshot':ref('Snapshot'),'bufferPayloads':table(TEXT),'presentation':obj({'name':TEXT,'view':{'anyOf':[obj({'position':vec(3),'target':vec(3),'up':vec(3)}),{'type':'null'}]},'unit':TEXT,'sourceSHA256':SHA,'note':TEXT,'quality':TEXT,'candidate':BOOL,'stats':table({'anyOf':[TEXT,{'type':'number'},BOOL]})})})
if __name__=='__main__':
    schema={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'urn:cad-preview:ucd:1.0.0','title':'UnifiedCADDocument 1.0.0','$ref':'#/$defs/Document','$defs':D}
    def safe_integers(value):
        if isinstance(value,dict):
            if value.get('type')=='integer':value.setdefault('maximum',9007199254740991)
            for child in value.values():safe_integers(child)
        elif isinstance(value,list):
            for child in value:safe_integers(child)
    safe_integers(schema)
    (Path(__file__).parent/'schema/ucd-1.0.schema.json').write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n')
