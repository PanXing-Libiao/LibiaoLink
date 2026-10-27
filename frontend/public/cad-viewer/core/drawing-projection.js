// UCD drawing projection. Source adapters supply UCD ownership and appearance;
// model/layout switching uses these same rules for every drawing format.
const IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const K = new Uint32Array([
 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
 0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
 0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
 0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
 0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
 0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
 0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
 0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function rotr(x,n){return (x>>>n)|(x<<(32-n));}
export function sha256Hex(bytes){
 const H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
 const ml=bytes.length*8,padded=new Uint8Array(((bytes.length+9+63)>>6)<<6);
 padded.set(bytes);padded[bytes.length]=0x80;
 const view=new DataView(padded.buffer);view.setUint32(padded.length-8,Math.floor(ml/0x100000000));view.setUint32(padded.length-4,ml>>>0);
 const w=new Uint32Array(64);
 for(let off=0;off<padded.length;off+=64){
  for(let i=0;i<16;i++)w[i]=view.getUint32(off+i*4);
  for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3),s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
  let [a,b,c,d,e,f,g,h]=H;
  for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g),t1=(h+S1+ch+K[i]+w[i])>>>0,S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c),t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
  H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
 }
 return H.map(x=>x.toString(16).padStart(8,'0')).join('');
}
export function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
export function identity(kind,value){return kind+'-'+sha256Hex(new TextEncoder().encode(canonical(value)));}
function mul(a,b){const out=new Array(16);for(let col=0;col<4;col++)for(let row=0;row<4;row++){let sum=0;for(let k=0;k<4;k++)sum+=a[k*4+row]*b[col*4+k];out[col*4+row]=sum;}return out;}
function translate(x,y,z){const m=IDENTITY.slice();m[12]=x;m[13]=y;m[14]=z;return m;}

export function annotationForScale(document,entry,viewport,layoutId){
 if(!entry.scaleVariants?.length)return {entry,hidden:false};
 const context=document.extensions?.['org.cad-preview.dxf-annotation-contexts/1']||{};
 const scale=viewport?viewport.annotationScale:layoutId?1:('modelDrawingPerPaper' in context?context.modelDrawingPerPaper:1);
 let selected=scale===null?null:entry.scaleVariants.find(v=>Math.abs(v.drawingPerPaper-scale)<=1e-9*Math.max(1,scale));
 const hidden=!selected&&context.allVisible===false;
 if(!selected)selected=entry.scaleVariants.find(v=>v.drawingPerPaper===entry.defaultScale)||entry;
 return {entry:selected,hidden};
}

