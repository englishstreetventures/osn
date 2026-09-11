#!/usr/bin/env bun
/**
 * Counts warning-severity diagnostics from an oxlint `--format=json` report.
 *
 * `--format=json` gives one object per diagnostic with an explicit
 * `"severity": "warning" | "error"` field, stamped by oxlint itself rather
 * than inferred from text — filtering on that field is exact regardless of
 * message wording or output layout, unlike grepping the word "warning" over
 * the human-readable output (which that format can itself contain inside a
 * rule's own message or a file path). See scripts/guard-lint-warnings.sh's
 * own comment for why the human-readable form has no summary line to count
 * instead.
 *
 * scripts/guard-lint-warnings.sh runs oxlint itself (real invocation, real
 * config) and hands this script the resulting JSON file path — this module
 * owns only the counting, so it can be unit-tested against a fixture report
 * with no oxlint invocation at all. See scripts/tests/lint-warning-count.test.ts
 * (the pure functions below) and .cli.test.ts (this file's CLI entry point).
 */

export interface OxlintDiagnostic {
  readonly severity?: unknown;
  readonly code?: unknown;
}

export interface OxlintReport {
  readonly diagnostics?: readonly OxlintDiagnostic[];
}

export interface WarningCount {
  readonly total: number;
  // Highest count first, so the guard's over-ceiling message can print the
  // rules most likely to be the new addition without the caller sorting.
  readonly byRule: ReadonlyArray<readonly [string, number]>;
}

/**
 * Filters an oxlint report's diagnostics down to `severity === "warning"`
 * and groups the survivors by rule `code`. A diagnostic with no string
 * `code` (defensive only — oxlint always sets one) groups under
 * `"(unknown rule)"` rather than being dropped, so the total stays exact
 * even if that ever happens.
 */
export function countWarnings(report: OxlintReport): WarningCount {
  const diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  const warnings = diagnostics.filter((d) => d != null && d.severity === "warning");

  const byRuleMap = new Map<string, number>();
  for (const w of warnings) {
    const code = typeof w.code === "string" && w.code.length > 0 ? w.code : "(unknown rule)";
    byRuleMap.set(code, (byRuleMap.get(code) ?? 0) + 1);
  }
  const byRule = [...byRuleMap.entries()].toSorted((a, b) => b[1] - a[1]);

  return { total: warnings.length, byRule };
}

if (import.meta.main) {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    process.stderr.write("usage: lint-warning-count.ts <oxlint-json-report-path>\n");
    process.exit(1);
  }

  let raw: string;
  try {
    raw = await Bun.file(jsonPath).text();
  } catch (err) {
    process.stderr.write(
      `lint-warning-count.ts: could not read ${jsonPath}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  let parsed: OxlintReport;
  try {
    parsed = JSON.parse(raw) as OxlintReport;
  } catch (err) {
    process.stderr.write(
      `lint-warning-count.ts: ${jsonPath} was not valid JSON: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  const { total, byRule } = countWarnings(parsed);
  process.stdout.write(`${total}\n`);
  for (const [code, n] of byRule) {
    process.stdout.write(`${code} ${n}\n`);
  }
}
