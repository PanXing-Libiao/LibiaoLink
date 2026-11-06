import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEXT_FONT, layoutAnnotationText, layoutTextRun, textOffsets, textWorldBox, textWorldCorners, textDisplayBox
} from '../../../../frontend/public/cad-viewer/core/drawing-text.js';

const IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const measure = text => String(text).length * 50;
const annotation = (extra = {}) => ({
  kind:'text', text:'AB', position:[10,20,0], direction:[1,0,0],
  semantic:{height:{value:2.5}, halign:{value:0}, valign:{value:0}, attachmentPoint:{value:1}},
  ...extra
});
const draw = (matrix = IDENTITY) => ({localToSpace:matrix});

test('raw text uses one measured line and the published 1.25 line box', () => {
  const {anchor, run} = layoutAnnotationText(annotation(), draw(), {measure});
  assert.deepEqual(anchor, [10,20]);
  assert.equal(TEXT_FONT.includes('sans-serif'), true);
  assert.equal(run.angle, 0);
  assert.equal(run.size, 2.5);
  assert.deepEqual(run.lines, ['AB']);
  assert.deepEqual(run.widths, [2.5]);
  assert.equal(run.width, 2.5);
  assert.equal(run.height, 3.125);
  assert.deepEqual(run.offsets, {dx:0, dy:0});
  assert.deepEqual(run.box, {minX:10, minY:16.875, maxX:12.5, maxY:20});
  assert.deepEqual(run.approximations, ['substituted-font','canvas-text-layout']);
  assert.equal(run.layout, 'canvas');
});

