// Spatial navigation so the whole UI works with a controller (D-pad/stick + A/B) or arrow keys.
const SEL = 'button:not([disabled]), a[href], input:not([type=hidden]), select, textarea, [tabindex="0"]';

let current: HTMLElement | null = null;
let gamepadUI = true; // disabled while a game is running (the Player polls pads itself)

export function setGamepadUI(on: boolean) { gamepadUI = on; }

function scope(): HTMLElement {
  // topmost modal layer wins
  const layers = document.querySelectorAll<HTMLElement>('.scrim, .pause, .player');
  return layers[layers.length - 1] ?? document.body;
}

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.hud.hidden');
}

function mark(el: HTMLElement | null) {
  current?.classList.remove('nav-focus');
  current = el;
  if (!el) return;
  el.classList.add('nav-focus');
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

export function move(dir: 'up' | 'down' | 'left' | 'right') {
  const root = scope();
  const all = [...root.querySelectorAll<HTMLElement>(SEL)].filter(visible);
  if (!all.length) return;
  const from = (document.activeElement && root.contains(document.activeElement) && document.activeElement !== document.body)
    ? document.activeElement as HTMLElement : null;
  if (!from) { mark(all[0]); return; }
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of all) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const dx = bx - ax, dy = by - ay;
    let main: number, cross: number;
    if (dir === 'right') { if (b.left < a.right - 4 && dx <= 4) continue; main = dx; cross = dy; }
    else if (dir === 'left') { if (b.right > a.left + 4 && dx >= -4) continue; main = -dx; cross = dy; }
    else if (dir === 'down') { if (b.top < a.bottom - 4 && dy <= 4) continue; main = dy; cross = dx; }
    else { if (b.bottom > a.top + 4 && dy >= -4) continue; main = -dy; cross = dx; }
    if (main <= 0) continue;
    const score = main + Math.abs(cross) * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) mark(best);
}

function isTyping() {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes((el as HTMLInputElement).type) || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

export function installNav() {
  window.addEventListener('keydown', e => {
    if (!gamepadUI || isTyping() || e.defaultPrevented) return;
    const d = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key as 'ArrowUp'];
    if (d) { e.preventDefault(); move(d); }
  });
  window.addEventListener('pointermove', () => { current?.classList.remove('nav-focus'); }, { passive: true });

  // gamepad polling for menus
  const prev = new Map<number, boolean[]>();
  let repeatAt = 0;
  const tick = (t: number) => {
    requestAnimationFrame(tick);
    if (!gamepadUI) return;
    for (const g of navigator.getGamepads?.() ?? []) {
      if (!g) continue;
      const p = prev.get(g.index) ?? [];
      const pressed = (i: number) => !!g.buttons[i]?.pressed;
      const edge = (i: number) => pressed(i) && !p[i];
      const ax = g.axes[0] ?? 0, ay = g.axes[1] ?? 0;
      const dirs: ['up' | 'down' | 'left' | 'right', boolean][] = [
        ['up', pressed(12) || ay < -0.6], ['down', pressed(13) || ay > 0.6], ['left', pressed(14) || ax < -0.6], ['right', pressed(15) || ax > 0.6],
      ];
      const held = dirs.find(([, on]) => on);
      const wasHeld = p[99];
      if (held && (!wasHeld || t > repeatAt)) { move(held[0]); repeatAt = t + (wasHeld ? 110 : 380); }
      if (edge(0)) (document.activeElement as HTMLElement | null)?.click();
      if (edge(1)) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      const snap = g.buttons.map(b => b.pressed);
      snap[99] = !!held;
      prev.set(g.index, snap);
    }
  };
  requestAnimationFrame(tick);
}
