import test from "node:test";
import assert from "node:assert/strict";
import {buildTileVertices,createStrokeTilePlanner,selectTileLevel,visibleTileRange} from "../public/cad-viewer/core/gpu/stroke-tiles.js";

test("tile level follows screen span", () => {
  assert.equal(selectTileLevel({minX:0,minY:0,maxX:1000,maxY:1000},1,360,8),2);
  assert.equal(selectTileLevel({minX:0,minY:0,maxX:100,maxY:100},0.1,360,8),0);
});

test("visible range is clamped to the tile grid", () => {
  const range=visibleTileRange({minX:0,minY:0,maxX:1000,maxY:1000},2,{minX:100,maxX:400,minY:100,maxY:400});
  assert.deepEqual(range,{level:2,x0:0,x1:1,y0:0,y1:1,count:4});
});

test("tile vertices merge styles and rebase around the tile center", () => {
  const descriptors=[
    {bounds:{minX:0,minY:40,maxX:100,maxY:60},worldSegments:new Float32Array([-50,50,150,50]),styleKey:"0|rgba(255,0,0,1)|2",color:[1,0,0],width:2,layerId:"0",lodSize:100},
    {bounds:{minX:0,minY:60,maxX:100,maxY:80},worldSegments:new Float32Array([0,70,100,70]),styleKey:"0|rgba(0,0,255,1)|1",color:[0,0,1],width:1,layerId:"0",lodSize:100}
  ];
  const built=buildTileVertices(descriptors,{minX:0,minY:0,maxX:100,maxY:100});
  assert.equal(built.segments,2);
  assert.equal(built.styleCount,2);
  assert.equal(built.data.length,18);
  assert.equal(built.originX,50);
  assert.equal(built.originY,50);
  assert.equal(built.data[0],-50);
  assert.equal(built.data[2],50);
  assert.equal(built.data[4],1);
});

test("planner reuses a tile buffer for repeated paints", () => {
  let created=0,front=0;
  const renderer={createTileBuffer:()=>({id:++created,segments:1}),deleteTileBuffer:()=>{},drawTile:()=>{front++;}};
  const planner=createStrokeTilePlanner(renderer,{tilePx:400,maxBytes:1024*1024});
  const entry={kind:"stroke",gpuRun:0,dash:[],layerId:"0",color:"rgba(0,0,0,1)",width:1,bounds:{minX:0,minY:0,maxX:100,maxY:100},gpuSegments:[new Float32Array([0,0,100,100])],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:100}}]};
  const node={matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
  const view={minX:-10,maxX:110,minY:-10,maxY:110};
  const first=planner.drawRun(node,0,[entry],[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],view,1,0.75);
  const second=planner.drawRun(node,0,[entry],[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],view,1,0.75);
  assert.equal(first.tiles,1);
  assert.equal(second.tiles,1);
  assert.equal(first.built,1);
  assert.equal(second.reused,1);
  assert.equal(created,1);
  assert.equal(front,2);
});

test("evicted tile buffers are rebuilt instead of redrawn", () => {
  let created=0,front=0;
  const renderer={createTileBuffer:()=>({id:++created,segments:1}),deleteTileBuffer:()=>{},drawTile:()=>{front++;}};
  const planner=createStrokeTilePlanner(renderer,{tilePx:400,maxBytes:50,maxDrawTiles:64});
  const entry={kind:"stroke",gpuRun:0,dash:[],layerId:"0",color:"rgba(0,0,0,1)",width:1,bounds:{minX:0,minY:0,maxX:1000,maxY:10},gpuSegments:[new Float32Array([0,5,20,5]),new Float32Array([980,5,1000,5])],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:10}},{bbox:{minX:900,minY:0,maxX:1000,maxY:10}}]};
  const node={};
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  planner.drawRun(node,0,[entry],matrix,{minX:0,maxX:100,minY:0,maxY:10},1,0);
  planner.drawRun(node,0,[entry],matrix,{minX:900,maxX:1000,minY:0,maxY:10},1,0);
  const rebuilt=planner.drawRun(node,0,[entry],matrix,{minX:0,maxX:100,minY:0,maxY:10},1,0);
  assert.equal(rebuilt.tiles,1);
  assert.equal(created,3);
  assert.equal(front,3);
});


