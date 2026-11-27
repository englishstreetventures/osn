// No file a product build reads may name a Bend law set: the deploy map and
// the changeset check treat a change inside `<workspace>/laws/<topic>/` as
// shipping nothing, which is true only while nothing that ships reads one.
// oxlint refuses the import from a workspace's `src/`
// (tools/oxlint/house/tests/law-set-imports.test.ts); this covers what oxlint
// does not read.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lawSetReferences, scanned } from "../lib/law-set-references";

const root = join(import.meta.dir, "..", "..");
const TOPS = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces as string[])
  .filter((glob) => glob.endsWith("/*"))
  .map((glob) => glob.slice(0, -2));

describe("lawSetReferences finds a law set named", () => {
  test.each([
    ["a static import", `import { step } from "../laws/account-deletion/model.mjs";`],
    ["a side-effect import", `import "../laws/x/model.mjs";`],
    ["a re-export", `export * from "../../laws/x/model.mjs";`],
    ["a dynamic import", `const m = await import("../laws/x/model.mjs");`],
    ["a require", `const m = require('../laws/x/model.mjs');`],
    ["another workspace's set", `import "../../../osn/api/laws/x/model.mjs";`],
    ["a package subpath", `import { step } from "@osn/api/laws/x/model.mjs";`],
    ["the second pattern of a glob", `import.meta.glob(["./a/*.ts", "../laws/**/*.mjs"]);`],
    ["an eager glob", `import.meta.globEager("../laws/x/*.bend");`],
    ["an Astro glob loader's base", `glob({ pattern: "**/*.md", base: "./laws/x" })`],
    ["an Astro file loader", `file("../laws/x/data.json")`],
    ["a URL built from the module", `new URL("../laws/x/LAWS.bend", import.meta.url)`],
    [
      "an import in an .astro frontmatter",
      `---\nimport { step } from "../../laws/x/model.mjs";\n---\n<p>{step}</p>`,
    ],
  ])("%s", (_, source) => {
    expect(lawSetReferences(source)).toHaveLength(1);
  });

  test.each([
    ["a folder whose name ends in laws", `import "../flaws/x.ts";`],
    ["a folder whose name starts with laws", `import "../lawsuit/x.ts";`],
    ["a plain string that is no module name", `const LAWS = "tests/laws/**/*.test.ts";`],
    ["the word in prose", `<p>Read the laws/ folder.</p>`],
  ])("but not %s", (_, source) => {
    expect(lawSetReferences(source)).toEqual([]);
  });
});

describe("scanned covers what a product build reads", () => {
  test.each([
    "osn/api/src/index.ts",
    "cire/landing/src/pages/index.astro",
    "cire/landing/astro.config.mjs",
    "cire/infra/alchemy.run.ts",
    "shared/ui/src/button.tsx",
  ])("%s is scanned", (path) => {
    expect(scanned(path, TOPS)).toBe(true);
  });

  test.each([
    "osn/api/tests/laws/model.ts",
    "osn/api/laws/account-deletion/model.mjs",
    "cire/api/src/__tests__/a.ts",
    "cire/api/src/a.test.ts",
    "osn/api/dist/index.js",
    "osn/api/README.md",
    "tools/lab/src/a.ts",
    "scripts/deploy-surfaces.ts",
  ])("%s is not", (path) => {
    expect(scanned(path, TOPS)).toBe(false);
  });
});

test("no file a product build reads names a law set", () => {
  const files = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .stdout.split("\0")
    .filter((path) => scanned(path, TOPS));
  // A filter that matched nothing would pass with nothing read.
  expect(files.length).toBeGreaterThan(500);
  expect(files.some((path) => path.endsWith(".astro"))).toBe(true);
  const found = files.flatMap((path) =>
    lawSetReferences(readFileSync(join(root, path), "utf8")).map((name) => `${path}: ${name}`),
  );
  expect(found).toEqual([]);
});
