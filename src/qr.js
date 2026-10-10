import { createRequire } from "node:module";

// The CommonJS build exposes stringToBytesFuncs (UTF-8 support); the ESM build
// of this package has a different shape.
const qrcode = createRequire(import.meta.url)("qrcode-generator");

// Profile names and links can contain non-ASCII text.
qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

// SVG with its own white background (QR codes need a light quiet zone).
export function qrSvg(text, { cellSize = 5, margin = 2 } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}
