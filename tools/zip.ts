/**
 * A byte-reproducible zip, written here rather than by shelling out to `zip`.
 *
 * Two reasons, and both were paid for once already in the project this grew out of. `zip` is
 * not declared or installed by anything in a Node toolchain, and a build that works on a
 * laptop and fails in CI over a missing binary is a bad trade for forty lines. And a
 * reproducible archive means two builds of the same content compare byte for byte, which is
 * how you tell "the pack is wrong" apart from "the pack is different" when one machine loads
 * it and another does not.
 *
 * Reproducibility comes from fixing everything that would otherwise vary: entries sorted by
 * path, a constant timestamp, no extra fields.
 */

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  path: string;
  data: Buffer;
}

/** A fixed DOS timestamp — 1980-01-01. Any constant works; varying is the thing to avoid. */
const DOS_TIME = 0;
const DOS_DATE = 33;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export function zip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store when deflating makes it bigger, which happens for tiny files and for PNGs.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(0x02014b50, 0);
    entryHeader.writeUInt16LE(20, 4); // version made by
    entryHeader.writeUInt16LE(20, 6); // version needed
    entryHeader.writeUInt16LE(0, 8);
    entryHeader.writeUInt16LE(method, 10);
    entryHeader.writeUInt16LE(DOS_TIME, 12);
    entryHeader.writeUInt16LE(DOS_DATE, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(body.length, 20);
    entryHeader.writeUInt32LE(raw.length, 24);
    entryHeader.writeUInt16LE(name.length, 28);
    entryHeader.writeUInt16LE(0, 30);
    entryHeader.writeUInt16LE(0, 32);
    entryHeader.writeUInt16LE(0, 34);
    entryHeader.writeUInt16LE(0, 36);
    entryHeader.writeUInt32LE(0, 38);
    entryHeader.writeUInt32LE(offset, 42);
    central.push(entryHeader, name);

    offset += header.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuf, end]);
}
