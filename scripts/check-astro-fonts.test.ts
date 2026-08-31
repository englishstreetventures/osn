import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAstroFonts, familyNamesFromAstroConfig } from "./check-astro-fonts";

// Every test builds its own throwaway `dist/` under a fresh temp directory,
// tracked here so `afterEach` can remove it even when a test fails partway
// through building its fixture.
let currentDir: string | undefined;

afterEach(async () => {
  if (currentDir) {
    await rm(currentDir, { recursive: true, force: true });
    currentDir = undefined;
  }
});

async function makeDist(): Promise<string> {
  currentDir = await mkdtemp(join(tmpdir(), "check-astro-fonts-"));
  const distDir = join(currentDir, "dist");
  await mkdir(distDir, { recursive: true });
  return distDir;
}

test("a real build — non-empty fonts dir and an inlined @font-face — passes", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  await writeFile(join(distDir, "_astro", "fonts", "abc123.woff2"), "fake-woff2-bytes");
  await writeFile(
    join(distDir, "index.html"),
    `<html><head><style>@font-face{font-family:"Schibsted Grotesk";src:url(/_astro/fonts/abc123.woff2)}</style></head><body></body></html>`,
  );

  expect(await checkAstroFonts(distDir)).toEqual([]);
});

test("a real build — non-empty fonts dir and a standalone @font-face stylesheet — passes", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  await writeFile(join(distDir, "_astro", "fonts", "abc123.woff2"), "fake-woff2-bytes");
  await writeFile(
    join(distDir, "_astro", "fonts.a1b2c3.css"),
    `@font-face{font-family:"Schibsted Grotesk";src:url(/_astro/fonts/abc123.woff2)}`,
  );
  await writeFile(join(distDir, "index.html"), `<html><body></body></html>`);

  expect(await checkAstroFonts(distDir)).toEqual([]);
});

test("failure mode 1 — no fonts dir at all — fails even with real @font-face CSS", async () => {
  const distDir = await makeDist();
  await writeFile(
    join(distDir, "index.html"),
    `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}</style></head></html>`,
  );

  expect(await checkAstroFonts(distDir)).toEqual([
    {
      problem: `${join(distDir, "_astro", "fonts")} is missing or empty — no font files were emitted by the build`,
    },
  ]);
});

test("failure mode 1 — fonts dir exists but is empty — fails", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  await writeFile(
    join(distDir, "index.html"),
    `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}</style></head></html>`,
  );

  expect(await checkAstroFonts(distDir)).toEqual([
    {
      problem: `${join(distDir, "_astro", "fonts")} is missing or empty — no font files were emitted by the build`,
    },
  ]);
});

test("failure mode 2 — fonts dir has files but nothing emits @font-face — fails", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  // A stale file left behind by an unrelated step is not evidence of a real
  // font build — the guard still requires the CSS half.
  await writeFile(join(distDir, "_astro", "fonts", "leftover.woff2"), "stale-bytes");
  await writeFile(join(distDir, "index.html"), `<html><body>no fonts here</body></html>`);

  expect(await checkAstroFonts(distDir)).toEqual([
    {
      problem: `no "@font-face" rule found in any .css or .html file under ${distDir}`,
    },
  ]);
});

test("both failure modes at once report both findings", async () => {
  const distDir = await makeDist();
  await writeFile(join(distDir, "index.html"), `<html><body>fontless</body></html>`);

  expect(await checkAstroFonts(distDir)).toEqual([
    {
      problem: `${join(distDir, "_astro", "fonts")} is missing or empty — no font files were emitted by the build`,
    },
    {
      problem: `no "@font-face" rule found in any .css or .html file under ${distDir}`,
    },
  ]);
});

test("an @font-face rule nested under a subdirectory's .css file still counts", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  await writeFile(join(distDir, "_astro", "fonts", "abc123.woff2"), "fake-woff2-bytes");
  await mkdir(join(distDir, "login"), { recursive: true });
  await writeFile(
    join(distDir, "login", "index.html"),
    `<html><head><style>@font-face{font-family:"Cormorant Garamond"}</style></head></html>`,
  );

  expect(await checkAstroFonts(distDir)).toEqual([]);
});

