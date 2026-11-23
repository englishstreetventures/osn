import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { queryOne } from "./support/fixtures";

// A rollback-journal database: an exclusive write lock refuses every reader.
const HOLD_LOCK = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN EXCLUSIVE");
db.exec("UPDATE t SET v = 2");
process.stdout.write("locked\\n");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);
`;

describe("queryOne", () => {
  test("waits out a write lock and returns the committed row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "query-one-"));
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
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");

      // The holder commits 500 ms after it printed; the blocked read must wait.
      const row = queryOne<{ v: number }>(dbPath, "SELECT v FROM t");
      expect(row).toEqual({ v: 2 });
    } finally {
      holder.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
