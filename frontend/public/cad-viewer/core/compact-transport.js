/** Lossless wire dictionary. Expand full canonical IDs before any viewer consumer. */
const fields=['occurrenceId','bindingId','primitiveId','membership','availability','suppression','visibility','materialId'];
export function unpackMetadata(envelope){
 if(envelope.transportProfile!=='ucd-binary-compact/1')return envelope;
 const table=envelope.drawTable,strings=table?.strings;
 if(table?.version!=='draw-index-table/1'||!Array.isArray(strings)||strings.some(s=>typeof s!=='string')||new Set(strings).size!==strings.length)throw new Error('Invalid draw dictionary');
 if(Object.keys(envelope.document.renderOwnership).length||Object.keys(envelope.snapshot.draws).length)throw new Error('Ambiguous compact draw maps');
 if(!Array.isArray(table.rows)||!Array.isArray(table.ownershipRemainder))throw new Error('Invalid draw table');
 const value=i=>{if(!Number.isSafeInteger(i)||i<0||i>=strings.length)throw new Error('Draw dictionary index out of range');return strings[i];};
 const draws=Object.create(null),owners=Object.create(null);
 for(const row of table.rows){
  if(!Array.isArray(row)||row.length!==10)throw new Error('Invalid compact draw row');
  const did=value(row[0]);if(Object.hasOwn(draws,did))throw new Error('Duplicate compact draw');
  const draw={};fields.forEach((key,i)=>{draw[key]=value(row[i+1]);});draws[did]=draw;
  if(row[9]!==-1)owners[did]=row[9]===null?null:value(row[9]);
 }
 for(const pair of table.ownershipRemainder){
  if(!Array.isArray(pair)||pair.length!==2)throw new Error('Invalid compact owner row');
  const did=value(pair[0]);if(Object.hasOwn(draws,did)||Object.hasOwn(owners,did))throw new Error('Duplicate compact owner');
  owners[did]=pair[1]===null?null:value(pair[1]);
 }
 const {drawTable,...rest}=envelope;
 return {...rest,transportProfile:'ucd-binary-manifest/1',document:{...envelope.document,renderOwnership:owners},snapshot:{...envelope.snapshot,draws}};
}
