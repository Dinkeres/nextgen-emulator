// GGPO-style rollback session. Transport-agnostic: `send` broadcasts a message to all peers,
// `receive` feeds messages from peers. Used in the emulation worker and in Node tests.
//
// Frame F is the next frame to simulate. Local input captured now applies to frame F+delay.
// Remote inputs are predicted (repeat last known); when the real input arrives and differs,
// we load the saved state at that frame and re-simulate to F without audio/video.

export interface RollbackCore {
  run(flags: number): void;
  setInput(port: number, mask: number): void;
  saveState(): Uint8Array;
  loadState(s: Uint8Array): boolean;
}

export type NetMsg =
  | { t: 'input'; from: number; start: number; masks: number[]; frame: number; ack: number }
  | { t: 'hash'; from: number; frame: number; hash: number }
  | { t: 'ping'; from: number; ts: number }
  | { t: 'pong'; from: number; to: number; ts: number }
  | { t: 'sync'; from: number; frame: number; state: Uint8Array };

export interface RollbackOpts {
  core: RollbackCore;
  localPort: number;          // -1 for spectators
  players: number[];          // ports in the session, e.g. [0, 1]
  inputDelay: number;         // frames (0-4)
  maxRollback: number;        // frames (0 = delay-based lockstep)
  send: (m: NetMsg) => void;
  onDesync?: (frame: number) => void;
  startState?: Uint8Array;
  hashInterval?: number;      // frames between desync checks
  now?: () => number;
}

export interface NetStats {
  frame: number; rollbacks: number; rollbackFrames: number; maxRollbackSeen: number; stalls: number;
  desyncs: number; resyncs: number;
  peers: { port: number; ping: number; advantage: number; lastFrame: number }[];
}

const RUN_VIDEO = 1, RUN_AUDIO = 2;
const HIST = 256; // ring size for inputs (frames)

