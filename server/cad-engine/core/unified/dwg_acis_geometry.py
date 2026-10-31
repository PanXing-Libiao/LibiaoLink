"""ACIS conversion with bounded analytic seams and verified UV clocks."""
import math
import cadquery as cq
from OCP.BRep import BRep_Tool,BRep_Builder
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.ShapeFix import ShapeFix_Face
from OCP.GeomProjLib import GeomProjLib
from cq_acis.cadquery import CadQueryConversionError,_ConeGeometry,_EllipseCylinderGeometry
from cq_acis.model import Vec3
from cq_acis._supported_curves import deviation
from .dwg_acis_surfaces import AcisSurfaceConverter
from .dwg_acis_repairs import elliptic_face,cylinder_face
from .dwg_acis_seam_check import check_boundaries
from .dwg_acis_projection import project

class AcisGeometryConverter(AcisSurfaceConverter):
 def __init__(self,model):
  from .dwg_acis_intersections import recover
  model,proofs=recover(model)
  super().__init__(model)
  self.intersection_proofs=proofs;self._checked_supported_curves.update(proofs)
  self.clock_proofs=[];self._projection_edges={}
 def _attach_surface_pcurves(self,edges,geometry,*,loop_index,coedges=None,placement=None):
  previous=self._projection_edges
  self._projection_edges={co.index:edge for co,edge in zip(coedges or (),edges)}
  try:return super()._attach_surface_pcurves(edges,geometry,loop_index=loop_index,coedges=coedges,placement=placement)
  finally:self._projection_edges=previous
 def _saved_surface_pcurve(self,coedge,geometry,first,last,reversed):
  pc,saved=super()._saved_surface_pcurve(coedge,geometry,first,last,reversed)
  if pc is not None or coedge is None or not isinstance(geometry,(_ConeGeometry,_EllipseCylinderGeometry)):return pc,saved
  source=self.model.resolve(coedge.edge)
  if source.curve.index in self._supported_curves:return pc,saved
  edge=self._projection_edges.get(coedge.index)
  if edge is None:return pc,saved
  curve=BRep_Tool.Curve_s(edge.wrapped,first,last)
  pc=GeomProjLib.Curve2d_s(curve,first,last,geometry.surface,self.tolerance*.1)
  if pc is None or deviation(curve,pc,geometry.surface,first,last)>self.tolerance:
   pc,proof=project(curve,geometry,first,last,self.tolerance);self.clock_proofs.append(proof)
  return pc,None
 def _edge(self,coedge,placement):
  edge=super()._edge(coedge,placement)
  if self.intersection_proofs:
   builder=BRep_Builder()
   for vertex in edge.Vertices():builder.UpdateVertex(vertex.wrapped,self.tolerance)
  return edge
 def _check_tolerant_join(self,previous,current,previous_coedge,current_coedge,geometry,placement,limit,loop_index):
  if self.intersection_proofs and previous_coedge and current_coedge:
   before=self.model.resolve(previous_coedge.edge);after=self.model.resolve(current_coedge.edge);end=before.start_vertex if previous_coedge.reversed else before.end_vertex;start=after.end_vertex if current_coedge.reversed else after.start_vertex
   expected=placement.point_vector(self._vertex_location(end,context='join'));points=[geometry.surface.Value(*uv) for uv in (previous,current)];errors=[(Vec3(p.X(),p.Y(),p.Z())-expected).magnitude for p in points];gap=points[0].Distance(points[1])
   if start==end and all(math.isfinite(d) and d<=self.tolerance for d in errors+[gap]):return
  return super()._check_tolerant_join(previous,current,previous_coedge,current_coedge,geometry,placement,limit,loop_index)
 def _cone_face(self,face,surface,loops,placement):
  try:
   result=super()._cone_face(face,surface,loops,placement)
   result=elliptic_face(self,result,face,surface,loops,placement)
   return cylinder_face(self,result,face,surface,loops,placement)
  except CadQueryConversionError as error:
   if str(error)!='full revolution boundary is not an isocurve' or surface.is_circular() or not surface.is_cylinder():raise
  geo=self._cone_geometry(face,surface,placement);wires=[self._wire(loop,placement,geo) for loop in loops];builder=BRepBuilderAPI_MakeFace(geo.surface,wires[0].wrapped,True)
  for wire in wires[1:]:builder.Add(wire.wrapped)
  original=cq.Face(builder.Face());boundaries=[(e,BRep_Tool.Curve_s(e.wrapped,0.,0.),*BRep_Tool.Range_s(e.wrapped)) for w in wires for e in w.Edges()]
  fix=ShapeFix_Face(original.wrapped);fix.SetPrecision(self.tolerance);fix.SetMaxTolerance(self.tolerance)
  if not fix.FixMissingSeam():raise ValueError('ellipse missing seam failed')
  result=cq.Face(fix.Face());senses=[]
  for edge in result.Edges():
   if BRep_Tool.IsClosed_s(edge.wrapped,result.wrapped):continue
   matches=[old for old,curve,a,b in boundaries if curve==BRep_Tool.Curve_s(edge.wrapped,0.,0.)]
   if len(matches)==1:senses.append(edge.wrapped.Orientation()!=matches[0].wrapped.Orientation())
  if senses and all(senses):result=self._reverse_face(result)
  proof=check_boundaries(self,result,geo.surface,boundaries);self.periodic_seam_faces.append({'face':face.index,**proof})
  if face.reversed!=surface.reversed:result=self._reverse_face(result)
  return result
