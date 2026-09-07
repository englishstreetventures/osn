import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginEntry = join(packageDirectory, "index.ts");

/** One oxlint diagnostic, cut down to the fields these tests assert on. */
type Diagnostic = {
  message: string;
  code: string;
  filename: string;
};

/**
 * Fixtures, keyed by file name. Whether a fixture's first line is blank is
 * load-bearing: the module-block exemption keys on a block opening at line 1,
 * so the fixtures testing it must not start with a newline.
 */
const fixtures = {
  // Two blocks, nothing between them. The first is attached to nothing.
  "zero-gap.ts": `
/** Describes something else entirely. */
/** Describes the constant. */
export const a = 1;
`,
  // The same defect with a blank line between, which is why the rule asks the
  // source code for the comments before a node rather than measuring line gaps.
  "blank-gap.ts": `
/** Describes something else entirely. */

/** Describes the constant. */
export const b = 2;
`,
  // Three blocks on one declaration, so the message must count them.
  "three-deep.ts": `
/** One. */
/** Two. */
/** Three. */
export const c = 3;
`,
  // A block opening the file documents the module, not whatever declaration
  // happens to come next. One module block plus one doc block is correct.
  "module-block.ts": `/** The module's own block, on line 1. */

/** Describes the constant. */
export const d = 4;
`,
  // The exemption drops the module block only. What is left is still a stack.
  "module-block-plus-stack.ts": `/** The module's own block, on line 1. */

/** Describes something else entirely. */
/** Describes the constant. */
export const e = 5;
`,
  // One doc block is the ordinary case.
  "single.ts": `
/** Describes the constant. */
export const f = 6;
`,
  // Only doc blocks stack. A line comment above a doc block is a normal shape
  // and must not be counted as one.
  "line-comment-above.ts": `
// An ordinary aside.
/** Describes the constant. */
export const g = 7;
`,
  // A plain block comment is not a doc block either.
  "plain-block-above.ts": `
/* An ordinary aside. */
/** Describes the constant. */
export const h = 8;
`,
} as const;

let fixtureDirectory: string;

/** Run oxlint over the fixture directory with only the house rule enabled. */
function lintFixtures(): Diagnostic[] {
  const result = Bun.spawnSync({
    cmd: [
      "bunx",
      "--bun",
      "oxlint",
      "-c",
      join(fixtureDirectory, "oxlintrc.json"),
      "--format=json",
      ".",
    ],
    cwd: fixtureDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(result.stdout.toString());
  return parsed.diagnostics ?? [];
}

/** The fixture file names the rule reported, deduplicated and sorted. */
function reportedFiles(diagnostics: Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))].toSorted();
}

describe("house/no-stacked-doc-block", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-stacked-doc-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-stacked-doc-block": "error" },
        jsPlugins: [{ name: "house", specifier: pluginEntry }],
      }),
    );
    for (const [name, source] of Object.entries(fixtures)) {
      writeFileSync(join(fixtureDirectory, name), source);
    }
    diagnostics = lintFixtures();
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("reports a stack whether or not a blank line separates the blocks", () => {
    expect(reportedFiles(diagnostics)).toEqual([
      "blank-gap.ts",
      "module-block-plus-stack.ts",
      "three-deep.ts",
      "zero-gap.ts",
    ]);
  });

  it("reports each stacked declaration once, not once per surplus block", () => {
    expect(diagnostics).toHaveLength(4);
  });

  it("counts the blocks in the message", () => {
    const message = diagnostics.find((d) => d.filename.endsWith("three-deep.ts"))?.message;
    expect(message).toContain("3 doc blocks");
  });

  it("exempts a block opening the file, and only that block", () => {
    expect(diagnostics.filter((d) => d.filename.endsWith("module-block.ts"))).toHaveLength(0);
    expect(
      diagnostics.filter((d) => d.filename.endsWith("module-block-plus-stack.ts")),
    ).toHaveLength(1);
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-stacked-doc-block)")).toBe(true);
  });
});