test('rotation follows the annotation direction and keeps the box in world space', () => {
  const {run} = layoutAnnotationText(annotation({direction:[0,1,0]}), draw(), {measure});
  assert.ok(Math.abs(run.angle - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(run.box.minX - 10) < 1e-9);
  assert.ok(Math.abs(run.box.maxX - 13.125) < 1e-9);
  assert.ok(Math.abs(run.box.minY - 20) < 1e-9);
  assert.ok(Math.abs(run.box.maxY - 22.5) < 1e-9);
});

test('native CAD layout without font metrics retains its legacy em sizing', () => {
  const native = layoutAnnotationText(annotation({
    text:'ABCD EFGH', semantic:{height:{value:2.5}, lineSpacing:{value:1}, rectangleWidth:{value:10},
      halign:{value:0}, valign:{value:0}, attachmentPoint:{value:1}}
  }), draw(), {measure, nativeLayout:true}).run;
  assert.equal(native.nativeLayout, true);
  assert.equal(native.layout, 'cad-em');
  assert.ok(Math.abs(native.size - 2.5) < 1e-12);
  assert.ok(Math.abs(native.lineHeight - 2.5 * 5 / 3) < 1e-12);
  assert.deepEqual(native.lines, ['ABCD','EFGH']);
  assert.ok(Math.abs(native.width - 4 * 50 * native.size / 100) < 1e-12);
  assert.ok(Math.abs(native.height - native.size) < 1e-12);
  assert.ok(Math.abs(native.box.maxY - 20) < 1e-9);
  assert.ok(Math.abs(native.box.minY - (20 - native.size)) < 1e-9);
  assert.deepEqual(native.approximations, ['substituted-font','cad-em-layout']);
});

test('native multi-line text keeps one-line metrics instead of multiplying by line count', () => {
  const native = layoutAnnotationText(annotation({
    text:'AB\nCD\nEF', semantic:{height:{value:2.5}, lineSpacing:{value:1}, rectangleWidth:{value:10},
      halign:{value:0}, valign:{value:0}, attachmentPoint:{value:1}}
  }), draw(), {measure, nativeLayout:true}).run;
  assert.equal(native.size, 2.5);
  assert.equal(native.lineHeight, 2.5 * 5 / 3);
  assert.deepEqual(native.lines, ['AB','CD','EF']);
  assert.ok(Math.abs(native.height - native.size) < 1e-12);
});

test('native CJK text can break between glyphs to honour rectangleWidth', () => {
  const native = layoutAnnotationText(annotation({
    text:'这是很长的中文注释', semantic:{height:{value:2.5}, lineSpacing:{value:1}, rectangleWidth:{value:10},
      halign:{value:0}, valign:{value:0}, attachmentPoint:{value:1}}
  }), draw(), {measure, nativeLayout:true}).run;
  assert.ok(native.lines.length > 1);
  assert.ok(native.widths.every((width) => width <= 10 + 1e-12));
});

test('display box includes every painted line, not just the em box', () => {
  const run = {
    x: 0, y: 0, angle: 0, size: 2, height: 2, width: 10, lineHeight: 3,
    kind: 'text', halign: 0, valign: 0, attachment: 1,
    text: 'A\nB\nC', lines: ['A', 'B', 'C'], widths: [10, 10, 10],
  };
  assert.deepEqual(textDisplayBox(run), {minX: 0, minY: -8, maxX: 10, maxY: 0});
});

test('MTEXT attachment and TEXT alignment offsets are shared helpers', () => {
  const mtext = {kind:'mtext', width:10, size:2.5, attachment:5};
  assert.deepEqual(textOffsets(mtext), {dx:-5, dy:0.875});
  assert.deepEqual(textOffsets({kind:'mtext', width:10, size:2.5, attachment:2}), {dx:-5, dy:2.5});
  assert.deepEqual(textOffsets({kind:'text', width:10, size:2.5, halign:1, valign:3}), {dx:-5, dy:2.5});
  assert.deepEqual(textOffsets({kind:'text', width:10, size:2.5, halign:2, valign:2}), {dx:-10, dy:0.875});
  const box = textWorldBox({x:0, y:0, angle:0, width:10, height:2.5}, {dx:-5, dy:0});
  assert.deepEqual(box, {minX:-5, minY:-2.5, maxX:5, maxY:0});
  assert.deepEqual(textWorldCorners({x:0, y:0, angle:0, width:10, height:2.5}, {dx:0, dy:0}),
    [[0,0],[10,0],[10,-2.5],[0,-2.5]]);
});

test('empty and dimension annotations keep their anchor but allocate no text run', () => {
  const empty = layoutAnnotationText(annotation({text:''}), draw(), {measure});
  assert.deepEqual(empty.anchor, [10,20]);
  assert.equal(empty.run, null);
  const dimension = layoutAnnotationText(annotation({kind:'dimension'}), draw(), {measure});
  assert.deepEqual(dimension.anchor, [10,20]);
  assert.equal(dimension.run, null);
});

test('a missing font metric callback is an explicit failure, not a zero-width guess', () => {
  assert.throws(() => layoutTextRun({text:'A', x:0, y:0, angle:0, height:2.5}),
    /text-measure-required/);
});


test('native wrapping uses measured cap height while source line spacing stays unchanged', () => {
  const input = {text:'甲乙丙丁', kind:'mtext', x:0, y:0, angle:0, height:10,
    nativeLayout:true, rectangleWidth:32, measure:text=>text.length*100,
    measureCapHeight:()=>72};
  const run = layoutTextRun(input);
  assert.deepEqual(run.lines, ['甲乙', '丙丁']);
  assert.ok(Math.abs(run.size*0.72-10)<1e-12);
  assert.equal(run.lineHeight,10*5/3);
  const largerCap = layoutTextRun({...input,measureCapHeight:()=>100});
  assert.deepEqual(largerCap.lines,['甲乙丙','丁']);
  assert.equal(largerCap.lineHeight,run.lineHeight);
});

test('inline font changes use their own cap metrics without inflating line spacing', () => {
  const run = layoutTextRun({text:'',kind:'mtext',x:0,y:0,angle:0,height:10,
    nativeLayout:true,fontFamily:'A',measure:text=>text.length*50,
    measureCapHeight:font=>font==='B'?80:50,
    runs:[{text:'AB',fontFamily:'A'},{text:'CD',fontFamily:'B'}]});
  assert.deepEqual(run.runLines[0].segments.map(s=>s.size),[20,12.5]);
  assert.equal(run.runLines[0].advance,10*5/3);
  assert.equal(run.width,32.5);
});


test('an overlong number keeps its source paragraph without an extra empty line', () => {
  const run=layoutTextRun({text:'2480\n1000',kind:'mtext',x:0,y:0,angle:0,height:10,
    nativeLayout:true,rectangleWidth:5,measure:text=>text.length*50,measureCapHeight:()=>72});
  assert.deepEqual(run.lines,['2480','1000']);
});
