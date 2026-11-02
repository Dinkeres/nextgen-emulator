// Long-session soak: cycles normal play / fast-forward / rewind / slow-mo / saves and samples
// memory (incl. the worker) and audio underruns. Usage: node bench/soak.mjs [minutes] [game]
import { chromium } from 'playwright';
const MIN = +(process.argv[2] ?? 4), GAME = process.argv[3] ?? 'Breakout';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-blink-features=ForceEagerMeasureMemory'] });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGE ERROR', e.message));
await p.goto('http://localhost:4173/');
await p.click('text=Get started');
await p.waitForFunction(() => document.querySelectorAll('.tile').length >= 8);
await p.click(`.tile[aria-label^="${GAME}"]`);
await p.click('.details .btn.primary.big');
await p.waitForSelector('canvas.screen'); await sleep(3000);
await p.keyboard.press('Enter');
const sample = async label => {
  const m = await p.evaluate(() => performance.memory?.usedJSHeapSize ?? -1);
  const s = await p.evaluate(() => { const s = window.__kaiser?.stats; return s && { fps: Math.round(s.fps), underruns: s.underruns, rewindMB: +s.rewindMB.toFixed(1), wasmMB: s.wasmMB, fill: s.audioFill }; });
  console.log(JSON.stringify({ t: label, jsHeapMB: +(m / 1048576).toFixed(1), ...s }));
};
await sample('start');
const t0 = Date.now();
let cycle = 0;
while (Date.now() - t0 < MIN * 60000) {
  await p.keyboard.down('ArrowRight'); await sleep(4000); await p.keyboard.up('ArrowRight');
  await p.keyboard.down('Tab'); await sleep(4000); await p.keyboard.up('Tab');          // fast-forward
  await p.keyboard.down('Backquote'); await sleep(2500); await p.keyboard.up('Backquote'); // rewind
  await p.keyboard.press('KeyG'); await sleep(2000); await p.keyboard.press('KeyG');   // slow-mo on/off
  await p.keyboard.press('F5'); await sleep(500);                                       // quick save
  await p.evaluate(() => window.__kaiser?.autoSave('timer'));
  if (++cycle % 4 === 0) await sample(`${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
await sample('end');
await b.close();
