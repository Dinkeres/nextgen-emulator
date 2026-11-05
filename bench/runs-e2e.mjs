// Two browsers through a whole Soul Link run against a local copy of the account server: friends,
// lobby, start gated on everyone, a real game running, deaths crossing over, a wipe, and the summary.
// Needs: wrangler dev (web/backend) on 8787, and a production build with the local server's address:
//   VITE_ACCOUNT_API=http://127.0.0.1:8787 npx vite build && npx vite preview --port 8080 --host 127.0.0.1
// Usage: SL_ROM=path OUT=dir node bench/runs-e2e.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const SITE = 'http://127.0.0.1:8080/', API = 'http://127.0.0.1:8787', ORIGIN = 'http://127.0.0.1:8080';
const OUT = process.env.OUT ?? '.', tag = Date.now().toString(36);
const post = async (path, body, token) => {
  const r = await fetch(API + path, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
};
const get = async (path, token) => (await fetch(API + path, { headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` } })).json();
const ok = m => console.log('PASS', m);

const names = ['ash' + tag, 'misty' + tag].map(n => n.slice(0, 16));
const users = [];
for (const n of names) users.push({ name: n, ...(await post('/api/signup', { email: `${n}@t.test`, password: 'password123', username: n })) });
await post('/api/friends', { action: 'request', username: names[1] }, users[0].token);
const { incoming } = await get('/api/friends', users[1].token);
await post('/api/friends', { action: 'accept', requestId: incoming[0].id }, users[1].token);
assert.equal((await get('/api/friends', users[0].token)).friends.length, 1); ok('friends');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const open = async u => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  await ctx.addInitScript(t => localStorage.setItem('horizon-test-session', JSON.stringify({ token: t })), u.token);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('page error', u.name, e.message));
  await page.goto(SITE);
  await page.getByRole('button', { name: 'Get started' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('banner').getByRole('button', { name: 'Add games' }).click()]);
  await chooser.setFiles(process.env.SL_ROM);
  await page.getByText(/Fire ?Red/i).first().waitFor();
  await page.getByRole('button', { name: 'Soul Link' }).click();
  await page.getByRole('heading', { name: 'Soul Link' }).waitFor();
  return page;
};
const [a, b] = [await open(users[0]), await open(users[1])];
await a.waitForTimeout(1400); // the cable finishes drawing
await a.screenshot({ path: `${OUT}/1-home.png` });

await a.getByRole('button', { name: 'New run' }).click();
await a.getByLabel('Run name').fill('Friday night race');
await a.getByText('Team race').click();
await a.locator('.rr-dialog select').waitFor();
await a.screenshot({ path: `${OUT}/2-new.png` });
await a.getByRole('button', { name: 'Create run' }).click();
await a.getByRole('heading', { name: 'Friday night race' }).waitFor();
await a.getByRole('button', { name: 'Invite', exact: true }).click();
await a.getByRole('button', { name: 'Invited' }).waitFor();

await b.getByRole('button', { name: 'Join run' }).click({ timeout: 15000 });
await b.getByRole('heading', { name: 'Friday night race' }).waitFor();
ok('invite and join');
await a.getByText(names[1]).first().waitFor();
assert.ok(await a.getByRole('button', { name: 'Start run' }).isDisabled(), 'start waits for ready');
await a.getByRole('button', { name: 'Ready' }).click();
await a.waitForTimeout(400);
assert.ok(await a.getByRole('button', { name: 'Start run' }).isDisabled(), 'start waits for everyone');
ok('start stays locked until everyone is ready');
await b.getByRole('button', { name: 'Ready' }).click();
await a.getByRole('button', { name: 'Start run' }).and(a.locator(':not([disabled])')).waitFor();
await a.locator('.rr-chat input').fill('Good luck');
await a.locator('.rr-chat button').click();
await a.waitForTimeout(300);
await a.screenshot({ path: `${OUT}/3-lobby.png` });
await a.getByRole('button', { name: 'Start run' }).click();

for (const p of [a, b]) await p.locator('.rr-panel').waitFor({ timeout: 30000 });
for (const p of [a, b]) {
  await p.waitForFunction(() => window.__kaiser?.emu?.coreName && window.__kaiser.emu.paused === false, null, { timeout: 30000 });
  assert.equal(await p.getByText("This game couldn't start").count(), 0, 'the game runs');
}
ok('both players are really running the game');
const run = (await get('/api/runs', users[0].token)).runs[0];
// A little real play time, then the rules, as both games would report them.
await a.waitForTimeout(3500);
const conn = async (u, reports) => {
  const ws = new WebSocket(`${API.replace('http', 'ws')}/run`, { headers: { Origin: ORIGIN } });
  await new Promise(r => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: 'auth', token: u.token, run: run.id }));
  await new Promise(r => setTimeout(r, 300));
  for (const r of reports) { ws.send(JSON.stringify({ t: 'report', r })); await new Promise(x => setTimeout(x, 200)); }
  ws.close();
};
await conn(users[0], [
  { k: 'catch', pid: 'aa', nick: 'BULBASAUR', species: 1, level: 5, sec: '88', area: 'Pallet Town' },
  { k: 'catch', pid: 'ab', nick: 'PIDGEY', species: 16, level: 3, sec: '101', area: 'Route 1' },
  { k: 'catch', pid: 'ac', nick: 'RATTATA', species: 19, level: 3, sec: '102', area: 'Route 2' },
  { k: 'pos', area: 'Pewter City', badges: 1 },
]);
await conn(users[1], [{ k: 'catch', pid: 'ba', nick: 'CHARMANDER', species: 4, level: 5, sec: '88', area: 'Pallet Town' }, { k: 'pos', area: 'Route 3', badges: 2 }]);
await a.getByText('PIDGEY').first().waitFor();
await a.waitForTimeout(600);
await a.screenshot({ path: `${OUT}/4-playing.png` });
ok('the team panel follows the game');
await conn(users[0], [{ k: 'faint', pid: 'ac' }]);
await a.locator('.rr-alert').waitFor({ timeout: 5000 });
await a.screenshot({ path: `${OUT}/5-death.png` });
ok('a death alert appears');
await conn(users[0], [{ k: 'faint', pid: 'ab' }, { k: 'faint', pid: 'aa' }]);
const detail = await get(`/api/runs/${run.id}`, users[0].token);
assert.equal(detail.run.state.teams[detail.run.players[0].team].resets, 1); ok('losing everything restarts that team');
await conn(users[1], [{ k: 'clear' }]);
await a.getByRole('heading', { name: 'Friday night race' }).waitFor({ timeout: 10000 });
await a.waitForTimeout(800);
await a.screenshot({ path: `${OUT}/6-summary.png`, fullPage: true });
ok('the run ends on the summary');
await b.close(); await a.close(); await browser.close();
console.log('ALL PASS');
