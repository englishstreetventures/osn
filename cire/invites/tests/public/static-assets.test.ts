// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
