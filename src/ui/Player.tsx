import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ArrowLeft, Camera, Download, FastForward, Gamepad2, LogOut, Maximize, Minimize, Pause, Play, Rewind,
  RotateCcw, Save, Settings as Gear, Snail, Upload, Users, AlertTriangle, Volume2, VolumeX, Wand2,
} from 'lucide-preact';
import type { Game, SaveState } from '../app/db.ts';
import { db } from '../app/db.ts';
import { Session, SLOTS } from '../app/session.ts';
import { settings, toast, updateSettings, useStore, effective } from '../app/store.ts';
import { Input } from '../engine/input.ts';
import { SYSTEMS, BTN } from '../engine/systems.ts';
import type { Stats } from '../engine/protocol.ts';
import type { ShaderId, AspectMode } from '../engine/renderer.ts';
import { setGamepadUI } from './nav.ts';
import { SlotCard } from './GameDetails.tsx';
import { SysBadge } from './common.tsx';
import { TouchControls } from './TouchControls.tsx';
import { Cheats } from './Cheats.tsx';
import type { Nav } from './App.tsx';
import type { NetSession } from '../net/session.ts';

type Panel = null | 'save' | 'load' | 'settings' | 'controls' | 'cheats';

export function Player({ game, slot, fresh, nav, net }: { game: Game; slot?: number; fresh?: boolean; nav: Nav; net?: NetSession }) {
  const s = useStore(settings);
  const cfg = effective(s, game);
  const sys = SYSTEMS[game.system];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessRef = useRef<Session | null>(null);
  const input = useMemo(() => new Input(), []);
  const [phase, setPhase] = useState<'loading' | 'playing' | 'error'>('loading');
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [hud, setHud] = useState(true);
  const [ff, setFf] = useState(false);
  const [slow, setSlow] = useState(false);
  const [rew, setRew] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [states, setStates] = useState<SaveState[]>([]);
  const [fs, setFs] = useState(!!document.fullscreenElement);
  const [editTouch, setEditTouch] = useState(false);
  const lastSlot = useRef(1);
  const ui = useRef({ menu, panel, editTouch });
  ui.current = { menu, panel, editTouch };
  const touchMode = cfg.controls.touch === 'on' || (cfg.controls.touch === 'auto' && matchMedia('(pointer: coarse)').matches);

  // ---------- lifecycle ----------
  useEffect(() => {
    setGamepadUI(false);
    const sess = new Session(game, canvasRef.current!);
    sessRef.current = sess;
    (window as unknown as { __kaiser?: Session }).__kaiser = sess; // for tests/debugging
    sess.onStats = st => setStats(st);
    sess.onError = m => toast(m, 'alert', 'error', 5000);
    input.keys = cfg.controls.keys; input.pad = cfg.controls.pad; input.rebuild();
    sess.emu.pollInput = () => input.poll();
    (async () => {
      try {
        if (net) await net.attach(sess, input); else await sess.start({ slot, fresh });
        setPhase('playing');
      } catch (e) {
        setError((e as Error).message || String(e)); setPhase('error');
      }
    })();
    return () => { setGamepadUI(true); net?.detach(); sess.end(); };
  }, []);

  const sess = () => sessRef.current!;

  // live-apply settings while playing
  useEffect(() => {
    if (phase !== 'playing') return;
    sess().emu.set({
      display: { shader: cfg.video.shader, aspect: cfg.video.aspect, integer: cfg.video.integer },
      volume: cfg.audio.muted ? 0 : cfg.audio.volume, ffAudio: cfg.audio.ffAudio, vsyncLock: cfg.video.vsyncLock,
      rewind: { enabled: cfg.speed.rewind, seconds: cfg.speed.rewindSeconds, budgetMB: navigator.maxTouchPoints > 0 ? 48 : 128 },
    });
    sess().scheduleAuto();
  }, [phase, JSON.stringify([cfg.video, cfg.audio, cfg.speed, cfg.saves.autoSaveMinutes])]);

  // speed changes
  useEffect(() => {
    if (phase !== 'playing' || net) return;
    sess().emu.setSpeed(ff ? cfg.speed.ffSpeed : slow ? cfg.speed.slowSpeed : 1);
  }, [ff, slow, phase, cfg.speed.ffSpeed, cfg.speed.slowSpeed]);
  useEffect(() => { if (phase === 'playing' && !net) sess().emu.setRewinding(rew); }, [rew, phase]);

  // menu pauses the game (and auto-saves)
  useEffect(() => {
    if (phase !== 'playing') return;
    if (menu && !net) { sess().pause(true); setFf(false); setRew(false); db.states(game.id).then(setStates); }
    else if (!menu) { setPanel(null); sess().resume(); }
    input.enabled = !menu;
    if (menu) input.clear();
  }, [menu, phase]);

  // ---------- HUD auto-hide ----------
  const hideT = useRef(0);
  const poke = () => {
    setHud(true);
    clearTimeout(hideT.current);
    hideT.current = window.setTimeout(() => setHud(false), 2600);
  };
  useEffect(() => { poke(); return () => clearTimeout(hideT.current); }, []);

  // ---------- actions ----------
  const saveSlot = async (n: number) => {
    try { await sess().save(n); lastSlot.current = n; toast(`Saved to slot ${n}`, 'save', 'success'); setStates(await db.states(game.id)); }
    catch (e) { toast('Save failed: ' + (e as Error).message, 'alert', 'error'); }
  };
  const loadSlot = async (n: number) => {
    if (net) { toast("Loading states is disabled during multiplayer", 'alert', 'warn'); return; }
    const ok = await sess().load(n);
    if (ok) { lastSlot.current = n; toast(n === 0 ? 'Loaded auto-save' : `Loaded slot ${n}`, 'upload', 'success'); setMenu(false); }
    else toast(n === 0 ? 'No auto-save yet' : `Slot ${n} is empty`, 'alert', 'warn');
  };
  const screenshot = async () => {
    const png = await sess().emu.screenshot();
    if (!png) return;
    await db.putShot({ gameId: game.id, blob: png, createdAt: Date.now() });
    toast('Screenshot saved to gallery', 'camera', 'success');
  };
  const toggleFs = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else { await rootRef.current!.requestFullscreen({ navigationUI: 'hide' }); lockOrientation(); }
    } catch { /* iOS Safari: no element fullscreen */ }
  };
  const exit = () => nav({ name: 'library' });
  const setSpeedFf = (on: boolean) => { if (net) return; setFf(on); if (on) setSlow(false); };

  useEffect(() => {
    const f = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  // ---------- keyboard ----------
  useEffect(() => {
    const hk = cfg.controls.hotkeys;
    const down = (e: KeyboardEvent) => {
      if (phase !== 'playing' || e.repeat && e.code !== hk.ff) { if (e.repeat) e.preventDefault(); return; }
      if (e.code === hk.menu || e.key === 'Escape') {
        e.preventDefault();
        // read live UI state: several key events can arrive before React re-renders
        const u = ui.current;
        if (u.editTouch) { u.editTouch = false; setEditTouch(false); return; }
        if (u.panel) { u.panel = null; setPanel(null); return; }
        u.menu = !u.menu; setMenu(u.menu); return;
      }
      if (ui.current.menu) return;
      if (e.code === hk.ff) { e.preventDefault(); if (cfg.speed.ffMode === 'hold') setSpeedFf(true); else setSpeedFf(!ff); return; }
      if (e.code === hk.ffToggle) { e.preventDefault(); setSpeedFf(!ff); toast(!ff ? `Fast-forward ${speedLabel(cfg.speed.ffSpeed)}` : 'Normal speed', 'fast-forward', 'info', 1200); return; }
      if (e.code === hk.slowmo && !net) { e.preventDefault(); setSlow(v => !v); setFf(false); return; }
      if (e.code === hk.rewind && !net) { e.preventDefault(); setRew(true); return; }
      if (e.code === hk.save) { e.preventDefault(); saveSlot(lastSlot.current); return; }
      if (e.code === hk.load) { e.preventDefault(); loadSlot(lastSlot.current); return; }
      if (e.code === hk.screenshot) { e.preventDefault(); screenshot(); return; }
      if (e.code === hk.fullscreen) { e.preventDefault(); toggleFs(); return; }
      if (input.keyDown(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      input.keyUp(e.code);
      if (e.code === hk.ff && cfg.speed.ffMode === 'hold') setSpeedFf(false);
      if (e.code === hk.rewind) setRew(false);
    };
    const blur = () => { input.clear(); setRew(false); if (cfg.speed.ffMode === 'hold') setFf(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [phase, menu, panel, ff, editTouch, cfg.controls.hotkeys, cfg.speed.ffMode]);

  // ---------- controller hotkeys: Home or Select+Start = menu, Select+R = FF, Select+L = rewind ----------
  useEffect(() => {
    let raf = 0;
    const prev: Record<number, { menu: boolean; ff: boolean; rew: boolean }> = {};
    const tick = () => {
      raf = requestAnimationFrame(tick);
      for (const g of input.pads()) {
        const b = (i: number) => !!g.buttons[i]?.pressed;
        const sel = b(8);
        const st = { menu: b(16) || (sel && b(9)), ff: sel && b(5), rew: sel && b(4) };
        const p = prev[g.index] ?? { menu: false, ff: false, rew: false };
        if (st.menu && !p.menu) { if (panel) setPanel(null); else setMenu(m => !m); }
        if (!menu) {
          if (st.ff !== p.ff) setSpeedFf(st.ff);
          if (st.rew !== p.rew && !net) setRew(st.rew);
        }
        prev[g.index] = st;
      }
      // when the menu is open, let menu navigation use the pad
      setGamepadUI(menu);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [menu, panel]);

  // ---------- render ----------
  const speed = ff ? cfg.speed.ffSpeed : slow ? cfg.speed.slowSpeed : 1;
  const rewindMax = cfg.speed.rewindSeconds;
  const netStats = stats?.net;

  return (
    <div class={`player ${hud || menu ? '' : 'hide-cursor'} ${touchMode && !menu ? 'touch-mode' : ''}`} ref={rootRef} style={{ '--sys': sys.color }}
      onContextMenu={e => e.preventDefault()}
      onPointerMove={e => { if (e.pointerType === 'mouse') poke(); }}
      onPointerDown={e => { if (!(e.target as HTMLElement).closest('.tbtn, .dpad, .hud, .pause')) poke(); }}>
      <canvas class="screen" ref={canvasRef} aria-label={`${game.title} game screen`} />

      {phase === 'loading' && (
        <div class="loading"><div class="box"><div class="spinner" /><h2>{game.title}</h2><p>{net ? 'Syncing with players…' : `Starting ${sys.name}…`}</p></div></div>
      )}
      {phase === 'error' && (
        <div class="loading"><div class="box">
          <AlertTriangle style={{ width: '44px', height: '44px', color: 'var(--warn)' }} />
          <h2>This game couldn't start</h2>
          <p style={{ maxWidth: '420px' }}>{error}</p>
          <button class="btn primary" onClick={exit} data-autofocus><ArrowLeft />Back to library</button>
        </div></div>
      )}

      {phase === 'playing' && <>
        {rew && <div class="indicator rew"><Rewind fill="currentColor" />Rewinding<span class="meter"><i style={{ width: `${Math.min(100, (stats?.rewindSeconds ?? 0) / rewindMax * 100)}%` }} /></span></div>}
        {!rew && ff && <div class="indicator ff"><FastForward fill="currentColor" />{speedLabel(cfg.speed.ffSpeed)}</div>}
        {!rew && !ff && slow && <div class="indicator slow"><Snail />{cfg.speed.slowSpeed}×</div>}

        {cfg.video.showFps && stats && (
          <div class="statsbox">{`${stats.fps.toFixed(0)} fps  ·  emu ${stats.emuFps.toFixed(0)}\nframe ${stats.workMs.toFixed(2)} ms\naudio ${stats.audioFill} buf  ·  ${stats.underruns} underruns\nrewind ${stats.rewindSeconds.toFixed(0)} s / ${stats.rewindMB.toFixed(1)} MB${netStats ? `\nrollbacks ${netStats.rollbacks}  max ${netStats.maxRollbackSeen}f` : ''}`}</div>
        )}
        {net && netStats && <NetOverlay stats={netStats} names={net.names()} />}

        {touchMode && !menu && <TouchControls system={sys} input={input} editing={editTouch} onDone={() => setEditTouch(false)}
          onMenu={() => setMenu(true)} onFf={on => setSpeedFf(cfg.speed.ffMode === 'hold' ? on : on ? !ff : ff)} onRewind={on => !net && setRew(on)} />}

        {!menu && !editTouch && <>
          <div class={`hud top ${hud ? '' : 'hidden'}`}>
            <button class="hbtn" onClick={exit} aria-label="Exit to library"><ArrowLeft /><span class="tip">Library</span></button>
            <div class="title">{game.title}</div>
            {document.fullscreenEnabled && <button class="hbtn" onClick={toggleFs} aria-label="Fullscreen">{fs ? <Minimize /> : <Maximize />}<span class="tip">Fullscreen</span></button>}
            <button class="hbtn" onClick={() => { setMenu(true); setPanel('settings'); }} aria-label="Settings"><Gear /><span class="tip">Settings</span></button>
          </div>
          <div class={`hud bottom ${hud ? '' : 'hidden'}`}>
            <div class="bar">
              <button class="hbtn" onClick={() => setMenu(true)} aria-label="Pause"><Pause /><span class="tip">Pause (Esc)</span></button>
              {!net && <button class={`hbtn ${rew ? 'on' : ''}`} aria-label="Rewind (hold)"
                onPointerDown={() => setRew(true)} onPointerUp={() => setRew(false)} onPointerLeave={() => setRew(false)} onPointerCancel={() => setRew(false)}>
                <Rewind /><span class="tip">Hold to rewind</span></button>}
              {!net && <button class={`hbtn ${ff ? 'on' : ''}`} onClick={() => setSpeedFf(!ff)} aria-label="Fast-forward" aria-pressed={ff}><FastForward /><span class="tip">Fast-forward ({speedLabel(cfg.speed.ffSpeed)})</span></button>}
              {!net && <button class={`hbtn opt ${slow ? 'on' : ''}`} onClick={() => { setSlow(!slow); setFf(false); }} aria-label="Slow motion" aria-pressed={slow}><Snail /><span class="tip">Slow motion</span></button>}
              <button class="hbtn" onClick={() => saveSlot(lastSlot.current)} aria-label="Quick save"><Save /><span class="tip">Save to slot {lastSlot.current} (F5)</span></button>
              {!net && <button class="hbtn" onClick={() => loadSlot(lastSlot.current)} aria-label="Quick load"><Upload /><span class="tip">Load slot {lastSlot.current} (F8)</span></button>}
              <button class="hbtn opt" onClick={screenshot} aria-label="Screenshot"><Camera /><span class="tip">Screenshot</span></button>
              <button class="hbtn opt" onClick={() => updateSettings(x => ({ ...x, audio: { ...x.audio, muted: !x.audio.muted } }))} aria-label={cfg.audio.muted ? 'Unmute' : 'Mute'}>{cfg.audio.muted ? <VolumeX /> : <Volume2 />}<span class="tip">{cfg.audio.muted ? 'Unmute' : 'Mute'}</span></button>
              {sys.maxPlayers > 1 && !net && <button class="hbtn opt" onClick={() => nav({ name: 'lobby', game })} aria-label="Multiplayer"><Users /><span class="tip">Multiplayer</span></button>}
            </div>
          </div>
        </>}

        {editTouch && <div class="editbar"><span style={{ padding: '0 6px', fontSize: '13px' }}>Drag to move · pinch or use +/- to resize</span></div>}

        {menu && (
          <div class="pause" onPointerDown={e => { if (e.target === e.currentTarget) setMenu(false); }}>
            <nav class="menu" aria-label="Pause menu">
              <div class="gname">{game.title}</div>
              <div class="gsys"><SysBadge system={game.system} />{net ? 'Online match' : 'Paused'}</div>
              <MenuItem icon={Play} label="Resume" primary kbd="Esc" onClick={() => setMenu(false)} autofocus />
              <MenuItem icon={Save} label="Save state" onClick={() => setPanel('save')} on={panel === 'save'} />
              {!net && <MenuItem icon={Upload} label="Load state" onClick={() => setPanel('load')} on={panel === 'load'} />}
              <MenuItem icon={Gear} label="Settings" onClick={() => setPanel('settings')} on={panel === 'settings'} />
              <MenuItem icon={Gamepad2} label="Controls" onClick={() => setPanel('controls')} on={panel === 'controls'} />
              {!net && <MenuItem icon={Wand2} label="Cheats" onClick={() => setPanel('cheats')} on={panel === 'cheats'} />}
              {sys.maxPlayers > 1 && !net && <MenuItem icon={Users} label="Multiplayer" onClick={() => nav({ name: 'lobby', game })} />}
              {!net && <MenuItem icon={RotateCcw} label="Reset game" onClick={() => { sess().emu.reset(); setMenu(false); toast('Game reset', 'rotate', 'info'); }} />}
              <MenuItem icon={LogOut} label="Exit to library" onClick={exit} />
            </nav>
            <div class={`panel ${panel ? '' : 'empty-panel'}`}>
              {panel && <button class="btn ghost" style={{ alignSelf: 'flex-start', color: '#fff', marginBottom: '8px' }} onClick={() => setPanel(null)}><ArrowLeft />Back</button>}
              {(panel === 'save' || panel === 'load') && (
                <>
                  <h3>{panel === 'save' ? 'Save to a slot' : 'Load a save'}</h3>
                  <div class="slots">
                    {panel === 'load' && states.find(x => x.slot === 0) && <SlotCard s={states.find(x => x.slot === 0)} onClick={() => loadSlot(0)} />}
                    {Array.from({ length: SLOTS }, (_, i) => i + 1).map(n => {
                      const st = states.find(x => x.slot === n);
                      return <SlotCard key={n} s={st} label={`Slot ${n}`} onClick={() => panel === 'save' ? saveSlot(n) : loadSlot(n)} />;
                    })}
                  </div>
                </>
              )}
              {panel === 'settings' && <QuickSettings game={game} />}
              {panel === 'cheats' && <><h3>Cheats</h3><Cheats game={game} dark onApply={codes => sess().emu.cheats(codes)} /></>}
              {panel === 'controls' && (
                <>
                  <h3>Controls</h3>
                  <ControlsHelp sysName={sys.name} />
                  <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
                    <button class="btn" onClick={() => nav({ name: 'settings', section: 'controls' })}>Remap buttons</button>
                    {touchMode && <button class="btn" onClick={() => { setEditTouch(true); setMenu(false); }}>Edit touch layout</button>}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </>}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, primary, kbd, on, autofocus }: { icon: typeof Play; label: string; onClick: () => void; primary?: boolean; kbd?: string; on?: boolean; autofocus?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (autofocus) ref.current?.focus({ preventScroll: true }); }, []);
  return <button ref={ref} class={`mitem ${primary ? 'primary' : ''} ${on ? 'nav-focus' : ''}`} onClick={onClick}><Icon />{label}{kbd && <kbd>{kbd}</kbd>}</button>;
}

function QuickSettings({ game }: { game: Game }) {
  const s = useStore(settings);
  const set = <K extends 'video' | 'audio' | 'speed'>(k: K, v: Partial<typeof s[K]>) => updateSettings(x => ({ ...x, [k]: { ...x[k], ...v } }));
  const shaders: [ShaderId, string][] = [['sharp', 'Sharp'], ['nearest', 'Pixel'], ['smooth', 'Smooth'], ['scanlines', 'Scanlines'], ['crt', 'CRT'], ['lcd', 'LCD grid']];
  const aspects: [AspectMode, string][] = [['core', 'Original'], ['4:3', '4:3'], ['16:9', '16:9'], ['square', 'Square pixels'], ['stretch', 'Stretch']];
  void game;
  return (
    <div>
      <h3>Quick settings</h3>
      <div class="setting"><div class="lbl"><b>Shader</b><small>Changes apply instantly behind this menu.</small></div></div>
      <div class="opts">{shaders.map(([id, l]) => <button key={id} class={`chip ${s.video.shader === id ? 'on' : ''}`} onClick={() => set('video', { shader: id })}>{l}</button>)}</div>
      <div class="setting"><div class="lbl"><b>Aspect ratio</b></div></div>
      <div class="opts">{aspects.map(([id, l]) => <button key={id} class={`chip ${s.video.aspect === id ? 'on' : ''}`} onClick={() => set('video', { aspect: id })}>{l}</button>)}</div>
      <div class="setting"><div class="lbl"><b>Integer scaling</b><small>Perfectly even pixels; may add borders.</small></div>
        <div class="ctl"><button class={`toggle ${s.video.integer ? 'on' : ''}`} role="switch" aria-checked={s.video.integer} aria-label="Integer scaling" onClick={() => set('video', { integer: !s.video.integer })} /></div></div>
      <div class="setting"><div class="lbl"><b>Volume</b></div>
        <div class="ctl"><input class="range" type="range" min="0" max="1" step="0.05" value={s.audio.volume} onInput={e => set('audio', { volume: +(e.target as HTMLInputElement).value, muted: false })} aria-label="Volume" /></div></div>
      <div class="setting"><div class="lbl"><b>Fast-forward speed</b></div></div>
      <div class="opts">{[2, 3, 4, 8, 100].map(v => <button key={v} class={`chip ${s.speed.ffSpeed === v ? 'on' : ''}`} onClick={() => set('speed', { ffSpeed: v })}>{speedLabel(v)}</button>)}</div>
      <div class="setting"><div class="lbl"><b>Show performance stats</b></div>
        <div class="ctl"><button class={`toggle ${s.video.showFps ? 'on' : ''}`} role="switch" aria-checked={s.video.showFps} aria-label="Show stats" onClick={() => set('video', { showFps: !s.video.showFps })} /></div></div>
    </div>
  );
}

function ControlsHelp({ sysName }: { sysName: string }) {
  const s = useStore(settings);
  const k = (c?: string) => (c ?? '').replace(/^Key|^Digit/, '').replace('Arrow', '');
  const hk = s.controls.hotkeys;
  const rows: [string, string][] = [
    ['D-pad', 'Arrow keys'], ['A / B', `${k(s.controls.keys.A?.[0])} / ${k(s.controls.keys.B?.[0])}`], ['X / Y', `${k(s.controls.keys.X?.[0])} / ${k(s.controls.keys.Y?.[0])}`],
    ['L / R', `${k(s.controls.keys.L?.[0])} / ${k(s.controls.keys.R?.[0])}`], ['Start / Select', `${k(s.controls.keys.START?.[0])} / ${k(s.controls.keys.SELECT?.[0])}`],
    ['Fast-forward', `${k(hk.ff)} (${s.speed.ffMode}) · Select+R on a controller`], ['Rewind', `${k(hk.rewind)} (hold) · Select+L`],
    ['Pause menu', `${k(hk.menu)} · Home or Select+Start`], ['Quick save / load', `${hk.save} / ${hk.load}`],
  ];
  return (
    <div>
      <p style={{ color: 'rgba(255,255,255,.6)', marginTop: '0px' }}>Keyboard and controllers work together. Plug in a controller any time — {sysName} buttons map by position.</p>
      {rows.map(([a, b]) => <div class="setting" key={a} style={{ padding: '10px 0' }}><div class="lbl"><b>{a}</b></div><div class="ctl" style={{ color: 'rgba(255,255,255,.7)', fontFamily: 'ui-monospace, monospace', fontSize: '13px' }}>{b}</div></div>)}
    </div>
  );
}

function NetOverlay({ stats, names }: { stats: NonNullable<Stats['net']>; names: Record<number, string> }) {
  return (
    <div class="netbox" aria-live="polite">
      {stats.peers.map(p => {
        const q = p.ping < 0 ? 'bad' : p.ping < 80 ? 'good' : p.ping < 160 ? 'ok' : 'bad';
        return <div class="p" key={p.port}><span class={`q ${q}`} />{names[p.port] ?? `P${p.port + 1}`}<span style={{ opacity: .7 }}>{p.ping < 0 ? '—' : `${p.ping} ms`}</span></div>;
      })}
      <div class="p" style={{ opacity: .8 }}>Rollback {stats.rollbacks ? (stats.rollbackFrames / stats.rollbacks).toFixed(1) : '0'}f avg · max {stats.maxRollbackSeen}f</div>
    </div>
  );
}

export const speedLabel = (v: number) => v >= 100 ? 'Max' : `${v}×`;

/** In fullscreen on phones, keep the orientation the player is holding (no accidental rotation). */
function lockOrientation() {
  const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  if (matchMedia('(pointer: coarse)').matches) o?.lock?.(innerWidth > innerHeight ? 'landscape' : 'portrait').catch(() => {});
}

void BTN;
