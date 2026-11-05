// Batched solid-stroke renderer; all CAD interpretation stays in the existing viewer.
export function createStrokeGPU(makeCanvas=()=>document.createElement("canvas")) {
 const canvas=makeCanvas();
 const gl=canvas.getContext("webgl2",{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
 if(!gl)throw new Error("本机未启用 WebGL2，请使用原显示版本");
 function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
 const program=gl.createProgram();
 gl.attachShader(program,shader(gl.VERTEX_SHADER,"#version 300 es\nprecision highp float;\nlayout(location=0) in vec4 segment;\nlayout(location=1) in vec2 linearAB;\nlayout(location=2) in vec2 linearCD;\nlayout(location=3) in vec2 origin;\nlayout(location=4) in vec3 tint;\nlayout(location=5) in float strokeWidth;\nuniform vec2 viewport;\nout vec2 distanceToLine;\nflat out float lineLength;\nflat out vec3 color;\nflat out float width;\nvoid main() {\n vec2 a=vec2(linearAB.x*segment.x+linearCD.x*segment.y+origin.x,linearAB.y*segment.x+linearCD.y*segment.y+origin.y);\n vec2 b=vec2(linearAB.x*segment.z+linearCD.x*segment.w+origin.x,linearAB.y*segment.z+linearCD.y*segment.w+origin.y);\n vec2 delta=b-a; float len=length(delta);\n vec2 direction=len>0.?delta/len:vec2(1.,0.);\n vec2 normal=vec2(-direction.y,direction.x);\n int vertex=gl_VertexID;\n float end=(vertex==1||vertex==2||vertex==4)?1.:0.;\n float side=(vertex==2||vertex==4||vertex==5)?1.:-1.;\n float extent=strokeWidth*.5+1.;\n float along=mix(-1.,len+1.,end);\n vec2 p=a+direction*along+normal*side*extent;\n distanceToLine=vec2(along,side*extent); lineLength=len; color=tint; width=strokeWidth;\n gl_Position=vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,0.,1.);\n}"));
 gl.attachShader(program,shader(gl.FRAGMENT_SHADER,"#version 300 es\nprecision highp float;\nin vec2 distanceToLine;\nflat in float lineLength;\nflat in vec3 color;\nflat in float width;\nout vec4 result;\nvoid main() {\n if(lineLength<0.0001)discard;\n float across=clamp(width*.5+.5-abs(distanceToLine.y),0.,1.);\n float along=clamp(distanceToLine.x+.5,0.,1.)*clamp(lineLength-distanceToLine.x+.5,0.,1.);\n float alpha=across*along;\n result=vec4(color*alpha,alpha);\n}"));
 gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
 const u={viewport:gl.getUniformLocation(program,"viewport")};
 const stride=14,bytesPerInstance=stride*4;
 let cache=new WeakMap(),pending=[],drawBuffer=null,combined=new Float32Array(0),pendingDraw=false,calls=0,segments=0,batches=0;
 const cc=makeCanvas().getContext("2d",{willReadFrequently:true});
 function geometry(batch){
  let g=cache.get(batch);if(g)return g;
  const ox=(batch.bounds.minX+batch.bounds.maxX)*.5,oy=(batch.bounds.minY+batch.bounds.maxY)*.5;
  const size=batch.gpuSegments.reduce((n,a)=>n+a.length,0),data=new Float32Array(size);
  let i=0;for(const array of batch.gpuSegments)for(let j=0;j<array.length;j+=2){data[i++]=array[j]-ox;data[i++]=array[j+1]-oy;}
  cc.clearRect(0,0,1,1);cc.fillStyle=batch.color;cc.fillRect(0,0,1,1);const rgba=cc.getImageData(0,0,1,1).data;
  g={data,count:size/4,ox,oy,width:batch.width,color:[rgba[0]/255,rgba[1]/255,rgba[2]/255]};cache.set(batch,g);return g;
 }
 function configureAttributes(){
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,bytesPerInstance,0);gl.vertexAttribDivisor(0,1);
  gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,2,gl.FLOAT,false,bytesPerInstance,16);gl.vertexAttribDivisor(1,1);
  gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,bytesPerInstance,24);gl.vertexAttribDivisor(2,1);
  gl.enableVertexAttribArray(3);gl.vertexAttribPointer(3,2,gl.FLOAT,false,bytesPerInstance,32);gl.vertexAttribDivisor(3,1);
  gl.enableVertexAttribArray(4);gl.vertexAttribPointer(4,3,gl.FLOAT,false,bytesPerInstance,40);gl.vertexAttribDivisor(4,1);
  gl.enableVertexAttribArray(5);gl.vertexAttribPointer(5,1,gl.FLOAT,false,bytesPerInstance,52);gl.vertexAttribDivisor(5,1);
 }
 function begin(w,h){
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  gl.viewport(0,0,w,h);gl.useProgram(program);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform2f(u.viewport,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  pending=[];pendingDraw=false;calls=0;segments=0;batches=0;
  configureAttributes();
 }
 function stroke(batch,m,view){
  if(!batch||!batch.gpuSegments.length)return;const g=geometry(batch);if(g.count>0)pending.push({g,m,view});
 }
 function flush(ctx){
  if(pendingDraw){ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(canvas,0,0);ctx.restore();gl.clear(gl.COLOR_BUFFER_BIT);pendingDraw=false;}
  if(!pending.length)return;
  const total=pending.reduce((n,item)=>n+item.g.count,0);if(!total){pending=[];return;}
  const needed=total*stride;if(combined.length<needed)combined=new Float32Array(Math.max(needed,combined.length*2));
  let at=0;
  for(const item of pending){
   const {data,color,width}=item.g,{scale,tx,ty,dpr}=item.view,m=item.m;
   const a=dpr*scale*m[0],b=-dpr*scale*m[1],c=dpr*scale*m[4],d=-dpr*scale*m[5];
   const x=dpr*(tx+scale*(m[12]+m[0]*item.g.ox+m[4]*item.g.oy)),y=dpr*(ty-scale*(m[13]+m[1]*item.g.ox+m[5]*item.g.oy));
   const w=width*dpr;
   for(let i=0;i<data.length;i+=4){combined[at++]=data[i];combined[at++]=data[i+1];combined[at++]=data[i+2];combined[at++]=data[i+3];combined[at++]=a;combined[at++]=b;combined[at++]=c;combined[at++]=d;combined[at++]=x;combined[at++]=y;combined[at++]=color[0];combined[at++]=color[1];combined[at++]=color[2];combined[at++]=w;}
  }
  if(!drawBuffer)drawBuffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,drawBuffer);gl.bufferData(gl.ARRAY_BUFFER,combined.subarray(0,at),gl.STREAM_DRAW);
  configureAttributes();gl.drawArraysInstanced(gl.TRIANGLES,0,6,total);
  calls++;segments+=total;batches+=pending.length;pending=[];pendingDraw=true;
 }
 function reset(){cache=new WeakMap();pending=[];pendingDraw=false;combined=new Float32Array(0);calls=0;segments=0;batches=0;}
 function dispose(){reset();if(drawBuffer){gl.deleteBuffer(drawBuffer);drawBuffer=null;}gl.deleteProgram(program);gl.getExtension("WEBGL_lose_context")?.loseContext();}
 return {begin,stroke,flush,reset,dispose,stats:()=>({calls,segments,buffers:drawBuffer?1:0,batches})};
}
