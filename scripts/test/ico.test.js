import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ICO_SIZES, icoFromPngs } from '../lib/ico.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fakePng = (n) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(n, 7)]);

test('an .ico lists each PNG with its size, length and offset', () => {
  const images = [
    { size: 16, png: fakePng(10) },
    { size: 32, png: fakePng(20) },
    { size: 256, png: fakePng(30) },
  ];
  const ico = icoFromPngs(images);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 is an icon');
  assert.equal(ico.readUInt16LE(4), 3);
  let expectedOffset = 6 + 16 * 3;
  images.forEach(({ size, png }, i) => {
    const at = 6 + i * 16;
    assert.equal(ico.readUInt8(at), size === 256 ? 0 : size, 'width');
    assert.equal(ico.readUInt8(at + 1), size === 256 ? 0 : size, 'height');
    assert.equal(ico.readUInt16LE(at + 4), 1, 'planes');
    assert.equal(ico.readUInt16LE(at + 6), 32, 'bits per pixel');
    assert.equal(ico.readUInt32LE(at + 8), png.length);
    assert.equal(ico.readUInt32LE(at + 12), expectedOffset);
    assert.deepEqual(ico.subarray(expectedOffset, expectedOffset + png.length), png);
    expectedOffset += png.length;
  });
  assert.equal(ico.length, expectedOffset);
});

test('the standard sizes run from 16 to 256 px, and other sizes are refused', () => {
  assert.deepEqual(ICO_SIZES, [16, 24, 32, 48, 64, 128, 256]);
  assert.throws(() => icoFromPngs([{ size: 512, png: fakePng(1) }]), /can't be 512 px/);
});
