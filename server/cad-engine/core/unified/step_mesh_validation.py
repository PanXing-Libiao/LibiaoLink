"""Source-face validation shared by independent display meshing and research.

CAD source geometry stays in the pinned OCP process. All maxima below are finite
sample measurements, not continuous Hausdorff bounds.
"""
import math,struct

def _cone_triangle_chart(surface,bounds,uvs):
    """Lift each cone triangle across its seam/pole without moving its vertices."""
    import itertools
    from OCP.gp import gp_Pnt,gp_Vec
    values=[list(u) for u in uvs];poles=[]
    for i,(u,v) in enumerate(values):
        p,du,dv=gp_Pnt(),gp_Vec(),gp_Vec();surface.D1(u,v,p,du,dv)
        if du.Magnitude()<1e-7:poles.append(i)
    if len(poles)>1:raise ValueError('multiple singular corners')
    active=[i for i in range(3) if i not in poles];period=surface.UPeriod();low,high=bounds[:2]
    candidates=[]
    for shifts in itertools.product((-1,0,1),repeat=len(active)):
        numbers=[values[i][0]+s*period for i,s in zip(active,shifts)]
        if min(numbers)>=low-1e-7 and max(numbers)<=high+1e-7:candidates.append((max(numbers)-min(numbers),sum(abs(s) for s in shifts),numbers))
    if not candidates:raise ValueError('unresolved-periodic-triangle-chart')
    spread,_,numbers=min(candidates)
    if spread>period/2:raise ValueError('unresolved periodic chart')
    for i,u in zip(active,numbers):values[i][0]=u
    for i in poles:values[i][0]=sum(numbers)/len(numbers)
    for old,new in zip(uvs,values):
        if surface.Value(*old).Distance(surface.Value(*new))>1e-7:raise ValueError('chart changed source point')
    return values



def _seam_charts(surface,bounds,xyz,uvs,triangles,tolerance):
    """Give seam corners their own equivalent UV without changing source CAD.

    OCCT Geom_Surface's period identifies identical points at u and u+period
    (likewise v). A single Gmsh node tag on a seam cannot express both corners
    of the trimmed parameter domain. Only full-period domains and corners on
    their seam limits are handled; other ambiguous charts retain strict checks.
    """
    axes=[]
    for axis,periodic in ((0,surface.IsUPeriodic()),(1,surface.IsVPeriodic())):
        if not periodic:continue
        period=surface.UPeriod() if axis==0 else surface.VPeriod();low,high=bounds[axis*2:axis*2+2]
        if all(math.isfinite(v) for v in (period,low,high)) and period>0 and abs(high-low-period)<=tolerance:
            axes.append((axis,period,low,high))
    if not axes:return xyz,uvs,triangles,{'periodicTrianglesAdjusted':0,'periodicSeamVerticesAdded':0}
    points=list(xyz);chart=list(uvs);result=[];aliases={};adjusted=0
    for triangle in triangles:
        shifts=[[0,0] for _ in triangle]
        for axis,period,low,high in axes:
            values=[uvs[i][axis] for i in triangle]
            if max(values)-min(values)<=period/2:continue
            interior=[v for v in values if low+tolerance<v<high-tolerance]
            if not interior:continue
            middle=(low+high)/2
            for corner,value in enumerate(values):
                if abs(value-high)<=tolerance and max(interior)<middle:shifts[corner][axis]=-1
                elif abs(value-low)<=tolerance and min(interior)>middle:shifts[corner][axis]=1
            changed=[value+shift[axis]*period for value,shift in zip(values,shifts)]
            if max(changed)-min(changed)>period/2 or min(changed)<low-tolerance or max(changed)>high+tolerance:
                raise ValueError('ambiguous-periodic-triangle-chart')
        ids=[];changed=False
        for node,shift in zip(triangle,shifts):
            if not any(shift):ids.append(node);continue
            changed=True;key=(node,*shift)
            if key not in aliases:
                q=list(uvs[node])
                for axis,period,_,_ in axes:q[axis]+=shift[axis]*period
                if len(points)>=50000:raise ValueError('mesher-seam-node-budget')
                aliases[key]=len(points);points.append(xyz[node]);chart.append(q)
            ids.append(aliases[key])
        adjusted+=changed;result.append(ids)
    return points,chart,result,{'periodicTrianglesAdjusted':adjusted,'periodicSeamVerticesAdded':len(aliases)}

