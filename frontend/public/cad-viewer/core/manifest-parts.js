import {applyCurveRows} from './dwg-packed-transport.js?v=direct-1';
// Partition high-cardinality UCD tables. One acknowledged batch is in flight,
// so the main thread never has to clone an entire expanded draw dictionary.
// A bounded 1K batch amortizes message/clone overhead without queueing the scene.
const BATCH_ENTRIES=1024;
const paths=[
 ['displayRows'],
 ...['products','productOccurrences','sceneOccurrences','renderOwnership','representations','geometries','accessors','buffers','materials','configurations','displayStates','properties','externalReferences','resources','viewContexts'].map(key=>['document',key]),
 ...['drawings','spaces','sheets','layouts','viewports','entities','annotations','blocks','blockInstances','layers','lineTypes','textStyles','plotStyles','hatchPatterns'].map(key=>['document','drawing',key]),
 ...['entityState','modes','drawOrder'].map(key=>['document','extensions','org.cad-preview.style-inheritance/1',key]),
 ['snapshot','draws'],['snapshot','occurrenceOverrides'],['snapshot','drawingProjection','draws'],['snapshot','drawingProjection','layerStates'],
];
export function* manifestParts(packet){
 const {curveRows, ...header}=packet,tables=[];
 for(const path of paths){
  let value=packet;for(const key of path)value=value?.[key];
  if(!value||Array.isArray(value)||typeof value!=='object')continue;
  let parent=header;
  for(const key of path.slice(0,-1)){parent[key]={...parent[key]};parent=parent[key];}
  parent[path.at(-1)]={};tables.push({path,value});
 }
 yield {kind:'header',packet:header};
 for(const {path,value} of tables){
  let entries=[];
  for(const key of Object.keys(value)){
   entries.push(key,value[key]);
   if(entries.length===BATCH_ENTRIES*2){yield {kind:'entries',path,entries};entries=[];}
  }
  if(entries.length)yield {kind:'entries',path,entries};
 }
 if(curveRows)for(let i=0;i<curveRows.length;i+=BATCH_ENTRIES)
  yield {kind:'entries',curveRows:curveRows.slice(i,i+BATCH_ENTRIES)};
}
export function applyManifestEntries(packet,{path,entries,curveRows}){
 if(curveRows){applyCurveRows(packet,curveRows,packet.curvePens);return;}
 let table=packet;for(const key of path)table=table[key];
 // Alternating keys/values avoid millions of tiny pair arrays during cloning.
 // Keep JSON's own data-property semantics for the legacy prototype setter.
 for(let i=0;i<entries.length;i+=2){
  const key=entries[i],value=entries[i+1];
  if(key==='__proto__')Object.defineProperty(table,key,{value,enumerable:true,writable:true,configurable:true});
  else table[key]=value;
 }
}
