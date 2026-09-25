import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

/**
 * The repo declares its browser floor once, in the root `.browserslistrc`.
 * This app's production build compiles to Vite's default target instead, and
 * nothing ties the two together: a Vite major moves its default on its own, and
 * the declared floor would go on describing browsers the build no longer
 * serves. This test is that tie. When it fails, decide the floor on purpose:
 * update `.browserslistrc` (and re-check the `lib` in
 * `cire/invites/tsconfig.json`), or pin `build.target` in `vite.config.ts`.
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const floorFile = resolve(appRoot, "../../.browserslistrc");

/** Vite's target names, as esbuild spells them, to browserslist's. */
const BROWSERSLIST_NAME: Readonly<Record<string, string>> = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  safari: "safari",
  ios: "ios_saf",
};

/** The query lines of `.browserslistrc`, comments and blank lines dropped. */
function declaredFloor(): string[] {
  return readFileSync(floorFile, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line.length > 0)
    .toSorted();
}

/** A Vite target list (`["chrome111", "safari16.4", …]`) as browserslist lines. */
function asBrowserslist(target: readonly string[]): string[] {
  return target
    .map((entry) => {
      const match = /^([a-z]+)(\d+(?:\.\d+)?)$/.exec(entry);
      const name = match ? BROWSERSLIST_NAME[match[1]!] : undefined;
      if (!match || !name) {
        throw new Error(`Vite target "${entry}" has no browserslist spelling here`);
      }
      return `${name} >= ${match[2]}`;
    })
    .toSorted();
}

describe("browser floor", () => {
  it("matches the target this app's client build compiles to", async () => {
    const config = await resolveConfig({ root: appRoot, logLevel: "silent" }, "build");
    const target = config.environments.client?.build.target;

    expect(Array.isArray(target)).toBe(true);
    expect(declaredFloor()).toEqual(asBrowserslist(target as string[]));
  });
});
