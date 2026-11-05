// Screen appearance from the adapter's resolved source CTB/STB pens.
// Physical printer halftoning and PC3 drivers are outside this screen preview.
export function plotAppearance(style, pen) {
  if (!pen) return style;
  if (pen.status !== 'ready') throw new Error(pen.reason || '打印样式不可用');
  const source = pen.style, rgb = source.color || style.color.slice(0, 3).map(v => v * 255);
  let color = rgb;
  if (source.grayscale) {
    const gray = Math.round(.3 * rgb[0] + .59 * rgb[1] + .11 * rgb[2]);
    color = [gray, gray, gray];
  }
  color = color.map(v => (255 - (255 - v) * source.screening / 100) / 255);
  return {...style, color:[...color, 1],
    ...(source.lineWeightMm !== null ? {lineWeight:{...style.lineWeight, value:source.lineWeightMm}} : {})};
}

export function plotParts(part, selected, pen, context, drawId) {
  if (!pen || pen.style.lineType === 31) return selected || [part];
  if (pen.style.lineType === 0 || !part.patternedStroke && !part.patternContinuation) return [part];
  const variant = part.plotVariants?.[context]?.[drawId];
  if (!variant || variant.status !== 'ready') throw new Error(variant?.reason || '打印线型显示几何不可用');
  return variant.parts;
}

export function fillTile(code, color) {
  if (code === 64 || code === 73) return null;
  // Selective adaptation of pinned truedxf plot/fill-style.ts (MIT).
  // Raster-driver device pixels, anchored at the printable area's lower-left.
  const size=[67,69,70].includes(code)?20:10;
  const tile = document.createElement('canvas'); tile.width = tile.height = size;
  const ctx = tile.getContext('2d');
  ctx.fillStyle = '#fff';ctx.fillRect(0,0,size,size);ctx.fillStyle=color;
  for(let row=0;row<size;row++)for(let x=0;x<size;x++) {
    const y=size-1-row,a=x%10,b=y%10;
    const ink=code===65?a<=4&&b<=4&&(a===0||a===4||b===0||b===4):
      code===66?a===0||b===0:code===67?(x+y)%20===0||(x-y+20)%20===0:
      code===68?b===0:code===69?(x+y)%20===0:code===70?(x-y+20)%20===0:
      code===71?a<=1&&b<=1:code===72?a===0:true;
    if(ink)ctx.fillRect(x,row,1,1);
  }
  return tile;
}
