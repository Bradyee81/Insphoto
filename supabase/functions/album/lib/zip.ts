// Minimal ZIP writer, store-only (no compression). Good enough for a bulk
// album export: the contents are already-compressed JPEGs/MP4s, so deflate
// would buy nothing and pulling in a compression dependency isn't worth it
// inside an Edge Function. Stretch item — see plan notes on §7.4.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dt =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dt };
}

interface Entry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

export class ZipBuilder {
  private chunks: Uint8Array[] = [];
  private entries: Entry[] = [];
  private offset = 0;
  private te = new TextEncoder();

  addFile(name: string, data: Uint8Array) {
    const nameBytes = this.te.encode(name);
    const crc = crc32(data);
    const { time, date } = dosDateTime(new Date());

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0, true); // flags
    header.setUint16(8, 0, true); // method: store
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true); // compressed size
    header.setUint32(22, data.length, true); // uncompressed size
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true); // extra length

    this.entries.push({ name: nameBytes, data, crc, offset: this.offset });
    this.chunks.push(new Uint8Array(header.buffer), nameBytes, data);
    this.offset += 30 + nameBytes.length + data.length;
  }

  build(): Uint8Array {
    const cdChunks: Uint8Array[] = [];
    let cdSize = 0;
    const { time, date } = dosDateTime(new Date());

    for (const entry of this.entries) {
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true); // version made by
      cd.setUint16(6, 20, true); // version needed
      cd.setUint16(8, 0, true); // flags
      cd.setUint16(10, 0, true); // method
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, entry.crc, true);
      cd.setUint32(20, entry.data.length, true);
      cd.setUint32(24, entry.data.length, true);
      cd.setUint16(28, entry.name.length, true);
      cd.setUint16(30, 0, true); // extra length
      cd.setUint16(32, 0, true); // comment length
      cd.setUint16(34, 0, true); // disk number start
      cd.setUint16(36, 0, true); // internal attrs
      cd.setUint32(38, 0, true); // external attrs
      cd.setUint32(42, entry.offset, true);

      cdChunks.push(new Uint8Array(cd.buffer), entry.name);
      cdSize += 46 + entry.name.length;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, this.entries.length, true);
    eocd.setUint16(10, this.entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, this.offset, true);
    eocd.setUint16(20, 0, true);

    const all = [...this.chunks, ...cdChunks, new Uint8Array(eocd.buffer)];
    const total = all.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of all) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}
