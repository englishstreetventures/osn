import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The installed alchemy's root directory, as this package resolves it: the
 * tests of the repository's alchemy patch load its `src/` and `lib/` copies
 * from here by computed path, which keeps the type-checker out of alchemy's
 * source.
 */
export function alchemyDir(): string {
  let dir = dirname(createRequire(join(packageDir, "index.js")).resolve("alchemy"));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: string }).name === "alchemy"
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no alchemy package.json above its entry point");
    dir = parent;
  }
}
