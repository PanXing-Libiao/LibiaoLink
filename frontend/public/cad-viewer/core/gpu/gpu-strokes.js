// Experimental solid-stroke renderer; all CAD interpretation stays in the existing viewer.
export function createStrokeGPU(makeCanvas=()=>document.createElement('canvas')) {
 const canvas=makeCanvas();
 const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
 if(!gl)throw new Error('本机未启用 WebGL2，请使用原显示版本');
 function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
 const program=gl.createProgram();
 gl.attachShader(program,shader(gl.VERTEX_SHADER,"#version 300 es\nprecision highp float;\nlayout(location=0) in vec4 segment;\nuniform mat3 matrix;\nuniform vec2 viewport;\nuniform float width;\nout vec2 distanceToLine;\nflat out float lineLength;\nvoid main() {\n vec2 a=(matrix*vec3(segment.xy,1.)).xy, b=(matrix*vec3(segment.zw,1.)).xy;\n vec2 delta=b-a; float len=length(delta);\n vec2 direction=len>0.?delta/len:vec2(1.,0.);\n vec2 normal=vec2(-direction.y,direction.x);\n int vertex=gl_VertexID;\n float end=(vertex==1||vertex==2||vertex==4)?1.:0.;\n float side=(vertex==2||vertex==4||vertex==5)?1.:-1.;\n float extent=width*.5+1.;\n float along=mix(-1.,len+1.,end);\n vec2 p=a+direction*along+normal*side*extent;\n distanceToLine=vec2(along,side*extent); lineLength=len;\n gl_Position=vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,0.,1.);\n}"));
 gl.attachShader(program,shader(gl.FRAGMENT_SHADER,"#version 300 es\nprecision highp float;\nin vec2 distanceToLine;\nflat in float lineLength;\nuniform float width;\nuniform vec3 color;\nout vec4 result;\nvoid main() {\n if(lineLength<0.0001)discard;\n float across=clamp(width*.5+.5-abs(distanceToLine.y),0.,1.);\n float along=clamp(distanceToLine.x+.5,0.,1.)*clamp(lineLength-distanceToLine.x+.5,0.,1.);\n float alpha=across*along;\n result=vec4(color*alpha,alpha);\n}"));
 gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
 const u=Object.fromEntries(['matrix','viewport','width','color'].map(k=>[k,gl.getUniformLocation(program,k)]));
 let cache=new WeakMap(),buffers=[],pending=false,calls=0,segments=0;
 const cc=makeCanvas().getContext('2d');
 function geometry(batch){
  let g=cache.get(batch);if(g)return g;
  const ox=(batch.bounds.minX+batch.bounds.maxX)*.5,oy=(batch.bounds.minY+batch.bounds.maxY)*.5;
  const size=batch.gpuSegments.reduce((n,a)=>n+a.length,0),data=new Float32Array(size);
  let i=0;for(const array of batch.gpuSegments)for(let j=0;j<array.length;j+=2){data[i++]=array[j]-ox;data[i++]=array[j+1]-oy;}
  const buffer=gl.createBuffer();buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
  cc.clearRect(0,0,1,1);cc.fillStyle=batch.color;cc.fillRect(0,0,1,1);const rgba=cc.getImageData(0,0,1,1).data;
  g={buffer,count:size/4,ox,oy,color:[rgba[0]/255,rgba[1]/255,rgba[2]/255]};cache.set(batch,g);return g;
 }
 function begin(w,h){
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  gl.viewport(0,0,w,h);gl.useProgram(program);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform2f(u.viewport,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);pending=false;calls=0;segments=0;
 }
 function stroke(batch,m,view){
  const g=geometry(batch),{scale,tx,ty,dpr}=view;
  const a=dpr*scale*m[0],b=-dpr*scale*m[1],c=dpr*scale*m[4],d=-dpr*scale*m[5];
  const x=dpr*(tx+scale*(m[12]+m[0]*g.ox+m[4]*g.oy)),y=dpr*(ty-scale*(m[13]+m[1]*g.ox+m[5]*g.oy));
  gl.uniformMatrix3fv(u.matrix,false,[a,b,0,c,d,0,x,y,1]);gl.uniform1f(u.width,batch.width*dpr);gl.uniform3fv(u.color,g.color);
  gl.bindBuffer(gl.ARRAY_BUFFER,g.buffer);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,16,0);gl.vertexAttribDivisor(0,1);
  gl.drawArraysInstanced(gl.TRIANGLES,0,6,g.count);pending=true;calls++;segments+=g.count;
 }
 function flush(ctx){if(!pending)return;ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(canvas,0,0);ctx.restore();gl.clear(gl.COLOR_BUFFER_BIT);pending=false;}
 function reset(){for(const b of buffers)gl.deleteBuffer(b);buffers=[];cache=new WeakMap();}
 function dispose(){reset();gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();}
 return {begin,stroke,flush,reset,dispose,stats:()=>({calls,segments,buffers:buffers.length})};
}
