// Drives two Quetzal games joined by QuetzalLink (in-memory "network" with latency).
// Usage: QZ_ROM=path node --experimental-strip-types bench/quetzal-coop.ts   (ROM is never committed)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { Core } from '../src/engine/core.ts';
import { QuetzalLink, isQuetzal, type QzMsg } from '../src/net/quetzal.ts';
const rom = new Uint8Array(readFileSync(process.env.QZ_ROM!));
console.log('isQuetzal', isQuetzal(rom));
const OUT = process.env.OUT ?? '.';
const factory = (await import(pathToFileURL('public/cores/mgba.mjs').href)).default;
const png = (fr: { data: Uint8Array; width: number; height: number }) => {
  const raw = Buffer.alloc((fr.width * 4 + 1) * fr.height);
  for (let y = 0; y < fr.height; y++) Buffer.from(fr.data.buffer, fr.data.byteOffset + y * fr.width * 4, fr.width * 4).copy(raw, y * (fr.width * 4 + 1) + 1);
  const ch = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
  const h = Buffer.alloc(13); h.writeUInt32BE(fr.width, 0); h.writeUInt32BE(fr.height, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', h), ch('IDAT', deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
};
const LAT = +(process.env.LAT ?? 4); // frames of one-way latency
const cores: Core[] = [], links: QuetzalLink[] = [];
const wire: { at: number; to: number; m: QzMsg }[] = [];
let F = 0;
for (let i = 0; i < 2; i++) {
  const c = await Core.create(factory);
  if (!c.load(rom, 'q.gba')) throw new Error('load');
  const st = `${OUT}/qsave${i}.state`;
  if (existsSync(st)) c.loadState(new Uint8Array(readFileSync(st)));
  cores.push(c);
  links.push(new QuetzalLink(c, i === 0, m => wire.push({ at: F + LAT, to: 1 - i, m: structuredClone(m) })));
  links[i].onStatus = s => console.log(`F${F} P${i + 1}: ${s}`);
}
const B = { RB: 1 << 11, LB: 1 << 10, A: 1 << 8, B: 1 << 0, SEL: 1 << 2, START: 1 << 3, R: 1 << 7, L: 1 << 6, U: 1 << 4, D: 1 << 5 };
export function step(inp: [number, number], linked = true) {
  for (let i = 0; i < 2; i++) { cores[i].setInput(0, inp[i]); cores[i].run(1); if (linked) links[i].frame(); }
  F++;
  for (let k = wire.length - 1; k >= 0; k--) if (wire[k].at <= F) { /* deliver in order below */ }
  const due = wire.filter(w => w.at <= F); for (const w of due) links[w.to].receive(w.m);
  wire.splice(0, wire.length, ...wire.filter(w => w.at > F));
}
const shot = (tag: string) => cores.forEach((c, i) => writeFileSync(`${OUT}/${tag}_p${i + 1}.png`, png(c.frame())));
const tap = (k: number, who: number[] = [0, 1], hold = 6, wait = 30) => {
  for (let f = 0; f < hold; f++) step([who.includes(0) ? k : 0, who.includes(1) ? k : 0]);
  for (let f = 0; f < wait; f++) step([0, 0]);
};
// script from argv: e.g. "A A START wait:60 shot:x save"
for (const cmd of (process.env.SCRIPT ?? '').split(/\s+/).filter(Boolean)) {
  const [op, arg] = cmd.split(':');
  if (op === 'wait') for (let f = 0; f < +arg; f++) step([0, 0]);
  else if (op === 'shot') shot(arg);
  else if (op === 'save') cores.forEach((c, i) => writeFileSync(`${OUT}/qsave${i}.state`, c.saveState()));
  else if (op === 'mashB') { for (let f = 0; f < +arg; f++) step([f % 20 < 3 ? B.B : 0, f % 20 < 3 ? B.B : 0]); }
  else if (op === 'mash') { for (let f = 0; f < +arg; f++) step([f % 20 < 3 ? B.A : 0, f % 20 < 3 ? B.A : 0]); }
  else if (op.startsWith('p1') || op.startsWith('p2')) tap((B as any)[op.slice(2)], [op[1] === '1' ? 0 : 1], 6, +(arg ?? 30));
  else tap((B as any)[op], [0, 1], 6, +(arg ?? 30));
}
console.log('frame', F, 'cb2', cores.map(c => c.read32(0x3002664).toString(16)), 'link st', cores.map(c => c.read8(0x3003511)));
if (process.env.TRACE) {
  const c = cores[0];
  let last = '';
  for (let f = 0; f < +process.env.TRACE; f++) {
    step([0, 0], !process.env.NOLINK);
    const s = [c.read8(0x3003510), c.read8(0x3003511), c.read8(0x3003512), c.read8(0x3003513), c.read8(0x300351e), c.read8(0x3000d93), c.read16(0x4000128).toString(16), c.read16(0x4000134).toString(16)].join(' ');
    if (s !== last) { console.log(F, 'master st id cnt E hs SIOCNT RCNT:', s); last = s; }
  }
}
if (process.env.PROBE) {
  const c = cores[0];
  const dump = () => { const a: string[] = []; for (let i = 0; i < 0x18; i++) a.push(c.read8(0x3003510 + i).toString(16).padStart(2, '0')); const w: string[] = []; for (let i = 0; i < 0x10; i++) w.push(c.read8(0x3000d88 + i).toString(16).padStart(2, '0')); return a.join('') + ' | ' + w.join(''); };
  for (let f = 0; f < +process.env.PROBE; f++) {
    const press = f >= 10 && f < 16 ? 1 << 8 : 0;
    cores[0].setInput(0, press); cores[0].run(1); const before = dump(); links[0].frame(); const after = dump();
    cores[1].setInput(0, 0); cores[1].run(1); links[1].frame();
    F++; const due = wire.filter(w => w.at <= F); for (const w of due) links[w.to].receive(w.m); wire.splice(0, wire.length, ...wire.filter(w => w.at > F));
    console.log(f, before, '->', after);
  }
}
