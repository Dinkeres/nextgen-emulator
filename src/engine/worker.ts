/// <reference lib="webworker" />
// Emulation worker: owns the core, timing, audio production, rewind and rendering.
// The main thread sends one `tick` per requestAnimationFrame with the current input.
import { Core, RUN_AUDIO, RUN_FF, RUN_VIDEO } from './core.ts';
import { LinkCore } from './linkcore.ts';
import { Renderer, type DisplayOptions } from './renderer.ts';
import { RewindBuffer } from './rewind.ts';
import { Rollback, packInput, type NetMsg } from '../net/rollback.ts';
import type { ToWorker, FromWorker, FFAudio } from './protocol.ts';
import { QuetzalLink } from '../net/quetzal.ts';

let core: Core | LinkCore;
const carry = [0, 0, 0, 0];
const silence = new Float32Array(4096 * 2);
let revBuf = new Int16Array(0);
let renderer: Renderer | null = null;
let rewind: RewindBuffer | null = null;
let rollback: Rollback | null = null;
let qz: QuetzalLink | null = null;

const S = {
  speed: 1, paused: true, rewinding: false, ffAudio: 'stretch' as FFAudio, volume: 1,
  acc: 0, frame: 0, rewindGran: 1, rewindEnabled: true,
  frameskip: 'auto' as 'auto' | 'off', skipping: false, frameCost: 0,
  vsyncLock: true, displayHz: 60,
  // audio
  outRate: 48000, ring: null as Float32Array | null, ctl: null as Int32Array | null, cap: 0,
  port: null as MessagePort | null, portFill: 0, portUnder: 0,
  pos: 0, lastL: 0, lastR: 0, targetFill: 2048,
  // stats
  emuFrames: 0, shownFrames: 0, statT: 0, workMs: 0,
  sramCopy: null as Uint8Array | null,
};

const post = (m: FromWorker, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': await init(m); break;
      case 'tick': if (m.stylus) applyStylus(m.stylus); tick(m.now, m.dt, m.inputs, m.vsync); break;
      case 'set':
        if (m.speed !== undefined) { S.speed = m.speed; S.acc = 0; }
        if (m.paused !== undefined) { S.paused = m.paused; if (!m.paused) primeAudio(); }
        if (m.rewinding !== undefined) S.rewinding = m.rewinding && !!rewind && !rollback;
        if (m.ffAudio) S.ffAudio = m.ffAudio;
        if (m.volume !== undefined) S.volume = m.volume;
        if (m.displayHz) S.displayHz = m.displayHz;
        if (m.vsyncLock !== undefined) S.vsyncLock = m.vsyncLock;
        if (m.frameskip) S.frameskip = m.frameskip;
        if (m.display && renderer) { renderer.opts = { ...renderer.opts, ...m.display }; renderer.redraw(); }
        if (m.rewind) configureRewind(m.rewind.enabled, m.rewind.seconds, m.rewind.budgetMB, m.rewind.heavy);
        if (m.options) for (const [k, v] of Object.entries(m.options)) core.setOption(k, v);
        break;
      case 'resize': renderer?.resize(m.w, m.h); renderer?.redraw(); break;
      case 'saveState': {
        const state = core.saveState();
        const thumb = await thumbnail();
        post({ type: 'state', id: m.id, state, thumb, frame: S.frame }, [state.buffer]);
        break;
      }
      case 'loadState': {
        const ok = core.loadState(new Uint8Array(m.state));
        rewind?.clear(); S.acc = 0;
        // render the loaded frame immediately so paused loads are visible
        core.run(RUN_VIDEO); present();
        post({ type: 'loaded', id: m.id, ok });
        break;
      }
      case 'reset': core.reset(); rewind?.clear(); break;
      case 'cheats': core.cheats(m.codes); break;
      case 'screenshot': post({ type: 'screenshot', id: m.id, png: await thumbnail('image/png', 0) }); break;
      case 'net': rollback?.receive(m.msg); break;
      case 'netStart': startNet(m); break;
      case 'netStop': rollback = null; core.setStrict(false); qz?.stop(); qz = null; break;
      case 'qzStart':
        if (!(core instanceof Core)) break;
        qz = new QuetzalLink(core, m.host, msg => post({ type: 'qz', msg }));
        qz.onStatus = text => post({ type: 'qzStatus', text });
        break;
      case 'qz': qz?.receive(m.msg); break;
      case 'bench': {
        // max throughput the way uncapped fast-forward runs: frames are emulated as fast as
        // possible and only those that reach the screen (~60/s) are rendered
        const t = performance.now(); let n = 0, shown = t;
        while (performance.now() - t < m.ms) {
          const show = performance.now() - shown >= 1000 / 60;
          core.run(show ? RUN_VIDEO | RUN_AUDIO | RUN_FF : RUN_FF);
          if (show) { present(); shown = performance.now(); }
          n++;
        }
        post({ type: 'bench', id: m.id, frames: n, ms: performance.now() - t });
        break;
      }
      case 'timings': { const t = presentLog.slice(); presentLog.fill(0); presentIdx = 0; post({ type: 'timings', id: m.id, t }, [t.buffer]); break; }
      case 'netResync': if (rollback) rollback.resyncPending = true; break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};

