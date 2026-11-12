// Pure helpers for the highlight gesture (unit-tested without Electron).

// A region from the renderer, in global screen points; null unless it's a sensible rectangle.
export function validRegion(r) {
  if (!r || typeof r !== 'object') return null;
  const n = (v) => Math.round(Number(v));
  const region = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
  if (!Object.values(region).every(Number.isFinite)) return null;
  if (region.width < 8 || region.height < 8) return null;
  return region;
}

// Region (screen points) -> crop rectangle in the captured thumbnail's pixels, clamped to it.
// The thumbnail can be smaller than display size × scaleFactor, so scale from its real size.
export function toCrop(region, display, thumb) {
  const sx = thumb.width / display.bounds.width;
  const sy = thumb.height / display.bounds.height;
  const x = Math.max(0, Math.round((region.x - display.bounds.x) * sx));
  const y = Math.max(0, Math.round((region.y - display.bounds.y) * sy));
  const right = Math.min(thumb.width, Math.round((region.x - display.bounds.x + region.width) * sx));
  const bottom = Math.min(thumb.height, Math.round((region.y - display.bounds.y + region.height) * sy));
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

// Longest side at most `max` pixels.
export function fitWithin({ width, height }, max = 1024) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const k = max / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}
