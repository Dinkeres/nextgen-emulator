// One play session: wires the Emulator to storage (auto-save, SRAM, slots, play time).
import { Emulator } from '../engine/emulator.ts';
import { SYSTEMS } from '../engine/systems.ts';
import type { Stats } from '../engine/protocol.ts';
import { db, type Game } from './db.ts';
import { romFor } from './library.ts';
import { effective, settings, toast, refreshLibrary, type Settings } from './store.ts';
import { cloudPull, cloudPush, cloudFlush } from './cloud.ts';

export const AUTO_SLOT = 0;

/** Options a system always needs from us (e.g. DS touch through the pointer device). */
/** DS: use the WebAssembly-threads build (3D on its own core) when the page can run threads. */
const dsThreads = () => typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated && (navigator.hardwareConcurrency ?? 1) > 1;
export function coreFile(core: string) { return core === 'melonds' && dsThreads() ? 'melonds-mt' : core; }

export function systemOptions(system: string, cfg: Settings): Record<string, string> {
  if (system === 'nds') return { melonds_touch_mode: 'Touch', melonds_screen_layout: cfg.ds.layout, melonds_screen_gap: '0', melonds_threaded_renderer: dsThreads() ? 'enabled' : 'disabled' };
  return {};
}

export const DS_BIOS_FILES = ['bios7.bin', 'bios9.bin', 'firmware.bin'];
/** User-provided DS BIOS/firmware (optional; melonDS uses FreeBIOS otherwise). */
async function dsBios(): Promise<Record<string, ArrayBuffer> | undefined> {
  const out: Record<string, ArrayBuffer> = {};
  for (const f of DS_BIOS_FILES) { const b = await db.kv<Blob>('bios:' + f); if (b) out[f] = await b.arrayBuffer(); }
  return Object.keys(out).length ? out : undefined;
}
export const SLOTS = 10;

export class Session {
  emu: Emulator;
  stats: Stats | null = null;
  onStats?: (s: Stats) => void;
  onError?: (msg: string) => void;
  private autoTimer = 0;
  private playTimer = 0;
  private lastTick = performance.now();
  private saving: Promise<void> | null = null;
  private dirty = false; // something happened since the last auto-save
  private ended = false;
  private listeners: [EventTarget, string, EventListener][] = [];
  /** Recent snapshot kept on the main thread so a closing tab can persist it without a worker round-trip. */
  private latest: { state: Uint8Array; thumb: Blob | null; at: number } | null = null;
  private snapTimer = 0;

  constructor(public game: Game, canvas: HTMLCanvasElement) {
    this.emu = new Emulator(canvas, {
      stats: s => { this.stats = s; this.onStats?.(s); },
      sram: d => { if (this.netplay && !this.link) return; db.putSram(this.game.id, d).catch(e => this.onError?.('Could not write save data: ' + e)); cloudPush(this.game.id, 'sram', d); },
      error: m => this.onError?.(m),
      notice: c => { if (c === 'rewind-heavy') toast('Rewind is off for this game so it runs smoothly (Settings → Advanced to force it)', 'info', 'info', 4500); },
    });
  }

  get cfg() { return effective(settings.value, this.game); }

  private netplay = false;

  /** netplay: boot fresh on every machine (no SRAM/state/options) and never auto-save. */
  /** Link play: this machine runs every player's GBA; we keep writing back our own player's save. */
  private link = false;

