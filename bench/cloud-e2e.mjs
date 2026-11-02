// Cloud saves across two "devices" (separate browsers) on one account, against a LOCAL copy of the
// account server (never the live one). Needs dist/_qz.gba (your own Quetzal ROM) and
// dist/_qz.state (an overworld state) staged locally; dist is gitignored.
import { chromium } from 'playwright';
const LIVE = 'https://horizon-test.luvrookie1.workers.dev', LOCAL = process.env.ACCOUNT_LOCAL ?? 'http://127.0.0.1:8799';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) process.exitCode = 1; };
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const user = 'cloud_' + (Date.now() % 1e6), email = user + '@example.test', pw = 'correct horse battery';
async function device(name, { state }) {
  const ctx = await b.newContext({ viewport: { width: 1000, height: 720 } });
  await ctx.route(LIVE + '/**', async r => r.fulfill({ response: await r.fetch({ url: r.request().url().replace(LIVE, LOCAL) }) }));
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log(name, 'PAGE ERROR', e.message));
  p.on('console', m => { if (/cloud/i.test(m.text())) console.log(name, m.type(), m.text()); });
  await p.goto('http://localhost:4173/');
  await p.click('text=Get started');
  await p.evaluate(async () => {
    const dt = new DataTransfer(); dt.items.add(new File([await (await fetch('_qz.gba')).blob()], 'PokemonQuetzal.gba'));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForSelector('.tile[aria-label*="Quetzal" i]', { timeout: 30000 });
  if (state) await p.evaluate(async () => {
    const st = await (await fetch('_qz.state')).blob();
    const db = await new Promise(r => { const q = indexedDB.open('nextgen-emulator'); q.onsuccess = () => r(q.result); });
    const g = (await new Promise(r => { const q = db.transaction('games').objectStore('games').getAll(); q.onsuccess = () => r(q.result); })).find(x => /quetzal/i.test(x.title));
    await new Promise(r => { const t = db.transaction('states', 'readwrite'); t.objectStore('states').put({ id: g.id + ':0', gameId: g.id, slot: 0, state: st, thumb: null, createdAt: Date.now() - 864e5, playTime: 0 }); t.oncomplete = r; });
  });
  return p;
}
const signIn = async (p, up) => {
  await p.click('text=Sign in');
  if (up) { await p.click('button.chip:has-text("Create account")'); await p.fill('input[aria-label="Username"]', user); }
  await p.fill('input[aria-label="Email"]', email);
  await p.fill('input[aria-label="Password"]', pw);
  await p.click('form button[type=submit]');
  await p.waitForSelector('text=Sign out');
  await p.click('button[aria-label="Back"], text=Library').catch(() => p.goto('http://localhost:4173/'));
};
const play = async p => {
  await p.click('.tile[aria-label*="Quetzal" i]');
  await p.click('button.btn.primary.big');
  await p.waitForSelector('canvas.screen');
};
const sram = p => p.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('nextgen-emulator'); q.onsuccess = () => r(q.result); });
  const all = await new Promise(r => { const q = db.transaction('sram').objectStore('sram').getAll(); q.onsuccess = () => r(q.result); });
  const s = all[0]; if (!s) return null;
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s[i]) | 0; return { len: s.length, h };
});
const tap = async (p, k, wait = 400) => { await p.keyboard.down(k); await sleep(120); await p.keyboard.up(k); await sleep(wait); };

// device A: sign up, play, save in-game, quit
const A = await device('A', { state: true });
await signIn(A, true);
await A.goto('http://localhost:4173/');
await play(A);
await sleep(3000);
await tap(A, 'Enter', 700); await tap(A, 'ArrowDown'); await tap(A, 'ArrowDown'); await tap(A, 'KeyX', 1500);
for (let i = 0; i < 4; i++) await tap(A, 'KeyX', 1500); // "save?" yes, (overwrite? yes), confirmations
await sleep(9000);
const aSram = await sram(A);
ok(!!aSram, 'device A has an in-game save ' + JSON.stringify(aSram));
await A.keyboard.press('Escape'); await sleep(500); await A.click('text=Exit to library');
await sleep(4000);
const list = await A.evaluate(async () => (await fetch('https://horizon-test.luvrookie1.workers.dev/api/saves', { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('horizon-test-session')).token } })).json());
ok(list.saves?.some(s => s.kind === 'sram') && list.saves?.some(s => s.kind === 'state'), 'cloud has the in-game save and the resume point ' + JSON.stringify(list.saves?.map(s => [s.kind, s.size])));

// device B: fresh browser, sign in, add the same ROM, press play
const B = await device('B', { state: false });
ok(!(await sram(B)), 'device B starts with no save');
await signIn(B, false);
await B.goto('http://localhost:4173/');
await play(B);
ok(await B.waitForSelector('text=Picked up where you left off', { timeout: 15000 }).then(() => true, () => false), 'device B shows it picked up the cloud save');
await sleep(2000);
const bSram = await sram(B);
ok(bSram && aSram && bSram.h === aSram.h && bSram.len === aSram.len, 'device B has the same in-game save as A');
await B.screenshot({ path: (process.env.OUT ?? '.') + '/cloud-B.png' });
await b.close();
