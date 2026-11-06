import test from "node:test";
import assert from "node:assert/strict";
import {buildTileVertices,createStrokeTilePlanner,selectTileLevel,visibleTileRange} from "../public/cad-viewer/core/gpu/stroke-tiles.js";
import {shouldProjectInstances} from "../public/cad-viewer/core/drawing-instances.js";

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
  assert.ok(Math.abs(built.data[0] + 50) < 1e-3);
  assert.ok(Math.abs(built.data[2] - 50) < 1e-3);
  assert.equal(built.data[4],1);
});

test("planner reuses a tile buffer for repeated paints", () => {
  let created=0,front=0;
  const renderer={createTileBuffer:()=>({id:++created,segments:1}),deleteTileBuffer:()=>{},drawTile:()=>{front++;}};
  const planner=createStrokeTilePlanner(renderer,{tilePx:400,maxBytes:1024*1024});
  const entry={kind:"stroke",gpuRun:0,dash:[],layerId:"0",color:"rgba(0,0,0,1)",width:1,bounds:{minX:0,minY:0,maxX:100,maxY:100},gpuSegments:[new Float32Array([0,0,100,100])],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:100}}]};
  const node={matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
  const view={minX:-10,maxX:110,minY:-10,maxY:110,scale:1,tx:0,ty:0,dpr:1};
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
  planner.drawRun(node,0,[entry],matrix,{minX:0,maxX:100,minY:0,maxY:10,scale:1,tx:0,ty:0,dpr:1},1,0);
  planner.drawRun(node,0,[entry],matrix,{minX:900,maxX:1000,minY:0,maxY:10,scale:1,tx:0,ty:0,dpr:1},1,0);
  const rebuilt=planner.drawRun(node,0,[entry],matrix,{minX:0,maxX:100,minY:0,maxY:10,scale:1,tx:0,ty:0,dpr:1},1,0);
  assert.equal(rebuilt.tiles,1);
  assert.equal(created,3);
  assert.equal(front,3);
});
test("incomplete webgl view is rejected for canvas fallback", () => {
  let front=0;
  const renderer={createTileBuffer:()=>({segments:1}),deleteTileBuffer:()=>{},drawTile:()=>{front++;}};
  const planner=createStrokeTilePlanner(renderer,{tilePx:400,maxBytes:1024*1024});
  const entry={kind:"stroke",gpuRun:0,dash:[],layerId:"0",color:"rgba(0,0,0,1)",width:1,bounds:{minX:0,minY:0,maxX:100,maxY:100},gpuSegments:[new Float32Array([0,0,100,100])],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:100}}]};
  const node={matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
  const result=planner.drawRun(node,0,[entry],node.matrix,{minX:-10,maxX:110,minY:-10,maxY:110},1,0.75);
  assert.equal(result.tiles,0);
  assert.equal(front,0);
});
test("large-coordinate boundary lines survive tile index and clipping", () => {
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const lines=[
    [458664.223635496,125355.05717890059,685664.223635496,125355.05717890059],
    [685664.223635496,286355.0571789007,458664.223635496,286355.0571789007],
    [458664.223635496,286355.0571789007,458664.223635496,125355.05717890059],
    [685664.223635496,286355.0571789007,685664.223635496,125355.05717890059]
  ];
  const entries=lines.map(line=>{
    const bounds={minX:Math.min(line[0],line[2]),minY:Math.min(line[1],line[3]),maxX:Math.max(line[0],line[2]),maxY:Math.max(line[1],line[3])};
    return {kind:"stroke",gpuRun:0,dash:[],layerId:"L",color:"rgba(0,0,0,1)",width:0.75,bounds,lodSize:Math.max(bounds.maxX-bounds.minX,bounds.maxY-bounds.minY),gpuSegments:[new Float32Array(line)],records:[{bbox:bounds}]};
  });
  let front=0;
  const renderer={createTileBuffer:(data,count,originX,originY)=>({data,count,originX,originY}),deleteTileBuffer:()=>{},drawTile:()=>{front++;}};
  const planner=createStrokeTilePlanner(renderer,{tilePx:360,maxBytes:1024*1024});
  const view={minX:300000,maxX:800000,minY:50000,maxY:350000,scale:0.0020130627129771417,tx:0,ty:0,dpr:1};
  const result=planner.drawRun({},0,entries,matrix,view,view.scale,0.75);
  assert.equal(result.tiles,4);
  assert.equal(result.segments,8);
  assert.equal(front,4);
});

test("per-record LOD does not inherit the whole batch envelope", () => {
  let data=null;
  const renderer={createTileBuffer:(buffer,count,originX,originY)=>{data=buffer;return {segments:count,originX,originY};},deleteTileBuffer:()=>{},drawTile:()=>{}};
  const planner=createStrokeTilePlanner(renderer,{tilePx:400,maxBytes:1024*1024});
  const entry={kind:"stroke",gpuRun:0,dash:[],layerId:"0",color:"rgba(0,0,0,1)",width:1,bounds:{minX:0,minY:0,maxX:100,maxY:100},gpuSegments:[new Float32Array([0,0,1,0]),new Float32Array([0,50,100,50])],records:[{bbox:{minX:0,minY:0,maxX:1,maxY:1}},{bbox:{minX:0,minY:0,maxX:100,maxY:100}}]};
  const view={minX:-10,maxX:110,minY:-10,maxY:110,scale:1,tx:0,ty:0,dpr:1};
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const result=planner.drawRun({},0,[entry],matrix,view,1,0.75);
  assert.equal(result.tiles,1);
  assert.ok(data);
  assert.equal(data[8],1);
  assert.equal(data[17],100);
});

test("block instances share tile buffers while keeping separate matrices", () => {
  let created=0;const matrices=[];
  const renderer={createTileBuffer:(data,count)=>({id:++created,segments:count}),deleteTileBuffer:()=>{},drawTile:(tile,view,minScreenPx,matrix)=>matrices.push(matrix)};
  const planner=createStrokeTilePlanner(renderer,{tilePx:400,maxBytes:1024*1024});
  const entry={kind:"stroke",gpuRun:0,dash:[],layerId:"0",color:"rgba(0,0,0,1)",width:1,bounds:{minX:0,minY:0,maxX:100,maxY:100},gpuSegments:[new Float32Array([0,0,100,100])],records:[{bbox:{minX:0,minY:0,maxX:100,maxY:100}}]};
  const group={};const a={group},b={group};
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];const translated=[1,0,0,0,0,1,0,0,0,0,1,0,25,30,0,1];
  const view={minX:-10,maxX:110,minY:-10,maxY:110,scale:1,tx:0,ty:0,dpr:1};
  assert.equal(planner.drawRun(a,0,[entry],identity,view,1,0.75).tiles,1);
  assert.equal(planner.drawRun(b,0,[entry],translated,view,1,0.75).tiles,1);
  assert.equal(created,1);
  assert.equal(matrices.length,2);
  assert.equal(matrices[0][12],0);
  assert.equal(matrices[1][12],25);
});

test("dense overview drawings use the retained WebGL plan", () => {
  assert.equal(shouldProjectInstances({kind:"model"},718), true);
  assert.equal(shouldProjectInstances({kind:"layout"},718), true);
  assert.equal(shouldProjectInstances({kind:"model"},256), false);
  assert.equal(shouldProjectInstances({kind:"block-preview"},10000), false);
});
