// Main-thread controller for one play session: spins up the worker, audio and the rAF loop.
import EmuWorker from './worker?worker';
import workletUrl from './audio-worklet.js?url';
import type { FromWorker, ToWorker, Stats, FFAudio, CoreOption } from './protocol.ts';
import type { AVInfo } from './core.ts';
import type { DisplayOptions } from './renderer.ts';
import { Renderer } from './renderer.ts';
import type { NetMsg } from '../net/rollback.ts';
import type { QzMsg } from '../net/quetzal.ts';

export interface StartOptions {
  coreUrl: string;
  rom: ArrayBuffer;
  fileName: string;
  sram?: ArrayBuffer;
  state?: ArrayBuffer;
  options?: Record<string, string>;
  systemFiles?: Record<string, ArrayBuffer>;
  link?: { roms: ArrayBuffer[]; srams: (ArrayBuffer | null)[]; view: number };
  strict?: boolean;
  display: DisplayOptions;
  volume: number;
  latencyMs: number;
  rewind: { enabled: boolean; seconds: number; budgetMB: number; heavy?: boolean };
  ffAudio: FFAudio;
  vsyncLock: boolean;
}

export interface Events {
  stats?: (s: Stats) => void;
  sram?: (d: Uint8Array) => void;
  error?: (msg: string) => void;
  notice?: (code: string) => void;
  net?: (m: NetMsg) => void;
  desync?: (frame: number) => void;
  qz?: (m: QzMsg) => void;
  qzStatus?: (text: string) => void;
}

const AUDIO_CAP = 16384; // frames (~340ms at 48k)

export class Emulator {
  private worker!: Worker;
  private ctx!: AudioContext;
  private node!: AudioWorkletNode;
  private raf = 0;
  private last = 0;
  private deltas: number[] = [];
  private pending = new Map<number, (v: unknown) => void>();
  private nextId = 1;
  private fallback: Renderer | null = null;
  private ro?: ResizeObserver;
  av!: AVInfo;
  coreName = '';
  coreOptions: CoreOption[] = [];
  hasSram = false;
  stateSize = 0;
  resumed = false;
  paused = true;
  displayHz = 60;
  /** Called every animation frame; returns input masks per port. */
  pollInput: () => number[] = () => [0, 0, 0, 0];
  /** Canvas-normalized stylus for touch-screen systems, or null. */
  pollStylus: () => [number, number, number] | null = () => null;

  constructor(private canvas: HTMLCanvasElement, private ev: Events = {}) {}

