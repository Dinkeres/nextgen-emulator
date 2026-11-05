// The Soul Link tracker on a fake GBA bus laid out like FireRed's memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoulTracker, readMon, place, type SoulReport } from '../src/net/soullink.ts';
import type { Bus } from '../src/net/quetzal.ts';

const PARTY = 0x2024284, COUNT = 0x2024029, SAVE = 0x2025000, STORAGE = 0x2030000;
function fakeBus(): Bus {
  const mem = new Map<number, number>();
  const r8 = (a: number) => mem.get(a) ?? 0;
  return {
    read8: r8, read16: a => r8(a) | r8(a + 1) << 8, read32: a => (r8(a) | r8(a + 1) << 8 | r8(a + 2) << 16 | r8(a + 3) << 24) >>> 0,
    write8: (a, v) => { mem.set(a, v & 255); }, write16(a, v) { this.write8(a, v); this.write8(a + 1, v >> 8); },
  };
}
const w32 = (b: Bus, a: number, v: number) => { b.write16(a, v & 0xffff); b.write16(a + 2, v >>> 16); };

/** Writes a Pokémon the way the game stores it: 48 encrypted bytes, checksum over the plain words. */
function putMon(b: Bus, at: number, pid: number, species: number, nick: number[], hp: number) {
  const ot = 0x12345678, key = (pid ^ ot) >>> 0;
  w32(b, at, pid); w32(b, at + 4, ot);
  nick.concat(0xff).forEach((c, i) => b.write8(at + 8 + i, c));
  const plain = new Array(12).fill(0);
  const growth = [0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3][pid % 24];
  plain[growth * 3] = species;
  let sum = 0;
  plain.forEach((w, i) => { sum = (sum + (w & 0xffff) + (w >>> 16)) & 0xffff; w32(b, at + 32 + i * 4, (w ^ key) >>> 0); });
  b.write16(at + 28, sum);
  b.write8(at + 84, 5); b.write16(at + 86, hp);
}

function game() {
  const b = fakeBus();
  w32(b, 0x3005008, SAVE); w32(b, 0x3005010, STORAGE);
  b.write8(0x2036dfc + 0x14, 101); // Route 1
  const reports: SoulReport[] = [];
  const t = new SoulTracker(b, r => reports.push(r));
  const run = (looks = 1) => { for (let i = 0; i < looks * 20; i++) t.frame(); };
  return { b, t, reports, run };
}
const PIDGEY = [0xca, 0xc3, 0xbe, 0xc1, 0xbf, 0xd3]; // PIDGEY

test('every encryption order decodes species, and bad data is rejected', () => {
  for (let pid = 0; pid < 24; pid++) {
    const b = fakeBus();
    putMon(b, 0x2000000, pid + 24 * 7, 25, PIDGEY, 20);
    assert.equal(readMon(b, 0x2000000)?.species, 25, `order ${pid}`);
    assert.equal(readMon(b, 0x2000000)?.nick, 'PIDGEY');
    b.write8(0x2000000 + 40, b.read8(0x2000000 + 40) ^ 1);
    assert.equal(readMon(b, 0x2000000), null, 'checksum catches corruption');
  }
});

test('the same route name is one route', () => {
  assert.equal(place(99).area, 'Route 4');
  assert.equal(place(99).sec, place(104).sec);
  assert.equal(place(101).area, 'Route 1');
});

test('nothing is reported before the game has started', () => {
  const { b, reports, run } = game();
  w32(b, 0x3005008, 0);
  run(5);
  assert.deepEqual(reports, []);
});

test('a catch, a faint, and a Pokémon the team lost stays fainted through healing', () => {
  const { b, t, reports, run } = game();
  b.write8(COUNT, 2);
  putMon(b, PARTY, 111, 1, PIDGEY, 20);
  putMon(b, PARTY + 100, 222, 16, PIDGEY, 18);
  run();
  assert.deepEqual(reports.filter(r => r.k === 'catch').map(r => (r as { pid: string }).pid), ['6f', 'de']);
  assert.equal(reports.filter(r => r.k === 'pos').length, 1);
  run(3);
  assert.equal(reports.filter(r => r.k === 'catch').length, 2, 'reported once');

  b.write16(PARTY + 86, 0);
  run(2);
  assert.deepEqual(reports.filter(r => r.k === 'faint'), [{ k: 'faint', pid: '6f' }]);

  t.setDead(['de']); // a teammate's death reached this game
  run();
  assert.equal(b.read16(PARTY + 100 + 86), 0, 'forced to faint');
  b.write16(PARTY + 100 + 86, 30);     // Pokémon Center
  run();
  assert.equal(b.read16(PARTY + 100 + 86), 0, 'stays fainted');
  assert.equal(reports.filter(r => r.k === 'faint').length, 1, 'the server already knows about that one');
});

test('a wild battle without a catch uses the route up, once you own a ball', () => {
  const { b, reports, run } = game();
  const battle = (outcome: number, trainer = false) => {
    b.write8(0x2023e8a, outcome); w32(b, 0x2022b4c, trainer ? 8 : 0);
    b.write8(0x30030f0 + 0x439, 2); run();
    b.write8(0x30030f0 + 0x439, 0); run();
  };
  const misses = () => reports.filter(r => r.k === 'miss').length;
  battle(4);
  assert.equal(misses(), 0, 'no balls yet');
  b.write16(SAVE + 0x430, 4);
  battle(1, true);
  assert.equal(misses(), 0, 'trainer battles never count');
  battle(7);
  assert.equal(misses(), 0, 'caught it');
  battle(4);
  assert.deepEqual(reports.filter(r => r.k === 'miss'), [{ k: 'miss', sec: '101', area: 'Route 1' }]);
});

test('badges, the end credits, and catches that went to the PC', () => {
  const { b, reports, run } = game();
  b.write8(SAVE + 0xee0 + (0x820 >> 3), 0b11);
  putMon(b, STORAGE + 4 + 80 * 37, 333, 19, PIDGEY, 0);
  run(16);
  assert.deepEqual(reports.find(r => r.k === 'pos'), { k: 'pos', area: 'Route 1', badges: 2 });
  assert.ok(reports.some(r => r.k === 'catch' && r.pid === (333).toString(16)));
  b.write8(SAVE + 0xee0 + (0x82c >> 3), 1 << (0x82c & 7));
  run(2);
  assert.equal(reports.filter(r => r.k === 'clear').length, 1);
});
