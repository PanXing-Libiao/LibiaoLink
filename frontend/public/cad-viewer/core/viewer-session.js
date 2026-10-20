/** User viewing policy. Source snapshot is immutable; this does not model native CAD locks. */
export class ViewerSession {
  constructor(parents, sourceVisibility, productParents=[]) {
    this.productParents=new Map(productParents);this.hiddenProducts=new Set();this.parents=new Map(parents);this.sourceVisibility=new Map(sourceVisibility);
    this.children=new Map();
    for(const [id,parent] of this.parents){if(!this.children.has(parent))this.children.set(parent,[]);this.children.get(parent).push(id);}
    this.hidden=new Set();this.revealed=new Set();this.isolation=null;this.revealSourceHidden=false;
    for(const id of this.parents.keys()){
      const seen=new Set();let p=id;
      while(p!==null){if(seen.has(p)||!this.parents.has(p))throw new Error('场景父链无效');seen.add(p);p=this.parents.get(p);}
    }
  }
  setProductShown(id,shown){if(!this.productParents.has(id))throw new Error('未知产品实例');if(shown)this.hiddenProducts.delete(id);else this.hiddenProducts.add(id);}
  productEffective(id){const seen=new Set();for(let p=id;p!=null;p=this.productParents.get(p)){if(seen.has(p)||!this.productParents.has(p))throw new Error('产品父链无效');seen.add(p);if(this.hiddenProducts.has(p))return false;}return true;}
  setShown(id,shown){if(!this.parents.has(id))throw new Error('未知场景实例');if(shown){this.hidden.delete(id);if(!this.sourceShown(id))this.revealed.add(id);}else this.hidden.add(id);}
  sourceShown(id){return this.sourceVisibility.get(id)!==false;}
  localShown(id){if(!this.parents.has(id))throw new Error('未知场景实例');return !this.hidden.has(id)&&(this.sourceShown(id)||this.revealSourceHidden||this.revealed.has(id))&&(this.isolation===null||this.isolation.has(id));}
  effective(id){for(let p=id;p!==null;p=this.parents.get(p))if(!this.localShown(p))return false;return true;}
  isolate(id){
    if(!this.parents.has(id))throw new Error('未知场景实例');
    const allowed=new Set();
    const stack=[id];
    while(stack.length){const key=stack.pop();allowed.add(key);for(const child of this.children.get(key)||[])stack.push(child);}
    for(let p=id;p!==null;p=this.parents.get(p))allowed.add(p);
    this.isolation=allowed;
  }
  showAll(){this.hiddenProducts.clear();this.hidden.clear();this.isolation=null;this.revealSourceHidden=true;}
  reset(){this.hiddenProducts.clear();this.hidden.clear();this.revealed.clear();this.isolation=null;this.revealSourceHidden=false;}
  record(){return {hiddenProducts:[...this.hiddenProducts],hidden:[...this.hidden],revealed:[...this.revealed],isolation:this.isolation===null?null:[...this.isolation],revealSourceHidden:this.revealSourceHidden};}
}
