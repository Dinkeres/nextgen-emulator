// DS online play (shared console): inputs incl. touch travel the network; both machines agree,
// and a stroke drawn by player 2 appears on player 1's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Core } from '../src/engine/core.ts';
import { Rollback, packInput, unpackInput, type NetMsg } from '../src/net/rollback.ts';

test('packed input round-trips buttons and touch', () => {
  for (const [b, p] of [[0, null], [0xffff, null], [0x123, [-32768, 32767]], [1, [0, 0]], [0xabcd, [12345, -23456]]] as const) {
    const [bb, pp] = unpackInput(packInput(b, p as [number, number] | null));
    assert.equal(bb, b); assert.deepEqual(pp, p);
  }
});

test('DS shared console over a 100 ms network: no desync, remote touch is drawn', async () => {
  const f = (await import(pathToFileURL('public/cores/melonds.mjs').href)).default;
  const rom = new Uint8Array(readFileSync('public/homebrew/kaiser-ds-demo.nds'));
  const machines = await Promise.all([0, 1].map(async () => {
    const c = await Core.create(f); c.setOption('melonds_touch_mode', 'Touch'); assert.ok(c.load(rom, 'demo.nds')); c.setStrict(true); return c;
  }));
  let clock = 0;
  const queue: { at: number; to: number; msg: NetMsg }[] = [];
  const s = [0, 1].map(me => new Rollback({
    core: machines[me], localPort: me, players: [0, 1], inputDelay: 4, maxRollback: 0, shared: true, hashInterval: 30, now: () => clock,
    send: msg => queue.push({ at: clock + 50, to: 1 - me, msg: structuredClone(msg) }),
  }));
  // bottom-screen point in the 256x384 stacked frame -> pointer space
  const pt = (x: number, y: number): [number, number] => [Math.round(x / 256 * 65536 - 32768), Math.round((192 + y) / 384 * 65536 - 32768)];
  for (let t = 0; t < 700 && Math.min(s[0].F, s[1].F) < 400; t++) {
    clock += 1000 / 60;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at <= clock) { s[queue[i].to].receive(queue[i].msg); queue.splice(i, 1); }
    s[0].advance(0, false);
    s[1].advance(packInput(0, t > 200 && t < 300 ? pt(40 + (t - 200), 80) : null), false); // player 2 draws a line
  }
  const [a, b] = s.map(x => x.stats());
  assert.equal(a.desyncs + b.desyncs, 0, 'machines agree');
  assert.ok(Math.min(a.frame, b.frame) >= 400);
  machines[0].run(3);
  const fr = machines[0].frame();
  let painted = 0;
  for (let x = 30; x < 160; x++) { const i = ((192 + 80) * 256 + x) * 4; if (fr.data[i + 2] > 200 && fr.data[i] < 100) painted++; }
  assert.ok(painted > 40, `player 1's DS shows player 2's blue stroke (${painted}px)`);
});
