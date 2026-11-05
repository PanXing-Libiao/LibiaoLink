// Pure display-range validation shared by the canvas viewer and node tests.
// Non-indexed line geometry stores consecutive vertex pairs. A range that cannot
// be paired must never fall through to the single-point path.
export function normalizeLineRange(range, vertexCount) {
  const available = Number.isSafeInteger(vertexCount) && vertexCount > 0 ? vertexCount : 0;
  let first = 0, count = available;
  if (range !== undefined && range !== null) {
    if (!Number.isSafeInteger(range.first) || !Number.isSafeInteger(range.count)) return null;
    first = range.first;
    count = range.count;
  }
  if (!available || first < 0 || count < 0 || count % 2 !== 0 || first + count > available) return null;
  return { first, count };
}
