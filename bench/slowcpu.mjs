// Emulates a slow device (Chromebook-class) with DevTools CPU throttling and reports DS fps.
// Usage: node bench/slowcpu.mjs <throttle> <core> <rom> [heavy]
import { chromium } from 'playwright';
const [rate = '4', core = 'melonds', rom = 'Traffic_Escape_DS.nds', heavy = '0'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
const cdp = await p.context().newCDPSession(p);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: +rate });
await p.goto(`http://localhost:4173/bench/kaiser.html?core=${core}&rom=${rom}&heavy=${heavy}`);
await p.waitForFunction(() => window.started, null, { timeout: 120000 });
await p.waitForTimeout(4000);
const s = await p.evaluate(() => new Promise(r => { window.emu['ev'].stats = r; }));
await p.waitForTimeout(4000);
const s2 = await p.evaluate(() => new Promise(r => { window.emu['ev'].stats = r; }));
console.log(JSON.stringify({ throttle: rate, heavy, fps: Math.round(s2.fps), emuFps: Math.round(s2.emuFps), workMs: +s2.workMs.toFixed(1), underruns: s2.underruns - s.underruns }));
await b.close();
