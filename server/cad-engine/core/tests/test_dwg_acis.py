"""Synthetic ACIS boundary tests; no company CAD fixtures."""
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'vendor/ezdxf/src'))
from unified.dwg_acis import reconstruct
try:
 import cadquery as cq
 import cq_acis
 from unified import dwg_acis_model as acis
 from unified.dwg_acis_worker import tessellate
 AVAILABLE=True
except ImportError:
 AVAILABLE=False

@unittest.skipUnless(AVAILABLE,'pinned ACIS runtime not installed')
class AcisGeometry(unittest.TestCase):
 def test_box_roundtrip_and_native_units(self):
  source=cq.Workplane().box(2,3,4).val()
  authored=cq_acis.from_cadquery(source)
  model=acis.parse(authored.to_sab())
  shape=acis.shapes(model,'3DSOLID')[0]
  self.assertEqual(len(shape.Faces()),6)
  self.assertAlmostEqual(shape.Volume(),24,places=6)
  triangles,edges,faces=tessellate(model,'3DSOLID')
  self.assertEqual(faces,6)
  self.assertTrue(edges)
  scale=model.metadata.units_mm
  self.assertAlmostEqual((max(triangles[0::3])-min(triangles[0::3]))*scale,2,places=6)
 def test_missing_precision_and_truncated_input_are_rejected(self):
  for data in (b'ACIS BinaryFile',b'700 0 0 0',b'x'*(8*1024*1024+1)):
   with self.subTest(size=len(data)):
    with self.assertRaises((ValueError,IndexError,RuntimeError)):acis.parse(data)
 def test_explicit_binary_profile_and_invalid_links(self):
  from ezdxf.acis import api,sab
  from ezdxf.render import forms
  data=api.export_sab([api.body_from_mesh(forms.cube())],version=20800)
  model=acis.parse(data)
  self.assertEqual(model.metadata.save_version,20800)
  self.assertEqual(len(acis.shapes(model,'3DSOLID')[0].Faces()),6)
  with self.assertRaises(ValueError):acis.binary_records(data[:-4])
  with self.assertRaises(ValueError):acis.binary_records(data+b'bad')
  import struct
  decoder=sab.Decoder(data);decoder.read_header()
  pointer=data.index(bytes([12]),decoder.index)
  damaged=bytearray(data);struct.pack_into('<i',damaged,pointer+1,-2)
  with self.assertRaisesRegex(ValueError,'invalid-reference'):acis.binary_records(bytes(damaged))
 def test_missing_declared_precision_is_rejected(self):
  model=acis.parse(cq_acis.from_cadquery(cq.Workplane().box(1,1,1).val()).to_sab())
  model=replace(model,metadata=replace(model.metadata,resabs=None))
  with patch.object(acis,'parse_sat',return_value=model):
   with self.assertRaisesRegex(ValueError,'precision-missing'):acis.parse(b'synthetic')
 def test_explicit_bicubic_preserves_poles_and_rejects_unknown_fit(self):
  from cq_acis.model import RawEntity,NULL_REF,BSplineSurfaceEntity
  from unified.dwg_acis_surfaces import decode_surfaces
  model=acis.parse(cq_acis.from_cadquery(cq.Workplane().box(1,1,1).val()).to_sab())
  poles=tuple(float(c) for u in range(4) for v in range(4) for c in (u,v,u*v))
  values=(NULL_REF,b'\x0b',1,'exactsur',0,'nubs',3,3,0,0,0,0,2,2,0.,3,1.,3,0.,3,1.,3)+poles+(0.,0,0,0,0,0,0,b'\x0a',1.,b'\x0a',0.,b'\x0a',1.,b'\x0a',0.,1,b'\x0b',b'\x0b',b'\x0b',b'\x0b')
  raw=RawEntity(0,'spline-surface',NULL_REF,None,values)
  model=replace(model,metadata=replace(model.metadata,save_version=20800),entities=(raw,))
  surface=decode_surfaces(model).entities[0]
  self.assertIsInstance(surface,BSplineSurfaceEntity)
  self.assertEqual(surface.raw,raw)
  surface.validate()
  for index,value in ((70,.01),(71,1),(89,0)):
   changed=list(values);changed[index]=value
   with self.subTest(index=index),self.assertRaisesRegex(ValueError,'unqualified-exactsur'):
    decode_surfaces(replace(model,entities=(replace(raw,values=tuple(changed)),)))
 def test_torus_patch_must_stay_outside_singular_branch(self):
  import math
  from unified.dwg_acis_surfaces import regular_patch_clearance
  self.assertGreater(regular_patch_clearance(2,3,(0,1,-.2,.2)),0)
  self.assertLess(regular_patch_clearance(2,3,(0,1,0,math.pi)),0)
  self.assertLess(regular_patch_clearance(2,3,(0,1,2*math.pi,3*math.pi)),0)
  for bounds in ((0,0,0,1),(0,1,0,7),(0,1,0,float('inf'))):
   with self.subTest(bounds=bounds),self.assertRaises(ValueError):regular_patch_clearance(2,3,bounds)
 def test_import_does_not_patch_shared_library(self):
  self.assertEqual(cq_acis.parse_sab_model.__module__,'cq_acis.sab')
  self.assertEqual(cq_acis.entities._EntityReader.read_bool.__module__,'cq_acis.entities')

class AcisProcess(unittest.TestCase):
 def test_no_runtime_does_not_drop_drawing(self):
  with TemporaryDirectory() as folder,patch.dict('os.environ',{},clear=True):
   rows,errors,data=reconstruct(folder,{'e':{'byteLength':1,'handle':'A','sha256':'0'*64}},{'e':{'geometry':{'sourceType':'3DSOLID'}}})
  self.assertEqual(rows,[]);self.assertEqual(errors,{'e':'acis-runtime-unavailable'});self.assertEqual(data,b'')
 def test_input_budget_rejects_before_process(self):
  with TemporaryDirectory() as folder,patch('subprocess.run') as run:
   rows,errors,data=reconstruct(folder,{'e':{'byteLength':9*1024*1024,'handle':'A','sha256':'0'*64}},{'e':{'geometry':{'sourceType':'3DSOLID'}}})
   run.assert_not_called();self.assertEqual(errors['e'],'acis-input-budget')
 def test_timeout_preserves_explicit_loss(self):
  import subprocess
  with TemporaryDirectory() as folder,patch.dict('os.environ',{'CAD_ACIS_PYTHON':'python'}),patch('subprocess.run',side_effect=subprocess.TimeoutExpired('acis',45)):
   rows,errors,data=reconstruct(folder,{'e':{'byteLength':1,'handle':'A','sha256':'0'*64}},{'e':{'geometry':{'sourceType':'3DSOLID'}}})
  self.assertEqual(errors['e'],'acis-worker-timeout');self.assertEqual(rows,[])

if __name__=='__main__':unittest.main()
