# Benchmarks

Machine: Windows 11, 12 logical cores, Node 24, Chromium (Playwright, headless, real 60 Hz rAF). Date: 2026-11-02.
All numbers are single runs; expect roughly ±5–10 % run-to-run noise.

Test ROMs are the freely licensed homebrew in `public/homebrew/` (see LICENSES.md):
NES *Thwaite* · SNES *Breakout* · GB *Libbet* · GBC *µCity* · GBA *240p Test Suite* · Genesis *Cube 3D*.

## 1. Kaiser vs. stock EmulatorJS (browser, same ROMs, same machine)

`node bench/browser-bench.mjs` — EmulatorJS *stable* from its official CDN vs. this repo's production build.

| System | Max speed EJS → **Kaiser** (fps) | Speed-up | 2nd launch EJS → **Kaiser** | wasm memory EJS → **Kaiser** | 1 % low fps (EJS / Kaiser) | Audio underruns (Kaiser) |
|---|---|---|---|---|---|---|
| NES | 2 155 → **2 689** | 1.25× | 439 ms → **46 ms** | 128 → **64 MB** | 55.2 / 54.3 | 0 |
| SNES | 1 211 → **2 291** | 1.89× | 542 ms → **68 ms** | 128 → **64 MB** | 54.9 / 53.7 | 0 |
| Game Boy | 7 057 → **8 428** | 1.19× | 436 ms → **39 ms** | 128 → **64 MB** | 54.9 / 54.6 | 0 |
| Game Boy Color | 4 321 → **6 879** | 1.59× | 448 ms → **40 ms** | 128 → **64 MB** | 54.9 / 54.3 | 0 |
| GBA | 1 189 → **15 392** | 12.9×* | 474 ms → **41 ms** | 128 → **64 MB** | 54.6 / 52.5 | 0 |
| Genesis | 1 288 → **1 833** | 1.42× | 456 ms → **47 ms** | 512 → **64 MB** | 54.6 / 52.7 | 0 |

Normal-speed pacing is identical for both (60.0 fps, p99 frame interval ≈ 18–19 ms in headless Chromium, 0 frames
over 25 ms). Raw data: `bench/browser-results.json`.

**How it's measured**
- *Max speed* — EJS: RetroArch fast-forward with ratio 0 (unlimited) for 3 s, counting `getFrameNum()`.
  Kaiser: the worker's uncapped fast-forward path for 3 s (emulate as fast as possible, render only the ~60 frames/s that
  reach the screen — exactly what the ⏩ "Max" setting does). This is the user-visible fast-forward ceiling.
  \*The GBA test ROM is mostly idle; mGBA skips most work when it's told a frame won't be shown, which EJS's RetroArch
  build doesn't exploit. Expect a smaller gap in CPU-heavy GBA games.
- *2nd launch* — time from navigation to first emulated frame on a reload (cores cached). EJS re-extracts its 7z core
  archive on every launch; Kaiser instantiates a cached, streaming-compiled wasm module.
- *1st launch* (not in table, not comparable): EJS 0.7–1.5 s downloading from its CDN; Kaiser 50–70 ms from a local server.
- *1 % low* — 1000 / 99th-percentile interval between presented frames. Headless Chromium paces both identically; real
  displays may differ.
- *Memory* — size of the wasm heap. Kaiser cores start at 64 MB and never grew during these runs.

## 2. Compiler flags (raw core speed, Node, no rendering)

`node --experimental-strip-types bench/core-bench.ts --frames 3000` (optimized) vs. the same cores built with plain
`-O2` (`FLAVOR=baseline bash cores/build.sh`). Average CPU time per emulated frame with video + audio produced.

| System (core) | `-O2` ms/frame | `-O3 -flto -msimd128` ms/frame | Gain | 1 % worst frame | State size | Save / load state |
|---|---|---|---|---|---|---|
| NES (FCEUmm) | 0.266 | **0.263** | +1 % | 0.44 ms | 13 KB | 0.007 / 0.013 ms |
| SNES (Snes9x) | 0.438 | **0.402** | +9 % | 0.64 ms | 804 KB | 0.23 / 0.07 ms |
| GB (Gambatte)† | 0.112 | **0.099** | +13 % | 0.16 ms | 50 KB | 0.019 / 0.017 ms |
| GBC (Gambatte)† | 0.144 | **0.086** | +68 % | 0.15 ms | 178 KB | 0.048 / 0.013 ms |
| GBA (mGBA) | 0.272 | **0.187** | +45 % | 0.83 ms | 516 KB | 0.21 / 0.06 ms |
| Genesis (GPGX) | 0.729 | **0.650** | +12 % | 0.78 ms | 1 012 KB | 0.23 / 0.04 ms |

†Gambatte miscompiles under `-flto` (traps at load), so it ships with `-O2 -msimd128`; the gain shown is SIMD alone.

**Rollback cost.** An 8-frame rollback = 1 state load + 8 silent frames + saves: ≈ 2 ms (NES), ≈ 4 ms (SNES),
≈ 6 ms (Genesis) — comfortably inside a 16.7 ms frame. NES and SNES are rollback-ready; Genesis Plus GX was found to
restore state inexactly (see DECISIONS.md) and uses delay-based netplay instead.

## 3. Netplay (simulated network, two real cores)

`node --test --experimental-strip-types tests/rollback.test.ts` — two cores linked by a simulated network, 1 800 frames
each, random inputs, every 60th frame's state hash compared between peers **and** against an offline reference run.

| Core | 50 ms RTT, 1 % loss | 100 ms, 5 % loss | 200 ms, 1 % loss |
|---|---|---|---|
| NES rollback (delay 2, max 8) | 0 desyncs · 3 rollbacks | 0 desyncs · 163 rollbacks (avg 1.6 f) | 0 desyncs · 160 rollbacks (avg 4.3 f) |
| SNES rollback (delay 2, max 8) | 0 desyncs | 0 desyncs | 0 desyncs |
| Genesis delay-based (delay 4) | 0 desyncs | 0 desyncs | 0 desyncs |

All runs matched the offline reference bit-for-bit at every checkpoint.

## 4. Biggest bottlenecks found in EmulatorJS (Step 0 audit)

1. **Everything on the main thread.** The core, GL rendering, audio and UI share one thread; any UI work or GC pause
   steals emulation time. → Kaiser runs the core in a Web Worker and renders there via OffscreenCanvas.
2. **Full RetroArch inside every core.** Each core ships RetroArch's menu, video/audio drivers and runloop
   (≈2× larger downloads, 128–512 MB heaps). → Kaiser links cores against a ~250-line libretro frontend.
3. **7z core archives decompressed in JS on every launch** (~400–500 ms even when cached). → Plain `.wasm`, compiled with
   streaming compilation and cached by the service worker.
4. **Netplay streams video from the host** (latency, bandwidth, quality loss). → Rollback netcode, inputs only.
5. **Audio through RetroArch's OpenAL/WebAudio path** with no drift control. → AudioWorklet + shared ring buffer + dynamic
   rate control (±0.5 %).
