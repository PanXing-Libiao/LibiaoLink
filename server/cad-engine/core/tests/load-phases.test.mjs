import test from 'node:test';
import assert from 'node:assert/strict';
import {LoadPhases} from '../../../../frontend/public/cad-viewer/core/load-phases.js';
test('observed phases accumulate across retries and snapshots do not double count',()=>{
 let at=0;const trace=new LoadPhases(()=>at);trace.phase('jobRequest');at=10;trace.phase('queued');at=30;trace.phase('processing');at=80;trace.phase('queued');at=90;
 assert.equal(trace.snapshot().durationsMS.queued,30);assert.equal(trace.snapshot().durationsMS.queued,30);
 trace.phase('persisting');at=110;trace.phase(null);
 assert.deepEqual(trace.snapshot(),{basis:'browser-observed',totalMS:110,durationsMS:{jobRequest:10,queued:30,processing:50,persisting:20}});
});
test('cache hit records no fictitious queue or native processing duration',()=>{
 let at=5;const trace=new LoadPhases(()=>at);trace.phase('jobRequest');at=15;trace.phase('manifestRead');at=20;trace.phase('metadataExpand');at=22;trace.phase('resources');at=30;trace.phase(null);
 assert.deepEqual(trace.snapshot().durationsMS,{jobRequest:10,manifestRead:5,metadataExpand:2,resources:8});
});