export function projectDrawing(document,target,effectiveLayers=null,presentationStyles=null,visitor=null){
 const m=document.drawing;
 const styleExt=(document.extensions&&document.extensions['org.cad-preview.style-inheritance/1'])||{};
 const styleModes=styleExt.modes||{},annotationStyles=styleExt.annotationStyles||{},flags=styleExt.entityState||{};
 const annotationItems=document.extensions?.['org.cad-preview.annotation-presentation/1']?.items||{};
 const projectionLimits=styleExt.projectionLimits||{};
 let layoutId=null,spaceId,drawing;
 if(target.kind==='model'){spaceId=target.spaceId;drawing=m.spaces[spaceId].drawingId;}
 else{layoutId=target.layoutId;const layout=m.layouts[layoutId];spaceId=layout.paperSpaceId;drawing=layout.drawingId;}
 const drawingId=target.drawingId||drawing,drawingRow=m.drawings[drawing];
 const layerStates={};
 for(const [id,layer] of Object.entries(m.layers))if(layer.drawingId===drawing)layerStates[id]={visible:!!layer.visible,frozen:!!layer.frozen,plot:layer.plot!==false};
 const viewports={};
 if(layoutId)for(const vid of m.layouts[layoutId].viewportIds)viewports[vid]=m.viewports[vid];
 const inheriting=new Set(Object.keys(styleExt.layerInheritance||{}));
 function effectiveLayer(layerId,chain){
  if(!inheriting.has(layerId))return layerId;
  for(let i=chain.length-1;i>=0;i--){const parentLayer=chain[i][1];if(!inheriting.has(parentLayer))return parentLayer;}
  return layerId;
 }
 const layerStyle=(id,viewport)=>({...m.layers[id]?.defaultStyle,...viewport?.layerOverrides?.[id]});
 const layerColor=(id,viewport)=>{const s=layerStyle(id,viewport).color;return (s&&s.rgba?s.rgba:[1,1,1,1]).slice();};
 const layerLineType=(id,viewport)=>layerStyle(id,viewport).lineTypeId;
 const layerLineWeight=(id,viewport)=>layerStyle(id,viewport).lineWeight;
 function colorFrom(style,layerId,chain,viewport){
  const mode=style.color?.mode;
  if(mode==='explicit')return style.color.rgba.slice();
  if(mode==='by-layer')return layerColor(layerId,viewport);
  if(mode==='by-block'){
   for(let i=chain.length-1;i>=0;i--){
    const parent=chain[i][0],parentLayer=chain[i][1],pm=parent.color?.mode;
    if(pm==='explicit')return parent.color.rgba.slice();
    if(pm==='by-layer')return layerColor(parentLayer,viewport);
   }
   return layerColor(layerId,viewport);
  }
  return layerColor(layerId,viewport);
 }
 function resolve(style,layerId,chain,itemId,viewport){
  const mode=styleModes[itemId]||{};
  let lt=style.lineTypeId;
  if(lt===undefined&&mode.lineType==='by-layer')lt=layerLineType(layerId,viewport);
  else if(lt===undefined&&mode.lineType==='by-block'){
   for(let i=chain.length-1;i>=0;i--){
    const parent=chain[i][0],parentLayer=chain[i][1],parentId=chain[i][2];
    if(parent.lineTypeId){lt=parent.lineTypeId;break;}
    const pm=(styleModes[parentId]||{}).lineType;
    if(pm==='by-layer'){lt=layerLineType(parentLayer,viewport);break;}
    if(pm==='by-block')continue;
   }
   if(lt===undefined)lt=layerLineType(layerId,viewport);
  }
  let lw=style.lineWeight;
  if(lw===undefined&&mode.lineWeight==='by-layer')lw=layerLineWeight(layerId,viewport);
  else if(lw===undefined&&mode.lineWeight==='by-block'){
   for(let i=chain.length-1;i>=0;i--){
    const parent=chain[i][0],parentLayer=chain[i][1],parentId=chain[i][2];
    if(parent.lineWeight){lw=parent.lineWeight;break;}
    const pm=(styleModes[parentId]||{}).lineWeight;
    if(pm==='by-layer'){lw=layerLineWeight(parentLayer,viewport);break;}
    if(pm==='by-block')continue;
   }
   if(lw===undefined)lw=layerLineWeight(layerId,viewport);
  }
  if(lw===undefined)lw={value:0.25,knowledge:'engineering-defined',validation:'experimental',evidenceIds:['policy']};
  const info=flags[itemId]||{};
  const layerOpacity=lid=>styleExt.viewportLayerOpacity?.[viewport?.id]?.[lid]??styleExt.layerOpacity?.[lid]??1;
  let opacity=layerOpacity(layerId);
  if(info.opacityMode==='explicit')opacity=info.opacity;
  else if(info.opacityMode==='by-block')for(let i=chain.length-1;i>=0;i--){
   const parent=flags[chain[i][2]]||{};
   if(parent.opacityMode==='explicit'){opacity=parent.opacity;break;}
   if(parent.opacityMode!=='by-block'){opacity=layerOpacity(chain[i][1]);break;}
  }
  const style2={color:colorFrom(style,layerId,chain,viewport),opacity,
   plot:style.plot!==false&&layerStates[layerId]?.plot!==false,lineWeight:lw};
  if(lt)style2.lineTypeId=lt;
  if(style.fontResourceId)style2.fontResourceId=style.fontResourceId;
  return style2;
 }
 const draws={};let order=0,drawn=0;
 const transformedClip=(id,placement)=>{
  const clip=styleExt.blockClips?.[id];
  return clip?[{boundary:clip.boundary.map(([x,y])=>[placement[0]*x+placement[4]*y+placement[12],placement[1]*x+placement[5]*y+placement[13]]),inverted:clip.inverted}]:[];
 };
 const MAX=Number(projectionLimits.maxDraws)||400000;
 function addDraw(kind,itemId,blockPath,localToSpace,visibility,availability,style,representationId,viewportId,layerId,clips,chain){
  order+=1;drawn+=1;
  if(drawn>MAX)throw new Error('drawing-projection-over-limit');
  const drawId=identity('drawing-draw',[drawingId,kind,itemId,blockPath,viewportId||'']);
  const draw={kind,itemId,blockPath,localToSpace,visibility,availability,style,drawOrder:order-1,
   visibilityLayerIds:[...new Set([layerId,...chain.map(parent=>parent[1])])]};
  if(clips?.length)draw.clipRegions=clips;
  if(viewportId)draw.viewportId=viewportId;
  if(representationId)draw.displayRepresentationId=representationId;
  if(visitor?.draw)visitor.draw(drawId,draw,layerId);
  else draws[drawId]=draw;
  if(effectiveLayers)effectiveLayers[drawId]=layerId;
 }
 function members(space){
  const rows=[];
  for(const [kind,table,field] of [['entity',m.entities,'entityIds'],['annotation',m.annotations,'annotationIds'],['blockInstance',m.blockInstances,'blockInstanceIds']]){
   for(const itemId of space[field]||[]){
    const item=table[itemId];
    if(kind==='annotation'&&item.ownerBlockInstanceId)continue;
    const ref=(item.sourceRefs&&item.sourceRefs[0])||{};
    rows.push([Number(styleExt.drawOrder?.[itemId]??ref.recordOffset??0),kind,itemId,item]);
   }
  }
  rows.sort((a,b)=>a[0]-b[0]||(a[1]<b[1]?-1:a[1]>b[1]?1:0)||(a[2]<b[2]?-1:a[2]>b[2]?1:0));
  return rows;
 }
 const attachedAnnotations=new Map();
 for(const [itemId,item] of Object.entries(m.annotations)){
  if(!item.ownerBlockInstanceId)continue;
  const ref=item.sourceRefs?.[0]||{};
  const rows=attachedAnnotations.get(item.ownerBlockInstanceId)||[];
  rows.push([Number(styleExt.drawOrder?.[itemId]??ref.recordOffset??0),'annotation',itemId,item]);
  attachedAnnotations.set(item.ownerBlockInstanceId,rows);
 }
 for(const rows of attachedAnnotations.values())rows.sort((a,b)=>a[0]-b[0]||(a[2]<b[2]?-1:a[2]>b[2]?1:0));
 const hiddenByLayer=(layerId,viewport)=>{
  const state=layerStates[layerId];
  if(!state)return false;
  if(!state.visible||state.frozen)return true;
  if(viewport&&(viewport.frozenLayerIds||[]).includes(layerId))return true;
  return false;
 };
 const entityVisibility=(itemId,layerId,viewport)=>hiddenByLayer(layerId,viewport)?'hidden':((flags[itemId]||{}).invisible?'hidden':'shown');
 function resolvePresentation(itemId,sourceStyle,layerId,chain,path,viewport,visibility,kind){
  const entry=annotationItems[itemId];
  if(entry?.status!=='ready')return;
  const drawId=identity('drawing-draw',[drawingId,kind,itemId,path,viewport?viewport.id:'']);
  const chosen=annotationForScale(document,entry,viewport,layoutId),parts=chosen.entry.parts;
  if(chosen.hidden){visibility='hidden';draws[drawId].visibility='hidden';}
  if(chosen.entry.status!=='ready'){draws[drawId].availability=kind==='annotation'?'missing-reference':'unsupported';delete draws[drawId].displayRepresentationId;if(presentationStyles)presentationStyles[drawId]=[];return;}
  if(!presentationStyles&&!entry.scaleVariants?.length&&!parts.some(part=>part.patternedStroke||part.patternContinuation))return;
  let patternGap=false;
  const rows=parts.map(part=>{
   const partChain=chain.concat([[sourceStyle,layerId,itemId]]);
   for(const ancestor of part.ancestors)partChain.push([ancestor.style,effectiveLayer(ancestor.layerId,partChain),ancestor.id]);
   const partLayer=effectiveLayer(part.layerId,partChain);
   const style=resolve(part.style,partLayer,partChain,part.id,viewport);
   const row={id:part.id,layerId:partLayer,style,
    visibility:visibility==='hidden'?'hidden':entityVisibility(part.id,partLayer,viewport)};
   const contextVariant=part.drawVariants?.[drawId];
   const variant=contextVariant?.lineTypeId===style.lineTypeId?contextVariant:part.lineTypeVariants?.[style.lineTypeId];
   if(variant){row.presentationParts=variant.parts;if(variant.status!=='ready')patternGap=true;}
   else if((part.patternedStroke||part.patternContinuation)&&(styleExt.lineTypePatterns?.[style.lineTypeId]?.length||styleExt.complexLineTypeIds?.includes(style.lineTypeId))){row.presentationParts=[];patternGap=true;}
   return row;
  });
  if(patternGap){draws[drawId].availability=kind==='annotation'?'missing-reference':'unsupported';delete draws[drawId].displayRepresentationId;}
  else if(entry.scaleVariants?.length||rows.some(row=>row.presentationParts)){
   const selected=rows.flatMap((row,index)=>(row.presentationParts||[parts[index]]).map(part=>part.representationId));
   draws[drawId].displayRepresentationId=identity('representation',[itemId,'linetype',selected]);
  }
  if(presentationStyles)presentationStyles[drawId]=rows;
 }
 function walk(spaceId,transform,path,viewport,chain,inheritedHidden,clips=[]){
  if(visitor?.space){
   visitor.space({spaceId,transform,path,viewport,chain,inheritedHidden,clips},()=>{
    visit(members(m.spaces[spaceId]),IDENTITY,[],viewport,chain,inheritedHidden,clips);
   });
  }else visit(members(m.spaces[spaceId]),transform,path,viewport,chain,inheritedHidden,clips);
 }
 function visit(rows,transform,path,viewport,chain,inheritedHidden,clips){
  for(const [,kind,itemId,item] of rows){
   if(kind==='entity'){
    const layerId=effectiveLayer(item.layerId,chain);
    const visibility=inheritedHidden?'hidden':entityVisibility(itemId,layerId,viewport);
    const presentation=annotationItems[itemId];
    const availability=flags[itemId]?.presentationGeometry==='missing'||presentation?.status==='missing'||item.geometry&&item.geometry.type==='unsupported'&&presentation?.status!=='ready'?'unsupported':'ready';
    const style=resolve(item.style,layerId,chain,itemId,viewport);
    const local=mul(transform,item.localFromOwner);
    addDraw('entity',itemId,path,local,visibility,availability,style,
     item.displayRepresentationId||(availability==='ready'&&annotationItems[itemId]?.mode!=='view-dependent'?identity('representation',[itemId]):null),viewport?viewport.id:null,layerId,clips,chain);
    resolvePresentation(itemId,item.style,layerId,chain,path,viewport,visibility,'entity');
   }else if(kind==='annotation'){
    const info=flags[itemId]||{};
    const layerId=effectiveLayer(item.layerId,chain);
    const visibility=inheritedHidden?'hidden':entityVisibility(itemId,layerId,viewport);
    const availability=(info.attributeTemplate||info.presentationGeometry==='missing')?'missing-reference':'ready';
    const sourceStyle=annotationStyles[itemId]||{color:{mode:'by-layer'},plot:true};
    const style=resolve(sourceStyle,layerId,chain,itemId,viewport);
    if(item.fontResourceId)style.fontResourceId=item.fontResourceId;
    addDraw('annotation',itemId,path,transform,visibility,availability,style,
     annotationItems[itemId]?.status==='ready'?identity('representation',[itemId]):null,viewport?viewport.id:null,layerId,clips,chain);
    resolvePresentation(itemId,sourceStyle,layerId,chain,path,viewport,visibility,'annotation');
   }else{
    const definition=m.blocks[item.definitionId];
    const layerId=effectiveLayer(item.layerId,chain);
    const array=item.array;
    const rowOffset=array?.rowOffset||[0,0,0],columnOffset=array?.columnOffset||[0,0,0];
    const rows=array&&rowOffset.some(v=>v!==0)?array.rows:1,columns=array&&columnOffset.some(v=>v!==0)?array.columns:1;
    if(rows*columns>MAX)throw new Error('drawing-projection-over-limit');
    const hidden=inheritedHidden||entityVisibility(itemId,layerId,viewport)==='hidden';
    const childChain=chain.concat([[item.style,layerId,itemId]]);
    for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
     const offset=translate(...columnOffset.map((v,axis)=>v*column+rowOffset[axis]*row));
     const ownerPlacement=mul(transform,offset),placement=mul(ownerPlacement,item.localFromBlock);
     const childPath=path.concat([{instanceId:itemId,row,column}]);
     const childClips=clips.concat(transformedClip(itemId,placement));
     walk(definition.spaceId,placement,childPath,viewport,childChain,hidden,childClips);
     visit(attachedAnnotations.get(itemId)||[],ownerPlacement,childPath,viewport,childChain,hidden,childClips);
    }
   }
  }
 }
 if(layoutId){
  for(const vid of m.layouts[layoutId].viewportIds){
   const viewport=m.viewports[vid];
   if(!viewport.enabled)continue;
   walk(viewport.sourceSpaceId,viewport.modelToPaper,[],viewport,[]);
  }
  walk(spaceId,IDENTITY,[],null,[]);
 }else walk(spaceId,IDENTITY,[],null,[]);
 return {drawingId,target:layoutId?{kind:'layout',layoutId}:{kind:'model',spaceId:drawingRow.modelSpaceId},
  viewports,layerStates,draws};
}
export {IDENTITY};

// Viewer-only inspection of a definition at its own source coordinates. The
// immutable view copy supplies a root to the existing projector; no INSERT or
// model placement is added to the source document or exported UCD snapshot.
export function projectBlock(document, blockId, effectiveLayers = null, presentationStyles = null) {
 const block = document.drawing.blocks[blockId];
 if (!block) throw new Error('Unknown block preview');
 const drawings = {...document.drawing.drawings};
 drawings[block.drawingId] = {...drawings[block.drawingId], modelSpaceId: block.spaceId};
 const view = {...document, drawing: {...document.drawing, drawings}};
 const result = projectDrawing(view, {kind:'model', spaceId:block.spaceId}, effectiveLayers, presentationStyles);
 return {...result, target:{kind:'block-preview', blockId}};
}
