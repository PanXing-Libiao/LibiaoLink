import * as THREE from './vendor/three.module.js';
import {OrbitControls} from './vendor/controls/OrbitControls.js';
import {projectDrawing} from './drawing-projection.js';

// Project only supported mesh sources, retaining the original block hierarchy.
export function projectMeshes(document, meshIds) {
  const source=document.drawing, keep=new Set();
  for(const [id,space] of Object.entries(source.spaces))
    if(space.entityIds.some(id=>meshIds.has(id)))keep.add(id);
  let changed=true;
  while(changed){changed=false;for(const [id,space] of Object.entries(source.spaces))
    if(!keep.has(id)&&space.blockInstanceIds.some(i=>keep.has(source.blocks[source.blockInstances[i].definitionId]?.spaceId))){keep.add(id);changed=true;}}
  const spaces=Object.fromEntries(Object.entries(source.spaces).map(([id,space])=>[id,{...space,
    entityIds:space.entityIds.filter(id=>meshIds.has(id)),annotationIds:[],
    blockInstanceIds:space.blockInstanceIds.filter(i=>keep.has(source.blocks[source.blockInstances[i].definitionId]?.spaceId))}]));
  const model=Object.values(source.drawings)[0].modelSpaceId;
  const styles={};
  const projection=projectDrawing({...document,drawing:{...source,spaces}},{kind:'model',spaceId:model},null,styles);
  return {projection,styles};
}

