// Same inputs must give the same state no matter which run flags (video/audio skip, FF hint)
// are used, otherwise rollback re-simulation and fast-forward would desync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Core } from '../src/engine/core.ts';
import { fnv1a } from '../src/net/rollback.ts';

const CASES: [string, string][] = [
  ['fceumm', 'public/homebrew/thwaite.nes'], ['snes9x', 'public/homebrew/breakout.sfc'],
  ['gambatte', 'public/homebrew/libbet.gb'], ['gambatte', 'public/homebrew/ucity.gbc'],
  ['mgba', 'public/homebrew/240pee_mb.gba'], ['genesis_plus_gx', 'public/homebrew/sgdk-cube3d.gen'],
];

for (const [name, rom] of CASES) test(`determinism ${name} ${rom.split('/').pop()}`, async () => {
  const f = (await import(pathToFileURL(`public/cores/${name}.mjs`).href)).default;
  const hashes: number[] = [];
  for (const flags of [3, 0, 1, 2, 4, 7]) {
    const c = await Core.create(f);
    c.load(new Uint8Array(readFileSync(rom)), rom.split('/').pop()!);
    c.setStrict(true);
    let seed = 7;
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      c.setInput(0, i % 9 === 0 ? seed & 0xfff : 0);
      c.run(flags);
    }
    hashes.push(fnv1a(c.saveState()));
  }
  assert.deepEqual(hashes, hashes.map(() => hashes[0]), `${name}: flag-dependent state: ${hashes.join(',')}`);
});

// load(save(s)) then run must equal just running: rollback and rewind depend on it
for (const [name, rom] of CASES) test(`state round-trip ${name} ${rom.split('/').pop()}`, async () => {
  const f = (await import(pathToFileURL(`public/cores/${name}.mjs`).href)).default;
  const c = await Core.create(f);
  c.load(new Uint8Array(readFileSync(rom)), rom.split('/').pop()!);
  c.setStrict(true);
  const press = (i: number) => c.setInput(0, i % 13 < 3 ? 1 << 8 | 1 << 7 : i % 50 === 0 ? 1 << 3 : 0);
  for (let i = 0; i < 300; i++) { press(i); c.run(2); }
  const s = c.saveState();
  for (let i = 300; i < 360; i++) { press(i); c.run(2); }
  const a = fnv1a(c.saveState());
  c.loadState(s);
  for (let i = 300; i < 360; i++) { press(i); c.run(2); }
  assert.equal(fnv1a(c.saveState()), a, `${name}: state after reload diverges`);
});
