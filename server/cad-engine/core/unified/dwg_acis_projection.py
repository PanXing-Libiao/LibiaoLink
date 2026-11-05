import math
from OCP.Geom2dAPI import Geom2dAPI_Interpolate
from OCP.TColgp import TColgp_HArray1OfPnt2d
from OCP.TColStd import TColStd_HArray1OfReal
from OCP.gp import gp_Pnt2d
from cq_acis.model import Vec3
from cq_acis._supported_curves import deviation

def smooth_project(curve,geometry,first,last,tolerance):
 for n in (65,129,257,513):
  points=TColgp_HArray1OfPnt2d(1,n);params=TColStd_HArray1OfReal(1,n);previous=None
  for i in range(n):
   t=first+(last-first)*i/(n-1);p=curve.Value(t);u,v=geometry.uv(Vec3(p.X(),p.Y(),p.Z()))
   if previous is not None:u+=round((previous-u)/(2*math.pi))*2*math.pi
   previous=u;points.SetValue(i+1,gp_Pnt2d(u,v));params.SetValue(i+1,t)
  interp=Geom2dAPI_Interpolate(points,params,False,1e-12);interp.Perform()
  if not interp.IsDone():raise ValueError('UV interpolation failed')
  pc=interp.Curve();error=deviation(curve,pc,geometry.surface,first,last)
  if error<=tolerance:return pc,{'points':n,'error':error}
 raise ValueError('UV error '+str(error))

def project(curve,geometry,first,last,tolerance):
 from OCP.Geom import Geom_BSplineCurve
 from OCP.Geom2d import Geom2d_BSplineCurve
 from OCP.TColgp import TColgp_Array1OfPnt2d
 from OCP.TColStd import TColStd_Array1OfReal,TColStd_Array1OfInteger
 from cq_acis._supported_curves import array
 if not isinstance(curve,Geom_BSplineCurve):return smooth_project(curve,geometry,first,last,tolerance)
 knots=[first]+[curve.Knot(i) for i in range(1,curve.NbKnots()+1) if first<curve.Knot(i)<last]+[last];pieces=[];previous=None;proofs=[]
 if len(knots)>65:raise ValueError("UV span budget")
 for a,b in zip(knots,knots[1:]):
  piece,proof=smooth_project(curve,geometry,a,b,tolerance);proofs.append(proof)
  if previous is not None:
   from OCP.gp import gp_Vec2d
   shift=round((previous-piece.Value(a).X())/(2*math.pi))*2*math.pi;piece.Translate(gp_Vec2d(shift,0))
  previous=piece.Value(b).X();pieces.append(piece)
 poles=[];values=[];mult=[]
 for piece in pieces:
  if piece.Degree()!=3 or piece.IsRational():raise ValueError('unexpected interpolant')
  if poles:
   if poles[-1].Distance(piece.Pole(1))>1e-10:raise ValueError('UV knot discontinuity')
   mult[-1]=3
  start=2 if poles else 1
  poles.extend(piece.Pole(i) for i in range(start,piece.NbPoles()+1));values.extend(piece.Knot(i) for i in range(2 if values else 1,piece.NbKnots()+1));mult.extend(piece.Multiplicity(i) for i in range(2 if mult else 1,piece.NbKnots()+1))
 pc=Geom2d_BSplineCurve(array(poles,TColgp_Array1OfPnt2d),array(values,TColStd_Array1OfReal),array(mult,TColStd_Array1OfInteger),3,False)
 maximum=max(deviation(curve,pc,geometry.surface,a,b) for a,b in zip(knots,knots[1:]))
 if maximum>tolerance:raise ValueError('joined UV error '+str(maximum))
 return pc,{'spans':len(pieces),'error':maximum,'points':sum(p['points'] for p in proofs)}
