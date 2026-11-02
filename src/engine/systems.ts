// System registry: which core runs what, plus per-system UI data.

/** libretro RETRO_DEVICE_ID_JOYPAD_* bit positions */
export const BTN = {
  B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  A: 8, X: 9, L: 10, R: 11, L2: 12, R2: 13, L3: 14, R3: 15,
} as const;
export type ButtonName = keyof typeof BTN;

export interface SystemInfo {
  id: string;
  name: string;
  short: string;
  core: string;          // file name in public/cores (without .mjs)
  exts: string[];
  color: string;         // accent for placeholder covers and badges
  buttons: ButtonName[]; // buttons the real controller has (for remap UI + touch layout)
  /** button labels as printed on that console, when they differ from libretro names */
  labels?: Partial<Record<ButtonName, string>>;
  rollback: boolean;     // state save/load fast enough for rollback netplay (see BENCHMARKS.md)
  maxPlayers: number;
}

const DPAD: ButtonName[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

export const SYSTEMS: Record<string, SystemInfo> = {
  nes: {
    id: 'nes', name: 'Nintendo Entertainment System', short: 'NES', core: 'fceumm',
    exts: ['nes', 'fds', 'unf', 'unif'], color: '#e4572e',
    buttons: [...DPAD, 'B', 'A', 'SELECT', 'START'], rollback: true, maxPlayers: 4,
  },
  snes: {
    id: 'snes', name: 'Super Nintendo', short: 'SNES', core: 'snes9x',
    exts: ['sfc', 'smc', 'fig', 'swc', 'bs'], color: '#7b5cff',
    buttons: [...DPAD, 'Y', 'X', 'B', 'A', 'L', 'R', 'SELECT', 'START'], rollback: true, maxPlayers: 4,
  },
  gb: {
    id: 'gb', name: 'Game Boy', short: 'GB', core: 'gambatte',
    exts: ['gb'], color: '#8bac0f',
    buttons: [...DPAD, 'B', 'A', 'SELECT', 'START'], rollback: true, maxPlayers: 1,
  },
  gbc: {
    id: 'gbc', name: 'Game Boy Color', short: 'GBC', core: 'gambatte',
    exts: ['gbc'], color: '#00a6a6',
    buttons: [...DPAD, 'B', 'A', 'SELECT', 'START'], rollback: true, maxPlayers: 1,
  },
  gba: {
    id: 'gba', name: 'Game Boy Advance', short: 'GBA', core: 'mgba',
    exts: ['gba'], color: '#4361ee',
    buttons: [...DPAD, 'B', 'A', 'L', 'R', 'SELECT', 'START'], rollback: true, maxPlayers: 1,
  },
  genesis: {
    id: 'genesis', name: 'Sega Genesis / Mega Drive', short: 'Genesis', core: 'genesis_plus_gx',
    exts: ['md', 'gen', 'smd', 'sms', 'gg', '32x'], color: '#1f8ef1',
    buttons: [...DPAD, 'Y', 'B', 'A', 'X', 'L', 'R', 'START', 'SELECT'],
    // libretro maps Genesis A/B/C to Y/B/A; X/Y/Z to L/X/R
    labels: { Y: 'A', B: 'B', A: 'C', L: 'X', X: 'Y', R: 'Z', SELECT: 'Mode' },
    rollback: true, maxPlayers: 4,
  },
};

export function systemForFile(name: string): SystemInfo | undefined {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return Object.values(SYSTEMS).find(s => s.exts.includes(ext));
}

export function buttonLabel(sys: SystemInfo, b: ButtonName): string {
  return sys.labels?.[b] ?? ({ SELECT: 'Select', START: 'Start', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' } as Record<string, string>)[b] ?? b;
}
