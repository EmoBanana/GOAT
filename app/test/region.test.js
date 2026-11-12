import assert from 'node:assert/strict';
import test from 'node:test';
import { fitWithin, toCrop, validRegion } from '../lib/region.js';

test('regions must be real rectangles of at least 8 points', () => {
  assert.deepEqual(validRegion({ x: 10.4, y: '20', width: 300, height: 200.6 }), { x: 10, y: 20, width: 300, height: 201 });
  assert.equal(validRegion({ x: 1, y: 1, width: 5, height: 100 }), null);
  assert.equal(validRegion({ x: 'a', y: 1, width: 50, height: 50 }), null);
  assert.equal(validRegion(null), null);
});

test('crops scale from points to the thumbnail pixels (Retina) and clamp to the image', () => {
  const display = { bounds: { x: 0, y: 0, width: 1710, height: 1107 } };
  const thumb = { width: 3420, height: 2214 };
  assert.deepEqual(toCrop({ x: 100, y: 50, width: 300, height: 200 }, display, thumb), { x: 200, y: 100, width: 600, height: 400 });
  assert.deepEqual(toCrop({ x: 1600, y: 1000, width: 300, height: 300 }, display, thumb), { x: 3200, y: 2000, width: 220, height: 214 });
  assert.equal(toCrop({ x: 5000, y: 5000, width: 50, height: 50 }, display, thumb), null);
  // A display that isn't at the origin, and a thumbnail smaller than full resolution.
  const right = { bounds: { x: 1710, y: 0, width: 1920, height: 1080 } };
  assert.deepEqual(toCrop({ x: 1710 + 960, y: 540, width: 192, height: 108 }, right, { width: 960, height: 540 }), { x: 480, y: 270, width: 96, height: 54 });
});

test('images are shrunk to at most 1024 px on the longest side', () => {
  assert.deepEqual(fitWithin({ width: 600, height: 400 }), { width: 600, height: 400 });
  assert.deepEqual(fitWithin({ width: 2048, height: 1000 }), { width: 1024, height: 500 });
  assert.deepEqual(fitWithin({ width: 300, height: 3000 }), { width: 102, height: 1024 });
});
