// App-wide state: settings (persisted), library, toasts. Tiny subscribe/notify store.
import { useEffect, useState } from 'preact/hooks';
import { db, type Game } from './db.ts';
import { DEFAULT_KEYS, DEFAULT_PAD, DEFAULT_HOTKEYS, type KeyBindings, type PadBindings, type Hotkey } from '../engine/input.ts';
import type { ShaderId, AspectMode } from '../engine/renderer.ts';
import type { FFAudio } from '../engine/protocol.ts';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  libraryView: 'grid' | 'list';
  welcomed: boolean;
  video: { shader: ShaderId; aspect: AspectMode; integer: boolean; vsyncLock: boolean; showFps: boolean };
  audio: { volume: number; latencyMs: number; ffAudio: FFAudio; muted: boolean };
  saves: { autoSaveMinutes: number; resume: boolean; autoSaveOnHide: boolean };
  speed: { ffSpeed: number; ffMode: 'hold' | 'toggle'; slowSpeed: number; rewind: boolean; rewindSeconds: number };
  controls: { keys: KeyBindings; pad: PadBindings; hotkeys: Record<Hotkey, string>; touch: 'auto' | 'on' | 'off'; touchOpacity: number; haptics: boolean };
  netplay: { name: string; signalUrl: string; inputDelay: number | 'auto'; maxRollback: number };
  coreOptions: Record<string, Record<string, string>>; // per core
  ds: { layout: DSLayout };
}

export type DSLayout = 'Top/Bottom' | 'Left/Right' | 'Hybrid Top' | 'Hybrid Bottom';

/** Hosted matchmaking (Cloudflare Worker, server/cloudflare). Run `npm run signal` for a local one. */
export const DEFAULT_SIGNAL = 'wss://kaiser-signal.luvrookie1.workers.dev';

const isMobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export const DEFAULTS: Settings = {
  theme: 'dark', libraryView: 'grid', welcomed: false,
  video: { shader: 'sharp', aspect: 'core', integer: false, vsyncLock: true, showFps: false },
  audio: { volume: 0.8, latencyMs: isMobile ? 70 : 45, ffAudio: 'stretch', muted: false },
  saves: { autoSaveMinutes: 2, resume: true, autoSaveOnHide: true },
  speed: { ffSpeed: 3, ffMode: 'hold', slowSpeed: 0.5, rewind: true, rewindSeconds: isMobile ? 15 : 45 },
  controls: { keys: DEFAULT_KEYS, pad: DEFAULT_PAD, hotkeys: DEFAULT_HOTKEYS, touch: 'auto', touchOpacity: 0.55, haptics: true },
  netplay: { name: '', signalUrl: DEFAULT_SIGNAL, inputDelay: 'auto', maxRollback: 8 },
  coreOptions: {},
  ds: { layout: 'Top/Bottom' },
};

/** Sections a game may override. */
export type Overridable = Pick<Settings, 'video' | 'audio' | 'speed'>;

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)?.[k], v);
  return out as T;
}

export function effective(s: Settings, g?: Game | null): Settings {
  return g?.settings ? merge(s, g.settings) : s;
}

// ---------------- store ----------------
type Listener = () => void;
class Store<T> {
  private ls = new Set<Listener>();
  value: T;
  constructor(value: T) { this.value = value; }
  set(v: T) { this.value = v; this.ls.forEach(l => l()); }
  update(fn: (v: T) => T) { this.set(fn(this.value)); }
  sub(l: Listener) { this.ls.add(l); return () => { this.ls.delete(l); }; }
}

export function useStore<T>(s: Store<T>): T {
  const [, force] = useState(0);
  const rendered = s.value;
  useEffect(() => {
    const un = s.sub(() => force(n => n + 1));
    // the store may have changed between render and subscribing (fast IndexedDB reads)
    if (s.value !== rendered) force(n => n + 1);
    return un;
  }, [s]);
  return s.value;
}

export const settings = new Store<Settings>(DEFAULTS);
export const library = new Store<Game[]>([]);

export async function loadSettings() {
  const saved = await db.kv<Partial<Settings>>('settings').catch(() => undefined);
  const s = merge(DEFAULTS, saved ?? {});
  if (s.netplay.signalUrl === 'ws://localhost:8787') s.netplay.signalUrl = DEFAULT_SIGNAL; // old default
  settings.set(s);
}

let saveTimer = 0;
export function updateSettings(patch: (s: Settings) => Settings) {
  settings.update(patch);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => db.putKv('settings', settings.value), 150);
}

export async function refreshLibrary() {
  library.set(await db.games());
}

// ---------------- toasts ----------------
export interface Toast { id: number; text: string; icon?: string; tone?: 'info' | 'success' | 'warn' | 'error' }
export const toasts = new Store<Toast[]>([]);
let toastId = 0;
export function toast(text: string, icon = 'info', tone: Toast['tone'] = 'info', ms = 2600) {
  const t = { id: ++toastId, text, icon, tone };
  toasts.update(l => [...l.slice(-3), t]);
  setTimeout(() => toasts.update(l => l.filter(x => x.id !== t.id)), ms);
}
