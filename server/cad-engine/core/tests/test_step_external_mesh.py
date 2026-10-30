"""Targeted geometry and process controls for the independent face fallback."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import math,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace,BRepBuilderAPI_MakePolygon
    from OCP.Geom import Geom_CylindricalSurface
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Ax3,gp_Pln,gp_Pnt,gp_Trsf,gp_Vec
    from unified.step_external_mesh import ExternalMeshContext,_execute
    from unified.step_mesh_validation import validate_external_mesh
except ModuleNotFoundError:
    HAVE_OCP = False
else:
    HAVE_OCP = True

@unittest.skipUnless(HAVE_OCP, 'OpenCASCADE (OCP) Python bindings are not installed')
class ExternalMeshTests(unittest.TestCase):
    def fixture(self):
        polygon=BRepBuilderAPI_MakePolygon()
        for x,y in ((.008,.008),(.008,.012),(.012,.012),(.012,.008)):polygon.Add(gp_Pnt(x,y,0))
        polygon.Close();maker=BRepBuilderAPI_MakeFace(BRepBuilderAPI_MakeFace(gp_Pln(),0,.02,0,.02).Face());maker.Add(polygon.Wire())
        points=[[0,0,0],[.02,0,0],[.02,.02,0],[0,.02,0],[.008,.008,0],[.012,.008,0],[.012,.012,0],[.008,.012,0]]
        triangles=[[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
        return maker.Face(),{'positions':points,'uvs':[p[:2] for p in points],'indices':triangles}
    def test_micro_hole_retained_and_filled_hole_refused(self):
        face,raw=self.fixture();mesh=validate_external_mesh(face,raw)
        self.assertEqual(mesh['validation']['boundaryChecks']['meshBoundaryComponents'],2)
        self.assertIsNone(BRep_Tool.Triangulation_s(face,TopLoc_Location()))
        raw['indices']=[[0,1,2],[0,2,3]]
        with self.assertRaisesRegex(ValueError,'source-face-domain|source-hole'):validate_external_mesh(face,raw)
    def test_reverse_and_location_are_applied_once(self):
        face,raw=self.fixture();base=validate_external_mesh(face,raw);reverse=validate_external_mesh(TopoDS.Face_s(face.Reversed()),raw)
        self.assertEqual(base['positions'],reverse['positions'])
        for i in range(0,len(base['indices']),3):
            a,b,c=base['indices'][i:i+3];self.assertEqual(reverse['indices'][i:i+3],[a,c,b])
        tr=gp_Trsf();tr.SetTranslation(gp_Vec(10,-20,30));moved=TopoDS.Face_s(face.Moved(TopLoc_Location(tr)))
        raw['positions']=[[p[j]+(10,-20,30)[j] for j in range(3)] for p in raw['positions']]
        result=validate_external_mesh(moved,raw)
        self.assertLess(result['validation']['maximumVertexDisplacementMM'],1e-10)
        self.assertEqual(result['validation']['boundaryChecks']['meshBoundaryComponents'],2)
    def test_bad_chart_collapsed_triangle_and_duplicate_are_refused(self):
        face,raw=self.fixture();raw['positions'][0]=[5,5,5]
        with self.assertRaisesRegex(ValueError,'chart-exceeds'):validate_external_mesh(face,raw)
        face,raw=self.fixture();raw['indices'].append(raw['indices'][0])
        with self.assertRaisesRegex(ValueError,'duplicate'):validate_external_mesh(face,raw)
    def test_periodic_seam_survives_real_independent_mesher(self):
        face=BRepBuilderAPI_MakeFace(Geom_CylindricalSurface(gp_Ax3(),.5),0,2*math.pi,0,.3,1e-7).Face()
        context=ExternalMeshContext();mesh=context.recover(face)
        self.assertIsNotNone(mesh,context.attempts)
        check=mesh['validation']
        self.assertGreater(check['duplicateNodeRowsCollapsed'],0)
        self.assertGreater(check['periodicTrianglesAdjusted'],0)
        self.assertGreater(check['periodicSeamVerticesAdded'],0)
        self.assertEqual(check['boundaryChecks']['meshBoundaryComponents'],1)
        self.assertEqual(check['rewoundTriangles'],0)
        self.assertIsNone(BRep_Tool.Triangulation_s(face,TopLoc_Location()))
    def test_conflicting_duplicate_node_chart_still_rejects(self):
        from types import SimpleNamespace as NS
        from unified.step_mesher_worker import mesh_face
        fake=NS(__version__='4.15.2',initialize=lambda *a,**k:None,finalize=lambda:None,
                option=NS(setNumber=lambda *a:None),model=NS(
                    occ=NS(importShapes=lambda *a:None,synchronize=lambda:None),getEntities=lambda *a:[(2,1)],
                    mesh=NS(generate=lambda *a:None,getNodes=lambda *a:([1,2,1],[0,0,0,1,0,0,0,0,0],[0,0,1,0,2*math.pi,0]))))
        with patch.dict(sys.modules,{'gmsh':fake}):
            with self.assertRaisesRegex(ValueError,'ambiguous-source-chart-node'):mesh_face(Path('controlled-face.brep'),.08)
    def test_missing_runtime_is_recorded(self):
        face,_=self.fixture()
        with patch.dict(os.environ,{'CAD_STEP_EXTERNAL_MESH':'1','CAD_STEP_MESHER_PYTHON':'/missing/face-mesher'}):
            context=ExternalMeshContext();self.assertIsNone(context.recover(face))
        self.assertEqual(context.attempts[0]['status'],'unavailable')
    def test_source_hash_mismatch_never_enters_display(self):
        face,_=self.fixture()
        with patch.dict(os.environ,{'CAD_STEP_EXTERNAL_MESH':'1','CAD_STEP_MESHER_PYTHON':sys.executable}),patch('unified.step_external_mesh._execute',return_value={'engine':'gmsh','version':'4.15.2','sourceSHA256':'0'*64}):
            context=ExternalMeshContext();self.assertIsNone(context.recover(face))
        self.assertEqual(len(context.attempts),2);self.assertTrue(all('source-or-version-mismatch' in r['reason'] for r in context.attempts))
    def test_timeout_reaps_child(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);script=folder/'slow-mesher'
            script.write_text('#!/bin/sh\nexec /bin/sleep 30\n');script.chmod(0o755)
            source=folder/'face.brep';source.write_text('controlled fixture')
            started=[];launch=subprocess.Popen
            def observe(args,**kwargs):
                process=launch(args,**kwargs)
                if args[0]==str(script):started.append(process.pid)
                return process
            with patch('unified.step_external_mesh.subprocess.Popen',side_effect=observe):
                with self.assertRaisesRegex(TimeoutError,'mesher-timeout'):_execute(script,source,folder/'mesh.json',.002,.4)
            self.assertEqual(len(started),1)
            with self.assertRaises(ProcessLookupError):os.kill(started[0],0)

if __name__=='__main__':unittest.main()
