import * as THREE from 'three';

// Local viewing history only; keep independent snapshots for reversible UI actions.
export function captureCameraView(camera,controls){
  return {position:camera.position.clone(),up:camera.up.clone(),target:controls.target.clone(),zoom:camera.zoom,minDistance:controls.minDistance,maxDistance:controls.maxDistance};
}
export function restoreCameraView(camera,controls,view){
  camera.up.copy(view.up);camera.position.copy(view.position);camera.zoom=view.zoom;
  controls.target.copy(view.target);controls.minDistance=view.minDistance;controls.maxDistance=view.maxDistance;
  camera.updateProjectionMatrix();controls.update();
}

// Camera navigation is a viewer policy, independent of source CAD visibility.
// Keep clipping in sync with OrbitControls, which moves the camera but does not
// update its near/far planes. A small selection must not shrink the scene range.
export function updateCameraRange(camera,controls,sceneSphere,focusRadius){
  if(!sceneSphere||sceneSphere.isEmpty())return;
  if(focusRadius!==undefined){
    controls.minDistance=focusRadius/200;
    controls.maxDistance=Math.max(focusRadius,sceneSphere.radius)*200;
  }
  const distance=camera.position.distanceTo(controls.target);
  // The usual precision floor must stay in front of a microscopic face target.
  const near=Math.max(Number.EPSILON,Math.min(distance/100,Math.max(distance/10000,0.00001)));
  const far=Math.max(camera.position.distanceTo(sceneSphere.center)+sceneSphere.radius*1.05,near*2,100);
  if(camera.near!==near||camera.far!==far){
    camera.near=near;camera.far=far;camera.updateProjectionMatrix();
  }
}

export function fitCameraToBox(camera,controls,box,sceneSphere=box.getBoundingSphere(new THREE.Sphere())){
  if(box.isEmpty())return false;
  const center=box.getCenter(new THREE.Vector3());
  const radius=Math.max(box.getSize(new THREE.Vector3()).length()/2,0.001);
  const fov=THREE.MathUtils.degToRad(camera.fov);
  const angle=Math.min(fov,2*Math.atan(Math.tan(fov/2)*camera.aspect));
  const distance=radius/Math.sin(angle/2)*1.18;
  const direction=camera.position.clone().sub(controls.target).normalize();
  if(direction.lengthSq()<.1)direction.set(1,-1,.7).normalize();
  camera.position.copy(center).addScaledVector(direction,distance);
  controls.target.copy(center);
  updateCameraRange(camera,controls,sceneSphere,radius);
  controls.update();
  return true;
}