async function init(m: Extract<ToWorker, { type: 'init' }>) {
  const factory = (await import(/* @vite-ignore */ m.coreUrl)).default;
  if (m.link) {
    core = await LinkCore.create(factory, m.link.roms.map(r => new Uint8Array(r)), m.link.srams.map(s => s ? new Uint8Array(s) : null), m.link.view);
  } else {
    const c = await Core.create(factory);
    core = c;
    for (const [k, v] of Object.entries(m.options ?? {})) c.setOption(k, v);
    for (const [k, v] of Object.entries(m.systemFiles ?? {})) c.writeSystemFile(k, new Uint8Array(v));
    if (!c.load(new Uint8Array(m.rom), m.fileName)) throw new Error('This game could not be loaded by the ' + m.coreUrl.split('/').pop()?.replace('.mjs', '') + ' core.');
    if (m.sram) c.setSram(new Uint8Array(m.sram));
  }
  if (m.strict) core.setStrict(true);
  S.sramCopy = core.sram()?.slice() ?? null;
  if (m.canvas) {
    renderer = new Renderer(m.canvas);
    renderer.coreAspect = core.av.aspect;
    if (m.display) renderer.opts = { ...renderer.opts, ...m.display };
  }
  S.outRate = m.audio.rate;
  S.targetFill = Math.round(S.outRate * (m.audio.latencyMs ?? 45) / 1000);
  if (m.audio.sab) {
    S.ring = new Float32Array(m.audio.sab.data); S.ctl = new Int32Array(m.audio.sab.ctl); S.cap = S.ring.length / 2;
  } else if (m.audio.port) {
    S.port = m.audio.port; S.cap = m.audio.capacity;
    S.port.onmessage = ev => { S.portFill = ev.data.fill; S.portUnder = ev.data.underruns; };
  }
  configureRewind(m.rewind?.enabled ?? true, m.rewind?.seconds ?? 30, m.rewind?.budgetMB ?? 96, m.rewind?.heavy);
  const resumed = m.state ? core.loadState(new Uint8Array(m.state)) : false;
  // draw the first frame so the screen isn't black before the first tick
  core.run(RUN_VIDEO); present();
  post({ type: 'ready', av: core.av, coreName: core.name, coreVersion: core.version, options: core.options(), stateSize: core.stateSize(), hasSram: !!core.sram(), resumed });
}

let rewindTick = 0;
let snapshotMs = -1; // measured cost of one rewind snapshot on this device
function configureRewind(enabled: boolean, seconds: number, budgetMB: number, heavy = false) {
  S.rewindEnabled = enabled;
  if (!enabled) { rewind = null; return; }
  const size = core.stateSize();
  if (!size) { rewind = null; return; }
  // Measure what a snapshot costs here (state save + delta compression). DS states are ~6 MB and
  // can cost several times more than emulating the frame, which wrecks slow devices.
  if (snapshotMs < 0) {
    const probe = new RewindBuffer(64 << 20);
    probe.push(core.saveState());
    const t = performance.now();
    for (let i = 0; i < 3; i++) probe.push(core.saveState());
    snapshotMs = (performance.now() - t) / 3;
  }
  if (snapshotMs > 5 && !heavy) {
    rewind = null; S.rewindEnabled = false;
    post({ type: 'notice', code: 'rewind-heavy' });
    return;
  }
  // snapshot often enough to feel smooth but keep the average overhead ~1.5 ms per frame
  S.rewindGran = Math.min(30, Math.max(size > 300_000 ? 2 : 1, Math.ceil(snapshotMs / 1.5)));
  // ~estimate 6% of state size per delta; clamp to the budget
  const want = seconds * core.av.fps / S.rewindGran * size * 0.06;
  const budget = Math.min(want, budgetMB * 1048576);
  if (rewind) rewind.budgetBytes = budget; else rewind = new RewindBuffer(budget);
}