test('shared node geometry follows each parent transform without a second upload',()=>{
 const calls=[];let uploads=0;const renderer={createTileBuffer:(data,segments,x,y)=>({data,segments,originX:x,originY:y,id:++uploads}),deleteTileBuffer(){},drawTile:(tile,view,min,matrix)=>calls.push({tile,matrix:Array.from(matrix)})};
 const planner=createStrokeTilePlanner(renderer),group={},node={group};
 const entry={kind:'stroke',gpuRun:0,dash:[],layerId:'0',color:'rgb(0,0,0)',width:1,lodSize:100,bounds:{minX:0,minY:0,maxX:100,maxY:10},gpuSegments:[[0,5,100,5]],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:10}}]};
 const first=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],second=first.slice();second[12]=1000;
 const a=planner.drawRun(node,0,[entry],first,{minX:-10,maxX:110,minY:-10,maxY:20},1,0.75);
 const b=planner.drawRun(node,0,[entry],second,{minX:990,maxX:1110,minY:-10,maxY:20},1,0.75);
 assert.equal(a.tiles,1);assert.equal(b.tiles,1);assert.equal(uploads,1);assert.equal(calls[1].matrix[12],1000);
 const other={group};planner.drawRun(other,0,[entry],second,{minX:990,maxX:1110,minY:-10,maxY:20},1,0.75);
 assert.equal(uploads,1);assert.equal(calls[0].tile,calls[2].tile);
});

test('rotation, mirror, nonuniform scale and changing LOD keep local buffers reusable',()=>{
 let uploads=0;const seen=[];const renderer={createTileBuffer:(data,segments,x,y)=>({data,segments,originX:x,originY:y,id:++uploads}),deleteTileBuffer(){},drawTile:(tile,view,min,m)=>seen.push(Array.from(m))};
 const planner=createStrokeTilePlanner(renderer),node={};const entry={kind:'stroke',gpuRun:0,dash:[],layerId:'0',color:'rgb(0,0,0)',width:1,lodSize:100,bounds:{minX:0,minY:0,maxX:100,maxY:10},gpuSegments:[[0,5,100,5]],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:10}}]};
 const matrices=[[0,1,0,0,-1,0,0,0,0,0,1,0,100,200,0,1],[-2,0,0,0,0,0.5,0,0,0,0,1,0,400,200,0,1],[1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1]];
 for(const matrix of matrices)assert.equal(planner.drawRun(node,0,[entry],matrix,{minX:-1000,maxX:1000,minY:-1000,maxY:1000},1,3).tiles,1);
 assert.equal(uploads,1);assert.deepEqual(seen,matrices);
});

test('tile uploads yield and cancellation stops unfinished draws',(t)=>{
 let now=0,uploads=0,draws=0;t.mock.method(performance,'now',()=>now+=7);
 const renderer={createTileBuffer:(data,segments)=>({segments,id:++uploads}),deleteTileBuffer(){},drawTile(){draws++;}};
 const planner=createStrokeTilePlanner(renderer),node={},matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 const entry={kind:'stroke',gpuRun:0,color:'rgb(0,0,0)',width:1,lodSize:100,bounds:{minX:0,minY:0,maxX:100,maxY:10},gpuSegments:[[0,5,100,5]],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:10}}]};
 const args=[node,0,[entry],matrix,{minX:-10,maxX:110,minY:-10,maxY:20},1,0.75];
 const pending=planner.drawRunSteps(...args);assert.equal(pending.next().done,false);
 assert.equal(uploads,0);pending.return();assert.equal(draws,0);
 const complete=planner.drawRun(...args);assert.equal(complete.tiles,1);assert.equal(uploads,1);assert.equal(draws,1);
});


test('large-coordinate lines on every tile boundary survive spatial lookup',()=>{
 for(const shift of [0,-600000]){
  const x=300000.1+shift,y=350000.1+shift,endX=300100.09+shift,endY=350100.09+shift;
  const segments=[[x,y,endX,y],[endX,y,endX,endY],[endX,endY,x,endY],[x,endY,x,y]];
  const records=segments.map(([a,b,c,d])=>({bbox:{minX:Math.min(a,c),minY:Math.min(b,d),maxX:Math.max(a,c),maxY:Math.max(b,d)}}));
  const uploaded=[];
  const renderer={createTileBuffer:(data,count,originX,originY)=>{uploaded.push({data,count,originX,originY});return {segments:count};},deleteTileBuffer(){},drawTile(){}};
  const planner=createStrokeTilePlanner(renderer,{maxLevel:0});
  const bounds={minX:x,minY:y,maxX:endX,maxY:endY};
  const entry={kind:'stroke',gpuRun:0,dash:[],layerId:'0',color:'rgb(255,255,0)',width:1,lodSize:100,bounds,records,gpuSegments:segments};
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const result=planner.drawRun({},0,[entry],matrix,bounds,1,0);
  assert.equal(result.segments,4,'all four boundary lines must reach the GPU');
  assert.ok(uploaded[0].data instanceof Float32Array,'GPU vertices remain tile-relative float32');
 }
});
