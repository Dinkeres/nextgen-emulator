// Raw core benchmark: runs each test ROM for a fixed number of frames in Node and
// reports CPU ms/frame (avg + 1% worst), effective max FPS, state save/load cost and memory.
// Usage: npm run bench [-- --frames 3000 --flavor baseline --json out.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Core, RUN_AUDIO, RUN_VIDEO } from '../src/engine/core.ts';
import { SYSTEMS } from '../src/engine/systems.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FRAMES = +opt('frames', '3000');
const suffix = opt('flavor', '') ? '-' + opt('flavor', '') : '';
const only = opt('only', '');

const TESTS: { system: string; rom: string }[] = [
  { system: 'nes', rom: 'public/homebrew/thwaite.nes' },
  { system: 'snes', rom: 'public/homebrew/breakout.sfc' },
  { system: 'gb', rom: 'public/homebrew/libbet.gb' },
  { system: 'gbc', rom: 'public/homebrew/ucity.gbc' },
  { system: 'gba', rom: 'public/homebrew/240pee_mb.gba' },
  { system: 'genesis', rom: 'public/homebrew/sgdk-cube3d.gen' },
];

const results: Record<string, unknown>[] = [];
for (const t of TESTS) {
  if (only && t.system !== only) continue;
  const sys = SYSTEMS[t.system];
  const coreFile = `${opt('dir', 'public/cores')}/${sys.core}${suffix}.mjs`;
  if (!existsSync(t.rom) || !existsSync(coreFile)) { console.log(`skip ${t.system} (missing ${existsSync(t.rom) ? coreFile : t.rom})`); continue; }
  const t0 = performance.now();
  const factory = (await import(pathToFileURL(coreFile).href)).default;
  const core = await Core.create(factory);
  const rom = new Uint8Array(readFileSync(t.rom));
  if (!core.load(rom, t.rom.split('/').pop()!)) { console.log(`load failed ${t.system}`); continue; }
  const loadMs = performance.now() - t0;

  const times: number[] = [];
  let audioFrames = 0;
  for (let f = 0; f < FRAMES + 120; f++) {
    // tap Start every 2s, hold right + A pseudo-randomly so games leave title screens
    const mask = (f % 120 < 5 ? 1 << 3 : 0) | (f % 37 < 18 ? 1 << 7 : 0) | (f % 23 < 4 ? 1 << 8 : 0);
    core.setInput(0, mask);
    const s = performance.now();
    core.run(RUN_VIDEO | RUN_AUDIO);
    const e = performance.now() - s;
    if (f >= 120) { times.push(e); audioFrames += core.audio().length / 2; }
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p99 = times[Math.floor(times.length * 0.99)];

  let saveMs = 0, loadStMs = 0, stateKB = 0;
  if (core.stateSize()) {
    const N = 200; let st = core.saveState();
    stateKB = st.length / 1024;
    let s = performance.now(); for (let i = 0; i < N; i++) st = core.saveState(); saveMs = (performance.now() - s) / N;
    s = performance.now(); for (let i = 0; i < N; i++) core.loadState(st); loadStMs = (performance.now() - s) / N;
  }
  const r = {
    system: t.system, core: core.name, rom: t.rom.split('/').pop(),
    avgMs: +avg.toFixed(3), p99Ms: +p99.toFixed(3), maxFps: Math.round(1000 / avg),
    audioRate: Math.round(audioFrames / (FRAMES / core.av.fps)), coreRate: core.av.sampleRate,
    loadMs: Math.round(loadMs), stateKB: +stateKB.toFixed(1), saveMs: +saveMs.toFixed(3), loadStateMs: +loadStMs.toFixed(3),
    wasmHeapMB: +(core.memoryBytes / 1048576).toFixed(0),
    rollbackFrames8Ms: +(loadStMs + 8 * avg + saveMs).toFixed(2), // cost of an 8-frame rollback
  };
  results.push(r);
  console.log(JSON.stringify(r));
}
const out = opt('json', '');
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
