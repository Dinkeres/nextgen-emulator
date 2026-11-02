import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Database, Gamepad2, Info, Monitor, Network, Save, SlidersHorizontal, Volume2, Upload, Download, Trash2, Palette, UserRound, LogOut } from 'lucide-preact';
import { account, signIn, signUp, signOut, USERNAME_RULE } from '../app/account.ts';
import { cloudList } from '../app/cloud.ts';
import { DEFAULTS, library, settings, toast, updateSettings, useStore, refreshLibrary, type Settings as S } from '../app/store.ts';
import { db, exportBackup, importBackup, persist, type Game } from '../app/db.ts';
import { HOMEBREW } from '../app/library.ts';
import { Renderer, type AspectMode, type ShaderId } from '../engine/renderer.ts';
import { BTN, SYSTEMS, type ButtonName } from '../engine/systems.ts';
import { DEFAULT_HOTKEYS, padKind, type Hotkey } from '../engine/input.ts';
import { Confirm, Toggle, download, fmtBytes } from './common.tsx';
import { speedLabel, DS_LAYOUTS } from './Player.tsx';
import { DS_BIOS_FILES } from '../app/session.ts';
import type { Nav } from './App.tsx';

type Section = 'account' | 'video' | 'audio' | 'controls' | 'saves' | 'netplay' | 'advanced' | 'about';
const SECTIONS: [Section, string, typeof Monitor][] = [
  ['account', 'Account', UserRound],
  ['video', 'Video', Monitor], ['audio', 'Audio', Volume2], ['controls', 'Controls', Gamepad2], ['saves', 'Saves & storage', Save],
  ['netplay', 'Multiplayer', Network], ['advanced', 'Advanced', SlidersHorizontal], ['about', 'About', Info],
];

const SHADERS: [ShaderId, string, string][] = [
  ['sharp', 'Sharp', 'Crisp pixels with clean edges at any size. Recommended.'],
  ['nearest', 'Pixel', 'Raw nearest-neighbour; can shimmer at odd sizes.'],
  ['smooth', 'Smooth', 'Bilinear filtering for a soft look.'],
  ['scanlines', 'Scanlines', 'Dark lines between rows like a CRT, without the curve.'],
  ['crt', 'CRT', 'Curved screen, scanlines, phosphor mask and vignette.'],
  ['lcd', 'LCD grid', 'Visible pixel grid like a handheld screen.'],
];
const ASPECTS: [AspectMode, string][] = [['core', 'Original'], ['4:3', '4:3'], ['16:9', '16:9'], ['square', 'Square pixels'], ['stretch', 'Stretch']];

const set = <K extends keyof S>(k: K, v: Partial<S[K]>) => updateSettings(x => ({ ...x, [k]: { ...(x[k] as object), ...v } }));

function Row({ title, desc, children }: { title: string; desc?: string; children?: preact.ComponentChildren }) {
  return <div class="setting"><div class="lbl"><b>{title}</b>{desc && <small>{desc}</small>}</div><div class="ctl">{children}</div></div>;
}
function Chips<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div class="opts">{options.map(([v, l]) => <button key={String(v)} class={`chip ${value === v ? 'on' : ''}`} onClick={() => onChange(v)} aria-pressed={value === v}>{l}</button>)}</div>;
}

export function SettingsPage({ nav, section: initial }: { nav: Nav; section?: string }) {
  const [sec, setSec] = useState<Section>((initial as Section) || 'video');
  return (
    <>
      <header class="topbar">
        <button class="btn icon ghost" onClick={() => nav({ name: 'library' })} aria-label="Back"><ArrowLeft /></button>
        <div class="brand"><span>Settings</span></div>
      </header>
      <main class="page">
        <div class="settings">
          <nav aria-label="Settings sections">
            {SECTIONS.map(([id, label, Icon]) => <button key={id} class={sec === id ? 'on' : ''} onClick={() => setSec(id)}><Icon />{label}</button>)}
          </nav>
          <div class="group" key={sec} style={{ animation: 'page-in var(--med) var(--ease)' }}>
            {sec === 'account' && <AccountSection />}
            {sec === 'video' && <Video />}
            {sec === 'audio' && <Audio />}
            {sec === 'controls' && <Controls />}
            {sec === 'saves' && <Saves />}
            {sec === 'netplay' && <Netplay />}
            {sec === 'advanced' && <Advanced />}
            {sec === 'about' && <About />}
          </div>
        </div>
      </main>
    </>
  );
}

