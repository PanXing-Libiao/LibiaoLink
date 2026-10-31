// Capture native Path2D commands without changing their on-screen execution.
const NativePath=globalThis.Path2D;
export const pathRecords=new WeakMap();
const methods=['moveTo','lineTo','closePath','rect','arc','arcTo','bezierCurveTo','quadraticCurveTo','ellipse','roundRect'];
export class RecordedPath extends NativePath {
 constructor(source){
  super(source);
  pathRecords.set(this,{source:source instanceof NativePath?source:null,svg:typeof source==='string'?source:null,commands:[]});
 }
 addPath(path,transform){
  if(transform===undefined)super.addPath(path);else super.addPath(path,transform);
  pathRecords.get(this).commands.push(['addPath',path,transform?{a:transform.a,b:transform.b,c:transform.c,d:transform.d,e:transform.e,f:transform.f}:null]);
 }
}
for(const name of methods)RecordedPath.prototype[name]=function(...args){NativePath.prototype[name].apply(this,args);pathRecords.get(this).commands.push([name,...args]);};
globalThis.Path2D=RecordedPath;
