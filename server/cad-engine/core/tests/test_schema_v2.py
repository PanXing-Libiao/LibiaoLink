"""Controlled positive/negative v2 contracts; not evidence of 2D CAD support."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import copy,json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from unified.validation import validate_envelope,ValidationError,shape,SCHEMA_V2
from unified.migrate import seal,migrate_bridge_v1
from unified.adapter import from_packet,IDENTITY,unknown
from test_schema import drawing_fixture

def fixture():
    packet={'format':'eDrawings','sourceSHA256':'a'*64,'name':'controlled','selectedConfiguration':'raw-scene','meshes':{},'root':{'id':'root','name':'root'},'stats':{},'view':None,'unit':'unknown'}
    return migrate_bridge_v1(from_packet(packet,0))

class ContractV2(unittest.TestCase):
    def test_migration_explicit_and_v1_unchanged(self):
        e=fixture();validate_envelope(e);self.assertEqual(e['document']['configurations'],[]);self.assertEqual(e['document']['viewContexts'][0]['origin'],'system-default');self.assertIn('fromRevision',e['document']['extensions']['org.cad-preview.migration/1'])
    def test_typed_fact_valid_invalid(self):
        for name,valid,bad in [('LengthUnitFact','mm',42),('HandednessFact','right','up'),('UpAxisFact','+Z',[0,0,1]),('SelectionFact',{'viewContextId':'v'},{'configurationId':'c'})]:
            with self.subTest(name=name):
                f={'knowledge':'source-declared','validation':'experimental','evidenceIds':['e'],'value':valid}
                shape(f,SCHEMA_V2['$defs'][name],root_schema=SCHEMA_V2)
                f['value']=bad
                with self.assertRaises(ValidationError):shape(f,SCHEMA_V2['$defs'][name],root_schema=SCHEMA_V2)
                shape(unknown(),SCHEMA_V2['$defs'][name],root_schema=SCHEMA_V2)
                f=unknown();f['value']=valid
                with self.assertRaises(ValidationError):shape(f,SCHEMA_V2['$defs'][name],root_schema=SCHEMA_V2)
    def test_missing_value_and_evidence(self):
        for patch in [{'knowledge':'source-declared','validation':'experimental','evidenceIds':['e']},{'knowledge':'source-declared','validation':'experimental','evidenceIds':[],'value':'mm'}]:
            with self.assertRaises(ValidationError):shape(patch,SCHEMA_V2['$defs']['LengthUnitFact'],root_schema=SCHEMA_V2)
    def test_semantic_rejections(self):
        mutations=[lambda e:e['snapshot']['selection'].update(viewContextId='missing'),lambda e:e['document']['defaultSelection']['value'].update(viewContextId='missing'),lambda e:e['snapshot']['selection'].update(displayStateId='x'),lambda e:e['document']['viewContexts'][0].update(configurationId='invented'),lambda e:e['document']['coordinates'].update(space='metric'),lambda e:e['document']['defaultSelection'].update(knowledge='hypothesis',validation='verified-scope'),lambda e:e['document']['defaultSelection'].update(evidenceIds=['missing']),lambda e:e['document']['capabilities'][0].update(implementation='unsupported',validation='verified-scope')]
        for edit in mutations:
            e=fixture();edit(e);seal(e)
            with self.assertRaises(ValidationError):validate_envelope(e)
    def test_real_configuration_context(self):
        e=fixture();d=e['document'];d['configurations']=[{'id':'c','name':'CAD configuration','sourceKey':'c','stateIds':['s'],'validation':'experimental'}];d['displayStates']=[{'id':'s','name':'source state','configurationIds':['c'],'validation':'experimental'}];d['viewContexts'].append({'id':'source-view','origin':'source-configuration','name':'View','configurationId':'c'});e['snapshot']['selection']={'viewContextId':'source-view','displayStateId':'s'};seal(e);validate_envelope(e)
    def test_pure_2d_has_no_fake_configuration(self):
        e=drawing_fixture(fixture());e['document']['sceneOccurrences']={};e['snapshot']['sceneRoots']=[];seal(e);validate_envelope(e);self.assertFalse(e['document']['configurations']);self.assertTrue(e['document']['drawing']['drawings'])
if __name__=='__main__':unittest.main()
