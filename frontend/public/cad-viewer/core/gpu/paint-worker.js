const paths=new Map(),batches=new Map(),images=new Map();
const strokePaths=new WeakMap();
const knownFonts=new Set();
let canvas,ctx,active=0;
let strokeStats={calls:0,segments:0,buffers:0,batches:0};
function resetStrokeStats(){strokeStats={calls:0,segments:0,buffers:0,batches:0};}
function makePath(def){
 const p=def.source?new Path2D(paths.get(def.source)):def.svg?new Path2D(def.svg):new Path2D();
 const names=["moveTo","lineTo","closePath","rect","arc","arcTo","bezierCurveTo","quadraticCurveTo","ellipse","roundRect","addPath"];
 const commands=def.commands||[];
 if(def.packed){const data=def.packed;for(let i=0;i<data.length;){const name=names[data[i++]],size=data[i++],args=Array.from(data.subarray(i,i+size));i+=size;
  if(name==="addPath")commands.push([name,args[0],args[1]?{a:args[2],b:args[3],c:args[4],d:args[5],e:args[6],f:args[7]}:null]);else commands.push([name,...args]);}}
 for(const [method,...args] of commands){
  if(method==="addPath"){if(args[1])p.addPath(paths.get(args[0]),args[1]);else p.addPath(paths.get(args[0]));}
  else p[method](...args);
 }
 paths.set(def.id,p);
}
function strokePath(batch){
 let path=strokePaths.get(batch);if(path)return path;
 path=new Path2D();const data=batch.gpuSegments[0]||[];
 for(let i=0;i+3<data.length;i+=4){path.moveTo(data[i],data[i+1]);path.lineTo(data[i+2],data[i+3]);}
 strokePaths.set(batch,path);return path;
}
function drawStroke(batch,m,view){
 if(!batch)return;
 const path=strokePath(batch),data=batch.gpuSegments[0]||[];
 const {scale,tx,ty,dpr}=view;
 const matrixScale=Math.max(Math.hypot(m[0],m[1]),Math.hypot(m[4],m[5]),1e-15);
 const localScale=scale*matrixScale;
 ctx.setTransform(dpr*scale*m[0],-dpr*scale*m[1],dpr*scale*m[4],-dpr*scale*m[5],dpr*(tx+scale*m[12]),dpr*(ty-scale*m[13]));
 ctx.strokeStyle=batch.color;ctx.lineWidth=batch.width/localScale;ctx.lineJoin="round";ctx.lineCap="butt";ctx.setLineDash([]);
 ctx.stroke(path);
 strokeStats.calls++;strokeStats.segments+=data.length/4;strokeStats.batches++;
}
function value(v){if(v&&typeof v==="object"){if(v.path)return paths.get(v.path);if(v.image)return images.get(v.image);}return v;}
let chain=Promise.resolve();
self.onmessage=event=>{chain=chain.then(()=>run(event.data)).catch(error=>self.postMessage({type:"error",message:error.stack}));};
async function run(m){
 if(m.type==="fonts"){
  const started=performance.now();
  await Promise.all(m.faces.map(async f=>{const key=JSON.stringify(f);if(knownFonts.has(key))return;const face=new FontFace(f.family,f.source,f.descriptors);await face.load();self.fonts.add(face);knownFonts.add(key);}));
  self.postMessage({type:"fonts-ready",timing:{faces:m.faces.length,ms:performance.now()-started}});return;
 }
 if(m.type==="cancel"){if(active===m.id)active=0;return;}
 if(m.type==="begin"){
  const started=performance.now();
  active=m.id;
  if(!canvas||canvas.width!==m.width||canvas.height!==m.height){canvas=new OffscreenCanvas(m.width,m.height);ctx=canvas.getContext("2d",{willReadFrequently:false});}
  ctx.reset();resetStrokeStats();
  self.postMessage({type:"begin-ready",id:m.id,timing:{ms:performance.now()-started}});
  return;
 }
 if(m.type!=="chunk"||m.id!==active)return;
 const started=performance.now();
 let pathMs=0,imageMs=0,commandMs=0,gpuMs=0,drainMs=0;
 let mark=performance.now();
 for(const def of m.paths)makePath(def);
 pathMs=performance.now()-mark;
 mark=performance.now();
 for(const def of m.batches)batches.set(def.id,def.batch);
 for(const def of m.images)images.set(def.id,def.bitmap);
 imageMs=performance.now()-mark;
 mark=performance.now();
 for(const op of m.commands){
  const [name,...args]=op;
  const opStarted=performance.now();
  if(name==="$set")ctx[args[0]]=args[1];
  else if(name==="$gpu-begin"){resetStrokeStats();}
  else if(name==="$gpu-stroke")drawStroke(batches.get(args[0]),args[1],args[2]);
  else if(name==="$gpu-flush"){}
  else ctx[name](...args.map(value));
  const elapsed=performance.now()-opStarted;
  commandMs+=elapsed;
  if(name.startsWith("$gpu-"))gpuMs+=elapsed;
 }
 let bitmap=null;
 if(m.done){
  const drainStarted=performance.now();
  bitmap=canvas.transferToImageBitmap();
  drainMs=performance.now()-drainStarted;
 }
 const timing={totalMs:performance.now()-started,pathMs,imageMs,commandMs,gpuMs,drainMs,
  pathDefinitions:m.paths.length,commandCount:m.commands.length,
  gpuCalls:0,gpuSegments:0,gpuBuffers:0,gpuBatches:strokeStats.batches,
  strokeCalls:strokeStats.calls,strokeSegments:strokeStats.segments,renderer:"canvas-worker"};
 if(m.done)self.postMessage({type:"frame",id:m.id,bitmap,stats:{...strokeStats,renderer:"canvas-worker"},profile:timing},[bitmap]);
 else self.postMessage({type:"chunk-ready",id:m.id,profile:timing});
}
