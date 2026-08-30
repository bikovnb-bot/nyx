import zlib from "node:zlib";

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function pngFromPixels(size, getPixel) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowLen = size * 4;
  const raw = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowLen + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const off = rowStart + 1 + x * 4;
      const [r, g, b, a] = getPixel(x, y);
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Builds a flat-color, size x size RGBA PNG buffer (no external deps).
export function solidColorPng(size, color) {
  return pngFromPixels(size, () => color);
}

// Anti-aliased filled circle on a transparent background, with an optional
// smaller inner dot (e.g. a "connected" indicator) in a second color.
export function circleIconPng(size, [r, g, b, a], dot) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size / 2 - 1;

  return pngFromPixels(size, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dot) {
      const ddx = x - (cx + dot.offset);
      const ddy = y - (cy + dot.offset);
      const dDist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dDist <= dot.radius) return dot.color;
    }

    const edge = dist - radius;
    if (edge <= 0) return [r, g, b, a];
    if (edge < 1) return [r, g, b, Math.round(a * (1 - edge))];
    return [0, 0, 0, 0];
  });
}

// Anti-aliased signed distance to a filled disc: negative = inside.
function discSd(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy) - radius;
}

// Nyx (goddess of night) mark: a crescent moon with a couple of small stars,
// rendered as a signed-distance composition of two discs (main disc minus an
// offset disc carves the crescent) plus a "connected" dot like circleIconPng.
export function crescentMoonPng(size, [r, g, b, a], opts = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.34;
  // Shifting the subtracted disc toward the upper-right carves a right-facing crescent.
  const cutOffset = size * 0.16;
  const cutRadius = size * 0.3;
  const starColor = opts.starColor || [255, 255, 255, a];
  const stars = opts.stars !== false
    ? [
        { x: size * 0.16, y: size * 0.2, r: Math.max(1, size * 0.028) },
        { x: size * 0.3, y: size * 0.42, r: Math.max(1, size * 0.018) },
      ]
    : [];
  const dot = opts.dot;

  return pngFromPixels(size, (x, y) => {
    if (dot) {
      const ddx = x - (cx + dot.offset);
      const ddy = y - (cy + dot.offset);
      const dDist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dDist <= dot.radius) return dot.color;
    }

    for (const star of stars) {
      const sd = discSd(x, y, star.x, star.y, star.r);
      if (sd <= 0) return starColor;
      if (sd < 1) return [starColor[0], starColor[1], starColor[2], Math.round(starColor[3] * (1 - sd))];
    }

    const bodyEdge = discSd(x, y, cx, cy, radius);
    const cutEdge = discSd(x, y, cx + cutOffset, cy - cutOffset, cutRadius);

    // Inside the main disc but outside the cut disc => part of the crescent.
    if (cutEdge > 0) {
      if (bodyEdge <= 0) return [r, g, b, a];
      if (bodyEdge < 1) return [r, g, b, Math.round(a * (1 - bodyEdge))];
      return [0, 0, 0, 0];
    }
    // Just inside the cut disc's boundary: a thin anti-aliased fade to transparent.
    if (cutEdge > -1 && bodyEdge <= 0) {
      return [r, g, b, Math.round(a * (1 + cutEdge))];
    }
    return [0, 0, 0, 0];
  });
}

// Wraps a single PNG image in a minimal ICO container (the "PNG in ICO"
// format supported since Windows Vista) so it can be used as a .ico file
// without any image-conversion dependency.
export function pngToIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 means 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // color palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // image data size
  entry.writeUInt32LE(header.length + entry.length, 12); // offset

  return Buffer.concat([header, entry, pngBuffer]);
}
