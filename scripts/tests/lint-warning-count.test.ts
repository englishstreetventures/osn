// Pure-function tests for countWarnings() — no oxlint invocation, no
// subprocess, no bun install required (matches every other file under
// scripts/: bun:test, Bun/Node built-ins, and lint-warning-count.ts itself).
// See .cli.test.ts for the import.meta.main CLI entry point this file's
// functions feed.

import { describe, expect, test } from "bun:test";

import { countWarnings, type OxlintReport } from "../lint-warning-count";

function diagnostic(severity: string, code: string) {
  return { severity, code };
}

describe("countWarnings", () => {
  test("counts only severity: warning, ignoring error and other values", () => {
    const report: OxlintReport = {
      diagnostics: [
        diagnostic("warning", "eslint(no-console)"),
        diagnostic("error", "eslint(no-debugger)"),
        diagnostic("warning", "eslint(no-console)"),
        diagnostic("off", "eslint(no-var)"),
      ],
    };

    expect(countWarnings(report).total).toBe(2);
  });

  // The whole reason to filter on the `severity` field rather than grepping
  // the word "warning": a diagnostic's own rule code (or message, which this
  // type does not model) can contain that word without being
  // warning-severity, and vice versa. This asserts the field, not the text,
  // decides.
  test("does not match on the word 'warning' appearing in a rule code", () => {
    const report: OxlintReport = {
      diagnostics: [
        {
          severity: "error",
          code: "house(no-warning-suppression)",
        },
      ],
    };

    expect(countWarnings(report).total).toBe(0);
  });

  test("groups by rule code, highest count first", () => {
    const report: OxlintReport = {
      diagnostics: [
        diagnostic("warning", "eslint(no-console)"),
        diagnostic("warning", "house(no-tracker-ref-in-comment)"),
        diagnostic("warning", "eslint(no-console)"),
        diagnostic("warning", "eslint(no-console)"),
        diagnostic("warning", "house(no-tracker-ref-in-comment)"),
      ],
    };

    expect(countWarnings(report).byRule).toEqual([
      ["eslint(no-console)", 3],
      ["house(no-tracker-ref-in-comment)", 2],
    ]);
  });

  test("an empty diagnostics array counts zero", () => {
    expect(countWarnings({ diagnostics: [] }).total).toBe(0);
  });

  // A report shaped unexpectedly (missing/non-array `diagnostics`) is not
  // this function's job to reject — the CLI entry point already validated
  // the JSON parsed at all. Treating it as zero diagnostics rather than
  // throwing keeps this function total, which the CLI test covers by giving
  // it exactly this shape.
  test("a missing diagnostics field counts zero rather than throwing", () => {
    expect(countWarnings({}).total).toBe(0);
  });

  test("a diagnostic with a non-string code groups under '(unknown rule)'", () => {
    const report = {
      diagnostics: [{ severity: "warning", code: 42 }],
    } as unknown as OxlintReport;

    expect(countWarnings(report).byRule).toEqual([["(unknown rule)", 1]]);
  });

  test("a null entry in diagnostics is skipped rather than throwing", () => {
    const report = {
      diagnostics: [null, diagnostic("warning", "eslint(no-console)")],
    } as unknown as OxlintReport;

    expect(countWarnings(report).total).toBe(1);
  });
});
