import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { queryOne, writeRow } from "./support/fixtures";

// A rollback-journal database: an exclusive write lock refuses every reader.
const HOLD_LOCK = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN EXCLUSIVE");
db.exec("UPDATE t SET v = 2");
process.stdout.write("locked\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);
`;

/** Runs `body` while a child process holds an exclusive lock for about 500 ms. */
async function withLockedDb(body: (dbPath: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "stack-db-"));
  const dbPath = join(dir, "scratch.db");
  const setup = new DatabaseSync(dbPath);
  setup.exec("PRAGMA journal_mode = DELETE");
  setup.exec("CREATE TABLE t (v INTEGER)");
  setup.exec("INSERT INTO t VALUES (1)");
  setup.close();

  const holder = Bun.spawn(["node", "-e", HOLD_LOCK, dbPath], {
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const first = await holder.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    body(dbPath);
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("stack database helpers", () => {
  test("queryOne waits out a write lock and returns the committed row", async () => {
    await withLockedDb((dbPath) => {
      const start = performance.now();
      const row = queryOne<{ v: number }>(dbPath, "SELECT v FROM t");
      expect(performance.now() - start).toBeGreaterThan(100);
      expect(row).toEqual({ v: 2 });
    });
  });

  test("writeRow waits out a write lock and changes the row", async () => {
    await withLockedDb((dbPath) => {
      const start = performance.now();
      writeRow(dbPath, "UPDATE t SET v = ? WHERE v = ?", 3, 2);
      expect(performance.now() - start).toBeGreaterThan(100);
      expect(queryOne<{ v: number }>(dbPath, "SELECT v FROM t")).toEqual({ v: 3 });
    });
  });
});
