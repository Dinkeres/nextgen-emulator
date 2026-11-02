// Cloud saves for signed-in players (the shared Horizon/Kaiser account server, /api/saves).
// Synced per game (ROM SHA-256, the same id on every device) and kind:
//   sram  — the battery save (the game's own save, e.g. Pokémon's), uploaded a few seconds after it changes
//   state — the auto-save state (resume where you left off), uploaded when it's written, if small enough
// Newest wins. Whatever a download replaces is kept in this browser as a backup (kv 'cloud-backup:…').
import { account, authToken, ACCOUNT_API } from './account.ts';
import { db } from './db.ts';

export type Kind = 'sram' | 'state';
const MAX = 1_900_000;
/** Per game+kind: when this device's copy was last changed (t) and which cloud version it matches (synced). */
type Meta = { t: number; synced: number };
const metaKey = (game: string, kind: Kind) => `cloud:${game}:${kind}`;
const getMeta = async (game: string, kind: Kind) => (await db.kv<Meta>(metaKey(game, kind))) ?? { t: 0, synced: 0 };
const setMeta = (game: string, kind: Kind, m: Meta) => db.putKv(metaKey(game, kind), m);

async function api(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(ACCOUNT_API + path, { ...init, signal: ctl.signal, headers: { ...init.headers, Authorization: 'Bearer ' + authToken() } });
  } finally { clearTimeout(timer); }
}

const pending = new Map<string, { data: Uint8Array; t: number; timer: number }>();

/** A local save changed: remember when, and upload it shortly (coalescing bursts of writes). */
export function cloudPush(game: string, kind: Kind, data: Uint8Array, delayMs = kind === 'sram' ? 4000 : 1000) {
  const t = Date.now();
  getMeta(game, kind).then(m => setMeta(game, kind, { ...m, t })).catch(() => {});
  if (!account.value || data.length > MAX) return;
  const key = game + kind;
  clearTimeout(pending.get(key)?.timer);
  pending.set(key, { data: data.slice(), t, timer: window.setTimeout(() => upload(game, kind), delayMs) });
}

async function upload(game: string, kind: Kind) {
  const p = pending.get(game + kind);
  if (!p || !account.value) return;
  pending.delete(game + kind);
  try {
    const r = await api(`/api/saves/${game}/${kind}?t=${p.t}`, { method: 'PUT', body: p.data as BlobPart as BodyInit }, 30000);
    if (!r.ok) { console.warn('[cloud] upload refused', r.status, await r.text().catch(() => '')); return; }
    const { updated } = await r.json();
    const m = await getMeta(game, kind);
    if (m.t <= p.t) await setMeta(game, kind, { t: p.t, synced: updated });
  } catch (e) {
    console.warn('[cloud] upload failed, will retry on the next change or launch', e);
  }
}

/** Upload anything still waiting (on leaving a game). */
export function cloudFlush() { for (const key of [...pending.keys()]) { const p = pending.get(key)!; clearTimeout(p.timer); upload(key.slice(0, -(key.endsWith('sram') ? 4 : 5)), key.endsWith('sram') ? 'sram' : 'state'); } }

/**
 * Before a game starts: bring this device up to date. Downloads cloud copies newer than ours and
 * uploads ours if the cloud is behind. Never blocks a launch for long (offline = play local saves).
 * Returns what was downloaded.
 */
export async function cloudPull(game: string, lastPlayed: number, readLocal: { sram: () => Promise<Uint8Array | undefined>; state: () => Promise<Uint8Array | undefined> },
  writeLocal: { sram: (d: Uint8Array) => Promise<unknown>; state: (d: Uint8Array, t: number) => Promise<unknown> }): Promise<Kind[]> {
  if (!account.value) return [];
  const got: Kind[] = [];
  try {
    const r = await api('/api/saves', {}, 4000);
    if (!r.ok) return [];
    const list: { game: string; kind: Kind; updated: number }[] = (await r.json()).saves;
    for (const kind of ['sram', 'state'] as Kind[]) {
      const cloud = list.find(s => s.game === game && s.kind === kind);
      const m = await getMeta(game, kind);
      const local = await readLocal[kind]();
      // a save made before cloud saves knew about it: dated by when the game was last played here
      if (local && !m.t) m.t = lastPlayed;
      if (cloud && cloud.updated > m.synced && (cloud.updated > m.t || !local)) {
        const d = await api(`/api/saves/${game}/${kind}`, {}, 20000);
        if (!d.ok) continue;
        const data = new Uint8Array(await d.arrayBuffer());
        if (local) await db.putKv(`cloud-backup:${game}:${kind}`, { data: local, t: m.t, replacedAt: Date.now() });
        await writeLocal[kind](data, cloud.updated);
        await setMeta(game, kind, { t: cloud.updated, synced: cloud.updated });
        got.push(kind);
      } else if (local && m.t > m.synced && (!cloud || m.t > cloud.updated)) {
        pending.set(game + kind, { data: local, t: m.t, timer: 0 });
        upload(game, kind);
      }
    }
  } catch (e) { console.warn('[cloud] sync skipped', e); }
  return got;
}

/** For the account page. */
export async function cloudList(): Promise<{ game: string; kind: Kind; size: number; updated: number }[]> {
  const r = await api('/api/saves');
  if (!r.ok) throw new Error('Could not load your cloud saves.');
  return (await r.json()).saves;
}
