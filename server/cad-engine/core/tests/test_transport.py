from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import base64,hashlib,sys,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.transport import ResourceStore,byte_range

def envelope(raw=b'abcdefgh'):
 h=hashlib.sha256(raw).hexdigest()
 return {'transportProfile':'ucd-base64-envelope/1','document':{'schemaVersion':'2.0.0','buffers':{'b':{'byteLength':len(raw),'sha256':h}}},'bufferPayloads':{'b':base64.b64encode(raw).decode()}}
class Transport(unittest.TestCase):
 def test_roundtrip_release(self):
  store=ResourceStore();e=envelope();m=store.publish(e);token=m['resourceLease'];h=m['bufferResources']['b']['sha256'];self.assertEqual(store.get(token,h),b'abcdefgh');self.assertEqual(m['document'],e['document']);store.release(token);self.assertIsNone(store.get(token,h))
 def test_integrity_quota_expiry(self):
  store=ResourceStore(limit=7)
  with self.assertRaises(ValueError):store.publish(envelope())
  e=envelope();e['bufferPayloads']['b']=base64.b64encode(b'xxxxxxxx').decode()
  with self.assertRaises(ValueError):ResourceStore().publish(e)
  store=ResourceStore(ttl=-1);m=store.publish(envelope());self.assertIsNone(store.get(m['resourceLease'],m['bufferResources']['b']['sha256']))
 def test_manifest_schema(self):
  import json,copy
  from test_schema_v2 import fixture
  from unified.validation import shape,SCHEMA_V2,ValidationError
  schema=json.loads((Path(__file__).resolve().parents[1]/'unified/schema/ucd-binary-manifest-1.schema.json').read_text())
  # Resolve exactly the two declared canonical URNs; no generic resolver claim.
  self.assertEqual(schema['properties']['document']['$ref'],'urn:cad-preview:ucd:2.0.0')
  self.assertEqual(schema['properties']['snapshot']['$ref'],'urn:cad-preview:ucd:2.0.0#/$defs/Snapshot')
  schema['properties']['document']['$ref']='#/$defs/Document';schema['properties']['snapshot']['$ref']='#/$defs/Snapshot'
  manifest=ResourceStore().publish(fixture());shape(manifest,schema,root_schema=SCHEMA_V2)
  for key,value in [('resourceLease','../bad'),('transportProfile','unknown'),('bufferPayloads',{})]:
   bad=copy.deepcopy(manifest);bad[key]=value
   with self.assertRaises(ValidationError):shape(bad,schema,root_schema=SCHEMA_V2)
 def test_ranges(self):
  self.assertEqual(byte_range('bytes=2-4',8),(2,4));self.assertEqual(byte_range('bytes=6-99',8),(6,7));self.assertEqual(byte_range('bytes=1-',8),(1,7))
  for value in ('bytes=8-9','bytes=5-4','bytes=-3','bytes=0-1,4-5','garbage'):
   with self.assertRaises(ValueError):byte_range(value,8)
if __name__=='__main__':unittest.main()
