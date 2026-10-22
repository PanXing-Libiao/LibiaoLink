"""Recover display meshes by OCCT's closed-face partition, retaining source identity.

Only analytic closed surfaces are handled. The source B-Rep is copied, never
replaced; all display patches still belong to the original source face.
"""
import math,struct
from .step_mesh_fallback import BARYCENTRIC_SAMPLES,UV_TOLERANCE,_triangle_area
from .step_repair_quality import display_area_check

def closed_face_native_mesh(face,deflection=.08):
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.GeomAbs import GeomAbs_Cone,GeomAbs_Cylinder,GeomAbs_Sphere,GeomAbs_Torus
    from OCP.GProp import GProp_GProps
    from OCP.ShapeUpgrade import ShapeUpgrade_ShapeDivideClosed
    from OCP.TopAbs import TopAbs_FACE,TopAbs_FORWARD,TopAbs_REVERSED,TopAbs_IN,TopAbs_ON
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Pnt2d,gp_Pnt,gp_Vec

    if not math.isfinite(deflection) or deflection<=0:return None
    if face.Orientation() not in (TopAbs_FORWARD,TopAbs_REVERSED):return None
    if BRepAdaptor_Surface(face).GetType() not in (GeomAbs_Cone,GeomAbs_Cylinder,GeomAbs_Sphere,GeomAbs_Torus):return None
    forward=TopoDS.Face_s(face.Oriented(TopAbs_FORWARD))
    if not BRepCheck_Analyzer(forward).IsValid():return None
    surface=BRep_Tool.Surface_s(forward)
    if not (surface.IsUClosed() or surface.IsVClosed()):return None
    bounds=BRepTools.UVBounds_s(forward)
    if not all(math.isfinite(x) for x in bounds):return None
    copy=BRepBuilderAPI_Copy(forward,True,False).Shape()
    splitter=ShapeUpgrade_ShapeDivideClosed(copy)
    tolerance=max(BRep_Tool.Tolerance_s(face),1e-7)
    splitter.SetPrecision(tolerance);splitter.SetMaxTolerance(tolerance)
    splitter.SetNbSplitPoints(1)
    if not splitter.Perform():return None
    shape=splitter.Result()
    if not BRepCheck_Analyzer(shape).IsValid():return None
    source_props=GProp_GProps();BRepGProp.SurfaceProperties_s(forward,source_props)
    split_props=GProp_GProps();BRepGProp.SurfaceProperties_s(shape,split_props)
    source_area=source_props.Mass()
    if source_area<=0 or abs(split_props.Mass()-source_area)>max(1e-6,source_area*1e-8):return None
    # Tighter native settings leave room for the paired UV/3D error gate below.
    BRepMesh_IncrementalMesh(shape,deflection/4,False,.1,False)
    explorer=TopExp_Explorer(shape,TopAbs_FACE)
    classifier=BRepClass_FaceClassifier();positions=[];uvs=[];indices=[]
    counts={'IN':0,'ON':0};patches=0;worst=area=0.
    while explorer.More():
        patch=TopoDS.Face_s(explorer.Current());explorer.Next();patches+=1
        if patches>16:return None
        loc=TopLoc_Location();tri=BRep_Tool.Triangulation_s(patch,loc)
        if tri is None or not tri.HasUVNodes():return None
        # A split patch can wrap U/V by one period. Keep its whole UV chart
        # continuous while bringing it back into the original face's chart.
        patch_bounds=BRepTools.UVBounds_s(patch);shifts=[0.,0.]
        for axis,periodic,period in ((0,surface.IsUPeriodic(),surface.UPeriod() if surface.IsUPeriodic() else 0),
                                      (1,surface.IsVPeriodic(),surface.VPeriod() if surface.IsVPeriodic() else 0)):
            if periodic:
                low,high=bounds[axis*2:axis*2+2];a,b=patch_bounds[axis*2:axis*2+2]
                if high-low>period+UV_TOLERANCE:return None
                shifts[axis]=round(((low+high)-(a+b))/(2*period))*period
        offset=len(positions);transform=loc.Transformation()
        for i in range(1,tri.NbNodes()+1):
            p=tri.Node(i).Transformed(transform);node_uv=tri.UVNode(i);uv=(node_uv.X()+shifts[0],node_uv.Y()+shifts[1]);point=p.Coord()
            if not all(math.isfinite(x) for x in (*point,*uv)):return None
            if p.Distance(surface.Value(*uv))>tolerance*10:return None
            positions.append(point);uvs.append(uv)
        for i in range(1,tri.NbTriangles()+1):
            a,b,c=(offset+n-1 for n in tri.Triangle(i).Get())
            if patch.Orientation()==TopAbs_REVERSED:b,c=c,b
            if face.Orientation()==TopAbs_REVERSED:b,c=c,b
            xyz=[positions[j] for j in (a,b,c)];tuv=[uvs[j] for j in (a,b,c)]
            tri_area=_triangle_area(*xyz)
            if tri_area<=1e-14:return None
            centre=tuple(sum(p[j] for p in tuv)/3 for j in range(2))
            p,du,dv=gp_Pnt(),gp_Vec(),gp_Vec();surface.D1(*centre,p,du,dv)
            ab=gp_Vec(*(xyz[1][j]-xyz[0][j] for j in range(3)))
            ac=gp_Vec(*(xyz[2][j]-xyz[0][j] for j in range(3)))
            sign=-1 if face.Orientation()==TopAbs_REVERSED else 1
            if ab.Crossed(ac).Dot(du.Crossed(dv))*sign<=0:return None
            for weights in BARYCENTRIC_SAMPLES:
                uv=tuple(sum(tuv[k][j]*weights[k] for k in range(3)) for j in range(2))
                classifier.Perform(forward,gp_Pnt2d(*uv),UV_TOLERANCE);state=classifier.State()
                if state not in (TopAbs_IN,TopAbs_ON):return None
                counts['IN' if state==TopAbs_IN else 'ON']+=1
                exact=surface.Value(*uv).Coord()
                chord=tuple(sum(xyz[k][j]*weights[k] for k in range(3)) for j in range(3))
                worst=max(worst,math.dist(exact,chord))
                if worst>deflection:return None
            area+=tri_area;indices.extend((a,b,c))
    area_check=display_area_check(source_area,area)
    stored=[struct.unpack('<fff',struct.pack('<fff',*p)) for p in positions]
    stored_area=sum(_triangle_area(*(stored[indices[i+j]] for j in range(3))) for i in range(0,len(indices),3))
    stored_area_check=display_area_check(source_area,stored_area)
    if patches<2 or not indices or not area_check['accepted'] or not stored_area_check['accepted']:return None
    return {'positions':positions,'indices':indices,'uvs':uvs,'rings':0,
            'area':area,'areaRatio':area/source_area,'maxDeviation':worst,
            'trim':'occt-closed-face-split','reason':'closed-face-native-remesh','nativePatchCount':patches,
            'validation':{'kind':'native-partition-finite-sampled-display-repair',
                'classifier':'BRepClass_FaceClassifier OCCT 7.8.1','classificationCounts':counts,
                'samplesPerTriangle':len(BARYCENTRIC_SAMPLES),'uvTolerance':UV_TOLERANCE,
                'nativeLinearDeflectionMM':deflection/4,'nativeAngularDeflectionRadians':.1,
                'splitSurfaceAreaRatio':split_props.Mass()/source_area,
                'areaCheck':area_check,'float32AreaCheck':stored_area_check,
                'pairedSurfaceMeshMeasuredMaximumMM':worst,'mathematicalMaximumBound':False}}
