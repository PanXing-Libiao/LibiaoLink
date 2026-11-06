import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizedDash,dashSegmentsForView,dashViewScale} from '../public/cad-viewer/core/gpu/dashed-strokes.js';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],view={scale:1,tx:0,ty:100,dpr:1};
const rows=(records,dash=[7,3],matrix=I,v=view)=>Array.from(dashSegmentsForView(records.map(segments=>({segments})),normalizedDash(dash),matrix,v,200,200,2));
test('connected edges retain phase; disconnected subpaths and records restart it',()=>{
 const a=rows([[10,20,23,20,23,20,23,36,50,20,67,20],[80,20,95,20]]);
 assert.equal(a[4],0);assert.equal(a[9],3);assert.equal(a[14],0);assert.equal(a[19],0);
});
test('viewport clipping keeps the original dash phase',()=>{
 const a=rows([[-10005,50,1005,50]],[17,8]);
 assert.equal(a[0],-3);assert.equal(a[2],203);assert.equal(a[4],2);
});
test('screen conversion retains translated large-coordinate detail',()=>{
 const normal=rows([[20,50,270,50]],[12,8]);
 const large=rows([[1000000020,50,1000000270,50]],[12,8],I,{...view,tx:-1000000000});
 assert.deepEqual(large,normal);
});
test('millions of dash repetitions do not expand source geometry',()=>{
 const a=rows([[0,0,2800,0]],[.0025,.001],I,{...view,scale:.06});
 assert.equal(a.length,5);assert.equal(a[2],168);
});
test('odd patterns follow Canvas repetition and transforms retain their own scale',()=>{
 assert.deepEqual(normalizedDash([6,3,2]),[6,3,2,6,3,2]);
 const mirror=I.slice();mirror[0]=-2;mirror[5]=2;assert.equal(dashViewScale(mirror,view),2);
 const anisotropic=I.slice();anisotropic[0]=2;assert.equal(dashViewScale(anisotropic,view),0);
 const shear=I.slice();shear[4]=.5;assert.equal(dashViewScale(shear,view),0);
});
test('zero-length edges do not introduce dots absent in the Canvas path',()=>{
 assert.equal(rows([[5,5,5,5]],[0,8]).length,0);
});

 test('missing WebGL2 returns an unavailable renderer instead of aborting page setup',async()=>{
 const {createStrokeGPU}=await import('../public/cad-viewer/core/gpu/gpu-strokes.js');
 assert.equal(createStrokeGPU(()=>({getContext:()=>null})),null);
});
