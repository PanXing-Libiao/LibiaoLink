// One region contract for painting, picking and navigation. Source stroke paths
// remain intact for Canvas dash phase; interaction uses their clipped intervals.
import {ShapeUtils, Vector2} from './vendor/three.core.js';

export function drawingClips(draw, viewports) {
  // Instanced projection stores the viewport boundary in the retained draw's
  // space-local coordinates; resolving the paper boundary again would clip a
  // second time under a different basis.
  if (draw.viewportClipLocal) return draw.clipRegions || [];
  const viewport = viewports[draw.viewportId];
  return (viewport ? [{boundary: viewport.clipBoundary, inverted: false}] : []).concat(draw.clipRegions || []);
}

const cross = (ax, ay, bx, by) => ax*by-ay*bx;
const side = (a,b,p) => cross(b[0]-a[0],b[1]-a[1],p[0]-a[0],p[1]-a[1]);
const equal = (a,b) => a[0]===b[0] && a[1]===b[1];
function cleanRing(ring) {
  const result=[];
  for (const p of ring) if (!result.length || !equal(p,result[result.length-1])) result.push(p);
  if (result.length>1 && equal(result[0],result[result.length-1])) result.pop();
  return result;
}
function area2(ring) {
  let total=0;
  for (let i=1;i+1<ring.length;i++) total+=side(ring[0],ring[i],ring[i+1]);
  return total;
}
export function insideRing(x,y,ring) {
  let inside=false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[j],b=ring[i],dx=b[0]-a[0],dy=b[1]-a[1];
    if (Math.abs(cross(x-a[0],y-a[1],dx,dy))<=1e-10*Math.max(1,Math.hypot(dx,dy))
      && x>=Math.min(a[0],b[0])-1e-10 && x<=Math.max(a[0],b[0])+1e-10
      && y>=Math.min(a[1],b[1])-1e-10 && y<=Math.max(a[1],b[1])+1e-10) return true;
    if ((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}

// HATCH's noncrossing contours are evenodd: immediate children are holes and
// grandchildren are islands. Reuse the already bundled Earcut for triangulation.
export function triangulateRings(source) {
  const rings=source.map(cleanRing),areas=rings.map(r=>Math.abs(area2(r)));
  const parents=rings.map((ring,i)=>{
    let parent=-1;
    for (let j=0;j<rings.length;j++) if (areas[j]>areas[i]
      && (parent===-1 || areas[j]<areas[parent]) && insideRing(...ring[0],rings[j])) parent=j;
    return parent;
  });
  const depths=parents.map(parent=>{
    let depth=0;
    for (let p=parent;p!==-1;p=parents[p]) depth++;
    return depth;
  });
  const result=[];
  let expectedArea=0;
  for (let i=0;i<rings.length;i++) {
    expectedArea+=(depths[i]%2?-1:1)*areas[i];
    if (depths[i]%2) continue;
    const contour=rings[i].map(([x,y])=>new Vector2(x,y));
    const holes=rings.filter((_,j)=>parents[j]===i).map(r=>r.map(([x,y])=>new Vector2(x,y)));
    const indices=ShapeUtils.triangulateShape(contour,holes),vertices=[contour,...holes].flat();
    for (const face of indices) {
      const triangle=face.map(at=>[vertices[at].x,vertices[at].y]);
      if (area2(triangle)<0) triangle.reverse();
      if (area2(triangle)!==0) result.push(triangle);
    }
  }
  const actualArea=result.reduce((sum,p)=>sum+area2(p),0);
  if (Math.abs(actualArea-expectedArea)>1e-8*Math.max(1,expectedArea)) throw new Error('drawing-clipping-triangulation-failed');
  return result;
}

function boundsOf(polygons,segments=[],points=[]) {
  let bounds=null;
  const extend=([x,y])=>{
    if (!bounds) bounds={minX:x,minY:y,maxX:x,maxY:y};
    else {bounds.minX=Math.min(bounds.minX,x);bounds.minY=Math.min(bounds.minY,y);bounds.maxX=Math.max(bounds.maxX,x);bounds.maxY=Math.max(bounds.maxY,y);}
  };
  for (const polygon of polygons) for (const p of polygon) extend(p);
  for (let i=0;i<segments.length;i+=2) extend([segments[i],segments[i+1]]);
  points.forEach(extend);
  return bounds;
}
const overlaps=(a,b)=>a.minX<=b.maxX && a.maxX>=b.minX && a.minY<=b.maxY && a.maxY>=b.minY;

// Convex pieces remain convex under a half-plane split. The same operation
// yields intersection and subtraction, including inverse clips and holes.
function splitPolygon(polygon,a,b) {
  const inside=[],outside=[];
  for (let i=0;i<polygon.length;i++) {
    const p=polygon[i],q=polygon[(i+1)%polygon.length],s=side(a,b,p),t=side(a,b,q);
    if (s>=0) inside.push(p);
    if (s<=0) outside.push(p);
    if ((s<0 && t>0)||(s>0 && t<0)) {
      const u=s/(s-t),hit=[p[0]+u*(q[0]-p[0]),p[1]+u*(q[1]-p[1])];
      inside.push(hit);outside.push(hit);
    }
  }
  const valid=points=>{const ring=cleanRing(points);return ring.length>=3 && area2(ring)!==0?ring:[];};
  return [valid(inside),valid(outside)];
}
function intersectConvex(polygon,triangle) {
  let remaining=polygon;
  for (let i=0;i<3 && remaining.length;i++) [remaining]=splitPolygon(remaining,triangle[i],triangle[(i+1)%3]);
  return remaining;
}
function subtractConvex(polygon,triangle) {
  const result=[];
  let remaining=polygon;
  for (let i=0;i<3 && remaining.length;i++) {
    const [inside,outside]=splitPolygon(remaining,triangle[i],triangle[(i+1)%3]);
    if (outside.length) result.push(outside);
    remaining=inside;
  }
  return result;
}

export function compileClips(clips) {
  const contains=(x,y)=>clips.every(clip=>insideRing(x,y,clip.boundary)!==clip.inverted);
  const regions=clips.map(clip=>({...clip,bounds:boundsOf([clip.boundary]),triangles:null}));
  // Undefined means unbounded; null means an empty intersection. Infinite source
  // lines need this finite search window before the same geometry clipping runs.
  let finiteBounds;
  for (const region of regions) if (!region.inverted) {
    if (finiteBounds===undefined) finiteBounds={...region.bounds};
    else if (finiteBounds) {
      const b=region.bounds;
      finiteBounds={minX:Math.max(finiteBounds.minX,b.minX),minY:Math.max(finiteBounds.minY,b.minY),
        maxX:Math.min(finiteBounds.maxX,b.maxX),maxY:Math.min(finiteBounds.maxY,b.maxY)};
      if (finiteBounds.minX>finiteBounds.maxX || finiteBounds.minY>finiteBounds.maxY) finiteBounds=null;
    }
  }
  function segments(source) {
    if (!clips.length) return source;
    const result=[];
    for (let i=0;i<source.length;i+=4) {
      const [x,y,bx,by]=source.slice(i,i+4),dx=bx-x,dy=by-y,cuts=[0,1];
      if (dx===0 && dy===0) {if (contains(x,y)) result.push(x,y,x,y);continue;}
      for (const {boundary} of clips) for (let j=0;j<boundary.length;j++) {
        const a=boundary[j],b=boundary[(j+1)%boundary.length],ex=b[0]-a[0],ey=b[1]-a[1];
        const denominator=cross(dx,dy,ex,ey),ax=a[0]-x,ay=a[1]-y;
        if (denominator!==0) {
          const t=cross(ax,ay,ex,ey)/denominator,u=cross(ax,ay,dx,dy)/denominator;
          if (t>0 && t<1 && u>=0 && u<=1) cuts.push(t);
        } else if (cross(ax,ay,dx,dy)===0) {
          const length2=dx*dx+dy*dy;
          for (const p of [a,b]) {const t=((p[0]-x)*dx+(p[1]-y)*dy)/length2;if(t>0 && t<1)cuts.push(t);}
        }
      }
      cuts.sort((a,b)=>a-b);
      for (let j=0;j+1<cuts.length;j++) {
        const a=cuts[j],b=cuts[j+1],mid=(a+b)/2;
        if (b>a && contains(x+dx*mid,y+dy*mid)) result.push(x+dx*a,y+dy*a,x+dx*b,y+dy*b);
      }
    }
    return result;
  }
  function polygons(source) {
    let pieces=source;
    for (const region of regions) {
      if (!pieces.length) break;
      // Stroke-only drawings never need to triangulate their clip boundaries.
      region.triangles??=triangulateRings([region.boundary]).map(triangle=>({triangle,bounds:boundsOf([triangle])}));
      const next=[];
      for (const piece of pieces) {
        const box=boundsOf([piece]);
        if (!overlaps(box,region.bounds)) {if(region.inverted)next.push(piece);continue;}
        if (region.inverted) {
          let remaining=[piece];
          for (const {triangle,bounds} of region.triangles) {
            const fragments=[];
            for (const polygon of remaining) {
              if (overlaps(boundsOf([polygon]),bounds)) fragments.push(...subtractConvex(polygon,triangle));
              else fragments.push(polygon);
            }
            remaining=fragments;
            if (!remaining.length) break;
          }
          next.push(...remaining);
        } else for (const {triangle,bounds} of region.triangles) {
          if (!overlaps(box,bounds)) continue;
          const intersection=intersectConvex(piece,triangle);
          if (intersection.length) next.push(intersection);
        }
      }
      pieces=next;
    }
    return pieces;
  }
  return {
    active:clips.length>0,contains,finiteBounds,
    geometry({segments:lines=[],polygons:faces=[],points:marks=[]}) {
      const visible={segments:segments(lines),polygons:polygons(faces),points:marks.filter(p=>contains(...p))};
      return {...visible,bounds:boundsOf(visible.polygons,visible.segments,visible.points)};
    },
    apply(ctx,visibleBounds) {
      for (const {boundary,inverted} of clips) {
        const path=new Path2D();
        if (inverted) {const b=visibleBounds;path.rect(b.minX,b.minY,b.maxX-b.minX,b.maxY-b.minY);}
        path.moveTo(...boundary[0]);
        for (const p of boundary.slice(1)) path.lineTo(...p);
        path.closePath();ctx.clip(path,'evenodd');
      }
    }
  };
}
