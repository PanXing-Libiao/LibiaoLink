import {createStrokeGPU} from './gpu-strokes.js';
const paths=new Map(),batches=new Map(),images=new Map();
const knownFonts=new Set();
let canvas,ctx,gpu=createStrokeGPU(()=>new OffscreenCanvas(1,1)),active=0;
function makePath(def){
 const p=def.source?new Path2D(paths.get(def.source)):def.svg?new Path2D(def.svg):new Path2D();
 const names=['moveTo','lineTo','closePath','rect','arc','arcTo','bezierCurveTo','quadraticCurveTo','ellipse','roundRect','addPath'];
 const commands=def.commands||[];
 if(def.packed){const data=def.packed;for(let i=0;i<data.length;){const name=names[data[i++]],size=data[i++],args=Array.from(data.subarray(i,i+size));i+=size;
  if(name==='addPath')commands.push([name,args[0],args[1]?{a:args[2],b:args[3],c:args[4],d:args[5],e:args[6],f:args[7]}:null]);else commands.push([name,...args]);}}
 for(const [method,...args] of commands){
  if(method==='addPath'){if(args[1])p.addPath(paths.get(args[0]),args[1]);else p.addPath(paths.get(args[0]));}
  else p[method](...args);
 }
 paths.set(def.id,p);
}
function value(v){if(v&&typeof v==='object'){if(v.path)return paths.get(v.path);if(v.image)return images.get(v.image);}return v;}
let chain=Promise.resolve();
self.onmessage=event=>{chain=chain.then(()=>run(event.data)).catch(error=>self.postMessage({type:'error',message:error.stack}));};
async function run(m){
 if(m.type==='fonts'){
  await Promise.all(m.faces.map(async f=>{const key=JSON.stringify(f);if(knownFonts.has(key))return;const face=new FontFace(f.family,f.source,f.descriptors);await face.load();self.fonts.add(face);knownFonts.add(key);}));
  self.postMessage({type:'fonts-ready'});return;
 }
 if(m.type==='cancel'){if(active===m.id)active=0;return;}
 if(m.type==='begin'){
  active=m.id;
  if(!canvas||canvas.width!==m.width||canvas.height!==m.height){canvas=new OffscreenCanvas(m.width,m.height);ctx=canvas.getContext('2d',{willReadFrequently:false});}
  ctx.reset();return;
 }
 if(m.type!=='chunk'||m.id!==active)return;
 for(const def of m.paths)makePath(def);
 for(const def of m.batches)batches.set(def.id,def.batch);
 for(const def of m.images)images.set(def.id,def.bitmap);
 for(const op of m.commands){
  const [name,...args]=op;
  if(name==='$set')ctx[args[0]]=args[1];
  else if(name==='$gpu-begin')gpu.begin(...args);
  else if(name==='$gpu-stroke')gpu.stroke(batches.get(args[0]),args[1],args[2]);
  else if(name==='$gpu-flush')gpu.flush(ctx);
  else ctx[name](...args.map(value));
 }
 // Drain this bounded chunk on the worker, before submitting another one.
 ctx.getImageData(0,0,1,1);
 if(m.done){
  const bitmap=canvas.transferToImageBitmap();
  self.postMessage({type:'frame',id:m.id,bitmap,stats:gpu.stats()},[bitmap]);
 }else self.postMessage({type:'chunk-ready',id:m.id});
}
