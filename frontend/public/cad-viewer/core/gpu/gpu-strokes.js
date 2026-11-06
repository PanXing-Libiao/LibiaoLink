import {createDashedStrokeGPU} from './dashed-strokes.js?v=dxf-0.17.4';
import {LOD_BIN_RATIO} from '../drawing-instances.js';
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
 const u={viewport:gl.getUniformLocation(program,"viewport"),view:gl.getUniformLocation(program,"view"),originScreen:gl.getUniformLocation(program,"originScreen"),linear:gl.getUniformLocation(program,"instanceLinear"),dpr:gl.getUniformLocation(program,"dpr"),minWorldSize:gl.getUniformLocation(program,"minWorldSize")};
 const stride=9,bytesPerVertex=stride*4;
 const buffers=new Set();
 let calls=0,segments=0,tileBatches=0,bufferBytes=0,pendingDraw=false;
 let activeView=null,activeMatrix=null,activeMinPx=null,dashed=null;
 let damage=null;
 // Include the complete stroke footprint, including caps and antialiasing. The
 // source draw order is unchanged; only transparent space around it is omitted.
 function includeBounds(box,m,v,width){
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const x of [box.minX,box.maxX])for(const y of [box.minY,box.maxY]){
   const sx=v.dpr*(v.tx+v.scale*(m[0]*x+m[4]*y+m[12]));
   const sy=v.dpr*(v.ty-v.scale*(m[1]*x+m[5]*y+m[13]));
   left=Math.min(left,sx);right=Math.max(right,sx);top=Math.min(top,sy);bottom=Math.max(bottom,sy);
  }
  const pad=width*v.dpr*.5+3;
  left=Math.max(0,Math.floor(left-pad));top=Math.max(0,Math.floor(top-pad));
  right=Math.min(canvas.width,Math.ceil(right+pad));bottom=Math.min(canvas.height,Math.ceil(bottom+pad));
  if(right<=left||bottom<=top)return;
  if(!damage)damage={left,top,right,bottom};
  else {damage.left=Math.min(damage.left,left);damage.top=Math.min(damage.top,top);damage.right=Math.max(damage.right,right);damage.bottom=Math.max(damage.bottom,bottom);}
 }
 function configureAttributes(){
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,bytesPerVertex,0);gl.vertexAttribDivisor(0,1);
  gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,bytesPerVertex,16);gl.vertexAttribDivisor(1,1);
  gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,1,gl.FLOAT,false,bytesPerVertex,28);gl.vertexAttribDivisor(2,1);
  gl.enableVertexAttribArray(3);gl.vertexAttribPointer(3,1,gl.FLOAT,false,bytesPerVertex,32);gl.vertexAttribDivisor(3,1);
 }
 function begin(w,h){
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  gl.viewport(0,0,w,h);gl.useProgram(program);gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform2f(u.viewport,w,h);
  calls=0;segments=0;tileBatches=0;pendingDraw=false;damage=null;
  activeView=null;activeMatrix=null;activeMinPx=null;
 }
 function createTileBuffer(data,count,originX,originY){
  const buffer=gl.createBuffer(),vao=gl.createVertexArray();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);configureAttributes();
  // Bound the actual uploaded (float32) endpoints once, rather than rescanning
  // geometry for every redraw. Each instance applies its own parent transform.
  const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};let width=0;
  for(let i=0;i<data.length;i+=stride){
   bounds.minX=Math.min(bounds.minX,data[i]+originX,data[i+2]+originX);bounds.maxX=Math.max(bounds.maxX,data[i]+originX,data[i+2]+originX);
   bounds.minY=Math.min(bounds.minY,data[i+1]+originY,data[i+3]+originY);bounds.maxY=Math.max(bounds.maxY,data[i+1]+originY,data[i+3]+originY);
   width=Math.max(width,data[i+7]);
  }
  const tile={buffer,vao,segments:count,originX,originY,bytes:data.byteLength,bounds,width};buffers.add(tile);bufferBytes+=tile.bytes;return tile;
 }
 function deleteTileBuffer(tile){
  if(!tile||!buffers.delete(tile))return;bufferBytes-=tile.bytes;gl.deleteBuffer(tile.buffer);gl.deleteVertexArray(tile.vao);
 }
 function drawTile(tile,view,minScreenPx,matrix){
  if(!tile||!tile.segments)return;
  gl.bindVertexArray(tile.vao);
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
 function drawDashed(entry,view,matrix){
  dashed ||= createDashedStrokeGPU(gl,canvas);
  const count=dashed.draw(entry,view,matrix);
  gl.useProgram(program);activeView=null;activeMatrix=null;activeMinPx=null;
  if(count===null)return false;
  if(count){includeBounds(entry.bounds,matrix,view,entry.width);calls++;segments+=count;pendingDraw=true;}return true;
 }
 function flush(ctx){
  if(!pendingDraw)return;
  if(damage){
   const {left,top,right,bottom}=damage,w=right-left,h=bottom-top;
   ctx.save();ctx.setTransform(1,0,0,1,0,0);
   ctx.drawImage(canvas,left,top,w,h,left,top,w,h);ctx.restore();
   gl.enable(gl.SCISSOR_TEST);gl.scissor(left,canvas.height-bottom,w,h);
   gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);
  }
  pendingDraw=false;damage=null;
 }
 function reset(){for(const tile of buffers){gl.deleteBuffer(tile.buffer);gl.deleteVertexArray(tile.vao);}buffers.clear();bufferBytes=0;calls=0;segments=0;tileBatches=0;pendingDraw=false;damage=null;}
 function dispose(){reset();dashed?.dispose();gl.deleteProgram(program);gl.getExtension("WEBGL_lose_context")?.loseContext();}
 return {begin,createTileBuffer,deleteTileBuffer,drawTile,drawDashed,flush,reset,dispose,stats:()=>({calls,segments,buffers:buffers.size,batches:tileBatches,bytes:bufferBytes})};
}
