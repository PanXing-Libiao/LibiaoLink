/** Browser-observed durations, not native execution timings. No file names or URLs. */
export class LoadPhases {
 constructor(now=()=>performance.now()) {this.now=now;this.started=now();this.changed=this.started;this.current=null;this.elapsed={};}
 phase(name) {
  const at=this.now();
  if(this.current!==null)this.elapsed[this.current]=(this.elapsed[this.current]||0)+at-this.changed;
  this.current=name;this.changed=at;
 }
 snapshot() {
  const at=this.now(),durations={...this.elapsed};
  if(this.current!==null)durations[this.current]=(durations[this.current]||0)+at-this.changed;
  return {basis:'browser-observed',totalMS:at-this.started,durationsMS:durations};
 }
}
