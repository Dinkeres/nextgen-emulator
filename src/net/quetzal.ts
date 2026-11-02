// Pokémon Quetzal "Mplayer" co-op over the network, without a lockstep link cable.
//
// Quetzal's Mplayer (by TenmaRH) talks over the GBA link cable with small 8-word messages. Instead
// of emulating the cable cycle-exactly (two GBAs per machine, input delay: slow on weak devices),
// each player runs only their own game and we stand in for the cable: we take what the game queued
// for sending, ship it to the partner, and drop the partner's messages into the game's receive
// queue, keeping the game's link-health fields happy. The overworld tolerates latency well.
//
// The RAM/ROM addresses and the approach come from Quetzal Online by Lost
// (https://github.com/OneLostGamer/Quetzal-Online); they are specific to Quetzal Alpha 9, so the
// ROM is checked byte-for-byte before this is enabled.

export interface Bus {
  read8(a: number): number; read16(a: number): number; read32(a: number): number;
  write8(a: number, v: number): void; write16(a: number, v: number): void;
}

/** One frame of cable traffic: our link state, queued link messages, "session started". */
export type QzMsg = { s?: number; c?: number[][]; g?: 1 };

const GL = 0x3003510;                                   // gLink
const SENDQ = GL + 0x18, SENDPOS = GL + 0x338, SENDCNT = GL + 0x339;
const RECVQ = GL + 0x33c, RECVPOS = GL + 0xfbc, RECVCNT = GL + 0xfbd;
const CAP = 50;                                         // queue slots
const WATCHDOG = 0x3000d8c, HS_COUNT = 0x3000d93;
const CB2 = 0x3002664, CB2_OVERWORLD = 0x80c2989;
const HANDSHAKE = 2, INIT_TIMER = 3, CONNECTED = 4;
const HERE_I_AM = 0xbebe;                               // Mplayer's per-frame position message
const ROM = 0x8000000;
// With no cable plugged in, the game would decide "joiner, player 0"; patch (RAM copy of the ROM
// only, during a session) the two routines that read the role and player number from the port.
const PATCHES = [
  { at: 0xd4e4, orig: [0x6801, 0x200c, 0x4001], host: [0x2108, 0x46c0, 0x46c0], join: [0x210c, 0x46c0, 0x46c0] },
  { at: 0xc1ca, orig: [0x4803, 0x6800, 0x0680, 0x0f80], host: [0x2000, 0x46c0, 0x46c0, 0x46c0], join: [0x2001, 0x46c0, 0x46c0, 0x46c0] },
];

/** True for the exact build this module knows (Pokémon Quetzal, Alpha 9 link code). */
export function isQuetzal(rom: Uint8Array): boolean {
  const ascii = (o: number, n: number) => String.fromCharCode(...rom.subarray(o, o + n));
  if (ascii(0xa0, 11) !== 'PKM QUETZAL' || ascii(0xac, 4) !== 'BPEE') return false;
  return PATCHES.every(p => p.orig.every((v, i) => (rom[p.at + i * 2] | rom[p.at + i * 2 + 1] << 8) === v));
}

export class QuetzalLink {
  private n = 0;
  private phase: 'idle' | 'handshake' | 'connected' = 'idle';
  private sawOverworld = false;
  private partnerState = 0;
  private lastHeard = -1;
  private goReceived = false;
  private partnerQ: number[][] = [];
  private lastPartner: number[] | null = null;
  private lastSelf: number[] | null = null;
  private lastSentState = -1;
  private away = 0;
  private cableLost = false;
  private patched = false;
  private out: QzMsg = {};
  /** Human-readable status for the UI. */
  status = 'Open START → MPLAYER → 2P';
  onStatus?: (s: string) => void;

  private bus: Bus;
  readonly host: boolean;
  private send: (m: QzMsg) => void;
  constructor(bus: Bus, host: boolean, send: (m: QzMsg) => void) { this.bus = bus; this.host = host; this.send = send; }

  receive(m: QzMsg) {
    this.lastHeard = this.n;
    if (m.c) this.partnerQ.push(...m.c);
    if (m.s !== undefined) this.partnerState = m.s;
    if (m.g) { if (this.phase === 'handshake') this.goReceived = true; this.partnerState = CONNECTED; }
  }

