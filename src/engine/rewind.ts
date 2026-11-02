// Rewind ring buffer: stores XOR deltas between consecutive save states, zero-run compressed.
// Deltas chain backwards from `current`, so popping restores the previous state exactly.

/** Encode a = a XOR b as [zeroRun varint][litLen varint][lit...]* . */
export function xorEncode(cur: Uint8Array, prev: Uint8Array, out: Uint8Array): number {
  const n = cur.length;
  let i = 0, o = 0;
  const varint = (v: number) => { while (v >= 0x80) { out[o++] = (v & 0x7f) | 0x80; v >>>= 7; } out[o++] = v; };
  while (i < n) {
    let z = i;
    while (z < n && cur[z] === prev[z]) z++;
    varint(z - i);
    i = z;
    if (i >= n) { varint(0); break; }
    // literal run until we see 4+ equal bytes in a row (cheap heuristic)
    let l = i, same = 0;
    while (l < n) {
      if (cur[l] === prev[l]) { if (++same >= 4) { l -= 3; break; } } else same = 0;
      l++;
    }
    if (l > n) l = n;
    varint(l - i);
    for (let k = i; k < l; k++) out[o++] = cur[k] ^ prev[k];
    i = l;
    if (o > out.length - 16) return -1; // not compressible enough; caller stores raw
  }
  return o;
}

/** state ^= delta (in place). */
export function xorApply(state: Uint8Array, delta: Uint8Array) {
  let i = 0, p = 0;
  const varint = () => { let v = 0, s = 0, b; do { b = delta[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v; };
  while (p < delta.length) {
    i += varint();
    if (p >= delta.length) break;
    const l = varint();
    for (let k = 0; k < l; k++) state[i + k] ^= delta[p++];
    i += l;
  }
}

export class RewindBuffer {
  private deltas: Uint8Array[] = [];
  private bytes = 0;
  private current: Uint8Array | null = null;
  private scratch = new Uint8Array(0);
  budgetBytes: number;
  constructor(budgetBytes: number) { this.budgetBytes = budgetBytes; }

  get length() { return this.deltas.length; }
  get usedBytes() { return this.bytes; }

  clear() { this.deltas = []; this.bytes = 0; this.current = null; }

  push(state: Uint8Array) {
    if (!this.current || this.current.length !== state.length) { this.current = state.slice(); this.deltas = []; this.bytes = 0; return; }
    if (this.scratch.length < state.length * 2 + 64) this.scratch = new Uint8Array(state.length * 2 + 64);
    // delta lets us go from `state` back to `current` (the older one)
    const n = xorEncode(state, this.current, this.scratch);
    const d = n < 0 ? rawDelta(state, this.current) : this.scratch.slice(0, n);
    this.deltas.push(d);
    this.bytes += d.length;
    this.current.set(state);
    while (this.bytes > this.budgetBytes && this.deltas.length > 1) this.bytes -= this.deltas.shift()!.length;
  }

  /** Step one snapshot back; returns the restored state (owned by the buffer) or null if empty. */
  pop(): Uint8Array | null {
    const d = this.deltas.pop();
    if (!d || !this.current) return null;
    this.bytes -= d.length;
    xorApply(this.current, d);
    return this.current;
  }
}

function rawDelta(cur: Uint8Array, prev: Uint8Array): Uint8Array {
  // single literal covering the whole state: [0][len][xor bytes]
  const out = new Uint8Array(cur.length + 12);
  let o = 0;
  out[o++] = 0;
  let v = cur.length; while (v >= 0x80) { out[o++] = (v & 0x7f) | 0x80; v >>>= 7; } out[o++] = v;
  for (let k = 0; k < cur.length; k++) out[o++] = cur[k] ^ prev[k];
  return out.subarray(0, o);
}
