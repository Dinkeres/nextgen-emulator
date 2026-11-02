// Runs a ROM for N frames and writes the last frame as PNG (visual check of a core).
// Usage: node --experimental-strip-types bench/frame-dump.ts <core> <rom> <frames> <out.png> [startTapEvery]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { Core } from '../src/engine/core.ts';
const [core, rom, frames, out, tap] = process.argv.slice(2);
const c = await Core.create((await import(pathToFileURL(`public/cores/${core}.mjs`).href)).default);
if (core === 'melonds') c.setOption('melonds_touch_mode', 'Touch');
if (!c.load(new Uint8Array(readFileSync(rom)), rom.split('/').pop()!)) throw new Error('load failed');
const W = 256, H = 384; // DS top/bottom layout; draw a stroke on the bottom screen when STROKE=1
for (let i = 0; i < +frames; i++) {
  c.setInput(0, tap && i % +tap < 4 ? (1 << 3) | (1 << 8) : 0);
  if (process.env.STROKE && i > 100 && i < 220) {
    const px = 30 + (i - 100) * 1.6, py = 192 + 80 + Math.sin(i / 8) * 40;
    c.setPointer(0, Math.round(px / W * 65536 - 32768), Math.round(py / H * 65536 - 32768), true);
  } else c.setPointer(0, 0, 0, false);
  c.run(i === +frames - 1 ? 3 : 2);
}
const f = c.frame();
const raw = Buffer.alloc((f.width * 4 + 1) * f.height);
for (let y = 0; y < f.height; y++) { raw[y * (f.width * 4 + 1)] = 0; Buffer.from(f.data.buffer, f.data.byteOffset + y * f.width * 4, f.width * 4).copy(raw, y * (f.width * 4 + 1) + 1); }
const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(f.width, 0); ihdr.writeUInt32BE(f.height, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${f.width}x${f.height}`, c.av);
