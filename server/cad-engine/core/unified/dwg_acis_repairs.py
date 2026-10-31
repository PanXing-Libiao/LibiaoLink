"""Qualified repairs retaining physical source curves and source precision."""
import math
import cadquery as cq
from OCP.BRep import BRep_Tool
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.ShapeFix import ShapeFix_Face
from OCP.TopAbs import TopAbs_REVERSED
from cq_acis.model import EllipseCurveEntity
from cq_acis._supported_curves import deviation
from cq_acis._analytic_seams import _check_seam_boundaries

def elliptic_face(self,result,face,surface,loops,placement):
 if result.isValid() or not surface.is_cylinder() or surface.is_circular():return result
 before_edges=result.Edges();before_range=[BRep_Tool.Range_s(e.wrapped) for e in before_edges];before_area=result.Area();before_uv=result.uvBounds();before_surface=BRep_Tool.Surface_s(result.wrapped)
 fix=ShapeFix_Face(result.wrapped);fix.SetPrecision(self.tolerance);fix.SetMaxTolerance(self.tolerance)
 for n in dir(fix):
  if n.endswith('Mode'):setattr(fix,n,int(n=='FixWireMode'))
 wire=fix.FixWireTool()
 for n in dir(wire):
  if n.startswith('Fix') and n.endswith('Mode'):setattr(wire,n,int(n in ('FixEdgeCurvesMode','FixSameParameterMode')))
 fix.Perform();after=cq.Face(fix.Face())
 if not after.isValid() or len(after.Edges())!=len(before_edges) or before_area!=after.Area() or before_uv!=after.uvBounds() or before_surface!=BRep_Tool.Surface_s(after.wrapped):raise ValueError('unqualified ellipse repair')
 for i,(old,new) in enumerate(zip(before_edges,after.Edges())):
  a,b=BRep_Tool.Range_s(new.wrapped)
  if (a,b)!=before_range[i] or BRep_Tool.Curve_s(old.wrapped,a,b)!=BRep_Tool.Curve_s(new.wrapped,a,b):raise ValueError('ellipse source curve changed')
  pc=BRep_Tool.CurveOnSurface_s(new.wrapped,after.wrapped,a,b)
  if deviation(BRep_Tool.Curve_s(new.wrapped,a,b),pc,before_surface,a,b)>self.tolerance:raise ValueError('ellipse boundary error')
 if any(BRep_Tool.Tolerance_s(e.wrapped)>self.tolerance for e in after.Edges()) or any(BRep_Tool.Tolerance_s(v.wrapped)>self.tolerance for v in after.Vertices()):raise ValueError('ellipse precision exceeded')
 return after

def cylinder_face(self,result,face,surface,loops,placement):
 if result.isValid() or not surface.is_cylinder() or not surface.is_circular() or len(loops)!=2:return result
 geo=self._cone_geometry(face,surface,placement);sections=[]
 for loop in loops:
  section=None
  for co in self._coedges(loop):
   if not co.pcurve.is_null:raise ValueError('saved pcurve not qualified')
   edge=self.model.resolve(co.edge);curve=self._resolve_geometry(edge.curve)
   if not isinstance(curve,EllipseCurveEntity):raise ValueError('not an elliptic rim')
   normal=placement.oriented_direction(curve.normal).normalized();major=placement.vector(curve.major_axis);minor=normal.cross(major)*abs(curve.ratio);delta=placement.point_vector(curve.center)-geo.center;axial=normal.dot(geo.axis);radius=geo.radius
   radial=delta-geo.axis*delta.dot(geo.axis);projected=[v-geo.axis*v.dot(geo.axis) for v in (major,minor)]
   if radial.magnitude>self.tolerance or abs(axial)<1e-8 or any(abs(v.magnitude-radius)>self.tolerance for v in projected) or abs(projected[0].dot(projected[1]))>self.tolerance*radius:raise ValueError('rim does not lie on cylinder')
   abc=(delta.dot(geo.axis),-radius*normal.dot(geo.x_direction)/axial,-radius*normal.dot(geo.y_direction)/axial)
   if section is not None and abs(abc[0]-section[0])+math.hypot(abc[1]-section[1],abc[2]-section[2])>self.tolerance:raise ValueError('split rim is not coplanar')
   section=abc
  sections.append(section)
 dc,da,db=(b-a for a,b in zip(*sections))
 if abs(dc)-math.hypot(da,db)<=self.tolerance:raise ValueError('rims intersect')
 wires=[self._wire(loop,placement,geo) for loop in loops]
 builder=BRepBuilderAPI_MakeFace(geo.surface,wires[0].wrapped,True);builder.Add(wires[1].wrapped);original=cq.Face(builder.Face());boundaries=[];windings=[]
 for wire in wires:
  winding=0
  for edge in wire.Edges():
   a,b=BRep_Tool.Range_s(edge.wrapped);pc=BRep_Tool.CurveOnSurface_s(edge.wrapped,original.wrapped,a,b)
   sign=-1 if edge.wrapped.Orientation()==TopAbs_REVERSED else 1
   winding+=sign*(pc.Value(b).X()-pc.Value(a).X());boundaries.append((edge,BRep_Tool.Curve_s(edge.wrapped,a,b),a,b))
  windings.append(winding)
 if any(abs(abs(w)-2*math.pi)>1e-10 for w in windings) or abs(sum(windings))>1e-10:raise ValueError('invalid rim winding')
 fixer=ShapeFix_Face(original.wrapped);fixer.SetPrecision(self.tolerance);fixer.SetMaxTolerance(self.tolerance)
 if not fixer.FixMissingSeam():raise ValueError('no seam')
 result=cq.Face(fixer.Face());senses=[]
 for edge in result.Edges():
  if BRep_Tool.IsClosed_s(edge.wrapped,result.wrapped):continue
  curve=BRep_Tool.Curve_s(edge.wrapped,0.,0.);matches=[source for source,saved,a,b in boundaries if curve==saved]
  if len(matches)==1:senses.append(edge.wrapped.Orientation()!=matches[0].wrapped.Orientation())
 if senses and all(senses):result=self._reverse_face(result)
 proof=_check_seam_boundaries(self,result,geo.surface,boundaries)
 self.periodic_seam_faces.append({'face':face.index,**proof})
 if face.reversed!=surface.reversed:result=self._reverse_face(result)
 return result
