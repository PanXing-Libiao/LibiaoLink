import {pathRecords} from './recorded-path.js';
export function createBackgroundPainter(onFrame,onError){
 const worker=new Worker(new URL('./paint-worker.js',import.meta.url),{type:'module'});
 let serial=0,current=0,waiting=null,commands=[],paths=[],batches=[],images=[],transfers=[];
 const pathIds=new WeakMap(),batchIds=new WeakMap(),imageIds=new WeakMap();
 let fontsReadyResolve;
 const ready=new Promise(resolve=>fontsReadyResolve=resolve);
 worker.onmessage=({data:m})=>{
  if(m.type==='fonts-ready')fontsReadyResolve();
  else if(m.type==='error'){onError(m.message);waiting?.();waiting=null;}
  else if(m.id===current){if(m.type==='frame')onFrame(m);else if(m.type==='chunk-ready'){const fn=waiting;waiting=null;fn?.();}}
  else m.bitmap?.close();
 };
 function pathRef(path){
  let id=pathIds.get(path);if(id)return {path:id};
  const data=pathRecords.get(path);if(!data)throw new Error('Unrecorded drawing path');
  id=++serial;pathIds.set(path,id);
  const source=data.source?pathRef(data.source).path:null;
  const ops=data.commands.map(op=>op[0]==='addPath'?['addPath',pathRef(op[1]).path,op[2]]:op);
  const names=['moveTo','lineTo','closePath','rect','arc','arcTo','bezierCurveTo','quadraticCurveTo','ellipse','roundRect','addPath'];
  const flat=ops.map(op=>op[0]==='addPath'?[op[0],op[1],...(op[2]?[1,op[2].a,op[2].b,op[2].c,op[2].d,op[2].e,op[2].f]:[0])]:op);
  if(flat.every(op=>names.includes(op[0])&&op.slice(1).every(v=>typeof v==='number'||typeof v==='boolean'))){
    const packed=new Float64Array(flat.reduce((n,op)=>n+op.length+1,0));let at=0;
    for(const op of flat){packed[at++]=names.indexOf(op[0]);packed[at++]=op.length-1;for(let i=1;i<op.length;i++)packed[at++]=Number(op[i]);}
    paths.push({id,source,svg:data.svg,packed});transfers.push(packed.buffer);
  }else paths.push({id,source,svg:data.svg,commands:ops});
  return {path:id};
 }
 function batchRef(batch){
  let id=batchIds.get(batch);if(id)return id;id=++serial;batchIds.set(batch,id);
  const data=new Float64Array(batch.gpuSegments.reduce((n,a)=>n+a.length,0));let offset=0;for(const a of batch.gpuSegments){data.set(a,offset);offset+=a.length;}const packed=[data];transfers.push(data.buffer);
  batches.push({id,batch:{bounds:batch.bounds,color:batch.color,width:batch.width,gpuSegments:packed}});
  return id;
 }
 const methods=new Set(['save','restore','setTransform','transform','translate','rotate','scale','clearRect','fillRect','strokeRect','beginPath','closePath','moveTo','lineTo','arc','arcTo','ellipse','bezierCurveTo','quadraticCurveTo','rect','setLineDash','stroke','fill','clip','fillText','strokeText']);
 const context=new Proxy({canvas:{width:0,height:0}},{
  set(obj,key,v){obj[key]=v;commands.push(['$set',key,v]);return true;},
  get(obj,key){
   if(key==='drawImage')return (image,...args)=>{
    let id=imageIds.get(image);
    if(!id){id=++serial;imageIds.set(image,id);images.push({id,source:image});}
    commands.push(['drawImage',{image:id},...args]);
   };
   if(methods.has(key))return (...args)=>commands.push([key,...args.map(v=>pathRecords.has(v)?pathRef(v):v)]);
   return obj[key];
  }
 });
 function fonts(){
  const faces=[],loaded=[...document.fonts].filter(f=>f.status==='loaded');
  for(const sheet of document.styleSheets){
   for(const rule of sheet.cssRules||[]){
    if(rule.type!==CSSRule.FONT_FACE_RULE)continue;
    const style=rule.style,family=style.getPropertyValue('font-family'),range=style.getPropertyValue('unicode-range')||'U+0-10FFFF';
    if(!loaded.some(f=>f.family===family&&f.unicodeRange===range))continue;
    const source=style.getPropertyValue('src').replace(/url\(([^)]+)\)/g,(_,v)=>'url('+new URL(v.trim().replace(/^['"]|['"]$/g,''),sheet.href||location.href).href+')');
    const descriptors={};for(const [key,css] of [['style','font-style'],['weight','font-weight'],['stretch','font-stretch'],['unicodeRange','unicode-range']])if(style.getPropertyValue(css))descriptors[key]=style.getPropertyValue(css);
    faces.push({family,source,descriptors});
   }
  }
  worker.postMessage({type:'fonts',faces});
 }
 function begin(width,height){
  current++;commands=[];context.canvas.width=width;context.canvas.height=height;
  worker.postMessage({type:'begin',id:current,width,height});return current;
 }
 async function submit(done,next){
  const id=current;
  const prepared=await Promise.all(images.map(async v=>({id:v.id,bitmap:await createImageBitmap(v.source)})));
  if(id!==current){for(const p of prepared)p.bitmap.close();return;}
  const message={type:'chunk',id,commands,paths,batches,images:prepared,done};
  const transfer=[...transfers,...prepared.map(v=>v.bitmap)];
  commands=[];paths=[];batches=[];images=[];transfers=[];waiting=next;
  const started=performance.now();worker.postMessage(message,transfer);document.getElementById('drawingCanvas').dataset.maxWorkerPostMs=String(Math.max(Number(document.getElementById('drawingCanvas').dataset.maxWorkerPostMs||0),performance.now()-started));
 }
 function cancel(){worker.postMessage({type:'cancel',id:current});current++;waiting=null;commands=[];}
 const gpu={
  begin:(...args)=>commands.push(['$gpu-begin',...args]),
  stroke:(batch,m,view)=>commands.push(['$gpu-stroke',batchRef(batch),m,view]),
  flush:()=>commands.push(['$gpu-flush'])
 };
 return {context,gpu,ready,fonts,begin,submit,cancel,dispose:()=>worker.terminate()};
}
