// Soul Link runs: named runs on the shared account server (Horizon's backend, runs.js), friends,
// and the live connection a lobby or a running game keeps to its run.
import { ACCOUNT_API, authToken } from './account.ts';
import type { Game } from './db.ts';
import { romFor } from './library.ts';
import type { SoulReport } from '../net/soullink.ts';

export type Mode = 'soullink' | 'race';
export const MODE_INFO: Record<Mode, { name: string; blurb: string }> = {
  soullink: { name: 'Soul Link', blurb: 'One team of 2 or 3. Finish the game together. If a player runs out of Pokémon, the run is over.' },
  race: { name: 'Team race', blurb: 'Up to 3 teams and 6 players. A wiped team restarts while the others play on. First team to finish wins.' },
};

export interface RunPlayer { id: number; name: string; team: number; ready: boolean; online: boolean }
export interface Slot { pid: string; nick: string; species: number; level: number; dead?: boolean }
export interface Route { sec: string; area: string; status: 'open' | 'linked' | 'dead'; slots: Record<string, Slot> }
export interface TeamState { members: number[]; attempt: number; resets: number; routes: Record<string, Route>; dead: Record<string, string[]> }
export interface RunState { teams: Record<string, TeamState>; players: Record<string, { team: number; area: string; badges: number }>; finished?: { winner: number | null } }
export interface Run {
  id: string; name: string; mode: Mode; game_id: string; game_title: string; host: number; status: 'lobby' | 'playing' | 'done';
  created: number; started: number | null; ended: number | null; winner: number | null; state: RunState | null;
  players: RunPlayer[]; rules: { teams: [number, number]; perTeam: [number, number]; total: number };
}
export interface RunRow {
  id: string; name: string; mode: Mode; game_id: string; game_title: string; status: Run['status']; created: number;
  started: number | null; ended: number | null; winner: number | null; team: number; deaths: number; resets: number;
}
export interface Invite { id: string; name: string; mode: Mode; game_id: string; game_title: string; host: string }
export interface Friend { id: number; username: string; online?: boolean; status?: string }
export interface Friends { friends: Friend[]; incoming: { id: number; username: string }[]; outgoing: { id: number; username: string }[] }
export interface RunEvent { id: number; at: number; team: number | null; attempt: number; user_id: number; kind: string; data: Record<string, unknown> }
export type Happened = Record<string, unknown> & { kind: string; team: number; who: number };

async function call<T>(path: string, body?: object): Promise<T> {
  let r: Response;
  try {
    r = await fetch(ACCOUNT_API + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken()}` },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the run server. Check your connection and try again.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || j.ok === false) throw new Error(j.error || `The run server answered ${r.status}.`);
  return j as T;
}

export const runsApi = {
  list: () => call<{ runs: RunRow[]; invites: Invite[] }>('/api/runs'),
  create: (b: { name: string; mode: Mode; gameId: string; gameTitle: string }) => call<{ id: string }>('/api/runs', b),
  detail: (id: string) => call<{ run: Run; events: RunEvent[] }>(`/api/runs/${id}`),
  invite: (id: string, friend: number) => call(`/api/runs/${id}/invite`, { friend }),
  join: (id: string) => call(`/api/runs/${id}/join`, {}),
  leave: (id: string) => call(`/api/runs/${id}/leave`, {}),
  friends: () => call<Friends>('/api/friends'),
  addFriend: (username: string) => call('/api/friends', { action: 'request', username }),
  answerFriend: (requestId: number, yes: boolean) => call('/api/friends', { action: yes ? 'accept' : 'decline', requestId }),
};

/** Radical Red and the other games the tracker reads: FireRed (USA, first release) underneath. */
export async function soulCompatible(g: Game): Promise<boolean> {
  if (g.system !== 'gba') return false;
  const rom = new Uint8Array(await romFor(g));
  return String.fromCharCode(...rom.subarray(0xac, 0xb0)) === 'BPRE' && rom[0xbc] === 0;
}

/** A run keeps its own saves, per player and per attempt: a restart is a truly new game. */
export async function runGame(base: Game, run: Run, me: number, attempt: number): Promise<Game> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${run.id}:${me}:${attempt}`));
  const id = [...new Uint8Array(hash)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  return { ...base, id, romId: base.romId ?? base.id, title: run.name, cheats: [], lastPlayed: Date.now() };
}

