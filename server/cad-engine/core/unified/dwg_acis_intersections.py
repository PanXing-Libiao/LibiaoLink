"""Recover only qualified explicit cylinder/cylinder intersection records."""
import math
from cq_acis.model import RawEntity,BSplineCurveEntity,Vec3,ParameterRange,FaceEntity,LoopEntity,EdgeEntity,TorusSurfaceEntity
from cq_acis.cadquery import _Placement,_CylinderGeometry
from cq_acis._supported_curves import spline3d
from OCP.Geom import Geom_CylindricalSurface,Geom_ToroidalSurface
from OCP.gp import gp_Ax3,gp_Pnt,gp_Dir
from OCP.GeomAPI import GeomAPI_IntSS,GeomAPI_ProjectPointOnCurve
from OCP.Geom import Geom_TrimmedCurve
from OCP.GeomConvert import GeomConvert_CompCurveToBSplineCurve
from dataclasses import replace
from .dwg_acis_fit import check
from .dwg_acis_projection import project

def recover_curve(model,raw):
 placement=_Placement(None,1.)
 v=raw.values
 if v[1:9]!=(b'\x0b',1,'int_int_cur',0,'nubs',3,0,9):raise ValueError('unknown intersection profile')
 knots=tuple(v[i] for i in range(9,27,2));mult=list(v[i] for i in range(10,27,2));mult[0]+=1;mult[-1]+=1;n=sum(mult)-4;end=27+n*3
 poles=tuple(Vec3(*v[i:i+3]) for i in range(27,end,3));fit=v[end];curve=BSplineCurveEntity(raw,v[0],3,knots,tuple(mult),poles,(1.,)*n,ParameterRange(knots[0],knots[-1]),fit);curve.validate()
 starts=[i for i,x in enumerate(v) if x=='cone'];supports=[];surfaces=[]
 if starts!=[end+1,end+22]:raise ValueError('unsupported intersection support layout')
 tail=v[end+43:]
 if len(tail)!=16 or tail[:3]!=('nullbs','nullbs',b'\n') or tail[4]!=b'\n' or tail[6:8]!=(0,1) or tail[9:13]!=(0,0,1,b'\n') or tail[14]!=b'\n' or (tail[13],tail[15])!=(knots[0],knots[-1]) or tail[8] not in (tail[3],tail[5]) or not all(isinstance(tail[i],(int,float)) and math.isfinite(tail[i]) for i in (3,5,8)):raise ValueError('unsupported intersection range fields')
 if not math.isfinite(fit) or fit<=0:raise ValueError('invalid saved fit bound')
 for start in starts:
  p=v[start+1:start+21];center=Vec3(*p[:3]);axis=Vec3(*p[3:6]).normalized();major=Vec3(*p[6:9]);radius=major.magnitude
  if p[9]!=1 or p[10:12]!=(b'\x0b',b'\x0b') or p[12]!=0 or p[13]!=1 or p[15:]!=(b'\x0b',)*5 or abs(radius-p[14])>model.metadata.resabs or abs(axis.dot(major))>model.metadata.resabs:raise ValueError('unqualified circular support')
  supports.append((center,axis,radius));surfaces.append(Geom_CylindricalSurface(gp_Ax3(gp_Pnt(center.x,center.y,center.z),gp_Dir(axis.x,axis.y,axis.z),gp_Dir(major.x,major.y,major.z)),radius))
 intersection=GeomAPI_IntSS(surfaces[0],surfaces[1],model.metadata.resabs)
 branches=[intersection.Line(i) for i in range(1,intersection.NbLines()+1)] if intersection.IsDone() else []
 if not branches or len(branches)>16:raise ValueError('intersection branch budget')
 endpointMatches=[];trace=[];interiorTrace=[];maximum=0.
 for i in range(257):
  p=curve.evaluate(knots[0]+(knots[-1]-knots[0])*i/256);point=gp_Pnt(p.x,p.y,p.z);distances=[]
  for j,line in enumerate(branches):
   projection=GeomAPI_ProjectPointOnCurve(point,line)
   candidates=[(point.Distance(line.Value(t)),j,t) for t in (line.FirstParameter(),line.LastParameter())]
   if projection.NbPoints():candidates.append((projection.LowerDistance(),j,projection.LowerDistanceParameter()))
   distances.append(min(candidates))
  if not distances:raise ValueError('no intersection projection')
  closest=min(distances);maximum=max(maximum,closest[0])
  if not trace or trace[-1]!=closest[1]:trace.append(closest[1])
  if 0<i<256 and (not interiorTrace or interiorTrace[-1]!=closest[1]):interiorTrace.append(closest[1])
  if i in (0,256):endpointMatches.append([{'branch':j,'distance':d,'parameter':t} for d,j,t in distances if d<=model.metadata.resabs])
 def nearest(line,point):
  projection=GeomAPI_ProjectPointOnCurve(point,line);values=[(point.Distance(line.Value(t)),t) for t in (line.FirstParameter(),line.LastParameter())]
  if projection.NbPoints():values.append((projection.LowerDistance(),projection.LowerDistanceParameter()))
  return min(values)
 selected=[branches[i] for i in interiorTrace];startPoint=curve.evaluate(knots[0]);endPoint=curve.evaluate(knots[-1]);startDistance,startT=nearest(selected[0],gp_Pnt(startPoint.x,startPoint.y,startPoint.z));endDistance,endT=nearest(selected[-1],gp_Pnt(endPoint.x,endPoint.y,endPoint.z))
 if maximum>fit or max(startDistance,endDistance)>model.metadata.resabs:raise ValueError('intersection does not fit saved curve/endpoints')
 connections=[]
 for first,second in zip(selected,selected[1:]):
  distance,a,b=min((first.Value(a).Distance(second.Value(b)),a,b) for a in (first.FirstParameter(),first.LastParameter()) for b in (second.FirstParameter(),second.LastParameter()))
  if distance>model.metadata.resabs:raise ValueError('disconnected intersection branch')
  connections.append((a,b))
 pieces=[]
 for i,line in enumerate(selected):
  a=startT if i==0 else connections[i-1][1];b=endT if i==len(selected)-1 else connections[i][0]
  piece=Geom_TrimmedCurve(line,min(a,b),max(a,b))
  if a>b:piece.Reverse()
  pieces.append(piece)
 joined=GeomConvert_CompCurveToBSplineCurve(pieces[0])
 for piece in pieces[1:]:
  if not joined.Add(piece,model.metadata.resabs,True,False,16):raise ValueError('cannot concatenate intersection')
 exact=joined.BSplineCurve()
 if exact.NbKnots()>65 or exact.NbPoles()>4096:raise ValueError("intersection spline budget")
 params=[exact.Knot(i) for i in range(1,exact.NbKnots()+1)];newknots=tuple(knots[0]+(k-params[0])/(params[-1]-params[0])*(knots[-1]-knots[0]) for k in params)
 derived=BSplineCurveEntity(raw,v[0],exact.Degree(),newknots,tuple(exact.Multiplicity(i) for i in range(1,exact.NbKnots()+1)),tuple(Vec3(*exact.Pole(i).Coord()) for i in range(1,exact.NbPoles()+1)),tuple(exact.Weight(i) for i in range(1,exact.NbPoles()+1)),ParameterRange(knots[0],knots[-1]),fit);derived.validate()

 fit_proof=check(spline3d(derived,placement),spline3d(curve,placement),fit)
 support_proofs=[]
 for support,(center,axis,radius) in zip(surfaces,supports):
  x=Vec3(*support.Position().XDirection().Coord());y=axis.cross(x)
  geo=_CylinderGeometry(support,center,axis,x,y,radius,model.metadata.resabs)
  pc,proof=project(spline3d(derived,placement),geo,knots[0],knots[-1],model.metadata.resabs);support_proofs.append(proof)
 return derived,{'fit':fit_proof,'supports':support_proofs}

def recover(model):
 if model.metadata.save_version!=21200:return model,{}
 replacements={};proofs={}
 for raw in model.entities:
  if not isinstance(raw,RawEntity) or raw.type_name!='intcurve-curve' or raw.values[1:4]!=(b'\x0b',1,'int_int_cur'):continue
  if len(replacements)>=16:raise ValueError('intersection recovery budget')
  replacement,proof=recover_curve(model,raw);replacements[raw.index]=replacement;proofs[raw.index]=proof
 if not replacements:return model,proofs
 return replace(model,entities=tuple(replacements.get(e.index,e) for e in model.entities)),proofs