def boundary_checks(face,positions,triangles,deflection=.08,physical_boundary=False):
    """Finite, bidirectional source-pcurve / final float32 mesh boundary check.

    Source curves are sampled separately: a source pcurve gap is measured, never
    silently inserted into the source. Mesh boundary components must retain holes.
    This measures samples, not a continuous Hausdorff bound.
    """
    from collections import Counter,defaultdict
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve2d
    from OCP.BRepTools import BRepTools_WireExplorer
    from OCP.TopAbs import TopAbs_WIRE,TopAbs_EDGE,TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    counts=Counter(tuple(sorted((t[i],t[(i+1)%3]))) for t in triangles for i in range(3))
    edges=[e for e,n in counts.items() if n==1];graph=defaultdict(set)
    row={'rejectionReasons':[],'meshBoundaryEdges':len(edges),'maximumAllowedMM':deflection,'mathematicalMaximumBound':False}
    for a,b in edges:graph[a].add(b);graph[b].add(a)
    if len(edges)>2048:
        row['rejectionReasons'].append('mesh-boundary-budget-exceeded');return row
    if not edges or any(n>2 for n in counts.values()) or any(len(v)!=2 for v in graph.values()):
        row['rejectionReasons'].append('mesh-boundary-not-closed-manifold');return row
    unseen=set(graph);components=0
    while unseen:
        components+=1;todo=[unseen.pop()]
        while todo:
            for other in graph[todo.pop()]:
                if other in unseen:unseen.remove(other);todo.append(other)
    surface=BRep_Tool.Surface_s(face);source_segments=[];source_samples=[];source_wires=0;gap=0.;physical_edges=[]
    wires=TopExp_Explorer(face,TopAbs_WIRE)
    while wires.More():
        source_wires+=1;wire=TopoDS.Wire_s(wires.Current());wires.Next();ex=BRepTools_WireExplorer(wire,face);segments=[]
        all_edges=TopExp_Explorer(wire,TopAbs_EDGE);edge_count=0
        while all_edges.More():edge_count+=1;all_edges.Next()
        while ex.More():
            edge=ex.Current();ex.Next();curve=BRepAdaptor_Curve2d(edge,face);a,b=curve.FirstParameter(),curve.LastParameter()
            points=[surface.Value(*curve.Value(a+(b-a)*i/32).Coord()).Coord() for i in range(33)]
            if edge.Orientation()==TopAbs_REVERSED:points.reverse()
            segments.append(points)
            if not physical_boundary or (not BRep_Tool.IsClosed_s(edge,face) and not BRep_Tool.Degenerated_s(edge)):
                source_samples.extend(points);source_segments.extend(zip(points,points[1:]));physical_edges.append(edge)
            if len(source_samples)>8192:
                row['rejectionReasons'].append('source-boundary-budget-exceeded');return row
        if len(segments)!=edge_count or not segments:
            row['rejectionReasons'].append('incomplete-source-boundary');return row
        gap=max(gap,max(math.dist(a[-1],b[0]) for a,b in zip(segments,segments[1:]+segments[:1])))
    row.update(sourceWireCount=source_wires,meshBoundaryComponents=components,sourcePCurveJoinMaximumMM=gap)
    if physical_boundary:
        # A periodic face can have one parameter wire but two physical loops.
        # Use exact source vertex identity; never weld nearby points or holes.
        from OCP.TopExp import TopExp
        vertices=[];source_graph={};degree={}
        def vertex_id(vertex):
            if vertex.IsNull():raise ValueError('source-boundary-missing-vertex')
            for i,known in enumerate(vertices):
                if vertex.IsSame(known):return i
            vertices.append(vertex);return len(vertices)-1
        for edge in physical_edges:
            a=vertex_id(TopExp.FirstVertex_s(edge));b=vertex_id(TopExp.LastVertex_s(edge))
            source_graph.setdefault(a,set()).add(b);source_graph.setdefault(b,set()).add(a)
            degree[a]=degree.get(a,0)+1;degree[b]=degree.get(b,0)+1
        if any(n!=2 for n in degree.values()):row['rejectionReasons'].append('source-physical-boundary-not-closed')
        remaining=set(source_graph);source_components=0
        while remaining:
            source_components+=1;todo=[remaining.pop()]
            while todo:
                for other in source_graph[todo.pop()]:
                    if other in remaining:remaining.remove(other);todo.append(other)
        row['sourcePhysicalBoundaryComponents']=source_components
        if components!=source_components:row['rejectionReasons'].append('source-hole-or-boundary-component-count-mismatch')
    elif components!=source_wires:row['rejectionReasons'].append('source-hole-or-boundary-component-count-mismatch')
    if not source_segments:
        row['rejectionReasons'].append('source-boundary-unavailable');return row
    mesh_segments=[(positions[a],positions[b]) for a,b in edges]
    mesh_samples=[tuple(a[j]*(1-t)+b[j]*t for j in range(3)) for a,b in mesh_segments for t in (0,.25,.5,.75,1)]
    if len(source_samples)*len(mesh_segments)+len(mesh_samples)*len(source_segments)>4_000_000:
        row['rejectionReasons'].append('boundary-comparison-budget-exceeded');return row
    def distance(p,a,b):
        d=tuple(b[j]-a[j] for j in range(3));den=sum(x*x for x in d)
        t=max(0,min(1,sum((p[j]-a[j])*d[j] for j in range(3))/den)) if den else 0
        return math.dist(p,tuple(a[j]+t*d[j] for j in range(3)))
    def maximum(samples,segments):return max(min(distance(p,a,b) for a,b in segments) for p in samples)
    forward=maximum(source_samples,mesh_segments);backward=maximum(mesh_samples,source_segments)
    row.update(sourceToMeshBoundaryMaximumMM=forward,meshToSourceBoundaryMaximumMM=backward,
               sourceSamples=len(source_samples),meshSamples=len(mesh_samples))
    if max(forward,backward,gap)>deflection:row['rejectionReasons'].append('source-boundary-samples-exceed-deflection')
    return row


