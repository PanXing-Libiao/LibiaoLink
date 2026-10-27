from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.gp import gp_Pln
from OCP.BRep import BRep_Tool
from OCP.TopLoc import TopLoc_Location
from unified.step_missing_faces import classify_missing_face,is_accepted_nonmeshable,REMESH_DEFLECTIONS

class MissingFaceTests(unittest.TestCase):
    def face(self,x,y):return BRepBuilderAPI_MakeFace(gp_Pln(),0,x,0,y).Face()
    def test_absolute_and_relative_zero_are_distinct_policy_criteria(self):
        zero=classify_missing_face(self.face(1e-5,1e-5))
        self.assertEqual(zero['criterion'],'area<=1e-9-mm2')
        thin=classify_missing_face(self.face(1000,1e-7))
        self.assertEqual(thin['criterion'],'area/bboxDiagSquared<1e-9')
        self.assertEqual(thin['classification'],'degenerate-zero-area')
        self.assertAlmostEqual(thin['bboxM']['max'][0],1.)
    def test_large_unmeshed_face_stays_strict_and_is_not_retried(self):
        with patch('unified.step_missing_faces._remesh') as retry:
            row=classify_missing_face(self.face(1,1))
        self.assertEqual(row['classification'],'missing-other');retry.assert_not_called()
    def test_tiny_face_that_can_mesh_is_not_accepted_as_absent(self):
        face=self.face(.01,.02);row=classify_missing_face(face)
        self.assertEqual(row['classification'],'missing-other')
        self.assertEqual(len(row['remeshAttempts']),5)
        self.assertTrue(all(r.get('triangles',0)>0 for r in row['remeshAttempts']))
        self.assertIsNone(BRep_Tool.Triangulation_s(face,TopLoc_Location()))
    def test_five_empty_attempts_required_and_errors_stay_strict(self):
        face=self.face(.01,.02)
        with patch('unified.step_missing_faces._remesh',side_effect=lambda f,d:{'deflectionMM':d,'triangles':0}):
            row=classify_missing_face(face)
        self.assertEqual(row['classification'],'unmeshable-tiny-area')
        self.assertEqual([r['deflectionMM'] for r in row['remeshAttempts']],list(REMESH_DEFLECTIONS))
        with patch('unified.step_missing_faces._remesh',side_effect=RuntimeError('native retry failed')):
            row=classify_missing_face(face)
        self.assertEqual(row['classification'],'missing-other')
    def test_only_the_two_approved_classifications_are_accepted(self):
        for value in ('missing-other',None,'unrecognized'):
            self.assertFalse(is_accepted_nonmeshable({'classification':value}))
        for value in ('degenerate-zero-area','unmeshable-tiny-area'):
            self.assertTrue(is_accepted_nonmeshable({'classification':value}))
    def test_default_adapter_still_rejects_a_real_large_missing_face(self):
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.STEPControl import STEPControl_Writer,STEPControl_AsIs
        from unified.step_adapter import read_step,PartialPreviewAvailable
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'ordinary-box.step';writer=STEPControl_Writer()
            writer.Transfer(BRepPrimAPI_MakeBox(1,1,1).Shape(),STEPControl_AsIs);writer.Write(str(path))
            with patch.dict(os.environ,{'CAD_STEP_EXTERNAL_MESH':'0'}),patch.object(BRep_Tool,'Triangulation_s',return_value=None):
                with self.assertRaises(PartialPreviewAvailable) as caught:read_step(path)
            record=caught.exception.details['entries'][0]
            self.assertEqual(record['classification'],'missing-other')
            self.assertGreater(record['areaMM2'],.001)

if __name__=='__main__':unittest.main()
