"""Source-domain, orientation and placement checks for closed display partitions."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import math
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.Geom import Geom_CylindricalSurface
    from OCP.TopAbs import TopAbs_FORWARD,TopAbs_IN,TopAbs_ON
    from OCP.TopoDS import TopoDS
    from OCP.TopLoc import TopLoc_Location
    from OCP.gp import gp_Ax3,gp_Pnt2d,gp_Trsf,gp_Vec
    from unified.step_periodic_mesh import closed_face_native_mesh
except ModuleNotFoundError:
    HAVE_OCP = False
else:
    HAVE_OCP = True

@unittest.skipUnless(HAVE_OCP, 'OpenCASCADE (OCP) Python bindings are not installed')
class PeriodicMeshTests(unittest.TestCase):
    def face(self,start=0,end=2*math.pi):
        return BRepBuilderAPI_MakeFace(Geom_CylindricalSurface(gp_Ax3(),3),start,end,0,4,1e-7).Face()
    def test_dense_samples_retain_source_domain(self):
        face=self.face();mesh=closed_face_native_mesh(face)
        self.assertIsNotNone(mesh)
        self.assertIsNone(BRep_Tool.Triangulation_s(face,TopLoc_Location()))
        classifier=BRepClass_FaceClassifier();forward=TopoDS.Face_s(face.Oriented(TopAbs_FORWARD))
        for i in range(0,len(mesh['indices']),3):
            uv=[mesh['uvs'][j] for j in mesh['indices'][i:i+3]]
            for a in range(5):
                for b in range(5-a):
                    w=(a/4,b/4,1-(a+b)/4)
                    p=gp_Pnt2d(*(sum(uv[k][j]*w[k] for k in range(3)) for j in range(2)))
                    classifier.Perform(forward,p,1e-7)
                    self.assertIn(classifier.State(),(TopAbs_IN,TopAbs_ON))
    def test_invalid_native_partition_is_rejected(self):
        self.assertIsNone(closed_face_native_mesh(self.face(math.pi,3*math.pi)))
    def test_reverse_and_location_are_applied_once(self):
        face=self.face();base=closed_face_native_mesh(face)
        reverse=closed_face_native_mesh(TopoDS.Face_s(face.Reversed()))
        self.assertEqual(base['positions'],reverse['positions'])
        for i in range(0,len(base['indices']),3):
            a,b,c=base['indices'][i:i+3];self.assertEqual(reverse['indices'][i:i+3],[a,c,b])
        tr=gp_Trsf();tr.SetTranslation(gp_Vec(10,-20,30))
        moved=closed_face_native_mesh(TopoDS.Face_s(face.Moved(TopLoc_Location(tr))))
        self.assertIsNotNone(moved)
        for p,q in zip(base['positions'],moved['positions']):
            for j,offset in enumerate((10,-20,30)):self.assertAlmostEqual(q[j]-p[j],offset,places=8)
    def test_open_surface_patch_is_not_reinterpreted_as_closed(self):
        self.assertIsNone(closed_face_native_mesh(self.face(.2,1.2)))

if __name__=='__main__':unittest.main()
