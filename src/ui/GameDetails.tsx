import { useEffect, useState } from 'preact/hooks';
import { Download, Heart, ImagePlus, Pencil, Play, RotateCcw, Save, Trash2, Users, X } from 'lucide-preact';
import { db, exportBackup, type Game, type SaveState, type Shot } from '../app/db.ts';
import { refreshLibrary, settings, toast, useStore } from '../app/store.ts';
import { HOMEBREW } from '../app/library.ts';
import { SYSTEMS } from '../engine/systems.ts';
import { Confirm, Cover, Modal, SysBadge, download, fmtAgo, fmtBytes, fmtTime, useObjectURL } from './common.tsx';
import { GameOverrides } from './Settings.tsx';
import { Cheats } from './Cheats.tsx';
import type { Nav } from './App.tsx';

export function GameDetails({ game, onClose, nav }: { game: Game; onClose: () => void; nav: Nav }) {
  const [tab, setTab] = useState<'saves' | 'shots' | 'settings' | 'cheats' | 'manage'>('saves');
  const [states, setStates] = useState<SaveState[]>([]);
  const [shots, setShots] = useState<Shot[]>([]);
  const [confirm, setConfirm] = useState<null | { title: string; text: string; yes: () => void }>(null);
  const [renaming, setRenaming] = useState(false);
  useStore(settings);
  const sys = SYSTEMS[game.system];
  const hb = game.bundled ? HOMEBREW.find(h => h.file === game.fileName) : undefined;

  const reload = () => { db.states(game.id).then(l => setStates(l.sort((a, b) => a.slot - b.slot))); db.shots(game.id).then(l => setShots(l.reverse())); };
  useEffect(reload, [game.id]);

  const update = async (p: Partial<Game>) => { await db.updateGame(game.id, p); await refreshLibrary(); };
  const play = (o: { slot?: number; fresh?: boolean } = {}) => { onClose(); nav({ name: 'play', game, ...o }); };
  const hasAuto = states.some(s => s.slot === 0);

  return (
    <Modal onClose={onClose} title="">
      <div class="details" style={{ '--sys': sys?.color }}>
        <div>
          <div class="cover-lg"><Cover game={game} /></div>
        </div>
        <div style={{ minWidth: '0px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <SysBadge system={game.system} />
            <span style={{ color: 'var(--text-3)', fontSize: '13px' }}>{sys?.name}</span>
            <button class="btn icon ghost" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close"><X /></button>
          </div>
          {renaming ? (
            <form onSubmit={e => { e.preventDefault(); const v = (e.currentTarget.elements.namedItem('t') as HTMLInputElement).value.trim(); if (v) update({ title: v }); setRenaming(false); }} style={{ display: 'flex', gap: '8px', margin: '10px 0' }}>
              <input class="input" name="t" defaultValue={game.title} style={{ flex: 1, fontSize: '18px' }} data-autofocus />
              <button class="btn primary">Save</button>
            </form>
          ) : <h1>{game.title}</h1>}
          {hb && <p class="blurb">{hb.blurb} <br /><small style={{ color: 'var(--text-3)' }}>By {hb.author} · {hb.license} · <a href={hb.url} target="_blank" rel="noopener">source</a></small></p>}
          <div class="facts">
            <div><b>{fmtTime(game.playTime)}</b>Play time</div>
            <div><b>{fmtAgo(game.lastPlayed)}</b>Last played</div>
            <div><b>{states.filter(s => s.slot > 0).length}</b>Save states</div>
            <div><b>{fmtBytes(game.size)}</b>ROM size</div>
          </div>
          <div class="cta">
            <button class="btn primary big" onClick={() => play()} data-autofocus><Play fill="currentColor" />{hasAuto && settings.value.saves.resume ? 'Continue' : 'Play'}</button>
            {hasAuto && <button class="btn big" onClick={() => play({ fresh: true })}><RotateCcw />Start over</button>}
            {sys.maxPlayers > 1 && <button class="btn big" onClick={() => { onClose(); nav({ name: 'lobby', game }); }}><Users />Multiplayer</button>}
            <button class={`btn big icon ${game.favorite ? 'on' : ''}`} onClick={() => update({ favorite: !game.favorite })} aria-label={game.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={game.favorite}>
              <Heart fill={game.favorite ? '#f43f5e' : 'none'} color={game.favorite ? '#f43f5e' : 'currentColor'} />
            </button>
          </div>

          <div class="tabs" role="tablist">
            {(['saves', 'shots', 'settings', 'cheats', 'manage'] as const).map(t => (
              <button key={t} role="tab" aria-selected={tab === t} class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {{ saves: 'Save states', shots: `Screenshots${shots.length ? ` (${shots.length})` : ''}`, settings: 'Game settings', cheats: `Cheats${game.cheats?.length ? ` (${game.cheats.length})` : ''}`, manage: 'Manage' }[t]}
              </button>
            ))}
          </div>

          {tab === 'saves' && (
            states.length === 0 ? <p style={{ color: 'var(--text-3)' }}>No saves yet. Your progress is auto-saved while you play, and you can save to 10 slots from the pause menu.</p> :
            <div class="slots">
              {states.map(s => <SlotCard key={s.id} s={s} onClick={() => play({ slot: s.slot })} onDelete={() => setConfirm({ title: 'Delete this save?', text: `${s.slot === 0 ? 'The auto-save' : `Slot ${s.slot}`} will be removed permanently.`, yes: async () => { await db.deleteState(game.id, s.slot); reload(); } })} />)}
            </div>
          )}

          {tab === 'shots' && (
            shots.length === 0 ? <p style={{ color: 'var(--text-3)' }}>Screenshots you take in-game show up here.</p> :
            <div class="gallery">{shots.map(sh => <ShotCard key={sh.id} shot={sh} name={game.title} onDelete={async () => { await db.deleteShot(sh.id!); reload(); }} />)}</div>
          )}

          {tab === 'settings' && <GameOverrides game={game} />}
          {tab === 'cheats' && <Cheats game={game} />}

          {tab === 'manage' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
              <button class="btn" onClick={() => setRenaming(true)}><Pencil />Rename</button>
              <label class="btn"><ImagePlus />{game.cover ? 'Change cover art' : 'Add cover art'}
                <input type="file" accept="image/*" hidden onChange={async e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { await update({ cover: f }); toast('Cover updated', 'image', 'success'); } }} />
              </label>
              {game.cover && <button class="btn ghost" onClick={() => update({ cover: undefined })}>Remove cover art</button>}
              <button class="btn" onClick={async () => download(await exportBackup(game.id), `${game.title} saves.kaiser`)}><Download />Export this game's saves</button>
              <button class="btn danger" onClick={() => setConfirm({ title: 'Delete all saves?', text: `All save states, battery saves and screenshots for ${game.title} will be deleted. This can't be undone.`, yes: async () => { await db.clearGame(game.id, true); reload(); toast('Saves deleted', 'trash', 'success'); } })}><Save />Delete saves only</button>
              <button class="btn danger" onClick={() => setConfirm({ title: `Remove ${game.title}?`, text: game.bundled ? 'Its saves will be deleted. Bundled games come back on next launch.' : 'The game and all of its saves will be removed from this browser.', yes: async () => { await db.clearGame(game.id); if (game.bundled) { const k = (await db.kv<string[]>('homebrew-added')) ?? []; await db.putKv('homebrew-added', k.filter(f => f !== game.fileName)); } await refreshLibrary(); onClose(); } })}><Trash2 />Remove from library</button>
            </div>
          )}
        </div>
      </div>
      {confirm && <Confirm title={confirm.title} text={confirm.text} onNo={() => setConfirm(null)} onYes={() => { confirm.yes(); setConfirm(null); }} />}
    </Modal>
  );
}

export function SlotCard({ s, onClick, onDelete, label }: { s?: SaveState; onClick: () => void; onDelete?: () => void; label?: string }) {
  const url = useObjectURL(s?.thumb);
  return (
    <div class="slot">
      <button onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left' }}>
        <div class="shot">{url ? <img src={url} alt="" /> : <Save />}</div>
        <div class="info">
          <b>{label ?? (s?.slot === 0 ? 'Auto-save' : `Slot ${s?.slot}`)}</b>
          {s ? <>{fmtAgo(s.createdAt)} · {fmtTime(s.playTime)}</> : 'Empty'}
        </div>
      </button>
      {s && onDelete && <button class="del" onClick={onDelete} aria-label="Delete save"><Trash2 /></button>}
    </div>
  );
}

function ShotCard({ shot, name, onDelete }: { shot: Shot; name: string; onDelete: () => void }) {
  const url = useObjectURL(shot.blob);
  return (
    <figure>
      {url && <img src={url} alt={`Screenshot from ${name}`} loading="lazy" />}
      <div class="acts">
        <button onClick={() => download(shot.blob, `${name} ${new Date(shot.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`)} aria-label="Download"><Download /></button>
        <button onClick={onDelete} aria-label="Delete"><Trash2 /></button>
      </div>
    </figure>
  );
}
