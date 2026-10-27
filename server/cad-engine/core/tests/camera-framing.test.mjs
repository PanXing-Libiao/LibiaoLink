import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {fitCameraToBox,updateCameraRange,captureCameraView,restoreCameraView} from '../../../../frontend/public/cad-viewer/core/camera-framing.js';

function rig(){
  const camera=new THREE.PerspectiveCamera(38,1.3,.01,100000);
  camera.up.set(0,0,1);camera.position.set(1,-1,.8);
  const controls={target:new THREE.Vector3(),minDistance:0,maxDistance:Infinity,update(){camera.lookAt(this.target);camera.updateMatrixWorld(true);}};
  return {camera,controls};
}
function visibleDepth(point,camera){
  const projected=point.clone().project(camera);
  assert.ok(projected.z>=-1&&projected.z<=1,`point depth ${projected.z} is clipped`);
  return projected;
}

test('focus a small off-centre part, then zoom beyond the old far plane',()=>{
  const {camera,controls}=rig();
  const scene=new THREE.Box3(new THREE.Vector3(-20000,-1000,-1000),new THREE.Vector3(20000,1000,1000)).getBoundingSphere(new THREE.Sphere());
  const box=new THREE.Box3(new THREE.Vector3(18000,0,0),new THREE.Vector3(18020,20,20));
  assert.equal(fitCameraToBox(camera,controls,box,scene),true);
  const projected=visibleDepth(box.getCenter(new THREE.Vector3()),camera);
  assert.ok(Math.abs(projected.x)<1e-10&&Math.abs(projected.y)<1e-10);
  const direction=camera.position.clone().sub(controls.target).normalize();
  const radius=box.getBoundingSphere(new THREE.Sphere()).radius;
  camera.position.copy(controls.target).addScaledVector(direction,radius*150);
  controls.update();updateCameraRange(camera,controls,scene);
  visibleDepth(box.getCenter(new THREE.Vector3()),camera);
  assert.ok(controls.maxDistance>scene.radius*100,'selection keeps the whole-model navigation range');
});

test('rotation, panning and scale changes keep all model corners within depth range',()=>{
  for(const scale of [.001,1,1000]){
    const {camera,controls}=rig();
    const box=new THREE.Box3(new THREE.Vector3(-10,-20,-30).multiplyScalar(scale),new THREE.Vector3(10,20,30).multiplyScalar(scale));
    const sphere=box.getBoundingSphere(new THREE.Sphere());
    controls.target.set(500,100,0).multiplyScalar(scale);
    for(const direction of [new THREE.Vector3(1,-2,3),new THREE.Vector3(-2,1,-3),new THREE.Vector3(0,0,1)]){
      let previousNear=0;
      for(const distance of [1000,10000,100000]){
        camera.position.copy(controls.target).addScaledVector(direction.clone().normalize(),distance*scale);
        controls.update();updateCameraRange(camera,controls,sphere);
        assert.ok(camera.near>previousNear,'near plane follows the viewing distance instead of retaining the tiny focus value');
        previousNear=camera.near;
        for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z])visibleDepth(new THREE.Vector3(x,y,z),camera);
      }
    }
  }
});

test('empty selection leaves the camera and orbit target unchanged',()=>{
  const {camera,controls}=rig(),position=camera.position.clone(),target=controls.target.clone();
  assert.equal(fitCameraToBox(camera,controls,new THREE.Box3()),false);
  assert.ok(camera.position.equals(position));assert.ok(controls.target.equals(target));
});

test('microscopic face focus is not clipped by the normal near-plane floor',()=>{
  const {camera,controls}=rig();
  camera.position.set(0,0,3e-6);controls.update();
  updateCameraRange(camera,controls,new THREE.Sphere(new THREE.Vector3(),20000),1e-6);
  visibleDepth(controls.target,camera);
  assert.ok(camera.near>0&&camera.near<camera.position.distanceTo(controls.target));
});

test('cancel focus restores the previous panned and zoomed camera without reverting a viewport resize',()=>{
  const {camera,controls}=rig();camera.position.set(100,-250,80);controls.target.set(30,10,5);
  camera.zoom=1.5;controls.minDistance=.25;controls.maxDistance=50000;controls.update();
  const before=captureCameraView(camera,controls);
  fitCameraToBox(camera,controls,new THREE.Box3(new THREE.Vector3(18000,0,0),new THREE.Vector3(18020,20,20)));
  camera.position.add(new THREE.Vector3(10,20,30));controls.target.add(new THREE.Vector3(1,2,3));
  camera.aspect=.6;camera.zoom=.75;restoreCameraView(camera,controls,before);
  assert.ok(camera.position.equals(new THREE.Vector3(100,-250,80)));assert.ok(controls.target.equals(new THREE.Vector3(30,10,5)));
  assert.equal(camera.zoom,1.5);assert.equal(camera.aspect,.6);assert.equal(controls.minDistance,.25);assert.equal(controls.maxDistance,50000);
  const projected=controls.target.clone().project(camera);assert.ok(Math.abs(projected.x)<1e-10&&Math.abs(projected.y)<1e-10);
});