  async start(o: StartOptions): Promise<void> {
    // --- audio ---
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(workletUrl);
    const shared = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
    let sab: { data: SharedArrayBuffer; ctl: SharedArrayBuffer } | undefined;
    let port: MessagePort | undefined;
    if (shared) sab = { data: new SharedArrayBuffer(AUDIO_CAP * 2 * 4), ctl: new SharedArrayBuffer(12) };
    this.node = new AudioWorkletNode(this.ctx, 'ring-player', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { sab, capacity: AUDIO_CAP },
    });
    this.node.connect(this.ctx.destination);
    // Safari only starts audio from inside a user gesture: retry on the next tap/key
    const unlock = () => { if (this.ctx.state !== 'running' && !this.paused) this.ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true });
    this.unlockOff = () => { for (const ev of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(ev, unlock, { capture: true }); };
    if (!shared) {
      const ch = new MessageChannel();
      this.node.port.postMessage({ port: ch.port1 }, [ch.port1]);
      port = ch.port2;
    }

    // --- worker ---
    this.worker = new EmuWorker();
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = e => this.ev.error?.(e.message || 'Emulator crashed');
    const offscreen = 'transferControlToOffscreen' in this.canvas ? this.canvas.transferControlToOffscreen() : undefined;
    if (!offscreen) this.fallback = new Renderer(this.canvas);
    const ready = this.waitFor('ready');
    const rom = o.rom.slice(0);
    const msg: ToWorker = {
      type: 'init', coreUrl: new URL(o.coreUrl, location.href).href, rom, fileName: o.fileName,
      canvas: offscreen, display: o.display,
      audio: { rate: this.ctx.sampleRate, latencyMs: o.latencyMs, sab, port, capacity: AUDIO_CAP },
      options: o.options, systemFiles: o.systemFiles, sram: o.sram, state: o.state, rewind: o.rewind, link: o.link, strict: o.strict,
    };
    const transfer: Transferable[] = [rom];
    if (offscreen) transfer.push(offscreen);
    if (port) transfer.push(port);
    this.worker.postMessage(msg, transfer);
    const r = await ready as Extract<FromWorker, { type: 'ready' }>;
    this.av = r.av; this.coreName = r.coreName; this.coreOptions = r.options; this.hasSram = r.hasSram; this.resumed = r.resumed; this.stateSize = r.stateSize;
    this.set({ ffAudio: o.ffAudio, volume: o.volume, vsyncLock: o.vsyncLock });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.watchdog();
  }

  private errorWaiters: ((e: Error) => void)[] = [];
  private readyResolve: ((v: unknown) => void) | null = null;
  private waitFor(_type: 'ready'): Promise<unknown> {
    return new Promise((res, rej) => { this.readyResolve = res; this.errorWaiters.push(rej); });
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case 'ready': this.readyResolve?.(m); this.readyResolve = null; this.errorWaiters = []; break;
      case 'stats': this.ev.stats?.(m); break;
      case 'sram': this.ev.sram?.(m.data); break;
      case 'state': case 'loaded': case 'screenshot': case 'bench': case 'timings': this.pending.get(m.id)?.(m); this.pending.delete(m.id); break;
      case 'frame': if (this.fallback) { this.fallback.coreAspect = m.aspect; this.fallback.draw(m.data, m.width, m.height); } break;
      case 'net': this.ev.net?.(m.msg); break;
      case 'netEvent': this.ev.desync?.(m.frame); break;
      case 'notice': this.ev.notice?.(m.code); break;
      case 'qz': this.ev.qz?.(m.msg); break;
      case 'qzStatus': this.ev.qzStatus?.(m.text); break;
      case 'error':
        if (this.errorWaiters.length) { this.errorWaiters.forEach(f => f(new Error(m.message))); this.errorWaiters = []; }
        else this.ev.error?.(m.message);
        break;
    }
  }

  private request<T>(msg: ToWorker & { id: number }, transfer: Transferable[] = []): Promise<T> {
    return new Promise(res => { this.pending.set(msg.id, res as (v: unknown) => void); this.worker.postMessage(msg, transfer); });
  }

  private unlockOff = () => {};
  private lastRaf = 0;
  private backup = 0;
  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    this.lastRaf = performance.now();
    this.tick(now, true);
  }

  /** rAF can stall while the page is visible (occluded window, some embedded webviews);
   *  keep the game and audio running from a timer until rAF comes back. */
  private watchdog() {
    this.backup = window.setInterval(() => {
      const now = performance.now();
      if (document.visibilityState === 'visible' && now - this.lastRaf > 50 && now - this.last > 14) this.tick(now, false);
    }, 1000 / 60);
  }

  private tick(now: number, fromRaf: boolean) {
    const dt = this.last ? now - this.last : 1000 / 60;
    this.last = now;
    // estimate the display refresh rate from the median frame delta
    if (fromRaf && dt > 4 && dt < 50) {
      this.deltas.push(dt);
      if (this.deltas.length >= 90) {
        const s = [...this.deltas].sort((a, b) => a - b);
        const hz = Math.round(1000 / s[s.length >> 1]);
        if (Math.abs(hz - this.displayHz) > 1) { this.displayHz = hz; this.post({ type: 'set', displayHz: hz }); }
        this.deltas = [];
      }
    }
    this.post({ type: 'tick', now, dt, inputs: this.pollInput(), vsync: fromRaf, stylus: this.pollStylus() ?? undefined });
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.fallback) { this.fallback.resize(w, h); this.fallback.redraw(); }
    else this.post({ type: 'resize', w, h });
  }

  private post(m: ToWorker, t: Transferable[] = []) { this.worker?.postMessage(m, t); }

  set(o: Omit<Extract<ToWorker, { type: 'set' }>, 'type'>) {
    if (o.display && this.fallback) { this.fallback.opts = { ...this.fallback.opts, ...o.display }; this.fallback.redraw(); }
    this.post({ type: 'set', ...o });
  }

  async resume() {
    this.paused = false;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    this.set({ paused: false });
  }
  pause() { this.paused = true; this.set({ paused: true }); }

  setSpeed(speed: number) { this.set({ speed }); }
  setRewinding(on: boolean) { this.set({ rewinding: on }); }
  reset() { this.post({ type: 'reset' }); }
  cheats(codes: string[]) { this.post({ type: 'cheats', codes }); }

  async saveState(): Promise<{ state: Uint8Array; thumb: Blob | null }> {
    const r = await this.request<Extract<FromWorker, { type: 'state' }>>({ type: 'saveState', id: this.nextId++ });
    return { state: r.state, thumb: r.thumb };
  }
  async loadState(state: ArrayBuffer | Uint8Array): Promise<boolean> {
    const buf = state instanceof Uint8Array ? state.slice().buffer : state.slice(0);
    const r = await this.request<Extract<FromWorker, { type: 'loaded' }>>({ type: 'loadState', id: this.nextId++, state: buf }, [buf]);
    return r.ok;
  }
  async screenshot(): Promise<Blob | null> {
    const r = await this.request<Extract<FromWorker, { type: 'screenshot' }>>({ type: 'screenshot', id: this.nextId++ });
    return r.png;
  }

  /** Benchmark helpers (bench/kaiser.html). */
  benchMax(ms: number) { return this.request<{ frames: number; ms: number }>({ type: 'bench', id: this.nextId++, ms }); }
  async timings(): Promise<Float64Array> { return (await this.request<{ t: Float64Array }>({ type: 'timings', id: this.nextId++ })).t; }

  // netplay plumbing (the session/transport lives in src/net)
  setNetHandlers(net: (m: NetMsg) => void, desync: (frame: number) => void) { this.ev.net = net; this.ev.desync = desync; }
  netStart(o: Omit<Extract<ToWorker, { type: 'netStart' }>, 'type'>) { this.post({ type: 'netStart', ...o }); }
  netReceive(msg: NetMsg) { this.post({ type: 'net', msg }); }
  netStop() { this.post({ type: 'netStop' }); }
  netResync() { this.post({ type: 'netResync' }); }
  /** Pokémon Quetzal co-op: each player runs their own game; only Mplayer's link messages travel. */
  qzStart(host: boolean, send: (m: QzMsg) => void, status: (text: string) => void) {
    this.ev.qz = send; this.ev.qzStatus = status; this.post({ type: 'qzStart', host });
  }
  qzReceive(msg: QzMsg) { this.post({ type: 'qz', msg }); }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.backup);
    this.unlockOff();
    this.ro?.disconnect();
    this.worker?.terminate();
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
  }
}
