// Several Game Boy Advances joined by an emulated link cable, driven like a single Core.
// Every machine in a link session runs ALL players' GBAs (cores/glue/gbalink.c); only inputs travel
// the network. `view` picks whose screen and sound this machine presents.
import type { AVInfo } from './core.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = any;

export class LinkCore {
  private m: Mod;
  av!: AVInfo;
  readonly players: number;
  private stateBuf = 0;
  private stateCap = 0;

  private constructor(m: Mod, players: number) { this.m = m; this.players = players; }

  /** roms[i] is player i's ROM (usually the same game); srams[i] that player's battery save. */
  static async create(factory: (o?: object) => Promise<Mod>, roms: Uint8Array[], srams: (Uint8Array | null)[] = [], view = 0): Promise<LinkCore> {
    const m = await factory({ print: () => {}, printErr: () => {} });
    const n = roms.length;
    if (!m._lk_create(n)) throw new Error('Could not create the linked Game Boy Advances.');
    roms.forEach((rom, i) => {
      const p = m._malloc(rom.length);
      m.HEAPU8.set(rom, p);
      const ok = m._lk_load(i, p, rom.length);
      m._free(p);
      if (!ok) throw new Error(`Player ${i + 1}'s game could not be loaded.`);
    });
    const c = new LinkCore(m, n);
    srams.forEach((s, i) => { if (s?.length) c.setSram(s, i); });
    m._lk_link();
    m._lk_set_view(view);
    c.av = { width: 240, height: 160, maxWidth: 240, maxHeight: 160, aspect: 3 / 2, fps: 16777216 / 280896, sampleRate: m._lk_sample_rate() };
    return c;
  }

  setView(i: number) { this.m._lk_set_view(i); }
  run(flags = 3) { this.m._lk_run(flags); }
  reset() { this.m._lk_reset(); }
  setInput(port: number, mask: number) { this.m._lk_set_input(port, mask); }
  setStrict(_on: boolean) { /* no frame-skip hints and no RTC: always deterministic */ }
  setPointer() { /* no touch screen */ }
  setOption() { /* no core options */ }
  options() { return []; }
  cheats() { /* not supported while linked */ }
  writeSystemFile() { /* GBA needs no BIOS */ }
  refreshAV() { /* fixed 240x160 */ }
  frameReady(): boolean { return this.m._lk_frame_ready() === 1; }

  frame(): { data: Uint8Array; width: number; height: number } {
    const p = this.m._lk_fb();
    return { data: this.m.HEAPU8.subarray(p, p + 240 * 160 * 4), width: 240, height: 160 };
  }
  audio(): Int16Array {
    const n = this.m._lk_audio_frames(), p = this.m._lk_audio() >> 1;
    return this.m.HEAP16.subarray(p, p + n * 2);
  }

  stateSize(): number { return this.m._lk_state_size(); }
  saveState(): Uint8Array {
    const size = this.stateSize();
    if (size > this.stateCap) { if (this.stateBuf) this.m._free(this.stateBuf); this.stateBuf = this.m._malloc(size); this.stateCap = size; }
    if (!this.m._lk_state_save(this.stateBuf, size)) throw new Error('Save state failed');
    return this.m.HEAPU8.slice(this.stateBuf, this.stateBuf + size);
  }
  loadState(s: Uint8Array): boolean {
    if (s.length > this.stateCap) { if (this.stateBuf) this.m._free(this.stateBuf); this.stateBuf = this.m._malloc(s.length); this.stateCap = s.length; }
    this.m.HEAPU8.set(s, this.stateBuf);
    return this.m._lk_state_load(this.stateBuf, s.length) === 1;
  }

  /** Battery save of one player's GBA (copy), or null. */
  sram(player = 0): Uint8Array | null {
    const n = this.m._lk_sram_clone(player);
    if (!n) return null;
    const p = this.m._lk_sram_ptr();
    return this.m.HEAPU8.slice(p, p + n);
  }
  setSram(data: Uint8Array, player = 0) {
    const p = this.m._malloc(data.length);
    this.m.HEAPU8.set(data, p);
    this.m._lk_sram_restore(player, p, data.length);
    this.m._free(p);
  }

  get name() { return `mGBA link ×${this.players}`; }
  get version() { return ''; }
  get memoryBytes() { return this.m.HEAPU8.length; }
}
