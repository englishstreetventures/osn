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
 * such a read reappears in a Worker's `src/` outside this package. It runs as
 * this package's `test:repo` task, which turbo reruns when a scanned tree
 * changes (`turbo.json` here).
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

const OFFENDER = /[\w)\]]\.(changes|rowsAffected)\b/;

describe("no raw rows-affected reads outside @shared/db-utils", () => {
  it("every affected-row read in a Worker src tree goes through rowsChanged()", () => {
    const offenders: string[] = [];
    for (const rel of SCANNED) {
      for (const file of tsFiles(join(REPO_ROOT, rel))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((raw, i) => {
          if (OFFENDER.test(scrub(raw))) {
            offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}  ${raw.trim()}`);
          }
        });
      }
    }
    expect(
      offenders,
      `Use rowsChanged() from @shared/db-utils instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // turbo caches this package's tests on its own files. The scan reruns when a
  // scanned tree changes only because each tree is an input of `test:repo`;
  // a tree missing there replays a cached green over a new offender.
  it("every scanned tree is an input of this package's test:repo task", () => {
    const turbo = Bun.JSONC.parse(
      readFileSync(join(REPO_ROOT, "shared/db-utils/turbo.json"), "utf8"),
    ) as { tasks: Record<string, { inputs?: string[]; dependsOn?: string[] }> };
    expect(turbo.tasks["test:repo"]?.inputs).toEqual(
      expect.arrayContaining(SCANNED.map((tree) => `$TURBO_ROOT$/${tree}/**`)),
    );
    expect(turbo.tasks.test?.dependsOn).toContain("test:repo");
  });
});
