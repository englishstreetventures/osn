import { crc32 } from "node:zlib";

/** One entry of a ZIP, as its central directory lists it. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** The CRC-32 the central directory records. */
  readonly crc: number;
  /** Whether {@link crc} is the CRC-32 of {@link bytes}. */
  readonly crcMatches: boolean;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Reads a stored (uncompressed) ZIP the way a desktop unzip tool does: from
 * the end-of-central-directory record, through each central-directory entry,
 * to its local header and data. Throws on anything else — a missing end
 * record (a cut archive), a compressed entry, a bad signature — so a test of
 * the archive fails on any of them. Each entry's CRC-32 is computed with
 * `node:zlib` and compared with the one the directory records.
 */
export function readZip(archive: Uint8Array): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let at = archive.byteLength - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("no end-of-central-directory record: the archive is cut");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error(`bad central entry ${i}`);
    const method = view.getUint16(at + 10, true);
    if (method !== 0) throw new Error(`entry ${i} is compressed (method ${method})`);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== LOCAL) throw new Error(`bad local header for ${name}`);
    const dataStart =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const bytes = archive.slice(dataStart, dataStart + size);
    entries.push({ name, bytes, crc, crcMatches: crc32(bytes) >>> 0 === crc });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Every entry by name, its bytes as UTF-8 text. */
export function zipTexts(archive: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder();
  return new Map(readZip(archive).map((entry) => [entry.name, decoder.decode(entry.bytes)]));
}
