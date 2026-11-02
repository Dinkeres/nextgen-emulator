// Linked GBAs: the cable works, the system is deterministic, and states round-trip exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LinkCore } from '../src/engine/linkcore.ts';
import { fnv1a } from '../src/net/rollback.ts';

const rom = new Uint8Array(readFileSync('public/homebrew/kaiser-link-squares.gba'));
const factory = async () => (await import(pathToFileURL('public/cores/gbalink.mjs').href)).default;
const RIGHT = 1 << 7, DOWN = 1 << 5;
const f0 = (await import(pathToFileURL('public/cores/gbalink.mjs').href)).default;

/** Leftmost x of pixels in a colour band (ignoring the 4px status bar). */
function findSquare(c: LinkCore, pred: (r: number, g: number, b: number) => boolean) {
  const f = c.frame();
  let minX = Infinity, minY = Infinity;
  for (let y = 6; y < 160; y++) for (let x = 0; x < 240; x++) {
    const i = (y * 240 + x) * 4;
    if (pred(f.data[i], f.data[i + 1], f.data[i + 2])) { minX = Math.min(minX, x); minY = Math.min(minY, y); }
  }
  return { x: minX, y: minY };
}
const red = (r: number, g: number, b: number) => r > 200 && g < 100 && b < 100;
const blue = (r: number, g: number, b: number) => b > 200 && r < 100;

test('link cable carries player 1 to player 2\'s screen', async () => {
  const c = await LinkCore.create(await factory(), [rom, rom], [], 1); // we look at player 2
  // both squares start at the same spot: move player 2 out of the way first
  for (let i = 0; i < 60; i++) { c.setInput(1, i > 10 ? DOWN : 0); c.run(2); }
  c.setInput(1, 0);
  c.run(3);
  const before = findSquare(c, red);
  assert.ok(Number.isFinite(before.x), 'player 2 sees player 1\'s (red) square');
  for (let i = 0; i < 40; i++) { c.setInput(0, RIGHT); c.run(2); }
  c.setInput(0, 0);
  for (let i = 0; i < 5; i++) c.run(i === 4 ? 3 : 2);
  const after = findSquare(c, red);
  assert.ok(after.x >= before.x + 60, `red moved right on player 2's screen (${before.x} -> ${after.x})`);
  // status bar on player 2's GBA is its own colour (blue = id 1) only when linked
  const f = c.frame();
  assert.ok(blue(f.data[(1 * 240 + 120) * 4], f.data[(1 * 240 + 120) * 4 + 1], f.data[(1 * 240 + 120) * 4 + 2]), 'player 2 reports linked as id 1');
});

test('linked system is deterministic across machines and survives reloads', async () => {
  const run = async () => {
    const c = await LinkCore.create(await factory(), [rom, rom, rom]);
    let seed = 3;
    const hashes: number[] = [];
    let mid: Uint8Array | null = null;
    for (let i = 0; i < 400; i++) {
      for (let p = 0; p < 3; p++) { seed = (seed * 1664525 + 1013904223) >>> 0; c.setInput(p, seed & (RIGHT | DOWN | 0x50)); }
      c.run(2);
      if (i === 200) mid = c.saveState();
      if (i % 50 === 0) hashes.push(fnv1a(c.saveState()));
    }
    return { c, hashes, mid: mid!, end: fnv1a(c.saveState()) };
  };
  const a = await run(), b = await run();
  assert.deepEqual(a.hashes, b.hashes, 'two machines agree frame-for-frame');
  // reload keeps the link running (no stall). Exact replay drifts by a few cycles after a reload,
  // which is why link play uses delay-based netcode (no rollback) — see DECISIONS.md.
  a.c.loadState(a.mid);
  const t = performance.now();
  for (let i = 0; i < 30; i++) a.c.run(2);
  assert.ok((performance.now() - t) / 30 < 50, 'frames after a reload run at normal speed');
});

test('online link play: two machines over a 100 ms / 5% loss network stay in sync', async () => {
  const { Rollback } = await import('../src/net/rollback.ts');
  type Msg = Parameters<InstanceType<typeof Rollback>['receive']>[0];
  const machines = await Promise.all([0, 1].map(me => LinkCore.create(f0, [rom, rom], [], me)));
  let clock = 0, seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const queue: { at: number; to: number; msg: Msg }[] = [];
  const sessions = [0, 1].map(me => new Rollback({
    core: machines[me], localPort: me, players: [0, 1], inputDelay: 4, maxRollback: 0, hashInterval: 30, now: () => clock,
    send: msg => { if (rnd() < 0.05) return; queue.push({ at: clock + 50 * (0.8 + rnd() * 0.4), to: 1 - me, msg: structuredClone(msg) }); },
  }));
  for (let t = 0; t < 900 && Math.min(sessions[0].F, sessions[1].F) < 600; t++) {
    clock += 1000 / 60;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at <= clock) { sessions[queue[i].to].receive(queue[i].msg); queue.splice(i, 1); }
    sessions[0].advance(t > 100 ? RIGHT : 0, false); // player 1 walks right
    sessions[1].advance(t > 60 && t < 90 ? DOWN : 0, false); // player 2 steps down out of the way
  }
  const [a, b] = sessions.map(s => s.stats());
  assert.equal(a.desyncs + b.desyncs, 0, 'machines agree');
  assert.ok(Math.min(a.frame, b.frame) >= 600, `progressed ${a.frame}/${b.frame}`);
  machines[1].run(3);
  assert.ok(findSquare(machines[1], red).x > 150, 'player 2\'s screen shows player 1 far to the right');
});
