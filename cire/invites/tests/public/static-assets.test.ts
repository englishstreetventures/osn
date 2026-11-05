// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { API } from "typescript/sync";
import { describe, expect, it } from "vitest";

/**
 * `/robots.txt` and `/favicon.ico` are files in `public/`, so Cloudflare's
 * static-asset layer answers them and the Worker never runs. A one-segment
 * path with no file in `public/` and no page of its own reaches
 * `src/pages/[slug].astro`, which looks the segment up in cire-api as a
 * wedding slug. The E2E suite cannot see the difference:
 * it runs `astro dev`, where Vite serves `public/` itself. A missing file
 * fails the tests that read it.
 */
const appRoot = resolve(import.meta.dirname, "../..");
const publicDir = join(appRoot, "public");

describe("public/robots.txt", () => {
  const file = join(publicDir, "robots.txt");

  // The invite and gift pages stay out of search through `X-Robots-Tag:
  // noindex` (src/lib/security-headers.ts). A crawler that obeys a Disallow
  // never fetches the page to see that header, and can still index the bare
  // URL from a link elsewhere.
  it("lets every crawler fetch every path and disallows nothing", () => {
    const rules = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(rules).toEqual(["User-agent: *", "Allow: /"]);
  });
});

/** One image in an ICO file's directory, with the bytes it points at. */
interface IcoImage {
  width: number;
  height: number;
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads an ICO's header and directory; throws on anything a browser would refuse. */
function readIco(bytes: Buffer): IcoImage[] {
  if (bytes.length < 6) throw new Error("shorter than an ICO header");
  if (bytes.readUInt16LE(0) !== 0) throw new Error("reserved header field is not 0");
  if (bytes.readUInt16LE(2) !== 1) throw new Error("image type is not 1 (icon)");
  const count = bytes.readUInt16LE(4);
  if (count === 0) throw new Error("holds no images");
  const images: IcoImage[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) throw new Error(`directory entry ${i} runs past the file`);
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (offset + size > bytes.length) throw new Error(`image ${i} runs past the file`);
    images.push({
      // 0 in a directory entry means 256.
      width: bytes[entry] || 256,
      height: bytes[entry + 1] || 256,
      data: bytes.subarray(offset, offset + size),
    });
  }
  return images;
}

/** The decoded pixel at (x, y) of an 8-bit RGB or RGBA PNG, as `#rrggbb`. */
function pngPixel(png: Buffer, x: number, y: number): string {
  const width = png.readUInt32BE(16);
  const bitDepth = png[24];
  const colourType = png[25];
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (bitDepth !== 8 || channels === 0) throw new Error("not an 8-bit RGB or RGBA PNG");
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows: Buffer[] = [];
  for (let row = 0; row <= y; row += 1) {
    const start = row * (stride + 1);
    const filter = raw[start];
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    const above = rows[row - 1] ?? Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = above[i];
      const upLeft = i >= channels ? above[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[i] = (line[i] + predictor) & 0xff;
    }
    rows.push(line);
  }
  const at = x * channels;
  return `#${[0, 1, 2].map((i) => rows[y][at + i].toString(16).padStart(2, "0")).join("")}`;
}

/** The `fill` of the favicon's background `<rect>`. */
function svgGround(svg: string): string {
  const fill = /<rect\b[^>]*\bfill="(#[0-9a-f]{6})"/i.exec(svg)?.[1];
  if (!fill) throw new Error("favicon.svg has no <rect> with a hex fill");
  return fill.toLowerCase();
}

/** `--color-bg: oklch(L% C H)` from a stylesheet, as `#rrggbb`. */
function oklchBgHex(css: string): string {
  const m = /--color-bg:\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(css);
  if (!m) throw new Error("--color-bg is not a literal oklch(L% C H)");
  const l = Number(m[1]) / 100;
  const c = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  return `#${linear
    .map((v) => {
      const x = Math.min(1, Math.max(0, v));
      const encoded = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

describe("public/favicon.svg", () => {
  it("fills the guest site's page background, --color-bg", () => {
    const css = readFileSync(join(appRoot, "src/styles/global.css"), "utf8");
    const svg = readFileSync(join(publicDir, "favicon.svg"), "utf8");
    expect(svgGround(svg)).toBe(oklchBgHex(css));
  });
});

describe("public/favicon.ico", () => {
  const file = join(publicDir, "favicon.ico");

  it("is an ICO of PNG images whose sizes match the directory", () => {
    const images = readIco(readFileSync(file));
    for (const image of images) {
      expect(image.data.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      // IHDR is the first chunk: width at byte 16, height at byte 20.
      expect([image.data.readUInt32BE(16), image.data.readUInt32BE(20)]).toEqual([
        image.width,
        image.height,
      ]);
    }
  });

  // `bun run favicon` writes the ICO from the SVG; an SVG edit that skips it
  // leaves browsers that ask for /favicon.ico showing the old ground.
  it("paints the colour favicon.svg fills, at an edge of the 32 px image", () => {
    const svg = readFileSync(join(publicDir, "favicon.svg"), "utf8");
    const image = readIco(readFileSync(file)).find((i) => i.width === 32);
    if (!image) throw new Error("no 32 px image");
    expect(pngPixel(image.data, 2, 16)).toBe(svgGround(svg));
  });

  it("holds the 16 and 32 px images tabs and bookmarks use", () => {
    const sizes = readIco(readFileSync(file)).map((image) => image.width);
    expect(sizes).toEqual(expect.arrayContaining([16, 32]));
  });
});

describe("the asset layer answers before the Worker", () => {
  it("wrangler.jsonc does not run the Worker ahead of static assets", () => {
    const path = join(appRoot, "wrangler.jsonc");
    // TypeScript's config reader, because the file is JSONC (comments allowed).
    using api = new API({ cwd: appRoot });
    const { config, error } = api.readConfigFile(path);
    expect(error).toBeUndefined();
    const { assets } = config as { assets?: { run_worker_first?: boolean } };
    expect(assets?.run_worker_first ?? false).toBe(false);
  });

  // `@cloudflare/vite-plugin` copies `public/.assetsignore` into the one it
  // writes to `dist/client/`, and Cloudflare does not upload what it lists.
  it("public/ has no .assetsignore that could leave either file out of the upload", () => {
    expect(
      existsSync(join(publicDir, ".assetsignore")),
      "a public/.assetsignore must not list robots.txt or favicon.ico; check it, then change this test",
    ).toBe(false);
  });
});