// The config shape all three packages use, trimmed to what the parser reads.
const TWO_FAMILY_CONFIG = `
export default defineConfig({
  experimental: {
    fonts: [
      { name: "Schibsted Grotesk", cssVariable: "--font-ui", provider: fontProviders.google() },
      { name: "Cormorant Garamond", cssVariable: "--font-flair", provider: fontProviders.google() },
    ],
  },
});
`;

test("familyNamesFromAstroConfig reads every family in the fonts array", () => {
  expect(familyNamesFromAstroConfig(TWO_FAMILY_CONFIG)).toEqual([
    "Schibsted Grotesk",
    "Cormorant Garamond",
  ]);
});

test("familyNamesFromAstroConfig ignores a name: outside the fonts array", () => {
  const config = `
    export default defineConfig({
      site: { name: "not a font" },
      experimental: { fonts: [{ name: "Lato" }] },
    });
  `;
  expect(familyNamesFromAstroConfig(config)).toEqual(["Lato"]);
});

test("familyNamesFromAstroConfig finds nothing when there is no fonts array", () => {
  expect(familyNamesFromAstroConfig("export default defineConfig({});")).toEqual([]);
});

// S-M1 (found reviewing this branch): Astro drops a family whose metadata
// fetch failed and CONTINUES — it emits neither a real @font-face nor even the
// optimizedFallbacks rule for it. Every package here declares two families, so
// a partial outage leaves the surviving family satisfying both whole-build
// checks while the other silently vanishes.
test("a build missing ONE of two declared families is caught", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  await writeFile(join(distDir, "_astro", "fonts", "abc123.woff2"), "fake-woff2-bytes");
  await writeFile(
    join(distDir, "index.html"),
    `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}</style></head></html>`,
  );

  expect(await checkAstroFonts(distDir, TWO_FAMILY_CONFIG)).toEqual([
    {
      problem:
        'font family "Cormorant Garamond" is declared in the astro config but appears nowhere in the built CSS or HTML — its metadata fetch failed and Astro dropped it',
    },
  ]);
});

test("a build carrying both declared families passes", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  await writeFile(join(distDir, "_astro", "fonts", "abc123.woff2"), "fake-woff2-bytes");
  await writeFile(
    join(distDir, "index.html"),
    `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}@font-face{font-family:"Cormorant Garamond"}</style></head></html>`,
  );

  expect(await checkAstroFonts(distDir, TWO_FAMILY_CONFIG)).toEqual([]);
});

// A guard that quietly stops guarding when its input changes shape is worse
// than no guard, so an unparseable config fails rather than passes.
test("a config the parser cannot read fails rather than passing", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts"), { recursive: true });
  await writeFile(join(distDir, "_astro", "fonts", "abc123.woff2"), "fake-woff2-bytes");
  await writeFile(
    join(distDir, "index.html"),
    `<html><head><style>@font-face{font-family:"Schibsted Grotesk"}</style></head></html>`,
  );

  const findings = await checkAstroFonts(distDir, "export default defineConfig({});");
  expect(findings).toHaveLength(1);
  expect(findings[0]!.problem).toContain("could not read any font family name");
});

// S-L1: a bare recursive readdir returns subdirectories too, so an empty
// nested directory used to read as "fonts present".
test("an empty subdirectory under _astro/fonts does not count as a font file", async () => {
  const distDir = await makeDist();
  await mkdir(join(distDir, "_astro", "fonts", "schibsted"), { recursive: true });
  await writeFile(
    join(distDir, "index.html"),
    `<html><head><style>@font-face{font-family:"x"}</style></head></html>`,
  );

  expect(await checkAstroFonts(distDir)).toEqual([
    {
      problem: `${join(distDir, "_astro", "fonts")} is missing or empty — no font files were emitted by the build`,
    },
  ]);
});
