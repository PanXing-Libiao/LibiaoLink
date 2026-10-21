/** Display an explicitly accepted omission; never generate replacement geometry. */
export function missingFaceManifest(envelope){
 const d=envelope.document,c=d.extensions?.['org.cad-preview.completeness/1'];
 const faces=c?.categories?.nonMeshableFaces||[];
 return {format:'cad-step-nonmeshable-faces/1',acceptancePolicy:c?.acceptancePolicy,
  documentId:d.documentId,documentRevision:d.revision,sources:d.sources,
  count:faces.length,countScope:'source faces per product definition; instances not multiplied',
  notice:'未显示面不参与拾取和面积/体积统计；受影响零件的体积及体积质心不可用。',faces};
}

export function appendNonMeshableUI(box,envelope,info){
 const manifest=missingFaceManifest(envelope);
 if(!manifest.count)return;
 box.setAttribute('role','region');box.setAttribute('aria-label','未显示的源面');
 const message=document.createElement('p');message.id='nonMeshableNotice';
 message.textContent=`本文件有 ${manifest.count} 个零面积/不可网格化面未显示`;
 const policy=document.createElement('p');policy.textContent=manifest.notice;
 const button=document.createElement('button');button.id='exportMissingFaces';button.type='button';button.textContent='导出缺失清单（JSON）';
 button.onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(manifest,null,2)],{type:'application/json;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=(info.name||'STEP').replace(/\.(step|stp)$/i,'')+'.missing-faces.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 const details=document.createElement('details');details.id='nonMeshableDetails';
 const summary=document.createElement('summary');summary.textContent=`查看 ${manifest.count} 个未显示面的明细`;
 const scroll=document.createElement('div');scroll.className='nonmeshable-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','未显示面明细表，可横向滚动');
 const table=document.createElement('table'),caption=document.createElement('caption');
 caption.textContent='按源产品定义去重；面号从0开始；闭合状态分别列出源面和边界。';table.append(caption);
 const head=document.createElement('thead'),header=document.createElement('tr');
 for(const label of ['产品 / XCAF entry','源面号','曲面类型','面积（mm²）','bbox（米，局部坐标）','有效 / 边界与闭合','容差（mm）','分类 / 命中判据']){
  const cell=document.createElement('th');cell.scope='col';cell.textContent=label;header.append(cell);
 }
 head.append(header);table.append(head);const body=document.createElement('tbody');
 const yes=value=>value==null?'未知':value?'是':'否';
 for(const face of manifest.faces){
  const row=document.createElement('tr');
  const values=[`${face.productName}\n${face.entry}`,face.face,face.surface,face.areaMM2,
   face.bboxM?`min: ${face.bboxM.min.join(', ')}\nmax: ${face.bboxM.max.join(', ')}\n对角线: ${face.bboxM.diagonal}`:'不可用',
   `有效：${yes(face.valid)}\n边界数：${face.wireCount}\n面闭合：${yes(face.closed)}\n边界闭合：${face.wiresClosed.map(yes).join(' / ')}`,
   face.faceToleranceMM,`${face.classification}\n${face.criterion}`];
  for(const value of values){const cell=document.createElement('td');cell.textContent=value==null?'不可用':String(value);row.append(cell);}
  body.append(row);
 }
 table.append(body);scroll.append(table);details.append(summary,scroll);box.append(policy,button,details);
 // Keep the omission count in the initial viewport, even when the detailed
 // completeness panel falls below the model and interaction controls.
 const top=document.createElement('div');top.id='nonMeshableTopNotice';top.className='nonmeshable-top';top.setAttribute('role','status');
 const show=document.createElement('button');show.type='button';show.textContent='查看缺失清单';
 show.onclick=()=>{details.open=true;details.scrollIntoView({block:'center'});summary.focus({preventScroll:true});};
 top.append(message,show);document.getElementById('viewport').before(top);
}

export function clearNonMeshableUI(){document.getElementById('nonMeshableTopNotice')?.remove();document.getElementById('meshRepairTopNotice')?.remove();}
