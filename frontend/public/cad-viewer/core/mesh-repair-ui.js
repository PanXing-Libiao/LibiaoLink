/** Explicit display approximations, separate from omitted source faces. */
export function repairManifest(envelope){
 const d=envelope.document,faces=d.extensions?.['org.cad-preview.completeness/1']?.categories?.meshRepairs||[];
 return {format:'cad-step-display-repairs/1',documentId:d.documentId,documentRevision:d.revision,sources:d.sources,
  count:faces.length,notice:'这些面使用显示近似修复；面积和体积仍按源面及已声明的排除范围统计。',faces};
}
export function appendMeshRepairUI(box,envelope,info,focus){
 const manifest=repairManifest(envelope);if(!manifest.count)return;
 box.classList.add('has-repairs');box.setAttribute('role','region');box.setAttribute('aria-label','几何修复与缺失说明');
 const details=document.createElement('details');details.id='meshRepairDetails';
 const summary=document.createElement('summary');summary.textContent=`查看 ${manifest.count} 个显示修复面的明细`;
 const note=document.createElement('p');note.textContent=manifest.notice;
 const exportButton=document.createElement('button');exportButton.id='exportMeshRepairs';exportButton.type='button';exportButton.textContent='导出修复清单（JSON）';
 exportButton.onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=(info.name||'STEP').replace(/\.(step|stp)$/i,'')+'.display-repairs.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 const scroll=document.createElement('div');scroll.className='nonmeshable-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','显示修复面明细表，可横向滚动');
 const table=document.createElement('table'),caption=document.createElement('caption');caption.textContent='面号从0开始；误差是实际显示网格的检查记录。';table.append(caption);
 const head=document.createElement('thead'),header=document.createElement('tr');
 for(const text of ['产品 / 定义位置','源面号','显示处理','源面积（mm²）','网格面积（mm²）','面积差（mm²）/ 相对差','抽查偏差（mm）','操作']){
  const cell=document.createElement('th');cell.scope='col';cell.textContent=text;header.append(cell);
 }
 head.append(header);table.append(head);const body=document.createElement('tbody');
 const number=x=>Number.isFinite(x)?Number(x).toPrecision(6):'未记录';
 const methods={'pcurve-region-fallback':'源边界重采样','closed-face-native-remesh':'闭合曲面分片','independent-gmsh-source-face':'独立网格与原曲面取点'};
 for(const face of manifest.faces){
  const check=face.validation?.float32AreaCheck||face.validation?.areaCheck||{},row=document.createElement('tr');
  const values=[`${face.productName}\n${face.entry}`,face.face,methods[face.reason]||'显示修复',number(check.sourceAreaMM2),number(check.meshAreaMM2??face.areaMM2),`${number(check.absoluteErrorMM2)} / ${number((check.relativeError??Math.abs(face.areaRatio-1))*100)}%`,number(face.maxDeviationMM)];
  for(const value of values){const cell=document.createElement('td');cell.textContent=String(value);row.append(cell);}
  const cell=document.createElement('td'),button=document.createElement('button');button.type='button';button.textContent='定位面';button.setAttribute('aria-label',`定位 ${face.productName} 的源面 ${face.face}`);
  button.onclick=()=>{
   if(!focus(face)){note.textContent='该面当前不可见，请先恢复对应零件的显示。';return;}
   note.textContent=manifest.notice;document.getElementById('viewport').scrollIntoView({block:'center'});
  };cell.append(button);row.append(cell);body.append(row);
 }
 table.append(body);scroll.append(table);details.append(summary,note,exportButton,scroll);box.append(details);
 let top=document.getElementById('nonMeshableTopNotice');
 if(!top){top=document.createElement('div');top.id='meshRepairTopNotice';top.className='nonmeshable-top';top.setAttribute('role','status');document.getElementById('viewport').before(top);}
 const message=document.createElement('p');message.id='meshRepairNotice';message.textContent=`本文件有 ${manifest.count} 个面已进行显示修复`;
 const show=document.createElement('button');show.type='button';show.textContent='查看修复明细';show.onclick=()=>{details.open=true;details.scrollIntoView({block:'center'});summary.focus({preventScroll:true});};
 top.append(message,show);
}
