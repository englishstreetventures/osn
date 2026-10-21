import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/** The Alchemy release whose source this package's builders were checked against. */
const AUDITED_ALCHEMY = "2.0.0-beta.83";

type Manifest = {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8")) as Manifest;

/** The installed package `name` as `fromDir` resolves it: its directory and manifest. */
function installed(
  name: string,
  fromDir: string,
): { readonly dir: string; readonly manifest: Manifest } {
  let dir = dirname(createRequire(join(fromDir, "index.js")).resolve(name));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = readManifest(candidate);
      if (manifest.name === name) return { dir, manifest };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json for ${name} above ${fromDir}`);
    dir = parent;
  }
}

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const own = readManifest(join(packageDir, "package.json"));

describe("pinned Alchemy", () => {
  test("declares and installs the audited release", () => {
    expect(own.dependencies?.alchemy).toBe(AUDITED_ALCHEMY);
    expect(installed("alchemy", packageDir).manifest.version).toBe(AUDITED_ALCHEMY);
  });

  test("the lockfile resolves exactly one Effect, the one this package pins", () => {
    // `bun.lock` names each resolved copy as `"effect@<version>"`; a second
    // copy appears as another version under a nested key such as
    // `"@effect/sql-d1/effect"`.
    const lock = readFileSync(join(packageDir, "..", "..", "bun.lock"), "utf8");
    const versions = new Set([...lock.matchAll(/"effect@([^"]+)"/g)].map((match) => match[1]));
    expect([...versions]).toEqual([own.dependencies?.effect]);
  });
});