// ---------------- frame loop ----------------
function tick(now: number, dt: number, inputs: number[], vsync: boolean) {
  if (!core) return;
  const t0 = performance.now();
  if (rollback) { netTick(inputs); finishTick(t0, now); return; }
  if (S.paused) { finishTick(t0, now); return; }

  if (S.rewinding && rewind) {
    let st: Uint8Array | null = null;
    // play back at ~2x real time whatever the snapshot interval
    rewindTick++;
    const every = Math.max(1, Math.floor(S.rewindGran / 2));
    const steps = rewindTick % every === 0 ? Math.max(1, Math.round(2 / S.rewindGran)) : 0;
    for (let i = 0; i < steps; i++) { const s = rewind.pop(); if (s) st = s; else break; }
    if (st) {
      core.loadState(st); core.run(RUN_VIDEO | RUN_AUDIO); present(); S.emuFrames++;
      // play this frame's sound backwards (quieter) for the classic rewind effect
      const a = core.audio();
      if (a.length) {
        if (revBuf.length < a.length) revBuf = new Int16Array(a.length);
        const n = a.length >> 1;
        for (let i = 0; i < n; i++) { revBuf[i * 2] = a[(n - 1 - i) * 2]; revBuf[i * 2 + 1] = a[(n - 1 - i) * 2 + 1]; }
        pushAudio(revBuf.subarray(0, a.length), 1, 0.5);
      }
    }
    // keep the audio ring primed with silence so releasing rewind doesn't glitch
    const want = S.targetFill - fill();
    if (want > 0) writeFrames(silence.subarray(0, Math.min(want, silence.length >> 1) * 2));
    finishTick(t0, now);
    return;
  }

  const fps = core.av.fps;
  let n: number;
  // Auto frameskip: if emulating + drawing a frame doesn't fit the refresh budget, leave the
  // one-frame-per-refresh lock so the accumulator runs 2 frames per tick and only the last is drawn
  // (cores that honour GET_AUDIO_VIDEO_ENABLE, like melonDS, skip drawing the others).
  const budget = 1000 / Math.max(30, S.displayHz);
  if (S.frameskip === 'auto') {
    if (!S.skipping && S.frameCost > budget * 0.8) S.skipping = true;
    else if (S.skipping && S.frameCost < budget * 0.45) S.skipping = false;
  } else S.skipping = false;
  const locked = !S.skipping && vsync && S.vsyncLock && S.speed === 1 && Math.abs(S.displayHz - fps) / fps < 0.012;
  if (locked) { n = 1; S.acc = 0; }
  else {
    S.acc += Math.min(dt, 100) / 1000 * fps * S.speed;
    n = Math.floor(S.acc);
    S.acc -= n;
    const cap = Math.max(2, Math.ceil(S.speed * 3));
    if (n > cap) { n = cap; S.acc = 0; }
  }
  // taps that happen during ticks with no emulated frame (120Hz+, slow-mo) carry over
  for (let p = 0; p < inputs.length; p++) { core.setInput(p, inputs[p] | carry[p]); carry[p] = n ? 0 : carry[p] | inputs[p]; }
  const uncapped = S.speed >= 100; // "uncapped": run as many frames as fit in ~10ms
  const ff = S.speed > 1;
  const deadline = t0 + 10;
  for (let i = 0; uncapped ? performance.now() < deadline : i < n; i++) {
    const last = uncapped ? performance.now() + (S.workMs / Math.max(1, i)) >= deadline : i === n - 1;
    let flags = last ? RUN_VIDEO : 0;
    const wantAudio = !ff || S.ffAudio === 'pitch' || (S.ffAudio === 'stretch' && last);
    if (wantAudio) flags |= RUN_AUDIO;
    if (ff) flags |= RUN_FF;
    core.run(flags);
    qz?.frame();
    if (i === 0) for (let p = 0; p < inputs.length; p++) core.setInput(p, inputs[p]);
    S.frame++; S.emuFrames++;
    if (wantAudio) pushAudio(core.audio(), ff && S.ffAudio === 'pitch' ? S.speed : S.speed < 1 ? S.speed : 1);
    if (rewind && S.frame % S.rewindGran === 0) rewind.push(core.saveState());
    if (last) { present(); }
    if (uncapped && last) break;
  }
  if (n && !uncapped) S.frameCost = S.frameCost * 0.95 + (performance.now() - t0) / n * 0.05;
  if (S.frame % 30 === 0) checkSram();
  finishTick(t0, now);
}

