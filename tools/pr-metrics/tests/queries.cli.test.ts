// `queries.sql` over the committed cards, because a card written by a newer
// collector, or a newer DuckDB, can break the script with no change to it: a
// key that differs from another only in case, or a word that became reserved.
// DuckDB is a local install and absent from CI and remote sessions, so the test
// skips there rather than failing.

import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const QUERIES = join(import.meta.dir, "..", "queries.sql");
const METRICS = join(ROOT, ".claude", "metrics");

/** A committed card to build fixture cards from, so every query finds the
 * fields it reads. */
const TEMPLATE = join(METRICS, "chore-session-metrics-acted-on-rate.json");

/**
 * Run the DuckDB CLI in `cwd`. DuckDB 2.0 switches to agent mode when an agent
 * runs it (`AI_AGENT` or `CLAUDECODE` set, stdout not a terminal): errors become
 * JSON without the word `Error`, and results lose their box. The variable turns
 * that off; an older DuckDB ignores it. `env` replaces the whole environment, so
 * the parent's is carried over.
 */
async function duckdb(cwd: string, args: string[]) {
  const proc = Bun.spawn(["duckdb", ...args], {
    cwd,
    env: { ...process.env, DUCKDB_AGENT_MODE: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: await proc.exited };
}

test.skipIf(Bun.which("duckdb") === null)(
  "queries.sql runs every query over the committed cards",
  async () => {
    const { stdout, stderr, exitCode } = await duckdb(ROOT, [
      ":memory:",
      "-c",
      ".read tools/pr-metrics/queries.sql",
    ]);

    expect(`${stdout}${stderr}`).not.toMatch(/Error/);
    expect(exitCode).toBe(0);
    // One result table per query.
    expect(stdout.match(/┌/g)?.length).toBe(9);
  },
);

test.skipIf(Bun.which("duckdb") === null)(
  "queries.sql reads a card whose keys differ only in case, and keeps both",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-metrics-queries-"));
    try {
      await cp(METRICS, join(dir, ".claude", "metrics"), { recursive: true });

      // Fewer keys than any inference threshold, and a case pair in each of the
      // five objects a card keys by data rather than by schema.
      const template = await Bun.file(TEMPLATE).json();
      const bucket = template.spend.by_actor.main;
      const card = {
        ...template,
        pr: { ...template.pr, branch: "test/case-pair" },
        spend: {
          ...template.spend,
          by_model: { "Claude-X": bucket, "claude-x": bucket },
          effort: { High: 1, high: 2 },
        },
        interaction: {
          ...template.interaction,
          tool_calls: { Bash: 3, bash: 1, Read: 2 },
          skills: { Retro: 1, retro: 4 },
          subagents: { Explore: 1, explore: 2 },
        },
      };
      await writeFile(join(dir, ".claude", "metrics", "test-case-pair.json"), JSON.stringify(card));

      const { stdout, stderr, exitCode } = await duckdb(dir, [
        ":memory:",
        "-c",
        `.read ${QUERIES}`,
        "-c",
        `SELECT interaction.tool_calls['Bash'] AS upper_bash, interaction.tool_calls['bash'] AS lower_bash,
                interaction.subagents['explore'] AS lower_explore
         FROM cards WHERE pr.branch = 'test/case-pair'`,
      ]);

      expect(`${stdout}${stderr}`).not.toMatch(/Error/);
      expect(exitCode).toBe(0);
      // Nine query tables, then the check below.
      expect(stdout.match(/┌/g)?.length).toBe(10);
      // Both keys read back with their own counts: neither merged nor dropped.
      expect(stdout).toMatch(/│\s+3\s+│\s+1\s+│\s+2\s+│/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(Bun.which("duckdb") === null)(
  "section 9's by-line rate leaves out the findings a landed test counted",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-metrics-queries-"));
    try {
      const template = await Bun.file(TEMPLATE).json();
      const review = { reports: 1, findings: 4, located: 4, paired: 4, control_changed: 1 };
      const cards = {
        // Counted by a collector that counts a landed test: 2 of its 4 by test.
        "by-test.json": {
          ...review,
          acted_on: 4,
          acted_on_paired: 4,
          acted_on_by_test: 2,
          acted_on_paired_by_test: 2,
        },
        // Counted by one that does not: no by-test fields at all.
        "by-line.json": { ...review, acted_on: 2, acted_on_paired: 2 },
      };
      await mkdir(join(dir, ".claude", "metrics"), { recursive: true });
      for (const [name, block] of Object.entries(cards)) {
        await writeFile(
          join(dir, ".claude", "metrics", name),
          JSON.stringify({ ...template, review: block }),
        );
      }

      const { stdout } = await duckdb(dir, ["-json", ":memory:", "-c", `.read ${QUERIES}`]);

      // 8 paired findings: 6 acted on, 4 of them by line (4 - 2, then 2 - 0),
      // and 2 control lines changed.
      const row = stdout.match(/\{[^{}]*"by_line_pct"[^{}]*\}/)?.[0];
      expect(row && JSON.parse(row)).toMatchObject({
        prs: 2,
        acted_on_pct: 75,
        by_line_pct: 50,
        control_pct: 25,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(Bun.which("duckdb") === null)(
  "the metrics view reads corrections only from a card of schema version 4 or later",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pr-metrics-queries-"));
    try {
      const template = await Bun.file(TEMPLATE).json();
      // branch: [schema_version, user_turns]. The last has no human turn.
      const fixtures: Record<string, [number, number]> = {
        "a-v3": [3, 9],
        "b-v4": [4, 9],
        "c-v4-silent": [4, 0],
      };
      await mkdir(join(dir, ".claude", "metrics"), { recursive: true });
      for (const [branch, [version, turns]] of Object.entries(fixtures)) {
        await writeFile(
          join(dir, ".claude", "metrics", `${branch}.json`),
          JSON.stringify({
            ...template,
            schema_version: version,
            pr: { ...template.pr, branch, merged_at: "2026-10-22T00:00:00.000Z" },
            interaction: { ...template.interaction, user_turns: turns, corrective_turns: 2 },
          }),
        );
      }

      const { stdout, exitCode } = await duckdb(dir, [
        "-json",
        ":memory:",
        "-c",
        `.read ${QUERIES}`,
        "-c",
        "SELECT list(corrections ORDER BY branch) AS corrections_by_branch FROM metrics",
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/"corrections_by_branch":\s*\[\s*null,\s*2,\s*null\s*\]/);
      // Query 3 says how many cards its corrections median covers.
      expect(stdout).toMatch(/"prs":\s*3,[^{}]*"v4_prs":\s*1,[^{}]*"median_corrections":\s*2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
