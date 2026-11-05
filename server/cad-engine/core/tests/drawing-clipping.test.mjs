import test from 'node:test';
import assert from 'node:assert/strict';
import * as clipping from '../../../../frontend/public/cad-viewer/core/drawing-clipping.js';

const square = (a,b,c,d) => [[a,b],[c,b],[c,d],[a,d]];
const region = clips => clipping.compileClips(clips);
const area = polygons => polygons.reduce((total, p) => total + Math.abs(p.slice(1,-1).reduce((sum,b,i) => {
  const a=p[0], c=p[i+2]; return sum+(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
},0))/2, 0);
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);

test('completely excluded strokes, points and filled footprints have no bounds', () => {
  const clips=region([{boundary:square(999,999,1011,1001),inverted:true}]);
  const geometry=clips.geometry({segments:[1000,1000,1010,1000],points:[[1005,1000]],polygons:[square(1001,999.5,1009,1000.5)]});
  assert.equal(clips.contains(1005,1000),false);
  assert.deepEqual(geometry,{segments:[],points:[],polygons:[],bounds:null});
});

test('crossing segments use their visible intervals instead of bbox intersection', () => {
  const clips=region([{boundary:[[0,0],[10,0],[0,10]],inverted:false}]);
  const visible=clips.geometry({segments:[-10,8,20,8]});
  assert.deepEqual(visible.segments,[0,8,2,8]);
  assert.deepEqual(visible.bounds,{minX:0,minY:8,maxX:2,maxY:8});
  assert.equal(clips.contains(8,8),false);
});

test('nonconvex clipping retains separate visible intervals and areas', () => {
  const boundary=[[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6]];
  const clips=region([{boundary,inverted:false}]);
  const visible=clips.geometry({segments:[-1,4,7,4],polygons:[square(-1,-1,7,7)]});
  assert.deepEqual(visible.segments,[0,4,2,4,4,4,6,4]);
  close(area(visible.polygons),28);
  assert.deepEqual(visible.bounds,{minX:0,minY:0,maxX:6,maxY:6});
});

test('normal and inverted chains share line, fill and point membership', () => {
  const clips=region([{boundary:square(0,0,10,10),inverted:false},{boundary:square(3,3,7,7),inverted:true}]);
  const visible=clips.geometry({segments:[-1,5,11,5],polygons:[square(-5,-5,15,15)],points:[[1,1],[5,5],[20,20]]});
  assert.deepEqual(visible.segments,[0,5,3,5,7,5,10,5]);
  assert.deepEqual(visible.points,[[1,1]]);
  close(area(visible.polygons),84);
  assert.deepEqual(visible.bounds,{minX:0,minY:0,maxX:10,maxY:10});
});

test('hole contours and nested islands keep evenodd fill semantics', () => {
  const rings=[square(0,0,10,10),square(2,2,8,8),square(4,4,6,6),square(20,0,22,2)];
  const triangles=clipping.triangulateRings(rings);
  close(area(triangles),72);
  const visible=region([{boundary:square(3,-1,7,11),inverted:false}]).geometry({polygons:triangles});
  close(area(visible.polygons),20);
  assert.deepEqual(visible.bounds,{minX:3,minY:0,maxX:7,maxY:10});
});

test('a clip inside a large fill creates the actual boundary; coincident exclusion is empty', () => {
  const boundary=square(3,4,7,8);
  const inside=region([{boundary,inverted:false}]).geometry({polygons:[square(-100,-100,100,100)]});
  close(area(inside.polygons),16);
  assert.deepEqual(inside.bounds,{minX:3,minY:4,maxX:7,maxY:8});
  const excluded=region([{boundary,inverted:true}]).geometry({polygons:[boundary],segments:[3,4,7,4]});
  assert.equal(excluded.bounds,null);
});

test('mirrors and large source coordinates preserve region geometry', () => {
  const offset=1e9, boundary=square(0,0,6,6).map(([x,y])=>[offset-x,offset+y]).reverse();
  const clips=region([{boundary,inverted:false}]);
  const visible=clips.geometry({polygons:[square(offset-10,offset-10,offset+10,offset+10)],segments:[offset-10,offset+3,offset+10,offset+3]});
  close(area(visible.polygons),36);
  assert.deepEqual(visible.bounds,{minX:offset-6,minY:offset,maxX:offset,maxY:offset+6});
  assert.equal(clips.contains(offset-3,offset+3),true);
});

test('zero length CAD dots follow the same boundary rule', () => {
  const clips=region([{boundary:square(0,0,2,2),inverted:false}]);
  assert.deepEqual(clips.geometry({segments:[1,1,1,1,3,3,3,3]}).segments,[1,1,1,1]);
});
