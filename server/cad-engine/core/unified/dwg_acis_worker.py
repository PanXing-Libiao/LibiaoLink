"""Bounded ACIS geometry worker. Invoked only by the native DWG assembler."""
import array
import hashlib
import json
import math
from pathlib import Path
import sys
if __package__ in (None,''):
 sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
 sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'vendor/ezdxf/src'))
from unified.dwg_acis_model import parse,shapes

MAX_TRIANGLES=200000
MAX_EDGES=200000
MAX_TOTAL_TRIANGLES=250000

def tessellate(model,source_kind):
 converted=shapes(model,source_kind);scale=model.metadata.units_mm
 triangles=array.array('d');edges=array.array('d');face_count=0
 for shape in converted:
  from unified.dwg_acis_mesh import mesh
  optimized=mesh(shape,model.metadata.resabs*scale)
  faces=shape.Faces();face_count+=len(faces)
  pieces=[optimized[:2]] if optimized is not None else (face.tessellate(0.08,0.15) for face in faces)
  for vertices,indices in pieces:
   if not vertices or not indices:raise ValueError('acis-unmeshed-face')
   if len(triangles)//9+len(indices)>MAX_TRIANGLES:raise ValueError('acis-triangle-budget')
   for triangle in indices:
    for index in triangle:triangles.extend(v/scale for v in vertices[index].toTuple())
  for edge in shape.Edges():
   points,_=edge.sample(0.08)
   if edge.IsClosed() and points:points.append(points[0])
   if len(edges)//6+max(0,len(points)-1)>MAX_EDGES:raise ValueError('acis-edge-budget')
   for a,b in zip(points,points[1:]):
    edges.extend(v/scale for v in a.toTuple());edges.extend(v/scale for v in b.toTuple())
 if not all(math.isfinite(v) for values in (triangles,edges) for v in values):raise ValueError('acis-nonfinite-position')
 return triangles,edges,face_count

def main():
 folder=Path(sys.argv[1]);requests=json.loads((folder/'acis-requests.json').read_text());rows=[];total=0
 with (folder/'acis-positions.bin').open('wb') as output:
  for request in requests:
   row={'id':request['id']}
   try:
    payload=(folder/request['payload']).read_bytes()
    if len(payload)!=request['byteLength'] or hashlib.sha256(payload).hexdigest()!=request['sha256']:raise ValueError('acis-payload-identity')
    model=parse(payload);triangles,edges,faces=tessellate(model,request['sourceKind'])
    if total+len(triangles)//9>MAX_TOTAL_TRIANGLES:raise ValueError('acis-document-triangle-budget')
    parts=[]
    for role,values in (('fill',triangles),('stroke',edges)):
     if not values:continue
     offset=output.tell()
     if sys.byteorder!='little':values.byteswap()
     values.tofile(output)
     if sys.byteorder!='little':values.byteswap()
     parts.append({'role':role,'offset':offset,'byteLength':len(values)*8,'count':len(values)//3,
      'min':[min(values[i::3]) for i in range(3)],'max':[max(values[i::3]) for i in range(3)]})
    total+=len(triangles)//9
    row.update(status='ready',parts=parts,faceCount=faces,triangleCount=len(triangles)//9,
      unitsMM=model.metadata.units_mm,resabs=model.metadata.resabs,resnor=model.metadata.resnor,saveVersion=model.metadata.save_version)
   except (ValueError,RuntimeError,TypeError,IndexError,KeyError,AttributeError) as error:
    row.update(status='unsupported',reason=getattr(error,'code',str(error))[:240])
   rows.append(row)
 (folder/'acis-results.json').write_text(json.dumps(rows,allow_nan=False))

if __name__=='__main__':main()
