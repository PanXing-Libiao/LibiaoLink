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
