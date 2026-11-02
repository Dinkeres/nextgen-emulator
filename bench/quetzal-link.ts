// Speed + screenshots of a GBA ROM in 1- and 2-player link mode. Usage: node ... bench/quetzal-link.ts ROM [frames]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { LinkCore } from '../src/engine/linkcore.ts';
const rom = new Uint8Array(readFileSync(process.argv[2]));
const frames = +(process.argv[3] ?? 1200), out = process.env.OUT ?? '.';
const f = (await import(pathToFileURL('public/cores/gbalink.mjs').href)).default;
const png = (fr: { data: Uint8Array; width: number; height: number }) => {
  const raw = Buffer.alloc((fr.width * 4 + 1) * fr.height);
  for (let y = 0; y < fr.height; y++) Buffer.from(fr.data.buffer, fr.data.byteOffset + y * fr.width * 4, fr.width * 4).copy(raw, y * (fr.width * 4 + 1) + 1);
  const ch = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
  const h = Buffer.alloc(13); h.writeUInt32BE(fr.width, 0); h.writeUInt32BE(fr.height, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', h), ch('IDAT', deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
};
for (const n of (process.env.N ?? '1,2').split(',').map(Number)) {
  const c = await LinkCore.create(f, Array(n).fill(rom));
  const t = performance.now();
  for (let i = 0; i < frames; i++) {
    const press = i % 40 < 3 ? (i % 80 < 40 ? 1 << 3 : 1 << 8) : 0; // tap Start / A to get past the intro
    for (let p = 0; p < n; p++) c.setInput(p, press);
    c.run(2);
  }
  console.log(`${n}P: ${((performance.now() - t) / frames).toFixed(2)} ms/frame, dbg asleep=${(c as any).m._lk_dbg(0)} frames=${[0,1,2,3].slice(0,n).map(i=>(c as any).m._lk_dbg(10+i))}`);
  for (let v = 0; v < n; v++) { c.setView(v); c.run(3); writeFileSync(`${out}/q${n}p${v + 1}.png`, png(c.frame())); }
}
