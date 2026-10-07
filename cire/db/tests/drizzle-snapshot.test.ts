import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `db:generate` numbers the next migration from migrations/meta/_journal.json
// and diffs src/schema.ts against the snapshot the journal's last entry names.
// A snapshot that drifted from the schema would fold unrelated DDL into the
// next migration file. This runs drizzle-kit on a copy, so nothing is written
// to the real migrations directory.

const CIRE_DB = join(import.meta.dir, "..");

test("drizzle-kit finds no schema change between src/schema.ts and the baseline's snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "cire-db-snapshot-"));
  try {
    copyFileSync(join(CIRE_DB, "drizzle.config.ts"), join(dir, "drizzle.config.ts"));
    cpSync(join(CIRE_DB, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(CIRE_DB, "migrations"), join(dir, "migrations"), { recursive: true });
    symlinkSync(join(CIRE_DB, "node_modules"), join(dir, "node_modules"));

    const result = Bun.spawnSync(
      [join(CIRE_DB, "node_modules", ".bin", "drizzle-kit"), "generate"],
      {
        cwd: dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain("No schema changes");
    expect(result.exitCode).toBe(0);
    expect(readdirSync(join(dir, "migrations")).filter((name) => name.endsWith(".sql"))).toEqual([
      "0001_initial.sql",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
