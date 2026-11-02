// Two real cores linked by a simulated network (latency + loss). Verifies no desyncs and that
// the netplay timeline equals an offline reference run fed the same inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Core } from '../src/engine/core.ts';
import { Rollback, fnv1a, type NetMsg } from '../src/net/rollback.ts';

// [core, rom, maxRollback]; Genesis is delay-based (0) because its state load isn't exact
const CASES: [string, string, number][] = [
  ['fceumm', 'public/homebrew/thwaite.nes', 8],
  ['snes9x', 'public/homebrew/breakout.sfc', 8],
  ['genesis_plus_gx', 'public/homebrew/sgdk-cube3d.gen', 0],
];
const NETS = [
  { latency: 50, loss: 0.01 },
  { latency: 100, loss: 0.05 },
  { latency: 200, loss: 0.01 },
];
const FRAMES = Number(process.env.NET_FRAMES ?? 1800);

async function makeCore(name: string, rom: string) {
  const f = (await import(pathToFileURL(`public/cores/${name}.mjs`).href)).default;
  const c = await Core.create(f);
  assert.ok(c.load(new Uint8Array(readFileSync(rom)), rom.split('/').pop()!));
  c.setStrict(true);
  return c;
}

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

for (const [coreName, rom, maxRb] of CASES) for (const net of NETS) {
  test(`rollback ${coreName} ${net.latency}ms ${net.loss * 100}% loss`, async () => {
    const cores = [await makeCore(coreName, rom), await makeCore(coreName, rom)];
    let clock = 0;
    const queue: { at: number; to: number; msg: NetMsg }[] = [];
    const rand = rng(42);
    const sessions = [0, 1].map(me => new Rollback({
      core: cores[me], localPort: me, players: [0, 1], inputDelay: maxRb ? 2 : 4, maxRollback: maxRb, hashInterval: 60,
      now: () => clock,
      send: msg => {
        if (rand() < net.loss) return;
        // jitter ±20% of one-way latency
        const owl = net.latency / 2 * (0.8 + rand() * 0.4);
        queue.push({ at: clock + owl, to: 1 - me, msg: structuredClone(msg) });
      },
    }));
    // each player's actual pressed buttons per local frame index
    const inputs = [rng(1), rng(2)];
    const held = [0, 0];
    const actual: number[][] = [[], []];
    let ticks = 0;
    while (Math.min(sessions[0].F, sessions[1].F) < FRAMES && ticks < FRAMES * 8) {
      ticks++;
      clock += 1000 / 60;
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at <= clock) { sessions[queue[i].to].receive(queue[i].msg); queue.splice(i, 1); }
      for (const me of [0, 1]) {
        if (inputs[me]() < 0.15) held[me] = Math.floor(inputs[me]() * 4096);
        // mirrors Rollback: local input is latched once for frame F+delay
        const target = sessions[me].F + (maxRb ? 2 : 4);
        if (actual[me][target] === undefined) actual[me][target] = held[me];
        sessions[me].advance(held[me], false);
      }
    }
    const [a, b] = sessions.map(s => s.stats());
    console.log(coreName, net, { frames: a.frame, rollbacks: a.rollbacks, avgRb: +(a.rollbackFrames / Math.max(1, a.rollbacks)).toFixed(1), maxRb: a.maxRollbackSeen, stalls: [a.stalls, b.stalls], desyncs: [a.desyncs, b.desyncs], ticks });
    assert.equal(a.desyncs + b.desyncs, 0, 'peers desynced');
    assert.ok(Math.min(a.frame, b.frame) >= FRAMES, `progressed ${a.frame}/${b.frame} in ${ticks} ticks`);

    // offline reference with the confirmed inputs both peers used
    const ref = await makeCore(coreName, rom);
    let checked = 0;
    for (let f = 0; f < FRAMES - 30; f++) {
      if (f > 0 && f % 60 === 0) {
        const h = sessions[0].getHash(f);
        if (h !== undefined && h !== -1) { assert.equal(fnv1a(ref.saveState()), h, `diverged from reference at ${f}`); checked++; }
      }
      for (const p of [0, 1]) ref.setInput(p, actual[p][f] ?? 0);
      ref.run(0);
    }
    assert.ok(checked >= 3, `only ${checked} checkpoints compared`);
  });
}
