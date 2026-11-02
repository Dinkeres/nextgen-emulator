// Thin typed wrapper over a core built with cores/glue/frontend.c.
// Runs anywhere wasm runs: Web Worker, main thread, or Node (tests/bench).

export interface AVInfo {
  width: number; height: number; maxWidth: number; maxHeight: number;
  aspect: number; fps: number; sampleRate: number;
}

export const RUN_VIDEO = 1, RUN_AUDIO = 2, RUN_FF = 4;
export const MEM_SAVE_RAM = 0, MEM_RTC = 1;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = any;

export class Core {
  private m: Mod;
  av!: AVInfo;
  private stateBuf = 0;
  private stateCap = 0;

  private constructor(m: Mod) { this.m = m; }

  /** factory: the default export of public/cores/<name>.mjs */
  static async create(factory: (opts?: object) => Promise<Mod>, wasmBinary?: ArrayBuffer | Uint8Array): Promise<Core> {
    const m = await factory({
      ...(wasmBinary ? { wasmBinary } : {}),
      print: () => {},
      printErr: (s: string) => console.warn('[core]', s),
    });
    for (const d of ['/system', '/save', '/rom']) try { m.FS.mkdir(d); } catch { /* exists */ }
    return new Core(m);
  }

  setOption(key: string, value: string) {
    const k = this.m.stringToNewUTF8(key), v = this.m.stringToNewUTF8(value);
    this.m._ng_set_var(k, v);
    this.m._free(k); this.m._free(v);
  }

  /** Raw "key\tDescription; a|b|c" lines registered by the core. */
  options(): { key: string; label: string; values: string[] }[] {
    const s: string = this.m.UTF8ToString(this.m._ng_options());
    return s.split('\n').filter(Boolean).map(line => {
      const [key, rest] = line.split('\t');
      const i = rest.indexOf('; ');
      return { key, label: rest.slice(0, i), values: rest.slice(i + 2).split('|') };
    });
  }

  load(rom: Uint8Array, fileName: string): boolean {
    const path = '/rom/' + fileName.replace(/[^\w.\-]/g, '_');
    this.m.FS.writeFile(path, rom);
    const p = this.m._malloc(rom.length);
    this.m.HEAPU8.set(rom, p);
    const cpath = this.m.stringToNewUTF8(path);
    const ok = this.m._ng_load(cpath, p, rom.length) === 1;
    // ponytail: rom buffer intentionally kept alive; some cores reference it after load.
    if (!ok) return false;
    const a = this.m._ng_av() >> 3;
    const f = this.m.HEAPF64;
    this.av = { width: f[a], height: f[a + 1], maxWidth: f[a + 2], maxHeight: f[a + 3], aspect: f[a + 4], fps: f[a + 5], sampleRate: f[a + 6] };
    return true;
  }

  refreshAV() {
    const a = this.m._ng_av() >> 3, f = this.m.HEAPF64;
    this.av.width = f[a]; this.av.height = f[a + 1]; this.av.aspect = f[a + 4];
  }

  run(flags = RUN_VIDEO | RUN_AUDIO) { this.m._ng_run(flags); }
  reset() { this.m._ng_reset(); }

  /** Pressed-button bitmask (libretro RETRO_DEVICE_ID_JOYPAD_* bit positions) for a port. */
  setInput(port: number, mask: number) { this.m.HEAPU16[(this.m._ng_joy() >> 1) + port] = mask; }
  setAnalog(port: number, stick: number, axis: number, v: number) {
    this.m.HEAP16[(this.m._ng_analog() >> 1) + port * 4 + stick * 2 + axis] = v;
  }

  frameReady(): boolean { return this.m._ng_frame_ready() === 1; }
  /** RGBA8888 view of the last rendered frame (valid until next run). */
  frame(): { data: Uint8Array; width: number; height: number } {
    const w = this.m._ng_fb_w(), h = this.m._ng_fb_h();
    return { data: this.m.HEAPU8.subarray(this.m._ng_fb(), this.m._ng_fb() + w * h * 4), width: w, height: h };
  }
  /** Interleaved stereo int16 produced by the last run (view, copy if kept). */
  audio(): Int16Array {
    const n = this.m._ng_audio_frames();
    const p = this.m._ng_audio() >> 1;
    return this.m.HEAP16.subarray(p, p + n * 2);
  }

  stateSize(): number { return this.m._ng_state_size(); }
  saveState(): Uint8Array {
    const size = this.stateSize();
    if (!size) throw new Error('Core does not support save states');
    if (size > this.stateCap) { if (this.stateBuf) this.m._free(this.stateBuf); this.stateBuf = this.m._malloc(size); this.stateCap = size; }
    if (!this.m._ng_state_save(this.stateBuf, size)) throw new Error('Save state failed');
    return this.m.HEAPU8.slice(this.stateBuf, this.stateBuf + size);
  }
  loadState(s: Uint8Array): boolean {
    if (s.length > this.stateCap) { if (this.stateBuf) this.m._free(this.stateBuf); this.stateBuf = this.m._malloc(s.length); this.stateCap = s.length; }
    this.m.HEAPU8.set(s, this.stateBuf);
    return this.m._ng_state_load(this.stateBuf, s.length) === 1;
  }

  /** Battery save RAM as a live view (null if the game has none). */
  sram(): Uint8Array | null {
    const n = this.m._ng_mem_size(MEM_SAVE_RAM);
    if (!n) return null;
    const p = this.m._ng_mem(MEM_SAVE_RAM);
    return p ? this.m.HEAPU8.subarray(p, p + n) : null;
  }
  setSram(data: Uint8Array) { const s = this.sram(); if (s) s.set(data.subarray(0, s.length)); }

  cheats(codes: string[]) {
    this.m._ng_cheat_reset();
    codes.forEach((c, i) => { const p = this.m.stringToNewUTF8(c); this.m._ng_cheat_set(i, 1, p); this.m._free(p); });
  }

  get name(): string { return this.m.UTF8ToString(this.m._ng_core_name()); }
  get version(): string { return this.m.UTF8ToString(this.m._ng_core_version()); }
  get memoryBytes(): number { return this.m.HEAPU8.length; }
}
