"""Run optional ACIS reconstruction under the existing DWG job boundary."""
import json
import os
from pathlib import Path
import subprocess

KINDS={'3DSOLID','REGION','PLANESURFACE','EXTRUDEDSURFACE','LOFTEDSURFACE','REVOLVEDSURFACE','SWEPTSURFACE'}

def reconstruct(folder,opaque,entities):
 requests=[];errors={};total=0
 for key,metadata in opaque.items():
  kind=entities.get(key,{}).get('geometry',{}).get('sourceType')
  if kind not in KINDS:continue
  size=metadata['byteLength'];total+=size
  if size>8*1024*1024 or total>64*1024*1024 or len(requests)>=128:
   errors[key]='acis-input-budget';continue
  requests.append({'id':key,'payload':'opaque-'+metadata['handle']+'.bin','sourceKind':kind,
   'byteLength':size,'sha256':metadata['sha256']})
 if not requests:return [],errors,b''
 interpreter=os.environ.get('CAD_ACIS_PYTHON')
 if not interpreter:
  return [],{**errors,**{r['id']:'acis-runtime-unavailable' for r in requests}},b''
 folder=Path(folder);(folder/'acis-requests.json').write_text(json.dumps(requests))
 try:
  subprocess.run([interpreter,str(Path(__file__).with_name('dwg_acis_worker.py')),str(folder)],
   check=True,timeout=45,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 except (subprocess.SubprocessError,OSError) as error:
  reason='acis-worker-timeout' if isinstance(error,subprocess.TimeoutExpired) else 'acis-worker-failed'
  return [],{**errors,**{r['id']:reason for r in requests}},b''
 rows=json.loads((folder/'acis-results.json').read_text());accepted=[]
 for row in rows:
  if row['status']=='ready':accepted.append(row)
  else:errors[row['id']]=row['reason']
 return accepted,errors,(folder/'acis-positions.bin').read_bytes()
