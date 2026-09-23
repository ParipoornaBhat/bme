import zlib from "node:zlib";

/**
 * Decode a mask PNG to one label byte per pixel (first channel).
 *
 * Labels leave the server as plain bytes rather than as an image for the
 * browser to decode: decoding in the browser means drawing to a canvas and
 * reading it back, and privacy-hardened browsers (Brave by default, Firefox
 * with fingerprinting protection) add +/-1 noise to canvas readback. On a
 * picture that is invisible; on labels stored as 0-3 it flips 0<->1 at random
 * pixels - holes in the annotation and stray specks outside it, which the next
 * save then writes to disk.
 *
 * Handles every standard scanline filter. Anything other than 8-bit,
 * non-interlaced gray / gray+alpha / RGB / RGBA is refused, never guessed at.
 */
export function decodeMaskPng(buf: Buffer): { width: number; height: number; labels: Uint8Array } {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8 || SIG.some((b, i) => buf[i] !== b)) throw new Error("not a PNG");

  let width = 0, height = 0, bitDepth = 0, colourType = 0, interlace = 0;
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }

  const channels = ({ 0: 1, 4: 2, 2: 3, 6: 4 } as Record<number, number>)[colourType];
  if (!channels || bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported mask PNG (colour type ${colourType}, ${bitDepth}-bit, interlace ${interlace})`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  if (raw.length < (rowBytes + 1) * height) throw new Error("truncated mask PNG");

  const prev = new Uint8Array(rowBytes);
  const cur = new Uint8Array(rowBytes);
  const labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowBytes + 1);
    const filter = raw[off];
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[off + 1 + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) labels[y * width + px] = cur[px * channels];
    prev.set(cur);
  }
  return { width, height, labels };
}
