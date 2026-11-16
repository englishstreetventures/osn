import { crc32 } from "node:zlib";

/**
 * A ZIP archive written one whole entry at a time, every entry stored rather
 * than compressed, for the whole-wedding download (`services/wedding-archive.ts`).
 *
 * fflate's streaming `Zip` writes the container — local headers, data
 * descriptors, the central directory, UTF-8 names — and each entry is handed
 * to it through its public `ZipInputFile` interface with its size and CRC-32
 * already known. The CRC comes from `node:zlib`, which workerd and Bun both
 * implement natively, so an entry costs the Worker a copy of its bytes and no
 * per-byte JavaScript. Storing is the point: the files a wedding holds are
 * images that do not compress, and deflating the CSVs would put the CPU back.
 *
 * fflate always writes a data descriptor after an entry, and writes no ZIP64
 * records, so an archive must stay under 4 GiB (the caller's byte limit keeps
 * it far below). Readers that use the central directory — the built-in tools
 * on Windows and macOS, `unzip`, Python's `zipfile` — open it; a streaming
 * reader that refuses a stored entry with a data descriptor (Java's
 * `ZipInputStream`) does not.
 */
import { Zip, type ZipInputFile } from "fflate";

/** Gathers what fflate emits during one call, so each call hands back its own bytes. */
export class StoredZip {
  private readonly zip: Zip;
  private chunks: Uint8Array[] = [];
  private failure: Error | null = null;

  constructor() {
    this.zip = new Zip((err, chunk) => {
      if (err) this.failure = err;
      else this.chunks.push(chunk);
    });
  }

  /** Adds `bytes` as the entry `name`, last modified at `mtime`; answers the bytes the archive gained. */
  add(name: string, bytes: Uint8Array, mtime: Date): Uint8Array[] {
    // fflate takes bytes over a plain ArrayBuffer: a view of one is passed on
    // as it is, and anything else (a shared buffer) is copied.
    const data =
      bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    const entry: ZipInputFile = {
      filename: name,
      size: data.byteLength,
      crc: crc32(data) >>> 0,
      compression: 0,
      mtime,
    };
    this.zip.add(entry);
    // `Zip.add` installs `ondata`; one call with `final` writes the data and
    // its descriptor.
    entry.ondata?.(null, data, true);
    return this.take();
  }

  /** Writes the central directory; answers the archive's last bytes. */
  end(): Uint8Array[] {
    this.zip.end();
    return this.take();
  }

  private take(): Uint8Array[] {
    if (this.failure) throw this.failure;
    const out = this.chunks;
    this.chunks = [];
    return out;
  }
}
