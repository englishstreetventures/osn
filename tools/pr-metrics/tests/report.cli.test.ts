// `report.ts` as its own entry point, which is the only way to reach the
// `import.meta.main` block.
//
// That block holds the line this file exists for:
//
//     const { defaultMetricsDir } = require("./index.ts") as typeof import("./index.ts");
//
// `index.ts` reads `node:fs` at module scope, and `@tools/metrics` imports
// `report.ts` into a browser, so the import had to become lazy. Nothing else
// tests it: `report.test.ts` imports `report.ts`'s named exports as a library,
// which never sets `import.meta.main`. A wrong path, a renamed export, or a
// future edit dropping `defaultMetricsDir` from `index.ts` would type-check and
// then fail the first time somebody ran the CLI by hand.
//
// Subprocess rather than import, for that reason — the same seam
// `pr-metrics.cli.test.ts` and `backfill.test.ts` use for their own entry
// points.

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Card } from "../index";

function card(number: number): Card {
  const zero = {
    input: 0,
    output: 0,
    thinking: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
  };

  return {
    schema_version: 1,
    pr: {
      number,
      branch: `feat/x-${number}`,
      base_sha: "a",
      head_sha: "b",
      generated_at: "2026-09-01T00:00:00.000Z",
      merged_at: "2026-09-02T00:00:00.000Z",
      phase: "at-merge",
    },
    issue: { number: null, type: null, labels: [] },
    complexity: { declared: 2, method: "confirmed" },
    window: {
      sessions: 1,
      first_ts: null,
      last_ts: null,
      span_seconds: 0,
      active_seconds: 600,
      compactions: 0,
    },
    spend: {
      usd_equivalent: 50,
      tokens: { ...zero, output: 1_000, cache_read: 9_000 },
      by_model: {},
      by_actor: {
        main: { tokens: { ...zero }, usd_equivalent: 40, messages: 0 },
        subagent: { tokens: { ...zero }, usd_equivalent: 10, messages: 0 },
      },
      effort: {},
      unpriced_models: [],
    },
    diff: {
      files: { generated: 0, test: 0, docs: 0, config: 0, source: 2 },
      loc: {
        generated: { added: 0, deleted: 0 },
        test: { added: 0, deleted: 0 },
        docs: { added: 0, deleted: 0 },
        config: { added: 0, deleted: 0 },
        source: { added: 30, deleted: 10 },
      },
      packages: ["osn/api"],
      touches_migration: false,
      commits: 1,
    },
    interaction: {
      user_turns: 4,
      corrective_turns: 2,
      tokens_before_first_edit: 2_000,
      sessions_with_observed_edit: 1,
      tool_calls: {},
      edit_churn: { files_edited_3plus: 0, max_edits_one_file: 0 },
      skills: {},
      subagents: {},
    },
  };
}

async function runReport(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "report.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();

  return { code: await proc.exited, stdout };
}

test("the report CLI runs end to end over a directory of cards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-metrics-report-"));

  try {
    await writeFile(join(dir, "a.json"), JSON.stringify(card(1)));
    await writeFile(join(dir, "b.json"), JSON.stringify(card(2)));

    const { code, stdout } = await runReport(["--dir", dir, "--coverage", "--json"]);

    expect(code).toBe(0);

    const parsed = JSON.parse(stdout) as {
      cards: number;
      merged: number;
      dir: string;
      tables: Record<string, { title: string; rows: string[][] }>;
    };

    expect(parsed.cards).toBe(2);
    expect(parsed.merged).toBe(2);
    expect(parsed.dir).toBe(dir);
    expect(parsed.tables.coverage?.rows.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The `--dir` path above never calls `defaultMetricsDir`, so it would still pass
// if the lazy require resolved nothing. Omitting `--dir` is what forces the
// required binding to be called.
test("the report CLI resolves its default directory through the lazy require", async () => {
  const { code, stdout } = await runReport(["--coverage", "--json"]);

  expect(code).toBe(0);

  const parsed = JSON.parse(stdout) as { dir: string };

  expect(parsed.dir).toContain(".claude/metrics");
});
