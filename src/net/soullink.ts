// The Soul Link tracker: reads a FireRed-based game's memory a few times a second and reports what
// happened (catches, faints, failed encounters, where the player is, badges, the end credits).
// The rules live on the server (Horizon backend, runs.js); this only reports, and keeps fainted
// whatever the server says is dead, so a Pokémon Center can't bring it back.
//
// Addresses are FireRed 1.0 (USA), from the pokefirered decompilation and checked against the ROM's
// literal pools. Radical Red is built on that ROM; anything it moved reads as "nothing here" (the
// checksums below reject garbage), so the worst case is a missed report, never a corrupted game.
import type { Bus } from './quetzal.ts';
import { FIRST_MAPSEC, MAPSECS } from './mapsecs.ts';

const PARTY = 0x2024284, PARTY_COUNT = 0x2024029, MON_SIZE = 100, BOX_MON_SIZE = 80;
const SAVE1 = 0x3005008, STORAGE = 0x3005010;
const MAIN_FLAGS = 0x30030f0 + 0x439, IN_BATTLE = 2;
const BATTLE_TYPE = 0x2022b4c, BATTLE_TRAINER = 8, OUTCOME = 0x2023e8a, CAUGHT = 7;
const MAP_SECTION = 0x2036dfc + 0x14;
const FLAGS = 0xee0, FLAG_BADGE1 = 0x820, FLAG_CLEAR = 0x82c, BALLS = 0x430, BALL_SLOTS = 13;
const BOXES = 14, BOX_SLOTS = 30;
const EVERY = 20;            // frames between looks (3 a second)
const PC_EVERY = 15;         // looks between PC scans (5 seconds)
const UNKNOWN = 'Somewhere';

export type SoulReport =
  | { k: 'pos'; area: string; badges: number }
  | { k: 'catch'; pid: string; nick: string; species: number; level: number; sec: string; area: string }
  | { k: 'miss'; sec: string; area: string }
  | { k: 'faint'; pid: string }
  | { k: 'clear' };

const CHARS: Record<number, string> = { 0: ' ', 0xab: '!', 0xac: '?', 0xad: '.', 0xae: '-', 0xb4: "'", 0xb5: '♂', 0xb6: '♀' };
for (let i = 0; i < 10; i++) CHARS[0xa1 + i] = String(i);
for (let i = 0; i < 26; i++) { CHARS[0xbb + i] = String.fromCharCode(65 + i); CHARS[0xd5 + i] = String.fromCharCode(97 + i); }

/** The game's own name of the place: the same name is one route, whichever piece of it you're on. */
export function place(section: number): { sec: string; area: string } {
  const area = MAPSECS[section - FIRST_MAPSEC] ?? '';
  return { sec: String(MAPSECS.indexOf(area) + FIRST_MAPSEC), area: area || UNKNOWN };
}

/** Which of the 24 orders the 4 encrypted parts are in, per pokefirered's GetSubstruct: growth first. */
const GROWTH_AT = [0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3];

interface Mon { pid: string; species: number; nick: string }

/** The Pokémon at `at` (party or PC record), or null if nothing valid is there. */
export function readMon(b: Bus, at: number): Mon | null {
  const pid = b.read32(at), ot = b.read32(at + 4);
  if (!pid && !ot) return null;
  const key = (pid ^ ot) >>> 0;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const w = (b.read32(at + 32 + i * 4) ^ key) >>> 0;
    sum = (sum + (w & 0xffff) + (w >>> 16)) & 0xffff;
  }
  if (sum !== b.read16(at + 28)) return null;
  const growth = (b.read32(at + 32 + GROWTH_AT[pid % 24] * 12) ^ key) >>> 0;
  const species = growth & 0xffff;
  if (!species) return null;
  let nick = '';
  for (let i = 0; i < 10; i++) {
    const c = b.read8(at + 8 + i);
    if (c === 0xff) break;
    nick += CHARS[c] ?? '';
  }
  return { pid: pid.toString(16), species, nick: nick.trim() };
}

