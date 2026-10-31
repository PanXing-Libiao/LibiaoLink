"""Bounded preview for a complete elliptic cylinder between two planar rims."""
import math
import cadquery as cq
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.Geom import Geom_SurfaceOfLinearExtrusion,Geom_Ellipse,Geom_Circle,Geom_RectangularTrimmedSurface
from OCP.GeomAbs import GeomAbs_Plane

def mesh(shape,precision,linear=.08,angular=.15):
 faces=shape.Faces()
 if len(faces)!=3 or len(shape.Solids())!=1:return None
 side=None;caps=[]
 for face in faces:
  surface=BRep_Tool.Surface_s(face.wrapped)
  if isinstance(surface,Geom_RectangularTrimmedSurface):surface=surface.BasisSurface()
  if isinstance(surface,Geom_SurfaceOfLinearExtrusion) and isinstance(surface.BasisCurve(),Geom_Ellipse):side=(face,surface)
  elif BRepAdaptor_Surface(face.wrapped).GetType()==GeomAbs_Plane:caps.append(face)
  else:return None
 if side is None or len(caps)!=2:return None
 face,surface=side;basis=surface.BasisCurve();center=cq.Vector(basis.Location());x=cq.Vector(basis.Position().XDirection());y=cq.Vector(basis.Position().YDirection());axis=cq.Vector(surface.Direction());a=x*basis.MajorRadius();b=y*basis.MinorRadius()
 if abs(axis.dot(x))>1e-10 or abs(axis.dot(y))>1e-10:return None
 sections=[]
 for cap in caps:
  edges=cap.Edges()
  if len(edges)!=1 or not edges[0].IsClosed():return None
  edge=edges[0];curve=BRep_Tool.Curve_s(edge.wrapped,0.,0.)
  if not isinstance(curve,(Geom_Circle,Geom_Ellipse)):return None
  first,last=BRep_Tool.Range_s(edge.wrapped)
  if abs(last-first-2*math.pi)>1e-10:return None
  plane=BRepAdaptor_Surface(cap.wrapped).Plane();normal=cq.Vector(plane.Axis().Direction());origin=cq.Vector(plane.Location());denom=normal.dot(axis)
  if abs(denom)<1e-8:return None
  c=normal.dot(origin-center)/denom;ca=-normal.dot(a)/denom;cb=-normal.dot(b)/denom
  source_center=cq.Vector(curve.Location());delta=source_center-center-axis*c
  major=cq.Vector(curve.Position().XDirection())*(curve.Radius() if isinstance(curve,Geom_Circle) else curve.MajorRadius());minor=cq.Vector(curve.Position().YDirection())*(curve.Radius() if isinstance(curve,Geom_Circle) else curve.MinorRadius())
  coords=[(v.dot(x)/basis.MajorRadius(),v.dot(y)/basis.MinorRadius()) for v in (major,minor)]
  if delta.Length>precision or any(abs(u*u+v*v-1)>precision/max(basis.MajorRadius(),1) for u,v in coords) or abs(coords[0][0]*coords[1][0]+coords[0][1]*coords[1][1])>precision/max(basis.MajorRadius(),1):return None
  sections.append((cap,c,ca,cb))
 sections.sort(key=lambda row:row[1]);low,high=sections
 if high[1]-low[1]-math.hypot(high[2]-low[2],high[3]-low[3])<=precision:return None
 curvature=max((a+axis*ca).Length+(b+axis*cb).Length for _,c,ca,cb in sections)
 step=min(math.sqrt(8*linear/curvature),angular*basis.MinorRadius()/basis.MajorRadius()/2)
 count=max(8,math.ceil(2*math.pi/step))
 if count>40000:return None
 angles={2*math.pi*i/count for i in range(count)}
 for vertex in shape.Vertices():
  d=vertex.Center()-center;angles.add(math.atan2(d.dot(y)/basis.MinorRadius(),d.dot(x)/basis.MajorRadius())%(2*math.pi))
 ordered=sorted(angles);angles=[];epsilon=min(1e-10,precision/max(curvature,1))
 for u in ordered:
  if not angles or u-angles[-1]>epsilon:angles.append(u)
 if len(angles)>1 and angles[0]+2*math.pi-angles[-1]<=epsilon:angles.pop()
 n=len(angles);vertices=[]
 for cap,c,ca,cb in sections:
  vertices.extend(center+a*math.cos(u)+b*math.sin(u)+axis*(c+ca*math.cos(u)+cb*math.sin(u)) for u in angles)
 vertices.extend(center+axis*s[1] for s in sections);triangles=[]
 def add(i,j,k,target):
  cross=(vertices[j]-vertices[i]).cross(vertices[k]-vertices[i])
  if cross.Length<1e-20:return
  mid=(vertices[i]+vertices[j]+vertices[k])/3;normal=target.normalAt(mid)
  triangles.append((i,k,j) if cross.dot(normal)<0 else (i,j,k))
 for i in range(n):
  j=(i+1)%n;add(i,j,n+j,face);add(i,n+j,n+i,face);add(2*n,j,i,low[0]);add(2*n+1,n+i,n+j,high[0])
 return vertices,triangles,{'segments':n,'linearBound':curvature*(2*math.pi/count)**2/8,'angularStep':2*math.pi/count,'sourceFaces':3}
