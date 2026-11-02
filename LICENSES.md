# Licenses and credits

Kaiser is free software released under the **GNU General Public License v3.0 or later** (see `LICENSE`).

It was designed by studying **[EmulatorJS](https://github.com/EmulatorJS/EmulatorJS)** (GPL-3.0) — its core loading,
rendering, audio, input, storage and netplay — and uses the same family of libretro emulator cores. Thank you to the
EmulatorJS and libretro communities. The frontend, engine and netcode here were written from scratch; no EmulatorJS
source files are included.

## Emulator cores (compiled to WebAssembly, shipped in `public/cores/`)

| System | Core | Upstream | License |
|---|---|---|---|
| NES / Famicom | FCEUmm | https://github.com/libretro/libretro-fceumm | GPL-2.0-or-later |
| SNES / Super Famicom | Snes9x | https://github.com/libretro/snes9x | Snes9x license — free for **non-commercial** use, source must be available |
| Game Boy / Game Boy Color | Gambatte | https://github.com/libretro/gambatte-libretro | GPL-2.0 |
| Game Boy Advance | mGBA | https://github.com/libretro/mgba (mirror of mgba-emu/mgba) | MPL-2.0 |
| Genesis / Mega Drive / Master System / Game Gear | Genesis Plus GX | https://github.com/libretro/Genesis-Plus-GX | Genesis Plus GX license — free for **non-commercial** use |

Core sources are fetched by `cores/fetch.sh` and built unmodified by `cores/build.sh`; the only addition is our own glue
(`cores/glue/frontend.c`, GPL-3.0). The Snes9x and Genesis Plus GX licenses forbid commercial use — the same terms
EmulatorJS ships under. Kaiser must therefore only be used non-commercially (see NEEDS_REVIEW.md).

## Libraries linked into the cores

| Component | License |
|---|---|
| libretro API header (`cores/glue/libretro.h`) and libretro-common | MIT |
| Emscripten runtime | MIT / University of Illinois NCSA |
| zlib (Emscripten port) | zlib |

## Frontend dependencies

| Package | License |
|---|---|
| Preact | MIT |
| lucide-preact (icons) | ISC |
| Outfit typeface via @fontsource-variable/outfit | SIL Open Font License 1.1 (font), MIT (package) |
| Vite, TypeScript, Playwright (dev only) | MIT / Apache-2.0 / Apache-2.0 |
| ws (signaling server) | MIT |
| fake-indexeddb (tests only) | Apache-2.0 |

The service worker's COOP/COEP technique follows the idea of [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT); the code in `public/sw.js` is original.

## Bundled homebrew (`public/homebrew/`)

All bundled games are freely licensed and redistributed with attribution. No commercial ROMs, BIOS files or copyrighted
game content are included or downloaded.

| File | Title | Author | License | Source |
|---|---|---|---|---|
| thwaite.nes | Thwaite | Damian Yerrick | GPL-3.0 | https://github.com/pinobatch/thwaite-nes |
| croom.nes | Concentration Room | Damian Yerrick | GPL-3.0 | https://github.com/pinobatch/croom-nes |
| 240pee.nes, gb240p.gb, 240pee_mb.gba | 240p Test Suite (mini) | Damian Yerrick, after Artemio Urbina | GPL-2.0 | https://github.com/pinobatch/240p-test-mini |
| libbet.gb | Libbet and the Magic Floor | Damian Yerrick | zlib | https://github.com/pinobatch/libbet |
| ucity.gbc | µCity | Antonio Niño Díaz | GPL-3.0 (code), CC BY-SA 4.0 (graphics & music) | https://github.com/AntonioND/ucity |
| breakout.sfc | Breakout (PVSnesLib example) | Alekmaul, based on Ulrich Hecht's SNES SDK demo | zlib (PVSnesLib) | https://github.com/alekmaul/pvsneslib |
| sgdk-cube3d.gen | Cube 3D (SGDK sample) | Stephane Dallongeville | MIT | https://github.com/Stephane-D/SGDK |
| sgdk-partic.gen | Particles (SGDK sample) | Stephane Dallongeville | MIT | https://github.com/Stephane-D/SGDK |

The GPL-licensed homebrew ROMs are distributed with their source available at the linked repositories.
