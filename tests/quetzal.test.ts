// Quetzal co-op bridge on a fake GBA bus: handshake to "connected", then messages cross over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuetzalLink, isQuetzal, type QzMsg, type Bus } from '../src/net/quetzal.ts';

const GL = 0x3003510, CAP = 50;
function fakeBus(): Bus & { mem: Map<number, number> } {
  const mem = new Map<number, number>();
  const r8 = (a: number) => mem.get(a) ?? 0;
  return {
    mem, read8: r8, read16: a => r8(a) | r8(a + 1) << 8, read32: a => (r8(a) | r8(a + 1) << 8 | r8(a + 2) << 16 | r8(a + 3) << 24) >>> 0,
    write8: (a, v) => { mem.set(a, v & 255); }, write16(a, v) { this.write8(a, v); this.write8(a + 1, v >> 8); },
  };
}

test('isQuetzal rejects other ROMs', () => assert.equal(isQuetzal(new Uint8Array(0x100000)), false));

test('two games handshake and exchange link messages', () => {
  const bus = [fakeBus(), fakeBus()];
  const inbox: QzMsg[][] = [[], []];
  const link = [0, 1].map(i => new QuetzalLink(bus[i], i === 0, m => inbox[1 - i].push(structuredClone(m))));
  const frame = () => { for (const i of [0, 1]) { link[i].frame(); for (const m of inbox[i].splice(0)) link[i].receive(m); } };
  for (const b of bus) { b.write16(0x3002664, 0x2989); b.write16(0x3002666, 0x080c); b.write8(GL + 1, 2); } // overworld, handshake
  for (let i = 0; i < 10; i++) frame();
  bus[0].write8(GL + 0xe, 1); // host pressed A
  for (let i = 0; i < 10; i++) frame();
  assert.deepEqual([bus[0].read8(GL + 1), bus[1].read8(GL + 1)], [4, 4], 'both connected');
  // host queues one message; the joiner receives it in player 0's slot
  for (let j = 0; j < 8; j++) bus[0].write16(GL + 0x18 + (j * CAP) * 2, 0x1000 + j);
  bus[0].write8(GL + 0x339, 1);
  bus[1].write8(GL + 0x338, 0); bus[1].write8(GL + 0x339, 1); // joiner sends one too (a cable swaps both)
  frame(); frame();
  const n = bus[1].read8(GL + 0xfbd);
  const slot = [...Array(n).keys()].find(k => bus[1].read16(GL + 0x33c + k * 2) === 0x1000);
  assert.notEqual(slot, undefined, 'host message arrives in player 0 column');
  assert.equal(bus[1].read16(GL + 0x33c + (7 * CAP + slot!) * 2), 0x1007);
});
