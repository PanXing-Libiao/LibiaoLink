import math
from OCP.Geom import Geom_SurfaceOfLinearExtrusion
from OCP.GeomAPI import GeomAPI_ProjectPointOnCurve
from OCP.Geom2dAPI import Geom2dAPI_Interpolate
from OCP.TColgp import TColgp_HArray1OfPnt2d
from OCP.TColStd import TColStd_HArray1OfReal
from OCP.gp import gp_Pnt2d,gp_Dir
from cq_acis._supported_curves import deviation

def check(candidate,source,limit):
 first,last=candidate.FirstParameter(),candidate.LastParameter();lo,hi=source.FirstParameter(),source.LastParameter();surface=Geom_SurfaceOfLinearExtrusion(source,gp_Dir(0,0,1));knots=[first]+[candidate.Knot(i) for i in range(1,candidate.NbKnots()+1) if first<candidate.Knot(i)<last]+[last];maximum=0;covered=[]
 for a,b in zip(knots,knots[1:]):
  for n in (33,65,129,257):
   points=TColgp_HArray1OfPnt2d(1,n);params=TColStd_HArray1OfReal(1,n);mapped=[]
   for i in range(n):
    t=a+(b-a)*i/(n-1);p=candidate.Value(t);proj=GeomAPI_ProjectPointOnCurve(p,source,lo,hi);options=[(p.Distance(source.Value(u)),u) for u in (lo,hi)]
    if proj.NbPoints():options.append((proj.LowerDistance(),proj.LowerDistanceParameter()))
    d,u=min(options)
    if t==first:u=lo
    if t==last:u=hi
    mapped.append(u);points.SetValue(i+1,gp_Pnt2d(u,0));params.SetValue(i+1,t)
   if any(y<=x for x,y in zip(mapped,mapped[1:])):raise ValueError('nonmonotone curve correspondence')
   interp=Geom2dAPI_Interpolate(points,params,False,1e-12);interp.Perform();pc=interp.Curve();poles=[pc.Pole(i).X() for i in range(1,pc.NbPoles()+1)]
   if any(y<x for x,y in zip(poles,poles[1:])):continue
   error=deviation(candidate,pc,surface,a,b)
   if error<=limit:break
  else:raise ValueError('full-span fit failed '+str(error))
  maximum=max(maximum,error);covered.append((mapped[0],mapped[-1]))
 if abs(covered[0][0]-lo)>1e-10 or abs(covered[-1][1]-hi)>1e-10 or any(abs(a[1]-b[0])>1e-10 for a,b in zip(covered,covered[1:])):raise ValueError('source curve interval coverage incomplete')
 return {'fullSpanMax':maximum,'sourceFitLimit':limit,'spans':len(covered),'monotoneCoverage':True}
