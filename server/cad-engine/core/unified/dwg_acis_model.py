# Pinned ACIS source dialects; original save version and precision are retained.
import struct
from cq_acis import entities as E
from cq_acis.graph import SatEntityGraph,parse_sat_graph
from cq_acis.sat import SatHeader
from cq_acis.model import RawEntity,AcisMetadata,AcisModel,AcisContainer,EntityRef
from ezdxf.acis import sab
import cq_acis
import math

class SourceReader(E._EntityReader):
 def read_bool(self,true_word,false_word,*,allow_numeric=False):
  return super().read_bool(true_word,false_word,allow_numeric=allow_numeric or self.graph.header.save_version==106)

class BinaryReader(SourceReader):
 def read_bool(self,true_word,false_word,*,allow_numeric=False):
  if self.peek() in (b'\x0a',b'\x0b'):return self._take()==b'\x0a'
  return super().read_bool(true_word,false_word,allow_numeric=allow_numeric)
 def read_bound(self):
  if self.peek() in (b'\x0a',b'\x0b'):return self.read_float() if self._take()==b'\x0a' else None
  return super().read_bound()
 def read_string(self):return self.read_word()

class LegacyGeometryReader(SourceReader):
 def read_bool(self,true_word,false_word,*,allow_numeric=False):
  return super().read_bool(true_word,false_word,allow_numeric=True)

def parse_sat(data):
 graph=parse_sat_graph(data);decoded=[]
 for raw in graph.entities:
  if graph.header.save_version==106 and raw.type_name in ('plane-surface','straight-curve','ellipse-curve'):
   reader=LegacyGeometryReader(graph,raw);reader.version=400
   decoded.append(E._DECODERS[raw.type_name](reader))
  else:
   decoder=E._DECODERS.get(raw.type_name)
   decoded.append(decoder(SourceReader(graph,raw)) if decoder else E.decode_entity(graph,raw))
 return E.SatModel(graph,tuple(decoded)).as_acis_model()

class BoundedDecoder(sab.Decoder):
 def forward(self,count):
  if count<0 or self.index+count>len(self.data):raise ValueError('acis-truncated-binary')
  return super().forward(count)

def binary_records(data):
 try:return _binary_records(data)
 except (sab.ParsingError,struct.error,IndexError,UnicodeError) as error:
  raise ValueError('acis-invalid-binary: '+str(error)) from error

def _binary_records(data):
 decoder=BoundedDecoder(data);header=decoder.read_header();header_end=decoder.index;records=[];ended=False
 while decoder.has_data:
  record=decoder.read_record()
  if not record or record[0].tag!=13:raise ValueError('acis-invalid-record')
  if record[0].value in ('End-of-ACIS-data','End-of-ASM-data'):
   if len(record)!=1 or decoder.has_data:raise ValueError('acis-trailing-binary-data')
   ended=True;break
  if len(record)<3 or record[1].tag!=12 or record[2].tag!=4:raise ValueError('acis-invalid-record-header')
  depth=0
  for token in record:
   if token.tag==15:depth+=1
   if token.tag==16:depth-=1
   if depth<0:raise ValueError('acis-unbalanced-subtype')
  if depth:raise ValueError('acis-unbalanced-subtype')
  records.append(record)
 if not ended:raise ValueError('acis-missing-end-marker')
 for record in records:
  for token in record:
   if token.tag==12 and not -1<=token.value<len(records):raise ValueError('acis-invalid-reference')
 builder=sab.SabBuilder();builder.header=header
 builder.set_entities(sab.resolve_pointers(list(sab.build_entities(records,header.version))))
 return builder,header_end