export class SoulTracker {
  private frames = 0;
  private looks = 0;
  private dead = new Set<string>();
  private seen = new Set<string>();
  private fainted = new Set<string>();
  private inBattle = false;
  private wild = false;
  private lastPos = '';
  private cleared = false;

  private b: Bus;
  private send: (r: SoulReport) => void;

  constructor(b: Bus, send: (r: SoulReport) => void) { this.b = b; this.send = send; }

  /** The Pokémon that must stay fainted in this game. */
  setDead(pids: string[]) { this.dead = new Set(pids); }

  frame() {
    if (++this.frames % EVERY) return;
    const b = this.b, save = b.read32(SAVE1);
    if (save >>> 24 !== 2) return; // not in a game yet (title screen, intro)
    this.looks++;
    const battling = !!(b.read8(MAIN_FLAGS) & IN_BATTLE);
    const here = place(b.read8(MAP_SECTION));
    if (here.area === UNKNOWN) return; // the title screen, or a place this game added
    this.party(battling, here);
    if (this.looks % PC_EVERY === 0 && !battling) this.pc(save, here);

    if (battling && !this.inBattle) this.wild = !(b.read32(BATTLE_TYPE) & BATTLE_TRAINER);
    if (!battling && this.inBattle && this.wild && b.read8(OUTCOME) !== CAUGHT && this.hasBalls(save)) {
      this.send({ k: 'miss', ...here }); // the first encounter of a route counts, caught or not
    }
    this.inBattle = battling;
    if (battling) return;

    let badges = 0;
    for (let i = 0; i < 8; i++) if (this.flag(save, FLAG_BADGE1 + i)) badges++;
    const pos = `${here.area}/${badges}`;
    if (pos !== this.lastPos) { this.lastPos = pos; this.send({ k: 'pos', area: here.area, badges }); }
    if (!this.cleared && this.flag(save, FLAG_CLEAR)) { this.cleared = true; this.send({ k: 'clear' }); }
  }

  private party(battling: boolean, here: { sec: string; area: string }) {
    const b = this.b, count = Math.min(b.read8(PARTY_COUNT), 6);
    for (let i = 0; i < count; i++) {
      const at = PARTY + i * MON_SIZE, mon = readMon(b, at);
      if (!mon) continue;
      this.caught(mon, b.read8(at + 84), here);
      const hp = b.read16(at + 86);
      if (this.dead.has(mon.pid)) { if (hp && !battling) b.write16(at + 86, 0); continue; }
      if (!hp && !this.fainted.has(mon.pid)) { this.fainted.add(mon.pid); this.send({ k: 'faint', pid: mon.pid }); }
    }
  }

  /** A catch with a full party goes straight to the PC. */
  private pc(save: number, here: { sec: string; area: string }) {
    const storage = this.b.read32(STORAGE);
    if (storage >>> 24 !== 2 || !save) return;
    for (let i = 0; i < BOXES * BOX_SLOTS; i++) {
      const mon = readMon(this.b, storage + 4 + i * BOX_MON_SIZE);
      if (mon) this.caught(mon, 0, here);
    }
  }

  private caught(mon: Mon, level: number, here: { sec: string; area: string }) {
    if (this.seen.has(mon.pid)) return;
    this.seen.add(mon.pid);
    this.send({ k: 'catch', pid: mon.pid, nick: mon.nick, species: mon.species, level, ...here });
  }

  private flag(save: number, n: number) { return !!(this.b.read8(save + FLAGS + (n >> 3)) & 1 << (n & 7)); }

  /** Before the first Poké Ball you can't catch anything, so those battles don't use the route up. */
  private hasBalls(save: number) {
    for (let i = 0; i < BALL_SLOTS; i++) if (this.b.read16(save + BALLS + i * 4)) return true;
    return false;
  }
}
