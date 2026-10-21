// `queries.sql` over the committed cards, because a card written by a newer
// collector, or a newer DuckDB, can break the script with no change to it: a
// key that differs from another only in case, or a word that became reserved.
// DuckDB is a local install and absent from CI and remote sessions, so the test
// skips there rather than failing.

import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

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
