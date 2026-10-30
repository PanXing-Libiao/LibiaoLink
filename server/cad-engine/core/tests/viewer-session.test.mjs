import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewerSession} from '../../../../frontend/public/cad-viewer/core/viewer-session.js';
const create=()=>new ViewerSession([['root',null],['a','root'],['b','root'],['hidden','root']],[['root',true],['a',true],['b',true],['hidden',false]]);
test('child hiding survives parent hide/show; shared siblings remain independent',()=>{
 const s=create(),source=[...s.sourceVisibility];s.setShown('a',false);assert.equal(s.effective('a'),false);assert.equal(s.effective('b'),true);
 s.setShown('root',false);assert.equal(s.effective('b'),false);s.setShown('root',true);
 assert.equal(s.effective('a'),false);assert.equal(s.effective('b'),true);assert.deepEqual([...s.sourceVisibility],source);
});
test('isolation is a filter and reset restores original source-hidden state',()=>{
 const s=create();s.setShown('a',false);s.isolate('b');assert.equal(s.effective('a'),false);assert.equal(s.effective('b'),true);
 s.showAll();assert.equal(s.effective('hidden'),true);assert.equal(s.sourceVisibility.get('hidden'),false);
 s.reset();assert.equal(s.effective('a'),true);assert.equal(s.effective('hidden'),false);
});
test('cycles and unknown identities fail explicitly',()=>{
 assert.throws(()=>new ViewerSession([['x','x']],[]));const s=create();assert.throws(()=>s.effective('absent'));
});
test('explicitly inspect one source-hidden item without rewriting source or siblings',()=>{
 const s=create();s.setShown('a',false);s.setShown('hidden',true);
 assert.equal(s.effective('hidden'),true);assert.equal(s.sourceVisibility.get('hidden'),false);assert.equal(s.effective('a'),false);
 s.reset();assert.equal(s.effective('hidden'),false);
});
test('indexed isolation preserves ancestors, descendants, and source gates after file replacement',()=>{
 const first=new ViewerSession([['r',null],['p','r'],['leaf','p'],['sibling','r']],[['r',true],['p',false],['leaf',true],['sibling',true]]);
 first.isolate('leaf');assert.deepEqual(new Set(first.record().isolation),new Set(['r','p','leaf']));assert.equal(first.effective('leaf'),false);
 first.setShown('p',true);assert.equal(first.effective('leaf'),true);assert.equal(first.effective('sibling'),false);
 first.reset();assert.equal(first.effective('p'),false);assert.equal(first.effective('sibling'),true);
 const second=new ViewerSession([['other',null]],[['other',true]]);assert.equal(second.isolation,null);assert.equal(second.effective('other'),true);assert.throws(()=>second.isolate('leaf'));
});
