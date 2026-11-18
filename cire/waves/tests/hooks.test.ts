/**
 * What a production bundle of the package must and must not carry.
 *
 * The test hooks (`window.__cireWaves`) are for development builds only: the
 * E2E flow holds the Gilded wave and reads the Distortion controller through
 * them against `astro dev`. A production bundle must not carry them, or any
 * page script could hold the organiser's screen in a transition.
 *
 * Upstream's MIT notice must ship with the vendored core it covers. A
 * minified Vite 8 build keeps no comment, legal ones included, so a notice
 * left in a header comment is gone from the chunk the organiser's browser
 * receives; the wrapper holds it as a string, and this fails a bundle
 * without it.
 *
 * Both entries are built with Vite as Astro builds them, once for production
 * and once for development, so the hook check can fail: the development
 * bundle must carry the hook the production one leaves out.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build, type Rollup } from "vite";
import solid from "vite-plugin-solid";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

async function bundle(mode: "production" | "development"): Promise<string> {
  // Vite reads production from NODE_ENV, which Vitest sets to `test`.
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    const out = (await build({
      configFile: false,
      logLevel: "silent",
      mode,
      root,
      plugins: [solid()],
      build: {
        write: false,
        minify: mode === "production",
        lib: {
          entry: {
            gilded: "src/gilded/gilded.ts",
            distortion: "src/distortion/DistortionWave.tsx",
          },
          formats: ["es"],
        },
        rollupOptions: { external: [/^solid-js/, /^@shared\//] },
      },
    })) as Rollup.RollupOutput[];
    return out
      .flatMap((o) => o.output)
      .map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
      .join("\n");
  } finally {
    process.env.NODE_ENV = was;
  }
}

let built: Promise<{ dev: string; prod: string }> | undefined;

/** Both bundles, built once, one after the other: each build reads NODE_ENV as it starts. */
function bundles(): Promise<{ dev: string; prod: string }> {
  built ??= (async () => {
    const dev = await bundle("development");
    const prod = await bundle("production");
    return { dev, prod };
  })();
  return built;
}

describe("a production bundle", () => {
  it("leaves out the test hooks a development bundle carries", async () => {
    const { dev, prod } = await bundles();
    expect(dev).toContain("__cireWaves");
    expect(prod).not.toContain("__cireWaves");
  }, 60_000);

  it("carries upstream's copyright and MIT notice, every line of it", async () => {
    const { prod } = await bundles();
    const licence = readFileSync(new URL("../vendor/LICENSE", import.meta.url), "utf8");
    // Whatever quotes the minifier picks, a line of the notice is one run of text.
    const text = prod.replaceAll('\\"', '"');
    const lines = licence.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toContain("Copyright (c) 2026 Jakub Antalik");
    for (const line of lines) expect(text).toContain(line);
  }, 60_000);
});
