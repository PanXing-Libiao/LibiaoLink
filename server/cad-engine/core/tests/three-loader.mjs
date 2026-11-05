// Test-only resolution of the browser import-map entry; no package installation/build.
export async function resolve(specifier,context,nextResolve){
 if(specifier==='three')return {url:new URL('../../../../frontend/public/cad-viewer/core/vendor/three.module.js',import.meta.url).href,shortCircuit:true};
 return nextResolve(specifier,context);
}
