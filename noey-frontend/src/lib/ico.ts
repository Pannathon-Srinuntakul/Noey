/**
 * Minimal ICO container around PNG images (the PNG-in-ICO form every current
 * browser reads). Lets /favicon.ico serve the Noey mark generated at build
 * time instead of a checked-in binary.
 */
export interface IcoImage {
  size: number; // square, 1..256
  png: Uint8Array;
}

export function buildIco(images: readonly IcoImage[]): Uint8Array<ArrayBuffer> {
  const headerSize = 6;
  const entrySize = 16;
  const dataOffset = headerSize + entrySize * images.length;
  const total = dataOffset + images.reduce((sum, image) => sum + image.png.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);

  let offset = dataOffset;
  images.forEach((image, index) => {
    if (image.size < 1 || image.size > 256) throw new RangeError(`icon size ${image.size} out of range`);
    const entry = headerSize + index * entrySize;
    const dimension = image.size === 256 ? 0 : image.size; // 0 means 256
    view.setUint8(entry, dimension);
    view.setUint8(entry + 1, dimension);
    view.setUint8(entry + 2, 0); // palette colours
    view.setUint8(entry + 3, 0); // reserved
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.png.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.byteLength;
  });
  return out;
}
