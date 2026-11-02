// End-to-end netplay: two browser pages, local signaling server, real WebRTC.
// Prereqs: production build on :4173 (vite preview) and `npm run signal` on :8787.
import { chromium } from 'playwright';
const BASE = 'http://localhost:4173/';
const GAME = process.argv[2] ?? 'Thwaite';
const SECONDS = +(process.argv[3] ?? 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const mk = async name => {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 760 } });
  const p = await ctx.newPage();
  // FORCE_RELAY=1: break WebRTC so traffic must use the signaling-server relay
  if (process.env.FORCE_RELAY) await p.addInitScript(() => {
    window.RTCPeerConnection = class { constructor() { this.connectionState = 'new'; }
      createDataChannel(label) { return { label, readyState: 'connecting', send() {}, set onmessage(_) {}, set onopen(_) {} }; }
      async createOffer() { return { type: 'offer', sdp: '' }; } async createAnswer() { return { type: 'answer', sdp: '' }; }
      async setLocalDescription(d) { this.localDescription = d; } async setRemoteDescription() {} async addIceCandidate() {} close() {} };
  });
  p.on('pageerror', e => console.log(name, 'PAGE ERROR', e.message));
  p.on('console', m => { if (/desync|netplay|error/i.test(m.text())) console.log(name, m.type(), m.text()); });
  await p.goto(BASE);
  await p.click('text=Get started');
  await p.waitForFunction(() => document.querySelectorAll('.tile').length >= 8);
  return p;
};
const host = await mk('host'), guest = await mk('guest');
await host.click('button[aria-label="Multiplayer"]');
await host.fill('input[aria-label="Your name"]', 'Host');
await host.selectOption('select[aria-label="Game to host"]', { label: await host.$eval('select[aria-label="Game to host"]', (s, g) => [...s.options].find(o => o.text.startsWith(g)).text, GAME) });
await host.click('text=Create room');
await host.waitForSelector('.pslots');
const link = await host.inputValue('input[aria-label="Invite link"]');
const room = link.split('join=')[1];
console.log('room', room);

await guest.click('button[aria-label="Multiplayer"]');
await guest.fill('input[aria-label="Your name"]', 'Guest');
await guest.fill('input[aria-label="Room code"]', room);
await guest.click('form button:has-text("Join")');
await guest.waitForSelector('.pslots');
await guest.click('text=Ready up');
await host.waitForFunction(() => !document.querySelector('.lobby .btn.primary.big')?.disabled, null, { timeout: 30000 });
await guest.locator('.chat input').fill('hello from guest'); await guest.locator('.chat form button').click();
await sleep(1500);
if (process.env.SHOT) await host.screenshot({ path: 'docs/screenshots/desktop-17-lobby.png' });
await host.click('text=Start game');
await Promise.all([host.waitForSelector('canvas.screen'), guest.waitForSelector('canvas.screen')]);
await sleep(4000);
// both press Start, then random play
for (const p of [host, guest]) { await p.keyboard.press('Enter'); }
const t0 = Date.now();
const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyX', 'KeyZ'];
while (Date.now() - t0 < SECONDS * 1000) {
  for (const p of [host, guest]) { const k = keys[Math.floor(Math.random() * keys.length)]; await p.keyboard.down(k); setTimeout(() => p.keyboard.up(k).catch(() => {}), 120); }
  await sleep(150);
}
const stats = async p => p.evaluate(() => { const s = window.__kaiser?.stats; return s && { fps: Math.round(s.fps), emuFps: Math.round(s.emuFps), net: s.net && { frame: s.net.frame, rollbacks: s.net.rollbacks, maxRb: s.net.maxRollbackSeen, stalls: s.net.stalls, desyncs: s.net.desyncs, resyncs: s.net.resyncs, peers: s.net.peers } }; });
console.log('host', JSON.stringify(await stats(host)));
console.log('guest', JSON.stringify(await stats(guest)));
const chat = await host.$$eval('.chat .log div', d => d.map(x => x.textContent)).catch(() => []);
console.log('chat seen by host before start:', chat.length);
await b.close();
