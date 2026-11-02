// Dumps each linked player's screen to PNG + prints its SIOCNT-derived status bar colour.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { LinkCore } from '../src/engine/linkcore.ts';
const n = +(process.argv[2] ?? 2), frames = +(process.argv[3] ?? 120);
const rom = new Uint8Array(readFileSync('public/homebrew/kaiser-link-squares.gba'));
const c = await LinkCore.create((await import(pathToFileURL('public/cores/gbalink.mjs').href)).default, Array(n).fill(rom));
for (let i = 0; i < frames; i++) { c.setInput(0, i > 30 ? 1 << 7 : 0); c.setInput(1, i > 30 ? 1 << 5 : 0); c.run(2); }
const png = (f: { data: Uint8Array; width: number; height: number }) => {
  const raw = Buffer.alloc((f.width * 4 + 1) * f.height);
  for (let y = 0; y < f.height; y++) Buffer.from(f.data.buffer, f.data.byteOffset + y * f.width * 4, f.width * 4).copy(raw, y * (f.width * 4 + 1) + 1);
  const ch = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
  const h = Buffer.alloc(13); h.writeUInt32BE(f.width, 0); h.writeUInt32BE(f.height, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', h), ch('IDAT', deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
};
for (let v = 0; v < n; v++) {
  c.setView(v); c.run(3);
  const f = c.frame();
  console.log(`player ${v + 1} status bar rgb`, f.data[(1 * 240 + 120) * 4], f.data[(1 * 240 + 120) * 4 + 1], f.data[(1 * 240 + 120) * 4 + 2]);
  writeFileSync(`bench/_link${v + 1}.png`, png(f));
}