export interface ChatLine { who: string; text: string; at: number }

/** The live link to one run: everyone's view of it, team chat, and watching a teammate's screen. */
export class RunConn {
  run: Run | null = null;
  me = 0;
  chat: ChatLine[] = [];
  error = '';
  /** ids of players someone is watching */
  watched: number[] = [];
  frame: { who: number; png: string } | null = null;
  connected = false;
  onHappened?: (list: Happened[]) => void;
  private id: string;
  private ws: WebSocket | null = null;
  private closed = false;
  private subs = new Set<() => void>();
  private queue: string[] = [];
  private retry = 0;

  constructor(id: string) { this.id = id; this.open(); }

  sub(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private emit() { for (const f of this.subs) f(); }

  private open() {
    if (this.closed) return;
    const ws = new WebSocket(`${ACCOUNT_API.replace(/^http/, 'ws')}/run`);
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'auth', token: authToken(), run: this.id })); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'you') {
        this.me = m.id; this.connected = true; this.retry = 0; this.error = '';
        for (const q of this.queue.splice(0)) ws.send(q);
      } else if (m.t === 'run') {
        this.run = m.run;
        if (m.happened?.length) this.onHappened?.(m.happened);
      } else if (m.t === 'chat') this.chat = [...this.chat, m].slice(-100);
      else if (m.t === 'watched') this.watched = m.ids;
      else if (m.t === 'frame') this.frame = { who: m.who, png: m.png };
      else if (m.t === 'error') this.error = m.error;
      this.emit();
    };
    ws.onclose = () => {
      this.connected = false;
      this.emit();
      if (!this.closed) setTimeout(() => this.open(), Math.min(10000, 500 * 2 ** this.retry++));
    };
  }

  private post(m: object) {
    const body = JSON.stringify(m);
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) this.ws.send(body);
    else this.queue.push(body);
  }

  ready(on: boolean) { this.post({ t: 'ready', on }); }
  team(team: number) { this.post({ t: 'team', team }); }
  start() { this.post({ t: 'start' }); }
  report(r: SoulReport) { this.post({ t: 'report', r }); }
  say(text: string) { this.post({ t: 'chat', text }); }
  watch(target: number | null) { this.frame = null; this.post({ t: 'watch', target }); this.emit(); }
  sendFrame(png: string) { if (this.connected) this.post({ t: 'frame', png }); }
  close() { this.closed = true; this.ws?.close(); }

  get mine() { return this.run?.players.find(p => p.id === this.me) ?? null; }
  get myTeam(): TeamState | null { return this.mine && this.run?.state ? this.run.state.teams[this.mine.team] ?? null : null; }
}

/** One line for the timeline, in plain words. */
export function eventText(e: { kind: string; data?: Record<string, unknown> } & Record<string, unknown>, who: string): string {
  const d = e.data ?? e;
  const group = (d.group as string[] | undefined)?.filter(n => n !== d.nick) ?? [];
  switch (e.kind) {
    case 'start': return 'The run started';
    case 'caught': return `${who} caught ${d.nick} in ${d.area}`;
    case 'linked': return d.area === 'Starters' ? `Starters linked: ${(d.group as string[]).join(', ')}` : `${(d.group as string[]).join(', ')} linked up in ${d.area}`;
    case 'illegal': return `${who} caught ${d.nick} in ${d.area}, but that route was used up, so it doesn't count`;
    case 'missed': return `${who} lost the encounter in ${d.area}${(d.lost as string[])?.length ? `, and ${(d.lost as string[]).join(', ')} went with it` : ''}`;
    case 'death': return `${d.nick} died in ${d.area}${group.length ? `, taking ${group.join(' and ')} with it` : ''}`;
    case 'badge': return `${who} earned badge ${d.badges}`;
    case 'wipe': return `Team ${e.team} wiped on attempt ${d.attempt}`;
    case 'clear': return `${who} beat the game`;
    default: return e.kind;
  }
}
