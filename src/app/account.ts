// Accounts shared with the Horizon project: same server (Horizon's web backend, a Cloudflare Worker
// with email + username + password accounts) and the same browser key, so signing in on either
// site on dinkeres.github.io signs you in on both. The password only ever goes to that server
// (which stores a salted PBKDF2 hash); this page keeps just the session token.
import { Store } from './store.ts';

export const ACCOUNT_API = 'https://horizon-test.luvrookie1.workers.dev';
const KEY = 'horizon-test-session'; // the Horizon site's key: shared sign-in on the same origin

export interface Account { username: string }
export const account = new Store<Account | null>(null);

const token = (): string | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null')?.token ?? null; } catch { return null; } };
const keep = (t: string | null) => { try { if (t) localStorage.setItem(KEY, JSON.stringify({ token: t })); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } };

async function call(path: string, body?: object): Promise<Record<string, string>> {
  let r: Response;
  try {
    r = await fetch(ACCOUNT_API + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { Authorization: 'Bearer ' + token() } });
  } catch { throw new Error("Couldn't reach the account server. Check your connection."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Account server error (${r.status})`), { status: r.status });
  return j;
}

/** On startup: who is signed in (also picks up a sign-in made on the Horizon site). */
export async function refreshAccount() {
  if (!token()) { account.set(null); return; }
  try { account.set({ username: (await call('/api/me')).username }); }
  catch (e) { if ((e as { status?: number }).status === 401) { keep(null); account.set(null); } } // offline: stay as we were
}

export async function signUp(email: string, username: string, password: string) {
  const j = await call('/api/signup', { email: email.trim(), username: username.trim(), password });
  keep(j.token); account.set({ username: j.username });
}
export async function signIn(email: string, password: string) {
  const j = await call('/api/login', { email: email.trim(), password });
  keep(j.token); account.set({ username: j.username });
}
/** Forgets the session in this browser (the server lets it expire after 30 days). */
export function signOut() { keep(null); account.set(null); }

export const USERNAME_RULE = /^[A-Za-z0-9_]{3,16}$/;
