import * as THREE from 'three';
import {ViewerSession} from './viewer-session.js';

/** Shared UCD projection. Product identities come only from productOccurrences/ownership. */
export function fromUnified(envelope){
  const d=envelope.document,s=envelope.snapshot;
  if(!['ucd-base64-envelope/1','ucd-binary-manifest/1'].includes(envelope.transportProfile)||!['1.0.0','2.0.0'].includes(d.schemaVersion))throw new Error('统一模型版本未支持');
  if(s.schemaVersion!==d.schemaVersion||s.documentRevision!==d.revision||d.extensionsRequired.length)throw new Error('统一模型快照或必需扩展不匹配');
  if(s.drawingProjection||Object.values(d.drawing).some(table=>Object.keys(table).length))throw new Error('二维绘制消费者尚未实现');
  const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],isIdentity=a=>a.every((v,i)=>v===identity[i]);
  const buffers=new Map(),geos=new Map(),attributes=new Map();
  for(const [id,b] of Object.entries(d.buffers)){
    const bytes=envelope.transportProfile==='ucd-binary-manifest/1'?new Uint8Array(envelope.decodedBuffers.get(id)):Uint8Array.from(atob(envelope.bufferPayloads[id]),c=>c.charCodeAt(0));
    if(bytes.byteLength!==b.byteLength)throw new Error('几何缓冲长度不符');buffers.set(id,bytes.buffer);
  }
  const types={f32:Float32Array,f64:Float64Array,u8:Uint8Array,u16:Uint16Array,u32:Uint32Array};
  function attribute(id){
    if(attributes.has(id))return attributes.get(id);
    const a=d.accessors[id],Type=types[a.component];if(!Type||a.byteStride&&a.byteStride!==Type.BYTES_PER_ELEMENT*a.components)throw new Error('未接入该Accessor类型或交错布局');
    if(a.component==='f64')throw new Error('WebGL消费端尚未接入f64量化，拒绝静默降精度');
    const out=new THREE.BufferAttribute(new Type(buffers.get(a.bufferId),a.byteOffset,a.count*a.components),a.components,a.normalized);attributes.set(id,out);return out;
  }
  for(const [id,g] of Object.entries(d.geometries)){
    if(Object.keys(g.attributes).some(key=>!['POSITION','NORMAL','COLOR_0'].includes(key)))throw new Error('未接入该顶点属性');
    const base=new THREE.BufferGeometry();for(const [key,aid] of Object.entries(g.attributes))base.setAttribute({POSITION:'position',NORMAL:'normal',COLOR_0:'color'}[key],attribute(aid));
    // Normals are generated per complete indexed resource before slicing primitives.
    for(const p of g.primitives){
      if(!['triangles','lines'].includes(p.topology))throw new Error('当前WebGL消费者未接入该拓扑: '+p.topology);
      const geo=new THREE.BufferGeometry();for(const [key,a] of Object.entries(base.attributes))geo.setAttribute(key,a);
      if(p.indices)geo.setIndex(attribute(p.indices));geo.setDrawRange(p.range.first,p.range.count);
      if(p.topology==='triangles'&&!geo.attributes.normal)geo.computeVertexNormals();
      geo.computeBoundingSphere();geo.userData.topology=p.topology;geos.set(id+'/'+p.id,geo);
    }
  }
  const byScene=new Map();for(const [id,draw] of Object.entries(s.draws)){if(!byScene.has(draw.occurrenceId))byScene.set(draw.occurrenceId,[]);byScene.get(draw.occurrenceId).push([id,draw]);}
  const objects=new Map(),drawObjects=new Map(),sourceVisibility=new Map();
  const fixed=(o,m)=>{o.matrix.fromArray(m);o.matrixAutoUpdate=false;o.matrixWorldNeedsUpdate=true;};
  for(const [id,n] of Object.entries(d.sceneOccurrences)){
    const over=s.occurrenceOverrides[id]||{},r=d.representations[over.representationId||n.representationId],draws=byScene.get(id)||[];
    const compact=r?.bindings.length===1&&draws.length===1&&isIdentity(r.bindings[0].localFromRepresentation);
    let o=new THREE.Group();
    for(const [did,draw] of draws){
      const b=r.bindings.find(x=>x.id===draw.bindingId),g=geos.get(b.geometryId+'/'+draw.primitiveId),mat=d.materials[draw.materialId];
      if(draw.membership!=='present'||draw.availability!=='ready'||!['active','not-represented'].includes(draw.suppression)||!['shown','hidden'].includes(draw.visibility))throw new Error('未支持的Draw状态');
      const lines=g.userData.topology==='lines';
      const material=lines?new THREE.LineBasicMaterial({color:new THREE.Color().fromArray(mat.baseColor),opacity:Math.max(mat.baseColor[3],.85),transparent:mat.alphaMode==='blend'}):new THREE.MeshStandardMaterial({color:new THREE.Color().fromArray(mat.baseColor),vertexColors:!!g.attributes.color,metalness:mat.metallic,roughness:mat.roughness,side:THREE.DoubleSide,flatShading:!g.attributes.color,opacity:mat.baseColor[3],transparent:mat.alphaMode==='blend'});
      const mesh=lines?new THREE.LineSegments(g,material):new THREE.Mesh(g,material);Object.assign(mesh.userData,{meshDefinition:b.geometryId,bindingId:b.id,primitiveId:draw.primitiveId,renderItemId:did,productId:d.renderOwnership[did],sourceId:id,sourceVisible:draw.visibility==='shown',drawObject:true,topology:g.userData.topology||'triangles'});
      mesh.name=n.name+' / '+draw.primitiveId;fixed(mesh,b.localFromRepresentation);drawObjects.set(did,mesh);
      if(compact)o=mesh;else o.add(mesh);
    }
    sourceVisibility.set(id,compact?draws[0][1].visibility==='shown':true);
    o.name=n.name;Object.assign(o.userData,{sourceId:id,sourcePath:n.sourceRefs[0]?.path,legacyId:n.sourceRefs[0]?.legacyId,sourceVisible:sourceVisibility.get(id),sceneAnchor:true});fixed(o,over.localFromParent||n.localFromParent);objects.set(id,o);
  }
  for(const n of Object.values(d.sceneOccurrences).sort((a,b)=>a.orderInParent-b.orderInParent))if(n.parentId!==null)objects.get(n.parentId).add(objects.get(n.id));
  for(const [pid,p] of Object.entries(d.productOccurrences))for(const sid of p.sceneAnchorIds){const o=objects.get(sid);if(o)o.userData.productId=pid;}
  let root;
  if(s.sceneRoots.length===1&&isIdentity(d.coordinates.sourceToDocument))root=objects.get(s.sceneRoots[0]);
  else{root=new THREE.Group();root.name='Document';fixed(root,d.coordinates.sourceToDocument);for(const id of s.sceneRoots)root.add(objects.get(id));}
  const session=new ViewerSession(Object.values(d.sceneOccurrences).map(n=>[n.id,n.parentId]),sourceVisibility,Object.values(d.productOccurrences).map(n=>[n.id,n.parentId]));
  const sync=()=>{
    for(const [id,o] of objects)o.visible=session.localShown(id);
    for(const [did,o] of drawObjects){const draw=s.draws[did];o.visible=session.localShown(draw.occurrenceId)&&session.productEffective(d.renderOwnership[did])&&(draw.visibility==='shown'||session.revealSourceHidden||session.revealed.has(draw.occurrenceId));}
  };sync();
  root.userData.productModel={products:d.products,occurrences:d.productOccurrences,sceneObjects:objects,drawObjects,ownership:d.renderOwnership};
  return {root,info:{...envelope.presentation,format:d.sources[0].format,unified:true,documentId:d.documentId,documentRevision:d.revision,snapshotId:s.id,productOccurrences:Object.keys(d.productOccurrences).length,selection:null},session,sync,objects,drawObjects};
}