def validate_external_mesh(face,raw,deflection=.08):
    """Return a validated display mesh on the original surface, or reject it.

    The mesher supplies topology and a UV chart. Every display vertex is explicitly
    reevaluated on the original source surface; the maximum displacement is logged.
    Float32 area, winding and paired samples are checked after storage conversion.
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepTools import BRepTools
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FORWARD,TopAbs_REVERSED,TopAbs_IN,TopAbs_ON
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Pnt,gp_Pnt2d,gp_Vec
    from .step_mesh_fallback import _triangle_area,BARYCENTRIC_SAMPLES,UV_TOLERANCE
    from .step_repair_quality import display_area_check
    if face.Orientation() not in (TopAbs_FORWARD,TopAbs_REVERSED):raise ValueError('unsupported-face-orientation')
    xyz,uvs,triangles=raw.get('positions'),raw.get('uvs'),raw.get('indices')
    if not isinstance(xyz,list) or not 3<=len(xyz)<=50000:raise ValueError('mesher-position-count')
    if not isinstance(uvs,list) or len(uvs)!=len(xyz):raise ValueError('mesher-source-UV-required')
    if not isinstance(triangles,list) or not 1<=len(triangles)<=50000:raise ValueError('mesher-triangle-count')
    for points,width in ((xyz,3),(uvs,2)):
        if not all(isinstance(p,list) and len(p)==width and all(type(x) in (int,float) and math.isfinite(x) for x in p) for p in points):raise ValueError('nonfinite-mesher-coordinate')
    if not all(isinstance(t,list) and len(t)==3 and len(set(t))==3 and all(type(i) is int and 0<=i<len(xyz) for i in t) for t in triangles):raise ValueError('invalid-mesher-triangle')
    if len({tuple(sorted(t)) for t in triangles})!=len(triangles):raise ValueError('duplicate-mesher-triangle')
    forward=TopoDS.Face_s(face.Oriented(TopAbs_FORWARD));surface=BRep_Tool.Surface_s(forward)
    cone_chart=surface.DynamicType().Name()=='Geom_ConicalSurface'
    bounds=BRepTools.UVBounds_s(forward)
    if cone_chart:
        seam_check={'coneTriangleLocalCharts':True,'chartPolicy':'step-cone-chart/1'}
    else:
        xyz,uvs,triangles,seam_check=_seam_charts(surface,bounds,xyz,uvs,triangles,UV_TOLERANCE)
    exact=[surface.Value(*uv).Coord() for uv in uvs]
    displacement=max(math.dist(a,b) for a,b in zip(xyz,exact))
    if not math.isfinite(displacement) or displacement>deflection:raise ValueError('external-chart-exceeds-source-surface-budget')
    stored=[struct.unpack('<fff',struct.pack('<fff',*p)) for p in exact]
    quantization=max(math.dist(a,b) for a,b in zip(exact,stored))
    classifier=BRepClass_FaceClassifier();counts={'IN':0,'ON':0};indices=[];oriented=[];area=double_area=worst=0.;rewound=0
    for triangle in triangles:
        ids=list(triangle);tuv=[uvs[i] for i in ids]
        if cone_chart:tuv=_cone_triangle_chart(surface,bounds,tuv)
        cross=(tuv[1][0]-tuv[0][0])*(tuv[2][1]-tuv[0][1])-(tuv[1][1]-tuv[0][1])*(tuv[2][0]-tuv[0][0])
        if not math.isfinite(cross) or cross==0:raise ValueError('collapsed-UV-triangle')
        if cross<0:ids[1],ids[2]=ids[2],ids[1];rewound+=1
        if cross<0:tuv=[tuv[0],tuv[2],tuv[1]]
        points=[stored[i] for i in ids]
        tri_area=_triangle_area(*points)
        if tri_area<=1e-14:raise ValueError('collapsed-float32-triangle')
        centre=tuple(sum(p[j] for p in tuv)/3 for j in range(2));p,du,dv=gp_Pnt(),gp_Vec(),gp_Vec();surface.D1(*centre,p,du,dv)
        ab=gp_Vec(*(points[1][j]-points[0][j] for j in range(3)));ac=gp_Vec(*(points[2][j]-points[0][j] for j in range(3)))
        if ab.Crossed(ac).Dot(du.Crossed(dv))<=0:raise ValueError('float32-source-winding-mismatch')
        for weights in BARYCENTRIC_SAMPLES:
            uv=tuple(sum(tuv[k][j]*weights[k] for k in range(3)) for j in range(2));classifier.Perform(forward,gp_Pnt2d(*uv),UV_TOLERANCE);state=classifier.State()
            if state not in (TopAbs_IN,TopAbs_ON):raise ValueError('source-face-domain-samples-outside')
            counts['IN' if state==TopAbs_IN else 'ON']+=1
            point=tuple(sum(points[k][j]*weights[k] for k in range(3)) for j in range(3))
            worst=max(worst,math.dist(point,surface.Value(*uv).Coord()))
        area+=tri_area;double_area+=_triangle_area(*(exact[i] for i in ids));oriented.append(ids)
        if face.Orientation()==TopAbs_REVERSED:ids=[ids[0],ids[2],ids[1]]
        indices.extend(ids)
    props=GProp_GProps();BRepGProp.SurfaceProperties_s(forward,props);source_area=abs(props.Mass())
    area_check=display_area_check(source_area,double_area);stored_check=display_area_check(source_area,area)
    if not area_check['accepted'] or not stored_check['accepted']:raise ValueError('mesh-outside-display-area-budget')
    if worst>deflection:raise ValueError('paired-float32-surface-samples-exceed-deflection')
    boundary=boundary_checks(forward,stored,oriented,deflection,physical_boundary=cone_chart)
    if boundary['rejectionReasons']:raise ValueError(';'.join(boundary['rejectionReasons']))
    return {'positions':stored,'uvs':uvs,'indices':indices,'rings':0,'area':area,'areaRatio':area/source_area,
            'maxDeviation':max(worst,boundary['sourceToMeshBoundaryMaximumMM'],boundary['meshToSourceBoundaryMaximumMM']),
            'trim':'independent-source-surface-chart','reason':'independent-gmsh-source-face',
            'validation':{'kind':'independent-finite-sampled-display-repair','classifier':'BRepClass_FaceClassifier OCCT 7.9.3',
                'uvTolerance':UV_TOLERANCE,'samplesPerTriangle':len(BARYCENTRIC_SAMPLES),'classificationCounts':counts,
                'areaCheck':area_check,'float32AreaCheck':stored_check,'boundaryChecks':boundary,
                'pairedSurfaceMeshMeasuredMaximumMM':worst,'sourceSurfaceResampled':True,
                'maximumVertexDisplacementMM':displacement,'float32QuantizationMaximumMM':quantization,
                'rewoundTriangles':rewound,'sourceFaceReversed':face.Orientation()==TopAbs_REVERSED,
                **seam_check,'mathematicalMaximumBound':False}}

