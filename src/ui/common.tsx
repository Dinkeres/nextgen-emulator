import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Gamepad, Gamepad2, Joystick, Smartphone, X } from 'lucide-preact';
import { SYSTEMS } from '../engine/systems';
import type { Game } from '../app/db';
import { db } from '../app/db';

export const SYS_ICON: Record<string, typeof Gamepad> = {
  nes: Gamepad, snes: Gamepad2, genesis: Joystick, gb: Smartphone, gbc: Smartphone, gba: Smartphone,
};

export function useObjectURL(b?: Blob | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!b) { setUrl(undefined); return; }
    const u = URL.createObjectURL(b);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [b]);
  return url;
}

/** Last auto-save screenshot for a game (for "Continue playing"). */
export function useAutoThumb(gameId: string, version = 0): Blob | null {
  const [b, setB] = useState<Blob | null>(null);
  useEffect(() => { db.state(gameId, 0).then(s => setB(s?.thumb ?? null)).catch(() => {}); }, [gameId, version]);
  return b;
}

export function Cover({ game, small }: { game: Game; small?: boolean }) {
  const url = useObjectURL(game.cover);
  const sys = SYSTEMS[game.system];
  const Icon = SYS_ICON[game.system] ?? Gamepad;
  if (url) return <img src={url} alt="" loading="lazy" />;
  return (
    <div class="ph" style={{ '--sys': sys?.color }} aria-hidden="true">
      <Icon class="ph-icon" strokeWidth={1.6} />
      {!small && <div class="ph-title">{game.title}</div>}
      <div class="ph-sys">{sys?.short}</div>
    </div>
  );
}

export function SysBadge({ system }: { system: string }) {
  const s = SYSTEMS[system];
  return <span class="badge" style={{ '--sys': s?.color }}>{s?.short ?? system}</span>;
}

export function Modal({ onClose, children, title, wide = true, class: cls = '' }: { onClose: () => void; children: ComponentChildren; title?: string; wide?: boolean; class?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    // focus first control for keyboard/controller users
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[data-autofocus], button.primary, button')?.focus({ preventScroll: true }));
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.({ preventScroll: true }); };
  }, []);
  return (
    <div class="scrim" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`sheet ${cls}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} style={wide ? undefined : { width: 'min(460px, 100%)' }}>
        {title && (
          <div class="sheet-head">
            <h2>{title}</h2>
            <button class="btn icon ghost" onClick={onClose} aria-label="Close"><X /></button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Confirm({ title, text, confirm = 'Delete', onYes, onNo }: { title: string; text: string; confirm?: string; onYes: () => void; onNo: () => void }) {
  return (
    <Modal onClose={onNo} wide={false}>
      <div class="confirm">
        <h3>{title}</h3>
        <p>{text}</p>
        <div class="row-btns">
          <button class="btn ghost" onClick={onNo} data-autofocus>Cancel</button>
          <button class="btn primary" style={{ background: 'var(--bad)', boxShadow: 'none' }} onClick={onYes}>{confirm}</button>
        </div>
      </div>
    </Modal>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button class={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export function fmtTime(secs: number) {
  if (secs < 60) return secs < 1 ? 'Never played' : '< 1 min';
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function fmtAgo(ts: number) {
  if (!ts) return 'Never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
