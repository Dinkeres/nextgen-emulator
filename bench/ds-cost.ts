// Where does a DS frame's time go? Emulation vs. the per-frame extras (rewind snapshots).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Core } from '../src/engine/core.ts';
import { RewindBuffer } from '../src/engine/rewind.ts';
const rom = process.argv[2] ?? 'bench/roms/Traffic_Escape_DS.nds';
const coreName = process.argv[3] ?? 'melonds';
const c = await Core.create((await import(pathToFileURL(`public/cores/${coreName}.mjs`).href)).default);
if (process.argv[4]) c.setOption('melonds_threaded_renderer', 'enabled');
c.setOption('melonds_touch_mode', 'Touch');
c.load(new Uint8Array(readFileSync(rom)), 'x.nds');
for (let i = 0; i < 300; i++) { c.setInput(0, i % 60 < 3 ? 8 : 0); c.run(2); }
// tap "[ 1]" on the level select (bottom screen) to get into 3D gameplay
const tap = (x: number, y: number, on: boolean) => c.setPointer(0, Math.round(x / 256 * 65536 - 32768), Math.round(y / 384 * 65536 - 32768), on);
for (let i = 0; i < 20; i++) { tap(27, 232, i < 10); c.run(2); }
for (let i = 0; i < 300; i++) c.run(2);
const N = 300, t = (f: () => void) => { const s = performance.now(); for (let i = 0; i < N; i++) f(); return (performance.now() - s) / N; };
const emuAV = t(() => c.run(3)), emuA = t(() => c.run(2)), emuNone = t(() => c.run(0));
const save = t(() => c.saveState());
const rb = new RewindBuffer(256 << 20);
const push = t(() => { c.run(2); rb.push(c.saveState()); }) - emuA;
console.log(JSON.stringify({ emuVideoAudio: +emuAV.toFixed(2), emuAudioOnly: +emuA.toFixed(2), emuNoAV: +emuNone.toFixed(2), saveState: +save.toFixed(2), rewindPushTotal: +push.toFixed(2), stateMB: +(c.stateSize() / 1048576).toFixed(1) }));
