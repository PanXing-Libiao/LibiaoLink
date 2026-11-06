import test from 'node:test';
import assert from 'node:assert/strict';
import {createStrokeGPU} from '../public/cad-viewer/core/gpu/gpu-strokes.js';
function fixture(){
 const calls=[],live=new Set();let status=1,available=true,id=0;
 const api={TIMEOUT_EXPIRED:1,ALREADY_SIGNALED:2,CONDITION_SATISFIED:3,WAIT_FAILED:4,SYNC_GPU_COMMANDS_COMPLETE:5,
  getShaderParameter:()=>true,getProgramParameter:()=>true,
  fenceSync(condition,flags){calls.push(['fence',condition,flags]);if(!available)return null;const sync={id:++id};live.add(sync);return sync;},
  clientWaitSync(sync,flags,timeout){assert.ok(live.has(sync));calls.push(['wait',flags,timeout]);return status;},
  deleteSync(sync){assert.ok(live.delete(sync));calls.push(['delete',sync.id]);},
  flush(){calls.push(['flush']);},getExtension:()=>({loseContext(){calls.push(['lose']);}})};
 const gl=new Proxy(api,{get(target,name){return name in target?target[name]:()=>({});}});
 return {gpu:createStrokeGPU(()=>({getContext:()=>gl})),calls,live,status(value){status=value;},unavailable(){available=false;}};
}
test('GPU polling never blocks and completed fences are retired once',()=>{
 const f=fixture();assert.equal(f.gpu.batchComplete(),true);f.gpu.submitBatch();
 assert.equal(f.gpu.batchComplete(),false);assert.equal(f.gpu.batchComplete(),false);
 assert.deepEqual(f.calls.filter(c=>c[0]==='wait'),[['wait',0,0],['wait',0,0]]);
 f.status(3);assert.equal(f.gpu.batchComplete(),true);assert.equal(f.live.size,0);
 assert.equal(f.gpu.batchComplete(),true);assert.equal(f.calls.filter(c=>c[0]==='delete').length,1);
});
test('cache reset cannot forget GPU work left by a cancelled paint',()=>{
 const f=fixture();f.gpu.submitBatch();f.gpu.reset();assert.equal(f.live.size,1);assert.equal(f.gpu.batchComplete(),false);
 f.status(2);assert.equal(f.gpu.batchComplete(),true);f.gpu.submitBatch();f.gpu.dispose();assert.equal(f.live.size,0);
});
test('failed or unavailable completion signals surface errors instead of waiting forever',()=>{
 const f=fixture();f.gpu.submitBatch();f.status(4);assert.throws(()=>f.gpu.batchComplete(),/wait failed/);assert.equal(f.live.size,0);
 f.unavailable();assert.throws(()=>f.gpu.submitBatch(),/fence unavailable/);f.gpu.dispose();
});
