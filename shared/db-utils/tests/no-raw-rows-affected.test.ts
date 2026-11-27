import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guard for the D1-vs-bun:sqlite rows-affected trap.
 *
 * D1 reports affected rows under `meta.changes`; bun:sqlite reports `.changes`
 * at the top level and some drivers use `.rowsAffected`. Reading any of those
 * directly works in tests (bun:sqlite) and returns 0 in production (D1), which
 * turns a compare-and-swap gate such as refresh rotation into always-fail.
 * Every affected-row read goes through `rowsChanged()` in this package.
 *
 * CI runs tests on bun:sqlite, so it can NEVER reproduce the D1 mismatch — a new
 * direct `.changes` / `.rowsAffected` read would pass every test and only fail
 * in production. This scan is driver-independent: it fails the build the moment
 * such a read reappears in a Worker's `src/` outside this package, whether as a
 * member (`result.changes`), a bracket (`result["changes"]`) or a destructuring
 * of anything but a plain name (`const { changes } = await stmt.run()`). It
 * runs as this package's `test:repo` task, which turbo reruns when a scanned
 * tree or a Wrangler config changes (`turbo.json` here).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The Worker backends that run on D1 in production, and the shared packages
// whose storage those Workers run.
const SCANNED = [
  "osn/api/src",
  "cire/api/src",
  "zap/api/src",
  "pulse/api/src",
  "shared/billing/src",
];

// Where a Worker's Wrangler config sits, relative to the repository root.
const WRANGLER_CONFIGS = ["*/*/wrangler.toml", "*/*/wrangler.jsonc", "*/*/wrangler.json"];

function tsFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // A package that doesn't exist yet is not a failure.
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      // Test files legitimately build D1-shaped `{ changes }` result stubs.
      out.push(full);
    }
  }
  return out;
}

/** Strip line comments and string/template literals so span names like
 *  `withSpan("x.changes.y")` and prose in comments don't false-positive. */
function scrub(line: string): string {
  return line.replace(/\/\/.*$/, "").replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "");
}

/** A line of a block comment: blanked before the destructuring scan reads it. */
const BLOCK_COMMENT_LINE = /^\s*(?:\*|\/\*)/;

const MEMBER = /[\w)\]]\.(changes|rowsAffected)\b/;
const BRACKET = /\[\s*(['"`])(?:changes|rowsAffected)\1\s*\]/;
/** A destructuring pattern, nested at most one level, and the start of what it is assigned from. */
const DESTRUCTURE = /\{((?:[^{}]|\{[^{}]*\})*)\}\s*=(?![=>])\s*([^\n;]*)/g;
const NAMES = /\b(?:changes|rowsAffected)\b/;
/** A plain name, optionally asserted to a type: a notice or an input object, never a driver call. */
const PLAIN_NAME = /^[A-Za-z_$][\w$]*(?:\s+as\s+[\w$.<>[\], ]+)?\s*$/;

/** Every raw rows-affected read in `file`, as `path:line  text`. */
function offendersIn(file: string): string[] {
  const where = relative(REPO_ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  const out: string[] = [];
  lines.forEach((raw, i) => {
    if (MEMBER.test(scrub(raw)) || BRACKET.test(raw.replace(/\/\/.*$/, ""))) {
      out.push(`${where}:${i + 1}  ${raw.trim()}`);
    }
  });
  const code = lines.map((raw) => (BLOCK_COMMENT_LINE.test(raw) ? "" : scrub(raw))).join("\n");
  for (const match of code.matchAll(DESTRUCTURE)) {
    const [whole, pattern = "", source = ""] = match;
    if (!NAMES.test(pattern) || PLAIN_NAME.test(source)) continue;
    const line = code.slice(0, match.index).split("\n").length;
    out.push(`${where}:${line}  ${whole.replaceAll(/\s+/g, " ").trim()}`);
  }
  return out;
}

describe("no raw rows-affected reads outside @shared/db-utils", () => {
  it("every affected-row read in a Worker src tree goes through rowsChanged()", () => {
    const offenders = SCANNED.flatMap((rel) => tsFiles(join(REPO_ROOT, rel)).flatMap(offendersIn));
    expect(
      offenders,
      `Use rowsChanged() from @shared/db-utils instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // A Worker that binds D1 and is missing from SCANNED is never scanned.
  it("every Worker whose Wrangler config binds D1 has its src tree scanned", () => {
    const bindsD1 = WRANGLER_CONFIGS.flatMap((pattern) => [
      ...new Bun.Glob(pattern).scanSync(REPO_ROOT),
    ])
      .filter((rel) => !rel.startsWith("node_modules/"))
      .filter((rel) => readFileSync(join(REPO_ROOT, rel), "utf8").includes("d1_databases"));
    expect(bindsD1).not.toEqual([]);
    expect(SCANNED).toEqual(expect.arrayContaining(bindsD1.map((rel) => `${dirname(rel)}/src`)));
  });

  // turbo caches this package's tests on its own files. The scan reruns when a
  // scanned tree or a Wrangler config changes only because each is an input
  // of `test:repo`; one missing there replays a cached green over a new
  // offender.
  it("every scanned tree and Wrangler config is an input of this package's test:repo task", () => {
    const turbo = Bun.JSONC.parse(
      readFileSync(join(REPO_ROOT, "shared/db-utils/turbo.json"), "utf8"),
    ) as { tasks: Record<string, { inputs?: string[]; dependsOn?: string[] }> };
    expect(turbo.tasks["test:repo"]?.inputs).toEqual(
      expect.arrayContaining([
        ...SCANNED.map((tree) => `$TURBO_ROOT$/${tree}/**`),
        ...WRANGLER_CONFIGS.map((pattern) => `$TURBO_ROOT$/${pattern}`),
      ]),
    );
    expect(turbo.tasks.test?.dependsOn).toContain("test:repo");
  });
});
