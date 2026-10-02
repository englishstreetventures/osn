import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * cire/db/migrations-archive: the chain production ran, file by file. The live
 * baseline already contains every file here, so the data-migration tests
 * replay this to see what a migration did to rows that already existed.
 */
export const ARCHIVE_DIR = join(import.meta.dir, "..", "..", "..", "db", "migrations-archive");

/** The archived migrations, in the order wrangler ran them. */
export function archivedFiles(): readonly string[] {
  return readdirSync(ARCHIVE_DIR)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
}

/** Run one archived migration against `db`. */
export function applyArchived(db: Database, file: string): void {
  db.exec(readFileSync(join(ARCHIVE_DIR, file), "utf8"));
}

const snapshots = new Map<string, Uint8Array>();

/**
 * A new in-memory database holding the schema the archived chain leaves just
 * before `file`, with `PRAGMA foreign_keys` set as given for the replay and
 * for the copy. The chain is replayed once per file and setting; each call
 * returns its own copy of that, so rows one test seeds never reach another.
 */
export function databaseBefore(file: string, { foreignKeys }: { foreignKeys: boolean }): Database {
  const key = `${file}:${foreignKeys}`;
  let snapshot = snapshots.get(key);
  if (snapshot === undefined) {
    const files = archivedFiles();
    const cut = files.indexOf(file);
    if (cut < 1) throw new Error(`${file} is not an archived migration after the first`);
    const db = new Database(":memory:");
    try {
      if (foreignKeys) db.exec("PRAGMA foreign_keys = ON;");
      for (const earlier of files.slice(0, cut)) applyArchived(db, earlier);
      snapshot = db.serialize();
    } finally {
      db.close();
    }
    snapshots.set(key, snapshot);
  }
  const copy = Database.deserialize(snapshot);
  if (foreignKeys) copy.exec("PRAGMA foreign_keys = ON;");
  return copy;
}
