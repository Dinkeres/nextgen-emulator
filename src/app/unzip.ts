// Minimal ZIP reader: lists entries from the central directory and inflates one with the
// platform's DecompressionStream. Enough for ROM archives; no encryption/ZIP64.

export interface ZipEntry { name: string; method: number; compSize: number; size: number; offset: number }

export function zipEntries(buf: ArrayBuffer): ZipEntry[] {
  const v = new DataView(buf);
  // end of central directory record: scan back over a possible comment
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP file.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory.');
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    if (!name.endsWith('/')) out.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function zipRead(buf: ArrayBuffer, e: ZipEntry): Promise<Uint8Array> {
  const v = new DataView(buf);
  if (v.getUint32(e.offset, true) !== 0x04034b50) throw new Error('Corrupt ZIP entry.');
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return data.slice();
  if (e.method !== 8) throw new Error(`Unsupported ZIP compression (method ${e.method}).`);
  const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  return new Uint8Array(out);
}
