import {createDashedStrokeGPU} from './dashed-strokes.js?v=dxf-0.17.24';
import {LOD_BIN_RATIO} from '../drawing-instances.js?v=dxf-0.17.24';
// Batched solid-stroke renderer. Geometry is uploaded once per spatial tile and
// reused across pan/zoom; non-stroke CAD semantics remain in the existing viewer.
export function createStrokeGPU(makeCanvas=()=>document.createElement("canvas")) {
 const canvas=makeCanvas();
 const gl=canvas.getContext("webgl2",{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
 if(!gl)return null;
 function shader(type,source){const value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(value));return value;}
 const program=gl.createProgram();
 gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
precision highp float;
layout(location=0) in vec4 segment;
layout(location=1) in vec3 tint;
layout(location=2) in float strokeWidth;
layout(location=3) in float lodSize;
uniform vec2 viewport;
uniform vec3 view;
uniform vec2 originScreen;
uniform mat2 instanceLinear;
uniform float dpr;
uniform float minWorldSize;
out vec2 distanceToLine;
flat out float lineLength;
flat out vec3 color;
flat out float width;
void main() {
 if(lodSize>0.0 && lodSize<=minWorldSize){
  distanceToLine=vec2(0.0);lineLength=0.0;color=tint;width=strokeWidth;
  gl_Position=vec4(3.0,3.0,3.0,1.0);return;
 }
 vec2 a=instanceLinear*segment.xy;
 vec2 b=instanceLinear*segment.zw;
 vec2 delta=b-a;float len=length(delta);
 vec2 direction=len>0.?delta/len:vec2(1.,0.);
 vec2 normal=vec2(-direction.y,direction.x);
 int vertex=gl_VertexID;
 float end=(vertex==1||vertex==2||vertex==4)?1.:0.;
 float side=(vertex==2||vertex==4||vertex==5)?1.:-1.;
 float deviceScale=max(view.x*dpr,1e-9);
 float deviceWidth=max(strokeWidth*dpr,0.001);
 float extent=(deviceWidth*.5+1.)/deviceScale;
 float along=mix(-extent,len+extent,end);
 vec2 p=a+direction*along+normal*side*extent;
 distanceToLine=vec2(along,side*extent)*deviceScale;lineLength=len*deviceScale;color=tint;width=deviceWidth;
 gl_Position=vec4((originScreen.x+p.x*view.x)*dpr/viewport.x*2.-1.,1.-(originScreen.y-p.y*view.x)*dpr/viewport.y*2.,0.,1.);
}`));
 gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
precision highp float;
in vec2 distanceToLine;
flat in float lineLength;
flat in vec3 color;
flat in float width;
out vec4 result;
void main() {
 if(lineLength<0.0001)discard;
 float across=clamp(width*.5+.5-abs(distanceToLine.y),0.,1.);
 float along=clamp(distanceToLine.x+.5,0.,1.)*clamp(lineLength-distanceToLine.x+.5,0.,1.);
 float alpha=across*along;
 result=vec4(color*alpha,alpha);
}`));
 gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
 const fillProgram=gl.createProgram();
 gl.attachShader(fillProgram,shader(gl.VERTEX_SHADER,"#version 300 es\nprecision highp float;\nlayout(location=0) in vec2 position;\nlayout(location=1) in vec4 tint;\nlayout(location=2) in float lodSize;\nuniform vec2 viewport;\nuniform vec3 view;\nuniform vec2 originScreen;\nuniform mat2 instanceLinear;\nuniform float dpr;\nuniform float minWorldSize;\nflat out vec4 color;\nvoid main(){\n if(lodSize>0.0 && lodSize<=minWorldSize){color=tint;gl_Position=vec4(3.0,3.0,3.0,1.0);return;}\n vec2 p=instanceLinear*position;color=tint;\n gl_Position=vec4((originScreen.x+p.x*view.x)*dpr/viewport.x*2.-1.,1.-(originScreen.y-p.y*view.x)*dpr/viewport.y*2.,0.,1.);\n}"));
 gl.attachShader(fillProgram,shader(gl.FRAGMENT_SHADER,"#version 300 es\nprecision highp float;\nflat in vec4 color;\nout vec4 result;\nvoid main(){result=vec4(color.rgb*color.a,color.a);}"));
 gl.linkProgram(fillProgram);if(!gl.getProgramParameter(fillProgram,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(fillProgram));
 const fillU={viewport:gl.getUniformLocation(fillProgram,"viewport"),view:gl.getUniformLocation(fillProgram,"view"),originScreen:gl.getUniformLocation(fillProgram,"originScreen"),linear:gl.getUniformLocation(fillProgram,"instanceLinear"),dpr:gl.getUniformLocation(fillProgram,"dpr"),minWorldSize:gl.getUniformLocation(fillProgram,"minWorldSize")};
 const u={viewport:gl.getUniformLocation(program,"viewport"),view:gl.getUniformLocation(program,"view"),originScreen:gl.getUniformLocation(program,"originScreen"),linear:gl.getUniformLocation(program,"instanceLinear"),dpr:gl.getUniformLocation(program,"dpr"),minWorldSize:gl.getUniformLocation(program,"minWorldSize")};
 const stride=9,bytesPerVertex=stride*4;
 const fillStride=7,fillBytesPerVertex=fillStride*4;
 const buffers=new Set();
 let calls=0,segments=0,tileBatches=0,bufferBytes=0,pendingDraw=false;
 let fillCalls=0,fillTriangles=0,fillTileBatches=0;
 let activeView=null,activeMatrix=null,activeMinPx=null,dashed=null;
 let activeFillView=null,activeFillMatrix=null,activeFillMinPx=null;
 let activeProgram=null;
 let damage=null,submission=null;
 function useProgram(value){if(activeProgram!==value){gl.useProgram(value);activeProgram=value;}}
 // Include the complete stroke footprint, including caps and antialiasing. The
 // source draw order is unchanged; only transparent space around it is omitted.
 function includeBounds(box,m,v,width){
  if(!box||!Number.isFinite(box.minX)||!Number.isFinite(box.minY)||!Number.isFinite(box.maxX)||!Number.isFinite(box.maxY))return;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const x of [box.minX,box.maxX])for(const y of [box.minY,box.maxY]){
   const sx=v.dpr*(v.tx+v.scale*(m[0]*x+m[4]*y+m[12]));
   const sy=v.dpr*(v.ty-v.scale*(m[1]*x+m[5]*y+m[13]));
   left=Math.min(left,sx);right=Math.max(right,sx);top=Math.min(top,sy);bottom=Math.max(bottom,sy);
  }
  const pad=(Number(width)||0)*v.dpr*.5+3;
  left=Math.max(0,Math.floor(left-pad));top=Math.max(0,Math.floor(top-pad));
  right=Math.min(canvas.width,Math.ceil(right+pad));bottom=Math.min(canvas.height,Math.ceil(bottom+pad));
  if(right<=left||bottom<=top)return;
  if(!damage)damage={left,top,right,bottom};
  else {damage.left=Math.min(damage.left,left);damage.top=Math.min(damage.top,top);damage.right=Math.max(damage.right,right);damage.bottom=Math.max(damage.bottom,bottom);}
 }
 function configureStrokeAttributes(){
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,bytesPerVertex,0);gl.vertexAttribDivisor(0,1);
  gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,bytesPerVertex,16);gl.vertexAttribDivisor(1,1);
  gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,1,gl.FLOAT,false,bytesPerVertex,28);gl.vertexAttribDivisor(2,1);
  gl.enableVertexAttribArray(3);gl.vertexAttribPointer(3,1,gl.FLOAT,false,bytesPerVertex,32);gl.vertexAttribDivisor(3,1);
 }
 function configureFillAttributes(){
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,fillBytesPerVertex,0);gl.vertexAttribDivisor(0,0);
  gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,4,gl.FLOAT,false,fillBytesPerVertex,8);gl.vertexAttribDivisor(1,0);
  gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,1,gl.FLOAT,false,fillBytesPerVertex,24);gl.vertexAttribDivisor(2,0);
  gl.disableVertexAttribArray(3);
 }
 function begin(w,h){
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  gl.viewport(0,0,w,h);gl.useProgram(program);activeProgram=program;gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform2f(u.viewport,w,h);
  gl.useProgram(fillProgram);gl.uniform2f(fillU.viewport,w,h);gl.useProgram(program);activeProgram=program;
  calls=0;segments=0;tileBatches=0;fillCalls=0;fillTriangles=0;fillTileBatches=0;pendingDraw=false;damage=null;
  activeView=null;activeMatrix=null;activeMinPx=null;
  activeFillView=null;activeFillMatrix=null;activeFillMinPx=null;
 }
 function createTileBuffer(data,count,originX,originY){
  const buffer=gl.createBuffer(),vao=gl.createVertexArray();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);configureStrokeAttributes();
  // Bound the actual uploaded (float32) endpoints once, rather than rescanning
  // geometry for every redraw. Each instance applies its own parent transform.
  const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};let width=0;
  for(let i=0;i<data.length;i+=stride){
   bounds.minX=Math.min(bounds.minX,data[i]+originX,data[i+2]+originX);bounds.maxX=Math.max(bounds.maxX,data[i]+originX,data[i+2]+originX);
   bounds.minY=Math.min(bounds.minY,data[i+1]+originY,data[i+3]+originY);bounds.maxY=Math.max(bounds.maxY,data[i+1]+originY,data[i+3]+originY);
   width=Math.max(width,data[i+7]);
  }
  const tile={kind:"stroke",buffer,vao,segments:count,originX,originY,bytes:data.byteLength,bounds,width};buffers.add(tile);bufferBytes+=tile.bytes;return tile;
 }
 function createFillTileBuffer(data,count,originX,originY){
  const buffer=gl.createBuffer(),vao=gl.createVertexArray();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);configureFillAttributes();
  const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
  for(let i=0;i<data.length;i+=fillStride){
   const x=data[i]+originX,y=data[i+1]+originY;
   bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);
   bounds.minY=Math.min(bounds.minY,y);bounds.maxY=Math.max(bounds.maxY,y);
  }
  const tile={kind:"fill",buffer,vao,triangles:count,originX,originY,bytes:data.byteLength,bounds};buffers.add(tile);bufferBytes+=tile.bytes;return tile;
 }
 function deleteTileBuffer(tile){
  if(!tile||!buffers.delete(tile))return;bufferBytes-=tile.bytes;gl.deleteBuffer(tile.buffer);gl.deleteVertexArray(tile.vao);
 }
 function drawTile(tile,view,minScreenPx,matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]){
  if(!tile||!tile.segments)return;
  useProgram(program);gl.bindVertexArray(tile.vao);
  if(activeView!==view){activeMatrix=null;gl.uniform3f(u.view,view.scale,view.tx,view.ty);gl.uniform1f(u.dpr,view.dpr);activeView=view;}
  if(activeMatrix!==matrix||activeMinPx!==minScreenPx){
   const localScale=view.scale*Math.max(Math.hypot(matrix[0],matrix[1]),Math.hypot(matrix[4],matrix[5]),1e-15);
   gl.uniformMatrix2fv(u.linear,false,new Float32Array([matrix[0],matrix[1],matrix[4],matrix[5]]));
   gl.uniform1f(u.minWorldSize,minScreenPx>0?minScreenPx/(localScale*LOD_BIN_RATIO):0);activeMatrix=matrix;activeMinPx=minScreenPx;
  }
  gl.uniform2f(u.originScreen,view.tx+(matrix[0]*tile.originX+matrix[4]*tile.originY+matrix[12])*view.scale,
    view.ty-(matrix[1]*tile.originX+matrix[5]*tile.originY+matrix[13])*view.scale);
  gl.drawArraysInstanced(gl.TRIANGLES,0,6,tile.segments);
  includeBounds(tile.bounds,matrix,view,tile.width);
  calls++;segments+=tile.segments;tileBatches++;pendingDraw=true;
 }
 function drawFillTile(tile,view,minScreenPx,matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]){
  if(!tile||!tile.triangles)return;
  useProgram(fillProgram);gl.bindVertexArray(tile.vao);
  if(activeFillView!==view){activeFillMatrix=null;gl.uniform3f(fillU.view,view.scale,view.tx,view.ty);gl.uniform1f(fillU.dpr,view.dpr);activeFillView=view;}
  if(activeFillMatrix!==matrix||activeFillMinPx!==minScreenPx){
   const localScale=view.scale*Math.max(Math.hypot(matrix[0],matrix[1]),Math.hypot(matrix[4],matrix[5]),1e-15);
   gl.uniformMatrix2fv(fillU.linear,false,new Float32Array([matrix[0],matrix[1],matrix[4],matrix[5]]));
   gl.uniform1f(fillU.minWorldSize,minScreenPx>0?minScreenPx/(localScale*LOD_BIN_RATIO):0);activeFillMatrix=matrix;activeFillMinPx=minScreenPx;
  }
  gl.uniform2f(fillU.originScreen,view.tx+(matrix[0]*tile.originX+matrix[4]*tile.originY+matrix[12])*view.scale,
    view.ty-(matrix[1]*tile.originX+matrix[5]*tile.originY+matrix[13])*view.scale);
  gl.drawArrays(gl.TRIANGLES,0,tile.triangles*3);
  includeBounds(tile.bounds,matrix,view,0);
  fillCalls++;fillTriangles+=tile.triangles;fillTileBatches++;pendingDraw=true;
 }
 function drawDashed(entry,view,matrix){
  dashed ||= createDashedStrokeGPU(gl,canvas);
  const count=dashed.draw(entry,view,matrix);
  gl.useProgram(program);activeProgram=program;activeView=null;activeMatrix=null;activeMinPx=null;
  if(count===null)return false;
  if(count){includeBounds(entry.bounds,matrix,view,entry.width);calls++;segments+=count;pendingDraw=true;}return true;
 }
 function flush(ctx){
  if(!pendingDraw)return;
  const box=damage||{left:0,top:0,right:canvas.width,bottom:canvas.height};
  const {left,top,right,bottom}=box,w=right-left,h=bottom-top;
  if(w>0&&h>0){
   ctx.save();ctx.setTransform(1,0,0,1,0,0);
   ctx.drawImage(canvas,left,top,w,h,left,top,w,h);ctx.restore();
   gl.enable(gl.SCISSOR_TEST);gl.scissor(left,canvas.height-bottom,w,h);
   gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);
  }
  pendingDraw=false;damage=null;
 }
 // Fence the whole batch after its WebGL -> Canvas copies and source clears.
 // Keep it across cancellation/reset: queued GPU work cannot be cancelled.
 function submitBatch(){
  if(submission)gl.deleteSync(submission);
  submission=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
  if(!submission)throw new Error('GPU completion fence unavailable');
  gl.flush();
 }
 function batchComplete(){
  if(!submission)return true;
  const status=gl.clientWaitSync(submission,0,0);
  if(status===gl.TIMEOUT_EXPIRED)return false;
  gl.deleteSync(submission);submission=null;
  if(status===gl.WAIT_FAILED)throw new Error('GPU completion wait failed');
  return true;
 }
 function reset(){
  for(const tile of buffers){gl.deleteBuffer(tile.buffer);gl.deleteVertexArray(tile.vao);}
  buffers.clear();bufferBytes=0;calls=0;segments=0;tileBatches=0;fillCalls=0;fillTriangles=0;fillTileBatches=0;pendingDraw=false;damage=null;
  activeView=null;activeMatrix=null;activeMinPx=null;activeFillView=null;activeFillMatrix=null;activeFillMinPx=null;
 }
 function dispose(){if(submission){gl.deleteSync(submission);submission=null;}reset();dashed?.dispose();gl.deleteProgram(program);gl.deleteProgram(fillProgram);gl.getExtension("WEBGL_lose_context")?.loseContext();}
 return {begin,submitBatch,batchComplete,createTileBuffer,createFillTileBuffer,deleteTileBuffer,drawTile,drawFillTile,drawDashed,flush,reset,dispose,
  stats:()=>({calls,segments,buffers:buffers.size,batches:tileBatches,bytes:bufferBytes,
   fillCalls,fillTriangles,fillBatches:fillTileBatches})};
}
