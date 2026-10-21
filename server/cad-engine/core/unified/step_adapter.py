"""STEP XDE adapter. Geometry/assembly interpretation belongs to pinned OCCT.

API basis: OCCT V7_8_1 XCAFDoc_ShapeTool (reference labels, component locations),
STEPCAFControl_Reader (XDE transfer), BRep_Tool::Triangulation (face location).
No STEP geometric entities are decoded here. IDs are stable within source SHA +
reader version; label entries are not claimed stable across CAD revisions.
"""
import hashlib,struct,time
from collections import Counter
from pathlib import Path
from .adapter import IDENTITY,identity,digest,unknown
from .migrate import seal
from .payload_sink import Base64Sink
from .validation import validate_binary_envelope,validate_envelope
from . import stageprof
from .step_repair_quality import AREA_POLICY
from .step_external_mesh import ExternalMeshContext,ENGINE as MESH_ENGINE
from .step_name_encoding import name_codepage as check_name_codepage

ENGINE='7.8.1.1'
class PartialPreviewAvailable(ValueError):
    """Strict mode rejected an incomplete STEP; the caller may offer partial preview."""
    def __init__(self,message,details):
        super().__init__(message)
        self.details=details


def read_step(path,sink=None,partial=False,name_codepage='UTF8'):
    """partial=True keeps faces that meshed and records the missing ones as diagnostics.

    The default (strict) path rejects the whole document on a missing face: a partial
    mesh is not the source geometry and must be requested explicitly.
    """
    name_codepage=check_name_codepage(name_codepage)
    sink=sink or Base64Sink()
    import OCP
    if OCP.__version__!=ENGINE:raise ValueError('STEP requires cadquery-ocp=='+ENGINE)
    from OCP.TDocStd import TDocStd_Document
    from OCP.TCollection import TCollection_ExtendedString,TCollection_AsciiString
    from OCP.XCAFDoc import XCAFDoc_DocumentTool,XCAFDoc_ColorSurf,XCAFDoc_ColorGen
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.TDF import TDF_LabelSequence,TDF_Label,TDF_Tool
    from OCP.TDataStd import TDataStd_Name
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRep import BRep_Tool
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE,TopAbs_REVERSED,TopAbs_EDGE,TopAbs_VERTEX,TopAbs_SHELL,TopAbs_SOLID,TopAbs_WIRE
    from OCP.TopoDS import TopoDS
    from OCP.TopLoc import TopLoc_Location
    from OCP.Quantity import Quantity_ColorRGBA
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_TangentialDeflection
    from . import worker_trace
    worker_trace.mark('runtimeReady');worker_trace.mark('parseStart')
    start=time.perf_counter();raw=Path(path).read_bytes();sha=hashlib.sha256(raw).hexdigest();sid='source-'+sha
    stageprof.mark('file-read',bytes=len(raw))
    worker_trace.mark('sourceReadCompleted')
    reader=STEPCAFControl_Reader();Interface_Static.SetCVal_s('xstep.cascade.unit','MM')
    # Official OCCT name decoder. Reset explicitly on every read because
    # Interface_Static is process-global; a preceding GB import must not leak.
    if not Interface_Static.SetCVal_s('read.step.codepage',name_codepage):raise ValueError('STEP name codepage unavailable')
    reader.SetColorMode(True);reader.SetNameMode(True)
    if reader.ReadFile(str(path))!=IFSelect_RetDone:raise ValueError('STEP ReadFile failed')
    model=reader.Reader().WS().Model();stageprof.mark('step-read',entities=model.NbEntities())
    worker_trace.mark('stepReadCompleted')
    types=Counter(model.Value(i).DynamicType().Name() for i in range(1,model.NbEntities()+1));stageprof.mark('entity-inventory',distinctTypes=len(types))
    # Reject before Transfer, which otherwise may resolve files from the local disk.
    from OCP.STEPConstruct import STEPConstruct_ExternRefs
    extern=STEPConstruct_ExternRefs(reader.Reader().WS());extern.LoadExternRefs()
    if extern.NbExternRefs():raise ValueError('unsupported-external-reference: external STEP documents require an upload resource resolver')
    if any('SpecifiedHigherUsageOccurrence' in t or 'ContextDependentOverRidingStyledItem' in t or 'Invisibility' in t or 'PresentationStyleByContext' in t for t in types):raise ValueError('unsupported-state-or-style: SHUO, context-dependent style or source invisibility requires separate acceptance')
    stageprof.mark('pre-transfer-policy')
    doc=TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    if not reader.Transfer(doc):raise ValueError('STEP XDE transfer failed')
    transferred=time.perf_counter();stageprof.mark('transfer')
    worker_trace.mark('xcafTransferCompleted')
    st=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main());ct=XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    evidence=[{'id':'xde','kind':'official','reference':'OCCT V7_8_1 XCAFDoc_ShapeTool, STEPCAFControl_Reader, BRep_Tool','version':ENGINE,'scope':'XDE reference/component placement and tessellation API; input-specific fidelity requires independent checks'},{'id':'policy','kind':'engineering-contract','reference':'unified/step_adapter.py','scope':'mm output unit, default viewing context and tessellation settings'}]
    evidence.append({'id':'name-codepage','kind':'official','reference':'https://github.com/Open-Cascade-SAS/OCCT/blob/V7_8_1/src/STEPControl/STEPControl_Controller.cxx','version':ENGINE,'scope':'read.step.codepage UTF8 default / explicit GB; charset selection is an import option, not a source declaration'})
    external_mesh=ExternalMeshContext()
    def fact(v,policy=False):return {'value':v,'knowledge':'engineering-defined' if policy else 'source-declared','validation':'experimental','evidenceIds':['policy' if policy else 'xde']}
    d={'schemaVersion':'2.0.0','serializationProfile':'ucd-json-python-sorted/1','documentId':'document-'+sha,'revision':'0'*64,'sources':[{'id':sid,'name':Path(path).name,'sha256':sha,'byteLength':len(raw),'format':'STEP'}],
       'adapter':{'id':'occt-xde-step','version':'0.3.3','implementationHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'ruleSetHash':digest({'occt':ENGINE,'nameCodepage':name_codepage,'linearDeflectionMM':.08,'angularDeflectionRadians':.3,'closedFacePartition':1,'surfaceRGBA':1,'nonMeshableAcceptance':'step-nonmeshable/1','displayAreaAcceptance':AREA_POLICY,'combinedRepair':{'enabled':external_mesh.enabled,'gmsh':MESH_ENGINE,'policy':'step-combined-repair/2'}}),'dependencies':[{'name':'cadquery-ocp','version':ENGINE}]},
       'coordinates':{'space':'metric','lengthUnit':fact('mm',True),'handedness':fact('right',True),'upAxis':unknown(),'sourceToDocument':IDENTITY,'conversionReason':'OCCT transfer normalizes length to mm; no model-up direction inferred'},
       'products':{},'productOccurrences':{},'productRoots':[],'sceneOccurrences':{},'renderOwnership':{},'representations':{},'geometries':{},'accessors':{},'buffers':{},'resources':{},'materials':{},'configurations':[],'displayStates':[],
       'viewContexts':[{'id':'view-default','origin':'system-default','name':'Imported STEP scene'}],'defaultSelection':fact({'viewContextId':'view-default'},True),'properties':{},'externalReferences':[],
       'capabilities':[{'feature':feature,'scope':'Pinned XDE adapter; acceptance tied to recorded samples','mechanism':'official-declared','implementation':'implemented','validation':'experimental','evidenceIds':['xde'],'limitations':[]} for feature in ['product-structure','shared-geometry','placement','surface-color']],
       'diagnostics':[],'evidence':evidence,'drawing':{k:{} for k in ['drawings','spaces','sheets','layouts','viewports','entities','annotations','blocks','blockInstances','layers','lineTypes','textStyles','plotStyles','hatchPatterns']},'extensions':{},'extensionsRequired':[]}
    s={'schemaVersion':'2.0.0','id':'pending','documentRevision':'0'*64,'selection':{'viewContextId':'view-default'},'sceneRoots':[],'occurrenceOverrides':{},'draws':{},'completeness':'partial','diagnostics':[]};measurements={};missing_geometry=[];wireframe_products=[];mesh_repairs=[];non_meshable_faces=[]
    def diagnostic(code,message):d['diagnostics'].append({'code':code,'severity':'warning','stage':'mapping','message':message,'sourceRefs':[{'sourceId':sid}]})
    diagnostic('tessellated-preview','BREP topology/analytic surfaces, edge curves, PMI, layers and validation properties are not mapped to UCD core; source bytes and entity inventory remain the audit source. Deflection 0.08 mm / 0.3 rad; no exact geometry claim.')
    for term,code in [('Undefined','unrecognized-step-entities'),('Tolerance','pmi-not-mapped'),('Annotation','annotation-not-mapped'),('PresentationLayer','layers-not-mapped'),('Text','text-not-mapped'),('ExternallyDefined','external-style-not-mapped')]:
        found={k:v for k,v in types.items() if term in k}
        if found:diagnostic(code,str(found))
    def entry(label):
        out=TCollection_AsciiString();TDF_Tool.Entry_s(label,out);return out.ToCString()
    def name(label):
        n=TDataStd_Name();return n.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(),n) else 'Unnamed '+entry(label)
    def refs(label):return [{'sourceId':sid,'objectKey':entry(label),'path':'XCAF/'+entry(label)}]
    def matrix(loc):
        tr=loc.Transformation();return [tr.Value(r,c) if r<4 else (1 if c==4 else 0) for c in range(1,5) for r in range(1,5)]
    def accessor(vals,component,n):
        blob=struct.pack('<'+('f' if component=='f32' else 'I')*len(vals),*vals);h=hashlib.sha256(blob).hexdigest();bid='buffer-'+h
        d['buffers'][bid]={'id':bid,'sha256':h,'byteLength':len(blob),'endianness':'little','alignment':4,'storage':{'kind':'resource','resourceId':bid}};sink.put(bid,blob)
        a={'bufferId':bid,'byteOffset':0,'byteLength':len(blob),'component':component,'components':n,'count':len(vals)//n,'normalized':False};aid=identity('accessor',a);d['accessors'][aid]=a;return aid
    def color(shape):
        # OCCT ColorTool::GetColor(shape,type) repeats ShapeTool::Search for each
        # type. Resolve that exact label once; preserve Surf-before-Gen priority.
        color_label=TDF_Label()
        if not st.Search(shape,color_label):return None
        c=Quantity_ColorRGBA()
        for typ in (XCAFDoc_ColorSurf,XCAFDoc_ColorGen):
            if ct.GetColor_s(color_label,typ,c):
                rgb=c.GetRGB();return [rgb.Red(),rgb.Green(),rgb.Blue(),c.Alpha()]
        return None
    material_cache={}
    def material(rgba):
        cache_key=(tuple(rgba) if rgba is not None else None)
        if cache_key in material_cache:return material_cache[cache_key]
        val=rgba or [.48,.51,.55,1];mid=identity('material',[val,rgba is not None]);d['materials'][mid]={'id':mid,'model':'pbr','baseColor':val,'metallic':0.,'roughness':.65,'alphaMode':'blend' if val[3]<1 else 'opaque','origin':'source' if rgba is not None else 'viewer-policy'};material_cache[cache_key]=mid;return mid
    definitions={}
    def definition(label):
        key=entry(label)
        if key in definitions:return definitions[key]
        pid=identity('product',[sha,key]);definitions[key]=pid;assembly=st.IsAssembly_s(label);shape=st.GetShape_s(label)
        p={'id':pid,'kind':'assembly' if assembly else 'part','name':fact(name(label)),'partNumber':unknown(),'representationIds':[],'propertySetIds':[],'sourceRefs':refs(label)};d['products'][pid]=p
        # Leaf-only audit measurements. BRepGProp on an assembly shape integrates the
        # same leaf faces again at every ancestor level (O(depth x size)); the values
        # are derived audit data, not source CAD semantics, and nothing downstream
        # consumes assembly measurements. Assembly geometry/placement is unaffected.
        if not assembly:
            stageprof.begin_leaf(key,name(label))
            t0=time.perf_counter();props=GProp_GProps();BRepGProp.VolumeProperties_s(shape,props);c=props.CentreOfMass()
            t1=time.perf_counter();area=GProp_GProps();BRepGProp.SurfaceProperties_s(shape,area)
            measurements[pid]={'name':name(label),'volumeMM3':props.Mass(),'areaMM2':area.Mass(),'centroidMM':[c.X(),c.Y(),c.Z()]}
            stageprof.mark('volume-properties-leaf',seconds=round(t1-t0,4))
            stageprof.mark('surface-properties-leaf',seconds=round(time.perf_counter()-t1,4))
        if assembly:return pid
        t0=time.perf_counter();mesher=BRepMesh_IncrementalMesh(shape,.08,False,.3,False);stageprof.mark('brep-mesh',seconds=round(time.perf_counter()-t0,4))
        t0=time.perf_counter();shape_color=color(shape);ex=TopExp_Explorer(shape,TopAbs_FACE);positions=[];indices=[];primitives=[];slots={};faceindex=0;missing=[];excluded=[]
        while ex.More():
            face=TopoDS.Face_s(ex.Current());loc=TopLoc_Location();tri=BRep_Tool.Triangulation_s(face,loc)
            if tri is None or tri.NbTriangles()==0:
                from .step_missing_faces import recover_missing_face,classify_missing_face,is_accepted_nonmeshable
                attempt_start=len(external_mesh.attempts)
                fallback=recover_missing_face(face,external_mesh)
                attempts=external_mesh.attempts[attempt_start:]
                if fallback is not None:
                    offset=len(positions)//3;first=len(indices)
                    for x,y,z in fallback['positions']:positions.extend((x,y,z))
                    indices.extend(offset+index for index in fallback['indices'])
                    slot=str(faceindex);slots[slot]=material(color(face) or shape_color);primitives.append({'id':'face-'+slot,'topology':'triangles','range':{'first':first,'count':len(indices)-first},'materialSlot':slot})
                    repair={'productName':name(label),'productId':pid,'entry':key,'face':faceindex,'triangles':len(fallback['indices'])//3,'rings':fallback['rings'],'areaMM2':fallback['area'],'areaRatio':fallback['areaRatio'],'maxDeviationMM':fallback['maxDeviation'],'trim':fallback['trim'],'reason':fallback.get('reason','pcurve-region-fallback'),'validation':fallback['validation']}
                    if attempts:repair['repairAttempts']=attempts
                    if fallback.get('nativePatchCount'):repair['nativePatchCount']=fallback['nativePatchCount']
                    mesh_repairs.append(repair);diagnostic('face-triangulation-repaired','face tessellated from the source surface because the OCCT mesher rejected the wire: '+name(label)+' face '+str(faceindex))
                    faceindex+=1;ex.Next();continue
                from OCP.BRepAdaptor import BRepAdaptor_Surface
                from OCP.BRepCheck import BRepCheck_Analyzer
                surface=BRepAdaptor_Surface(face).GetType().name
                face_edges=TopExp_Explorer(face,TopAbs_EDGE);edge_count=0
                while face_edges.More():edge_count+=1;face_edges.Next()
                probe=TopExp_Explorer(shape,TopAbs_FACE);missing_faces=0
                while probe.More():
                    if BRep_Tool.Triangulation_s(TopoDS.Face_s(probe.Current()),TopLoc_Location()) is None:missing_faces+=1
                    probe.Next()
                valid=BRepCheck_Analyzer(face).IsValid();tolerance=BRep_Tool.Tolerance_s(face);max_tolerance=BRep_Tool.MaxTolerance_s(face,TopAbs_FACE)
                detail=f'{name(label)} (XCAF entry {key}) face {faceindex}; surface={surface}, valid={valid}, faceToleranceMM={tolerance:.3e}, maxToleranceMM={max_tolerance:.3e}, edges={edge_count}, shapeFacesMissingTriangulation={missing_faces}, meshDone={mesher.IsDone()}, meshStatus={mesher.GetStatusFlags()}'
                record={'productName':name(label),'productId':pid,'entry':key,'face':faceindex,'surface':surface,'valid':valid,'faceToleranceMM':tolerance,'missingFacesInShape':missing_faces,'meshDone':bool(mesher.IsDone()),'meshStatus':int(mesher.GetStatusFlags()),'reason':'face-triangulation-missing'}
                record.update(classify_missing_face(face))
                if attempts:record['repairAttempts']=attempts
                # Only these policy classifications are accepted omissions. A
                # missing-other face still enters the unchanged strict rejection.
                if is_accepted_nonmeshable(record):
                    record.update(acceptedOmission=True,pickable=False,includedInMeasurements=False)
                    non_meshable_faces.append(record);excluded.append(face)
                    faceindex+=1;ex.Next();continue
                if not partial:raise PartialPreviewAvailable('missing-face-triangulation: '+detail+' rejected (strict mode; pass partial=true for a labelled partial preview)',{'category':'face-triangulation-missing','affectedProducts':[name(label)],'entries':[record]})
                missing.append(record);missing_geometry.append(record);faceindex+=1;ex.Next();continue
            offset=len(positions)//3;first=len(indices)
            transform=loc.Transformation();identity_location=loc.IsIdentity();reversed_face=face.Orientation()==TopAbs_REVERSED
            for i in range(1,tri.NbNodes()+1):
                pt=tri.Node(i)
                if not identity_location:pt=pt.Transformed(transform)
                positions.extend(pt.Coord())
            for i in range(1,tri.NbTriangles()+1):
                a,b,c=tri.Triangle(i).Get()
                if reversed_face:b,c=c,b
                indices.extend([offset+a-1,offset+b-1,offset+c-1])
            slot=str(faceindex);slots[slot]=material(color(face) or shape_color);primitives.append({'id':'face-'+slot,'topology':'triangles','range':{'first':first,'count':len(indices)-first},'materialSlot':slot});faceindex+=1;ex.Next()
        stageprof.mark('mesh-extract-leaves',faces=faceindex,vertices=len(positions)//3,triangles=len(indices)//3,seconds=round(time.perf_counter()-t0,4))
        if excluded:
            from OCP.BRep import BRep_Builder
            from OCP.TopoDS import TopoDS_Compound
            retained=TopoDS_Compound();builder=BRep_Builder();builder.MakeCompound(retained)
            kept=TopExp_Explorer(shape,TopAbs_FACE)
            while kept.More():
                face=kept.Current();kept.Next()
                if not any(face.IsSame(item) for item in excluded):builder.Add(retained,face)
            props=GProp_GProps();BRepGProp.SurfaceProperties_s(retained,props)
            # Removing a face does not establish a closed solid. Keep retained
            # source-face area, but withdraw volume/volume-centroid for this part.
            measurements[pid].update(areaMM2=props.Mass(),volumeMM3=None,centroidMM=None,
                                     areaScope='source-faces-excluding-nonmeshable',excludedNonMeshableFaces=len(excluded),
                                     volumeUnavailableReason='nonmeshable faces excluded; closed-volume measurement unavailable')
            diagnostic('nonmeshable-faces-accepted',f'{name(label)}: {len(excluded)} source faces omitted under step-nonmeshable/1; excluded from picking and measurements')
        if missing:diagnostic('face-triangulation-missing','partial preview; faces without triangulation were omitted: '+'; '.join(f"{r['productName']} face {r['face']} ({r['surface']})" for r in missing))
        wireframe=False
        if not positions and not excluded:
            edge_positions=[];edge_indices=[];edge_primitives=[];edge_slots={};edge_index=0;segments=0
            t0=time.perf_counter();edge_explorer=TopExp_Explorer(shape,TopAbs_EDGE)
            while edge_explorer.More():
                edge=TopoDS.Edge_s(edge_explorer.Current());edge_explorer.Next()
                if BRep_Tool.Degenerated_s(edge):continue
                curve=BRepAdaptor_Curve(edge)
                try:discretized=GCPnts_TangentialDeflection(curve,.3,.08)
                except Exception:discretized=None
                if discretized is None or discretized.NbPoints()<2:continue
                first=len(edge_indices);base=len(edge_positions)//3
                for i in range(1,discretized.NbPoints()+1):
                    pt=discretized.Value(i);edge_positions.extend([pt.X(),pt.Y(),pt.Z()])
                for i in range(discretized.NbPoints()-1):edge_indices.extend([base+i,base+i+1])
                slot=str(edge_index);edge_slots[slot]=material(color(shape));edge_primitives.append({'id':'edge-'+slot,'topology':'lines','range':{'first':first,'count':len(edge_indices)-first},'materialSlot':slot});segments+=discretized.NbPoints()-1;edge_index+=1
            stageprof.mark('edge-discretization',edges=edge_index,segments=segments,seconds=round(time.perf_counter()-t0,4))
            if edge_primitives:
                positions,indices,primitives,slots=edge_positions,edge_indices,edge_primitives,edge_slots;wireframe=True
                diagnostic('wireframe-geometry',f'{name(label)} has no faces; {edge_index} edges discretized at 0.08 mm / 0.3 rad into {segments} line segments')
                wireframe_products.append({'productName':name(label),'productId':pid,'edges':edge_index,'segments':segments,'linearDeflectionMM':.08,'angularDeflectionRadians':.3})
        if not positions and excluded:return pid  # Retain the product/tree, with no pickable replacement edges.
        if not positions:
            def count_of(kind):
                explorer=TopExp_Explorer(shape,kind);total=0
                while explorer.More():total+=1;explorer.Next()
                return total
            counts={kind:count_of(kind) for kind in (TopAbs_FACE,TopAbs_EDGE,TopAbs_VERTEX,TopAbs_SHELL,TopAbs_SOLID,TopAbs_WIRE)}
            raise ValueError(f'unsupported-non-surface-product: {name(label)} (XCAF entry {key}, shape {shape.ShapeType()}, faces={counts[TopAbs_FACE]}, shells={counts[TopAbs_SHELL]}, solids={counts[TopAbs_SOLID]}, edges={counts[TopAbs_EDGE]}, wires={counts[TopAbs_WIRE]}, vertices={counts[TopAbs_VERTEX]})')
        t0=time.perf_counter();pa=accessor(positions,'f32',3);ia=accessor(indices,'u32',1)
        # Bounds use the stored float32 values, not pre-rounding doubles.
        pos=struct.unpack('<'+'f'*len(positions),sink.get(d['accessors'][pa]['bufferId']))
        gid=identity('geometry',[sha,key]);rid=identity('representation',[sha,key])
        for primitive in primitives:primitive['indices']=ia
        stageprof.mark('geometry-accessors',seconds=round(time.perf_counter()-t0,4))
        d['geometries'][gid]={'id':gid,'coordinateSpace':'geometry-local','attributes':{'POSITION':pa},'primitives':primitives,'bounds':{'min':[min(pos[i::3]) for i in range(3)],'max':[max(pos[i::3]) for i in range(3)]},'normalOrigin':'recomputed','sourceRefs':refs(label)}
        d['representations'][rid]={'id':rid,'kind':'tessellation','bindings':[{'id':'body','geometryId':gid,'localFromRepresentation':IDENTITY,'materialSlots':slots}],'sourceRefs':refs(label)};p['representationIds']=[rid];stageprof.end_leaf(faces=faceindex,vertices=len(positions)//3,indices=len(indices),positionBytes=len(positions)*4,indexBytes=len(indices)*4);return pid
    def visit(label,parent,sceneparent,chain,order,ancestors):
        ref=TDF_Label();target=ref if st.GetReferredShape_s(label,ref) else label;key=entry(target)
        if key in ancestors or len(chain)>128:raise ValueError('assembly-cycle-or-depth-limit')
        pid=definition(target);oid=identity('product-occurrence',[sha,chain]);nid=identity('scene',[sha,chain]);p=d['products'][pid]
        d['productOccurrences'][oid]={'id':oid,'definitionId':pid,'parentId':parent,'orderInParent':order,'sceneAnchorIds':[nid],'sourceRefs':refs(label)}
        n={'id':nid,'parentId':sceneparent,'orderInParent':order,'sourceKind':'group','name':p['name']['value'],'localFromParent':matrix(st.GetLocation_s(label)),'sourceRefs':refs(label),'propertySetIds':[]};d['sceneOccurrences'][nid]=n
        if p['representationIds']:
            rid=p['representationIds'][0];n['representationId']=rid
            for b in d['representations'][rid]['bindings']:
                for prim in d['geometries'][b['geometryId']]['primitives']:
                    did=identity('draw',[nid,b['id'],prim['id']]);s['draws'][did]={'occurrenceId':nid,'bindingId':b['id'],'primitiveId':prim['id'],'membership':'present','availability':'ready','suppression':'not-represented','visibility':'shown','materialId':b['materialSlots'][prim['materialSlot']]};d['renderOwnership'][did]=oid
        seq=TDF_LabelSequence();st.GetComponents_s(target,seq)
        for i in range(1,seq.Length()+1):visit(seq.Value(i),oid,nid,chain+[entry(seq.Value(i))],i-1,ancestors|{key})
        return oid,nid
    roots=TDF_LabelSequence();st.GetFreeShapes(roots)
    for i in range(1,roots.Length()+1):
        label=roots.Value(i);oid,nid=visit(label,None,None,[entry(label)],i-1,set());d['productRoots'].append(oid);s['sceneRoots'].append(nid)
    stageprof.mark('structure-build',definitions=len(d['products']),occurrences=len(d['productOccurrences']),draws=len(s['draws']))
    worker_trace.mark('geometryExtractionCompleted')
    if not d['geometries']:raise ValueError('No surface geometry imported')
    if external_mesh.used:d['adapter']['dependencies'].append({'name':'gmsh','version':MESH_ENGINE})
    has_wireframe=any(p['topology']=='lines' for g in d['geometries'].values() for p in g['primitives'])
    has_partial=any(x['code']=='face-triangulation-missing' for x in d['diagnostics'])
    d['extensions']['org.cad-preview.completeness/1']={'status':'partial' if has_partial else 'complete','categories':{'faceTriangulation':missing_geometry,'nonMeshableFaces':non_meshable_faces,'meshRepairs':mesh_repairs,'geometryWithoutFaces':wireframe_products,'unsupportedSourceAttributes':[]},'counts':{'products':len(d['products']),'productsAffected':len({r['productId'] for r in missing_geometry}),'missingFaces':len(missing_geometry),'omittedFaces':len(missing_geometry),'nonMeshableFaces':len(non_meshable_faces),'nonMeshableProducts':len({r['productId'] for r in non_meshable_faces}),'repairedFaces':len(mesh_repairs),'repairedTriangles':sum(r['triangles'] for r in mesh_repairs),'wireframeProducts':len(wireframe_products)},'affectedProducts':sorted({r['productName'] for r in missing_geometry}),'repairedProducts':sorted({r['productName'] for r in mesh_repairs}),'missingIsNotSourceHidden':True,'acceptancePolicy':'step-nonmeshable/1','rule':'missing-other remains strict; classified nonmeshable omissions are listed separately, not pickable, excluded from measurements','reader':'OCCT 7.8.1.1 STEPCAFControl_Reader + XCAF'}
    s['completeness']='partial' if has_partial else 'complete'
    d['extensions']['org.cad-preview.step-audit/1']={'entityInventory':dict(types),'definitionMeasurements':measurements,'measurementScope':'leaf-definitions-only; accepted nonmeshable faces excluded from area, affected part volume/centroid unavailable','identityStability':'source-sha-and-reader-version','linearDeflectionMM':.08,'angularDeflectionRadians':.3,'wireframeGeometry':has_wireframe,'partialPreview':has_partial,'strictMode':not partial,'meshRepairs':{'faces':len(mesh_repairs),'triangles':sum(r['triangles'] for r in mesh_repairs),'detail':mesh_repairs}}
    d['extensions']['org.cad-preview.step-audit/1']['nameEncoding']={'codepage':name_codepage,'selection':'explicit-import-option' if name_codepage!='UTF8' else 'default','policy':'step-name-codepage/1','evidenceIds':['name-codepage']}
    source_product_count=sum(count for typ,count in types.items() if typ=='StepBasic_ProductDefinition')
    if source_product_count!=len(d['products']):diagnostic('product-count-difference',f'Source ProductDefinition count {source_product_count}, mapped XCAF definitions {len(d["products"])}; not claimed lossless')
    elapsed=time.perf_counter()-start
    note='产品实例来自 XCAF 引用关系；源颜色与默认材质区分。'
    note+=('曲面三角网格与线框几何共存；' if has_wireframe else '曲面三角网格；')
    note+=('部分面缺少三角化，已按请求省略并在诊断中逐面列出；' if has_partial else '')
    if non_meshable_faces:note+=f'{len(non_meshable_faces)} 个零面积/不可网格化源面未显示（逐面记录，不参与拾取和统计）；'
    if mesh_repairs:note+=f'OCCT 网格器拒绝的 {len(mesh_repairs)} 个面已按同一曲面重采样（面积比 {min(r["areaRatio"] for r in mesh_repairs):.4f}–{max(r["areaRatio"] for r in mesh_repairs):.4f}，见诊断与完整性扩展）；'
    note+='PMI、外部依赖未接入，详见诊断。'
    e={'transportProfile':sink.profile,'document':d,'snapshot':s,'presentation':{'name':Path(path).name,'view':None,'unit':'mm · OCCT 导入坐标','sourceSHA256':sha,'quality':'STEP / XDE · 有限范围验证' + (' / 部分预览' if has_partial else ''),'candidate':True,'note':note,'stats':{'productDefinitions':len(d['products']),'productOccurrences':len(d['productOccurrences']),'geometryDefinitions':len(d['geometries']),'draws':len(s['draws']),'parseSeconds':transferred-start,'mappingSeconds':elapsed-(transferred-start)}}}
    sink.attach(e)
    stageprof.mark('ucd-assembled')
    seal(e);stageprof.mark('revision-seal')
    worker_trace.mark('revisionCompleted')
    if isinstance(sink,Base64Sink):validate_envelope(e)
    else:validate_binary_envelope(d,s,e['presentation'],sink.get)
    sink.finish(e);stageprof.mark('validate-envelope')
    worker_trace.mark('validationCompleted')
    return e
