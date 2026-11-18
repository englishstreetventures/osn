/**
 * The repository patches the Alchemy Cloudflare provider's Worker upload
 * (`patches/@alchemy.run%2Fcloudflare@2.0.0-beta.85.patch`) so every full
 * script upload sends `keep_bindings: ["secret_text", "secret_key"]`, as
 * `wrangler deploy` does: Cloudflare keeps each secret the upload does not
 * name. Production stacks upload no secret at all (the inventory's `worker`
 * source), so this is what keeps every production secret through a deploy.
 * Each case reads the provider's `src/` copy, which Bun loads in a deploy, and
 * its `lib/` copy, so this file fails if the patch stops carrying the hunk.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { cloudflareDir } from "./support/cloudflare-dir";

const COPIES = [
  { copy: "src", path: "src/Workers/WorkerProvider.ts" },
  { copy: "lib", path: "lib/Workers/WorkerProvider.js" },
] as const;

const CLOUDFLARE_DIR = cloudflareDir();

/** What a deploy's script upload asks Cloudflare to keep: every secret it does not name. */
const KEPT = ["secret_text", "secret_key"];

describe("KS1: every full script upload keeps the secrets it does not name", () => {
  test.each(COPIES)(
    "$copy: KEPT_BINDING_TYPES names both secret binding types",
    async ({ path }) => {
      const module = (await import(/* @vite-ignore */ join(CLOUDFLARE_DIR, path))) as {
        readonly KEPT_BINDING_TYPES?: readonly string[];
      };
      expect(module.KEPT_BINDING_TYPES).toEqual(KEPT);
    },
  );

  test.each(COPIES)(
    "$copy: the upload metadata sets keepBindings from it, and nothing sets it otherwise",
    ({ path }) => {
      const source = readFileSync(join(CLOUDFLARE_DIR, path), "utf8");
      const assignments = [...source.matchAll(/keepBindings:\s*([^,\n]+)/g)].map((match) =>
        match[1]?.trim(),
      );
      // One upload metadata object names keepBindings; the versions upload,
      // taken only for a gradual rollout, which no stack declares, names none.
      expect(assignments).toEqual(["[...KEPT_BINDING_TYPES]"]);
    },
  );
});
