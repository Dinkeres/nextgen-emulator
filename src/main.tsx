import { render } from 'preact';
import './ui/styles.css';
import { App } from './ui/App';
import { loadSettings, refreshLibrary } from './app/store';
import { ensureHomebrew } from './app/library';
import { persist } from './app/db';
import { installNav } from './ui/nav';

declare const __BUILD__: string;

async function registerSW() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  try {
    await navigator.serviceWorker.register(`./sw.js?v=${__BUILD__}`);
    // First visit: the SW starts controlling the page after load; reload once so its
    // COOP/COEP headers apply (shared-memory audio). Guarded so it can never loop.
    if (!self.crossOriginIsolated && !sessionStorage.getItem('coi-reload')) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        sessionStorage.setItem('coi-reload', '1');
        location.reload();
      }, { once: true });
    }
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
