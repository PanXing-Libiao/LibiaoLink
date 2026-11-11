// Exact parameters for the ordinary native curves omitted from a temporary DWG view.
// The worker transfers numeric columns. The canvas resolves individual handles on demand.
const widths = {line:6, arc:21};

export function archiveCurves(doc) {
  const rows = {line:[], arc:[]}, native = doc.extensions['org.libiaolink.dwg/1'].nativeGeometry;
  function add(key,g) {
    if (!(g.type === 'line' || (g.type === 'arc' && native[key]?.type === 'arc')) ||
        !/^entity-[0-9A-F]{1,16}$/.test(key)) return;
    rows[g.type].push([BigInt('0x'+key.slice(7)), g, native[key]]);
  }
  for (const r of doc.packed.entities) add(doc.packed.strings[r[0]],r[12]);
  for (const [key,e] of Object.entries(doc.drawing.entities)) add(key,e.geometry);
  const tables = {};
  for (const [type,items] of Object.entries(rows)) {
    items.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    const handles=new BigUint64Array(items.length), values=new Float64Array(items.length*widths[type]);
    items.forEach(([handle,g,n],i)=>{
      handles[i]=handle;
      values.set(type==='line' ? [...g.start,...g.end] :
        [...g.center,...g.normal,...g.xAxis,g.radius,g.startAngle,g.sweepAngle,
         ...n.center,...n.normal,n.radius,n.startAngle,n.endAngle],i*widths[type]);
    });
    tables[type]={handles,values};
  }
  return tables;
}

export function restoreCurve(tables,entity,native) {
  if (!tables || !entity?.geometry?.displayOnly) return;
  const type=entity.geometry.type, {handles,values}=tables[type];
  const handle=BigInt('0x'+entity.sourceRefs[0].objectKey);
  let lo=0,hi=handles.length;
  while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(handles[mid]<handle)lo=mid+1;else hi=mid;}
  if(handles[lo]!==handle)return;
  const i=lo*widths[type],xyz=k=>[values[i+k],values[i+k+1],values[i+k+2]];
  if(type==='line') entity.geometry={type,start:xyz(0),end:xyz(3)};
  else {
    entity.geometry={type,center:xyz(0),normal:xyz(3),xAxis:xyz(6),radius:values[i+9],startAngle:values[i+10],sweepAngle:values[i+11]};
    native[entity.id]={type,center:xyz(12),normal:xyz(15),radius:values[i+18],startAngle:values[i+19],endAngle:values[i+20]};
  }
}
