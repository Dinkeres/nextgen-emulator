// Stage 1 of the 3DS recompilation project (docs/superpowers/specs/2026-11-02-3ds-recomp-design.md):
// measure a DECRYPTED .3ds (CCI/NCSD) dump: its main program, the code modules it loads later (CRO),
// which 3DS system services it talks to, and how much of its code a static recompiler must cover.
// Reads only; writes a report (and optionally the unpacked code) under 3ds-work/ (gitignored).
// Usage: node tools/3ds/inspect.mjs "<game>.3ds" [--extract]
import { openSync, readSync, fstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv[2], extract = process.argv.includes('--extract');
if (!file) { console.error('usage: node tools/3ds/inspect.mjs <dump.3ds> [--extract]'); process.exit(1); }
const fd = openSync(file, 'r'), fileSize = fstatSync(fd).size;
const read = (off, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
const MU = 0x200; // media unit
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
const ascii = (b, o, n) => b.subarray(o, o + n).toString('latin1').replace(/\0.*$/s, '');

// ---------- NCSD (cartridge image) ----------
const ncsd = read(0, 0x200);
if (ascii(ncsd, 0x100, 4) !== 'NCSD') throw new Error('Not a .3ds (CCI/NCSD) image');
const parts = [];
for (let i = 0; i < 8; i++) {
  const off = ncsd.readUInt32LE(0x120 + i * 8) * MU, size = ncsd.readUInt32LE(0x124 + i * 8) * MU;
  if (size) parts.push({ i, off, size });
}
say(`# 3DS dump report\n\nFile: ${kb(fileSize)}, ${parts.length} partitions (${parts.map(p => `#${p.i} ${kb(p.size)}`).join(', ')})`);

// ---------- NCCH (partition 0: the game) ----------
const base = parts[0].off;
const ncch = read(base, 0x200);
if (ascii(ncch, 0x100, 4) !== 'NCCH') throw new Error('Partition 0 is not NCCH');
const flags7 = ncch[0x188 + 7];
const noCrypto = !!(flags7 & 0x4);
const productCode = ascii(ncch, 0x150, 16);
const programId = ncch.readBigUInt64LE(0x118).toString(16).padStart(16, '0');
say(`Product code: ${productCode} · program ID ${programId} · ${noCrypto ? 'decrypted (NoCrypto flag set)' : 'ENCRYPTED: needs a decrypted dump'}`);
if (!noCrypto) process.exit(2);
const exefsOff = base + ncch.readUInt32LE(0x1a0) * MU, exefsSize = ncch.readUInt32LE(0x1a4) * MU;
const romfsOff = base + ncch.readUInt32LE(0x1b0) * MU, romfsSize = ncch.readUInt32LE(0x1b4) * MU;

// ---------- ExHeader: memory layout, services, kernel capabilities ----------
const ex = read(base + 0x200, 0x800);
const codeCompressed = !!(ex[0xd] & 1);
const seg = o => ({ addr: ex.readUInt32LE(o), pages: ex.readUInt32LE(o + 4), size: ex.readUInt32LE(o + 8) });
const text = seg(0x10), ro = seg(0x20), data = seg(0x30), bss = ex.readUInt32LE(0x3c), stack = ex.readUInt32LE(0x1c);
say(`\n## Program layout\n\n- name "${ascii(ex, 0, 8)}", code ${codeCompressed ? 'compressed (BLZ)' : 'plain'}`);
say(`- .text ${kb(text.size)} @0x${text.addr.toString(16)}, .rodata ${kb(ro.size)} @0x${ro.addr.toString(16)}, .data ${kb(data.size)} @0x${data.addr.toString(16)}, .bss ${kb(bss)}, stack ${kb(stack)}`);
const deps = [];
for (let i = 0; i < 48; i++) { const t = ex.readBigUInt64LE(0x40 + i * 8); if (t) deps.push(t.toString(16).padStart(16, '0')); }
say(`- system modules it depends on: ${deps.length}`);
const saveSize = Number(ex.readBigUInt64LE(0x1c0));
say(`- save data size: ${kb(saveSize)}`);
const services = [];
for (let i = 0; i < 34; i++) { const s = ascii(ex, 0x250 + i * 8, 8); if (s) services.push(s); }
say(`\n## System services it may use (${services.length})\n\n${services.join(', ')}`);
const kcaps = [];
for (let i = 0; i < 28; i++) kcaps.push(ex.readUInt32LE(0x370 + i * 4));
const svcAllowed = [];
for (const d of kcaps) if ((d >>> 27) === 0b11110) { const idx = (d >>> 24) & 7; for (let b = 0; b < 24; b++) if (d & (1 << b)) svcAllowed.push(idx * 24 + b); }
say(`\nKernel calls (SVCs) it is allowed: ${svcAllowed.length}`);
const coreFlags = ex[0x20f + 0] ; void coreFlags;
const sysMode = (ex[0x20e] >> 4) & 0xf, n3dsMode = ex[0x20d] & 0x3, cpuSpeed = (ex[0x20d] >> 1) & 1;
say(`Memory mode: old-3DS ${['Prod 64MB', '?', 'Dev1', 'Dev2', 'Dev3', 'Dev4'][sysMode] ?? sysMode}${n3dsMode ? `, New-3DS mode flags ${ex[0x20d]}` : ''}${cpuSpeed ? ', asks for New-3DS 804 MHz' : ''}`);

// ---------- ExeFS: .code (main program), icon, banner ----------
const exh = read(exefsOff, 0x200);
const exefs = {};
for (let i = 0; i < 10; i++) {
  const name = ascii(exh, i * 16, 8);
  if (name) exefs[name] = { off: exefsOff + 0x200 + exh.readUInt32LE(i * 16 + 8), size: exh.readUInt32LE(i * 16 + 12) };
}
let code = read(exefs['.code'].off, exefs['.code'].size);
if (codeCompressed) code = blzDecompress(code);
say(`\n## Main program (.code): ${kb(exefs['.code'].size)} stored, ${kb(code.length)} unpacked`);

/** Nintendo's "backwards LZ" code compression (as in 3dstool/ctrtool). */
function blzDecompress(src) {
  const n = src.length;
  const tb = src.readUInt32LE(n - 8), grow = src.readUInt32LE(n - 4);
  const top = tb & 0xffffff, bottom = tb >>> 24;
  const dst = Buffer.alloc(n + grow);
  src.copy(dst, 0);
  let d = n + grow, s = n - bottom; const end = n - top;
  while (s > end) {
    const flag = dst[--s];
    for (let i = 0; i < 8; i++) {
      if (((flag << i) & 0x80) === 0) dst[--d] = dst[--s];
      else {
        const hi = dst[--s], lo = dst[--s];
        const off = (((hi & 0x0f) << 8) | lo) + 3, len = ((hi >> 4) & 0x0f) + 3;
        for (let j = 0; j < len; j++) { dst[d - 1] = dst[d - 1 + off]; d--; }
      }
      if (s <= end) break;
    }
  }
  return dst;
}

// ---------- code analysis (ARM mode words in .text) ----------
function analyse(buf, textSize, label) {
  const words = Math.floor(Math.min(textSize, buf.length) / 4);
  let bl = 0, blx = 0, svc = 0, bxReg = 0, blxReg = 0, ldrPc = 0, popPc = 0, vfp = 0, neon = 0, ldrexStrex = 0, mcr = 0;
  const targets = new Set(), svcs = new Map();
  for (let i = 0; i < words; i++) {
    const w = buf.readUInt32LE(i * 4), cond = w >>> 28;
    if (cond === 0xf) { if ((w & 0x0e000000) === 0x0a000000) { blx++; targets.add(i * 4 + 8 + (((w << 8) >> 6) | ((w >>> 23) & 2))); } continue; }
    if ((w & 0x0f000000) === 0x0b000000) { bl++; targets.add(i * 4 + 8 + ((w << 8) >> 6)); }
    else if ((w & 0x0f000000) === 0x0f000000) { svc++; const n = w & 0xff; svcs.set(n, (svcs.get(n) ?? 0) + 1); }
    else if ((w & 0x0ffffff0) === 0x012fff10) bxReg++;
    else if ((w & 0x0ffffff0) === 0x012fff30) blxReg++;
    else if ((w & 0x0c50f000) === 0x0410f000) ldrPc++;                       // LDR pc, [...]
    else if ((w & 0x0e508000) === 0x08108000) popPc++;                      // LDM ... {..., pc}
    else if ((w & 0x0e000e00) === 0x0c000a00 || (w & 0x0f000e10) === 0x0e000a00 || (w & 0x0f000e10) === 0x0e000a10) vfp++;
    else if ((w & 0x0f900ff0) === 0x01900f90 || (w & 0x0f900ff0) === 0x01800f90) ldrexStrex++;
    else if ((w & 0x0f100010) === 0x0e000010 && ((w >> 8) & 0xf) === 15) mcr++;
  }
  void neon;
  return { label, words, functions: [...targets].filter(t => t >= 0 && t < textSize).length, bl, blx, svc, svcs, bxReg, blxReg, ldrPc, popPc, vfp, ldrexStrex, mcr };
}
const main = analyse(code, text.size, '.code');
const pct = (a, b) => (100 * a / b).toFixed(2) + '%';
const report = a => {
  say(`- ${a.words.toLocaleString()} instruction words; ~${a.functions.toLocaleString()} distinct call targets (≈ functions)`);
  say(`- direct calls: ${(a.bl + a.blx).toLocaleString()} (${a.blx.toLocaleString()} switch ARM↔Thumb)`);
  say(`- indirect jumps/calls (the hard part of static recompilation): BX reg ${a.bxReg.toLocaleString()}, BLX reg ${a.blxReg.toLocaleString()}, LDR pc ${a.ldrPc.toLocaleString()}, POP {pc} ${a.popPc.toLocaleString()}`);
  say(`- floating point (VFP) instructions: ${a.vfp.toLocaleString()} (${pct(a.vfp, a.words)}); atomics (LDREX/STREX): ${a.ldrexStrex}; coprocessor writes: ${a.mcr}`);
  say(`- kernel calls in code: ${a.svc} sites, ${a.svcs.size} distinct (${[...a.svcs.keys()].sort((x, y) => x - y).map(n => '0x' + n.toString(16)).join(' ')})`);
};
report(main);

// service names the program asks for at run time (srv:GetServiceHandle strings)
const KNOWN = ['srv:', 'APT:U', 'APT:A', 'fs:USER', 'gsp::Gpu', 'gsp::Lcd', 'hid:USER', 'hid:SPVR', 'dsp::DSP', 'nwm::UDS', 'nwm::UDS', 'ndm:u', 'ac:u', 'ac:i', 'cfg:u', 'cfg:s', 'ptm:u', 'ptm:sysm', 'y2r:u', 'cam:u', 'mic:u', 'ir:USER', 'ir:rst', 'ldr:ro', 'frd:u', 'act:u', 'boss:U', 'news:u', 'cecd:u', 'soc:U', 'ssl:C', 'http:C', 'nim:aoc', 'am:app', 'csnd:SND', 'pxi:dev', 'mvd:STD', 'qtm:u', 'qtm:s', 'mcu::HWC', 'pm:app', 'ns:s', 'err:f', 'dlp:SRVR', 'dlp:CLNT', 'ps:ps', 'gsp::Gpu'];
const strings = code.toString('latin1');
const used = [...new Set(KNOWN.filter(s => strings.includes(s + '\0') || strings.includes(s)))];
say(`\nService names found in the code: ${used.join(', ')}`);
const wireless = used.includes('nwm::UDS');
say(`Local wireless (nwm::UDS): ${wireless ? 'YES: multiplayer goes through 3DS local wireless' : 'not found in main program'}`);

// ---------- RomFS: assets and code modules (CRO) ----------
const ivfc = read(romfsOff, 0x60);
if (ascii(ivfc, 0, 4) !== 'IVFC') { say('\nRomFS: missing or not IVFC'); }
else {
  const masterHash = ivfc.readUInt32LE(0x08), l3log = ivfc.readUInt32LE(0x4c);
  const align = (v, a) => Math.ceil(v / a) * a;
  const l3 = romfsOff + align(0x60 + masterHash, 1 << l3log);
  const h = read(l3, 0x28);
  const dirMetaOff = l3 + h.readUInt32LE(0x0c), dirMetaLen = h.readUInt32LE(0x10);
  const fileMetaOff = l3 + h.readUInt32LE(0x1c), fileMetaLen = h.readUInt32LE(0x20), dataOff = l3 + h.readUInt32LE(0x24);
  const dm = read(dirMetaOff, dirMetaLen), fm = read(fileMetaOff, fileMetaLen);
  const files = [];
  const name16 = (b, o, n) => b.subarray(o, o + n).toString('utf16le');
  const walkDir = (off, path) => {
    const firstDir = dm.readUInt32LE(off + 8), firstFile = dm.readUInt32LE(off + 12);
    for (let f = firstFile; f !== 0xffffffff; f = fm.readUInt32LE(f + 4)) {
      const nlen = fm.readUInt32LE(f + 0x1c);
      files.push({ path: path + name16(fm, f + 0x20, nlen), off: dataOff + Number(fm.readBigUInt64LE(f + 8)), size: Number(fm.readBigUInt64LE(f + 0x10)) });
    }
    for (let d = firstDir; d !== 0xffffffff; d = dm.readUInt32LE(d + 4)) {
      const nlen = dm.readUInt32LE(d + 0x14);
      walkDir(d, path + name16(dm, d + 0x18, nlen) + '/');
    }
  };
  walkDir(0, '/');
  const total = files.reduce((n, f) => n + f.size, 0);
  const byExt = new Map();
  for (const f of files) { const e = (f.path.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '(none)').toLowerCase(); const x = byExt.get(e) ?? { n: 0, size: 0 }; x.n++; x.size += f.size; byExt.set(e, x); }
  say(`\n## RomFS (assets): ${files.length.toLocaleString()} files, ${kb(total)}`);
  say([...byExt].sort((a, b) => b[1].size - a[1].size).slice(0, 12).map(([e, x]) => `- .${e}: ${x.n} files, ${kb(x.size)}`).join('\n'));
  const cros = files.filter(f => /\.cro$/i.test(f.path) || /\.crs$/i.test(f.path) || /\.crr$/i.test(f.path));
  say(`\n## Code modules loaded at run time (CRO/CRS/CRR): ${cros.length}`);
  let croCode = 0;
  const croStats = [];
  for (const c of cros) {
    if (!/\.cro$/i.test(c.path)) { say(`- ${c.path} ${kb(c.size)}`); continue; }
    const hdr = read(c.off, 0x138);
    const codeOff = hdr.readUInt32LE(0xb0), codeSize = hdr.readUInt32LE(0xb4);
    croCode += codeSize;
    const body = read(c.off + codeOff, codeSize);
    const a = analyse(body, codeSize, c.path);
    croStats.push(a);
    say(`- ${c.path}: ${kb(c.size)} file, ${kb(codeSize)} code, ~${a.functions} functions`);
    if (extract) { mkdirSync(join('3ds-work', 'cro'), { recursive: true }); writeFileSync(join('3ds-work', 'cro', c.path.split('/').pop()), read(c.off, c.size)); }
  }
  if (croStats.length) {
    const sum = k => croStats.reduce((n, a) => n + a[k], 0);
    say(`\nAll CRO code: ${kb(croCode)}, ~${sum('functions').toLocaleString()} functions, indirect jumps ${(sum('bxReg') + sum('blxReg') + sum('ldrPc')).toLocaleString()}, VFP ${sum('vfp').toLocaleString()}`);
  }
  // GPU shader binaries (PICA200 "DVLB") stored loose
  const shaders = files.filter(f => /\.(shbin|bcsdr)$/i.test(f.path));
  say(`Loose GPU shader files: ${shaders.length}`);
}

say(`\n## Total code a recompiler must translate\n\nmain program ${kb(text.size)} + run-time modules (above)`);
mkdirSync('3ds-work', { recursive: true });
writeFileSync(join('3ds-work', 'report.md'), out.join('\n') + '\n');
if (extract) writeFileSync(join('3ds-work', 'code.bin'), code);
console.log('\nreport: 3ds-work/report.md');
