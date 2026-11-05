// Soul Link runs: your runs and records, the lobby, the summary, and the link chart they share.
// The run's look lives in runs.css and is deliberately its own world inside Kaiser.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, Crown, Eye, Play, Plus, Send, Skull, Trophy, UserPlus, X } from 'lucide-preact';
import './runs.css';
import { account } from '../app/account.ts';
import { addFiles, pickFiles } from '../app/library.ts';
import { library, toast, useStore } from '../app/store.ts';
import type { Game } from '../app/db.ts';
import {
  eventText, MODE_INFO, RunConn, runGame, runsApi, soulCompatible,
  type Friends, type Invite, type Mode, type Run, type RunEvent, type RunRow, type TeamState,
} from '../app/runs.ts';
import { AccountForm } from './Settings.tsx';
import { Player } from './Player.tsx';
import type { Nav } from './App.tsx';

const hms = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'Under 1m';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const when = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** The signature: every route is a cable through what the team caught there. Death cuts it. */
export function LinkChart({ team, names, compact, empty }: { team: TeamState; names: Record<number, string>; compact?: boolean; empty?: string }) {
  const routes = Object.values(team.routes);
  if (!routes.length) return <p class="rr-empty">{empty ?? 'Nothing caught yet. Your starters link up first.'}</p>;
  return (
    <ol class={`rr-chart ${compact ? 'compact' : ''}`}>
      {routes.map(r => {
        const waiting = team.members.filter(id => !r.slots[id]);
        return (
          <li key={r.sec} class={`rr-route ${r.status}`}>
            <span class="rr-area">{r.area}</span>
            <span class="rr-cable">
              {team.members.map(id => {
                const s = r.slots[id];
                return <span key={id} class={`rr-mon ${s ? '' : 'empty'}`} title={names[id]}>{s ? s.nick : r.status === 'dead' ? 'none' : '?'}</span>;
              })}
            </span>
            {!compact && <span class="rr-note">{r.status === 'dead' ? 'Dead' : r.status === 'linked' ? 'Linked' : `Waiting on ${waiting.map(id => names[id]).join(' and ')}`}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- the runs home ----------
export function RunsHome({ nav }: { nav: Nav }) {
  const acct = useStore(account);
  const games = useStore(library);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [friends, setFriends] = useState<Friends | null>(null);
  const [making, setMaking] = useState(false);
  const [err, setErr] = useState('');
  const [add, setAdd] = useState('');

  const refresh = async () => {
    try {
      const [l, f] = await Promise.all([runsApi.list(), runsApi.friends()]);
      setRuns(l.runs); setInvites(l.invites); setFriends(f); setErr('');
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => {
    if (!acct) return;
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [acct?.username]);

  const done = runs.filter(r => r.status === 'done' && r.ended && r.started);
  const won = done.filter(r => r.winner === r.team);
  const records = useMemo(() => {
    const fastest = won.reduce<number | null>((a, r) => { const t = r.ended! - r.started!; return a === null || t < a ? t : a; }, null);
    return {
      fastest: fastest === null ? 'None yet' : hms(fastest),
      wins: won.length,
      cleanest: won.length ? Math.min(...won.map(r => r.deaths)) : null,
      resets: runs.length ? Math.max(...runs.map(r => r.resets)) : 0,
    };
  }, [runs]);

  const join = async (i: Invite) => {
    try { await runsApi.join(i.id); nav({ name: 'run', id: i.id }); } catch (e) { toast((e as Error).message, 'alert', 'error'); }
  };
  const addFriend = async (e: Event) => {
    e.preventDefault();
    if (!add.trim()) return;
    try { await runsApi.addFriend(add.trim()); setAdd(''); toast('Friend request sent', 'check', 'success'); refresh(); }
    catch (x) { toast((x as Error).message, 'alert', 'error'); }
  };

  return (
    <div class="rr">
      <header class="rr-bar">
        <button class="rr-back" onClick={() => nav({ name: 'library' })} aria-label="Back to library"><ArrowLeft /></button>
        <span>Kaiser</span>
      </header>
      <main class="rr-page">
        <section class="rr-hero">
          <h1>Soul Link</h1>
          <p>You and your friends each play your own game. Whatever you catch on a route is tied together. If one dies, they all die.</p>
          {acct && <button class="rr-go" onClick={() => setMaking(true)} data-autofocus><Plus />New run</button>}
          <svg class="rr-hero-cable" viewBox="0 0 900 60" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 42 C120 42 150 14 280 14 S440 46 560 46" />
            <path class="cut" d="M600 22 C690 22 760 44 900 30" />
          </svg>
        </section>

        {!acct ? (
          <section class="rr-sec"><h2>Sign in to start a run</h2><p class="rr-dim">Runs, friends and the summary all live on your account.</p><AccountForm /></section>
        ) : <>
          {err && <p class="rr-bad" role="alert">{err}</p>}
          {invites.length > 0 && (
            <section class="rr-sec rr-invites">
              <h2>Invites</h2>
              {invites.map(i => (
                <div class="rr-row" key={i.id}>
                  <span><b>{i.name}</b><small>{i.host} invited you to a {MODE_INFO[i.mode].name}</small></span>
                  <button class="rr-btn" onClick={() => join(i)}>Join run</button>
                </div>
              ))}
            </section>
          )}
          <div class="rr-split">
            <section class="rr-sec">
              <h2>Your runs</h2>
              {runs.length === 0 ? <p class="rr-empty">No runs yet. Start one and invite a friend.</p> : runs.map(r => (
                <button class="rr-row rr-runrow" key={r.id} onClick={() => nav({ name: 'run', id: r.id })}>
                  <span><b>{r.name}</b><small>{MODE_INFO[r.mode].name} in {r.game_title}, {when(r.created)}</small></span>
                  <span class="rr-tally">
                    {r.status === 'done' ? (r.winner === r.team ? <em class="win">Won</em> : <em>Lost</em>) : <em class="live">{r.status === 'lobby' ? 'In lobby' : 'Playing'}</em>}
                    <small>{r.deaths} deaths, {r.resets} resets</small>
                  </span>
                </button>
              ))}
            </section>
            <aside class="rr-side">
              <section class="rr-sec">
                <h2>Records</h2>
                <dl class="rr-records">
                  <div><dt>Fastest win</dt><dd>{records.fastest}</dd></div>
                  <div><dt>Wins</dt><dd>{records.wins}</dd></div>
                  <div><dt>Fewest deaths in a win</dt><dd>{records.cleanest ?? 'None yet'}</dd></div>
                  <div><dt>Most resets in a run</dt><dd>{records.resets}</dd></div>
                </dl>
              </section>
              <section class="rr-sec">
                <h2>Friends</h2>
                {friends?.incoming.map(r => (
                  <div class="rr-row" key={r.id}>
                    <span><b>{r.username}</b><small>Wants to be friends</small></span>
                    <span class="rr-pair">
                      <button class="rr-icon" aria-label={`Accept ${r.username}`} onClick={() => runsApi.answerFriend(r.id, true).then(refresh)}><Check /></button>
                      <button class="rr-icon" aria-label={`Decline ${r.username}`} onClick={() => runsApi.answerFriend(r.id, false).then(refresh)}><X /></button>
                    </span>
                  </div>
                ))}
                {friends?.friends.map(f => <div class="rr-row" key={f.id}><span><b>{f.username}</b></span></div>)}
                {friends && !friends.friends.length && !friends.incoming.length && <p class="rr-empty">Add a friend to invite them to runs.</p>}
                <form class="rr-inline" onSubmit={addFriend}>
                  <input value={add} onInput={e => setAdd((e.target as HTMLInputElement).value)} placeholder="Username" aria-label="Friend's username" maxLength={16} />
                  <button class="rr-btn" disabled={!add.trim()}><UserPlus />Add</button>
                </form>
              </section>
            </aside>
          </div>
        </>}
      </main>
      {making && <NewRun games={games} nav={nav} close={() => setMaking(false)} />}
    </div>
  );
}

function NewRun({ games, nav, close }: { games: Game[]; nav: Nav; close: () => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>('soullink');
  const [ok, setOk] = useState<Game[] | null>(null);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      const list: Game[] = [];
      for (const g of games.filter(x => x.system === 'gba')) if (await soulCompatible(g).catch(() => false)) list.push(g);
      setOk(list); setPick(list[0]?.id ?? '');
    })();
  }, [games.length]);
  const submit = async (e: Event) => {
    e.preventDefault();
    const g = ok?.find(x => x.id === pick);
    if (!g) return;
    try { nav({ name: 'run', id: (await runsApi.create({ name, mode, gameId: g.id, gameTitle: g.title })).id }); }
    catch (x) { setErr((x as Error).message); }
  };
  const addGame = async () => { const f = await pickFiles(); if (f.length) await addFiles(f); };
  return (
    <div class="rr-scrim" role="dialog" aria-modal="true" aria-label="New run">
      <form class="rr-dialog" onSubmit={submit}>
        <h2>Name your run</h2>
        <input class="rr-name" value={name} maxLength={40} placeholder="Friday night race" onInput={e => setName((e.target as HTMLInputElement).value)} aria-label="Run name" autoFocus />
        <div class="rr-modes" role="radiogroup" aria-label="Game mode">
          {(Object.keys(MODE_INFO) as Mode[]).map(m => (
            <label key={m} class={mode === m ? 'on' : ''}>
              <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
              <b>{MODE_INFO[m].name}</b><small>{MODE_INFO[m].blurb}</small>
            </label>
          ))}
        </div>
        {ok === null ? <p class="rr-dim">Checking your games…</p> : ok.length === 0 ? (
          <div><p class="rr-dim">Runs need Radical Red or FireRed (USA, first release). Add your patched copy to your library.</p>
            <button type="button" class="rr-btn" onClick={addGame}><Plus />Add a game</button></div>
        ) : (
          <label class="rr-field">Game
            <select value={pick} onChange={e => setPick((e.target as HTMLSelectElement).value)}>{ok.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select>
          </label>
        )}
        {err && <p class="rr-bad" role="alert">{err}</p>}
        <div class="rr-actions">
          <button type="button" class="rr-btn ghost" onClick={close}>Cancel</button>
          <button class="rr-go small" disabled={!name.trim() || !pick}>Create run</button>
        </div>
      </form>
    </div>
  );
}

// ---------- one run: lobby, playing or summary ----------
export function RunScreen({ id, nav }: { id: string; nav: Nav }) {
  const conn = useMemo(() => new RunConn(id), [id]);
  const [, force] = useState(0);
  useEffect(() => { const off = conn.sub(() => force(n => n + 1)); return () => { off(); conn.close(); }; }, [conn]);
  const run = conn.run;
  if (!run) return <div class="rr rr-wait"><p>{conn.error || 'Connecting to the run…'}</p><button class="rr-btn ghost" onClick={() => nav({ name: 'runs' })}>Back to runs</button></div>;
  if (run.status === 'lobby') return <RunLobby conn={conn} run={run} nav={nav} />;
  if (run.status === 'playing' && conn.mine) return <RunPlay conn={conn} run={run} nav={nav} />;
  return <RunSummary id={id} nav={nav} />;
}

function Chat({ conn }: { conn: RunConn }) {
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: 1e9 }); }, [conn.chat.length]);
  return (
    <div class="rr-chat" aria-label="Team chat">
      <div class="log" ref={log}>
        {conn.chat.length === 0 && <p class="rr-empty">Only your team can read this.</p>}
        {conn.chat.map((c, i) => <p key={i}><b>{c.who}</b> {c.text}</p>)}
      </div>
      <form onSubmit={e => { e.preventDefault(); if (text.trim()) conn.say(text); setText(''); }}>
        <input value={text} maxLength={300} placeholder="Message your team" onInput={e => setText((e.target as HTMLInputElement).value)} aria-label="Message your team" />
        <button class="rr-icon" aria-label="Send"><Send /></button>
      </form>
    </div>
  );
}

function RunLobby({ conn, run, nav }: { conn: RunConn; run: Run; nav: Nav }) {
  const games = useStore(library);
  const [friends, setFriends] = useState<Friends | null>(null);
  const [sent, setSent] = useState<number[]>([]);
  useEffect(() => { runsApi.friends().then(setFriends).catch(() => {}); }, []);
  const mine = conn.mine;
  const host = run.host === conn.me;
  const hasGame = games.some(g => g.id === run.game_id);
  const teams = Array.from({ length: run.rules.teams[1] }, (_, i) => i + 1);
  const waiting = run.players.filter(p => !p.ready || !p.online);
  const invite = async (f: number) => {
    try { await runsApi.invite(run.id, f); setSent([...sent, f]); } catch (e) { toast((e as Error).message, 'alert', 'error'); }
  };
  const leave = async () => { await runsApi.leave(run.id).catch(() => {}); nav({ name: 'runs' }); };
  const addRom = async () => {
    const f = await pickFiles(); if (!f.length) return;
    const added = await addFiles(f);
    if (!added.some(a => a.id === run.game_id)) toast('That file is different from the host’s copy. Everyone needs the exact same ROM.', 'alert', 'error', 6000);
  };
  const open = friends?.friends.filter(f => !run.players.some(p => p.id === f.id)) ?? [];
  return (
    <div class="rr">
      <header class="rr-bar">
        <button class="rr-back" onClick={leave} aria-label="Leave run"><ArrowLeft /></button>
        <span>{MODE_INFO[run.mode].name} in {run.game_title}</span>
      </header>
      <main class="rr-page">
        <h1 class="rr-title">{run.name}</h1>
        {conn.error && <p class="rr-bad" role="alert">{conn.error}</p>}
        {!hasGame && <div class="rr-need"><p><b>You need the same game.</b> Add your copy of {run.game_title}. It has to match the host’s file exactly, and it never leaves your device.</p><button class="rr-btn" onClick={addRom}><Plus />Add game</button></div>}
        <div class="rr-lobby">
          <div>
            <div class="rr-teams">
              {teams.map(t => {
                const list = run.players.filter(p => p.team === t);
                const full = list.length >= run.rules.perTeam[1];
                return (
                  <section class={`rr-team t${t}`} key={t}>
                    <h2>Team {t}</h2>
                    <ul>
                      {list.map(p => (
                        <li key={p.id} class={p.online ? '' : 'off'}>
                          <span>{p.name}{p.id === run.host && <Crown aria-label="Host" />}</span>
                          <small>{!p.online ? 'Not here' : p.ready ? 'Ready' : 'Getting ready'}</small>
                        </li>
                      ))}
                      {Array.from({ length: run.rules.perTeam[1] - list.length }, (_, i) => <li key={i} class="open"><span>Open</span></li>)}
                    </ul>
                    {mine && mine.team !== t && !full && teams.length > 1 && <button class="rr-btn ghost" onClick={() => conn.team(t)}>Switch to team {t}</button>}
                  </section>
                );
              })}
            </div>
            <div class="rr-actions start">
              {mine && <button class={mine.ready ? 'rr-btn' : 'rr-go small'} disabled={!hasGame} onClick={() => conn.ready(!mine.ready)}>{mine.ready ? 'Not ready' : 'Ready'}</button>}
              {host && <button class="rr-go small" disabled={waiting.length > 0} onClick={() => conn.start()}><Play />Start run</button>}
              <span class="rr-dim">{waiting.length ? `Waiting for ${waiting.map(p => p.name).join(', ')}` : host ? 'Everyone is ready.' : 'The host starts the run.'}</span>
            </div>
          </div>
          <aside class="rr-side">
            <section class="rr-sec">
              <h2>Invite friends</h2>
              {open.length === 0 ? <p class="rr-empty">Nobody left to invite. Add friends from the runs page.</p> : open.map(f => (
                <div class="rr-row" key={f.id}>
                  <span><b>{f.username}</b></span>
                  <button class="rr-btn ghost" disabled={sent.includes(f.id)} onClick={() => invite(f.id)}>{sent.includes(f.id) ? 'Invited' : 'Invite'}</button>
                </div>
              ))}
            </section>
            <section class="rr-sec"><h2>Team chat</h2><Chat conn={conn} /></section>
          </aside>
        </div>
      </main>
    </div>
  );
}

// ---------- playing ----------
function beep() {
  try {
    const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(440, a.currentTime); o.frequency.exponentialRampToValueAtTime(110, a.currentTime + 0.5);
    g.gain.setValueAtTime(0.06, a.currentTime); g.gain.linearRampToValueAtTime(0, a.currentTime + 0.5);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.5);
    o.onended = () => a.close();
  } catch { /* no sound available */ }
}

function RunPlay({ conn, run, nav }: { conn: RunConn; run: Run; nav: Nav }) {
  const games = useStore(library);
  const base = games.find(g => g.id === run.game_id);
  const team = conn.myTeam;
  const attempt = team?.attempt ?? 1;
  const [game, setGame] = useState<Game | null>(null);
  const [alert, setAlert] = useState<{ title: string; text: string; hard?: boolean } | null>(null);
  const names = Object.fromEntries(run.players.map(p => [p.id, p.name]));
  useEffect(() => { setGame(null); if (base) runGame(base, run, conn.me, attempt).then(setGame); }, [base?.id, attempt]);
  useEffect(() => {
    let t = 0;
    conn.onHappened = list => {
      const mineTeam = conn.mine?.team;
      for (const e of list) {
        if (e.team === mineTeam && e.kind === 'death') {
          const others = (e.group as string[]).filter(n => n !== e.nick);
          setAlert({ title: `${e.nick} died`, text: others.length ? `${others.join(' and ')} went with it.` : `Caught in ${e.caught}.` }); beep();
        } else if (e.team === mineTeam && e.kind === 'wipe') {
          setAlert({ title: 'Your team wiped', text: run.mode === 'race' ? 'Everyone starts over from the beginning.' : 'The run is over.', hard: true }); beep();
        } else if (e.team === mineTeam && e.kind === 'missed') {
          setAlert({ title: `${e.area} is gone`, text: `${names[e.who]} lost the encounter, so nobody on your team can catch there.` });
        } else if (e.team === mineTeam && e.kind === 'illegal') {
          toast(`${e.nick} doesn't count: ${e.area} was already used`, 'alert', 'warn', 5000);
        } else if (e.team !== mineTeam && (e.kind === 'wipe' || e.kind === 'badge')) {
          toast(e.kind === 'wipe' ? `Team ${e.team} wiped and restarted` : `Team ${e.team} earned badge ${e.badges}`, 'info', 'info', 4000);
        }
      }
      clearTimeout(t);
      t = window.setTimeout(() => setAlert(null), 6000);
    };
    return () => { conn.onHappened = undefined; clearTimeout(t); };
  }, [conn]);
  if (!base) return <div class="rr rr-wait"><p>You need {run.game_title} in your library to play this run.</p><button class="rr-btn ghost" onClick={() => nav({ name: 'runs' })}>Back to runs</button></div>;
  if (!game || !team) return <div class="rr rr-wait"><p>Getting your game ready…</p></div>;
  return (
    <>
      <Player key={game.id} game={game} nav={nav} run={conn} />
      <RunPanel conn={conn} run={run} team={team} names={names} />
      {alert && <div class={`rr-alert ${alert.hard ? 'hard' : ''}`} role="alert"><Skull /><div><b>{alert.title}</b><span>{alert.text}</span></div></div>}
    </>
  );
}

function RunPanel({ conn, run, team, names }: { conn: RunConn; run: Run; team: TeamState; names: Record<number, string> }) {
  const [open, setOpen] = useState(true);
  const [watching, setWatching] = useState<number | null>(null);
  const players = run.state!.players;
  const rivals = Object.entries(run.state!.teams).filter(([, t]) => t !== team);
  const watch = (id: number | null) => { setWatching(id); conn.watch(id); };
  return (
    <aside class={`rr rr-panel ${open ? '' : 'shut'}`} aria-label="Your team">
      <button class="rr-panel-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide team' : 'Team'}</button>
      {open && <div class="rr-panel-body">
        <h2>{run.name}</h2>
        <section>
          {team.members.map(id => (
            <div class="rr-mate" key={id}>
              <span><b>{id === conn.me ? 'You' : names[id]}</b><small>{players[id]?.area || 'Starting out'}</small></span>
              <span class="rr-badges" aria-label={`${players[id]?.badges ?? 0} badges`}>{players[id]?.badges ?? 0}</span>
              {id !== conn.me && <button class="rr-icon" aria-label={`Watch ${names[id]}`} aria-pressed={watching === id} onClick={() => watch(watching === id ? null : id)}><Eye /></button>}
            </div>
          ))}
        </section>
        {watching !== null && <div class="rr-watch">{conn.frame?.who === watching ? <img alt={`${names[watching]}'s screen`} src={`data:image/png;base64,${conn.frame.png}`} /> : <p class="rr-empty">Waiting for {names[watching]}’s screen…</p>}</div>}
        <section class="rr-links"><h3>Linked Pokémon</h3><LinkChart team={team} names={names} compact /></section>
        {rivals.map(([t, r]) => {
          const best = Math.max(0, ...r.members.map(id => players[id]?.badges ?? 0));
          return <p class={`rr-rival t${t}`} key={t}><b>Team {t}</b><span>{best} badges, {r.resets} resets</span></p>;
        })}
        <Chat conn={conn} />
      </div>}
    </aside>
  );
}

// ---------- summary ----------
function RunSummary({ id, nav }: { id: string; nav: Nav }) {
  const [data, setData] = useState<{ run: Run; events: RunEvent[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { runsApi.detail(id).then(setData).catch(e => setErr((e as Error).message)); }, [id]);
  if (!data) return <div class="rr rr-wait"><p>{err || 'Loading the run…'}</p><button class="rr-btn ghost" onClick={() => nav({ name: 'runs' })}>Back to runs</button></div>;
  const { run, events } = data;
  const names = Object.fromEntries(run.players.map(p => [p.id, p.name]));
  const teams = Object.entries(run.state?.teams ?? {});
  const start = run.started ?? run.created;
  const deaths = events.filter(e => e.kind === 'death');
  const timeline = events.filter(e => e.kind !== 'caught');
  const count = (team: string, kind: string) => events.filter(e => e.kind === kind && String(e.team) === team).length;
  const badges = (t: TeamState) => Math.max(0, ...t.members.map(m => run.state!.players[m]?.badges ?? 0));
  return (
    <div class="rr">
      <header class="rr-bar">
        <button class="rr-back" onClick={() => nav({ name: 'runs' })} aria-label="Back to runs"><ArrowLeft /></button>
        <span>{MODE_INFO[run.mode].name} in {run.game_title}</span>
      </header>
      <main class="rr-page">
        <section class="rr-result">
          <h1>{run.name}</h1>
          <p class="rr-verdict"><Trophy />{run.winner ? (teams.length > 1 ? `Team ${run.winner} won` : 'Game beaten') : run.status === 'done' ? 'The run ended in a wipe' : 'Still going'}</p>
          <p class="rr-dim">{run.ended ? hms(run.ended - start) : `Started ${when(start)}`}</p>
        </section>
        <div class="rr-teams">
          {teams.map(([t, team]) => (
            <section class={`rr-team t${t}`} key={t}>
              <h2>Team {t}</h2>
              <p class="rr-dim">{team.members.map(m => names[m]).join(', ')}</p>
              <dl class="rr-records">
                <div><dt>Badges</dt><dd>{badges(team)}</dd></div>
                <div><dt>Deaths</dt><dd>{count(t, 'death')}</dd></div>
                <div><dt>Resets</dt><dd>{team.resets}</dd></div>
              </dl>
              <LinkChart team={team} names={names} empty={team.resets ? 'Nothing caught since the last restart.' : 'Nothing caught.'} />
            </section>
          ))}
        </div>
        <div class="rr-split">
          <section class="rr-sec">
            <h2>Timeline</h2>
            <ol class="rr-time">
              {timeline.map(e => (
                <li key={e.id} class={`ev-${e.kind}`}>
                  <time>{hms(e.at - start)}</time>
                  <span>{eventText(e as unknown as { kind: string }, names[e.user_id] ?? '')}{e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}</span>
                </li>
              ))}
            </ol>
          </section>
          <aside class="rr-side">
            <section class="rr-sec">
              <h2>Graveyard</h2>
              {deaths.length === 0 ? <p class="rr-empty">Nobody died. Nicely played.</p> : (
                <ul class="rr-graves">
                  {deaths.map(e => (
                    <li key={e.id}><Skull /><span><b>{(e.data.nick as string)}</b><small>{names[e.user_id]} lost it in {e.data.area as string}, caught in {e.data.caught as string}</small></span></li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
