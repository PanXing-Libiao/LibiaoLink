"""Cone seam/pole repair keeps trims, holes, orientation and task limits."""
import copy,hashlib,math,os,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from OCP.BRep import BRep_Tool
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace,BRepBuilderAPI_MakeEdge,BRepBuilderAPI_MakeWire
from OCP.BRepLib import BRepLib
from OCP.GCE2d import GCE2d_MakeSegment
from OCP.Geom import Geom_ConicalSurface
from OCP.gp import gp_Ax3,gp_Pnt2d,gp_Trsf,gp_Vec
from OCP.TopoDS import TopoDS
from OCP.TopLoc import TopLoc_Location
from unified.step_mesh_validation import validate_external_mesh
from unified.step_external_mesh import ExternalMeshContext,ENGINE


def patch_fixture(hole=False):
    surface=Geom_ConicalSurface(gp_Ax3(),.4,1)
    maker=BRepBuilderAPI_MakeFace(surface,.2,1.2,0,1,1e-7)
    if hole:
        points=[(.6,.4),(.8,.4),(.8,.6),(.6,.6)]
        wire=BRepBuilderAPI_MakeWire()
        for a,b in zip(points,points[1:]+points[:1]):
            curve=GCE2d_MakeSegment(gp_Pnt2d(*a),gp_Pnt2d(*b)).Value()
            wire.Add(BRepBuilderAPI_MakeEdge(curve,surface).Edge())
        maker.Add(TopoDS.Wire_s(wire.Wire().Reversed()))
    face=maker.Face();BRepLib.BuildCurves3d_s(face)
    uv=[[.2+i*.1,j*.1] for j in range(11) for i in range(11)]
    triangles=[]
    for j in range(10):
        for i in range(10):
            if hole and 4<=i<6 and 4<=j<6:continue
            a=j*11+i;b=a+1;c=a+12;d=a+11
            triangles.extend([[a,b,c],[a,c,d]])
    return face,{'positions':[list(surface.Value(*p).Coord()) for p in uv],'uvs':uv,'indices':triangles}


