// Two separate browsers play Pokémon Quetzal co-op through the real signaling server.
// Prereqs: `npm run build && npx vite preview`, and copy your own Quetzal ROM + an overworld save
// state to dist/_qz.gba / dist/_qz.state (dist is gitignored; nothing is committed).
import { chromium } from 'playwright';
const BASE = 'http://localhost:4173/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const mk = async name => {
  const p = await (await b.newContext({ viewport: { width: 1000, height: 720 } })).newPage();
  p.on('pageerror', e => console.log(name, 'PAGE ERROR', e.message));
  p.on('console', m => { if (/error|quetzal|co-op/i.test(m.text())) console.log(name, m.type(), m.text()); });
  await p.goto(BASE);
  await p.click('text=Get started');
  await p.waitForFunction(() => document.querySelectorAll('.tile').length >= 2);
  await p.evaluate(async () => {
    const rom = new File([await (await fetch('_qz.gba')).blob()], 'PokemonQuetzal.gba');
    const dt = new DataTransfer(); dt.items.add(rom);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => [...document.querySelectorAll('.tile')].some(t => /quetzal/i.test(t.textContent)), null, { timeout: 30000 });
  await p.evaluate(async () => {
    const state = await (await fetch('_qz.state')).blob();
    const db = await new Promise(r => { const q = indexedDB.open('nextgen-emulator'); q.onsuccess = () => r(q.result); });
    const games = await new Promise(r => { const q = db.transaction('games').objectStore('games').getAll(); q.onsuccess = () => r(q.result); });
    const g = games.find(x => /quetzal/i.test(x.title + x.fileName));
    await new Promise(r => { const t = db.transaction('states', 'readwrite'); t.objectStore('states').put({ id: g.id + ':0', gameId: g.id, slot: 0, state, thumb: null, createdAt: Date.now(), playTime: 0 }); t.oncomplete = r; });
  });
  return p;
};
const host = await mk('host'), guest = await mk('guest');
await host.click('button[aria-label="Multiplayer"]');
await host.fill('input[aria-label="Your name"]', 'Host');
await host.selectOption('select[aria-label="Game to host"]', { label: await host.$eval('select[aria-label="Game to host"]', s => [...s.options].find(o => /quetzal/i.test(o.text)).text) });
await host.click('text=Create room');
await host.waitForSelector('.pslots');
const room = (await host.inputValue('input[aria-label="Invite link"]')).split('join=')[1];
await guest.click('button[aria-label="Multiplayer"]');
await guest.fill('input[aria-label="Your name"]', 'Guest');
await guest.fill('input[aria-label="Room code"]', room);
await guest.click('form button:has-text("Join")');
await guest.waitForSelector('.pslots');
await guest.click('text=Ready up');
await host.waitForFunction(() => !document.querySelector('.lobby .btn.primary.big')?.disabled, null, { timeout: 30000 });
await host.click('text=Start game');
await Promise.all([host.waitForSelector('canvas.screen'), guest.waitForSelector('canvas.screen')]);
await sleep(3000);
const tap = async (p, k, wait = 350) => { await p.keyboard.down(k); await sleep(120); await p.keyboard.up(k); await sleep(wait); };
for (const p of [host, guest]) { await tap(p, 'Enter', 600); for (let i = 0; i < 4; i++) await tap(p, 'ArrowDown'); await tap(p, 'KeyX', 800); await tap(p, 'KeyX', 800); }
await sleep(1500);
await tap(host, 'KeyX', 3000);
for (let i = 0; i < 3; i++) await tap(guest, 'ArrowLeft', 300);
await sleep(1500);
const toasts = async p => p.$$eval('.toast, [class*=toast]', d => d.map(x => x.textContent.trim()).filter(Boolean)).catch(() => []);
console.log('host toasts', await toasts(host));
console.log('guest toasts', await toasts(guest));
for (const [n, p] of [['host', host], ['guest', guest]]) {
  const s = await p.evaluate(() => { const s = window.__kaiser?.stats; return s && { fps: Math.round(s.fps), emuFps: Math.round(s.emuFps), workMs: +s.workMs.toFixed(2) }; });
  console.log(n, JSON.stringify(s));
  await p.screenshot({ path: `${process.env.OUT ?? '.'}/qz-${n}.png` });
}
await b.close();