/** Canvas-relative stylus -> libretro pointer space over the emulated frame (local port 0). */
let stylusState: [number, number, number] = [0, 0, 0];
/** Latest local touch in pointer space, or null when not touching (folded into netplay input). */
let localTouch: [number, number] | null = null;
function applyStylus(s: [number, number, number]) {
  stylusState = s;
  const clamp = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * 65535 - 32768)));
  let fx = s[0], fy = s[1];
  if (renderer) {
    const [vx, vy, vw, vh] = renderer.viewport();
    const c = renderer.size();
    fx = (s[0] * c[0] - vx) / vw; fy = (s[1] * c[1] - vy) / vh;
  }
  const down = !!s[2] && fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
  localTouch = down ? [clamp(fx), clamp(fy)] : null;
  if (!rollback) core.setPointer(0, clamp(fx), clamp(fy), down);
}
void stylusState;

function finishTick(t0: number, now: number) {
  S.workMs = S.workMs * 0.9 + (performance.now() - t0) * 0.1;
  if (now - S.statT >= 1000) {
    const secs = (now - S.statT) / 1000;
    post({
      type: 'stats', emuFps: S.emuFrames / secs, fps: S.shownFrames / secs, workMs: S.workMs,
      audioFill: fill(), underruns: S.ctl ? Atomics.load(S.ctl, 2) : S.portUnder,
      skipping: S.skipping,
      rewindSeconds: rewind ? rewind.length * S.rewindGran / core.av.fps : 0, rewindMB: rewind ? rewind.usedBytes / 1048576 : 0, wasmMB: core.memoryBytes / 1048576,
      net: rollback?.stats(),
    });
    S.emuFrames = 0; S.shownFrames = 0; S.statT = now;
  }
}

const presentLog = new Float64Array(4096);
let presentIdx = 0;
function present() {
  const f = core.frame();
  if (!f.width) return;
  S.shownFrames++;
  presentLog[presentIdx++ & 4095] = performance.now();
  if (renderer) {
    if (core.av.width !== f.width || core.av.height !== f.height) { core.refreshAV(); renderer.coreAspect = core.av.aspect; }
    renderer.draw(f.data, f.width, f.height);
  } else {
    const copy = f.data.slice();
    post({ type: 'frame', data: copy, width: f.width, height: f.height, aspect: core.av.aspect }, [copy.buffer]);
  }
}

function checkSram() {
  const s = core.sram();
  if (!s || !S.sramCopy) return;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== S.sramCopy[i]) {
      S.sramCopy = s.slice();
      const out = s.slice();
      post({ type: 'sram', data: out }, [out.buffer]);
      return;
    }
  }
}

async function thumbnail(type = 'image/webp', quality = 0.8): Promise<Blob | null> {
  const f = core.frame();
  if (!f.width || typeof OffscreenCanvas === 'undefined') return null;
  const c = new OffscreenCanvas(f.width, f.height);
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
  // stretch to display aspect so thumbnails look right (e.g. NES 8:7 pixels)
  const h = f.height, w = Math.round(h * core.av.aspect);
  if (w === f.width) return c.convertToBlob({ type, quality });
  const c2 = new OffscreenCanvas(w, h);
  const ctx2 = c2.getContext('2d')!;
  ctx2.imageSmoothingEnabled = false;
  ctx2.drawImage(c, 0, 0, w, h);
  return c2.convertToBlob({ type, quality });
}

