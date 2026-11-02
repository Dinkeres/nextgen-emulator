import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, Copy, Crown, Eye, Gamepad2, Keyboard, Link2, LogIn, Play, Plus, Send, Users, AlertTriangle } from 'lucide-preact';
import { library, settings, toast, updateSettings, useStore } from '../app/store.ts';
import { addFiles, pickFiles } from '../app/library.ts';
import { SYSTEMS } from '../engine/systems.ts';
import type { Game } from '../app/db.ts';
import { NetSession, type LobbyPeer } from '../net/session.ts';
import { Cover, SysBadge } from './common.tsx';
import type { Nav } from './App.tsx';

const COLORS = ['#8b5cf6', '#22d3ee', '#f59e0b', '#f43f5e', '#10b981', '#6366f1', '#ec4899', '#84cc16'];

export function Lobby({ nav, game: initialGame, room: joinRoom }: { nav: Nav; game?: Game; room?: string }) {
  const s = useStore(settings);
  const games = useStore(library);
  const mpGames = games.filter(g => (SYSTEMS[g.system]?.maxPlayers ?? 1) > 1);
  const [pick, setPick] = useState<string>(initialGame?.id ?? mpGames[0]?.id ?? '');
  const [code, setCode] = useState(joinRoom ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [net, setNet] = useState<NetSession | null>(null);
  const [, force] = useState(0);
  const name = s.netplay.name || 'Player';
  const started = useRef(false);

  useEffect(() => net?.sub(() => force(n => n + 1)), [net]);
  useEffect(() => () => { if (!started.current) net?.close(); }, [net]);
  // auto-join from an invite link once a name exists
  useEffect(() => { if (joinRoom && s.netplay.name) connect({ room: joinRoom }); }, []);

  const connect = async (o: { create?: Game; room?: string }) => {
    setBusy(true); setErr('');
    try {
      const sess = await NetSession.connect(s.netplay.signalUrl, name, {
        create: o.create ? { id: o.create.id, title: o.create.title, system: o.create.system } : undefined,
        room: o.room?.trim().toUpperCase(),
        hasRom: g => library.value.some(x => x.id === g.id),
      });
      sess.onStart = () => {
        const g = library.value.find(x => x.id === sess.state.game?.id);
        if (!g) return;
        started.current = true;
        nav({ name: 'play', game: g, net: sess });
      };
      setNet(sess);
      history.replaceState(null, '', `#join=${sess.state.room}`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const leave = () => { net?.close(); setNet(null); history.replaceState(null, '', location.pathname); };

  // ---------- connect form ----------
  if (!net) {
    const g = games.find(x => x.id === pick);
    return (
      <>
        <header class="topbar">
          <button class="btn icon ghost" onClick={() => nav({ name: 'library' })} aria-label="Back"><ArrowLeft /></button>
          <div class="brand"><span>Multiplayer</span></div>
        </header>
        <main class="page" style={{ maxWidth: '980px' }}>
          <div class="section-title" style={{ marginTop: '0px' }}><h2>Play together online</h2></div>
          <p style={{ color: 'var(--text-2)', marginTop: '-6px' }}>Rollback netplay: every player runs the game locally and only button presses are sent, so it feels like playing on the same couch.</p>
          <div class="setting"><div class="lbl"><b>Your name</b><small>Shown to everyone in the room.</small></div>
            <div class="ctl"><input class="input" value={s.netplay.name} maxLength={20} placeholder="Player" onInput={e => updateSettings(x => ({ ...x, netplay: { ...x.netplay, name: (e.target as HTMLInputElement).value } }))} aria-label="Your name" /></div></div>
          {err && <div class="notice bad" style={{ margin: '14px 0' }}><AlertTriangle />{err}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px', marginTop: '18px' }}>
            <div class="card" style={{ padding: '20px' }}>
              <h3 style={{ marginTop: '0px', display: 'flex', gap: '10px', alignItems: 'center' }}><Crown style={{ width: '20px', color: 'var(--accent)' }} />Host a game</h3>
              {mpGames.length === 0 ? <p style={{ color: 'var(--text-3)' }}>Add a NES, SNES or Genesis game to host a match.</p> : <>
                <select class="input" style={{ width: '100%', borderRadius: '12px' }} value={pick} onChange={e => setPick((e.target as HTMLSelectElement).value)} aria-label="Game to host">
                  {mpGames.map(x => <option key={x.id} value={x.id}>{x.title} — {SYSTEMS[x.system].short}</option>)}
                </select>
                {g && <p style={{ color: 'var(--text-3)', fontSize: '13px' }}>{SYSTEMS[g.system].rollback ? 'Rollback netcode · ' : 'Delay-based netcode · '}up to {SYSTEMS[g.system].maxPlayers} players + spectators</p>}
                <button class="btn primary" disabled={busy || !g} onClick={() => connect({ create: g })} data-autofocus><Users />Create room</button>
              </>}
            </div>
            <div class="card" style={{ padding: '20px' }}>
              <h3 style={{ marginTop: '0px', display: 'flex', gap: '10px', alignItems: 'center' }}><LogIn style={{ width: '20px', color: 'var(--accent-2)' }} />Join a room</h3>
              <form onSubmit={e => { e.preventDefault(); if (code.trim()) connect({ room: code }); }} style={{ display: 'flex', gap: '8px' }}>
                <input class="input" style={{ flex: 1, textTransform: 'uppercase', letterSpacing: '.12em', fontWeight: 700 }} placeholder="ROOM CODE" value={code} maxLength={8} onInput={e => setCode((e.target as HTMLInputElement).value)} aria-label="Room code" />
                <button class="btn" disabled={busy || !code.trim()}>Join</button>
              </form>
              <p style={{ color: 'var(--text-3)', fontSize: '13px' }}>Or open an invite link from a friend.</p>
            </div>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: '13px', marginTop: '22px' }}>Signaling server: <code>{s.netplay.signalUrl}</code> · change it in Settings → Multiplayer. Everyone must use the same server.</p>
        </main>
      </>
    );
  }

  // ---------- in a room ----------
  const st = net.state;
  const sys = st.game ? SYSTEMS[st.game.system] : null;
  const myGame = st.game ? games.find(x => x.id === st.game!.id) : undefined;
  const me = net.mePeer;
  const reason = net.isHost ? net.canStart() : null;
  const link = `${location.origin}${location.pathname}#join=${st.room}`;
  const slots = Array.from({ length: sys?.maxPlayers ?? 2 }, (_, i) => st.peers.find(p => p.port === i));
  const spectators = st.peers.filter(p => p.port === null);

  const addRom = async () => {
    const f = await pickFiles(); if (!f.length) return;
    const added = await addFiles(f);
    const ok = added.some(a => a.id === st.game?.id);
    net.reportRom(ok);
    if (!ok) toast('That file is different from the host’s copy (the checksum doesn’t match). Try another dump of the same game.', 'alert', 'error', 6000);
    else toast('ROM verified — it matches the host’s copy', 'check', 'success');
  };

  return (
    <>
      <header class="topbar">
        <button class="btn icon ghost" onClick={leave} aria-label="Leave room"><ArrowLeft /></button>
        <div class="brand"><span>Room <b style={{ letterSpacing: '.12em' }}>{st.room}</b></span></div>
      </header>
      <main class="page" style={{ maxWidth: '1180px', paddingTop: '0px' }}>
        {net.error && <div class="notice bad" style={{ marginTop: '16px' }}><AlertTriangle />{net.error}</div>}
        <div class="lobby" style={{ padding: '20px 0' }}>
          <div>
            {st.game && (
              <div class="card" style={{ display: 'flex', gap: '16px', padding: '14px', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ position: 'relative', width: '64px', height: '84px', borderRadius: '12px', overflow: 'hidden', flex: 'none' }}>
                  {myGame ? <Cover game={myGame} small /> : <div class="ph" style={{ '--sys': sys?.color }} />}
                </div>
                <div style={{ flex: 1, minWidth: '0px' }}>
                  <SysBadge system={st.game.system} />
                  <h3 style={{ margin: '6px 0 2px' }}>{st.game.title}</h3>
                  <small style={{ color: 'var(--text-3)' }}>{sys?.rollback ? 'Rollback netcode' : 'Delay-based netcode'} · ROMs are matched by checksum and never sent</small>
                </div>
              </div>
            )}
            {!net.isHost && st.game && !myGame && (
              <div class="notice" style={{ marginBottom: '16px' }}><AlertTriangle />
                <div><b>You need the same ROM to play.</b><br />Add your copy of <b>{st.game.title}</b> ({sys?.name}). It has to be the exact same file as the host’s — it’s checked by checksum and never uploaded.
                  <div style={{ marginTop: '10px' }}><button class="btn" onClick={addRom}><Plus />Add ROM</button>
                    <button class="btn ghost" onClick={() => net.setSpectator(true)}><Eye />Watch instead</button></div></div>
              </div>
            )}
            <div class="linkbox">
              <input class="input" readOnly value={link} aria-label="Invite link" onFocus={e => (e.target as HTMLInputElement).select()} />
              <button class="btn" onClick={() => { navigator.clipboard?.writeText(link); toast('Invite link copied', 'check', 'success'); }}><Copy />Copy</button>
              {'share' in navigator && <button class="btn icon" onClick={() => navigator.share({ title: 'Play with me on Kaiser', url: link }).catch(() => {})} aria-label="Share"><Link2 /></button>}
            </div>
            <div class="pslots">
              {slots.map((p, i) => p ? <Slot key={p.id} p={p} i={i} me={net.me} host={st.hostId} /> : (
                <div key={i} class="pslot empty-slot">Player {i + 1} · open</div>
              ))}
            </div>
            {spectators.length > 0 && <p style={{ color: 'var(--text-3)', fontSize: '13.5px' }}><Eye style={{ width: '15px', verticalAlign: -3 }} /> Watching: {spectators.map(x => x.name).join(', ')}</p>}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '18px', alignItems: 'center' }}>
              {net.isHost ? (
                <>
                  <button class="btn primary big" disabled={!!reason} onClick={() => net.start({ inputDelay: s.netplay.inputDelay, maxRollback: s.netplay.maxRollback })}><Play fill="currentColor" />Start game</button>
                  <span style={{ color: 'var(--text-3)', fontSize: '14px' }}>{reason ?? 'Everyone is ready!'}</span>
                </>
              ) : me && (
                <>
                  {me.port !== null && <button class={`btn big ${me.ready ? '' : 'primary'}`} disabled={!myGame} onClick={() => net.setReady(!me.ready)}>{me.ready ? <><Check />Ready — tap to cancel</> : 'Ready up'}</button>}
                  <button class="btn big ghost" onClick={() => net.setSpectator(me.port !== null)}><Eye />{me.port === null ? 'Join as player' : 'Spectate'}</button>
                  <span style={{ color: 'var(--text-3)', fontSize: '14px' }}>The host starts the game when everyone is ready.</span>
                </>
              )}
            </div>
          </div>
          <Chat net={net} />
        </div>
      </main>
    </>
  );
}

function Slot({ p, i, me, host }: { p: LobbyPeer; i: number; me: string; host: string }) {
  const PadIcon = p.pad === 'keyboard' ? Keyboard : Gamepad2;
  const q = p.id === me ? null : p.ping < 0 ? null : p.ping < 80 ? 'good' : p.ping < 160 ? 'ok' : 'bad';
  return (
    <div class={`pslot ${p.ready ? 'ready' : ''}`}>
      <div class="av" style={{ background: COLORS[i % COLORS.length] }}>P{i + 1}</div>
      <div class="who">
        <b>{p.name}{p.id === me ? ' (you)' : ''} {p.id === host && <Crown style={{ width: '14px', color: 'var(--warn)', verticalAlign: -2 }} />}</b>
        <small style={{ display: 'flex', gap: '6px', alignItems: 'center' }}><PadIcon style={{ width: '14px' }} />{p.pad === 'keyboard' ? 'Keyboard' : p.pad}
          {q && <><span class={`q ${q}`} style={{ width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' }} />{p.ping} ms</>}
          {p.hasRom === false && <span style={{ color: 'var(--bad)' }}>· needs ROM</span>}</small>
      </div>
      <span class="state">{p.ready ? 'Ready' : 'Not ready'}</span>
    </div>
  );
}

function Chat({ net }: { net: NetSession }) {
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: 1e9, behavior: 'smooth' }); }, [net.chat.length]);
  return (
    <div class="chat" aria-label="Lobby chat">
      <div class="log" ref={log}>
        <div class="sys">Say hi! Chat is only visible in this room.</div>
        {net.chat.map((c, i) => c.sys ? <div key={i} class="sys">{c.text}</div> : <div key={i}><b>{c.name}</b>{c.text}</div>)}
      </div>
      <form onSubmit={e => { e.preventDefault(); net.sendChat(text); setText(''); }}>
        <input class="input" value={text} maxLength={300} placeholder="Message" onInput={e => setText((e.target as HTMLInputElement).value)} aria-label="Chat message" />
        <button class="btn icon primary" aria-label="Send"><Send /></button>
      </form>
    </div>
  );
}
