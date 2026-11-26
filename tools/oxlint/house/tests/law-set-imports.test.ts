import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(dirname(packageDirectory)));

/** One oxlint diagnostic, cut down to the fields these tests assert on. */
type Diagnostic = {
  message: string;
  help?: string;
  code: string;
  severity: string;
  filename: string;
};

// A Bend law set (`<workspace>/laws/<topic>/`) ships in no build: the deploy
// map redeploys nothing for it and it needs no changeset. The root
// oxlintrc.json's `no-restricted-imports` override is what stops shipped code
// importing one. A later override that sets the same rule for an overlapping
// glob replaces it silently, and a mistyped glob matches nothing, so these run
// oxlint with the repository's own config over probes in real workspaces.
describe("no-restricted-imports keeps law sets out of shipped code", () => {
  const PROBE = "__law-set-import-probe.ts";
  const probes = {
    osnSource: `osn/api/src/${PROBE}`,
    cireSource: `cire/api/src/${PROBE}`,
    osnTests: `osn/api/tests/${PROBE}`,
  };
  // A side-effect import of a model that exists, so the probe type-checks if
  // a concurrent `tsc` happens to see it.
  const source = `import "../laws/account-deletion/model.mjs";\n`;

  let hits: Diagnostic[] = [];

  beforeAll(() => {
    for (const path of Object.values(probes)) writeFileSync(join(repoRoot, path), source);
    const result = Bun.spawnSync({
      cmd: [
        "bunx",
        "--bun",
        "oxlint",
        "-c",
        join(repoRoot, "oxlintrc.json"),
        "--format=json",
        ...Object.values(probes),
      ],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(result.stdout.toString());
    hits = (parsed.diagnostics ?? []).filter((d) => d.code === "eslint(no-restricted-imports)");
  }, 60_000);

  afterAll(() => {
    for (const path of Object.values(probes)) rmSync(join(repoRoot, path), { force: true });
  });

  const inFile = (path: string) => hits.filter((d) => d.filename.endsWith(path));

  it("refuses a law-set import in osn-api's src/", () => {
    const found = inFile(probes.osnSource);
    expect(found.map((d) => d.severity)).toEqual(["error"]);
    expect(found[0]?.help).toContain("A Bend law set ships in nothing");
  });

  it("refuses it in another product's src/", () => {
    expect(inFile(probes.cireSource).map((d) => d.severity)).toEqual(["error"]);
  });

  it("allows the same import from tests/", () => {
    expect(inFile(probes.osnTests)).toEqual([]);
  });
});
