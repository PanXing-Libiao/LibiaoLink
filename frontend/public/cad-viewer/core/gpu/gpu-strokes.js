// Batched solid-stroke renderer. Geometry is uploaded once per spatial tile and
// reused across pan/zoom; non-stroke CAD semantics remain in the existing viewer.
export function createStrokeGPU(makeCanvas=()=>document.createElement("canvas")) {
 const canvas=makeCanvas();
 const gl=canvas.getContext("webgl2",{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
 if(!gl)throw new Error("本机未启用 WebGL2，请使用原显示版本");
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
uniform vec2 tileOrigin;
uniform float dpr;
uniform float minWorldSize;
out vec2 distanceToLine;
flat out float lineLength;
flat out vec3 color;
flat out float width;
void main() {
 if(lodSize>0.0 && lodSize<minWorldSize){
  distanceToLine=vec2(0.0);lineLength=0.0;color=tint;width=strokeWidth;
  gl_Position=vec4(3.0,3.0,3.0,1.0);return;
 }
 vec2 a=segment.xy+tileOrigin;
 vec2 b=segment.zw+tileOrigin;
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
 gl_Position=vec4((view.y+p.x*view.x)*dpr/viewport.x*2.-1.,1.-(view.z-p.y*view.x)*dpr/viewport.y*2.,0.,1.);
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
 const u={viewport:gl.getUniformLocation(program,"viewport"),view:gl.getUniformLocation(program,"view"),tileOrigin:gl.getUniformLocation(program,"tileOrigin"),dpr:gl.getUniformLocation(program,"dpr"),minWorldSize:gl.getUniformLocation(program,"minWorldSize")};
 const stride=9,bytesPerVertex=stride*4;
 const buffers=new Set();
 let calls=0,segments=0,tileBatches=0,bufferBytes=0,pendingDraw=false;
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
  calls=0;segments=0;tileBatches=0;pendingDraw=false;
 }
 function createTileBuffer(data,count,originX,originY){
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
  const tile={buffer,segments:count,originX,originY,bytes:data.byteLength};buffers.add(tile);bufferBytes+=tile.bytes;return tile;
 }
 function deleteTileBuffer(tile){
  if(!tile||!buffers.delete(tile))return;bufferBytes-=tile.bytes;gl.deleteBuffer(tile.buffer);
 }
 function drawTile(tile,view,minScreenPx){
  if(!tile||!tile.segments)return;
  const minWorldSize=minScreenPx>0?minScreenPx/Math.max(view.scale,1e-15):0;
  gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,tile.buffer);configureAttributes();
  gl.uniform3f(u.view,view.scale,view.tx,view.ty);gl.uniform2f(u.tileOrigin,tile.originX,tile.originY);
  gl.uniform1f(u.dpr,view.dpr);gl.uniform1f(u.minWorldSize,minWorldSize);
  gl.drawArraysInstanced(gl.TRIANGLES,0,6,tile.segments);
  calls++;segments+=tile.segments;tileBatches++;pendingDraw=true;
 }
 function flush(ctx){
  if(!pendingDraw)return;
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(canvas,0,0);ctx.restore();gl.clear(gl.COLOR_BUFFER_BIT);pendingDraw=false;
 }
 function reset(){for(const tile of buffers)gl.deleteBuffer(tile.buffer);buffers.clear();bufferBytes=0;calls=0;segments=0;tileBatches=0;pendingDraw=false;}
 function dispose(){reset();gl.deleteProgram(program);gl.getExtension("WEBGL_lose_context")?.loseContext();}
 return {begin,createTileBuffer,deleteTileBuffer,drawTile,flush,reset,dispose,stats:()=>({calls,segments,buffers:buffers.size,batches:tileBatches,bytes:bufferBytes})};
}
