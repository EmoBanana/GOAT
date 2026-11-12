// A Windows .ico built from PNG images: a 6-byte header, a 16-byte entry per image, then the PNGs.
// PNG entries work on Windows Vista and later; a width or height of 256 is written as 0.
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, i) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error(`An icon can't be ${size} px.`);
    const at = i * 16;
    entries.writeUInt8(size === 256 ? 0 : size, at); // width
    entries.writeUInt8(size === 256 ? 0 : size, at + 1); // height
    entries.writeUInt8(0, at + 2); // no palette
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}
