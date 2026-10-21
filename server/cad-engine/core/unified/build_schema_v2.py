"""UCD 2.0: explicit view contexts and discriminated, typed facts. v1 is frozen."""
import json
from pathlib import Path
from .build_schema import obj,arr,ref,enum,ID,TEXT
KNOWLEDGE=['native-confirmed','standard-confirmed','official-declared','source-declared','engineering-defined','hypothesis','unknown']
VALIDATION=['not-implemented','experimental','verified-scope','not-applicable']
def fact(value):
    return {'oneOf':[obj({'knowledge':enum('unknown'),'validation':enum('not-applicable'),'evidenceIds':arr(ID)}),obj({'value':value,'knowledge':enum(*KNOWLEDGE[:-1]),'validation':enum(*VALIDATION),'evidenceIds':arr(ID,1)})]}
def build():
    schema=json.loads((Path(__file__).parent/'schema/ucd-1.0.schema.json').read_text());d=schema['$defs']
    schema['$id']='urn:cad-preview:ucd:2.0.0';schema['title']='UnifiedCADDocument 2.0.0'
    d['Fact']=fact({});d['LengthUnitFact']=fact(enum('mm','cm','m','inch','foot','micrometre'))
    d['HandednessFact']=fact(enum('right','left'));d['UpAxisFact']=fact(enum('+X','-X','+Y','-Y','+Z','-Z'))
    d['Selection']=obj({'viewContextId':ID,'displayStateId':ID},['viewContextId']);d['SelectionFact']=fact(ref('Selection'))
    d['ViewContext']={'oneOf':[obj({'id':ID,'origin':enum('system-default'),'name':TEXT,'sourceContextKey':TEXT},['id','origin','name']),obj({'id':ID,'origin':enum('source-configuration'),'name':TEXT,'configurationId':ID})]}
    for name in ('Document','Snapshot'):d[name]['properties']['schemaVersion']={'const':'2.0.0'}
    p=d['Document']['properties'];p['viewContexts']=arr(ref('ViewContext'),1);d['Document']['required'].append('viewContexts');p['configurations']['minItems']=0;p['defaultSelection']=ref('SelectionFact')
    for field,name in [('lengthUnit','LengthUnitFact'),('handedness','HandednessFact'),('upAxis','UpAxisFact')]:d['Coordinates']['properties'][field]=ref(name)
    for name in ('Drawing','BlockDefinition','Annotation'):d[name]['properties']['units']=ref('LengthUnitFact')
    for name in ('Configuration','DisplayState'):d[name]['properties']['validation']=enum(*VALIDATION)
    p=d['Capability']['properties'];p['mechanism']=enum(*KNOWLEDGE);p['implementation']=enum('not-implemented','experimental','implemented','unsupported');p['validation']=enum(*VALIDATION);d['Capability']['required'].append('validation')
    d['Snapshot']['properties']['completeness']=enum('complete','partial','experimental')
    return schema
if __name__=='__main__':(Path(__file__).parent/'schema/ucd-2.0.schema.json').write_text(json.dumps(build(),ensure_ascii=False,indent=2)+'\n')
