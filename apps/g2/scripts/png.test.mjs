import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, litPixelCount } from "./png.mjs";

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

/** RGBA PNG; `lit` pixel indexes get alpha 255. Rows alternate filters 0 and 2 to exercise unfiltering. */
function encodeRgba(width, height, lit) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc(width * height * 4);
  for (const i of lit) pixels.set([0, 255, 0, 255], i * 4);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * width * 4, (y + 1) * width * 4);
    if (y % 2 === 1) {
      const prev = pixels.subarray((y - 1) * width * 4, y * width * 4);
      rows.push(Buffer.from([2]), Buffer.from(row.map((v, x) => (v - prev[x]) & 0xff)));
    } else {
      rows.push(Buffer.from([0]), row);
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("simulator screenshot decoding", () => {
  it("counts lit pixels by alpha", () => {
    const png = decodePng(encodeRgba(8, 4, [0, 9, 10, 31]));
    expect([png.width, png.height, png.channels]).toEqual([8, 4, 4]);
    expect(litPixelCount(png)).toBe(4);
  });

  it("reports a blank framebuffer as zero", () => {
    expect(litPixelCount(decodePng(encodeRgba(576, 288, [])))).toBe(0);
  });
});
