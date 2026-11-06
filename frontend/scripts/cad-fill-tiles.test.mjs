import test from "node:test";
import assert from "node:assert/strict";
import {buildFillTileVertices,createFillTilePlanner,parseFillColor,FILL_TILE_STRIDE} from "../public/cad-viewer/core/gpu/fill-tiles.js";

test("overlapping HATCH triangles stay independent and rebase to tile center", () => {
  const descriptors = [
    {bounds:{minX:0,minY:0,maxX:20,maxY:20},triangles:[[[0,0],[20,0],[20,20]]],
      tint:parseFillColor("rgba(0,200,210,1)"),styleKey:"L|rgba(0,200,210,1)",lodSize:20},
    {bounds:{minX:0,minY:0,maxX:20,maxY:20},triangles:[[[0,0],[20,20],[0,20]]],
      tint:parseFillColor("rgba(240,40,80,1)"),styleKey:"L|rgba(240,40,80,1)",lodSize:20}
  ];
  const built = buildFillTileVertices(descriptors,{minX:0,minY:0,maxX:20,maxY:20},{data:null,length:0});
  assert.equal(built.triangles,2);
  assert.equal(built.styleCount,2);
  assert.equal(built.data.length,6*FILL_TILE_STRIDE);
  assert.equal(built.originX,10);
  assert.equal(built.originY,10);
  assert.equal(built.data[0],-10);
  assert.equal(built.data[1],-10);
  assert.equal(built.data[2],0);
  assert.equal(Math.round(built.data[3]*255),200);
  assert.equal(Math.round(built.data[4]*255),210);
  assert.equal(built.data[6],20);
  const secondTriangle = 3*FILL_TILE_STRIDE;
  assert.ok(Math.abs(built.data[secondTriangle + 2]-240/255) < 1e-6);
  assert.ok(Math.abs(built.data[secondTriangle + 3]-40/255) < 1e-6);
});

test("triangles crossing a tile boundary are clipped without dropping the fill", () => {
  const descriptor = {bounds:{minX:-50,minY:-50,maxX:50,maxY:50},
    triangles:[[[-50,-50],[50,-50],[50,50]]],
    tint:[0,0,0,1],styleKey:"cross",lodSize:100};
  const built = buildFillTileVertices([descriptor],{minX:0,minY:0,maxX:50,maxY:50},{data:null,length:0});
  assert.ok(built.triangles >= 1);
  for (let at=0; at<built.data.length; at+=FILL_TILE_STRIDE) {
    assert.ok(built.data[at]+built.originX >= -0.01);
    assert.ok(built.data[at+1]+built.originY >= -0.01);
    assert.ok(built.data[at]+built.originX <= 50.01);
    assert.ok(built.data[at+1]+built.originY <= 50.01);
  }
});

test("fill planner combines adjacent fill entries in source order and reuses tiles", () => {
  let created=0,front=0,uploaded=null;
  const renderer={
    createFillTileBuffer:(data,count,originX,originY)=>{created++;uploaded=data;return {id:created,count,originX,originY};},
    deleteTileBuffer:()=>{},drawFillTile:()=>{front++;}
  };
  const planner=createFillTilePlanner(renderer,{tilePx:400,maxBytes:1024*1024});
  const entries=[
    {kind:"fill",gpuFillRun:1,color:"rgba(255,0,0,1)",layerId:"0",lodSize:100,records:[
      {bbox:{minX:0,minY:0,maxX:10,maxY:10},fillTriangles:[[[0,0],[10,0],[10,10]]]}]},
    {kind:"fill",gpuFillRun:1,color:"rgba(0,0,255,1)",layerId:"0",lodSize:100,records:[
      {bbox:{minX:20,minY:0,maxX:30,maxY:10},fillTriangles:[[[20,0],[30,0],[30,10]]]}]}
  ];
  const node={};
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const view={minX:-10,maxX:40,minY:-10,maxY:20,scale:1,tx:0,ty:0,dpr:1};
  const first=planner.drawRun(node,1,entries,matrix,view,1,0);
  const second=planner.drawRun(node,1,entries,matrix,view,1,0);
  assert.equal(first.tiles,1);
  assert.equal(first.triangles,2);
  assert.equal(second.triangles,2);
  assert.equal(first.built,1);
  assert.equal(second.reused,1);
  assert.equal(created,1);
  assert.equal(front,2);
  assert.equal(uploaded.length,2*3*FILL_TILE_STRIDE);
  assert.ok(uploaded[2] > 0.9);
  const blueAt=3*FILL_TILE_STRIDE;
  assert.ok(uploaded[blueAt+2] < 0.1);
  assert.ok(uploaded[blueAt+4] > 0.9);
});
