// Unit tests: rewind compression, input mapping, IndexedDB storage + backups, settings overrides.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RewindBuffer, xorEncode, xorApply } from '../src/engine/rewind.ts';
import { Input, DEFAULT_KEYS, padKind } from '../src/engine/input.ts';
import { BTN, systemForFile } from '../src/engine/systems.ts';
import { db, exportBackup, importBackup, sha256, type Game } from '../src/app/db.ts';
import { DEFAULTS, effective } from '../src/app/store.ts';

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

// ---------- rewind ----------
test('xor delta round-trips', () => {
  const r = rng(1);
  for (const size of [1, 7, 100, 4096, 70000]) {
    const a = new Uint8Array(size).map(() => (r() * 256) | 0);
    const b = a.slice();
    for (let i = 0; i < size / 20; i++) b[(r() * size) | 0] ^= 0x5a;
    const out = new Uint8Array(size * 2 + 64);
    const n = xorEncode(b, a, out);
    assert.ok(n > 0);
    const restored = b.slice();
    xorApply(restored, out.subarray(0, n));
    assert.deepEqual(restored, a);
  }
});

test('rewind buffer restores every previous state in order', () => {
  const r = rng(2);
  const buf = new RewindBuffer(64 * 1024 * 1024);
  const history: Uint8Array[] = [];
  let s = new Uint8Array(20000).map(() => (r() * 256) | 0);
  for (let f = 0; f < 120; f++) {
    s = s.slice();
    for (let i = 0; i < 300; i++) s[(r() * s.length) | 0] = (r() * 256) | 0;
    history.push(s);
    buf.push(s);
  }
  for (let f = history.length - 2; f >= 0; f--) assert.deepEqual(buf.pop(), history[f], `frame ${f}`);
  assert.equal(buf.pop(), null);
});

test('rewind buffer respects its memory budget', () => {
  const r = rng(3);
  const buf = new RewindBuffer(200_000);
  let s = new Uint8Array(50000);
  for (let f = 0; f < 500; f++) { s = s.slice(); for (let i = 0; i < 2000; i++) s[(r() * s.length) | 0] = f & 255; buf.push(s); }
  assert.ok(buf.usedBytes <= 200_000, `${buf.usedBytes}`);
  assert.ok(buf.length > 10);
});

// ---------- input ----------
test('keyboard maps to libretro bits and latches quick taps', () => {
  const inp = new Input();
  assert.ok(inp.keyDown('KeyX'));
  assert.equal(inp.poll()[0], 1 << BTN.A);
  inp.keyUp('KeyX');
  assert.equal(inp.poll()[0], 0);
  inp.keyDown('Enter'); inp.keyUp('Enter'); // tap between two polls
  assert.equal(inp.poll()[0], 1 << BTN.START, 'tap shorter than a frame is not lost');
  assert.equal(inp.poll()[0], 0);
  assert.equal(inp.keyDown('KeyP'), false, 'unbound keys are not swallowed');
});

test('remapping and gamepads', () => {
  const inp = new Input();
  inp.keys = { ...DEFAULT_KEYS, A: ['KeyK'] }; inp.rebuild();
  inp.keyDown('KeyK');
  assert.equal(inp.poll()[0], 1 << BTN.A);
  inp.clear();
  const pad = (pressed: number[], axes = [0, 0]) => ({ connected: true, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })) });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [pad([0]), pad([], [0.9, -0.9])] } });
  const m = inp.poll();
  assert.equal(m[0], 1 << BTN.B, 'bottom face button -> B (positional)');
  assert.equal(m[1], (1 << BTN.RIGHT) | (1 << BTN.UP), 'left stick acts as d-pad on port 2');
  assert.equal(padKind('Wireless Controller (Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(padKind('Pro Controller (Vendor: 057e)'), 'switch');
});

test('system detection by extension', () => {
  assert.equal(systemForFile('Game (USA).sfc')?.id, 'snes');
  assert.equal(systemForFile('x.GBA')?.id, 'gba');
  assert.equal(systemForFile('x.gen')?.id, 'genesis');
  assert.equal(systemForFile('x.txt'), undefined);
});

// ---------- settings ----------
test('per-game overrides merge over global settings', () => {
  const g = { settings: { video: { shader: 'crt' }, speed: { ffSpeed: 8 } } } as unknown as Game;
  const e = effective(DEFAULTS, g);
  assert.equal(e.video.shader, 'crt');
  assert.equal(e.video.aspect, DEFAULTS.video.aspect, 'untouched keys inherit');
  assert.equal(e.speed.ffSpeed, 8);
  assert.equal(e.audio.volume, DEFAULTS.audio.volume);
  assert.equal(effective(DEFAULTS, null), DEFAULTS);
});

// ---------- storage ----------
test('storage: games, roms, states, sram, cleanup, usage', async () => {
  const rom = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  const id = await sha256(rom);
  assert.equal(id.length, 32);
  const g: Game = { id, title: 'Test', system: 'nes', fileName: 't.nes', size: 5, addedAt: 1, lastPlayed: 0, playTime: 0, favorite: false };
  await db.putGame(g);
  await db.putRom(id, new Blob([rom]));
  await db.updateGame(id, { favorite: true, playTime: 42 });
  assert.equal((await db.game(id))?.favorite, true);
  assert.equal((await db.game(id))?.playTime, 42);
  assert.deepEqual(new Uint8Array(await (await db.rom(id))!.arrayBuffer()), new Uint8Array(rom));

  for (const slot of [0, 1, 2]) await db.putState({ id: `${id}:${slot}`, gameId: id, slot, state: new Blob([new Uint8Array(100).fill(slot)]), thumb: null, createdAt: slot, playTime: 1 });
  await db.putSram(id, new Uint8Array([9, 9, 9]));
  assert.equal((await db.states(id)).length, 3);
  assert.deepEqual(await db.sram(id), new Uint8Array([9, 9, 9]));
  const usage = await db.usage();
  assert.equal(usage[id], 5 + 300 + 3);

  await db.deleteState(id, 2);
  assert.equal((await db.states(id)).length, 2);
  await db.clearGame(id, true);
  assert.equal((await db.states(id)).length, 0);
  assert.equal(await db.sram(id), undefined);
  assert.ok(await db.game(id), 'keepGame keeps the library entry');
  await db.clearGame(id);
  assert.equal(await db.game(id), undefined);
});

test('backup export/import round-trips saves', async () => {
  const id = 'b'.repeat(32);
  await db.putGame({ id, title: 'Backup', system: 'snes', fileName: 'b.sfc', size: 1, addedAt: 1, lastPlayed: 1, playTime: 5, favorite: false });
  await db.putState({ id: `${id}:3`, gameId: id, slot: 3, state: new Blob([new Uint8Array([1, 2, 3])]), thumb: new Blob([new Uint8Array([7])], { type: 'image/webp' }), createdAt: 5, playTime: 5 });
  await db.putSram(id, new Uint8Array([4, 5, 6]));
  const file = await exportBackup();
  await db.clearGame(id);
  assert.equal(await db.game(id), undefined);
  assert.equal(await importBackup(file), 1);
  assert.equal((await db.game(id))?.title, 'Backup');
  const st = await db.state(id, 3);
  assert.deepEqual(new Uint8Array(await st!.state.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(st!.thumb?.type, 'image/webp');
  assert.deepEqual(await db.sram(id), new Uint8Array([4, 5, 6]));
  const bad = await new Response(new Blob(['{}']).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  await assert.rejects(importBackup(bad), /not a Kaiser backup/);
});
