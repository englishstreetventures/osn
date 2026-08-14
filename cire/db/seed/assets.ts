// Generates the placeholder images the dev seed's R2 keys point at, and uploads
// them to the dev bucket.
//
//   bun run --cwd cire/db assets:seed:dev
//
// The seed stores R2 object KEYS, not URLs (cire/api/src/services/invite-assets.ts
// mints them). A key with no object behind it is a broken image on every guest
// page — the seed alone cannot make the invite look finished. So this writes
// eight images, one per key the seed emits, straight into `cire-assets-dev`.
//
// The pictures are generated, not photographs: deterministic gradients tinted
// from the key itself, so each slot is visibly its own image and no real
// wedding photo is copied onto a tier anyone can reach. Re-running overwrites
// them byte-for-byte.
//
// Manual, not CI: R2 objects survive the D1 reset, so this is a one-off per
// bucket. See wiki/runbooks/dev-environment.md.

import { deflateSync } from "node:zlib";

import { customisation, events } from "./data";

// Only ever this bucket. The production bucket holds real couples' photographs;
// nothing here should be able to reach it even with a mistyped argument.
const DEV_BUCKET = "cire-assets-dev";

type Placeholder = {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  // Base hue in degrees. Picked per slot so the eight images are told apart at
  // a glance in the R2 dashboard and on the page.
  readonly hue: number;
};

export function placeholders(): readonly Placeholder[] {
  const eventSlots = Object.values(events).map((event, index) => ({
    key: event.eventImageKey,
    width: 1200,
    height: 800,
    hue: 20 + index * 47,
  }));

  return [
    { key: customisation.heroImageKey, width: 1920, height: 1080, hue: 210 },
    { key: customisation.storyImageKey, width: 1400, height: 1050, hue: 330 },
    { key: customisation.footerImageKey, width: 1400, height: 1050, hue: 150 },
    ...eventSlots,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// A very small PNG encoder
// ─────────────────────────────────────────────────────────────────────────────
//
// Eight fixed placeholder images do not justify an image dependency in a
// database package. PNG's baseline is small enough to write out: signature,
// IHDR, one zlib-compressed IDAT of filter-0 scanlines, IEND.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    // The mask keeps the index inside 0-255, so the table lookup is total.
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// `pixel(x, y)` returns [r, g, b], each 0-255.
function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
): Uint8Array {
  // One filter byte (0 = None) then 3 bytes per pixel, per scanline.
  const raw = new Uint8Array(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  // 10-12: compression 0, filter 0, interlace 0 — all already zero.

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// Muted, photo-ish colour from a hue and two 0-1 positions. Deliberately low
// saturation: a placeholder should read as "image missing on purpose", not as a
// design choice someone has to undo.
function hsl(
  hue: number,
  saturation: number,
  lightness: number,
): readonly [number, number, number] {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = lightness - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)] as const;
}

export function render(spec: Placeholder): Uint8Array {
  const { width, height, hue } = spec;
  return encodePng(width, height, (x, y) => {
    const u = x / width;
    const v = y / height;
    // Diagonal wash plus a soft band, so a crop taken from any corner still
    // looks like a different part of one picture.
    const wash = 0.34 + 0.3 * (1 - v) + 0.08 * Math.sin((u + v) * Math.PI * 1.5);
    const band = 0.04 * Math.sin(v * Math.PI * 6);
    return hsl(hue + 24 * u, 0.16, Math.min(0.92, Math.max(0.16, wash + band)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload
// ─────────────────────────────────────────────────────────────────────────────

async function upload(spec: Placeholder, dir: string): Promise<void> {
  const file = `${dir}/${spec.key.replaceAll("/", "_")}.png`;
  await Bun.write(file, render(spec));

  const proc = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "r2",
      "object",
      "put",
      `${DEV_BUCKET}/${spec.key}`,
      `--file=${file}`,
      "--content-type=image/png",
      "--remote",
    ],
    { cwd: new URL("../../api", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" },
  );

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`wrangler r2 object put failed for ${spec.key} (exit ${code})`);
  }
}

if (import.meta.main) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/cire-assets-`);

  const specs = placeholders();
  console.log(`Uploading ${specs.length} placeholder images to ${DEV_BUCKET}…`);
  for (const spec of specs) {
    // Serially: eight small files, and one failure should stop rather than
    // race seven more uploads into a bucket that is refusing them.
    await upload(spec, dir);
    console.log(`  ✓ ${spec.key} (${spec.width}×${spec.height})`);
  }
  console.log("Done. R2 objects outlive the D1 reset — re-run only after recreating the bucket.");
}
