// Adding games (local files stay in the browser) and the bundled, freely licensed homebrew.
import { db, sha256, type Game } from './db.ts';
import { refreshLibrary, toast } from './store.ts';
import { SYSTEMS, systemForFile } from '../engine/systems.ts';
import { zipEntries, zipRead } from './unzip.ts';

export interface Homebrew { file: string; title: string; system: string; author: string; license: string; url: string; blurb: string }

export const HOMEBREW: Homebrew[] = [
  { file: 'thwaite.nes', title: 'Thwaite', system: 'nes', author: 'Damian Yerrick', license: 'GPL-3.0', url: 'https://github.com/pinobatch/thwaite-nes', blurb: 'Defend your villages from incoming missiles. 1–2 players.' },
  { file: 'croom.nes', title: 'Concentration Room', system: 'nes', author: 'Damian Yerrick', license: 'GPL-3.0', url: 'https://github.com/pinobatch/croom-nes', blurb: 'A memory card-flipping game set in a mysterious lab. 1–2 players.' },
  { file: 'breakout.sfc', title: 'Breakout', system: 'snes', author: 'Alekmaul (PVSnesLib), after Ulrich Hecht', license: 'zlib', url: 'https://github.com/alekmaul/pvsneslib', blurb: 'Classic brick-breaking on the Super Nintendo.' },
  { file: 'libbet.gb', title: 'Libbet and the Magic Floor', system: 'gb', author: 'Damian Yerrick', license: 'zlib', url: 'https://github.com/pinobatch/libbet', blurb: 'Roll across every floor tile in this puzzle game.' },
  { file: 'ucity.gbc', title: 'µCity', system: 'gbc', author: 'Antonio Niño Díaz', license: 'GPL-3.0 (code), CC BY-SA 4.0 (media)', url: 'https://github.com/AntonioND/ucity', blurb: 'A full city-building simulation for the Game Boy Color.' },
  { file: 'sgdk-cube3d.gen', title: 'Cube 3D', system: 'genesis', author: 'Stephane Dallongeville (SGDK sample)', license: 'MIT', url: 'https://github.com/Stephane-D/SGDK', blurb: 'Real-time 3D rendering demo for the Mega Drive.' },
  { file: 'sgdk-partic.gen', title: 'Particles', system: 'genesis', author: 'Stephane Dallongeville (SGDK sample)', license: 'MIT', url: 'https://github.com/Stephane-D/SGDK', blurb: 'Hundreds of bitmap particles bouncing around.' },
  { file: 'kaiser-ds-demo.nds', title: 'Kaiser DS Demo', system: 'nds', author: 'Kaiser project (original)', license: 'GPL-3.0', url: 'https://github.com/Dinkeres/nextgen-emulator/tree/main/homebrew-src/ds-demo', blurb: 'Spin a 3D cube on the top screen and paint with the stylus on the touch screen.' },
  { file: 'kaiser-link-squares.gba', title: 'Link Squares', system: 'gba', author: 'Kaiser project (original)', license: 'GPL-3.0', url: 'https://github.com/Dinkeres/nextgen-emulator/tree/main/homebrew-src/gba-link', blurb: 'A 2–4 player link-cable test: everyone moves a square and sees each other live. Try it in Multiplayer!' },
  { file: '240pee_mb.gba', title: '240p Test Suite', system: 'gba', author: 'Damian Yerrick & Artemio Urbina', license: 'GPL-2.0', url: 'https://github.com/pinobatch/240p-test-mini', blurb: 'Display and input calibration patterns for the GBA.' },
];

const homebrewUrl = (f: string) => new URL(`${import.meta.env.BASE_URL}homebrew/${f}`, location.href).href;

/** Make sure bundled homebrew appears in the library (ids are the ROM hashes). */
export async function ensureHomebrew() {
  const known = await db.kv<string[]>('homebrew-added') ?? [];
  const missing = HOMEBREW.filter(h => !known.includes(h.file));
  if (!missing.length) return;
  await Promise.all(missing.map(async h => {
    try {
      const buf = await (await fetch(homebrewUrl(h.file))).arrayBuffer();
      const id = await sha256(buf);
      if (!(await db.game(id))) {
        await db.putGame({ id, title: h.title, system: h.system, fileName: h.file, size: buf.byteLength, addedAt: Date.now() - HOMEBREW.indexOf(h), lastPlayed: 0, playTime: 0, favorite: false, bundled: true });
      }
      known.push(h.file);
    } catch { /* offline on first load: try again next time */ }
  }));
  await db.putKv('homebrew-added', known);
}

export async function romFor(g: Game): Promise<ArrayBuffer> {
  if (g.bundled) return (await fetch(homebrewUrl(g.fileName))).arrayBuffer();
  const b = await db.rom(g.id);
  if (!b) throw new Error('The ROM for this game is missing. Add the file again.');
  return b.arrayBuffer();
}

function titleFromFile(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[_.]+/g, ' ').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+/g, ' ').trim() || name;
}

/** Add ROM files. Unknown extensions are reported, not stored. Returns added games. */
export async function addFiles(files: Iterable<File>): Promise<Game[]> {
  const added: Game[] = [];
  const skipped: string[] = [];
  for (let f of files) {
    if (/\.zip$/i.test(f.name)) {
      // ROMs are often zipped: use the first supported file inside
      try {
        const buf = await f.arrayBuffer();
        const entry = zipEntries(buf).find(e => systemForFile(e.name));
        if (!entry) { skipped.push(f.name); continue; }
        f = new File([(await zipRead(buf, entry)) as BlobPart], entry.name.split('/').pop()!);
      } catch { skipped.push(f.name); continue; }
    }
    const sys = systemForFile(f.name);
    if (!sys) { skipped.push(f.name); continue; }
    if (f.size > 64 * 1048576) { skipped.push(f.name); continue; }
    const buf = await f.arrayBuffer();
    const id = await sha256(buf);
    const existing = await db.game(id);
    if (existing) { added.push(existing); continue; }
    const g: Game = { id, title: titleFromFile(f.name), system: sys.id, fileName: f.name, size: f.size, addedAt: Date.now(), lastPlayed: 0, playTime: 0, favorite: false };
    await db.putRom(id, new Blob([buf]));
    await db.putGame(g);
    added.push(g);
  }
  await refreshLibrary();
  if (added.length) toast(added.length === 1 ? `Added ${added[0].title}` : `Added ${added.length} games`, 'plus', 'success');
  if (skipped.length) {
    const exts = Object.values(SYSTEMS).flatMap(s => s.exts).map(e => '.' + e).join(' ');
    toast(`Couldn't add ${skipped.length === 1 ? skipped[0] : skipped.length + ' files'} — supported: ${exts}`, 'alert', 'warn', 5000);
  }
  return added;
}

export function pickFiles(): Promise<File[]> {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true;
    i.accept = [...Object.values(SYSTEMS).flatMap(s => s.exts), 'zip'].map(e => '.' + e).join(',');
    i.onchange = () => res([...(i.files ?? [])]);
    i.click();
  });
}
