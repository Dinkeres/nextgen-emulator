// Messages between the main thread (Emulator) and the emulation worker.
import type { AVInfo } from './core.ts';
import type { DisplayOptions } from './renderer.ts';
import type { QzMsg } from '../net/quetzal.ts';
import type { NetMsg, NetStats } from '../net/rollback.ts';

export type FFAudio = 'mute' | 'pitch' | 'stretch';

export interface CoreOption { key: string; label: string; values: string[] }

export type ToWorker =
  | {
      type: 'init'; coreUrl: string; rom: ArrayBuffer; fileName: string;
      canvas?: OffscreenCanvas; display?: Partial<DisplayOptions>;
      audio: { rate: number; latencyMs?: number; sab?: { data: SharedArrayBuffer; ctl: SharedArrayBuffer }; port?: MessagePort; capacity: number };
      options?: Record<string, string>; sram?: ArrayBuffer; state?: ArrayBuffer;
      /** user-supplied BIOS/firmware written to /system before the game loads */
      systemFiles?: Record<string, ArrayBuffer>;
      /** GBA link play: every player's ROM and battery save; `view` = whose screen/sound this machine shows */
      link?: { roms: ArrayBuffer[]; srams: (ArrayBuffer | null)[]; view: number };
      /** deterministic from the first frame (netplay) */
      strict?: boolean;
      rewind?: { enabled: boolean; seconds: number; budgetMB: number; heavy?: boolean };
    }
  /** stylus: [x, y, down] normalized to the canvas (0..1), for touch-screen systems */
  | { type: 'tick'; now: number; dt: number; inputs: number[]; vsync: boolean; stylus?: [number, number, number] }
  | {
      type: 'set'; speed?: number; paused?: boolean; rewinding?: boolean; ffAudio?: FFAudio; volume?: number;
      displayHz?: number; vsyncLock?: boolean; frameskip?: 'auto' | 'off'; display?: Partial<DisplayOptions>;
      rewind?: { enabled: boolean; seconds: number; budgetMB: number; heavy?: boolean }; options?: Record<string, string>;
    }
  | { type: 'resize'; w: number; h: number }
  | { type: 'saveState'; id: number }
  | { type: 'loadState'; id: number; state: ArrayBuffer }
  | { type: 'reset' }
  | { type: 'cheats'; codes: string[] }
  | { type: 'screenshot'; id: number }
  | { type: 'net'; msg: NetMsg }
  | { type: 'netStart'; localPort: number; players: number[]; inputDelay: number; maxRollback: number; state?: ArrayBuffer; shared?: boolean }
  | { type: 'netStop' }
  | { type: 'netResync' }
  // Pokémon Quetzal co-op bridge (src/net/quetzal.ts)
  | { type: 'qzStart'; host: boolean } | { type: 'qz'; msg: QzMsg }
  | { type: 'bench'; id: number; ms: number }
  | { type: 'timings'; id: number };

export interface Stats {
  emuFps: number; fps: number; workMs: number; audioFill: number; underruns: number;
  rewindSeconds: number; rewindMB: number; wasmMB: number; skipping?: boolean; net?: NetStats;
}

export type FromWorker =
  | { type: 'ready'; av: AVInfo; coreName: string; coreVersion: string; options: CoreOption[]; stateSize: number; hasSram: boolean; resumed: boolean }
  | ({ type: 'stats' } & Stats)
  | { type: 'state'; id: number; state: Uint8Array; thumb: Blob | null; frame: number }
  | { type: 'loaded'; id: number; ok: boolean }
  | { type: 'sram'; data: Uint8Array }
  | { type: 'screenshot'; id: number; png: Blob | null }
  | { type: 'frame'; data: Uint8Array; width: number; height: number; aspect: number }
  | { type: 'net'; msg: NetMsg }
  | { type: 'netEvent'; event: 'desync'; frame: number }
  | { type: 'qz'; msg: QzMsg } | { type: 'qzStatus'; text: string }
  | { type: 'error'; message: string }
  | { type: 'notice'; code: 'rewind-heavy' }
  | { type: 'bench'; id: number; frames: number; ms: number }
  | { type: 'timings'; id: number; t: Float64Array };
