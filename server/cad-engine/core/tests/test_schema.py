"""Positive/negative contract fixtures. No fixture claims CAD format support."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import base64
import copy
import hashlib
from pathlib import Path
import struct
import sys
import unittest
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from convert import convert
from unified.adapter import from_packet,digest,identity,IDENTITY,unknown
from unified.validation import validate_envelope,ValidationError,SCHEMA

def refresh(e):
 d=e['document'];s=e['snapshot'];d['revision']=digest({k:v for k,v in d.items() if k!='revision'});s['documentRevision']=d['revision'];s['id']=identity('snapshot',{k:v for k,v in s.items() if k!='id'})

def drawing_fixture(e):
 m=e['document']['drawing'];sid=e['document']['sources'][0]['id'];style={'color':{'mode':'by-layer'},'plot':True}
 m['drawings']['D']={'id':'D','name':'Controlled contract fixture','sourceIds':[sid],'modelSpaceId':'M','sheetIds':['S'],'layoutIds':['L'],'layerIds':['Y'],'units':unknown()}
 m['spaces']['M']={'id':'M','drawingId':'D','kind':'model','ownerId':'D','entityIds':['E'],'annotationIds':['A'],'blockInstanceIds':['I']}
 m['spaces']['P']={'id':'P','drawingId':'D','kind':'paper','ownerId':'L','entityIds':[],'annotationIds':[],'blockInstanceIds':[]}
 m['spaces']['BSPACE']={'id':'BSPACE','drawingId':'D','kind':'block','ownerId':'B','entityIds':[],'annotationIds':[],'blockInstanceIds':[]}
 m['sheets']['S']={'id':'S','drawingId':'D','name':'A4','paperSize':[297,210],'paperUnit':'mm','margins':[5,5,5,5],'layoutIds':['L']}
 m['layouts']['L']={'id':'L','drawingId':'D','name':'Layout','sheetId':'S','paperSpaceId':'P','viewportIds':['V'],'paperToSheet':IDENTITY}
 m['viewports']['V']={'id':'V','layoutId':'L','sourceSpaceId':'M','modelToPaper':IDENTITY,'projection':'orthographic','clipBoundary':[[0,0],[100,0],[100,100]],'enabled':True,'frozenLayerIds':[],'layerOverrides':{},'annotationScale':1}
 m['layers']['Y']={'id':'Y','drawingId':'D','name':'Layer','visible':True,'frozen':False,'lockedForEditing':True,'plot':True,'defaultStyle':style,'sourceRefs':[]}
 m['entities']['E']={'id':'E','drawingId':'D','ownerSpaceId':'M','layerId':'Y','localFromOwner':IDENTITY,'geometry':{'type':'line','start':[0,0,0],'end':[1,1,0]},'style':style,'sourceRefs':[],'displayOrder':0}
 m['annotations']['A']={'id':'A','ownerSpaceId':'M','layerId':'Y','kind':'dimension','position':[0,0,0],'direction':[1,0,0],'text':'reference','associativeEntityIds':['E'],'semantic':{},'presentationEntityIds':[],'annotationScales':[1],'sourceRefs':[]}
 m['blocks']['B']={'id':'B','drawingId':'D','name':'Block','spaceId':'BSPACE','basePoint':[0,0,0],'units':unknown(),'dynamicParameters':{}}
 m['blockInstances']['I']={'id':'I','ownerSpaceId':'M','definitionId':'B','layerId':'Y','localFromBlock':IDENTITY,'attributes':{},'style':style,'sourceRefs':[]}
 refresh(e);return e

def drawing_projection_fixture(e):
 drawing_fixture(e)
 e['snapshot']['drawingProjection']={'drawingId':'D','target':{'kind':'layout','layoutId':'L'},'viewports':copy.deepcopy(e['document']['drawing']['viewports']),'layerStates':{'Y':{'visible':True,'frozen':False,'plot':True}},'draws':{'draw-E-V':{'kind':'entity','itemId':'E','blockPath':[],'viewportId':'V','localToSpace':IDENTITY,'visibility':'shown','availability':'ready','style':{'color':[0,0,0,1],'opacity':1,'plot':True},'drawOrder':0}}}
 refresh(e);return e

@unittest.skipUnless((SAMPLE_ROOT / 'Viola.easm').exists(), 'external STEP sample (CAD_TEST_DATA or .cad-work/research) is not provisioned')
class SchemaTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  p=SAMPLE_ROOT / 'Viola.easm';raw=p.read_bytes();cls.envelope=from_packet(convert(raw,p.name,allow_experimental=False),len(raw))
 def fail_mutation(self,edit,code=None):
  e=copy.deepcopy(self.envelope);edit(e);refresh(e)
  with self.assertRaises(ValidationError) as raised:validate_envelope(e)
  if code:self.assertEqual(raised.exception.code,code)
 def test_real_document_and_stable_identity(self):
  validate_envelope(self.envelope);self.assertEqual(self.envelope['document']['products'],{})
  d=self.envelope['document'];self.assertEqual(d['revision'],digest({k:v for k,v in d.items() if k!='revision'}))
 def test_resource_dictionary_order_does_not_change_identity(self):
  p=SAMPLE_ROOT / 'Viola.easm';raw=p.read_bytes();packet=convert(raw,p.name,allow_experimental=False)
  packet['meshes']=dict(reversed(list(packet['meshes'].items())))
  other=from_packet(packet,len(raw))
  self.assertEqual(set(other['document']['sceneOccurrences']),set(self.envelope['document']['sceneOccurrences']))
  self.assertEqual(other['document']['revision'],self.envelope['document']['revision'])
  self.assertEqual(other['snapshot']['id'],self.envelope['snapshot']['id'])
 def test_schema_version_and_required_extension_fail(self):
  self.fail_mutation(lambda e:e['document'].update(schemaVersion='2.0.0'),'invalid-schema')
  self.fail_mutation(lambda e:e['document']['extensionsRequired'].append('unknown.required/1'),'unsupported-feature')
 def test_missing_or_cyclic_scene_reference(self):
  def edit(e):
   n=next(iter(e['document']['sceneOccurrences'].values()));n['parentId']=n['id']
  self.fail_mutation(edit,'invalid-reference')
 def test_accessor_window_alignment_stride_and_type(self):
  for patch in [{'byteOffset':1},{'byteLength':0},{'count':9007199254740992},{'normalized':True},{'byteStride':2},{'byteStride':9007199254740992}]:
   self.fail_mutation(lambda e,patch=patch:next(a for a in e['document']['accessors'].values() if a['component']=='f32').update(patch))
 def test_payload_integrity_and_budget(self):
  self.fail_mutation(lambda e:e['bufferPayloads'].update({next(iter(e['bufferPayloads'])):'AAAA'}),'invalid-buffer')
  with self.assertRaisesRegex(ValidationError,'budget'):validate_envelope(self.envelope,max_decoded=1)
 def test_primitive_arity_and_range(self):
  for patch in [{'count':1},{'first':9007199254740991,'count':3}]:
   def edit(e):next(iter(e['document']['geometries'].values()))['primitives'][0]['range'].update(patch)
   self.fail_mutation(edit,'invalid-geometry')
 def test_out_of_range_unsigned_index(self):
  def edit(e):
   d=e['document'];g=next(iter(d['geometries'].values()));a=d['accessors'][g['primitives'][0]['indices']];bid=a['bufferId'];raw=bytearray(base64.b64decode(e['bufferPayloads'][bid]));struct.pack_into('<I',raw,0,0xffffffff)
   e['bufferPayloads'][bid]=base64.b64encode(raw).decode();d['buffers'][bid]['sha256']=hashlib.sha256(raw).hexdigest()
  self.fail_mutation(edit,'invalid-geometry')
 def test_snapshot_association_and_revision(self):
  self.fail_mutation(lambda e:e['snapshot']['selection'].update(configurationId='missing'),'invalid-reference')
  e=copy.deepcopy(self.envelope);e['snapshot']['documentRevision']='0'*64
  with self.assertRaises(ValidationError):validate_envelope(e)
 def test_unknown_fact_cannot_invent_value(self):
  self.fail_mutation(lambda e:e['document']['coordinates']['lengthUnit'].update(value='mm'),'invalid-schema')
 def test_two_dimensional_structure_fixture(self):
  validate_envelope(drawing_fixture(copy.deepcopy(self.envelope)))
  # A coverage-complete projection is accepted; the fixture's model space holds E and A.
  complete=drawing_projection_fixture(copy.deepcopy(self.envelope))
  complete['snapshot']['drawingProjection']['draws']['draw-A-V']={'kind':'annotation','itemId':'A','blockPath':[],'viewportId':'V','localToSpace':IDENTITY,'visibility':'shown','availability':'ready','style':{'color':[0,0,0,1],'opacity':1,'plot':True},'drawOrder':1}
  refresh(complete);validate_envelope(complete)
  # Omitting a space member is an invalid projection, not an unsupported feature.
  e=drawing_projection_fixture(copy.deepcopy(self.envelope))
  with self.assertRaises(ValidationError) as raised:validate_envelope(e)
  self.assertEqual(raised.exception.code,'invalid-reference')
 def test_drawing_only_document_needs_no_three_dimensional_root(self):
  e=drawing_fixture(copy.deepcopy(self.envelope));d=e['document'];s=e['snapshot']
  for key in ['sceneOccurrences','renderOwnership','representations','geometries','accessors','buffers','materials']:d[key]={}
  s['sceneRoots']=[];s['draws']={};e['bufferPayloads']={};refresh(e);validate_envelope(e)
 def test_two_dimensional_missing_layer_and_block_cycle(self):
  e=drawing_fixture(copy.deepcopy(self.envelope));e['document']['drawing']['entities']['E']['layerId']='missing';refresh(e)
  with self.assertRaises(ValidationError):validate_envelope(e)
  e=drawing_fixture(copy.deepcopy(self.envelope));m=e['document']['drawing'];m['blockInstances']['I']['ownerSpaceId']='BSPACE';m['spaces']['M']['blockInstanceIds']=[];m['spaces']['BSPACE']['blockInstanceIds']=['I'];refresh(e)
  with self.assertRaisesRegex(ValidationError,'cycle'):validate_envelope(e)

if __name__=='__main__':unittest.main()
