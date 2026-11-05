// Browser acceptance only. Synthetic delayed loads exercise the public host API;
// real corpus checks use the file input, production HTTP parser and Canvas viewer.
const frame=document.getElementById('viewer'),status=document.getElementById('status');
const report={date:'2026-10-22',viewerVersion:'0.4.3',method:'Real original bytes via file input change and production parse; Canvas pixels, viewer hit-test and actual layer buttons. Synthetic delayed host loaders are separate controls.',controls:[],files:[],failures:[]};
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,timeout=70000){const start=performance.now();while(!test()){if(performance.now()-start>timeout)throw new Error('readiness timeout');await pause(40);}}
const save=()=>fetch('/__report',{method:'POST',body:JSON.stringify(report)});
const el=(w,id)=>w.document.getElementById(id);
async function fresh(platform=false){
 frame.src='/__import-frame?autoload=0&acceptance=1'+(platform?'&platform=1':'');
 await new Promise(resolve=>frame.onload=resolve);
 const w=frame.contentWindow;await until(()=>w.__acceptanceLoad&&w.__viewerDebug);return w;
}
function empty(w,phase){
 const state=w.__viewerDebug();
 assert(state.loadState.phase===phase,'wrong import phase: '+JSON.stringify(state.loadState));
 assert(!state.name&&!state.draws&&!state.drawing&&!state.session&&!state.selected&&!state.selectedDrawId,'old model identity remains');
 assert(!w.__drawing&&!w.__drawingTest&&!w.__drawingInstalled,'old 2D API remains');
 assert(!el(w,'drawingCanvas')&&!el(w,'drawingPanel')&&!el(w,'drawingOverlay'),'old drawing DOM remains');
 assert(!el(w,'source').textContent&&el(w,'completeness').hidden,'old source/coverage remains');
 assert(el(w,'stats').textContent==='当前无预览'&&el(w,'export').disabled&&el(w,'fit').disabled,'empty preview has live actions/counts');
 assert(!el(w,'tree').children.length&&!el(w,'productTree')?.children.length,'old tree remains');
 assert(el(w,'partialOffer').hidden,'stale partial-preview offer remains');
 return {phase,name:el(w,'filename').textContent,stats:el(w,'stats').textContent,sourceCleared:true,drawingCleared:true,actionsDisabled:true};
}
async function lifecycle(){
 const env=await(await fetch('/api/sample?id=dxf_byblock')).json();assert(!env.error,'control sample failed');
 const w=await fresh(true),load=w.__acceptanceLoad;
 await load(async()=>structuredClone(env),{name:'valid-control.dxf'});
 assert(w.__drawing&&w.__viewerDebug().loadState.phase==='ready','valid control not ready');
 const previous=w.__viewerDebug(),previousCanvas=el(w,'drawingCanvas');
 for(const event of ['cancel','change']){
  // The file input is empty after every accepted import. These are browser
  // event controls, not a claim that the OS picker itself was automated.
  el(w,'file').dispatchEvent(new w.Event(event,{bubbles:true}));
  assert(w.__viewerDebug().loadSeq===previous.loadSeq&&el(w,'drawingCanvas')===previousCanvas,'empty/cancelled picker replaced current preview');
  report.controls.push({case:event==='cancel'?'file-input-cancel-event':'file-input-empty-change',currentPreviewPreserved:true,nativeOSPickerAutomated:false});
 }
 for(let i=0;i<2;i++){
  await load(async()=>{throw new Error('synthetic rejection');},{name:'rejected-control.dxf'});
  report.controls.push({case:i?'repeated-failure':'valid-then-failure',...empty(w,'failed')});
  assert(el(w,'error').textContent.includes('rejected-control.dxf'),'error filename missing');
 }
 let resolve;const pending=load(()=>new Promise(r=>resolve=r),{name:'delayed-control.dxf'});
 empty(w,'loading');el(w,'cancelLoad').click();
 report.controls.push({case:'cancel-ignoring-signal',...empty(w,'cancelled'),entryEnabled:!el(w,'open').disabled});
 resolve(structuredClone(env));await pending;empty(w,'cancelled');
 report.controls.push({case:'cancelled-late-success-rejected',passed:true});
 let oldResolve;const old=load(()=>new Promise(r=>oldResolve=r),{name:'old-control.dxf'});
 const newest=structuredClone(env);newest.presentation.name='new-session-control.dxf';
 await load(async()=>newest,{name:newest.presentation.name});
 oldResolve(structuredClone(env));await old;
 assert(w.__viewerDebug().name===newest.presentation.name&&!w.__viewerDebug().loading,'superseded result replaced newest');
 report.controls.push({case:'superseded-late-success-rejected',passed:true});
 let oldReject;const error=load(()=>new Promise((resolve,reject)=>oldReject=reject),{name:'old-error-control.dxf'});
 await load(async()=>structuredClone(newest),{name:newest.presentation.name});
 oldReject(new Error('obsolete error'));await error;
 assert(el(w,'error').hidden&&w.__viewerDebug().name===newest.presentation.name,'superseded error replaced newest');
 report.controls.push({case:'superseded-late-error-rejected',passed:true});
 await save();
}
function image(w){
 const canvas=el(w,'drawingCanvas'),bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
 let nonWhite=0,hash=2166136261;
 for(let i=0;i<bytes.length;i+=4){if(bytes[i]<245||bytes[i+1]<245||bytes[i+2]<245)nonWhite++;hash=Math.imul(hash^bytes[i],16777619);hash=Math.imul(hash^bytes[i+1],16777619);hash=Math.imul(hash^bytes[i+2],16777619);}
 return {nonWhitePixels:nonWhite,hash:hash>>>0};
}
function interact(w,row){
 const d=w.__drawingTest;row.image=image(w);assert(row.image.nonWhitePixels>0,'blank drawing');
 row.counts=d.counts();
 const canvas=el(w,'drawingCanvas'),box=canvas.getBoundingClientRect();
 // samplePoint is read-only; selectAt invokes the same hit-test/selection as
 // pointerup. Native file chooser/pointer checks are recorded separately.
 for(let i=0;i<d.counts().presentationParts;i++){
  const p=d.samplePoint(i);if(!p||p.x<0||p.y<0||p.x>box.width||p.y>box.height)continue;
  const hit=d.selectAt(p.x,p.y);if(hit){row.pick={drawId:hit,label:el(w,'selected').textContent};break;}
 }
 assert(row.pick,'no visible source could be picked');
 assert(!el(w,'focus').disabled,'selected source cannot be focused');
 w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));
 assert(!d.selection().length,'selection did not clear');
 const before=d.counts().visible;
 for(const check of el(w,'drawingPanel').querySelectorAll('input[type=checkbox]')){
  if(check.disabled||!check.checked)continue;
  const label=check.parentElement.textContent.trim();check.click();const hidden=d.counts().visible;check.click();
  assert(d.counts().visible===before,'layer did not restore');
  if(hidden<before){row.layer={label,before,hidden,restored:d.counts().visible};break;}
 }
 assert(row.layer,'no checked layer affected visible geometry');
}
async function corpus(){
 const fixtures=await(await fetch('/__fixtures')).json(),w=await fresh();
 for(const source of fixtures){
  const row={...source};delete row.expectedDisplay;status.textContent='Checking '+source.id;report.files.push(row);
  try{
   const raw=await(await fetch('/__fixture?id='+encodeURIComponent(source.id))).arrayBuffer();
   const transfer=new w.DataTransfer();transfer.items.add(new w.File([raw],source.file));
   const seq=w.__viewerDebug().loadSeq;el(w,'file').files=transfer.files;el(w,'file').dispatchEvent(new w.Event('change',{bubbles:true}));
   await until(()=>w.__viewerDebug().loadSeq>seq&&!w.__viewerDebug().loading);
   const debug=w.__viewerDebug();assert(!debug.error,debug.error);assert(debug.loadState.phase==='ready'&&debug.name===source.file,'wrong source installed');
   assert(el(w,'source').textContent.includes(source.sha256),'source SHA256 changed');
   assert(!el(w,'file').value,'file input not cleared for same-file reimport');
   row.coverage=el(w,'completeness').textContent;
   const expected=source.expectedDisplay;
   assert(row.coverage.includes(`几何显示：${expected.status}（${expected.withDisplayGeometry} / ${expected.sourceRecords}`),'coverage changed');
   row.display=expected;interact(w,row);row.open='passed';
   if(source.file==='qcad_flange.dxf'){
    const buttons=[...el(w,'drawingPanel').querySelectorAll('.dspaces button')];
    buttons[1].click();row.layout={space:w.__drawing.record().space,counts:w.__drawingTest.counts()};
    el(w,'drawingPanel').querySelector('.dspaces button').click();
    assert(w.__drawingTest.counts().visible===row.counts.visible,'model-space return changed visibility');row.layout.modelRestored=true;
   }
   if(source.file==='H09_blocks.dxf'){
    row.recoveryBlocks=[];
    for(const name of ['*Paper_Space28','*D138']){
     const select=el(w,'drawingPanel').querySelector('select[aria-label="恢复的块内容"]');
     const option=[...select.options].find(o=>o.textContent.startsWith(name+'（'));assert(option,'recovery block missing');
     select.value=option.value;select.dispatchEvent(new w.Event('change',{bubbles:true}));
     const block={name};interact(w,block);row.recoveryBlocks.push(block);
    }
   }
   row.pageTiming=debug.timing;
  }catch(error){row.open='failed';row.error=String(error);report.failures.push({id:source.id,error:String(error)});}
  await save();
 }
}
document.getElementById('run').onclick=async()=>{
 document.getElementById('run').disabled=true;
 try{await lifecycle();await corpus();status.textContent=JSON.stringify({complete:true,controls:report.controls.length,files:report.files.length,failures:report.failures},null,2);}
 catch(error){report.failures.push({case:'lifecycle',error:String(error)});status.textContent=String(error);}
 await save();
};
