import { useEffect, useState } from 'preact/hooks';
import { AlertTriangle, Camera, Check, FastForward, Gamepad2, History, Image, Info, Plus, RotateCcw, Save, Trash2, Upload, UserPlus, Users, Zap, Download } from 'lucide-preact';
import { settings, toasts, toast, updateSettings, useStore } from '../app/store.ts';
import { addFiles, pickFiles } from '../app/library.ts';
import { padKind } from '../engine/input.ts';
import type { Game } from '../app/db.ts';
import { Library } from './Library.tsx';
import { Player } from './Player.tsx';
import { SettingsPage } from './Settings.tsx';
import { Lobby } from './Lobby.tsx';
import type { NetSession } from '../net/session.ts';

export type View =
  | { name: 'library' }
  | { name: 'settings'; section?: string }
  | { name: 'play'; game: Game; slot?: number; fresh?: boolean; net?: NetSession }
  | { name: 'lobby'; game?: Game; room?: string };
export type Nav = (v: View) => void;

export function App() {
  const s = useStore(settings);
  const [view, setView] = useState<View>(() => {
    const room = new URLSearchParams(location.hash.slice(1)).get('join');
    return room ? { name: 'lobby', room } : { name: 'library' };
  });
  const [dragging, setDragging] = useState(false);

  // theme
  useEffect(() => {
    const apply = () => {
      const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0b0d12' : '#f4f5fa');
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.theme]);

  // controller hot-plug toasts
  useEffect(() => {
    const on = (e: GamepadEvent) => toast(`${({ xbox: 'Xbox', playstation: 'PlayStation', switch: 'Switch', generic: 'Controller' })[padKind(e.gamepad.id)]} controller connected`, 'gamepad', 'success');
    const off = () => toast('Controller disconnected', 'gamepad', 'warn');
    addEventListener('gamepadconnected', on); addEventListener('gamepaddisconnected', off);
    return () => { removeEventListener('gamepadconnected', on); removeEventListener('gamepaddisconnected', off); };
  }, []);

  // drag & drop ROMs anywhere (not while playing)
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e) || view.name === 'play') return; e.preventDefault(); depth++; setDragging(true); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; setDragging(false);
      if (view.name === 'play') return;
      const added = await addFiles([...(e.dataTransfer?.files ?? [])]);
      if (added.length && view.name !== 'library') setView({ name: 'library' });
    };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('dragover', over); addEventListener('drop', drop);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('dragover', over); removeEventListener('drop', drop); };
  }, [view.name]);

  const nav: Nav = v => {
    if (v.name !== 'lobby' && location.hash) history.replaceState(null, '', location.pathname + location.search);
    setView(v);
    scrollTo({ top: 0 });
  };

  return (
    <>
      {!s.welcomed && view.name === 'library' ? <Welcome /> :
        view.name === 'library' ? <Library nav={nav} /> :
        view.name === 'settings' ? <SettingsPage nav={nav} section={view.section} /> :
        view.name === 'lobby' ? <Lobby nav={nav} game={view.game} room={view.room} /> :
        <Player key={view.game.id + (view.slot ?? '') + (view.fresh ? 'f' : '')} game={view.game} slot={view.slot} fresh={view.fresh} nav={nav} net={view.net} />}
      {dragging && <div class="dropzone"><div><Upload /><br />Drop to add to your library</div></div>}
      <Toasts />
    </>
  );
}

function Welcome() {
  const done = () => updateSettings(x => ({ ...x, welcomed: true }));
  return (
    <div class="welcome">
      <div class="wcard">
        <img class="logo" src="./icon.svg" alt="" />
        <h1>Your retro library,<br /><b>beautifully played.</b></h1>
        <p class="lead">Kaiser runs classic consoles right in your browser — with rewind, fast-forward, auto-save and online play that feels local.</p>
        <div class="steps">
          <div class="card"><Plus /><div><b>Add your games</b><small>Drop ROM files anywhere or click Add games. They never leave this device.</small></div></div>
          <div class="card"><Zap /><div><b>Press play</b><small>Keyboard, controller or touch. Hold Tab to fast-forward, ` to rewind.</small></div></div>
          <div class="card"><Save /><div><b>Never lose progress</b><small>Auto-saves while you play. Pick up right where you left off.</small></div></div>
        </div>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button class="btn primary big" onClick={done} data-autofocus autoFocus>Get started</button>
          <button class="btn big" onClick={async () => { const f = await pickFiles(); done(); if (f.length) await addFiles(f); }}><Upload />Add a ROM</button>
        </div>
        <p style={{ color: 'var(--text-3)', fontSize: '13px', marginTop: '22px' }}>Includes free homebrew games to try right away.</p>
      </div>
    </div>
  );
}

const TOAST_ICONS: Record<string, typeof Info> = {
  info: Info, save: Save, upload: Upload, check: Check, alert: AlertTriangle, gamepad: Gamepad2, camera: Camera, plus: Plus,
  history: History, trash: Trash2, rotate: RotateCcw, image: Image, 'fast-forward': FastForward, users: Users, join: UserPlus, download: Download,
};

function Toasts() {
  const list = useStore(toasts);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map(t => { const I = TOAST_ICONS[t.icon ?? 'info'] ?? Info; return <div key={t.id} class={`toast ${t.tone}`}><I />{t.text}</div>; })}
    </div>
  );
}
