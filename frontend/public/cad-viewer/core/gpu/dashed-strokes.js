// Render numeric dash patterns directly; cost depends on source edges and pixels,
// not the number of dash/gap repetitions along an edge.
export const MAX_DASH_VALUES = 32;
export function normalizedDash(dash) {
  return dash.length % 2 ? dash.concat(dash) : dash;
}
export function dashViewScale(matrix, view) {
  const x = Math.hypot(matrix[0], matrix[1]), y = Math.hypot(matrix[4], matrix[5]);
  // Canvas preserves elliptical caps under nonuniform transforms. Keep that
  // existing path unless this instance is a rotation/reflection + uniform scale.
  if (!x || !y || Math.abs(x-y)>Math.max(x,y)*1e-9
      || Math.abs(matrix[0]*matrix[4]+matrix[1]*matrix[5])>x*y*1e-9) return 0;
  return x*view.scale;
}
function clipLine(ax, ay, bx, by, width, height, pad) {
  const dx=bx-ax,dy=by-ay;let lo=0,hi=1;
  for(const [p,q] of [[-dx,ax+pad],[dx,width+pad-ax],[-dy,ay+pad],[dy,height+pad-ay]]) {
    if(p===0){if(q<0)return null;continue;}
    const t=q/p;
    if(p<0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
    if(lo>hi)return null;
  }
  return [lo,hi];
}
export function dashSegmentsForView(records, pattern, matrix, view, width, height, strokeWidth) {
  const period=pattern.reduce((a,b)=>a+b,0),localScale=dashViewScale(matrix,view),rows=[];
  const pad=strokeWidth*.5+2/view.dpr;
  for(const record of records){
    const source=record.segments;let previousX,previousY,phase=0;
    for(let i=0;i+3<source.length;i+=4){
      const ax=source[i],ay=source[i+1],bx=source[i+2],by=source[i+3];
      if(previousX===undefined||Math.abs(previousX-ax)>1e-9||Math.abs(previousY-ay)>1e-9)phase=0;
      const length=Math.hypot(bx-ax,by-ay);
      const x1=view.tx+(matrix[0]*ax+matrix[4]*ay+matrix[12])*view.scale;
      const y1=view.ty-(matrix[1]*ax+matrix[5]*ay+matrix[13])*view.scale;
      const x2=view.tx+(matrix[0]*bx+matrix[4]*by+matrix[12])*view.scale;
      const y2=view.ty-(matrix[1]*bx+matrix[5]*by+matrix[13])*view.scale;
      const clip=clipLine(x1,y1,x2,y2,width,height,pad);
      if(clip&&length>0){const [lo,hi]=clip;rows.push(x1+(x2-x1)*lo,y1+(y2-y1)*lo,
        x1+(x2-x1)*hi,y1+(y2-y1)*hi,((phase+length*lo)%period)*localScale);}
      phase=(phase+length)%period;previousX=bx;previousY=by;
    }
  }
  return new Float32Array(rows);
}
export function createDashedStrokeGPU(gl,canvas) {
  function compile(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;}
  const program=gl.createProgram();
  const vertex=compile(gl.VERTEX_SHADER,`#version 300 es
precision highp float;
layout(location=0) in vec4 edge;
layout(location=1) in float phase;
uniform vec2 viewport;
uniform float dpr;
uniform float radius;
out vec2 position;
flat out float edgeLength;
flat out float offset;
void main(){
  vec2 delta=edge.zw-edge.xy;float len=length(delta);
  vec2 direction=len>0.0?delta/len:vec2(1.0,0.0),normal=vec2(-direction.y,direction.x);
  int v=gl_VertexID;float end=(v==1||v==2||v==4)?1.0:0.0;
  float side=(v==2||v==4||v==5)?1.0:-1.0;
  float pad=radius+1.0/dpr;
  position=vec2(mix(-pad,len+pad,end),side*pad);edgeLength=len;offset=phase;
  vec2 p=edge.xy+direction*position.x+normal*position.y;
  gl_Position=vec4(p.x*dpr/viewport.x*2.0-1.0,1.0-p.y*dpr/viewport.y*2.0,0.0,1.0);
}`);
  const fragment=compile(gl.FRAGMENT_SHADER,`#version 300 es
precision highp float;
in vec2 position;
flat in float edgeLength;
flat in float offset;
uniform vec2 intervals[16];
uniform int intervalCount;
uniform float period;
uniform float radius;
uniform float dpr;
uniform vec3 color;
out vec4 result;
void main(){
  float distance=1e30;
  // The closest occurrence on either side is enough, even for millions of
  // repetitions. Clip each dash to this edge; round caps also form round joins.
  float x=clamp(position.x,0.0,edgeLength);
  for(int i=0;i<16;i++){
    if(i>=intervalCount)break;
    vec2 span=intervals[i];float k=floor((offset+x-span.x)/period);
    for(int j=0;j<2;j++){
      vec2 range=span+(k+float(j))*period-offset;
      float a=max(0.0,range.x),b=min(edgeLength,range.y);
      if(a>b)continue;
      float dx=max(max(a-position.x,position.x-b),0.0);
      distance=min(distance,length(vec2(dx,position.y)));
    }
  }
  float alpha=clamp((radius-distance)*dpr+0.5,0.0,1.0);
  result=vec4(color*alpha,alpha);
}`);
  gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vertex);gl.deleteShader(fragment);
  const u=Object.fromEntries(['viewport','dpr','radius','intervals','intervalCount','period','color']
    .map(name=>[name,gl.getUniformLocation(program,name)]));
  const buffer=gl.createBuffer(),vao=gl.createVertexArray();gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,4,gl.FLOAT,false,20,0);gl.vertexAttribDivisor(0,1);
  gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,1,gl.FLOAT,false,20,16);gl.vertexAttribDivisor(1,1);
  // Union one dashed stroke in an isolated target, then source-over it onto
  // the shared stroke canvas. This preserves round-join coverage without a
  // GPU -> Canvas handoff at every dashed batch.
  const target=gl.createFramebuffer(),texture=gl.createTexture(),copyVAO=gl.createVertexArray();
  let targetWidth=0,targetHeight=0;
  const copyProgram=gl.createProgram();
  const copyVertex=compile(gl.VERTEX_SHADER,`#version 300 es
  void main(){vec2 p=gl_VertexID==0?vec2(-1.,-1.):gl_VertexID==1?vec2(3.,-1.):vec2(-1.,3.);gl_Position=vec4(p,0.,1.);}`);
  const copyFragment=compile(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float;
  uniform sampler2D source;
  out vec4 result;
  void main(){result=texelFetch(source,ivec2(gl_FragCoord.xy),0);}`);
  gl.attachShader(copyProgram,copyVertex);gl.attachShader(copyProgram,copyFragment);gl.linkProgram(copyProgram);
  if(!gl.getProgramParameter(copyProgram,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(copyProgram));
  gl.deleteShader(copyVertex);gl.deleteShader(copyFragment);
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  function draw(entry,view,matrix){
    const pattern=normalizedDash(entry.dash),scale=dashViewScale(matrix,view);
    if(!scale||pattern.length>MAX_DASH_VALUES)return null;
    const data=dashSegmentsForView(entry.records,pattern,matrix,view,canvas.width/view.dpr,canvas.height/view.dpr,entry.width);
    if(!data.length)return 0;
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
    if(targetWidth!==canvas.width||targetHeight!==canvas.height){
      targetWidth=canvas.width;targetHeight=canvas.height;
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,targetWidth,targetHeight,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    }
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    for(let i=0;i<data.length;i+=5){left=Math.min(left,data[i],data[i+2]);right=Math.max(right,data[i],data[i+2]);top=Math.min(top,data[i+1],data[i+3]);bottom=Math.max(bottom,data[i+1],data[i+3]);}
    const pad=entry.width*view.dpr*.5+3;
    left=Math.max(0,Math.floor(left*view.dpr-pad));right=Math.min(canvas.width,Math.ceil(right*view.dpr+pad));
    top=Math.max(0,Math.floor(top*view.dpr-pad));bottom=Math.min(canvas.height,Math.ceil(bottom*view.dpr+pad));
    gl.bindFramebuffer(gl.FRAMEBUFFER,target);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    gl.enable(gl.SCISSOR_TEST);gl.scissor(left,canvas.height-bottom,Math.max(0,right-left),Math.max(0,bottom-top));
    gl.clear(gl.COLOR_BUFFER_BIT);
    const ranges=new Float32Array(32);let at=0;
    for(let i=0;i<pattern.length;i++){if(i%2===0)ranges[i]=at*scale;at+=pattern[i];if(i%2===0)ranges[i+1]=at*scale;}
    const color=entry.color.match(/[\d.]+/g).slice(0,3).map(x=>Number(x)/255);
    gl.useProgram(program);gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STREAM_DRAW);
    gl.uniform2f(u.viewport,canvas.width,canvas.height);gl.uniform1f(u.dpr,view.dpr);gl.uniform1f(u.radius,entry.width*.5);
    gl.uniform2fv(u.intervals,ranges);gl.uniform1i(u.intervalCount,pattern.length/2);gl.uniform1f(u.period,at*scale);gl.uniform3fv(u.color,color);
    // A single Canvas stroke unions its subpaths. MAX prevents overlapping
    // caps/joins of the same batch from repeatedly darkening antialiased pixels.
    gl.blendEquation(gl.MAX);gl.drawArraysInstanced(gl.TRIANGLES,0,6,data.length/5);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.useProgram(copyProgram);gl.bindVertexArray(copyVAO);
    gl.drawArrays(gl.TRIANGLES,0,3);gl.disable(gl.SCISSOR_TEST);
    return data.length/5;
  }
  return {draw,dispose(){gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);gl.deleteProgram(program);gl.deleteFramebuffer(target);gl.deleteTexture(texture);gl.deleteVertexArray(copyVAO);gl.deleteProgram(copyProgram);}};
}
