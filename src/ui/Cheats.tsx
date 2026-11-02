import { useState } from 'preact/hooks';
import { Plus, Trash2 } from 'lucide-preact';
import { db, type Cheat, type Game } from '../app/db.ts';
import { refreshLibrary } from '../app/store.ts';
import { Toggle } from './common.tsx';

/** Per-game cheat list. Codes are parsed by the core (Game Genie, Pro Action Replay, GameShark, …). */
export function Cheats({ game, onApply, dark }: { game: Game; onApply?: (codes: string[]) => void; dark?: boolean }) {
  const [list, setList] = useState<Cheat[]>(game.cheats ?? []);
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const save = async (l: Cheat[]) => {
    setList(l);
    game.cheats = l;
    await db.updateGame(game.id, { cheats: l });
    onApply?.(l.filter(c => c.on).map(c => c.code));
    refreshLibrary();
  };
  const add = (e: Event) => {
    e.preventDefault();
    const c = code.trim().toUpperCase().replace(/\s+/g, '+');
    if (!c) return;
    save([...list, { code: c, desc: desc.trim() || c, on: true }]);
    setCode(''); setDesc('');
  };
  const muted = dark ? 'rgba(255,255,255,.6)' : 'var(--text-3)';
  return (
    <div>
      <p style={{ color: muted, marginTop: '0px' }}>Enter codes in the formats your console's cheat devices used (Game Genie, Pro Action Replay, GameShark…). Join multi-part codes with +.</p>
      <form onSubmit={add} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input class="input" style={{ flex: '1 1 160px', fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }} placeholder="Code, e.g. SXIOPO" value={code} onInput={e => setCode((e.target as HTMLInputElement).value)} aria-label="Cheat code" />
        <input class="input" style={{ flex: '2 1 200px' }} placeholder="Description (optional)" value={desc} onInput={e => setDesc((e.target as HTMLInputElement).value)} aria-label="Cheat description" />
        <button class="btn" disabled={!code.trim()}><Plus />Add</button>
      </form>
      {list.length === 0 ? <p style={{ color: muted }}>No cheats yet.</p> : list.map((c, i) => (
        <div class="setting" key={i} style={{ padding: '10px 0' }}>
          <div class="lbl"><b>{c.desc}</b><small style={{ fontFamily: 'ui-monospace, monospace' }}>{c.code}</small></div>
          <div class="ctl">
            <Toggle on={c.on} onChange={v => save(list.map((x, j) => j === i ? { ...x, on: v } : x))} label={`Enable ${c.desc}`} />
            <button class="btn icon ghost" onClick={() => save(list.filter((_, j) => j !== i))} aria-label={`Delete ${c.desc}`}><Trash2 /></button>
          </div>
        </div>
      ))}
    </div>
  );
}
