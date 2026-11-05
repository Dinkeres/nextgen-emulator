import { useMemo, useState } from 'preact/hooks';
import { Clock, Grid2x2, Heart, Link2, List, Play, Plus, Search, Settings as Gear, Sparkles, Star, Upload, Users, UserRound } from 'lucide-preact';
import { account } from '../app/account.ts';
import { library, settings, updateSettings, useStore } from '../app/store.ts';
import { addFiles, pickFiles } from '../app/library.ts';
import { SYSTEMS } from '../engine/systems.ts';
import type { Game } from '../app/db.ts';
import { Cover, SysBadge, fmtAgo, fmtTime, useAutoThumb, useObjectURL } from './common.tsx';
import { GameDetails } from './GameDetails.tsx';
import type { Nav } from './App.tsx';

type Filter = 'all' | 'fav' | 'recent' | string;
type Sort = 'recent' | 'title' | 'added' | 'time';

export function Library({ nav }: { nav: Nav }) {
  const games = useStore(library);
  const s = useStore(settings);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [open, setOpen] = useState<Game | null>(null);

  const systemsPresent = useMemo(() => Object.values(SYSTEMS).filter(sy => games.some(g => g.system === sy.id)), [games]);
  const recent = useMemo(() => games.filter(g => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 8), [games]);

  const shown = useMemo(() => {
    let l = games;
    if (filter === 'fav') l = l.filter(g => g.favorite);
    else if (filter === 'recent') l = l.filter(g => g.lastPlayed);
    else if (filter !== 'all') l = l.filter(g => g.system === filter);
    if (q.trim()) { const k = q.trim().toLowerCase(); l = l.filter(g => g.title.toLowerCase().includes(k) || SYSTEMS[g.system]?.short.toLowerCase() === k); }
    const by: Record<Sort, (a: Game, b: Game) => number> = {
      recent: (a, b) => (b.lastPlayed - a.lastPlayed) || (b.addedAt - a.addedAt),
      title: (a, b) => a.title.localeCompare(b.title),
      added: (a, b) => b.addedAt - a.addedAt,
      time: (a, b) => b.playTime - a.playTime,
    };
    return [...l].sort(by[sort]);
  }, [games, filter, q, sort]);

  const add = async () => { const f = await pickFiles(); if (f.length) await addFiles(f); };
  const play = (g: Game) => nav({ name: 'play', game: g });

  return (
    <>
      <header class="topbar">
        <div class="brand"><img src="./icon.svg" alt="" /><span>Kai<b>ser</b></span></div>
        <label class="search">
          <Search />
          <input class="input" type="search" placeholder="Search your games" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} aria-label="Search games" />
        </label>
        <div class="actions">
          <button class="btn primary" onClick={add}><Plus /><span class="hide-sm">Add games</span></button>
          <button class="btn" onClick={() => nav({ name: 'runs' })}><Link2 /><span class="hide-sm">Soul Link</span></button>
          <button class="btn icon" onClick={() => nav({ name: 'lobby' })} aria-label="Multiplayer"><Users /></button>
          <AccountButton nav={nav} />
          <button class="btn icon" onClick={() => nav({ name: 'settings' })} aria-label="Settings"><Gear /></button>
        </div>
      </header>
      <main class="page">
        {recent.length > 0 && !q && filter === 'all' && (
          <section>
            <div class="section-title" style={{ marginTop: '4px' }}><h2>Continue playing</h2></div>
            <div class="continue">
              {recent.map(g => <ContinueCard key={g.id} game={g} onPlay={() => play(g)} />)}
            </div>
          </section>
        )}

        <div class="section-title">
          <h2>Library <span class="muted">{games.length ? `· ${games.length} game${games.length === 1 ? '' : 's'}` : ''}</span></h2>
        </div>
        <div class="filters" role="toolbar" aria-label="Filters">
          <button class={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}><Sparkles />All</button>
          <button class={`chip ${filter === 'fav' ? 'on' : ''}`} onClick={() => setFilter('fav')}><Heart />Favorites</button>
          <button class={`chip ${filter === 'recent' ? 'on' : ''}`} onClick={() => setFilter('recent')}><Clock />Recently played</button>
          {systemsPresent.map(sy => (
            <button key={sy.id} class={`chip ${filter === sy.id ? 'on' : ''}`} onClick={() => setFilter(sy.id)}>
              <span class="dot" style={{ background: sy.color }} />{sy.short}
            </button>
          ))}
          <span class="spacer" />
          <select class="input" value={sort} onChange={e => setSort((e.target as HTMLSelectElement).value as Sort)} aria-label="Sort by">
            <option value="recent">Last played</option>
            <option value="title">Title A–Z</option>
            <option value="added">Recently added</option>
            <option value="time">Most played</option>
          </select>
          <div class="seg" role="group" aria-label="View">
            <button class={s.libraryView === 'grid' ? 'on' : ''} onClick={() => updateSettings(x => ({ ...x, libraryView: 'grid' }))} aria-label="Grid view"><Grid2x2 /></button>
            <button class={s.libraryView === 'list' ? 'on' : ''} onClick={() => updateSettings(x => ({ ...x, libraryView: 'list' }))} aria-label="List view"><List /></button>
          </div>
        </div>

        {games.length === 0 ? (
          <button class="empty" onClick={add}>
            <div class="ring"><Upload /></div>
            <h3>Drop a ROM here or click to add one</h3>
            <p>Your games stay on this device. Supported: NES, SNES, Game Boy, Game Boy Color, Game Boy Advance and Genesis / Mega Drive — zipped ROMs work too.</p>
          </button>
        ) : shown.length === 0 ? (
          <div class="empty" style={{ cursor: 'default' }}><h3>No matches</h3><p>Try a different search or filter.</p></div>
        ) : s.libraryView === 'grid' ? (
          <div class="grid">
            {shown.map(g => (
              <button key={g.id} class="tile" style={{ '--sys': SYSTEMS[g.system]?.color }} onClick={() => setOpen(g)} aria-label={`${g.title}, ${SYSTEMS[g.system]?.name}`}>
                <div class="cover">
                  <Cover game={g} />
                  {g.favorite && <span class="fav"><Star /></span>}
                </div>
                <div class="title">{g.title}</div>
                <div class="sub"><SysBadge system={g.system} />{g.lastPlayed ? fmtAgo(g.lastPlayed) : 'New'}</div>
              </button>
            ))}
            <button class="tile" onClick={add} aria-label="Add games">
              <div class="cover" style={{ display: 'grid', placeItems: 'center', border: '2px dashed var(--line-2)', background: 'transparent', boxShadow: 'none' }}>
                <Plus style={{ width: '34px', height: '34px', color: 'var(--text-3)' }} />
              </div>
              <div class="title" style={{ color: 'var(--text-3)' }}>Add games</div>
            </button>
          </div>
        ) : (
          <div class="list">
            {shown.map(g => (
              <button key={g.id} class="row" onClick={() => setOpen(g)}>
                <div class="mini"><Cover game={g} small /></div>
                <div><h4>{g.title}</h4><small>{SYSTEMS[g.system]?.name} · {fmtTime(g.playTime)}</small></div>
                <span class="when">{fmtAgo(g.lastPlayed)}</span>
                <SysBadge system={g.system} />
              </button>
            ))}
          </div>
        )}
        <p class="footer">
          Kaiser is free software (GPL-3.0), built on the work of <a href="https://emulatorjs.org" target="_blank" rel="noopener">EmulatorJS</a> and libretro core authors.
          {' '}<a href="#" onClick={e => { e.preventDefault(); nav({ name: 'settings', section: 'about' }); }}>Credits & licenses</a>
        </p>
      </main>
      {open && <GameDetails game={games.find(g => g.id === open.id) ?? open} onClose={() => setOpen(null)} nav={nav} />}
    </>
  );
}

function ContinueCard({ game, onPlay }: { game: Game; onPlay: () => void }) {
  const thumb = useObjectURL(useAutoThumb(game.id, game.lastPlayed));
  return (
    <button class="cont-card" onClick={onPlay} aria-label={`Continue ${game.title}`} style={{ '--sys': SYSTEMS[game.system]?.color }}>
      {thumb ? <img src={thumb} alt="" /> : <Cover game={game} small />}
      <div class="shade" />
      <div class="meta">
        <div>
          <SysBadge system={game.system} />
          <h3>{game.title}</h3>
          <small>{fmtAgo(game.lastPlayed)} · {fmtTime(game.playTime)}</small>
        </div>
        <span class="play"><Play fill="currentColor" /></span>
      </div>
    </button>
  );
}

function AccountButton({ nav }: { nav: Nav }) {
  const a = useStore(account);
  return a
    ? <button class="btn" onClick={() => nav({ name: 'settings', section: 'account' })} aria-label={`Account: ${a.username}`}><UserRound /><span class="hide-sm">{a.username}</span></button>
    : <button class="btn" onClick={() => nav({ name: 'settings', section: 'account' })}><UserRound /><span class="hide-sm">Sign in</span></button>;
}