// ---------------- audio ----------------
function fill(): number {
  if (S.ctl) return (Atomics.load(S.ctl, 0) - Atomics.load(S.ctl, 1) + S.cap) % S.cap;
  return S.portFill;
}

function primeAudio() {
  // start at the target latency with silence so the first frames don't underrun
  const f = fill();
  if (f < S.targetFill) writeFrames(new Float32Array((S.targetFill - f) * 2));
  if (S.ctl) Atomics.store(S.ctl, 2, 0);
}

let resampleBuf = new Float32Array(8192);
/** Linear resample int16 stereo to the output rate with dynamic rate control. */
function pushAudio(src: Int16Array, timeScale: number, gain = 1) {
  const frames = src.length >> 1;
  if (!frames || (!S.ring && !S.port)) return;
  const f = fill();
  if (f > S.targetFill * 3) return; // way too far ahead (e.g. tab was throttled) — drop
  // DRC: nudge rate ±0.5% to keep the buffer near target, which hides clock drift between
  // the core's nominal rate and the real audio clock without audible pitch change.
  const err = Math.max(-1, Math.min(1, (f - S.targetFill) / S.targetFill));
  const step = core.av.sampleRate / S.outRate * timeScale * (1 + err * 0.005);
  const outMax = Math.ceil(frames / step) + 4;
  if (resampleBuf.length < outMax * 2) resampleBuf = new Float32Array(outMax * 2);
  const v = S.volume * gain / 32768;
  let pos = S.pos, o = 0;
  while (pos < frames) {
    const i = Math.floor(pos), fr = pos - i;
    const l0 = i === 0 ? S.lastL : src[(i - 1) * 2], r0 = i === 0 ? S.lastR : src[(i - 1) * 2 + 1];
    const l1 = src[i * 2], r1 = src[i * 2 + 1];
    resampleBuf[o++] = (l0 + (l1 - l0) * fr) * v;
    resampleBuf[o++] = (r0 + (r1 - r0) * fr) * v;
    pos += step;
  }
  S.pos = pos - frames;
  S.lastL = src[(frames - 1) * 2]; S.lastR = src[(frames - 1) * 2 + 1];
  writeFrames(resampleBuf.subarray(0, o));
}

function writeFrames(buf: Float32Array) {
  const n = buf.length >> 1;
  if (S.ring && S.ctl) {
    let w = Atomics.load(S.ctl, 0);
    const r = Atomics.load(S.ctl, 1);
    const free = S.cap - 1 - ((w - r + S.cap) % S.cap);
    const k = Math.min(n, free);
    for (let i = 0; i < k; i++) { S.ring[w * 2] = buf[i * 2]; S.ring[w * 2 + 1] = buf[i * 2 + 1]; w = (w + 1) % S.cap; }
    Atomics.store(S.ctl, 0, w);
  } else if (S.port) {
    const copy = buf.slice();
    S.port.postMessage(copy, [copy.buffer]);
    S.portFill += n; // optimistic until the worklet reports back
  }
}

// ---------------- netplay (rollback) ----------------
function startNet(m: Extract<ToWorker, { type: 'netStart' }>) {
  rewind?.clear();
  core.setStrict(true);
  netAcc = 0;
  S.rewinding = false;
  rollback = new Rollback({
    core, localPort: m.localPort, players: m.players, inputDelay: m.inputDelay, maxRollback: m.maxRollback, shared: m.shared,
    send: (msg: NetMsg) => post({ type: 'net', msg }),
    onDesync: (frame: number) => post({ type: 'netEvent', event: 'desync', frame }),
    startState: m.state ? new Uint8Array(m.state) : undefined,
  });
  S.acc = 0;
  primeAudio();
}

let netAcc = 0;
function netTick(inputs: number[]) {
  if (!rollback) return;
  // one emulated frame per ~60Hz tick; high-refresh displays accumulate fractional frames
  netAcc += Math.min(2, core.av.fps / Math.max(30, S.displayHz));
  let shown = false;
  while (netAcc >= 1) {
    netAcc--;
    const res = rollback.advance(packInput(inputs[0] ?? 0, localTouch), netAcc < 1);
    if (res.ran) { S.frame++; S.emuFrames++; pushAudio(core.audio(), 1); shown = true; }
  }
  if (shown) present();
}
