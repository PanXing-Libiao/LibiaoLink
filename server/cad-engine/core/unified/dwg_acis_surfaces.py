"""Explicit cubic SAB surface profile and nonsingular trimmed torus patches."""
import math
from dataclasses import replace
from cq_acis.model import RawEntity,BSplineSurfaceEntity,Vec3,ParameterRange,TorusSurfaceEntity
from cq_acis.cadquery import CadQueryConverter,_TorusGeometry

def decode_surfaces(model):
 if model.metadata.save_version!=20800:return model
 entities=[]
 for raw in model.entities:
  if not isinstance(raw,RawEntity) or raw.type_name!='spline-surface':entities.append(raw);continue
  v=raw.values
  if v[1:4]!=(b'\x0b',1,'exactsur') or v[5:14]!=('nubs',3,3,0,0,0,0,2,2):entities.append(raw);continue
  # A single observed open bicubic, non-rational profile. Preserve all raw fields;
  # do not reinterpret unknown flags, subtype references, ranges or fit bounds.
  tail=(0,0,0,0,0,0,b'\x0a',1.,b'\x0a',0.,b'\x0a',1.,b'\x0a',0.,1,b'\x0b',b'\x0b',b'\x0b',b'\x0b')
  if len(v)!=90 or not v[0].is_null or type(v[4]) is not int or v[4]<0 or v[14:22]!=(0.,3,1.,3,0.,3,1.,3) or v[70]!=0. or v[71:]!=tail:
   raise ValueError('acis-unqualified-exactsur-profile')
  poles=tuple(Vec3(*v[i:i+3]) for i in range(22,70,3))
  surface=BSplineSurfaceEntity(raw,v[0],3,3,(0.,1.),(0.,1.),(4,4),(4,4),4,4,poles,(1.,)*16,False,ParameterRange(0.,1.),ParameterRange(0.,1.),0.)
  surface.validate();entities.append(surface)
 return replace(model,entities=tuple(entities))

def regular_patch_clearance(major,minor,bounds):
 """Minimum distance to the axis on the complete enclosing parameter rectangle."""
 if not all(math.isfinite(x) for x in (major,minor,*bounds)):raise ValueError('acis-nonfinite-torus-domain')
 u0,u1,v0,v1=bounds
 if not u0<u1 or not v0<v1 or u1-u0>2*math.pi+1e-10 or v1-v0>2*math.pi+1e-10:raise ValueError('acis-unqualified-torus-domain')
 cosine=min(math.cos(v0),math.cos(v1))
 if math.pi+2*math.pi*math.ceil((v0-math.pi)/(2*math.pi))<=v1:cosine=-1.
 return major+minor*cosine

class AcisSurfaceConverter(CadQueryConverter):
 def __init__(self,model):super().__init__(model);self.regular_torus_patches=[]
 def _closed_analytic_geometry(self,face,surface,placement):
  if not isinstance(surface,TorusSurfaceEntity) or surface.major_radius>abs(surface.minor_radius):return super()._closed_analytic_geometry(face,surface,placement)
  from OCP.Geom import Geom_ToroidalSurface
  from OCP.gp import gp_Ax3,gp_Pnt,gp_Dir
  if not placement.preserves_circles:raise ValueError('non-similarity torus placement')
  center=placement.point_vector(surface.center);axis=placement.vector(surface.axis).normalized();x=placement.vector(surface.u_direction).normalized();y=axis.cross(x);scale=placement.vector(Vec3(1,0,0)).magnitude;major=surface.major_radius*scale;minor=abs(surface.minor_radius)*scale
  if major<=self.tolerance or minor<=self.tolerance or abs(axis.dot(x))>1e-9:raise ValueError('invalid torus frame')
  geometry=Geom_ToroidalSurface(gp_Ax3(gp_Pnt(center.x,center.y,center.z),gp_Dir(axis.x,axis.y,axis.z),gp_Dir(x.x,x.y,x.z)),major,minor)
  return _TorusGeometry(geometry,center,axis,x,y,major,self.tolerance,minor)
 def _closed_analytic_face(self,face,surface,loops,placement):
  result=super()._closed_analytic_face(face,surface,loops,placement)
  if isinstance(surface,TorusSurfaceEntity) and surface.major_radius<=abs(surface.minor_radius):
   if not loops:raise ValueError('singular untrimmed torus')
   u0,u1,v0,v1=result.uvBounds();scale=placement.vector(Vec3(1,0,0)).magnitude
   minimum=regular_patch_clearance(surface.major_radius*scale,abs(surface.minor_radius)*scale,(u0,u1,v0,v1))
   if not math.isfinite(minimum) or minimum<=self.tolerance or u1-u0>2*math.pi+1e-10:raise ValueError('torus patch approaches singular or double-valued region')
   self.regular_torus_patches.append({'face':face.index,'minimumAxisDistance':minimum,'uvBounds':[u0,u1,v0,v1]})
  return result