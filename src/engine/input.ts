// Keyboard + Gamepad + touch input -> per-port libretro joypad bitmasks.
import { BTN, type ButtonName } from './systems';

export type KeyBindings = Partial<Record<ButtonName, string[]>>;   // KeyboardEvent.code
export type PadBindings = Partial<Record<ButtonName, number[]>>;   // standard-mapping button index

export const DEFAULT_KEYS: KeyBindings = {
  UP: ['ArrowUp'], DOWN: ['ArrowDown'], LEFT: ['ArrowLeft'], RIGHT: ['ArrowRight'],
  B: ['KeyZ'], A: ['KeyX'], Y: ['KeyA'], X: ['KeyS'], L: ['KeyQ'], R: ['KeyW'],
  L2: ['Digit1'], R2: ['Digit2'], START: ['Enter'], SELECT: ['ShiftRight', 'Space'],
};

// Positional: bottom face = libretro B, right = A, left = Y, top = X (matches SNES layout,
// and is right for Xbox, PlayStation and Switch Pro pads under the W3C standard mapping).
export const DEFAULT_PAD: PadBindings = {
  B: [0], A: [1], Y: [2], X: [3], L: [4], R: [5], L2: [6], R2: [7],
  SELECT: [8], START: [9], L3: [10], R3: [11], UP: [12], DOWN: [13], LEFT: [14], RIGHT: [15],
};

export type Hotkey = 'menu' | 'ff' | 'rewind' | 'save' | 'load' | 'ffToggle' | 'slowmo' | 'screenshot' | 'fullscreen';
export const DEFAULT_HOTKEYS: Record<Hotkey, string> = {
  menu: 'Escape', ff: 'Tab', rewind: 'Backquote', save: 'F5', load: 'F8', ffToggle: 'KeyF',
  slowmo: 'KeyG', screenshot: 'F12', fullscreen: 'F11',
};

export function padKind(id: string): 'xbox' | 'playstation' | 'switch' | 'generic' {
  const s = id.toLowerCase();
  if (/054c|playstation|dualshock|dualsense|ps[345]/.test(s)) return 'playstation';
  if (/057e|nintendo|switch|pro controller|joy-con/.test(s)) return 'switch';
  if (/045e|xbox|xinput|microsoft/.test(s)) return 'xbox';
  return 'generic';
}

export class Input {
  keys: KeyBindings = DEFAULT_KEYS;
  pad: PadBindings = DEFAULT_PAD;
  touch = 0;               // bits from the on-screen controls (port 0)
  latched = 0;             // presses since the last poll (keyboard + touch taps)
  private down = new Set<string>();
  private keyMap = new Map<string, number>();
  /** set while a remap screen is listening, so game input doesn't fire */
  enabled = true;

  constructor() { this.rebuild(); }

  rebuild() {
    this.keyMap.clear();
    for (const [b, codes] of Object.entries(this.keys)) for (const c of codes ?? []) this.keyMap.set(c, (this.keyMap.get(c) ?? 0) | (1 << BTN[b as ButtonName]));
  }

  /** Returns true if the key is bound to a game button (so callers can preventDefault). */
  keyDown(code: string) {
    this.down.add(code);
    // latch so a tap shorter than one frame still reaches the game
    this.latched |= this.keyMap.get(code) ?? 0;
    return this.keyMap.has(code);
  }
  keyUp(code: string) { this.down.delete(code); }
  clear() { this.down.clear(); this.touch = 0; this.latched = 0; }

  /** Gamepads in port order (null-free, connected only). */
  pads(): Gamepad[] {
    return (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
  }

  padMask(g: Gamepad): number {
    let m = 0;
    for (const [b, idx] of Object.entries(this.pad)) for (const i of idx ?? []) if (g.buttons[i]?.pressed) m |= 1 << BTN[b as ButtonName];
    // left stick doubles as the d-pad
    const [x = 0, y = 0] = g.axes;
    if (x < -0.5) m |= 1 << BTN.LEFT; if (x > 0.5) m |= 1 << BTN.RIGHT;
    if (y < -0.5) m |= 1 << BTN.UP; if (y > 0.5) m |= 1 << BTN.DOWN;
    return m;
  }

  /** Masks for ports 0..3. Keyboard and touch drive port 0; pad N drives port N. */
  poll(): number[] {
    const out = [0, 0, 0, 0];
    if (!this.enabled) return out;
    for (const c of this.down) out[0] |= this.keyMap.get(c) ?? 0;
    out[0] |= this.touch | this.latched;
    this.latched = 0;
    this.pads().forEach((g, i) => { if (i < 4) out[i] |= this.padMask(g); });
    return out;
  }
}