// ---------- video ----------
function testPattern(): { data: Uint8Array; w: number; h: number } {
  const w = 160, h = 120, d = new Uint8Array(w * h * 4);
  const pal = [[24, 20, 60], [92, 60, 200], [34, 211, 238], [250, 204, 21], [244, 63, 94], [255, 255, 255], [16, 185, 129]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = pal[0];
    if (y > 84) c = ((x >> 3) + (y >> 3)) & 1 ? pal[6] : [12, 120, 80];       // ground
    else if (y < 84) c = [20 + y / 2, 18 + y / 3, 60 + y];                     // sky gradient
    const cx = x - 120, cy = y - 34; if (cx * cx + cy * cy < 180) c = pal[3]; // sun
    if (x > 30 && x < 62 && y > 52 && y <= 84) c = pal[1];                     // house
    if (x > 38 && x < 46 && y > 62 && y < 72) c = pal[2];
    if (x > 50 && x < 56 && y > 70 && y <= 84) c = pal[4];
    if (y > 44 && y <= 52 && Math.abs(x - 46) < (y - 44) * 2.2) c = pal[4];  // roof
    if (y >= 96 && y < 104 && x > 70 && x < 150 && ((x >> 2) & 1)) c = pal[5]; // text-ish
    const i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  return { data: d, w, h };
}

export function ShaderPreview({ shader, aspect, integer }: { shader: ShaderId; aspect: AspectMode; integer: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const r = useRef<Renderer | null>(null);
  const pat = useRef(testPattern());
  useEffect(() => {
    try { r.current = new Renderer(ref.current!); } catch { return; }
    const ro = new ResizeObserver(() => { const c = ref.current; if (!c || !r.current) return; r.current.resize(c.clientWidth * devicePixelRatio, c.clientHeight * devicePixelRatio); r.current.redraw(); });
    ro.observe(ref.current!);
    return () => { ro.disconnect(); r.current = null; };
  }, []);
  useEffect(() => {
    if (!r.current) return;
    r.current.opts = { shader, aspect, integer };
    r.current.coreAspect = 4 / 3;
    const p = pat.current;
    r.current.draw(p.data, p.w, p.h);
  }, [shader, aspect, integer]);
  return <div class="preview"><canvas ref={ref} aria-label="Shader preview" /></div>;
}

function Video() {
  const s = useStore(settings).video;
  return (
    <>
      <h3>Video</h3><p class="lead">How games look. The preview updates live.</p>
      <ShaderPreview shader={s.shader} aspect={s.aspect} integer={s.integer} />
      <Row title="Shader" desc={SHADERS.find(x => x[0] === s.shader)?.[2]} />
      <Chips value={s.shader} options={SHADERS.map(([a, b]) => [a, b])} onChange={v => set('video', { shader: v })} />
      <Row title="Aspect ratio" desc="Original uses each console's real display shape (e.g. NES 8:7 pixels → 4:3)." />
      <Chips value={s.aspect} options={ASPECTS} onChange={v => set('video', { aspect: v })} />
      <Row title="Integer scaling" desc="Scales by whole numbers only so every pixel is the same size. May leave borders.">
        <Toggle on={s.integer} onChange={v => set('video', { integer: v })} label="Integer scaling" />
      </Row>
      <Row title="Sync to display" desc="When your screen runs near the game's speed (60 Hz), present exactly one frame per refresh for perfectly smooth motion. Turn off if a game runs slightly fast or slow.">
        <Toggle on={s.vsyncLock} onChange={v => set('video', { vsyncLock: v })} label="Sync to display" />
      </Row>
      <Row title="Frame skip" desc="Auto keeps games at full speed on slower devices (e.g. Chromebooks) by drawing every other frame when needed. Off always draws every frame, even if the game slows down." />
      <Chips value={s.frameskip} options={[['auto', 'Auto'], ['off', 'Off']]} onChange={v => set('video', { frameskip: v })} />
      <Row title="Show performance stats" desc="FPS, frame time, audio buffer and rewind memory in the corner.">
        <Toggle on={s.showFps} onChange={v => set('video', { showFps: v })} label="Show stats" />
      </Row>
      <Row title="Nintendo DS screens" desc="How the two DS screens are arranged. Changes apply instantly in game." />
      <Chips value={useStore(settings).ds.layout} options={DS_LAYOUTS} onChange={v => updateSettings(x => ({ ...x, ds: { ...x.ds, layout: v } }))} />
      <Row title="Theme" desc="Dark is easier on the eyes in a dim room." />
      <Chips value={useStore(settings).theme} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']]} onChange={v => updateSettings(x => ({ ...x, theme: v }))} />
    </>
  );
}

// ---------- audio ----------
function Audio() {
  const s = useStore(settings).audio;
  return (
    <>
      <h3>Audio</h3><p class="lead">Sound plays through a dedicated audio thread with automatic drift correction.</p>
      <Row title="Volume" desc={`${Math.round(s.volume * 100)}%`}>
        <input class="range" type="range" min="0" max="1" step="0.05" value={s.volume} onInput={e => set('audio', { volume: +(e.target as HTMLInputElement).value })} aria-label="Volume" />
      </Row>
      <Row title="Mute"><Toggle on={s.muted} onChange={v => set('audio', { muted: v })} label="Mute" /></Row>
      <Row title="Audio latency" desc="Lower is snappier; raise it if you hear crackling on a slow device." />
      <Chips value={s.latencyMs} options={[[30, '30 ms'], [45, '45 ms'], [70, '70 ms'], [100, '100 ms']]} onChange={v => set('audio', { latencyMs: v })} />
      <Row title="Fast-forward sound" desc="Stretched keeps normal pitch, Pitched plays everything sped up, Muted is silent." />
      <Chips value={s.ffAudio} options={[['stretch', 'Stretched'], ['pitch', 'Pitched up'], ['mute', 'Muted']]} onChange={v => set('audio', { ffAudio: v })} />
    </>
  );
}

// ---------- controls ----------
const keyName = (c?: string) => !c ? '—' : c.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace('Backquote', '`').replace('ShiftRight', 'R-Shift').replace('ShiftLeft', 'L-Shift');
const PAD_NAMES = ['A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'Back / Share', 'Start / Options', 'L-stick', 'R-stick', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Home'];
const ORDER: ButtonName[] = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'X', 'Y', 'L', 'R', 'L2', 'R2', 'SELECT', 'START'];
const HOTKEY_LABELS: Record<Hotkey, string> = { menu: 'Pause menu', ff: 'Fast-forward', ffToggle: 'Fast-forward toggle', rewind: 'Rewind (hold)', slowmo: 'Slow motion toggle', save: 'Quick save', load: 'Quick load', screenshot: 'Screenshot', fullscreen: 'Fullscreen' };

function Controls() {
  const st = useStore(settings);
  const c = st.controls;
  const [listen, setListen] = useState<null | { kind: 'key' | 'pad' | 'hot'; id: string }>(null);
  const [pads, setPads] = useState<Gamepad[]>([]);

  useEffect(() => {
    const upd = () => setPads((navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g));
    upd();
    addEventListener('gamepadconnected', upd); addEventListener('gamepaddisconnected', upd);
    return () => { removeEventListener('gamepadconnected', upd); removeEventListener('gamepaddisconnected', upd); };
  }, []);

  useEffect(() => {
    if (!listen) return;
    const onKey = (e: KeyboardEvent) => {
      if (listen.kind === 'pad') return;
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape' && listen.kind !== 'hot') { setListen(null); return; }
      if (listen.kind === 'key') set('controls', { keys: { ...c.keys, [listen.id]: [e.code] } });
      else set('controls', { hotkeys: { ...c.hotkeys, [listen.id]: e.code } });
      setListen(null);
    };
    let raf = 0;
    const base = new Map<number, boolean[]>();
    const poll = () => {
      raf = requestAnimationFrame(poll);
      if (listen.kind !== 'pad') return;
      for (const g of navigator.getGamepads?.() ?? []) {
        if (!g) continue;
        const now = g.buttons.map(b => b.pressed);
        const was = base.get(g.index);
        if (!was) { base.set(g.index, now); continue; }
        const i = now.findIndex((p, k) => p && !was[k]);
        if (i >= 0) { set('controls', { pad: { ...c.pad, [listen.id]: [i] } }); setListen(null); return; }
        base.set(g.index, now);
      }
    };
    window.addEventListener('keydown', onKey, true);
    raf = requestAnimationFrame(poll);
    return () => { window.removeEventListener('keydown', onKey, true); cancelAnimationFrame(raf); };
  }, [listen, c]);

  const isL = (kind: string, id: string) => listen?.kind === kind && listen.id === id;
  return (
    <>
      <h3>Controls</h3><p class="lead">Click a binding, then press the key or controller button you want. Controllers map by button position, so A/B feel right on Xbox, PlayStation and Switch pads.</p>
      <Row title="Connected controllers" desc={pads.length ? pads.map(p => `${p.index + 1}: ${padKind(p.id)} — ${p.id.slice(0, 48)}`).join('\n') : 'None yet — press any button on your controller.'} />
      <div class="section-title" style={{ marginTop: '18px' }}><h2 style={{ fontSize: '17px' }}>Buttons</h2>
        <button class="btn ghost" onClick={() => set('controls', { keys: DEFAULTS.controls.keys, pad: DEFAULTS.controls.pad })}>Reset to defaults</button></div>
      <div class="bindings">
        {ORDER.map(b => (
          <div class="setting" key={b}>
            <div class="lbl"><b>{({ UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', SELECT: 'Select', START: 'Start' } as Record<string, string>)[b] ?? b}</b>
              <small>{b === 'A' ? 'NES/SNES A · Genesis C' : b === 'B' ? 'NES/SNES B · Genesis B' : b === 'Y' ? 'SNES Y · Genesis A' : ''}</small></div>
            <div class="ctl">
              <button class={`bind ${isL('key', b) ? 'listening' : ''}`} onClick={() => setListen({ kind: 'key', id: b })} aria-label={`Keyboard binding for ${b}`}>{isL('key', b) ? 'Press a key…' : keyName(c.keys[b]?.[0])}</button>
              <button class={`bind ${isL('pad', b) ? 'listening' : ''}`} style={{ minWidth: '104px' }} onClick={() => setListen({ kind: 'pad', id: b })} aria-label={`Controller binding for ${b}`}>{isL('pad', b) ? 'Press button…' : PAD_NAMES[c.pad[b]?.[0] ?? -1] ?? '—'}</button>
            </div>
          </div>
        ))}
      </div>
      <div class="section-title"><h2 style={{ fontSize: '17px' }}>Hotkeys</h2>
        <button class="btn ghost" onClick={() => set('controls', { hotkeys: DEFAULT_HOTKEYS })}>Reset</button></div>
      <div class="bindings">
        {(Object.keys(HOTKEY_LABELS) as Hotkey[]).map(h => (
          <div class="setting" key={h}><div class="lbl"><b>{HOTKEY_LABELS[h]}</b></div>
            <div class="ctl"><button class={`bind ${isL('hot', h) ? 'listening' : ''}`} onClick={() => setListen({ kind: 'hot', id: h })}>{isL('hot', h) ? 'Press a key…' : keyName(c.hotkeys[h])}</button></div></div>
        ))}
      </div>
      <Row title="Controller shortcuts" desc="Home or Select+Start opens the menu · Select+R fast-forwards · Select+L rewinds." />
      <Row title="Fast-forward mode" desc="Hold: fast while the key is held. Toggle: press once to start, again to stop." />
      <Chips value={st.speed.ffMode} options={[['hold', 'Hold'], ['toggle', 'Toggle']]} onChange={v => set('speed', { ffMode: v })} />
      <div class="section-title"><h2 style={{ fontSize: '17px' }}>Touch controls</h2></div>
      <Row title="On-screen controls" desc="Auto shows them on phones and tablets." />
      <Chips value={c.touch} options={[['auto', 'Auto'], ['on', 'Always'], ['off', 'Never']]} onChange={v => set('controls', { touch: v })} />
      <Row title="Opacity" desc={`${Math.round(c.touchOpacity * 100)}%`}>
        <input class="range" type="range" min="0.15" max="1" step="0.05" value={c.touchOpacity} onInput={e => set('controls', { touchOpacity: +(e.target as HTMLInputElement).value })} aria-label="Touch opacity" />
      </Row>
      <Row title="Haptic feedback" desc="A short vibration on each press, where supported."><Toggle on={c.haptics} onChange={v => set('controls', { haptics: v })} label="Haptics" /></Row>
      <Row title="Custom layouts" desc="Open the pause menu in a game → Controls → Edit touch layout. Layouts are saved per system.">
        <button class="btn ghost" onClick={() => { set('controls', { layouts: {} } as Partial<S['controls']>); toast('Touch layouts reset', 'rotate', 'success'); }}>Reset all</button>
      </Row>
    </>
  );
}

// ---------- saves ----------
function Saves() {
  const s = useStore(settings).saves;
  const games = useStore(library);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState<Game | null>(null);
  const refresh = () => {
    db.usage().then(setUsage);
    navigator.storage?.estimate?.().then(e => setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
    navigator.storage?.persisted?.().then(setPersisted);
  };
  useEffect(refresh, []);
  const total = Object.values(usage).reduce((a, b) => a + b, 0);
  return (
    <>
      <h3>Saves & storage</h3><p class="lead">Everything is stored in this browser. Export a backup to move saves to another device.</p>
      <Row title="Auto-save every" desc="A save state is also written when you pause, switch tabs or close the page." />
      <Chips value={s.autoSaveMinutes} options={[[0, 'Off'], [1, '1 min'], [2, '2 min'], [5, '5 min']]} onChange={v => set('saves', { autoSaveMinutes: v })} />
      <Row title="Resume where you left off" desc="Opening a game continues from its latest auto-save."><Toggle on={s.resume} onChange={v => set('saves', { resume: v })} label="Resume" /></Row>
      <Row title="Save when the tab is hidden" desc="Protects progress if the browser closes the tab in the background."><Toggle on={s.autoSaveOnHide} onChange={v => set('saves', { autoSaveOnHide: v })} label="Save on hide" /></Row>
      <Row title="Persistent storage" desc={persisted ? 'Granted — the browser won’t clear your saves to free space.' : 'Ask the browser to never evict your saves under storage pressure.'}>
        {!persisted && <button class="btn" onClick={async () => { const ok = await persist(); setPersisted(ok); toast(ok ? 'Storage is now persistent' : 'The browser declined (it may grant it after you use the site more)', ok ? 'check' : 'alert', ok ? 'success' : 'warn'); }}>Request</button>}
      </Row>
      <Row title="Back up all saves" desc="One file with every save state, battery save and cover image.">
        <button class="btn" onClick={async () => download(await exportBackup(), `kaiser-backup-${new Date().toISOString().slice(0, 10)}.kaiser`)}><Download />Export</button>
        <label class="btn"><Upload />Import<input type="file" accept=".kaiser,application/gzip" hidden onChange={async e => {
          const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
          try { const n = await importBackup(f); await refreshLibrary(); refresh(); toast(`Restored saves for ${n} game${n === 1 ? '' : 's'}`, 'check', 'success'); }
          catch (err) { toast((err as Error).message, 'alert', 'error'); }
        }} /></label>
      </Row>
      <div class="section-title"><h2 style={{ fontSize: '17px' }}>Storage used</h2><span class="muted">{fmtBytes(total)}{quota?.quota ? ` of ${fmtBytes(quota.quota)} available` : ''}</span></div>
      {quota?.quota ? <div class="meterbar"><i style={{ width: `${Math.max(1, Math.min(100, quota.usage / quota.quota * 100))}%` }} /></div> : null}
      {games.filter(g => usage[g.id]).sort((a, b) => (usage[b.id] ?? 0) - (usage[a.id] ?? 0)).map(g => (
        <div class="storage-row" key={g.id}>
          <div><b>{g.title}</b><br /><small>{SYSTEMS[g.system]?.short}</small></div>
          <span style={{ color: 'var(--text-2)' }}>{fmtBytes(usage[g.id])}</span>
          <button class="btn icon ghost danger" aria-label={`Clear data for ${g.title}`} onClick={() => setConfirm(g)}><Trash2 /></button>
        </div>
      ))}
      {confirm && <Confirm title={`Clear data for ${confirm.title}?`} text="All save states, battery saves and screenshots for this game will be deleted. The game stays in your library." confirm="Clear data"
        onNo={() => setConfirm(null)} onYes={async () => { await db.clearGame(confirm.id, true); setConfirm(null); refresh(); toast('Data cleared', 'trash', 'success'); }} />}
    </>
  );
}

// ---------- netplay ----------
function Netplay() {
  const s = useStore(settings).netplay;
  return (
    <>
      <h3>Multiplayer</h3><p class="lead">Rollback netplay: everyone runs the game locally and only button presses travel over the network.</p>
      <Row title="Your name" desc="Shown to other players in the lobby.">
        <input class="input" value={s.name} maxLength={20} placeholder="Player" onInput={e => set('netplay', { name: (e.target as HTMLInputElement).value })} aria-label="Your name" />
      </Row>
      <Row title="Input delay" desc="Frames of delay before your input applies. Auto picks it from your ping; more delay = fewer rollbacks." />
      <Chips value={s.inputDelay} options={[['auto', 'Auto'], [0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]} onChange={v => set('netplay', { inputDelay: v })} />
      <Row title="Max rollback" desc="How many frames the game may rewind to correct a late input before waiting." />
      <Chips value={s.maxRollback} options={[[4, '4'], [6, '6'], [8, '8']]} onChange={v => set('netplay', { maxRollback: v })} />
      <Row title="Signaling server" desc="Only used to introduce players; game traffic goes peer-to-peer. See server/README.md to run your own.">
        <input class="input" style={{ width: '260px' }} value={s.signalUrl} onInput={e => set('netplay', { signalUrl: (e.target as HTMLInputElement).value })} aria-label="Signaling server URL" />
      </Row>
    </>
  );
}

// ---------- account ----------
function CloudSaves() {
  const games = useStore(library);
  const [list, setList] = useState<Awaited<ReturnType<typeof cloudList>> | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { cloudList().then(setList, e => setErr(e.message)); }, []);
  const byGame = new Map<string, { sram?: number; state?: number; size: number }>();
  for (const s of list ?? []) { const g = byGame.get(s.game) ?? { size: 0 }; g[s.kind] = s.updated; g.size += s.size; byGame.set(s.game, g); }
  const total = (list ?? []).reduce((n, s) => n + s.size, 0);
  return (
    <>
      <div class="section-title" style={{ marginTop: '22px' }}><h2 style={{ fontSize: '17px' }}>Cloud saves</h2><span class="muted">{list ? `${fmtBytes(total)} of 64 MB` : ''}</span></div>
      <p class="muted" style={{ fontSize: '13.5px', marginTop: '-4px' }}>On while you're signed in. Your in-game saves (and where you left off, for games whose save state fits) follow you to any device: add the same ROM there and press play. ROMs are never uploaded.</p>
      {err && <div class="notice bad">{err}</div>}
      {list && !list.length && <p class="muted">Nothing yet: play a game and save in-game.</p>}
      {[...byGame].map(([id, g]) => (
        <Row key={id} title={games.find(x => x.id === id)?.title ?? 'A game not in this library'} desc={[g.sram && 'In-game save', g.state && 'Resume point'].filter(Boolean).join(' + ') + ` · ${fmtBytes(g.size)} · ${new Date(Math.max(g.sram ?? 0, g.state ?? 0)).toLocaleString()}`} />
      ))}
    </>
  );
}

function AccountSection() {
  const a = useStore(account);
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (a) return (
    <>
      <h3>Account</h3><p class="lead">You're signed in. This is the same account as Horizon: signing in or out here does the same there.</p>
      <Row title={a.username} desc="Your name in multiplayer rooms.">
        <button class="btn" onClick={() => { signOut(); toast('Signed out', 'info', 'info'); }}><LogOut />Sign out</button>
      </Row>
      <CloudSaves />
    </>
  );
  const submit = async (e: Event) => {
    e.preventDefault();
    setErr('');
    if (mode === 'up' && !USERNAME_RULE.test(username.trim())) { setErr('Usernames are 3–16 letters, numbers or _.'); return; }
    if (mode === 'up' && password.length < 8) { setErr('Use at least 8 characters for your password.'); return; }
    setBusy(true);
    try {
      if (mode === 'up') await signUp(email, username, password); else await signIn(email, password);
      setPassword('');
      toast(`Signed in as ${account.value?.username}`, 'success', 'success');
    } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <h3>Account</h3><p class="lead">One account for Kaiser and Horizon. It's optional: everything works signed out.</p>
      <Chips value={mode} options={[['in', 'Sign in'], ['up', 'Create account']]} onChange={m => { setMode(m); setErr(''); }} />
      <form onSubmit={submit} style={{ display: 'grid', gap: '10px', maxWidth: '360px', marginTop: '14px' }}>
        <input class="input" type="email" autocomplete="email" placeholder="Email" value={email} onInput={e => setEmail((e.target as HTMLInputElement).value)} aria-label="Email" required />
        {mode === 'up' && <input class="input" autocomplete="username" placeholder="Username (3–16 letters, numbers, _)" value={username} maxLength={16} onInput={e => setUsername((e.target as HTMLInputElement).value)} aria-label="Username" required />}
        <input class="input" type="password" autocomplete={mode === 'up' ? 'new-password' : 'current-password'} placeholder={mode === 'up' ? 'Password (8+ characters)' : 'Password'} value={password} onInput={e => setPassword((e.target as HTMLInputElement).value)} aria-label="Password" required />
        {err && <div class="notice bad" role="alert">{err}</div>}
        <button class="btn primary" type="submit" disabled={busy}>{busy ? 'One moment…' : mode === 'up' ? 'Create account' : 'Sign in'}</button>
      </form>
    </>
  );
}

// ---------- advanced ----------
function Advanced() {
  const st = useStore(settings);
  const [opts, setOpts] = useState<Record<string, { key: string; label: string; values: string[] }[]>>({});
  useEffect(() => { (async () => {
    const out: typeof opts = {};
    for (const core of new Set(Object.values(SYSTEMS).map(s => s.core))) { const o = await db.kv<typeof opts[string]>('coreopts:' + core); if (o?.length) out[core] = o; }
    setOpts(out);
  })(); }, []);
  return (
    <>
      <h3>Advanced</h3><p class="lead">Core options for each emulator. Options appear after you've played a game on that system once.</p>
      <Row title="Isolation" desc={self.crossOriginIsolated ? 'Cross-origin isolated: shared-memory audio is active.' : 'Not isolated: using message-based audio (works fine, slightly more overhead).'} />
      <Row title="Rewind" desc="Keeps recent history in memory so you can hold rewind."><Toggle on={st.speed.rewind} onChange={v => set('speed', { rewind: v })} label="Rewind" /></Row>
      <Row title="Rewind on demanding systems" desc="Rewind is switched off automatically when snapshots would slow the game down (e.g. Nintendo DS on slower devices). Turn this on to force it."><Toggle on={st.speed.rewindHeavy} onChange={v => set('speed', { rewindHeavy: v })} label="Force rewind" /></Row>
      <Row title="Rewind length" desc="Longer history uses more memory (shrunk automatically on phones)." />
      <Chips value={st.speed.rewindSeconds} options={[[15, '15 s'], [30, '30 s'], [45, '45 s'], [60, '60 s']]} onChange={v => set('speed', { rewindSeconds: v })} />
      <Row title="Slow motion speed" />
      <Chips value={st.speed.slowSpeed} options={[[0.5, '0.5×'], [0.25, '0.25×']]} onChange={v => set('speed', { slowSpeed: v })} />
      <Row title="Fast-forward speed" />
      <Chips value={st.speed.ffSpeed} options={[2, 3, 4, 8, 100].map(v => [v, speedLabel(v)] as [number, string])} onChange={v => set('speed', { ffSpeed: v })} />
      {Object.entries(opts).map(([core, list]) => (
        <div key={core}>
          <div class="section-title"><h2 style={{ fontSize: '17px' }}>{core}</h2>
            <button class="btn ghost" onClick={() => updateSettings(x => ({ ...x, coreOptions: { ...x.coreOptions, [core]: {} } }))}>Reset</button></div>
          {list.map(o => (
            <Row key={o.key} title={o.label} desc="Applies the next time a game starts.">
              <select class="input" value={st.coreOptions[core]?.[o.key] ?? o.values[0]} onChange={e => updateSettings(x => ({ ...x, coreOptions: { ...x.coreOptions, [core]: { ...x.coreOptions[core], [o.key]: (e.target as HTMLSelectElement).value } } }))}>
                {o.values.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </Row>
          ))}
        </div>
      ))}
      <DsBios />
      <Row title="Reset all settings" desc="Restores defaults. Your games and saves are kept.">
        <button class="btn danger" onClick={() => { updateSettings(() => ({ ...DEFAULTS, welcomed: true })); toast('Settings reset', 'rotate', 'success'); }}>Reset</button>
      </Row>
    </>
  );
}

function About() {
  return (
    <>
      <h3>About Kaiser</h3>
      <p class="lead">A next-generation browser emulator. Free software under the GNU GPL v3, with credit and thanks to <a href="https://github.com/EmulatorJS/EmulatorJS" target="_blank" rel="noopener">EmulatorJS</a>, whose work this project studied and builds upon, and to the libretro core authors.</p>
      <div class="section-title"><h2 style={{ fontSize: '17px' }}>Emulator cores</h2></div>
      {[['FCEUmm (NES)', 'GPL-2.0'], ['Snes9x (SNES)', 'Snes9x license (non-commercial)'], ['Gambatte (GB/GBC)', 'GPL-2.0'], ['mGBA (GBA)', 'MPL-2.0'], ['Genesis Plus GX (Genesis/Mega Drive)', 'Genesis Plus GX license (non-commercial)']].map(([a, b]) => <Row key={a} title={a} desc={b} />)}
      <div class="section-title"><h2 style={{ fontSize: '17px' }}>Bundled homebrew</h2></div>
      {HOMEBREW.map(h => <Row key={h.file} title={h.title} desc={`${h.author} · ${h.license}`}><a class="btn ghost" href={h.url} target="_blank" rel="noopener">Source</a></Row>)}
      <Row title="Interface" desc="Outfit font (OFL-1.1) · Lucide icons (ISC) · Preact (MIT)" />
      <p style={{ color: 'var(--text-3)', marginTop: '20px' }}>Kaiser never downloads games for you. Only add games you own the rights to play.</p>
    </>
  );
}

function DsBios() {
  const [have, setHave] = useState<Record<string, boolean>>({});
  const refresh = async () => { const o: Record<string, boolean> = {}; for (const f of DS_BIOS_FILES) o[f] = !!(await db.kv('bios:' + f)); setHave(o); };
  useEffect(() => { refresh(); }, []);
  return (
    <>
      <div class="section-title"><h2 style={{ fontSize: '17px' }}>Nintendo DS BIOS (optional)</h2></div>
      <p style={{ color: 'var(--text-3)', marginTop: '-6px' }}>Kaiser runs DS games with the built-in open-source FreeBIOS. A few games work better with dumps of your own console's BIOS and firmware. Files stay in this browser and are never uploaded.</p>
      {DS_BIOS_FILES.map(f => (
        <Row key={f} title={f} desc={have[f] ? 'Installed' : 'Not installed — using FreeBIOS'}>
          <label class="btn"><Upload />{have[f] ? 'Replace' : 'Choose file'}<input type="file" hidden onChange={async e => {
            const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
            await db.putKv('bios:' + f, file); refresh(); toast(`${f} installed`, 'check', 'success');
          }} /></label>
          {have[f] && <button class="btn icon ghost danger" aria-label={`Remove ${f}`} onClick={async () => { await db.putKv('bios:' + f, null); refresh(); }}><Trash2 /></button>}
        </Row>
      ))}
    </>
  );
}

// ---------- per-game overrides (used in GameDetails) ----------
export function GameOverrides({ game }: { game: Game }) {
  const [over, setOver] = useState<Record<string, Record<string, unknown>>>((game.settings as Record<string, Record<string, unknown>>) ?? {});
  const g = useStore(settings);
  const save = async (o: typeof over) => { setOver(o); await db.updateGame(game.id, { settings: o }); await refreshLibrary(); };
  const put = (sec: string, k: string, v: unknown) => save({ ...over, [sec]: { ...(over[sec] ?? {}), [k]: v } });
  const val = <T,>(sec: 'video' | 'speed' | 'audio', k: string): T => (over[sec]?.[k] ?? (g[sec] as Record<string, unknown>)[k]) as T;
  const overridden = Object.values(over).some(o => o && Object.keys(o).length);
  return (
    <div>
      <p style={{ color: 'var(--text-3)', marginTop: '0px' }}>Override your global settings just for this game. <Palette style={{ width: '14px', verticalAlign: -2 }} /></p>
      <ShaderPreview shader={val('video', 'shader')} aspect={val('video', 'aspect')} integer={val('video', 'integer')} />
      <Row title="Shader" /><Chips value={val<ShaderId>('video', 'shader')} options={SHADERS.map(([a, b]) => [a, b])} onChange={v => put('video', 'shader', v)} />
      <Row title="Aspect ratio" /><Chips value={val<AspectMode>('video', 'aspect')} options={ASPECTS} onChange={v => put('video', 'aspect', v)} />
      <Row title="Integer scaling"><Toggle on={val('video', 'integer')} onChange={v => put('video', 'integer', v)} label="Integer scaling" /></Row>
      <Row title="Fast-forward speed" /><Chips value={val<number>('speed', 'ffSpeed')} options={[2, 3, 4, 8, 100].map(v => [v, speedLabel(v)] as [number, string])} onChange={v => put('speed', 'ffSpeed', v)} />
      <Row title="Rewind"><Toggle on={val('speed', 'rewind')} onChange={v => put('speed', 'rewind', v)} label="Rewind" /></Row>
      {overridden && <button class="btn ghost" style={{ marginTop: '12px' }} onClick={() => save({})}><Database />Use global settings</button>}
    </div>
  );
}

void BTN;
