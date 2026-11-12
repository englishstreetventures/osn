import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
  archivedPlaceholder,
  FREEZE_MIGRATION,
  flattenMigrations,
  migrationFiles,
  migrationHash,
  MigrationsSourceError,
} from "../src/migrations";
import { cloudflareDir } from "./support/cloudflare-dir";

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

/** A live directory and an archive beside it, as cire/db lays them out. */
function archived(): {
  readonly source: string;
  readonly archive: string;
  readonly target: string;
} {
  const root = mkdtempSync(join(tmpdir(), "migrations-archive-"));
  const source = join(root, "migrations");
  const archive = join(root, "migrations-archive");
  mkdirSync(source);
  mkdirSync(archive);
  writeFileSync(join(source, "0001_initial.sql"), "CREATE TABLE baseline (id INTEGER);\n");
  writeFileSync(join(source, "0082_live.sql"), "ALTER TABLE baseline ADD COLUMN b TEXT;\n");
  writeFileSync(join(source, "20261021132850_late.sql"), "CREATE INDEX i ON baseline (b);\n");
  writeFileSync(join(archive, "0001_initial.sql"), "CREATE TABLE original (id INTEGER);\n");
  writeFileSync(join(archive, "0002_two.sql"), "DELETE FROM original;\n");
  writeFileSync(join(archive, "0010_ten.sql"), "DROP TABLE original;\n");
  writeFileSync(join(archive, "README.md"), "# archive\n");
  return { source, archive, target: join(root, ".generated", "migrations", "cire-db") };
}

/** The installed provider's own `@alchemy.run/sql/SqlFile`, the module a deploy lists and hashes with. */
interface SqlFileModule {
  readonly listSqlFiles: (
    dir: string,
  ) => Effect.Effect<readonly { readonly id: string; readonly hash: string }[], unknown, unknown>;
}

const alchemyListing = async (dir: string) => {
  const path = createRequire(join(cloudflareDir(), "package.json")).resolve(
    "@alchemy.run/sql/SqlFile",
  );
  const { listSqlFiles } = (await import(/* @vite-ignore */ path)) as SqlFileModule;
  return Effect.runPromise(
    listSqlFiles(dir).pipe(Effect.provide(BunServices.layer)) as Effect.Effect<
      readonly { readonly id: string; readonly hash: string }[]
    >,
  );
};

describe("production's migrations: the archive and the freeze", () => {
  test("M7: an archived name the live directory lacks becomes a refusing placeholder, byte for byte", () => {
    const { source, archive, target } = archived();
    flattenMigrations({ source, archive, target });
    for (const name of ["0002_two.sql", "0010_ten.sql"]) {
      expect(readFileSync(join(target, name), "utf8")).toBe(
        `-- ${name} is archived in cire/db/migrations-archive/. Production applied it before Alchemy\n` +
          "-- migrated this database, so its ledger names it and nothing runs this file. Running it\n" +
          "-- means this database's ledger lacks it: refuse, never record it.\n" +
          `SELECT * FROM "${name} was never applied to this database: see cire/db/migrations-archive/README.md";\n`,
      );
      expect(archivedPlaceholder(name)).toBe(readFileSync(join(target, name), "utf8"));
    }
    // Never the archived SQL itself: 0002 deletes rows, 0010 drops a table.
    expect(readFileSync(join(target, "0002_two.sql"), "utf8")).not.toContain("DELETE");
    expect(readFileSync(join(target, "0010_ten.sql"), "utf8")).not.toContain("DROP");
  });

  test("M8: a name both directories hold keeps the live file's bytes", () => {
    const { source, archive, target } = archived();
    flattenMigrations({ source, archive, target });
    expect(readFileSync(join(target, "0001_initial.sql"), "utf8")).toBe(
      "CREATE TABLE baseline (id INTEGER);\n",
    );
    expect(listing(target)).not.toContain("README.md");
  });

  test("M9: migrationFiles lists the flattened directory in Alchemy's order, with Alchemy's hashes", async () => {
    const { source, archive, target } = archived();
    flattenMigrations({ source, archive, freeze: true, target });
    const files = migrationFiles({ source, archive, freeze: true });
    const alchemy = await alchemyListing(target);
    expect(files.map((file) => file.name)).toEqual(alchemy.map((file) => file.id));
    expect(files.map((file) => migrationHash(file.sql))).toEqual(alchemy.map((file) => file.hash));
    expect(Object.fromEntries(files.map((file) => [file.name, file.kind]))).toEqual({
      "0001_initial.sql": "live",
      "0002_two.sql": "archived",
      "0010_ten.sql": "archived",
      "0082_live.sql": "live",
      "20261021132850_late.sql": "live",
      [FREEZE_MIGRATION.name]: "generated",
    });
  });

  test("M10: a missing archive directory is refused before the target is touched", () => {
    const { source, target } = archived();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "kept.sql"), "SELECT 1;\n");
    const nowhere = join(source, "..", "nowhere");
    expect(() => flattenMigrations({ source, archive: nowhere, target })).toThrow(
      MigrationsSourceError,
    );
    expect(() => migrationFiles({ source, archive: nowhere })).toThrow(MigrationsSourceError);
    expect(listing(target)).toEqual(["kept.sql"]);
  });

  test("M11: freeze writes the one generated file that stops Wrangler writing its ledger; without it, none", () => {
    const { source, target } = archived();
    flattenMigrations({ source, target });
    expect(listing(target)).not.toContain(FREEZE_MIGRATION.name);
    flattenMigrations({ source, freeze: true, target });
    // After every numbered chain, before every timestamped file: it applies
    // first among the files a conversion release finds waiting.
    expect(FREEZE_MIGRATION.name).toBe("1000_freeze_wrangler_ledger.sql");
    const files = migrationFiles({ source, freeze: true }).map((file) => file.name);
    expect(files).toEqual([
      "0001_initial.sql",
      "0082_live.sql",
      FREEZE_MIGRATION.name,
      "20261021132850_late.sql",
    ]);
    expect(readFileSync(join(target, FREEZE_MIGRATION.name), "utf8")).toBe(
      "-- Production only: Alchemy migrates this database, so Wrangler's ledger takes no new row.\n" +
        "-- Any wrangler d1 migrations apply against it fails on its ledger INSERT and rolls back.\n" +
        'CREATE TRIGGER IF NOT EXISTS "d1_migrations_frozen" BEFORE INSERT ON "d1_migrations"\n' +
        "BEGIN\n" +
        "  SELECT RAISE(ABORT, 'd1_migrations is frozen: the Alchemy stack migrates this database');\n" +
        "END;\n",
    );
  });

  test("M12: migrationHash is the sha256 of the file's text, as Alchemy computes it", () => {
    expect(migrationHash("SELECT 1;\n")).toBe(
      createHash("sha256").update("SELECT 1;\n").digest("hex"),
    );
  });
});
