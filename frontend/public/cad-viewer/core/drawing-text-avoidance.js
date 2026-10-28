// Display-only annotation decluttering. Source text anchors and UCD records are
// never changed: this module only chooses a new anchor for the painted glyphs
// and returns the offset so the viewer can draw a leader back to the source.
const EPSILON = 1e-9;

export function translateBox(box, dx, dy) {
  return {minX: box.minX + dx, minY: box.minY + dy,
    maxX: box.maxX + dx, maxY: box.maxY + dy};
}

export function boxesOverlap(a, b) {
  return a.minX < b.maxX - EPSILON && a.maxX > b.minX + EPSILON
    && a.minY < b.maxY - EPSILON && a.maxY > b.minY + EPSILON;
}

function boxArea(box) {
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function boxKey(box, dx, dy) {
  return [dx, dy].map(value => Math.round(value * 1e6) / 1e6).join(',');
}

function candidateShifts(box, placed, gap) {
  const shifts = [{dx: 0, dy: 0}];
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  for (const other of placed) {
    if (!boxesOverlap(box, other)) continue;
    shifts.push(
      {dx: other.maxX + gap - box.minX, dy: 0},
      {dx: other.minX - gap - box.maxX, dy: 0},
      {dx: 0, dy: other.maxY + gap - box.minY},
      {dx: 0, dy: other.minY - gap - box.maxY},
    );
  }
  // A second ring handles the common case where the nearest edge is blocked
  // by another annotation, without searching the whole drawing.
  for (const factor of [0.5, 1, 1.5, 2]) {
    const sx = Math.max(width * factor, gap || 1);
    const sy = Math.max(height * factor, gap || 1);
    shifts.push({dx: sx, dy: 0}, {dx: -sx, dy: 0}, {dx: 0, dy: sy}, {dx: 0, dy: -sy},
      {dx: sx, dy: sy}, {dx: sx, dy: -sy}, {dx: -sx, dy: sy}, {dx: -sx, dy: -sy});
  }
  const seen = new Set();
  return shifts
    .map(shift => ({...shift, distance: Math.hypot(shift.dx, shift.dy)}))
    .filter(shift => {
      if (shift.distance <= EPSILON) return false;
      const key = boxKey(box, shift.dx, shift.dy);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Resolve axis-aligned display boxes in deterministic, largest-first order.
 * The largest box keeps its source position; smaller overlapping boxes move to
 * the nearest free edge. Items that cannot be placed within `maxShift` keep
 * their source position rather than being moved arbitrarily.
 */
export function resolveTextAvoidance(items, {gap = 0, maxShift = Infinity} = {}) {
  const resolved = new Map();
  const placed = [];
  const ordered = items
    .map((item, order) => ({...item, order}))
    .sort((a, b) => boxArea(b.box) - boxArea(a.box) || a.order - b.order);

  for (const item of ordered) {
    const source = item.box;
    let choice = {dx: 0, dy: 0, box: source};
    if (placed.some(other => boxesOverlap(source, other))) {
      for (const shift of candidateShifts(source, placed, gap)) {
        if (shift.distance > maxShift) continue;
        const box = translateBox(source, shift.dx, shift.dy);
        if (!placed.some(other => boxesOverlap(box, other))) {
          choice = {dx: shift.dx, dy: shift.dy, box};
          break;
        }
      }
    }
    placed.push(choice.box);
    resolved.set(item.id, choice);
  }
  return resolved;
}
