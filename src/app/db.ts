// IndexedDB persistence. Every write resolves only when its transaction commits.

export interface Game {
  id: string;            // sha-256 of the ROM (hex, first 32 chars) — also used for netplay matching
  title: string;
  system: string;
  fileName: string;
  size: number;
  addedAt: number;
  lastPlayed: number;
  playTime: number;      // seconds
  favorite: boolean;
  cover?: Blob;          // user-provided art only
  bundled?: boolean;     // shipped homebrew (ROM fetched from /homebrew, not stored)
  settings?: Record<string, unknown>; // per-game overrides
}

export interface SaveState {
  id: string;            // `${gameId}:${slot}`
  gameId: string;
  slot: number;          // 0 = auto-save, 1..10 manual
  state: Blob;
  thumb: Blob | null;
  createdAt: number;
  playTime: number;
}

export interface Shot { id?: number; gameId: string; blob: Blob; createdAt: number }

const DB_NAME = 'nextgen-emulator';
const VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('games', { keyPath: 'id' });
      db.createObjectStore('roms');
      const st = db.createObjectStore('states', { keyPath: 'id' });
      st.createIndex('gameId', 'gameId');
      db.createObjectStore('sram');
      const sh = db.createObjectStore('shots', { keyPath: 'id', autoIncrement: true });
      sh.createIndex('gameId', 'gameId');
      db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

type Store = 'games' | 'roms' | 'states' | 'sram' | 'shots' | 'kv';

async function tx<T>(stores: Store | Store[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode, { durability: 'strict' } as IDBTransactionOptions);
    let result: T;
    const req = fn(t);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => res(result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error('Transaction aborted'));
  });
}

const get = <T>(s: Store, key: IDBValidKey) => tx<T>(s, 'readonly', t => t.objectStore(s).get(key) as IDBRequest<T>);
const all = <T>(s: Store) => tx<T[]>(s, 'readonly', t => t.objectStore(s).getAll() as IDBRequest<T[]>);
const put = (s: Store, v: unknown, key?: IDBValidKey) => tx<IDBValidKey>(s, 'readwrite', t => t.objectStore(s).put(v, key));
const del = (s: Store, key: IDBValidKey) => tx<undefined>(s, 'readwrite', t => { t.objectStore(s).delete(key); });
const byGame = <T>(s: 'states' | 'shots', gameId: string) =>
  tx<T[]>(s, 'readonly', t => t.objectStore(s).index('gameId').getAll(gameId) as IDBRequest<T[]>);

export const db = {
  games: () => all<Game>('games'),
  game: (id: string) => get<Game | undefined>('games', id),
  putGame: (g: Game) => put('games', g),
  async updateGame(id: string, patch: Partial<Game>) {
    const g = await get<Game | undefined>('games', id);
    if (g) await put('games', { ...g, ...patch });
  },
  rom: (id: string) => get<Blob | undefined>('roms', id),
  putRom: (id: string, b: Blob) => put('roms', b, id),

  states: (gameId: string) => byGame<SaveState>('states', gameId),
  state: (gameId: string, slot: number) => get<SaveState | undefined>('states', `${gameId}:${slot}`),
  putState: (s: SaveState) => put('states', s),
  deleteState: (gameId: string, slot: number) => del('states', `${gameId}:${slot}`),

  sram: (gameId: string) => get<Uint8Array | undefined>('sram', gameId),
  putSram: (gameId: string, d: Uint8Array) => put('sram', d, gameId),

  shots: (gameId: string) => byGame<Shot>('shots', gameId),
  putShot: (s: Shot) => put('shots', s),
  deleteShot: (id: number) => del('shots', id),

  kv: <T>(key: string) => get<T | undefined>('kv', key),
  putKv: (key: string, v: unknown) => put('kv', v, key),

  /** Remove everything stored for one game (ROM, saves, screenshots). */
  async clearGame(gameId: string, keepGame = false) {
    const [states, shots] = await Promise.all([db.states(gameId), db.shots(gameId)]);
    await tx(['games', 'roms', 'states', 'sram', 'shots'], 'readwrite', t => {
      if (!keepGame) { t.objectStore('games').delete(gameId); t.objectStore('roms').delete(gameId); }
      t.objectStore('sram').delete(gameId);
      for (const s of states) t.objectStore('states').delete(s.id);
      for (const s of shots) t.objectStore('shots').delete(s.id!);
    });
  },

  /** Approximate bytes stored per game. */
  async usage(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const add = (id: string, n: number) => { out[id] = (out[id] ?? 0) + n; };
    for (const g of await db.games()) { add(g.id, g.bundled ? 0 : g.size); if (g.cover) add(g.id, g.cover.size); }
    for (const s of await all<SaveState>('states')) add(s.gameId, s.state.size + (s.thumb?.size ?? 0));
    for (const s of await all<Shot>('shots')) add(s.gameId, s.blob.size);
    const db0 = await openDB();
    await new Promise<void>(res => {
      const t = db0.transaction('sram');
      const c = t.objectStore('sram').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { add(String(cur.key), (cur.value as Uint8Array).length); cur.continue(); } };
      t.oncomplete = () => res();
    });
    return out;
  },
};

/** Ask the browser not to evict our data under storage pressure. */
export async function persist(): Promise<boolean> {
  try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch { return false; }
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ---------------- backup / restore ----------------
// Format: gzip(JSON) with blobs base64-encoded. Small and dependency-free.
const toB64 = async (b: Blob | Uint8Array) => {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function exportBackup(gameId?: string, includeRoms = false): Promise<Blob> {
  const games = (await db.games()).filter(g => !gameId || g.id === gameId);
  const out: Record<string, unknown>[] = [];
  for (const g of games) {
    const states = await db.states(g.id);
    const sram = await db.sram(g.id);
    const rom = includeRoms && !g.bundled ? await db.rom(g.id) : undefined;
    out.push({
      game: { ...g, cover: g.cover ? await toB64(g.cover) : undefined },
      sram: sram ? await toB64(sram) : undefined,
      rom: rom ? await toB64(rom) : undefined,
      states: await Promise.all(states.map(async s => ({ ...s, state: await toB64(s.state), thumb: s.thumb ? await toB64(s.thumb) : null, thumbType: s.thumb?.type }))),
    });
  }
  const json = JSON.stringify({ format: 'nextgen-emulator-backup', version: 1, exportedAt: Date.now(), games: out });
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function importBackup(file: Blob): Promise<number> {
  const text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const data = JSON.parse(text);
  if (data?.format !== 'nextgen-emulator-backup') throw new Error('This file is not a NextGen Emulator backup.');
  let n = 0;
  for (const e of data.games) {
    const g = e.game as Game & { cover?: string };
    const existing = await db.game(g.id);
    await db.putGame({ ...(existing ?? g), ...g, cover: g.cover ? new Blob([fromB64(g.cover)]) : existing?.cover });
    if (e.rom) await db.putRom(g.id, new Blob([fromB64(e.rom)]));
    if (e.sram) await db.putSram(g.id, fromB64(e.sram));
    for (const s of e.states) {
      await db.putState({ ...s, state: new Blob([fromB64(s.state)]), thumb: s.thumb ? new Blob([fromB64(s.thumb)], { type: s.thumbType || 'image/webp' }) : null });
    }
    n++;
  }
  return n;
}
