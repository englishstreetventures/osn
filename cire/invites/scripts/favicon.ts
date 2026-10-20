/**
 * Writes `public/favicon.ico` from `public/favicon.svg`:
 *
 *   bun run --cwd cire/invites favicon
 *
 * Browsers request `/favicon.ico` from any page that declares no icon. As a
 * file in `public/`, it is answered by Cloudflare's static-asset layer and the
 * Worker never runs. Run this again after any change to `public/favicon.svg`,
 * and commit both files.
 *
 * It adds no dependency. Playwright's Chromium (the one the browser tests use)
 * draws the SVG at each size, and this file writes the ICO, one PNG image per
 * size. The SVG names Georgia first, a system font that Linux lacks and that
 * the repo does not bundle, so a stylesheet rule here draws its text in the
 * bundled Cormorant Garamond italic instead, whatever fonts the machine has.
 * The same Chromium build on the same operating system writes the same bytes;
 * anti-aliasing differs between operating systems.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

const SIZES = [16, 32, 48] as const;
const FONT = "@fontsource/cormorant-garamond/files/cormorant-garamond-latin-400-italic.woff2";
const FAMILY = "CireFavicon";

const appRoot = resolve(import.meta.dirname, "..");
const svg = readFileSync(join(appRoot, "public/favicon.svg"), "utf8");
const font = readFileSync(createRequire(import.meta.url).resolve(FONT)).toString("base64");

/** An ICO file (header, directory, then the images) holding one PNG per size. */
function ico(images: readonly { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    head.writeUInt8(size, entry); // width; every size here is below 256
    head.writeUInt8(size, entry + 1); // height
    head.writeUInt16LE(1, entry + 4); // colour planes
    head.writeUInt16LE(32, entry + 6); // bits per pixel
    head.writeUInt32LE(png.length, entry + 8);
    head.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map(({ png }) => png)]);
}

// The browser tests read the same variable, for machines whose Chromium build
// does not match the pinned Playwright (see vitest.config.ts).
const executablePath = process.env.VITEST_BROWSER_EXECUTABLE_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // One copy of the SVG per size, stacked. A CSS property beats the SVG's
  // `font-family` attribute, so Georgia is never used. The font comes as a
  // `data:` URL because a page made by `setContent` cannot load a `file:` one.
  const copies = SIZES.map((size) =>
    svg.replace("<svg", `<svg id="icon-${size}" width="${size}" height="${size}"`),
  );
  await page.setContent(`<!doctype html>
<style>
  @font-face {
    font-family: "${FAMILY}";
    font-style: italic;
    font-weight: 400;
    src: url(data:font/woff2;base64,${font}) format("woff2");
  }
  html, body { margin: 0; background: transparent; }
  svg { display: block; }
  svg text { font-family: "${FAMILY}"; }
</style>
${copies.join("\n")}`);
  const faces = await page.evaluate(
    async (family) => (await document.fonts.load(`italic 15px "${family}"`)).length,
    FAMILY,
  );
  if (faces === 0)
    throw new Error(`${FONT} did not load; refusing to draw the icon in a fallback font`);

  // Playwright queues a page's screenshots and takes them one at a time.
  const images = await Promise.all(
    SIZES.map(async (size) => ({
      size,
      png: await page.locator(`#icon-${size}`).screenshot({ omitBackground: true }),
    })),
  );
  writeFileSync(join(appRoot, "public/favicon.ico"), ico(images));
  process.stdout.write(`wrote public/favicon.ico: ${SIZES.join(", ")} px\n`);
} finally {
  await browser.close();
}
