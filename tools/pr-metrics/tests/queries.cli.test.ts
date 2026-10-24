// `queries.sql` over the committed cards, because a card written by a newer
// collector, or a newer DuckDB, can break the script with no change to it: a
// key that differs from another only in case, or a word that became reserved.
// DuckDB is a local install and absent from CI and remote sessions, so the test
// skips there rather than failing.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const QUERIES = join(import.meta.dir, "..", "queries.sql");

/** A committed card to build fixture cards from, so every query finds the
 * fields it reads. */
const TEMPLATE = join(ROOT, ".claude", "metrics", "chore-session-metrics-acted-on-rate.json");

test.skipIf(Bun.which("duckdb") === null)(
  "queries.sql runs every query over the committed cards",
  async () => {
    const proc = Bun.spawn(["duckdb", ":memory:", "-c", ".read tools/pr-metrics/queries.sql"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(`${stdout}${stderr}`).not.toMatch(/Error/);
    // One result table per query.
    expect(stdout.match(/┌/g)?.length).toBe(9);
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

      const proc = Bun.spawn(["duckdb", "-json", ":memory:", "-c", `.read ${QUERIES}`], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

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
