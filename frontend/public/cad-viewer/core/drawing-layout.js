// Layout contract: one place decides which viewports participate in a layout,
// in which order the paper/viewport spaces are walked, and which spaces carry
// paper/model transforms. Renderers consume the resulting draws; they do not
// re-filter viewport ids or re-order paper space.
export function layoutViewports(document, layoutId) {
  const drawing = document && document.drawing;
  const layout = drawing && drawing.layouts && drawing.layouts[layoutId];
  if (!layout) return [];
  return (layout.viewportIds || [])
    .map(id => drawing.viewports && drawing.viewports[id])
    .filter(viewport => viewport && viewport.enabled);
}

export function layoutSpacePlan(document, layoutId) {
  const drawing = document && document.drawing;
  const layout = drawing && drawing.layouts && drawing.layouts[layoutId];
  if (!layout) return null;
  return {
    layoutId,
    paperSpaceId: layout.paperSpaceId,
    viewports: layoutViewports(document, layoutId)
  };
}
