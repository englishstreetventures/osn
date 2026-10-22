import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { flattenMigrations, MigrationsSourceError } from "../src/migrations";

// CRLF line endings and a multi-byte character, so a copy that rewrites text fails M3.
const FIRST = "CREATE TABLE a (id INTEGER);\r\n-- café\r\n";
const SECOND = "CREATE TABLE b (id INTEGER);\n--> statement-breakpoint\n";

/** A Drizzle-shaped migrations directory, and a target an earlier run left a file in. */
function fixture(): { readonly source: string; readonly target: string } {
  const root = mkdtempSync(join(tmpdir(), "migrations-"));
  const source = join(root, "drizzle");
  const files: Readonly<Record<string, string>> = {
    "0001_a.sql": FIRST,
    "0002_b.sql": SECOND,
    "meta/_journal.json": "{}",
    "meta/0001_snapshot.json": "{}",
    "nested/0003_c.sql": "CREATE TABLE c (id INTEGER);\n",
    "README.md": "# migrations\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), text);
  }
  const target = join(root, ".generated", "migrations", "cire-db");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "0000_stale.sql"), "DROP TABLE a;\n");
  return { source, target };
}

const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted();

describe("flattenMigrations", () => {
  test("M1: leaves out meta/_journal.json and every file that is not .sql", () => {
    const { source, target } = fixture();
    flattenMigrations({ source, target });
    const out = listing(target);
    expect(out.filter((path) => path.startsWith("meta") || !path.endsWith(".sql"))).toEqual([]);
  });

  test("M2: leaves out a .sql file in a subdirectory", () => {
    const { source, target } = fixture();
    flattenMigrations({ source, target });
    expect(listing(target)).not.toContain(join("nested", "0003_c.sql"));
    expect(listing(target)).not.toContain("nested");
  });

  test("M3: copies each top-level .sql file under its own name, byte for byte", () => {
    const { source, target } = fixture();
    expect(flattenMigrations({ source, target })).toBe(target);
    expect(listing(target)).toEqual(["0001_a.sql", "0002_b.sql"]);
    for (const name of ["0001_a.sql", "0002_b.sql"]) {
      expect(readFileSync(join(target, name)).equals(readFileSync(join(source, name)))).toBe(true);
    }
  });

  test("M4: removes a file an earlier run left in the target", () => {
    const { source, target } = fixture();
    flattenMigrations({ source, target });
    expect(listing(target)).not.toContain("0000_stale.sql");
  });

  test("M5: refuses a source with no .sql file, or no directory at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "migrations-"));
    writeFileSync(join(empty, "README.md"), "# nothing here\n");
    mkdirSync(join(empty, "meta"));
    writeFileSync(join(empty, "meta", "_journal.json"), "{}");
    const target = join(mkdtempSync(join(tmpdir(), "migrations-")), "out");
    expect(() => flattenMigrations({ source: empty, target })).toThrow(MigrationsSourceError);
    expect(() => flattenMigrations({ source: join(empty, "missing"), target })).toThrow(
      MigrationsSourceError,
    );
  });

  test("M6: refuses a target that overlaps the source, which emptying it would delete", () => {
    const { source } = fixture();
    for (const target of [join(source, "flat"), source, dirname(source)]) {
      expect(() => flattenMigrations({ source, target })).toThrow(MigrationsSourceError);
    }
    expect(listing(source)).toContain("0001_a.sql");
  });
});
