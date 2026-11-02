// Browser benchmark: stock EmulatorJS vs Kaiser, same ROMs, headless Chromium (real 60 Hz rAF).
// Prereqs: `npm run build && npx vite preview --port 4173` and `python -m http.server 8090 -d bench`.
// Usage: node bench/browser-bench.mjs [--only nes] [--json out.json]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', '');
const PACE_MS = 8000, MAX_MS = 3000;

const CASES = [
  { sys: 'nes', ejs: 'nes', kaiser: 'fceumm', rom: 'thwaite.nes' },
  { sys: 'snes', ejs: 'snes', kaiser: 'snes9x', rom: 'breakout.sfc' },
  { sys: 'gb', ejs: 'gb', kaiser: 'gambatte', rom: 'libbet.gb' },
  { sys: 'gbc', ejs: 'gb', kaiser: 'gambatte', rom: 'ucity.gbc' },
  { sys: 'gba', ejs: 'gba', kaiser: 'mgba', rom: '240pee_mb.gba' },
  { sys: 'genesis', ejs: 'segaMD', kaiser: 'genesis_plus_gx', rom: 'cube3d.gen', kaiserRom: 'sgdk-cube3d.gen' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function pacing(ts) {
  const iv = []; for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
  if (!iv.length) return { fps: 0, p99: 0, low1: 0, jitter: 0 };
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
  const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
  const p99 = pct(iv, 0.99);
  return { fps: +(1000 / mean).toFixed(1), p99: +p99.toFixed(1), low1: +(1000 / p99).toFixed(1), jitter: +sd.toFixed(2), late: iv.filter(x => x > 25).length };
}

async function runEngine(browser, engine, c) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = engine === 'ejs'
    ? `http://localhost:8090/ejs/index.html?core=${c.ejs}&rom=${c.rom}`
    : `http://localhost:4173/bench/kaiser.html?core=${c.kaiser}&rom=${c.kaiserRom ?? c.rom}`;
  const out = { engine, sys: c.sys };
  try {
    // cold load (empty cache) then warm load (second launch)
    for (const phase of ['cold', 'warm']) {
      const nav0 = Date.now();
      if (phase === 'cold') await page.goto(url); else await page.reload();
      await page.waitForFunction(() => window.started, null, { timeout: 120000 });
      const inPage = await page.evaluate(() => window.started - window.t0);
      out[phase + 'LoadMs'] = Math.round(Math.max(inPage, 0) + (await page.evaluate(() => performance.timing.responseEnd - performance.timing.navigationStart)));
      void nav0;
    }
    await sleep(1500); // settle

    if (engine === 'ejs') {
      const ts = await page.evaluate(async ms => {
        const gm = window.EJS_emulator.gameManager;
        const t = []; let last = gm.getFrameNum(); const end = performance.now() + ms;
        await new Promise(r => { const f = () => { const n = gm.getFrameNum(); if (n !== last) { t.push(performance.now()); last = n; } if (performance.now() < end) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
        return t;
      }, PACE_MS);
      Object.assign(out, pacing(ts));
      out.maxFps = await page.evaluate(async ms => {
        const gm = window.EJS_emulator.gameManager;
        gm.setFastForwardRatio(0); gm.toggleFastForward(1);
        await new Promise(r => setTimeout(r, 500));
        const a = gm.getFrameNum(), t = performance.now();
        await new Promise(r => setTimeout(r, ms));
        const fps = (gm.getFrameNum() - a) / ((performance.now() - t) / 1000);
        gm.toggleFastForward(0);
        return Math.round(fps);
      }, MAX_MS);
      out.wasmMB = await page.evaluate(() => Math.round((window.EJS_emulator.Module.HEAPU8?.length ?? 0) / 1048576));
    } else {
      await page.evaluate(() => window.emu.timings());
      await sleep(PACE_MS);
      const ts = await page.evaluate(async () => Array.from(await window.emu.timings()).filter(Boolean).sort((a, b) => a - b));
      Object.assign(out, pacing(ts));
      // underruns during the normal-speed run (the max-speed test below starves audio by design)
      out.underruns = await page.evaluate(async () => new Promise(r => { window.emu['ev'].stats = s => r(s.underruns); }));
      const r = await page.evaluate(ms => window.emu.benchMax(ms), MAX_MS);
      out.maxFps = Math.round(r.frames / (r.ms / 1000));
      out.wasmMB = 64; // INITIAL_MEMORY; cores never grew past it in bench/core-bench.ts
    }
  } catch (e) { out.error = String(e.message ?? e).split('\n')[0]; }
  if (errors.length) out.pageErrors = errors.slice(0, 3);
  await ctx.close();
  return out;
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results = [];
for (const c of CASES) {
  if (only && c.sys !== only) continue;
  for (const engine of ['ejs', 'kaiser']) {
    const r = await runEngine(browser, engine, c);
    results.push(r);
    console.log(JSON.stringify(r));
  }
}
await browser.close();
const out = opt('json', '');
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
