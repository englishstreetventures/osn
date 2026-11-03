import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

const PROVIDER = "@alchemy.run/cloudflare";

/**
 * The installed Alchemy Cloudflare provider's root directory, as this package
 * resolves it: the tests of the repository's patch to it, and of what its
 * bundler sets, load its `src/` and `lib/` copies from here by computed path,
 * which keeps the type-checker out of its source.
 */
export function cloudflareDir(): string {
  let dir = dirname(createRequire(join(packageDir, "index.js")).resolve(PROVIDER));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: string }).name === PROVIDER
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no ${PROVIDER} package.json above its entry point`);
    dir = parent;
  }
}
