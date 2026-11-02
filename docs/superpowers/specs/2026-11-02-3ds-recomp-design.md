# 3DS games in the browser by static recompilation: design

Status: approved direction (owner, 2026-11-02: "do whatever it takes, answer the questions yourself").
Choices marked **(my call)** were made by the agent under that instruction and can be revisited.

## Intent

Play **Super Smash Bros. for Nintendo 3DS** in Kaiser, in the browser, **with a friend online**,
on a Chromebook or a PC. Not by emulating a 3DS: by **recompiling the game's code ahead of time into
WebAssembly**, the way N64Recomp (Majora's Mask) and XenonRecomp (Sonic Unleashed) produced native
ports. Pokémon Ultra Sun/Ultra Moon is a later target, if the approach pays off.

Why: browser emulators can't generate code at run time as fast as desktop emulators' JITs do, so a
3DS emulator in a browser is too slow for Smash. Ahead-of-time recompiled code runs close to native
WebAssembly speed.

## Goals

1. A recompiler that turns a 3DS game's ARM11 code (main program + its CRO modules) into WebAssembly.
2. A runtime that stands in for the 3DS: kernel calls, the system services the game uses (graphics,
   sound, files, input, local wireless...), and the PICA200 GPU drawn with WebGL2 (WebGPU later).
3. Smash: single player first, then **local-wireless versus over the internet** through Kaiser's
   rooms and Cloudflare signaling (same accounts, same relay fallback as GBA/DS multiplayer).
4. It lives inside Kaiser: a 3DS section in the library, saves in the browser + cloud saves.

## Non-goals

- A general 3DS emulator, or compatibility with "every game". Each supported game is a project.
- Nintendo's online services (dead).
- Speed work on slow Chromebooks before it runs at all (owner: "optimization later").

## Anti-goals (failure even if it "works")

- **Shipping any Nintendo code, assets, keys or recompiled output.** Kaiser's servers and repo never
  hold them. Each player provides their **own decrypted dump**; recompilation and caching happen
  **on their device** (IndexedDB), like Quetzal ROMs today.
- Downloading or embedding 3DS console keys (boot9/AES). Decryption is done by the player on their
  own 3DS (GodMode9); Kaiser only accepts decrypted dumps.
- Breaking existing systems (GBA/DS/etc.), accounts, or cloud saves.

## Ownership ("only owners can play")

A browser can't prove someone owns a cartridge. What actually protects the game is the model above:
no game data is ever distributed; the player's own dump is the input. On top, **(my call)** Kaiser
accepts only dumps whose program ID + content hash match a known retail release it supports
(a fingerprint, stored as hashes only), and says plainly that this is not DRM.

## Facts from stage 1 (inspector: `tools/3ds/inspect.mjs`)

- The provided Smash file (`CTR-P-AXCE`, program ID 00040000000EDF00, USA Rev 1, 2 GB) is **still
  encrypted** despite its name: NCCH crypto flags are set and the extended header is ciphertext.
  The full measurement (code size, functions, indirect jumps, CRO modules, services incl. `nwm::UDS`)
  runs as soon as a decrypted dump exists. The inspector writes to `3ds-work/` (gitignored).

## Architecture **(my call)**

```
player's decrypted .3ds ──► unpack (NCSD/NCCH/ExeFS/RomFS, BLZ)   [browser, Web Worker]
                         └► recompile: ARM11 .code + .cro ──► WebAssembly module(s), cached in IndexedDB
runtime (wasm + TS):  CPU state (r0-r15, CPSR, VFP s0-s31/d0-d15, FPSCR) in linear memory
                      3DS virtual memory: 0x00100000 code, heap, linear heap (FCRAM), VRAM, TLS
                      kernel HLE (SVCs: memory, threads, sync, IPC) ─ cooperative threads
                      services HLE: srv, APT, fs, gsp::Gpu, hid, dsp, cfg, ptm, ldr:ro, nwm::UDS, ...
                      PICA200 ─► WebGL2 (shader bytecode ─► GLSL, cached), Web Audio for DSP
Kaiser: library entry, input/touch (bottom screen), saves (ExtData/SaveData ─► IndexedDB + cloud)
```

Key technical decisions:

- **Recompiler output**: one wasm function per guest function, guest registers in memory (locals
  cached per block), direct calls as wasm calls, **indirect jumps through a lookup table**
  (guest address ─► function index) with a fallback **interpreter** for anything not found ahead of
  time (jump tables, code reached only through pointers). The interpreter also covers Thumb code.
  This hybrid (static + fallback) is what makes N64Recomp-style ports robust.
- **CRO modules**: Smash loads CROs via `ldr:ro`. Recompile each CRO ahead of time against its own
  base; at load time, apply relocations and register its functions in the lookup table.
- **Threads**: 3DS games use several threads on the app core (+ the system core). Run them as
  cooperative green threads on one wasm thread first (deterministic; good for netplay), with
  context switches at SVCs (wait/sleep/yield). Real parallelism later.
- **GPU**: HLE at the GSP command-list level: parse PICA200 register writes, translate vertex/
  geometry shaders (PICA bytecode) and the fixed-function fragment pipeline to GLSL, cache programs.
  Correctness first; WebGPU later for speed.
- **Audio**: DSP HLE (as Citra does: decode the AAC/ADPCM/PCM voice pipeline) to an AudioWorklet.
- **Multiplayer**: implement `nwm::UDS` (local wireless) as a virtual network whose frames travel
  over Kaiser's room data channels (WebRTC, server relay fallback). Smash's own netcode then runs
  unchanged, exactly like the Quetzal bridge forwards Mplayer's link messages.
- **Reference implementations**: Citra/Azahar/Panda3DS (GPL) document service and GPU behaviour.
  Kaiser is GPL-3.0, so their algorithms and code may be reused with attribution in LICENSES.md.

## Stages (each ends with a go/no-go)

1. **Measure** (done, blocked on a decrypted dump): inspector on Smash ─► code size, functions,
   indirect-jump density, CROs, services. Go if the code is mostly ARM-mode, CROs are loadable,
   and services are within reach.
2. **Pipeline on our own homebrew** (no Nintendo code needed): build small 3DS test programs with
   devkitARM/libctru (installed), recompile them to wasm, run them with minimal kernel + srv/APT/hid/
   gsp, draw the framebuffer. Then citro3d test programs for the GPU path.
3. **Smash boots**: all services it touches, CRO loading, file system over RomFS, title screen.
4. **Smash plays**: GPU accuracy, audio, input/touch, saves, menus, a full match vs CPU.
5. **Smash online**: `nwm::UDS` over Kaiser rooms, two players in a match.
6. **Speed** for Chromebooks; then evaluate Ultra Sun/Moon with the same inspector.

## Left to the builder

Instruction-coverage details, memory layout specifics, which GPU features first, test-ROM design.
