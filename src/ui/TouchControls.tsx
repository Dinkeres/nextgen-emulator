import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FastForward, Menu, Rewind } from 'lucide-preact';
import { BTN, type ButtonName, type SystemInfo, buttonLabel } from '../engine/systems.ts';
import type { Input } from '../engine/input.ts';
import { settings, updateSettings, useStore } from '../app/store.ts';

/** Positions are fractions of the screen; size is a fraction of the short screen side. */
export interface TItem { id: string; kind: 'dpad' | 'btn' | 'pill' | 'shoulder' | 'action'; b?: ButtonName; x: number; y: number; s: number; label?: string }

const face = (sys: SystemInfo): TItem[] => {
  const btn = (b: ButtonName, x: number, y: number, s = 0.16): TItem => ({ id: b, kind: 'btn', b, x, y, s, label: buttonLabel(sys, b) });
  switch (sys.id) {
    case 'snes': return [btn('X', 0.86, 0.48), btn('A', 0.93, 0.63), btn('B', 0.86, 0.78), btn('Y', 0.79, 0.63)];
    case 'genesis': return [btn('Y', 0.72, 0.74, 0.15), btn('B', 0.82, 0.70, 0.15), btn('A', 0.92, 0.66, 0.15),
      btn('L', 0.74, 0.52, 0.11), btn('X', 0.83, 0.48, 0.11), btn('R', 0.92, 0.44, 0.11)];
    default: return [btn('B', 0.80, 0.72, 0.17), btn('A', 0.92, 0.62, 0.17)];
  }
};

export function defaultLayout(sys: SystemInfo): TItem[] {
  const l: TItem[] = [
    { id: 'dpad', kind: 'dpad', x: 0.14, y: 0.66, s: 0.42 },
    ...face(sys),
    { id: 'SELECT', kind: 'pill', b: 'SELECT', x: 0.42, y: 0.92, s: 0.07, label: buttonLabel(sys, 'SELECT') },
    { id: 'START', kind: 'pill', b: 'START', x: 0.58, y: 0.92, s: 0.07, label: 'Start' },
    { id: 'menu', kind: 'action', x: 0.5, y: 0.07, s: 0.085 },
    { id: 'rewind', kind: 'action', x: 0.06, y: 0.08, s: 0.085 },
    { id: 'ff', kind: 'action', x: 0.94, y: 0.08, s: 0.085 },
  ];
  if (sys.buttons.includes('L') && sys.id !== 'genesis') {
    l.push({ id: 'L', kind: 'shoulder', b: 'L', x: 0.08, y: 0.26, s: 0.1, label: 'L' }, { id: 'R', kind: 'shoulder', b: 'R', x: 0.92, y: 0.26, s: 0.1, label: 'R' });
  }
  if (sys.id === 'genesis' && !sys.buttons.includes('SELECT')) return l.filter(i => i.id !== 'SELECT');
  return l;
}

const DIRS = [BTN.RIGHT, BTN.DOWN, BTN.LEFT, BTN.UP];

