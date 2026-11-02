# Decisions

Every judgment call made while building this autonomously, with the reason. Newest at the bottom of each section.

## Product
1. **Name: "Kaiser"** (repo `nextgen-emulator`). Taken from the project folder name `KaiserEmlator`; short, ownable, no
   trademark conflict with any console maker. Logo is an original geometric "K".
2. **Original visual identity**: dark ink background, violet→cyan gradient accent, Outfit typeface, Lucide icons, rounded
   cards. Inspired by the *feel* of console home screens, copying none of their layouts or assets.
3. **Cover art is never scraped.** Games without user-provided art get a generated cover (title + system colour + icon).
4. **Bundled demo games**: only freely licensed homebrew with verified licenses (LICENSES.md). For SNES and Genesis no
   standalone open game with a prebuilt ROM was found, so the SDK samples *Breakout* (PVSnesLib, zlib) and *Cube 3D* /
   *Particles* (SGDK, MIT) are used. PVSnesLib's *LikeMario* example was **rejected** because its sprites are derived from
   Nintendo artwork.

## Engine architecture
5. **Own libretro frontend instead of EmulatorJS's RetroArch builds.** EJS cores embed all of RetroArch (menus, drivers,
   runloop). Linking the same cores against a ~250-line C frontend (`cores/glue/frontend.c`) gives direct control of
   frame stepping, save states, audio and input — prerequisites for worker rendering, rewind, fast-forward and rollback.
   Result: 2–10× faster launches, half (or less) the memory, higher max speed (BENCHMARKS.md).
6. **Cores chosen** (fastest *good* core per system, favouring accuracy when speed headroom is huge):
   - NES **FCEUmm** — broad mapper support, 0.26 ms/frame (≈60× real-time). QuickNES is faster but less compatible; Nestopia slower.
   - SNES **Snes9x (current)** — accurate and still 0.4 ms/frame (≈40× real-time). snes9x2010 is faster but less accurate and wasn't needed.
   - GB/GBC **Gambatte** — best accuracy, 0.1 ms/frame.
   - GBA **mGBA** — accurate, no BIOS needed. gpSP is faster but less compatible.
   - Genesis **Genesis Plus GX** — accurate (also SMS/GG). PicoDrive faster but less accurate.
7. **Compiler flags**: `-O3 -flto -msimd128` applied to every compile via `EMCC_CFLAGS`; measured +1…+68 %.
   **Gambatte exception**: `-flto` produces a wasm trap at load, so Gambatte uses `-O2 -msimd128`.
8. **No pthreads core builds.** libretro cores are single-threaded; a `-pthread` build adds proxying overhead without
   speed-up. SharedArrayBuffer is used where it matters — the lock-free audio ring between the emulation worker and the
   AudioWorklet. Non-isolated pages fall back to a MessagePort ring automatically.
9. **Pixel conversion in C to RGBA8.** One uniform texture format for any GPU API; costs ≈0.05 ms/frame.
10. **WebGL2 presenter (in the worker, on OffscreenCanvas); WebGPU not used.** Presenting one ≤512×448 texture through a
    single shader pass is not GPU-bound, so WebGPU brings no measurable gain, while WebGL2 works in workers on every
    current browser (Safari 17+, Firefox, Chrome). A main-thread renderer is the fallback when OffscreenCanvas transfer
    is unavailable. (Listed in NEEDS_REVIEW.md in case WebGPU is wanted anyway.)
11. **Frame pacing**: the main thread sends one `tick` per `requestAnimationFrame`. When the display rate is within 1.2 %
    of the core rate ("sync to display", on by default) exactly one frame runs per refresh — perfectly smooth at 60 Hz —
    and audio drift is absorbed by dynamic rate control. Otherwise (120/144 Hz, PAL, slow-mo) a fixed-step accumulator
    decides how many frames to run. A watchdog timer keeps the game running if rAF stalls while the page is visible.
