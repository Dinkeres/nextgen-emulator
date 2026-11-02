# Needs your review

Things I deliberately did not decide alone, or that you should know before relying on them.

## Licensing
1. **Non-commercial cores.** Snes9x and Genesis Plus GX are licensed for non-commercial use only (the same cores EmulatorJS
   ships). That matches your private, non-commercial site, but it means Kaiser as a whole must stay non-commercial. If you
   ever want a commercial-friendly build, swap them for bsnes/higan-style GPL cores (SNES) and PicoDrive (non-commercial
   too) / BlastEm (GPL-3, Genesis).
2. **GPL compatibility of mixing** GPL-3 code with non-commercial cores is the same gray area EmulatorJS is in. Not a
   problem for private use; worth a look before any wider distribution.

## Deployment / infrastructure
3. **Signaling server is not deployed anywhere.** Per your instructions it only runs locally (`npm run signal`).
   The public demo therefore cannot do online multiplayer until you host `server/signal.mjs` (≈80 lines, see
   `server/README.md`) behind `wss://` and set its URL in Settings → Multiplayer (or change the default in
   `src/app/store.ts`).
4. **TURN server.** Only public STUN is configured. Some players (symmetric NAT / mobile carriers) will need a TURN relay;
   add it to `ICE_SERVERS` in `src/net/session.ts`.
5. **Your existing emulator site was not touched.** To adopt Kaiser there, copy `dist/` and send the COOP/COEP headers
   from the README. Note COEP `require-corp` blocks cross-origin images/scripts that don't send CORP headers — check any
   ads/analytics/embeds on that site first.

## Scope I chose not to do (yet)
6. **WebGPU presenter** — skipped on purpose (DECISIONS.md #10): no measurable gain for this workload, WebGL2 is universal.
   Say the word if you want it anyway; the renderer is isolated in `src/engine/renderer.ts`.
7. **N64 / PS1 / NDS cores** are not included. They need GL-based or threaded cores and BIOS handling; I prioritised
   polishing six systems over shipping half-working ones (rule 2). The build script structure supports adding more.
8. **Friends system** — none existed in the (empty) project folder, so invites are share links. If your site has an
   account/friends API, `src/net/session.ts` is the place to hook it in (room code + `#join=CODE` link).
9. **Netplay drop-in/out** — if a player disconnects mid-match, everyone continues offline rather than seamlessly
   continuing with a bot/empty controller.
10. **Rollback for Genesis** — disabled because Genesis Plus GX doesn't restore state exactly (verified by tests). Could be
    revisited with a different Genesis core or by finding the unsaved field upstream.
11. **Real-hardware checks.** I verified everything in Chromium (desktop + emulated phone/tablet viewports). I could not test
    on a physical iPhone/Android device, a physical gamepad, or Safari/Firefox. Worth 10 minutes of your time.

## Housekeeping
12. Gambatte is built without LTO because LTO miscompiles it (wasm trap at load). If a future Emscripten fixes this, remove
    the exception in `cores/build.sh` for a free speed-up.
13. `docs/screenshots/` is ~8 MB of PNGs committed for the README; regenerate any time with `npm run screenshots`.