class ConeMeshTests(unittest.TestCase):
    def test_trimmed_hole_is_retained_and_filling_refused(self):
        face,raw=patch_fixture(True);mesh=validate_external_mesh(face,raw)
        self.assertEqual(mesh['validation']['boundaryChecks']['sourcePhysicalBoundaryComponents'],2)
        self.assertEqual(mesh['validation']['boundaryChecks']['meshBoundaryComponents'],2)
        _,filled=patch_fixture(False)
        with self.assertRaises(ValueError):validate_external_mesh(face,filled)
        self.assertIsNone(BRep_Tool.Triangulation_s(face,TopLoc_Location()))

    def test_mesh_outside_trim_is_refused(self):
        face,raw=patch_fixture()
        surface=BRep_Tool.Surface_s(face)
        raw['uvs']=[[u-.3,v] for u,v in raw['uvs']]
        raw['positions']=[list(surface.Value(*uv).Coord()) for uv in raw['uvs']]
        with self.assertRaisesRegex(ValueError,'periodic|domain'):validate_external_mesh(face,raw)

    def test_reversal_and_placement_applied_once(self):
        face,raw=patch_fixture(True);base=validate_external_mesh(face,raw)
        reverse=validate_external_mesh(TopoDS.Face_s(face.Reversed()),raw)
        self.assertEqual(base['positions'],reverse['positions'])
        for i in range(0,len(base['indices']),3):
            a,b,c=base['indices'][i:i+3];self.assertEqual(reverse['indices'][i:i+3],[a,c,b])
        tr=gp_Trsf();tr.SetTranslation(gp_Vec(10,-20,30))
        moved=TopoDS.Face_s(face.Moved(TopLoc_Location(tr)))
        transformed=copy.deepcopy(raw)
        transformed['positions']=[[p[j]+(10,-20,30)[j] for j in range(3)] for p in raw['positions']]
        result=validate_external_mesh(moved,transformed)
        for a,b in zip(base['positions'],result['positions']):
            for j,offset in enumerate((10,-20,30)):self.assertAlmostEqual(b[j]-a[j],offset,delta=3e-6)

    def test_periodic_apex_fan_retains_physical_boundary(self):
        surface=Geom_ConicalSurface(gp_Ax3(),.4,1);apex=-1/math.sin(.4)
        face=BRepBuilderAPI_MakeFace(surface,0,2*math.pi,apex,apex+1,1e-7).Face()
        uv=[[0,apex]]+[[i*2*math.pi/64,apex+1] for i in range(64)]
        raw={'positions':[list(surface.Value(*p).Coord()) for p in uv],'uvs':uv,
             'indices':[[0,i+1,(i+1)%64+1] for i in range(64)]}
        mesh=validate_external_mesh(face,raw)
        self.assertEqual(mesh['validation']['boundaryChecks']['sourcePhysicalBoundaryComponents'],1)
        self.assertLess(mesh['maxDeviation'],.08)
        raw['indices'].pop()
        with self.assertRaises(ValueError):validate_external_mesh(face,raw)

    def test_cached_raw_is_revalidated_and_scoped_to_context(self):
        face,raw=patch_fixture(True)
        def execute(interpreter,source,target,size,timeout):
            return {**copy.deepcopy(raw),'engine':'gmsh','version':ENGINE,'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest()}
        with patch.dict(os.environ,{'CAD_STEP_MESHER_PYTHON':sys.executable}),patch('unified.step_external_mesh._execute',side_effect=execute) as launch,patch('unified.step_mesh_validation.validate_external_mesh',wraps=validate_external_mesh) as check:
            context=ExternalMeshContext();one=context.recover(face);two=context.recover(face)
            self.assertIsNotNone(one,context.attempts);self.assertEqual(one,two)
            self.assertEqual(launch.call_count,1);self.assertEqual(check.call_count,2)
            self.assertIsNotNone(ExternalMeshContext().recover(face));self.assertEqual(launch.call_count,2)
            context.remaining=0;self.assertIsNone(context.recover(face))
            self.assertEqual(launch.call_count,2)

    def test_cache_budget_and_rejected_meshes(self):
        face,raw=patch_fixture(True)
        def execute(interpreter,source,target,size,timeout):
            return {**copy.deepcopy(raw),'engine':'gmsh','version':ENGINE,'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest()}
        with patch.dict(os.environ,{'CAD_STEP_MESHER_PYTHON':sys.executable}),patch('unified.step_external_mesh._execute',side_effect=execute) as launch,patch('unified.step_external_mesh.RAW_CACHE_BYTES',1):
            context=ExternalMeshContext();self.assertIsNotNone(context.recover(face));self.assertIsNotNone(context.recover(face))
            self.assertEqual(launch.call_count,2);self.assertEqual(context._cache_bytes,0)
        _,raw=patch_fixture(False)
        with patch.dict(os.environ,{'CAD_STEP_MESHER_PYTHON':sys.executable}),patch('unified.step_external_mesh._execute',side_effect=execute):
            context=ExternalMeshContext();self.assertIsNone(context.recover(face));self.assertEqual(context._cache_bytes,0)

    def test_large_face_candidate_refines_without_relaxing_validation(self):
        from OCP.gp import gp_Pln
        face=BRepBuilderAPI_MakeFace(gp_Pln(),0,100,0,100).Face()
        raw={'positions':[[0,0,0],[100,0,0],[100,100,0],[0,100,0]],
             'uvs':[[0,0],[100,0],[100,100],[0,100]],'indices':[[0,1,2],[0,2,3]]}
        sizes=[]
        def execute(interpreter,source,target,size,timeout):
            sizes.append(size);mesh=copy.deepcopy(raw)
            if len(sizes)==1:mesh['indices'].pop() # A coarse candidate must not hide a missing region.
            return {**mesh,'engine':'gmsh','version':ENGINE,'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest()}
        with patch.dict(os.environ,{'CAD_STEP_MESHER_PYTHON':sys.executable}),patch('unified.step_external_mesh._execute',side_effect=execute):
            context=ExternalMeshContext();result=context.recover(face)
        self.assertIsNotNone(result,context.attempts)
        self.assertEqual(sizes,[math.sqrt(10),math.sqrt(10)/2])
        self.assertEqual(context.attempts[0]['status'],'rejected')
        self.assertEqual(result['validation']['boundaryChecks']['maximumAllowedMM'],.08)

if __name__=='__main__':unittest.main()