export function TouchControls({ system, input, editing, onDone, onMenu, onFf, onRewind }: {
  system: SystemInfo; input: Input; editing: boolean; onDone: () => void; onMenu: () => void; onFf: (on: boolean) => void; onRewind: (on: boolean) => void;
}) {
  const s = useStore(settings);
  const key = system.id;
  const saved = (s.controls as { layouts?: Record<string, TItem[]> }).layouts?.[key];
  const [items, setItems] = useState<TItem[]>(saved ?? defaultLayout(system));
  const [sel, setSel] = useState<string | null>(null);
  const [vw, setVw] = useState({ w: innerWidth, h: innerHeight });
  const rootRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, string>()); // pointer -> item id
  const [pressed, setPressed] = useState<Record<string, number>>({});
  const opacity = s.controls.touchOpacity;

  useEffect(() => { const r = () => setVw({ w: innerWidth, h: innerHeight }); addEventListener('resize', r); return () => removeEventListener('resize', r); }, []);
  const short = Math.min(vw.w, vw.h);
  // portrait: controls sit in the lower half under the game
  const portrait = vw.h > vw.w;
  // sizes scale with the screen but stop growing on tablets (thumbs don't get bigger)
  const unit = Math.min(short, 430);
  const pos = (it: TItem) => {
    let y = it.y;
    if (portrait && it.kind !== 'action') y = 0.55 + it.y * 0.45;
    const size = it.s * unit;
    const half = (it.kind === 'pill' ? size * 1.2 : it.kind === 'shoulder' ? size * 0.9 : size / 2) + 6;
    // keep every control fully on screen whatever the aspect ratio
    const left = Math.min(vw.w - half, Math.max(half, it.x * vw.w));
    const top = Math.min(vw.h - size / 2 - 6, Math.max(size / 2 + 6, y * vw.h));
    return { left, top, size };
  };

  // ---------- hit testing ----------
  const hit = (x: number, y: number): { id: string; mask: number } | null => {
    for (const it of items) {
      const p = pos(it);
      const dx = x - p.left, dy = y - p.top;
      if (it.kind === 'dpad') {
        const r = p.size / 2;
        const d = Math.hypot(dx, dy);
        if (d > r * 1.25) continue;
        if (d < r * 0.18) return { id: it.id, mask: 0 };
        const a = Math.atan2(dy, dx); // 8-way: each direction covers 135° so diagonals press two
        let m = 0;
        DIRS.forEach((bit, i) => {
          const center = i * Math.PI / 2;
          let diff = Math.abs(a - center); if (diff > Math.PI) diff = 2 * Math.PI - diff;
          if (diff < Math.PI * 0.375) m |= 1 << bit;
        });
        return { id: it.id, mask: m };
      }
      const w = it.kind === 'pill' ? p.size * 2.4 : it.kind === 'shoulder' ? p.size * 1.8 : p.size;
      const h = p.size;
      const pad = it.kind === 'btn' ? 1.12 : 1.05;
      if (Math.abs(dx) <= w / 2 * pad && Math.abs(dy) <= h / 2 * pad) return { id: it.id, mask: it.b ? 1 << BTN[it.b] : 0 };
    }
    return null;
  };

  const recompute = (masks: Map<number, { id: string; mask: number }>) => {
    let m = 0;
    const pr: Record<string, number> = {};
    for (const v of masks.values()) { m |= v.mask; pr[v.id] = v.mask || 1; }
    input.latched |= m & ~input.touch; // keep very short taps
    input.touch = m;
    setPressed(pr);
  };
  const state = useRef(new Map<number, { id: string; mask: number }>());

  const actions: Record<string, (on: boolean) => void> = { menu: on => on && onMenu(), ff: onFf, rewind: onRewind };

  const onDown = (e: PointerEvent) => {
    if (editing) return startDrag(e);
    const h = hit(e.clientX, e.clientY);
    if (!h) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (actions[h.id]) { actions[h.id](true); pointers.current.set(e.pointerId, h.id); setPressed(p => ({ ...p, [h.id]: 1 })); return; }
    state.current.set(e.pointerId, h);
    if (s.controls.haptics) navigator.vibrate?.(8);
    recompute(state.current);
  };
  const onMove = (e: PointerEvent) => {
    if (editing) return moveDrag(e);
    if (!state.current.has(e.pointerId)) return;
    const prev = state.current.get(e.pointerId)!;
    const h = hit(e.clientX, e.clientY);
    // slide between buttons (but keep the d-pad captured once touched)
    const next = prev.id === 'dpad' ? (hitDpad(e.clientX, e.clientY) ?? prev) : h && !actions[h.id] ? h : { id: prev.id, mask: 0 };
    if (next.id !== prev.id || next.mask !== prev.mask) {
      if (next.mask && next.mask !== prev.mask && s.controls.haptics) navigator.vibrate?.(5);
      state.current.set(e.pointerId, next);
      recompute(state.current);
    }
  };
  const hitDpad = (x: number, y: number) => {
    const d = items.find(i => i.kind === 'dpad'); if (!d) return null;
    const p = pos(d);
    const dx = x - p.left, dy = y - p.top;
    if (Math.hypot(dx, dy) < p.size * 0.09) return { id: 'dpad', mask: 0 };
    const a = Math.atan2(dy, dx); let m = 0;
    DIRS.forEach((bit, i) => { let diff = Math.abs(a - i * Math.PI / 2); if (diff > Math.PI) diff = 2 * Math.PI - diff; if (diff < Math.PI * 0.375) m |= 1 << bit; });
    return { id: 'dpad', mask: m };
  };
  const onUp = (e: PointerEvent) => {
    if (editing) { drag.current = null; return; }
    const a = pointers.current.get(e.pointerId);
    if (a) { actions[a]?.(false); pointers.current.delete(e.pointerId); setPressed(p => { const n = { ...p }; delete n[a]; return n; }); return; }
    state.current.delete(e.pointerId);
    recompute(state.current);
  };
  useEffect(() => () => { input.touch = 0; }, []);

  // ---------- layout editor ----------
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const startDrag = (e: PointerEvent) => {
    let best: TItem | null = null, bd = Infinity;
    for (const it of items) { const p = pos(it); const d = Math.hypot(e.clientX - p.left, e.clientY - p.top); if (d < bd && d < p.size) { bd = d; best = it; } }
    if (!best) { setSel(null); return; }
    const p = pos(best);
    drag.current = { id: best.id, dx: e.clientX - p.left, dy: e.clientY - p.top };
    setSel(best.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const x = Math.min(0.98, Math.max(0.02, (e.clientX - d.dx) / vw.w));
    let y = Math.min(0.98, Math.max(0.02, (e.clientY - d.dy) / vw.h));
    const it = items.find(i => i.id === d.id)!;
    if (portrait && it.kind !== 'action') y = Math.min(1, Math.max(0, (y - 0.55) / 0.45));
    setItems(l => l.map(i => i.id === d.id ? { ...i, x, y } : i));
  };
  const resize = (k: number) => sel && setItems(l => l.map(i => i.id === sel ? { ...i, s: Math.min(0.6, Math.max(0.05, i.s * k)) } : i));
  const save = () => {
    updateSettings(x => ({ ...x, controls: { ...x.controls, layouts: { ...((x.controls as { layouts?: Record<string, TItem[]> }).layouts ?? {}), [key]: items } } }));
    onDone();
  };
  const reset = () => setItems(defaultLayout(system));

  const icon = (id: string) => id === 'menu' ? <Menu /> : id === 'ff' ? <FastForward /> : <Rewind />;

  return (
    <>
      <div ref={rootRef} class={`touch ${editing ? 'editing' : ''}`} style={{ pointerEvents: 'auto', opacity: editing ? 1 : opacity }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={e => e.preventDefault()}>
        {items.map(it => {
          const p = pos(it);
          const isSel = editing && sel === it.id;
          if (it.kind === 'dpad') {
            const m = pressed.dpad ?? 0;
            const on = (b: number) => (state.current.get([...state.current.keys()].find(k => state.current.get(k)!.id === 'dpad') ?? -1)?.mask ?? 0) & (1 << b);
            void m;
            return (
              <div key={it.id} class="dpad" style={{ left: `${p.left}px`, top: `${p.top}px`, width: `${p.size}px`, height: `${p.size}px`, pointerEvents: 'none', outlineColor: isSel ? '#fff' : undefined }}>
                <div class={`arm h ${on(BTN.LEFT) || on(BTN.RIGHT) ? '' : ''}`} />
                <div class="arm v" />
                <div class={`arm ${on(BTN.UP) ? 'on' : ''}`} style={{ left: '33.3%', top: '0px', width: '33.4%', height: '34%', borderRadius: '14px 14px 4px 4px' }}><ChevronUp /></div>
                <div class={`arm ${on(BTN.DOWN) ? 'on' : ''}`} style={{ left: '33.3%', bottom: '0px', width: '33.4%', height: '34%', borderRadius: '4px 4px 14px 14px' }}><ChevronDown /></div>
                <div class={`arm ${on(BTN.LEFT) ? 'on' : ''}`} style={{ top: '33.3%', left: '0px', height: '33.4%', width: '34%', borderRadius: '14px 4px 4px 14px' }}><ChevronLeft /></div>
                <div class={`arm ${on(BTN.RIGHT) ? 'on' : ''}`} style={{ top: '33.3%', right: '0px', height: '33.4%', width: '34%', borderRadius: '4px 14px 14px 4px' }}><ChevronRight /></div>
              </div>
            );
          }
          const w = it.kind === 'pill' ? p.size * 2.4 : it.kind === 'shoulder' ? p.size * 1.8 : p.size;
          return (
            <div key={it.id} class={`tbtn ${it.kind === 'pill' ? 'pill' : ''} ${it.kind === 'shoulder' ? 'shoulder' : ''} ${it.kind === 'action' ? 'sm' : ''} ${pressed[it.id] ? 'down' : ''}`}
              style={{ left: `${p.left}px`, top: `${p.top}px`, width: `${w}px`, height: `${p.size}px`, fontSize: `${Math.max(11, p.size * (it.kind === 'btn' ? 0.36 : 0.3))}px`, pointerEvents: 'none', outlineColor: isSel ? '#fff' : undefined }}
              aria-hidden="true">
              {it.kind === 'action' ? icon(it.id) : it.label}
            </div>
          );
        })}
      </div>
      {editing && (
        <div class="editbar">
          <button class="btn" onClick={() => resize(0.88)} disabled={!sel} aria-label="Smaller">−</button>
          <button class="btn" onClick={() => resize(1.12)} disabled={!sel} aria-label="Bigger">+</button>
          <label>Opacity <input type="range" class="range" style={{ width: '100px' }} min="0.15" max="1" step="0.05" value={opacity}
            onInput={e => updateSettings(x => ({ ...x, controls: { ...x.controls, touchOpacity: +(e.target as HTMLInputElement).value } }))} /></label>
          <button class="btn" onClick={reset}>Reset</button>
          <button class="btn primary" onClick={save}>Save layout</button>
        </div>
      )}
    </>
  );
}
