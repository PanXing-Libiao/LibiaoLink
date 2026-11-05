// Media contract: image placement, pixel size, resource identity, opacity and
// bounds in the draw's local space. The renderer owns decoding and Canvas
// drawing; it does not re-read geometry.imageToEntity or decide media identity.
// Source-side image clipping is baked into the published PNG by dxf_media, so
// imageToEntity placement is the only runtime transform.
function apply(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[12], m[1] * p[0] + m[5] * p[1] + m[13]];
}
function apply3(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]];
}

export function mediaItemFor(document, itemId) {
  return document?.extensions?.['org.cad-preview.dxf-media/1']?.items?.[itemId] || null;
}

export function imagePlacement(entity, draw) {
  const geometry = entity && entity.geometry;
  if (!geometry || geometry.type !== 'image') return null;
  const pixel = geometry.pixelSize;
  if (!Array.isArray(pixel) || !(pixel[0] > 0) || !(pixel[1] > 0)) return null;
  if (!Array.isArray(geometry.imageToEntity) || geometry.imageToEntity.length !== 16) return null;
  const matrix = draw.localToSpace;
  if (!Array.isArray(matrix) || matrix.length !== 16 || matrix.some(value => !Number.isFinite(value))) return null;
  const [w, h] = pixel;
  const point = (x, y) => apply(matrix, apply3(geometry.imageToEntity, [x, y, 0]));
  const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => point(x, y));
  const bbox = {
    minX: Math.min(...corners.map(point => point[0])),
    minY: Math.min(...corners.map(point => point[1])),
    maxX: Math.max(...corners.map(point => point[0])),
    maxY: Math.max(...corners.map(point => point[1]))
  };
  return {resourceId: geometry.resourceId, pixelSize: [w, h], corners, bbox};
}

export function rasterRecord(entity, draw, mediaItem = null) {
  const placement = imagePlacement(entity, draw);
  if (!placement) return null;
  return {
    ...placement,
    w: placement.pixelSize[0], h: placement.pixelSize[1],
    opacity: Number(draw.style?.opacity ?? 1),
    mediaStatus: mediaItem?.status || null,
    sourceKind: mediaItem?.sourceKind || entity.geometry.sourceType || 'IMAGE'
  };
}