export function createDrawingMeshViewer({document:doc,viewport,geometry,meshIds,onSelect}) {
  const {projection,styles}=projectMeshes(doc,meshIds);
  const entries=doc.extensions['org.cad-preview.annotation-presentation/1'].items;
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setClearColor(0xf4f5f7);
  const canvas=renderer.domElement;canvas.id='drawingMeshCanvas';
  canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;z-index:4;touch-action:none';
  viewport.append(canvas);
  const status=document.createElement('div');status.setAttribute('role','status');
  status.style.cssText='position:absolute;top:12px;left:12px;z-index:5;pointer-events:none;padding:6px 10px;border-radius:6px;background:#ffffffdd;color:#405566;font-size:12px';
  viewport.append(status);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,0.01,10000);
  camera.up.set(0,0,1);
  const controls=new OrbitControls(camera,canvas);controls.enableDamping=false;
  scene.add(new THREE.HemisphereLight(0xffffff,0x888899,2));
  const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(1,-2,3);scene.add(light);
  const cache=new Map(),objects=[],materials=[],bounds=new THREE.Box3(),rows=[];
  let skipped=0,frame=0,disposed=false,active=true;
  function request(){if(active&&!disposed&&!frame)frame=requestAnimationFrame(()=>{frame=0;renderer.render(scene,camera);});}
  function shared(rep){
    if(cache.has(rep))return cache.get(rep);
    const src=geometry(rep),g=new THREE.BufferGeometry(),box=new THREE.Box3();
    for(let i=0;i<src.positions.length;i+=3)box.expandByPoint(new THREE.Vector3(...src.positions.subarray(i,i+3)));
    const center=box.getCenter(new THREE.Vector3()),positions=new Float32Array(src.positions.length);
    for(let i=0;i<positions.length;i++)positions[i]=src.positions[i]-center.getComponent(i%3);
    g.setAttribute('position',new THREE.BufferAttribute(positions,3));
    if(src.indices)g.setIndex(new THREE.BufferAttribute(new Uint32Array(src.indices),1));
    if(src.range)g.setDrawRange(src.range.first,src.range.count);
    if(src.topology==='triangles')g.computeVertexNormals();g.computeBoundingBox();
    const result={g,center,src};cache.set(rep,result);return result;
  }
  for(const [id,draw] of Object.entries(projection.draws)){
    if(draw.visibility==='hidden')continue;
    // A 2D clipping boundary cannot be applied as an arbitrary 3D cutting solid.
    if(draw.clipRegions?.length){skipped++;continue;}
    const group=new THREE.Group();group.userData={id,draw};
    const entry=entries[draw.itemId];
    for(const part of entry.parts){
      const resolved=styles[id]?.find(row=>row.id===part.id);
      if(resolved?.visibility==='hidden')continue;
      const style=resolved?.style||draw.style,{g,center,src}=shared(part.representationId);
      const color=new THREE.Color().setRGB(...style.color.slice(0,3),THREE.SRGBColorSpace);
      const opacity=draw.style.opacity??1;
      const material=src.topology==='triangles'
        ?new THREE.MeshStandardMaterial({color,side:THREE.DoubleSide,roughness:0.8,metalness:0,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1,opacity,transparent:opacity<1})
        :new THREE.LineBasicMaterial({color,opacity,transparent:opacity<1});
      const object=src.topology==='triangles'?new THREE.Mesh(g,material):new THREE.LineSegments(g,material);
      object.matrixAutoUpdate=false;
      object.matrix.fromArray(draw.localToSpace).multiply(new THREE.Matrix4().fromArray(src.localFromRepresentation)).multiply(new THREE.Matrix4().makeTranslation(center.x,center.y,center.z));
      object.userData={id,draw,color:color.clone()};materials.push(material);objects.push(object);group.add(object);
    }
    scene.add(group);group.updateMatrixWorld(true);bounds.union(new THREE.Box3().setFromObject(group));rows.push(group);
  }
  // Keep GPU coordinates close to the origin without changing source coordinates.
  const origin=bounds.isEmpty()?new THREE.Vector3():bounds.getCenter(new THREE.Vector3());
  rows.forEach(group=>group.position.sub(origin));scene.updateMatrixWorld(true);
  function visibleBounds(selected){const b=new THREE.Box3();for(const row of rows)if(row.visible&&(!selected||selected.has(row.userData.id)))b.union(new THREE.Box3().setFromObject(row));return b;}
  function fit(selected){const box=visibleBounds(selected);if(box.isEmpty())return false;
    const center=box.getCenter(new THREE.Vector3()),radius=Math.max(box.getSize(new THREE.Vector3()).length()/2,1e-6);
    const distance=radius/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))*1.15*Math.max(1,1/camera.aspect);
    camera.position.copy(center).add(new THREE.Vector3(1,-1,0.8).normalize().multiplyScalar(distance));
    controls.minDistance=radius/1000;controls.maxDistance=radius*50;
    camera.near=Math.max(radius/10000,1e-8);camera.far=distance+radius*100;camera.updateProjectionMatrix();controls.target.copy(center);controls.update();request();return true;}
  function resize(){const w=viewport.clientWidth||1,h=viewport.clientHeight||1;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();request();}
  function sync(layers,selected){for(const row of rows)row.visible=!(row.userData.draw.visibilityLayerIds||[]).some(id=>layers.get(id)===false);
    status.textContent=(rows.some(row=>row.visible)?'三维对象 · 仅显示已支持的面和网格':'当前没有可见的三维面或网格')+(skipped?' · 裁剪实例暂未显示':'');
    for(const object of objects)object.material.color.copy(selected.has(object.userData.id)?new THREE.Color(0xd9426f):object.userData.color);request();}
  let down=null;
  const start=e=>{down=[e.clientX,e.clientY];};
  const end=e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>4)return;down=null;
    const rect=canvas.getBoundingClientRect(),ray=new THREE.Raycaster();ray.params.Line.threshold=visibleBounds().getSize(new THREE.Vector3()).length()/500;
    ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2),camera);
    const hit=ray.intersectObjects(objects.filter(o=>o.parent.visible),false)[0];onSelect(hit?hit.object.userData:null,e.shiftKey);};
  canvas.addEventListener('pointerdown',start);canvas.addEventListener('pointerup',end);controls.addEventListener('change',request);
  resize();fit();
  return {fit,resize,sync,setActive(value){active=value;canvas.hidden=!value;status.hidden=!value;controls.enabled=value;if(value){resize();request();}},
    record:()=>({objects:rows.length,parts:objects.length,skippedClipped:skipped,visible:rows.filter(r=>r.visible).length,origin:origin.toArray(),camera:camera.position.toArray(),bounds:bounds.isEmpty()?null:{min:bounds.min.toArray(),max:bounds.max.toArray()}}),
    dispose(){disposed=true;cancelAnimationFrame(frame);controls.dispose();canvas.removeEventListener('pointerdown',start);canvas.removeEventListener('pointerup',end);for(const {g} of cache.values())g.dispose();materials.forEach(m=>m.dispose());renderer.dispose();canvas.remove();status.remove();}};
}