def parse_sab(data,source_id='source'):
 # Attempt the pinned parser first; decode the registered vector transform without changing the source version.
 try:return vector_transforms(cq_acis.parse_sab_model(data,source_id=source_id))
 except ValueError as error:
  if 'unsupported SAB save version' not in str(error):raise
 builder,header_end=binary_records(data);h=builder.header
 if h.version not in (700,20800,21200,21500):raise ValueError('unregistered exploratory profile')
 resabs=struct.unpack_from('<d',data,header_end-17)[0];resnor=struct.unpack_from('<d',data,header_end-8)[0]
 index={id(e):i for i,e in enumerate(builder.entities)}
 def ref(e):return EntityRef(-1 if e is None or e.name=='null-ptr' else index[id(e)])
 raws=[]
 for i,entity in enumerate(builder.entities):
  values=[]
  for token in entity.data:
   if token.tag==12:values.append(ref(token.value))
   elif token.tag in (19,20):values.extend(token.value)
   elif token.tag in (10,11) or token.value is None:values.append(bytes([token.tag]))
   else:values.append(token.value)
  # Binary coedge selector and vertex flag are retained in the source payload.
  if entity.name=='coedge' and len(values)==9 and type(values[7]) is int and values[7]==0:del values[7]
  if entity.name=='vertex' and len(values)==4 and type(values[2]) is int:del values[2]
  if entity.name=='transform' and len(values)==1 and isinstance(values[0],str):
   words=values[0].split();values=[float(v) for v in words[:13]]+words[13:]
  raws.append(RawEntity(i,entity.name,ref(entity.attributes),entity.id,tuple(values)))
 header=SatHeader(h.version,len(raws),len(builder.bodies),h.flags,h.product_id,h.acis_version,str(h.creation_date),h.units_in_mm,resabs,resnor,0,0)
 graph=SatEntityGraph(header,tuple(raws));decoded=[]
 for raw in raws:
  fn=E._DECODERS.get(raw.type_name)
  if fn is None:decoded.append(raw);continue
  try:decoded.append(fn(BinaryReader(graph,raw)))
  except E.EntityDecodeError:decoded.append(raw)
 metadata=AcisMetadata(h.units_in_mm,resabs,resnor,AcisContainer.SAB,h.version,h.product_id,h.acis_version,str(h.creation_date),dialect='local-explicit-binary-record-adapter')
 return AcisModel(metadata,tuple(decoded))



def vector_transforms(model):
 from cq_acis.model import TransformEntity
 decoded=[]
 for entity in model.entities:
  if not isinstance(entity,RawEntity) or entity.type_name!='transform':decoded.append(entity);continue
  values=entity.values
  if len(values)!=8 or not all(isinstance(v,bytes) and len(v)==25 and v[0]==20 for v in values[:4]):decoded.append(entity);continue
  if type(values[4]) not in (int,float) or any(v not in (b'\x0a',b'\x0b') for v in values[5:]):raise ValueError('unrecognized transform profile')
  matrix=tuple(x for v in values[:4] for x in struct.unpack('<3d',v[1:]));scale=float(values[4])
  if not all(math.isfinite(v) for v in (*matrix,scale)):raise ValueError('nonfinite transform')
  decoded.append(TransformEntity(entity,matrix,scale,*(v==b'\x0a' for v in values[5:])))
 return AcisModel(model.metadata,tuple(decoded),model.diagnostics)

def parse(data):
 if len(data)>8*1024*1024:raise ValueError('acis-input-budget')
 model=parse_sab(data) if data.startswith((b'ACIS BinaryFile',b'ASM BinaryFile')) else parse_sat(data)
 metadata=model.metadata
 if any(v is None or not math.isfinite(v) or v<=0 for v in (metadata.units_mm,metadata.resabs,metadata.resnor)):
  raise ValueError('acis-source-units-or-precision-missing')
 from .dwg_acis_surfaces import decode_surfaces
 return decode_surfaces(model)

def shapes(model,source_kind):
 import cadquery as cq
 from .dwg_acis_geometry import AcisGeometryConverter
 from cq_acis.model import LumpEntity,ShellEntity,FaceEntity
 if source_kind=='3DSOLID':
  result=AcisGeometryConverter(model).convert()
  if any(not shape.Solids() or shape.Volume()<=0 for shape in result):raise ValueError('acis-solid-not-closed')
 elif source_kind in ('REGION','PLANESURFACE','EXTRUDEDSURFACE','LOFTEDSURFACE','REVOLVEDSURFACE','SWEPTSURFACE'):
  converter=AcisGeometryConverter(model);result=[]
  for body in model.bodies():
   if not body.wire.is_null:raise ValueError('acis-wire-body-unsupported')
   placement=converter._body_placement(body);faces=[]
   for lump in converter._linked_entities(body.lump,LumpEntity,'next_lump',context='sheet lumps'):
    if lump.body.index!=body.index:raise ValueError('acis-lump-ownership')
    for shell in converter._linked_entities(lump.shell,ShellEntity,'next_shell',context='sheet shells'):
     if not shell.subshell.is_null or not shell.wire.is_null:raise ValueError('acis-sheet-substructure-unsupported')
     for face in converter._linked_entities(shell.face,FaceEntity,'next_face',context='sheet faces'):
      if face.shell.index!=shell.index:raise ValueError('acis-face-ownership')
      faces.append(converter._face(face,placement))
   if not faces:raise ValueError('acis-sheet-empty')
   result.append(cq.Compound.makeCompound(faces))
 else:raise ValueError('acis-source-kind-unsupported')
 if not result or len(result)!=len(model.bodies()) or not all(s.isValid() for s in result):raise ValueError('acis-shape-invalid')
 if sum(len(s.Faces()) for s in result)!=sum(isinstance(e,FaceEntity) for e in model.entities):raise ValueError('acis-face-count-mismatch')
 return result