export function fnv1a(d: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

class PlayerInput {
  masks = new Int32Array(HIST);
  frames = new Int32Array(HIST).fill(-1); // which frame each slot holds (confirmed)
  confirmed = -1;     // highest frame f such that all frames <= f are known
  lastKnown = 0;      // mask of the latest known frame (prediction)
  get(f: number): number | undefined { const i = f & (HIST - 1); return this.frames[i] === f ? this.masks[i] : undefined; }
  set(f: number, m: number) {
    const i = f & (HIST - 1);
    if (this.frames[i] === f) return false;
    this.frames[i] = f; this.masks[i] = m;
    while (this.get(this.confirmed + 1) !== undefined) { this.confirmed++; this.lastKnown = this.get(this.confirmed)!; }
    return true;
  }
}

export class Rollback {
  F = 0;
  private o: Required<Omit<RollbackOpts, 'startState' | 'onDesync'>> & Pick<RollbackOpts, 'onDesync'>;
  private inp = new Map<number, PlayerInput>();
  private used = new Map<number, Int32Array>(); // what we fed the core per port (to detect mispredictions)
  private states: (Uint8Array | null)[];
  private stateFrame: Int32Array;
  private rollbackTo = Infinity;
  private myHashes = new Map<number, number>();
  private theirHashes = new Map<string, number>();
  private peerFrame = new Map<number, number>();
  private peerAck = new Map<number, number>();
  private ping = new Map<number, number>();
  private advAvg = 0;
  private lastPing = 0;
  /** Host: set after a desync; the state is shipped once no predictions are outstanding. */
  resyncPending = false;
  st: NetStats = { frame: 0, rollbacks: 0, rollbackFrames: 0, maxRollbackSeen: 0, stalls: 0, desyncs: 0, resyncs: 0, peers: [] };

  constructor(opts: RollbackOpts) {
    this.o = { hashInterval: 60, now: () => performance.now(), ...opts } as typeof this.o;
    for (const p of opts.players) { this.inp.set(p, new PlayerInput()); this.used.set(p, new Int32Array(HIST).fill(-1)); }
    const n = Math.max(1, opts.maxRollback) + 2;
    this.states = new Array(n).fill(null);
    this.stateFrame = new Int32Array(n).fill(-1);
    if (opts.startState) opts.core.loadState(opts.startState);
    // frames before `delay` have no real local input: everyone agrees they're 0
    for (const p of opts.players) for (let f = 0; f < opts.inputDelay; f++) this.inp.get(p)!.set(f, 0);
  }

  private get spectator() { return this.o.localPort < 0; }

  /** Minimum confirmed frame across all players. */
  confirmedFrame(): number {
    let c = Infinity;
    for (const pi of this.inp.values()) c = Math.min(c, pi.confirmed);
    return c;
  }

  /** Called once per display tick. Returns whether a frame was simulated. */
  advance(localMask: number, render = true): { ran: boolean } {
    const now = this.o.now();
    if (now - this.lastPing > 1000) { this.lastPing = now; this.o.send({ t: 'ping', from: this.o.localPort, ts: now }); }

    // 1. record + send local input for F+delay (once per frame)
    if (!this.spectator) {
      const me = this.inp.get(this.o.localPort)!;
      const target = this.F + this.o.inputDelay;
      if (me.get(target) === undefined) me.set(target, localMask);
      this.sendInputs();
    }

    if (this.resyncPending && this.confirmedFrame() >= this.F - 1) { this.resyncPending = false; this.resyncFromHere(); }

    // 2. apply late-arriving inputs (rollback)
    if (this.rollbackTo < this.F) this.resimulate();
    this.rollbackTo = Infinity;

    // 3. stall if we'd exceed the rollback window (or need confirmed inputs)
    const conf = this.confirmedFrame();
    const window = this.spectator ? 0 : this.o.maxRollback;
    if (this.F - conf > window) { this.st.stalls++; return { ran: false }; }

    // 4. time sync: if we're consistently ahead of peers, wait a frame so they catch up
    if (!this.spectator && this.o.maxRollback > 0) {
      const adv = this.advantage();
      this.advAvg = this.advAvg * 0.9 + adv * 0.1;
      if (this.advAvg > 1.5 && this.F % 8 === 0) { this.advAvg -= 1; this.st.stalls++; return { ran: false }; }
    }

    this.step(this.F, render ? RUN_VIDEO | RUN_AUDIO : RUN_AUDIO);
    this.F++;
    this.st.frame = this.F;
    this.checkHash();
    return { ran: true };
  }

  private step(f: number, flags: number) {
    const slot = f % this.states.length;
    this.states[slot] = this.o.core.saveState();
    this.stateFrame[slot] = f;
    for (const [p, pi] of this.inp) {
      const known = pi.get(f);
      const m = known ?? pi.lastKnown;
      this.o.core.setInput(p, m);
      const u = this.used.get(p)!;
      u[f & (HIST - 1)] = known === undefined ? -1 - m : m; // negative = predicted
    }
    this.o.core.run(flags);
  }

  private resimulate() {
    const from = this.rollbackTo;
    const slot = from % this.states.length;
    if (this.stateFrame[slot] !== from) { // outside the window: shouldn't happen thanks to stalling
      return;
    }
    this.o.core.loadState(this.states[slot]!);
    const n = this.F - from;
    this.st.rollbacks++; this.st.rollbackFrames += n; this.st.maxRollbackSeen = Math.max(this.st.maxRollbackSeen, n);
    for (let f = from; f < this.F; f++) this.step(f, 0);
  }

  private sendInputs() {
    const me = this.inp.get(this.o.localPort)!;
    // resend everything peers haven't acknowledged (unreliable channel), capped
    let ack = Infinity;
    for (const p of this.o.players) if (p !== this.o.localPort) ack = Math.min(ack, this.peerAck.get(p) ?? -1);
    if (ack === Infinity) ack = me.confirmed - 1;
    const start = Math.max(ack + 1, me.confirmed - 63);
    const masks: number[] = [];
    for (let f = start; f <= me.confirmed; f++) masks.push(me.get(f) ?? 0);
    if (!masks.length) return;
    this.o.send({ t: 'input', from: this.o.localPort, start, masks, frame: this.F, ack: this.confirmedFrame() });
  }

  receive(m: NetMsg) {
    switch (m.t) {
      case 'input': {
        this.peerFrame.set(m.from, m.frame);
        this.peerAck.set(m.from, Math.max(this.peerAck.get(m.from) ?? -1, m.ack));
        const pi = this.inp.get(m.from);
        if (!pi) return;
        for (let i = 0; i < m.masks.length; i++) {
          const f = m.start + i;
          if (!pi.set(f, m.masks[i])) continue;
          if (f < this.F) {
            const used = this.used.get(m.from)![f & (HIST - 1)];
            const predicted = used < 0 ? -1 - used : used;
            if (used < 0 && predicted !== m.masks[i]) this.rollbackTo = Math.min(this.rollbackTo, f);
          }
        }
        break;
      }
      case 'ping': if (!this.spectator) this.o.send({ t: 'pong', from: this.o.localPort, to: m.from, ts: m.ts }); break;
      case 'pong': if (m.to === this.o.localPort) this.ping.set(m.from, this.o.now() - m.ts); break;
      case 'hash': {
        this.theirHashes.set(m.from + ':' + m.frame, m.hash);
        this.compareHash(m.frame, m.from);
        break;
      }
      case 'sync': {
        // authoritative state from the host after a desync
        this.o.core.loadState(m.state);
        this.F = m.frame;
        this.rollbackTo = Infinity;
        for (let i = 0; i < this.stateFrame.length; i++) this.stateFrame[i] = -1;
        this.myHashes.clear(); this.theirHashes.clear();
        this.st.resyncs++;
        break;
      }
    }
  }

  private advantage(): number {
    let adv = -Infinity;
    for (const p of this.o.players) {
      if (p === this.o.localPort) continue;
      const pf = this.peerFrame.get(p);
      if (pf === undefined) continue;
      const lag = (this.ping.get(p) ?? 0) / 2 / (1000 / 60);
      adv = Math.max(adv, this.F - (pf + lag));
    }
    return adv === -Infinity ? 0 : adv;
  }

  private checkHash() {
    // only frames we've actually simulated (inputs can be confirmed ahead of F)
    const c = Math.min(this.confirmedFrame(), this.F - 1);
    const k = Math.floor(c / this.o.hashInterval) * this.o.hashInterval;
    if (k <= 0 || this.myHashes.has(k)) return;
    const slot = k % this.states.length;
    if (this.stateFrame[slot] !== k) { this.myHashes.set(k, -1); return; } // already rotated out
    const h = fnv1a(this.states[slot]!);
    this.myHashes.set(k, h);
    if (this.myHashes.size > 32) this.myHashes.delete(this.myHashes.keys().next().value!);
    if (!this.spectator) this.o.send({ t: 'hash', from: this.o.localPort, frame: k, hash: h });
    for (const p of this.o.players) this.compareHash(k, p);
  }

  private compareHash(frame: number, from: number) {
    const mine = this.myHashes.get(frame), theirs = this.theirHashes.get(from + ':' + frame);
    if (mine === undefined || theirs === undefined || mine === -1) return;
    this.theirHashes.delete(from + ':' + frame);
    if (mine !== theirs) { this.st.desyncs++; this.o.onDesync?.(frame); }
  }

  getHash(frame: number) { return this.myHashes.get(frame); }

  /** Host side of a resync: ship the current state to everyone. */
  resyncFromHere() {
    const state = this.o.core.saveState();
    this.o.send({ t: 'sync', from: this.o.localPort, frame: this.F, state });
    for (let i = 0; i < this.stateFrame.length; i++) this.stateFrame[i] = -1;
    this.myHashes.clear(); this.theirHashes.clear();
  }

  stats(): NetStats {
    this.st.peers = this.o.players.filter(p => p !== this.o.localPort).map(p => ({
      port: p, ping: Math.round(this.ping.get(p) ?? -1), advantage: +this.advAvg.toFixed(1), lastFrame: this.peerFrame.get(p) ?? -1,
    }));
    return { ...this.st };
  }
}
