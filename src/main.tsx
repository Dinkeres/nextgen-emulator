import { render } from 'preact';
import './ui/styles.css';
import { App } from './ui/App.tsx';
import { loadSettings, refreshLibrary } from './app/store.ts';
import { ensureHomebrew } from './app/library.ts';
import { persist } from './app/db.ts';
import { installNav } from './ui/nav.ts';

declare const __BUILD__: string;

async function registerSW() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  try {
    // No forced reload to become cross-origin isolated: it could restart a game the player just
    // launched. The first visit uses message-port audio; every later visit is isolated.
    await navigator.serviceWorker.register(`./sw.js?v=${__BUILD__}`);
  } catch (e) { console.warn('Service worker unavailable; running without offline support', e); }
}

(async () => {
  await loadSettings();
  render(<App />, document.getElementById('app')!);
  installNav();
  await refreshLibrary();
  await ensureHomebrew();
  await refreshLibrary();
  persist();
  registerSW();
})();
