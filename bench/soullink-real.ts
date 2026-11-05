// Plays the real game headless until the tracker has seen a real starter, proving the addresses.
// Usage: SL_ROM=path node --experimental-strip-types bench/soullink-real.ts   (ROM is never committed)
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { Core } from '../src/engine/core.ts';
import { SoulTracker, type SoulReport } from '../src/net/soullink.ts';

const rom = new Uint8Array(readFileSync(process.env.SL_ROM!));
const factory = (await import(pathToFileURL('public/cores/mgba.mjs').href)).default;
const c = await Core.create(factory);
if (!c.load(rom, 'g.gba')) throw new Error('load');
const reports: SoulReport[] = [];
const t = new SoulTracker(c, r => { reports.push(r); console.log(`frame ${F}`, JSON.stringify(r)); });
const B = { A: 1 << 8, B: 1, START: 1 << 3, U: 1 << 4, D: 1 << 5, L: 1 << 6, R: 1 << 7 };
let F = 0;
const run = (input: number) => { c.setInput(0, input); c.run(1); t.frame(); F++; };
const press = (k: number, hold = 8, wait = 12) => { for (let i = 0; i < hold; i++) run(k); for (let i = 0; i < wait; i++) run(0); };
const save1 = () => c.read32(0x3005008);
const map = () => { const s = save1(); return s >>> 24 === 2 ? [c.read8(s + 4), c.read8(s + 5)] : [-1, -1]; };
// gObjectEvents[0].currentCoords: the player, live (the save block's copy only updates on saving).
const xy = () => [c.read16(0x2036e38 + 0x10) - 7, c.read16(0x2036e38 + 0x12) - 7];
const party = () => c.read8(0x2024029);
let seed = 7; const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;

const png = (fr: { data: Uint8Array; width: number; height: number }) => {
  const raw = Buffer.alloc((fr.width * 4 + 1) * fr.height);
  for (let y = 0; y < fr.height; y++) Buffer.from(fr.data.buffer, fr.data.byteOffset + y * fr.width * 4, fr.width * 4).copy(raw, y * (fr.width * 4 + 1) + 1);
  const ch = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])), 8 + d.length); return b; };
  const h = Buffer.alloc(13); h.writeUInt32BE(fr.width, 0); h.writeUInt32BE(fr.height, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', h), ch('IDAT', deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
};

// The intro: A and Start until the game hands over the bedroom.
const t0 = Date.now();
for (let i = 0; i < 700 && save1() >>> 24 !== 2; i++) press(i % 3 === 2 ? B.START : B.A, 6, 16);
for (let i = 0; i < 1400 && !(map()[0] === 4 && map()[1] === 1 && xy()[0] > 0 && reports.length); i++) press(i % 7 === 6 ? B.START : B.A, 6, 16);
console.log('in the game at frame', F, 'map', map(), 'pos', xy(), `${Math.round(F / ((Date.now() - t0) / 1000))} fps`);

// Then a noisy walk toward each exit; talking, choosing and battling are all just A.
const goals: Record<string, [number, number]> = { '4,1': [10, 2], '4,0': [4, 8], '3,0': [12, 0], '4,3': [8, 5] };
if (process.env.SL_PROBE) {
  for (const [n, k] of [['R', B.R], ['R', B.R], ['U', B.U], ['L', B.L], ['D', B.D], ['B', B.B], ['A', B.A], ['R', B.R]] as const) {
    for (let i = 0; i < 30; i++) run(k);
    for (let i = 0; i < 30; i++) run(0);
    console.log(n, 'xy', xy(), 'map', map(), 'locked', c.read8(0x2037a70), 'cb2', c.read32(0x30030f0 + 4).toString(16), 'mainstate', c.read8(0x30030f0 + 0x438));
  }
  writeFileSync(process.env.OUT ?? 'p.png', png(c.frame()));
}
const LIMIT = Number(process.env.SL_FRAMES ?? 400000);
while (F < LIMIT && !reports.some(r => r.k === 'catch')) {
  const [x, y] = xy();
  // The bedroom's stairs are reached from below; the railing blocks the row beside them.
  const goal = map().join() === '4,1' && x < 10 ? [10, 4] : goals[map().join()];
  const moves: number[] = [];
  if (goal) { if (x < goal[0]) moves.push(B.R); if (x > goal[0]) moves.push(B.L); if (y < goal[1]) moves.push(B.D); if (y > goal[1]) moves.push(B.U); }
  const noise = rnd(4) === 0 || !moves.length;
  const dir = noise ? [B.U, B.D, B.L, B.R][rnd(4)] : moves[rnd(moves.length)];
  const before = xy().join();
  press(dir, 32, 2);
  // Not moving means something wants attention: a dialog, a choice, a battle.
  if (xy().join() === before) { press(B.A, 6, 10); if (rnd(3) === 0) press(B.B, 6, 8); }
  if (F % 20000 < 44) console.log('frame', F, 'map', map(), 'pos', xy(), 'party', party());
}
console.log('frames', F, 'map', map(), 'party', party());
writeFileSync(process.env.OUT ?? 'soullink-real.png', png(c.frame()));
console.log('reports:', JSON.stringify(reports));
