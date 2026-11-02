// Captures every main screen at desktop / tablet / phone sizes into docs/screenshots/.
// Prereq: production build served at http://localhost:4173 (npx vite preview --port 4173).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEVICES = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: 'tablet', viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];
const only = process.argv[2];

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const d of DEVICES) {
  if (only && only !== d.name) continue;
  const ctx = await browser.newContext({ ...d, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(d.name, 'PAGE ERROR', e.message));
  const shot = async n => { await sleep(450); await page.screenshot({ path: `${OUT}/${d.name}-${n}.png` }); console.log(d.name, n); };

  await page.goto(BASE);
  await page.waitForSelector('.welcome');
  await shot('01-welcome');
  await page.click('text=Get started');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 8, null, { timeout: 30000 });
  await shot('02-library');

  // play a game so "Continue playing" fills in
  await page.click('.tile[aria-label^="Thwaite"]');
  await shot('03-details');
  await page.click('.details .btn.primary.big');
  await page.waitForSelector('canvas.screen');
  await sleep(1500);
  await page.keyboard.press('Enter'); await sleep(800); await page.keyboard.press('Enter'); await sleep(1500);
  await page.mouse.move(300, 300); await page.mouse.move(320, 320);
  await shot('04-ingame');
  await page.keyboard.down('Tab'); await sleep(900);
  await shot('05-fastforward');
  await page.keyboard.up('Tab');
  await page.keyboard.press('Escape');
  await shot('06-pause');
  await page.click('.mitem:has-text("Save state")');
  await shot('07-save-slots');
  await page.click('.slot >> nth=0'); await sleep(600);
  await page.keyboard.press('Escape');
  await page.click('.mitem:has-text("Exit to library")');
  await page.waitForSelector('.continue');
  await shot('08-library-continue');

  await page.click('.cont-card');
  await page.waitForSelector('canvas.screen'); await sleep(1500);
  await page.keyboard.press('Escape');
  await page.click('.mitem:has-text("Settings")');
  await shot('09-quick-settings');
  await page.keyboard.press('Escape'); // close the panel (full-screen on phones)
  await page.click('.mitem:has-text("Exit to library")');
  await page.waitForSelector('.continue');

  await page.click('button[aria-label="Settings"]');
  await shot('10-settings-video');
  await page.click('.settings nav button:has-text("Controls")');
  await shot('11-settings-controls');
  await page.click('.settings nav button:has-text("Saves")');
  await shot('12-settings-saves');
  await page.click('button[aria-label="Back"]');

  await page.click('button[aria-label="Multiplayer"]');
  await shot('13-multiplayer');
  await page.click('button[aria-label="Back"]');

  if (d.hasTouch) {
    await page.click('.tile[aria-label^="Breakout"]');
    await page.click('.details .btn.primary.big');
    await page.waitForSelector('.touch'); await sleep(2500);
    await shot('14-touch-snes');
    await page.click('button[aria-label="Exit to library"]').catch(() => {});
  }
  await ctx.close();
}
await browser.close();
