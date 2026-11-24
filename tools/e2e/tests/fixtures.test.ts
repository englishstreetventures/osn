/**
 * The stack-database helpers in `support/fixtures.ts` against a server's write.
 *
 * Every stack database uses SQLite's rollback journal, so while a server
 * commits a write, any other connection to the file is refused with
 * `database is locked` unless it waits. Each test holds a write transaction
 * open here, has a second process call a helper, and commits once that
 * process is about to: the helper has to wait out the lock and then see the
 * committed row. The tests show that the helpers wait, not for how long:
 * holding the lock for a set time would mean sleeping on the real clock.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "support/fixtures.ts");
/** Above the helpers' five-second wait, so a helper that gives up fails with its own message. */
const TEST_TIMEOUT_MS = 15_000;

const dir = mkdtempSync(join(tmpdir(), "e2e-fixtures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Outcome {
  code: number | null;
  out: string;
  err: string;
}

/** A new database at `<name>.db` holding one note, `before`. */
function scratch(name: string): string {
  const path = join(dir, `${name}.db`);
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.exec("INSERT INTO notes (id, body) VALUES (1, 'before')");
  db.close();
  return path;
}

/**
 * Opens a write transaction on `path` that changes the note to `after`, runs
 * `call` in a new Bun process with `queryOne`, `writeRow` and `path` in scope,
 * and commits once that process prints `calling`. Its stdout ends with the
 * call's result as JSON, or `error: <message>`.
 *
 * Before `calling`, the process reads the file once with no wait and stops
 * unless SQLite refuses the read. That shows the lock holds in the caller's
 * own process just before the call. It also loads SQLite there: a process's
 * first open takes about a millisecond, long enough for the commit to land
 * first, and the helper would then meet no lock at all.
 */
async function whileLocked(path: string, call: string): Promise<Outcome> {
  const writer = new Database(path);
  writer.exec("BEGIN EXCLUSIVE");
  writer.exec("UPDATE notes SET body = 'after' WHERE id = 1");

  const script = `
    import { writeSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import { queryOne, writeRow } from ${JSON.stringify(FIXTURES)};
    const path = ${JSON.stringify(path)};
    const bare = new DatabaseSync(path, { readOnly: true });
    let refusal = "none";
    try {
      bare.prepare("SELECT body FROM notes").get();
    } catch (error) {
      refusal = error.message;
    }
    bare.close();
    if (refusal !== "database is locked") {
      writeSync(1, "precondition: the read without a wait was refused with " + refusal + "\\n");
      process.exit(1);
    }
    writeSync(1, "calling\\n");
    try {
      writeSync(1, JSON.stringify(${call} ?? null) + "\\n");
    } catch (error) {
      writeSync(1, "error: " + error.message + "\\n");
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk: string) => (err += chunk));
  const exited = new Promise<number | null>((done) => child.on("close", done));
  await new Promise<void>((calling) => {
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("calling\n")) calling();
    });
    child.on("close", () => calling());
  });

  writer.exec("COMMIT");
  writer.close();
  return { code: await exited, out, err };
}

describe("the stack-database helpers wait out a server's write", () => {
  test(
    "queryOne returns the row the transaction commits",
    async () => {
      const path = scratch("query-one");
      expect(
        await whileLocked(path, `queryOne(path, "SELECT body FROM notes WHERE id = ?", 1)`),
      ).toEqual({ code: 0, out: 'calling\n{"body":"after"}\n', err: "" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "writeRow writes after the transaction commits",
    async () => {
      const path = scratch("write-row");
      expect(
        await whileLocked(
          path,
          `writeRow(path, "UPDATE notes SET body = ? WHERE id = ?", "mine", 1)`,
        ),
      ).toEqual({ code: 0, out: "calling\nnull\n", err: "" });
      const db = new Database(path, { readonly: true });
      try {
        expect(db.query("SELECT body FROM notes WHERE id = 1").get()).toEqual({ body: "mine" });
      } finally {
        db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
