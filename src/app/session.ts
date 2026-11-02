// One play session: wires the Emulator to storage (auto-save, SRAM, slots, play time).
import { Emulator } from '../engine/emulator.ts';
import { SYSTEMS } from '../engine/systems.ts';
import type { Stats } from '../engine/protocol.ts';
import { db, type Game } from './db.ts';
import { romFor } from './library.ts';
import { effective, settings, toast, refreshLibrary } from './store.ts';

export const AUTO_SLOT = 0;
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

  constructor(public game: Game, canvas: HTMLCanvasElement) {
    this.emu = new Emulator(canvas, {
      stats: s => { this.stats = s; this.onStats?.(s); },
      sram: d => { if (this.netplay) return; db.putSram(this.game.id, d).catch(e => this.onError?.('Could not write save data: ' + e)); },
      error: m => this.onError?.(m),
    });
  }

  get cfg() { return effective(settings.value, this.game); }

  private netplay = false;

  /** netplay: boot fresh on every machine (no SRAM/state/options) and never auto-save. */
  async start(opts: { slot?: number; fresh?: boolean; netplay?: boolean } = {}) {
    this.netplay = !!opts.netplay;
    const sys = SYSTEMS[this.game.system];
    const cfg = this.cfg;
    const [rom, sram] = await Promise.all([romFor(this.game), opts.netplay ? undefined : db.sram(this.game.id)]);
    let state: ArrayBuffer | undefined;
    const slot = opts.fresh || opts.netplay ? undefined : opts.slot ?? (cfg.saves.resume ? AUTO_SLOT : undefined);
    if (slot !== undefined) state = await (await db.state(this.game.id, slot))?.state.arrayBuffer();
    await this.emu.start({
      coreUrl: `${import.meta.env.BASE_URL}cores/${sys.core}.mjs`,
      rom, fileName: this.game.fileName,
      sram: sram ? (sram.slice().buffer as ArrayBuffer) : undefined, state,
      options: opts.netplay ? undefined : cfg.coreOptions[sys.core],
      display: { shader: cfg.video.shader, aspect: cfg.video.aspect, integer: cfg.video.integer },
      volume: cfg.audio.muted ? 0 : cfg.audio.volume,
      latencyMs: cfg.audio.latencyMs,
      rewind: { enabled: cfg.speed.rewind && !opts.netplay, seconds: cfg.speed.rewindSeconds, budgetMB: navigator.maxTouchPoints > 0 ? 48 : 128 },
      ffAudio: cfg.audio.ffAudio,
      vsyncLock: cfg.video.vsyncLock,
    });
    db.putKv('coreopts:' + sys.core, this.emu.coreOptions).catch(() => {});
    if (opts.netplay) return; // NetSession resumes after the start barrier
    const cheats = this.game.cheats?.filter(c => c.on).map(c => c.code);
    if (cheats?.length) { this.emu.cheats(cheats); toast(`${cheats.length} cheat${cheats.length > 1 ? 's' : ''} active`, 'info', 'info'); }
    if (state) toast('Resumed where you left off', 'history', 'info');
    await this.emu.resume();
    await db.updateGame(this.game.id, { lastPlayed: Date.now() });
    this.scheduleAuto();
    this.playTimer = window.setInterval(() => this.trackTime(), 15000);
    this.on(document, 'visibilitychange', () => { if (document.hidden && this.cfg.saves.autoSaveOnHide) this.autoSave('hidden'); });
    // pagehide fires on tab close/navigation (beforeunload is unreliable, esp. on mobile)
    this.on(window, 'pagehide', () => { this.trackTime(); this.autoSave('pagehide'); });
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

  /** Save to a slot (0 = auto). Resolves once the write has committed. */
  async save(slot: number): Promise<void> {
    const { state, thumb } = await this.emu.saveState();
    await db.putState({ id: `${this.game.id}:${slot}`, gameId: this.game.id, slot, state: new Blob([state as BlobPart]), thumb, createdAt: Date.now(), playTime: this.game.playTime });
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
    clearInterval(this.autoTimer); clearInterval(this.playTimer);
    for (const [t, ev, fn] of this.listeners) t.removeEventListener(ev, fn);
    this.trackTime();
    this.emu.pause();
    await this.autoSave('exit');
    this.emu.destroy();
    await refreshLibrary();
  }
}
