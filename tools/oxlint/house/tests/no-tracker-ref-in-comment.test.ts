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
  labels?: { span: { offset: number; length: number } }[];
};

/**
 * Fixtures, keyed by file name. The rule reads comment text only, so a fixture
 * needs a comment and enough syntax to parse — nothing here is type-checked.
 * The reference shapes live in template literals, which are string content
 * rather than comments, so writing them here cannot trip the rule on this file.
 */
const fixtures = {
  "tracker-ref.ts": `
// Widened after osn-tracker#589 measured the fan-out.
export const width = 500;
`,
  // Three tags in three shapes the pre-review design would each have missed: a
  // parenthesised one mid-line, a two-digit one, and a tier outside the
  // security/perf pair.
  "finding-id.ts": `
// Bound checked at the edge (S-M1).
export const a = 1;
// Session rotation covered by C-M15.
export const b = 2;
// Regression fixture kept for T-S2.
export const c = 3;
`,
  // One tag at the start of its line, one mid-sentence.
  "phase-code.ts": `
// O3: short TTL for the challenge entry.
export const ttl = 120_000;
// Enforced during X1: the seed pass, before any request is served.
export const seeded = true;
`,
  // The shape that appears throughout the tree: a finding tag used as a label,
  // so its own trailing colon sits where a plan code's would. One reference,
  // and so exactly one diagnostic — the finding tag, not a plan code as well.
  "finding-id-as-label.ts": `
// S-M2: restrict CORS to a known origin allowlist.
export const origins = [];
`,
  // A standard that numbers its clauses the way a plan numbers its phases. The
  // citation is stable and is the kind of pointer the convention encourages, so
  // it must not report — while a real plan code in the same file still does.
  "normative-citation.ts": `
// Copenhagen Book M3: cap length at 255 to match the RFC 5321 mailbox limit.
export const maxEmailLength = 255;
// O3: enforced at the edge.
export const enforced = true;
`,
  // Two more citation styles this repo actually uses, beyond the Copenhagen
  // Book fixture above — neither should report.
  "normative-citation-other-standards.ts": `
// WCAG M1: contrast ratio floor for body text.
export const contrastFloor = 4.5;
// ISO M2: date fields are always this format.
export const dateFormat = "yyyy-MM-dd";
`,
  "narrative.ts": `
// This used to be a synchronous read.
export const a = 1;
// The delay was reported as "quite a wait" before the hold was budgeted.
export const b = 2;
// Still used by removeMember — not a fold target in this plan.
export const c = 3;
`,
  // Location precision: the tag sits on the block's fourth line, and that is
  // the line the diagnostic must point at — not the line the block opens on.
  "multiline-block.ts": `
/**
 * Caps fan-out width.
 *
 * Raised under S-H18 once the bind limit was measured.
 */
export const width = 500;
`,
  // Every line here is a near miss for one of the four patterns and must stay
  // clean: present-tense "reported as" is ordinary prose, a bare issue number
  // is a public cross-reference rather than a tracker finding, and neither
  // "Step 1:" nor a compiler code puts a digit where the phase-code pattern
  // needs one.
  "clean.ts": `
// Anything slower is reported as a timeout.
export const a = 1;
// Follows the approach in #123.
export const b = 2;
// Step 1: normalise, then compare.
export const c = 3;
// Silencing TS2345: the overload is the wrong one to widen.
export const d = 4;
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
  const stdout = result.stdout.toString();
  const parsed: { diagnostics?: Diagnostic[] } = JSON.parse(stdout);
  return parsed.diagnostics ?? [];
}

/** The fixture file names the rule reported, deduplicated and sorted. */
function reportedFiles(diagnostics: Diagnostic[]): string[] {
  return [...new Set(diagnostics.map((d) => d.filename.split("/").at(-1) ?? ""))].toSorted();
}

/** Every diagnostic reported against one fixture file. */
function forFixture(diagnostics: Diagnostic[], name: string): Diagnostic[] {
  return diagnostics.filter((d) => d.filename.endsWith(name));
}

/** The 1-indexed line each diagnostic points at, resolved against the fixture's own source. */
function reportedLines(diagnostics: Diagnostic[], name: string): number[] {
  const source = fixtures[name as keyof typeof fixtures];
  return forFixture(diagnostics, name)
    .map((d) => {
      const offset = d.labels?.[0]?.span.offset ?? 0;
      return source.slice(0, offset).split("\n").length;
    })
    .toSorted((a, b) => a - b);
}

describe("house/no-tracker-ref-in-comment", () => {
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), "house-tracker-ref-"));
    writeFileSync(
      join(fixtureDirectory, "oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        rules: { "house/no-tracker-ref-in-comment": "error" },
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

  it("reports every fixture carrying a rotting reference, and no others", () => {
    expect(reportedFiles(diagnostics)).toEqual([
      "finding-id-as-label.ts",
      "finding-id.ts",
      "multiline-block.ts",
      "narrative.ts",
      "normative-citation.ts",
      "phase-code.ts",
      "tracker-ref.ts",
    ]);
  });

  it("reports each reference separately rather than once per comment", () => {
    expect(forFixture(diagnostics, "finding-id.ts")).toHaveLength(3);
    expect(forFixture(diagnostics, "phase-code.ts")).toHaveLength(2);
    expect(forFixture(diagnostics, "narrative.ts")).toHaveLength(3);
    expect(forFixture(diagnostics, "tracker-ref.ts")).toHaveLength(1);
  });

  it("leaves a normative standard citation alone but still reports a real plan code", () => {
    const reported = forFixture(diagnostics, "normative-citation.ts");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("O3:");
  });

  it("reads a finding tag used as a label as one reference, not a plan code as well", () => {
    const reported = forFixture(diagnostics, "finding-id-as-label.ts");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("S-M2");
    expect(reported[0]?.message).toContain("review finding tag");
  });

  it("catches a tag mid-line, a two-digit number, and a tier beyond security and perf", () => {
    const messages = forFixture(diagnostics, "finding-id.ts").map((d) => d.message);
    expect(messages.join("\n")).toContain("S-M1");
    expect(messages.join("\n")).toContain("C-M15");
    expect(messages.join("\n")).toContain("T-S2");
  });

  it("points at the line the reference sits on, not the line its block opens on", () => {
    expect(reportedLines(diagnostics, "multiline-block.ts")).toEqual([5]);
  });

  it("stays quiet on prose that only resembles a reference", () => {
    expect(forFixture(diagnostics, "clean.ts")).toHaveLength(0);
  });

  it("catches all three narrative phrases, not just the first two", () => {
    const messages = forFixture(diagnostics, "narrative.ts").map((d) => d.message);
    expect(messages.some((m) => m.includes("narrates how the code got here"))).toBe(true);
    expect(forFixture(diagnostics, "narrative.ts")).toHaveLength(3);
  });

  it("exempts citation styles beyond the Copenhagen Book", () => {
    expect(forFixture(diagnostics, "normative-citation-other-standards.ts")).toHaveLength(0);
  });

  it("reports under the plugin's rule id", () => {
    expect(diagnostics.every((d) => d.code === "house(no-tracker-ref-in-comment)")).toBe(true);
  });
});
