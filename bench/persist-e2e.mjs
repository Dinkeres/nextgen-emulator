// Close the tab mid-game (no beforeunload), reopen, and verify progress was auto-saved and resumes.
// Prereq: production build on :4173. Usage: node bench/persist-e2e.mjs
import { chromium } from 'playwright';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext();
let p = await ctx.newPage();
await p.goto('http://localhost:4173/');
await p.click('text=Get started');
await p.waitForFunction(() => document.querySelectorAll('.tile').length >= 8);
await p.click('.tile[aria-label^="Thwaite"]');
await p.click('.details .btn.primary.big');
await p.waitForSelector('canvas.screen'); await sleep(2000);
await p.keyboard.press('Enter'); await sleep(1000); await p.keyboard.press('Enter'); await sleep(3000);
const closedAt = Date.now();
await p.close({ runBeforeUnload: false }); // like closing the tab
p = await ctx.newPage();
await p.goto('http://localhost:4173/');
const saved = await p.evaluate(() => new Promise(res => {
  const r = indexedDB.open('nextgen-emulator');
  r.onsuccess = () => {
    const t = r.result.transaction(['states', 'games']);
    const st = t.objectStore('states').getAll(), gs = t.objectStore('games').getAll();
    t.oncomplete = () => {
      const g = gs.result.find(x => x.title === 'Thwaite');
      const a = st.result.find(x => x.gameId === g.id && x.slot === 0);
      res({ autoSaveAt: a?.createdAt, stateBytes: a?.state.size, hasThumb: !!a?.thumb, playTime: g.playTime });
    };
  };
}));
await p.waitForSelector('.continue', { timeout: 20000 });
await p.click('.cont-card');
await p.waitForSelector('canvas.screen');
const resumed = await p.waitForSelector('.toast:has-text("Resumed")', { timeout: 8000 }).then(() => true).catch(() => false);
const res = { lostSeconds: +((closedAt - saved.autoSaveAt) / 1000).toFixed(1), hasThumb: saved.hasThumb, playTime: +saved.playTime.toFixed(1), resumed };
console.log(JSON.stringify(res));
await b.close();
process.exit(res.lostSeconds <= 2.5 && res.resumed ? 0 : 1);
