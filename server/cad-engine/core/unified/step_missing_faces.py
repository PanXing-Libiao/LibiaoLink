"""User-approved missing-face classification, not a geometry repair.

Units are normalized by STEPCAFControl to mm. Policy, in this order:
* degenerate-zero-area: area <= 1e-9 mm² OR area / face bbox diagonal² < 1e-9;
* unmeshable-tiny-area: remaining area <= 0.001 mm² AND five independent
  remeshes at 0.08/0.02/0.01/0.005/0.001 mm all produce no triangles;
* missing-other: everything else, including failed/incomplete measurements.
The tiny-area ceiling was explicitly approved by the user on 2026-10-20.
These are display acceptance thresholds, not statements of exact zero area or
proof that every CAD kernel fails. Global tessellation parameters stay unchanged.
"""
import math

ZERO_AREA_MM2=1e-9
RELATIVE_ZERO_AREA=1e-9
TINY_AREA_MM2=.001
REMESH_DEFLECTIONS=(.08,.02,.01,.005,.001)
POLICY_VERSION='step-nonmeshable/1'

def is_accepted_nonmeshable(record):
    return record.get('classification') in ('degenerate-zero-area','unmeshable-tiny-area')

def recover_missing_face(face,external=None):
    """Preserve the existing pcurve-first, closed-face-partition-second path."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepTools import BRepTools
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopoDS import TopoDS
    try:
        outer=BRepTools.OuterWire_s(face);degenerated=False;edges=TopExp_Explorer(outer,TopAbs_EDGE)
        while edges.More():
            if BRep_Tool.Degenerated_s(TopoDS.Edge_s(edges.Current())):degenerated=True;break
            edges.Next()
    except Exception:degenerated=True
    if degenerated:
        try:
            from .step_mesh_fallback import pcurve_region_mesh
            result=pcurve_region_mesh(face,.08)
            if result is not None:return result
        except Exception:pass
    try:
        from .step_periodic_mesh import closed_face_native_mesh
        result=closed_face_native_mesh(face,.08)
        if result is not None:return result
    except Exception:pass
    if external is not None:
        try:return external.recover(face)
        except Exception as error:
            external.attempts.append({'method':'independent-gmsh-source-face','status':'failed','reason':str(error)[:512]})
    return None

def _remesh(face,deflection):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.BRepTools import BRepTools
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    # Each attempt starts from its own deep copy, with no cached triangulation.
    # Diagnostic triangles never enter the display output or mutate the source.
    copy=TopoDS.Face_s(BRepBuilderAPI_Copy(face,True,False).Shape())
    BRepTools.Clean_s(copy,True)
    mesher=BRepMesh_IncrementalMesh(copy,deflection,False,.3,False)
    tri=BRep_Tool.Triangulation_s(copy,TopLoc_Location())
    return {'deflectionMM':deflection,'angularDeflectionRadians':.3,
            'triangles':tri.NbTriangles() if tri is not None else 0,
            'done':bool(mesher.IsDone()),'status':int(mesher.GetStatusFlags())}

def classify_missing_face(face):
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.Bnd import Bnd_Box
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_WIRE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    row={'classification':'missing-other','criterion':'measurement-incomplete',
         'areaMM2':None,'bboxM':None,'areaOverBBoxDiagSquared':None,'valid':None,
         'surface':None,'wireCount':None,'closed':bool(face.Closed()),'wiresClosed':[],
         'faceToleranceMM':None,'remeshAttempts':[],'classificationPolicy':POLICY_VERSION}
    try:
        row['surface']=BRepAdaptor_Surface(face).GetType().name
        row['valid']=bool(BRepCheck_Analyzer(face).IsValid())
        row['faceToleranceMM']=BRep_Tool.Tolerance_s(face)
        if not math.isfinite(row['faceToleranceMM']):
            row['faceToleranceMM']=None;raise ValueError('non-finite face tolerance')
        wires=TopExp_Explorer(face,TopAbs_WIRE)
        while wires.More():
            row['wiresClosed'].append(bool(BRep_Tool.IsClosed_s(TopoDS.Wire_s(wires.Current()))));wires.Next()
        row['wireCount']=len(row['wiresClosed'])
        props=GProp_GProps();BRepGProp.SurfaceProperties_s(face,props)
        area=abs(props.Mass())
        if not math.isfinite(area):raise ValueError('non-finite face area')
        row['areaMM2']=area
        box=Bnd_Box();BRepBndLib.AddOptimal_s(face,box,False,False)
        if box.IsVoid() or box.IsOpen():raise ValueError('face bounding box unavailable')
        bounds=box.Get()
        if not all(math.isfinite(x) for x in bounds):raise ValueError('non-finite face bounds')
        diag2=sum((bounds[i+3]-bounds[i])**2 for i in range(3))
        if not math.isfinite(diag2):raise ValueError('non-finite bbox diagonal')
        row['bboxM']={'min':[x/1000 for x in bounds[:3]],'max':[x/1000 for x in bounds[3:]],
                     'diagonal':math.sqrt(diag2)/1000,'space':'geometry-local'}
        ratio=area/diag2 if diag2>0 else None
        row['areaOverBBoxDiagSquared']=ratio
        if area<=ZERO_AREA_MM2 or ratio is not None and ratio<RELATIVE_ZERO_AREA:
            row.update(classification='degenerate-zero-area',criterion='area<=1e-9-mm2' if area<=ZERO_AREA_MM2 else 'area/bboxDiagSquared<1e-9')
        elif area>TINY_AREA_MM2:row['criterion']='area>0.001-mm2'
        else:
            for deflection in REMESH_DEFLECTIONS:
                try:row['remeshAttempts'].append(_remesh(face,deflection))
                except Exception as error:row['remeshAttempts'].append({'deflectionMM':deflection,'error':str(error)})
            if all(r.get('triangles')==0 for r in row['remeshAttempts']):
                row.update(classification='unmeshable-tiny-area',criterion='area<=0.001-mm2-and-five-independent-remeshes-empty')
            else:row['criterion']='remesh-produced-triangles-or-failed'
    except Exception as error:row['classificationError']=str(error)
    return row