12. **Audio**: AudioWorklet ring buffer; linear resampling in the worker; DRC nudges the rate ±0.5 % toward a 45 ms
    target (70 ms on touch devices). Silence is fed during rewind so releasing it never glitches.
13. **Input**: positional gamepad mapping (bottom face = libretro B …), correct for Xbox/PlayStation/Switch pads under the
    W3C standard mapping. Presses are *latched* until the next poll so taps shorter than a frame are never lost.

## Fast-forward / rewind / slow-motion
14. Fast-forward skips rendering (and, by default, audio mixing) for frames that aren't shown and tells the core via
    `GET_AUDIO_VIDEO_ENABLE`. Audio modes: stretched (default, normal pitch — plays only the shown frames' audio),
    pitched-up, muted. Speeds 2×/3×/4×/8×/Max; hold or toggle.
15. Rewind stores XOR deltas between consecutive save states with zero-run compression (lossless, typically 1–10 % of a
    state). Snapshots every frame for small states, every 2nd for states >300 KB. Memory budget 128 MB desktop /
    48 MB touch devices, and default length 45 s desktop / 15 s phones.

## Saves
16. Game id = SHA-256 of the ROM: deduplicates the library and is the netplay ROM check.
17. IndexedDB with `durability: 'strict'`; every write resolves only on commit. `navigator.storage.persist()` requested at
    startup and offered in Settings.
18. Auto-save (slot 0) on a timer (default 2 min), on pause, on `visibilitychange→hidden`, on `pagehide` and on exit; never
    `beforeunload`. 10 manual slots. Battery saves are written within ~0.5 s of the game changing them.
19. Backups are a single gzip-compressed JSON file (`.kaiser`): dependency-free and human-inspectable.

## Netplay
20. **GGPO-style rollback** in the worker; transport-agnostic so it is tested in Node with real cores over a simulated lossy
    network. Inputs go over unreliable/unordered WebRTC channels with redundancy (all unacknowledged inputs resent);
    hashes and resync states over a reliable channel.
21. **Strict mode**: during netplay the core is never told that frames are skipped. Tests found two cores change emulated
    state when audio/video is disabled, which would desync rollback re-simulation.
22. **Genesis uses delay-based netplay.** Tests showed Genesis Plus GX's state load is not exact (re-simulated frames drift by
    a few bytes that then spread). Delay-based lockstep never loads states and passes all network tests.
23. **GB/GBC/GBA have no netplay**: they're single-player without link-cable emulation.
24. Netplay always boots the game fresh with default core options and no battery save on every machine (identical start),
    and never auto-saves or writes SRAM — so a match can't overwrite single-player progress.
25. Desync → detected by periodic state hashes; the host ships its state (chunked over the reliable channel) once no
    predictions are outstanding. Logged to the console and shown as a toast.
26. A *player* disconnecting ends the match gracefully: everyone keeps playing offline from the current state. (Drop-in/out
    with an agreed cut-over frame is possible but was judged not worth the risk tonight.)
27. Lobby state is host-authoritative and travels over the signaling server's relay, so it works before P2P is connected.
    The signaling server is ~80 lines and is only run locally (never deployed).
28. **No friends system found.** The working folder contained no existing code, so invites are share links (`#join=CODE`) and
    the Web Share sheet.

## Frontend
29. **Preact + hand-written CSS design system** (≈50 KB gzipped app JS). Fonts and icons are bundled so the PWA works fully offline.
30. One service worker does both offline caching and COOP/COEP isolation; its cache name includes the build id so updated
    cores are never served stale. It reloads the page once on first visit to become isolated, guarded against loops.
31. Touch controls: one custom layout saved per system (drag, resize, opacity), instead of multiple named presets.
32. Cheats use the cores' own parsers (Game Genie, Pro Action Replay, GameShark, CodeBreaker… whatever each core supports).

## Testing
33. Tests use Node's built-in test runner with type-stripping (no framework). Browser benchmarks use Playwright headless
    Chromium because the automation browser window was rAF-throttled.