  /** Call once after every emulated frame. */
  frame() {
    const b = this.bus;
    this.n++;
    // the partner reports in every few frames; 5 s of silence means they're gone
    const alive = this.lastHeard >= 0 && this.n - this.lastHeard <= 300;
    const st = b.read8(GL + 1);
    if (b.read32(CB2) === CB2_OVERWORLD) this.sawOverworld = true;
    if (this.n % 4 === 0 || st !== this.lastSentState) { this.out.s = st; this.lastSentState = st; }

    if (this.phase === 'idle') {
      // after the first visit to the overworld a handshake may start anywhere (battles and trades
      // reopen the link from their own screens)
      if (this.sawOverworld && st >= 1 && st <= HANDSHAKE && alive && this.partnerState >= 1) {
        this.phase = 'handshake'; this.goReceived = false; this.setPatches(true);
        this.say(this.host ? 'Partner found — press A to start' : 'Partner found — waiting for the host');
      }
    } else if (this.phase === 'handshake') {
      if (st === 0) this.toIdle('Link closed');
      else {
        // the host's game asks to start (A in the menu, or after a battle/trade); go only once
        // the partner is in the handshake too
        if (this.host && st === HANDSHAKE && b.read8(GL + 0xe) && this.partnerState >= HANDSHAKE) {
          b.write8(GL + 1, INIT_TIMER); b.write16(GL + 4, 0x8fff); this.healthy();
        }
        if (this.host && b.read8(GL + 1) >= INIT_TIMER) {
          b.write8(GL + 1, CONNECTED); this.out.g = 1; this.healthy(); this.connected();
        } else if (!this.host && this.goReceived) {
          b.write8(GL + 1, CONNECTED); b.write16(GL + 4, 0x8fff); this.healthy(); this.connected();
        } else this.fakeHandshake();
      }
    } else {
      if (st === 0) this.toIdle('Session ended');
      else if (!alive) this.toIdle('Partner disconnected');
      else {
        if (this.host && this.partnerState >= 1 && this.partnerState < CONNECTED && this.n % 8 === 0) this.out.g = 1;
        // partner left the session (whiteout, reset...): after a grace period stop faking a healthy
        // cable so our game notices, like it would with a real cable going quiet
        this.away = this.partnerState < CONNECTED ? this.away + 1 : 0;
        if (this.away > 90) { if (!this.cableLost) { this.cableLost = true; this.say('Partner left the session'); } }
        else this.relay();
      }
    }
    if (this.out.s !== undefined || this.out.c || this.out.g) { this.send(this.out); this.out = {}; }
  }

  /** Session over (partner left, or we leave): put the game's code back. */
  stop() { this.setPatches(false); this.phase = 'idle'; }

  private connected() { this.phase = 'connected'; this.away = 0; this.cableLost = false; this.say('Co-op running'); }
  private say(s: string) { this.status = s; this.onStatus?.(s); }

  private toIdle(why: string) {
    this.phase = 'idle'; this.goReceived = false; this.away = 0; this.cableLost = false;
    this.lastPartner = this.lastSelf = null; this.partnerQ = [];
    this.setPatches(false);
    this.say(why);
  }

  private setPatches(on: boolean) {
    if (on === this.patched) return;
    for (const p of PATCHES) (on ? (this.host ? p.host : p.join) : p.orig).forEach((v, i) => this.bus.write16(ROM + p.at + i * 2, v));
    this.patched = on;
  }

  /** What a finished cable handshake leaves in gLink, held while both games wait. */
  private fakeHandshake() {
    const b = this.bus;
    b.write8(WATCHDOG, 0);
    if (b.read8(GL + 1) !== HANDSHAKE) return;
    b.write8(GL, this.host ? 8 : 0); b.write8(GL + 2, this.host ? 0 : 1); b.write8(GL + 3, 2);
    b.write16(GL + 4, 0xb9a0); b.write16(GL + 6, 0xb9a0); b.write16(GL + 8, 0xffff); b.write16(GL + 10, 0xffff);
    b.write8(GL + 0xf, 1); b.write8(HS_COUNT, 2);
  }

  /** No hardware/checksum/queue/lag errors, watchdog fed. */
  private healthy() {
    const b = this.bus;
    for (let i = 0x10; i <= 0x13; i++) b.write8(GL + i, 0);
    b.write8(GL + 0xd, b.read8(GL) ? 9 : 0);
    b.write8(WATCHDOG, 0);
  }

  private relay() {
    const b = this.bus;
    const me = b.read8(GL + 2), other = 1 - me;
    // outgoing: drain the game's send queue
    const spos = b.read8(SENDPOS), scnt = b.read8(SENDCNT);
    const sent: number[][] = [];
    for (let k = 0; k < scnt; k++) {
      const slot = (spos + k) % CAP, cmd: number[] = [];
      for (let j = 0; j < 8; j++) cmd.push(b.read16(SENDQ + (j * CAP + slot) * 2));
      if (cmd[0] === HERE_I_AM) this.lastSelf = cmd;
      sent.push(cmd);
    }
    b.write8(SENDPOS, (spos + scnt) % CAP); b.write8(SENDCNT, 0);
    if (sent.length) this.out.c = sent;

    // incoming: a cable delivers every player's message for a slot together
    const rpos = b.read8(RECVPOS);
    let rcnt = b.read8(RECVCNT);
    const put = (mine: number[] | null, theirs: number[] | null) => {
      const slot = (rpos + rcnt) % CAP;
      for (let j = 0; j < 8; j++) for (let p = 0; p < 4; p++) {
        const v = p === me ? mine?.[j] : p === other ? theirs?.[j] : 0;
        b.write16(RECVQ + ((p * 8 + j) * CAP + slot) * 2, v ?? 0);
      }
      rcnt++;
    };
    // falling behind: position messages only matter as the newest one, keep everything else
    if (this.partnerQ.length > 4) {
      let newest = -1;
      for (let i = this.partnerQ.length - 1; i >= 0; i--) if (this.partnerQ[i][0] === HERE_I_AM) { newest = i; break; }
      this.partnerQ = this.partnerQ.filter((c, i) => c[0] !== HERE_I_AM || i === newest);
    }
    const take = () => { const c = this.partnerQ.shift() ?? null; if (c?.[0] === HERE_I_AM) this.lastPartner = c; return c; };
    for (const cmd of sent) {
      if (rcnt >= CAP) break;
      put(cmd, take() ?? this.lastPartner); // the cable always carries the partner's latest position
    }
    while (this.partnerQ.length && rcnt < 3) put(this.lastSelf, take());
    b.write8(RECVCNT, rcnt);
    this.healthy();
  }
}
