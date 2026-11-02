// Messages between the main thread (Emulator) and the emulation worker.
import type { AVInfo } from './core.ts';
import type { DisplayOptions } from './renderer.ts';
import type { NetMsg, NetStats } from '../net/rollback.ts';

export type FFAudio = 'mute' | 'pitch' | 'stretch';

export interface CoreOption { key: string; label: string; values: string[] }

export type ToWorker =
  | {
      type: 'init'; coreUrl: string; rom: ArrayBuffer; fileName: string;
      canvas?: OffscreenCanvas; display?: Partial<DisplayOptions>;
      audio: { rate: number; latencyMs?: number; sab?: { data: SharedArrayBuffer; ctl: SharedArrayBuffer }; port?: MessagePort; capacity: number };
      options?: Record<string, string>; sram?: ArrayBuffer; state?: ArrayBuffer;
      rewind?: { enabled: boolean; seconds: number; budgetMB: number };
    }
  | { type: 'tick'; now: number; dt: number; inputs: number[]; vsync: boolean }
  | {
      type: 'set'; speed?: number; paused?: boolean; rewinding?: boolean; ffAudio?: FFAudio; volume?: number;
      displayHz?: number; vsyncLock?: boolean; display?: Partial<DisplayOptions>;
      rewind?: { enabled: boolean; seconds: number; budgetMB: number }; options?: Record<string, string>;
    }
  | { type: 'resize'; w: number; h: number }
  | { type: 'saveState'; id: number }
  | { type: 'loadState'; id: number; state: ArrayBuffer }
  | { type: 'reset' }
  | { type: 'cheats'; codes: string[] }
  | { type: 'screenshot'; id: number }
  | { type: 'net'; msg: NetMsg }
  | { type: 'netStart'; localPort: number; players: number[]; inputDelay: number; maxRollback: number; state?: ArrayBuffer }
  | { type: 'netStop' }
  | { type: 'netResync' }
  | { type: 'bench'; id: number; ms: number }
  | { type: 'timings'; id: number };

export interface Stats {
  emuFps: number; fps: number; workMs: number; audioFill: number; underruns: number;
  rewindSeconds: number; rewindMB: number; net?: NetStats;
}

export type FromWorker =
  | { type: 'ready'; av: AVInfo; coreName: string; coreVersion: string; options: CoreOption[]; stateSize: number; hasSram: boolean }
  | ({ type: 'stats' } & Stats)
  | { type: 'state'; id: number; state: Uint8Array; thumb: Blob | null; frame: number }
  | { type: 'loaded'; id: number; ok: boolean }
  | { type: 'sram'; data: Uint8Array }
  | { type: 'screenshot'; id: number; png: Blob | null }
  | { type: 'frame'; data: Uint8Array; width: number; height: number; aspect: number }
  | { type: 'net'; msg: NetMsg }
  | { type: 'netEvent'; event: 'desync'; frame: number }
  | { type: 'error'; message: string }
  | { type: 'bench'; id: number; frames: number; ms: number }
  | { type: 'timings'; id: number; t: Float64Array };
