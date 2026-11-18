/**
 * The test hooks (`window.__cireWaves`) are for development builds only: the
 * E2E flow holds the Gilded wave and reads the Distortion controller through
 * them against `astro dev`. A production bundle must not carry them, or any
 * page script could hold the organiser's screen in a transition.
 *
 * Both entries are built with Vite as Astro builds them, once for production
 * and once for development, so the check can fail: the development bundle
 * must carry the hook the production one leaves out.
 */

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

describe("test hooks", () => {
  it("are in a development bundle and absent from a production one", async () => {
    // One after the other: each build reads NODE_ENV as it starts.
    const dev = await bundle("development");
    const prod = await bundle("production");
    expect(dev).toContain("__cireWaves");
    expect(prod).not.toContain("__cireWaves");
  }, 60_000);
});