  async start(opts: { slot?: number; fresh?: boolean; netplay?: boolean; link?: { players: number; srams: (ArrayBuffer | null)[]; view: number } } = {}) {
    this.netplay = !!opts.netplay;
    this.link = !!opts.link;
    const sys = SYSTEMS[this.game.system];
    const cfg = this.cfg;
    if (!opts.netplay) {
      const id = this.game.id;
      const got = await cloudPull(id, this.game.lastPlayed, {
        sram: () => db.sram(id),
        state: async () => { const s = await db.state(id, AUTO_SLOT); return s ? new Uint8Array(await s.state.arrayBuffer()) : undefined; },
      }, {
        sram: d => db.putSram(id, d),
        state: (d, t) => db.putState({ id: `${id}:${AUTO_SLOT}`, gameId: id, slot: AUTO_SLOT, state: new Blob([d as BlobPart]), thumb: null, createdAt: t, playTime: this.game.playTime }),
      });
      if (got.length) toast(got.includes('state') ? 'Picked up where you left off on your other device' : 'Loaded your cloud save', 'save', 'success', 4000);
    }
    const [rom, sram] = await Promise.all([romFor(this.game), opts.netplay ? undefined : db.sram(this.game.id)]);
    let state: ArrayBuffer | undefined;
    const slot = opts.fresh || opts.netplay ? undefined : opts.slot ?? (cfg.saves.resume ? AUTO_SLOT : undefined);
    if (slot !== undefined) state = await (await db.state(this.game.id, slot))?.state.arrayBuffer();
    await this.emu.start({
      coreUrl: `${import.meta.env.BASE_URL}cores/${opts.link ? 'gbalink' : coreFile(sys.core)}.mjs`,
      link: opts.link ? { roms: Array.from({ length: opts.link.players }, () => rom), srams: opts.link.srams, view: opts.link.view } : undefined,
      strict: !!opts.netplay,
      rom, fileName: this.game.fileName,
      sram: sram ? (sram.slice().buffer as ArrayBuffer) : undefined, state,
      options: { ...(opts.netplay ? {} : cfg.coreOptions[sys.core]), ...systemOptions(sys.id, cfg) },
      systemFiles: sys.id === 'nds' ? await dsBios() : undefined,
      display: { shader: cfg.video.shader, aspect: cfg.video.aspect, integer: cfg.video.integer },
      volume: cfg.audio.muted ? 0 : cfg.audio.volume,
      latencyMs: cfg.audio.latencyMs,
      rewind: { enabled: cfg.speed.rewind && !opts.netplay, seconds: cfg.speed.rewindSeconds, budgetMB: navigator.maxTouchPoints > 0 ? 48 : 128, heavy: cfg.speed.rewindHeavy },
      ffAudio: cfg.audio.ffAudio,
      vsyncLock: cfg.video.vsyncLock,
    });
    db.putKv('coreopts:' + sys.core, this.emu.coreOptions).catch(() => {});
    if (opts.netplay) return; // NetSession resumes after the start barrier
    const cheats = this.game.cheats?.filter(c => c.on).map(c => c.code);
    if (cheats?.length) { this.emu.cheats(cheats); toast(`${cheats.length} cheat${cheats.length > 1 ? 's' : ''} active`, 'info', 'info'); }
    if (state && this.emu.resumed) toast('Resumed where you left off', 'history', 'info');
    else if (state) toast("Couldn't load the last save — starting fresh. Your other saves are untouched.", 'alert', 'warn', 5000);
    await this.emu.resume();
    await db.updateGame(this.game.id, { lastPlayed: Date.now() });
    this.scheduleAuto();
    this.playTimer = window.setInterval(() => this.trackTime(), 15000);
    this.on(document, 'visibilitychange', () => { if (document.hidden && this.cfg.saves.autoSaveOnHide) this.autoSave('hidden'); });
    // pagehide fires on tab close/navigation (beforeunload is unreliable, esp. on mobile). The worker
    // can't answer in time while the page is torn down, so write the latest snapshot right away.
    this.on(window, 'pagehide', () => { this.trackTime(); this.writeLatest(); });
    // big states (DS ~6 MB) are expensive to capture: snapshot less often so play stays smooth
    const snapEvery = this.emu.stateSize > 1 << 20 ? 15000 : 2000;
    this.snapTimer = window.setInterval(() => { if (!this.emu.paused) this.snapshot().catch(() => {}); }, snapEvery);
  }

  private on(t: EventTarget, ev: string, fn: EventListener) { t.addEventListener(ev, fn); this.listeners.push([t, ev, fn]); }

  scheduleAuto() {
    clearInterval(this.autoTimer);
    const m = this.cfg.saves.autoSaveMinutes;
    if (m > 0) this.autoTimer = window.setInterval(() => { if (!this.emu.paused) this.autoSave('timer'); }, m * 60000);
  }

  private trackTime() {
    const now = performance.now();
    const secs = this.emu.paused ? 0 : (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (secs > 0) { this.game.playTime += secs; this.dirty = true; db.updateGame(this.game.id, { playTime: this.game.playTime }); }
  }

  private async snapshot() {
    const s = await this.emu.saveState();
    this.latest = { ...s, at: Date.now() };
    return s;
  }

  /** Synchronously queue the newest in-memory snapshot as the auto-save (used on pagehide). */
  private writeLatest() {
    if (!this.latest || this.netplay) return;
    const { state, thumb, at } = this.latest;
    db.putState({ id: `${this.game.id}:${AUTO_SLOT}`, gameId: this.game.id, slot: AUTO_SLOT, state: new Blob([state as BlobPart]), thumb, createdAt: at, playTime: this.game.playTime }).catch(() => {});
  }

  /** Save to a slot (0 = auto). Resolves once the write has committed. */
  async save(slot: number): Promise<void> {
    const { state, thumb } = await this.snapshot();
    await db.putState({ id: `${this.game.id}:${slot}`, gameId: this.game.id, slot, state: new Blob([state as BlobPart]), thumb, createdAt: Date.now(), playTime: this.game.playTime });
    if (slot === AUTO_SLOT && !this.netplay) cloudPush(this.game.id, 'state', state);
  }

  autoSave(reason: 'timer' | 'pause' | 'hidden' | 'pagehide' | 'exit'): Promise<void> {
    if (this.netplay) return Promise.resolve();
    if (this.saving) return this.saving;
    this.saving = this.save(AUTO_SLOT)
      .then(() => { if (reason === 'timer') toast('Auto-saved', 'save', 'success', 1600); this.dirty = false; })
      .catch(e => { if (reason !== 'pagehide') toast('Auto-save failed: ' + e.message, 'alert', 'error'); })
      .finally(() => { this.saving = null; });
    return this.saving;
  }

  async load(slot: number): Promise<boolean> {
    const s = await db.state(this.game.id, slot);
    if (!s) return false;
    return this.emu.loadState(await s.state.arrayBuffer());
  }

  pause(autosave = true) {
    this.trackTime();
    this.emu.pause();
    if (autosave) this.autoSave('pause');
  }
  resume() { this.lastTick = performance.now(); return this.emu.resume(); }

  async end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.autoTimer); clearInterval(this.playTimer); clearInterval(this.snapTimer);
    for (const [t, ev, fn] of this.listeners) t.removeEventListener(ev, fn);
    this.trackTime();
    this.emu.pause();
    await this.autoSave('exit');
    cloudFlush();
    this.emu.destroy();
    await refreshLibrary();
  }
}
