import * as THREE from 'three';
import {ViewerSession} from './viewer-session.js';

/** Direct UCD render projection: build the optimized physical representation without
 * first creating one Mesh/BufferGeometry per logical draw.
 *
 * Semantics are the same as unified-viewer.js: one logical draw still maps to one
 * (physical mesh, triangle span) pair, and product/scene gates stay independent.
 * Physical meshes merge only draws inside the same scene occurrence that also share
 * binding, material, source visibility and product ownership; geometry buffers,
 * normals and merged index arrays are cached per definition and shared by instances.
 */
export function directProjection(envelope,{mergePrimitives=true}={}){
  const d=envelope.document,s=envelope.snapshot;
  if(!['ucd-base64-envelope/1','ucd-binary-manifest/1'].includes(envelope.transportProfile)||!['1.0.0','2.0.0'].includes(d.schemaVersion))throw new Error('统一模型版本未支持');
  if(s.schemaVersion!==d.schemaVersion||s.documentRevision!==d.revision||d.extensionsRequired.length)throw new Error('统一模型快照或必需扩展不匹配');
  if(s.drawingProjection||Object.values(d.drawing).some(table=>Object.keys(table).length))throw new Error('二维绘制消费者尚未实现');
  if(Object.values(d.materials||{}).some(m=>m.alphaMode&&!['opaque','blend'].includes(m.alphaMode)))throw new Error('Direct 尚未接入遮罩材质（alphaMode）');
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],isIdentity=a=>a.every((v,i)=>v===identity[i]);
  const stats={bufferBytes:0,attributes:0,geometryResources:0,normalsComputed:0,normalArrays:0,primitiveViews:0,mergedGeometries:0,mergedIndexBytes:0,indexCopies:0,materialsCreated:0,meshObjectsCreated:0,groupObjectsCreated:0,logicalDraws:0};
  const buffers=new Map(),attributes=new Map();
  for(const [id,b] of Object.entries(d.buffers)){
    const bytes=envelope.transportProfile==='ucd-binary-manifest/1'?new Uint8Array(envelope.decodedBuffers.get(id)):Uint8Array.from(atob(envelope.bufferPayloads[id]),c=>c.charCodeAt(0));
    if(bytes.byteLength!==b.byteLength)throw new Error('几何缓冲长度不符');buffers.set(id,bytes.buffer);stats.bufferBytes+=b.byteLength;
  }
  const Types={f32:Float32Array,f64:Float64Array,u8:Uint8Array,u16:Uint16Array,u32:Uint32Array};
  function attribute(id){
    if(attributes.has(id))return attributes.get(id);
    const a=d.accessors[id],Type=Types[a.component];if(!Type||a.byteStride&&a.byteStride!==Type.BYTES_PER_ELEMENT*a.components)throw new Error('未接入该Accessor类型或交错布局');
    if(a.component==='f64')throw new Error('WebGL消费端尚未接入f64量化，拒绝静默降精度');
    const out=new THREE.BufferAttribute(new Type(buffers.get(a.bufferId),a.byteOffset,a.count*a.components),a.components,a.normalized);attributes.set(id,out);stats.attributes++;return out;
  }
  const SEMANTICS={POSITION:'position',NORMAL:'normal',COLOR_0:'color'};
  const geometryResources=new Map();
  function resource(geometryId){
    if(geometryResources.has(geometryId))return geometryResources.get(geometryId);
    const g=d.geometries[geometryId];
    if(Object.keys(g.attributes).some(key=>!SEMANTICS[key]))throw new Error('未接入该顶点属性');
    const attributesMap={};for(const [key,aid] of Object.entries(g.attributes))attributesMap[SEMANTICS[key]]=attribute(aid);
    const primitives=g.primitives;
    const topology=g.primitives[0].topology;
    const indexIds=new Set(primitives.map(p=>p.indices));
    const shared=indexIds.size===1?attribute(primitives[0].indices):null;
    const base=new THREE.BufferGeometry();
    for(const [name,attr] of Object.entries(attributesMap))base.setAttribute(name,attr);
    if(shared)base.setIndex(shared);
    let normal=attributesMap.normal||null;
    if(!normal&&shared&&topology==='triangles'){
      // computeVertexNormals() ignores drawRange and walks the whole index; every
      // primitive of one geometry shares index+position, so one computation equals
      // the per-primitive result the old projection recomputed for every draw.
      base.computeVertexNormals();normal=base.attributes.normal;stats.normalsComputed++;stats.normalArrays++;
      for(const p of primitives){if(p.indices!==primitives[0].indices)throw new Error('共享法线需要同一索引资源');}
    }
    base.setIndex(null);
    const out={geometry:g,attributes:attributesMap,sharedIndex:shared,normal,base,topology,primitiveViews:new Map()};
    geometryResources.set(geometryId,out);stats.geometryResources++;
    return out;
  }
  function primitiveView(geometryId,primitiveId){
    const res=resource(geometryId);
    const key=geometryId+'/'+primitiveId;
    if(res.primitiveViews.has(primitiveId))return res.primitiveViews.get(primitiveId);
    const p=res.geometry.primitives.find(x=>x.id===primitiveId);
    if(!p)throw new Error('图元不存在');
    if(!['triangles','lines'].includes(p.topology))throw new Error('当前WebGL消费者未接入该拓扑: '+p.topology);
    const geo=new THREE.BufferGeometry();
    for(const [name,attr] of Object.entries(res.attributes))geo.setAttribute(name,attr);
    if(res.normal)geo.setAttribute('normal',res.normal);
    if(p.indices)geo.setIndex(attribute(p.indices));geo.setDrawRange(p.range.first,p.range.count);
    if(p.topology==='triangles'&&!geo.attributes.normal){geo.computeVertexNormals();stats.normalsComputed++;}
    geo.computeBoundingSphere();geo.computeBoundingBox();geo.userData.topology=p.topology;
    res.primitiveViews.set(primitiveId,geo);stats.primitiveViews++;
    return geo;
  }
  const mergedCache=new Map();
  function mergedGeometry(geometryId,primitiveIds){
    const key=geometryId+'|'+primitiveIds.join(',');
    if(mergedCache.has(key))return mergedCache.get(key);
    const res=resource(geometryId);
    const prims=primitiveIds.map(id=>res.geometry.primitives.find(p=>p.id===id));
    if(!res.sharedIndex)throw new Error('合并渲染需要同一索引资源');
    const indexAttr=attribute(prims[0].indices);
    const total=prims.reduce((n,p)=>n+p.range.count,0);
    const merged=new Uint32Array(total);let cursor=0;
    for(const p of prims){const {first,count}=p.range;merged.set(indexAttr.array.subarray(first,first+count),cursor);cursor+=count;}
    const geo=new THREE.BufferGeometry();
    for(const [name,attr] of Object.entries(res.attributes))geo.setAttribute(name,attr);
    if(res.normal)geo.setAttribute('normal',res.normal);
    geo.setIndex(new THREE.BufferAttribute(merged,1));geo.setDrawRange(0,total);
    geo.computeBoundingSphere();geo.computeBoundingBox();geo.userData.topology=res.topology;
    mergedCache.set(key,geo);stats.mergedGeometries++;stats.mergedIndexBytes+=merged.byteLength;stats.indexCopies++;
    return geo;
  }
  const materials=new Map();
  function material(materialId,hasColor,lines=false){
    const key=materialId+'|'+hasColor+'|'+lines;
    if(materials.has(key))return materials.get(key);
    const mat=d.materials[materialId];
    const blend=mat.alphaMode==='blend';
    const out=lines?new THREE.LineBasicMaterial({color:new THREE.Color().fromArray(mat.baseColor),opacity:mat.baseColor[3],transparent:blend,depthWrite:!blend}):new THREE.MeshStandardMaterial({color:new THREE.Color().fromArray(mat.baseColor),vertexColors:hasColor,metalness:mat.metallic,roughness:mat.roughness,side:THREE.DoubleSide,flatShading:!hasColor,opacity:mat.baseColor[3],transparent:blend,depthWrite:!blend});
    materials.set(key,out);stats.materialsCreated++;return out;
  }
  const byScene=new Map();
  for(const [id,draw] of Object.entries(s.draws)){
    if(draw.membership!=='present'||draw.availability!=='ready'||!['active','not-represented'].includes(draw.suppression)||!['shown','hidden'].includes(draw.visibility))throw new Error('未支持的Draw状态');
    const list=byScene.get(draw.occurrenceId)||[];list.push([id,draw]);byScene.set(draw.occurrenceId,list);
  }
  const fixed=(o,m)=>{o.matrix.fromArray(m);o.matrixAutoUpdate=false;o.matrixWorldNeedsUpdate=true;};
  const objects=new Map(),drawObjects=new Map(),sourceVisibility=new Map();
  for(const [id,n] of Object.entries(d.sceneOccurrences)){
    const over=s.occurrenceOverrides[id]||{},r=d.representations[over.representationId||n.representationId],draws=byScene.get(id)||[];
    const identityBinding=r?.bindings.length===1&&isIdentity(r.bindings[0].localFromRepresentation);
    const groups=new Map();
    for(const [did,draw] of draws){
      // Transparent faces remain separate objects so Three.js can sort them;
      // merging a whole transparent part would defeat object-depth sorting.
      const key=[draw.bindingId,draw.materialId,draw.visibility,d.renderOwnership[did]??'',d.materials[draw.materialId].alphaMode==='blend'?did:''].join('|');
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push([did,draw]);
    }
    const single=draws.length===1&&identityBinding;
    let o=single?null:new THREE.Group();if(o)stats.groupObjectsCreated++;
    for(const members of groups.values()){
      const [did,draw]=members[0],b=r.bindings.find(x=>x.id===draw.bindingId);
      if(!b)throw new Error('缺少Binding');
      const primitiveIds=members.map(([,x])=>x.primitiveId);
      const hasColor=!!resource(b.geometryId).attributes.color;
      const topology=resource(b.geometryId).topology;
      const lines=topology==='lines';
      const geo=mergePrimitives&&primitiveIds.length>1?mergedGeometry(b.geometryId,primitiveIds):primitiveView(b.geometryId,primitiveIds[0]);
      if(d.materials[draw.materialId].alphaMode==='blend'&&!geo.userData.primitiveBounds){
        // Shared POSITION arrays cover the entire definition. Sorting needs the
        // drawn face's bounds, otherwise every transparent face has one centre.
        const box=new THREE.Box3(),point=new THREE.Vector3();
        const {start,count}=geo.drawRange;
        for(let i=start;i<start+count;i++){point.fromBufferAttribute(geo.attributes.position,geo.index.getX(i));box.expandByPoint(point);}
        geo.boundingBox=box;geo.boundingSphere=box.getBoundingSphere(new THREE.Sphere());geo.userData.primitiveBounds=true;
      }
      const spans=[];let offset=0;const merged=mergePrimitives&&primitiveIds.length>1;
      for(const [memberId,memberDraw] of members){
        const p=resource(b.geometryId).geometry.primitives.find(x=>x.id===memberDraw.primitiveId);
        // faceIndex from Raycaster is absolute in the geometry's index array.
        spans.push({firstTriangle:(merged?offset:p.range.first)/3,triangleCount:p.range.count/3,firstIndex:merged?offset:p.range.first,indexCount:p.range.count,renderItemId:memberId,primitiveId:memberDraw.primitiveId,bindingId:memberDraw.bindingId,productOccurrenceId:d.renderOwnership[memberId],sceneOccurrenceId:id});
        offset+=p.range.count;
      }
      const mesh=lines?new THREE.LineSegments(geo,material(draw.materialId,false,true)):new THREE.Mesh(geo,material(draw.materialId,hasColor));stats.meshObjectsCreated++;
      mesh.name=n.name+' / '+primitiveIds.join('+');fixed(mesh,b.localFromRepresentation);
      Object.assign(mesh.userData,{meshDefinition:b.geometryId,bindingId:b.id,primitiveId:members.length===1?primitiveIds[0]:undefined,renderItemId:members.length===1?did:undefined,productId:d.renderOwnership[did],sourceId:id,sourceVisible:draw.visibility==='shown',drawObject:true,primitiveSpans:spans,logicalDraws:members.map(([x])=>x),topology});
      for(const [memberId] of members)drawObjects.set(memberId,mesh);
      if(single)o=mesh;else o.add(mesh);
    }
    if(!o)throw new Error('场景节点没有Draw');
    // Match the established UCD viewer rule: only a compact single-draw occurrence
    // inherits the draw's source visibility; otherwise per-draw state stays on the
    // mesh so hiding one face does not hide its siblings.
    sourceVisibility.set(id,single?draws[0][1].visibility==='shown':true);
    o.name=n.name;Object.assign(o.userData,{sourceId:id,sourcePath:n.sourceRefs[0]?.path,legacyId:n.sourceRefs[0]?.legacyId,sourceVisible:sourceVisibility.get(id),sceneAnchor:true});fixed(o,over.localFromParent||n.localFromParent);objects.set(id,o);
    stats.logicalDraws+=draws.length;
  }
  for(const n of Object.values(d.sceneOccurrences).sort((a,b)=>a.orderInParent-b.orderInParent))if(n.parentId!==null)objects.get(n.parentId).add(objects.get(n.id));
  for(const [pid,p] of Object.entries(d.productOccurrences))for(const sid of p.sceneAnchorIds){const o=objects.get(sid);if(o)o.userData.productId=pid;}
  let root;
  if(s.sceneRoots.length===1&&isIdentity(d.coordinates.sourceToDocument))root=objects.get(s.sceneRoots[0]);
  else{root=new THREE.Group();root.name='Document';fixed(root,d.coordinates.sourceToDocument);for(const id of s.sceneRoots)root.add(objects.get(id));}
  const session=new ViewerSession(Object.values(d.sceneOccurrences).map(n=>[n.id,n.parentId]),sourceVisibility,Object.values(d.productOccurrences).map(n=>[n.id,n.parentId]));
  const sync=()=>{
    for(const [id,o] of objects)o.visible=session.localShown(id);
    for(const mesh of new Set(drawObjects.values())){
      const draw=s.draws[mesh.userData.primitiveSpans[0].renderItemId];const gated=mesh.userData.logicalDraws.some(memberId=>{const x=s.draws[memberId];return x.visibility!=='shown'&&!session.revealSourceHidden&&!session.revealed.has(x.occurrenceId);});
      mesh.visible=session.localShown(draw.occurrenceId)&&session.productEffective(d.renderOwnership[mesh.userData.primitiveSpans[0].renderItemId])&&!gated;
    }
  };sync();
  root.userData.productModel={products:d.products,occurrences:d.productOccurrences,sceneObjects:objects,drawObjects,ownership:d.renderOwnership};
  return {root,info:{...envelope.presentation,format:d.sources[0].format,unified:true,documentId:d.documentId,documentRevision:d.revision,snapshotId:s.id,productOccurrences:Object.keys(d.productOccurrences).length,selection:null},session,sync,objects,drawObjects,stats};
}
