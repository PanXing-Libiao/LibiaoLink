"""Explicit artificial UCD fixture, NEVER a genuine STEP multi-body assertion."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import copy,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.migrate import seal
from unified.validation import validate_envelope
e=json.loads(Path(sys.argv[1]).read_text());d=e['document'];s=e['snapshot'];rid=next(iter(d['representations']));r=d['representations'][rid]
b=copy.deepcopy(r['bindings'][0]);b['id']='controlled-second-binding';old=b['geometryId'];b['geometryId']='controlled-geometry';d['geometries'][b['geometryId']]=copy.deepcopy(d['geometries'][old]);d['geometries'][b['geometryId']]['id']=b['geometryId'];b['localFromRepresentation'][12]=17;r['bindings'].append(b)
for did,draw in list(s['draws'].items()):
 if d['sceneOccurrences'][draw['occurrenceId']].get('representationId')==rid:
  key=did+'-controlled';s['draws'][key]={**draw,'bindingId':b['id']};d['renderOwnership'][key]=d['renderOwnership'][did]
next(iter(s['draws'].values()))['visibility']='hidden'
# Another legal owner ancestor at the same scene: must split batch by owner gate.
did=list(s['draws'])[1];owner=d['renderOwnership'][did]
if d['productOccurrences'][owner]['parentId']:d['renderOwnership'][did]=d['productOccurrences'][owner]['parentId']
seal(e);validate_envelope(e);Path(sys.argv[2]).write_text(json.dumps(e))
