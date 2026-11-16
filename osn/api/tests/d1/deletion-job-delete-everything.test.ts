import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

/**
 * A deletion job that deletes everything holds no stored answers, on real D1,
 * whoever writes it. Migration 20261115103320_deletion_app_contract creates
 * two triggers that refuse the pair on insert and on update.
 *
 * The database is built from the migration files, never from
 * `createSchemaSql()`, so it tests the DDL production runs rather than the
 * test copy of it, and a later migration that drops the triggers turns these
 * red.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "drizzle");
const REFUSAL = "a deletion job that deletes everything holds no choices";

let mf: Miniflare;
let d1: D1Database;

/** The error a write fails with, or "accepted" when D1 takes it. */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
    return "accepted";
  } catch (error) {
    return String(error);
  }
}

const addJob = (accountId: string, deleteEverything: number, choices: string | null) =>
  d1
    .prepare(
      "INSERT INTO deletion_jobs (account_id, soft_deleted_at, hard_delete_at, delete_everything, choices) VALUES (?, 1, 2, ?, ?)",
    )
    .bind(accountId, deleteEverything, choices)
    .run();

const jobOf = (accountId: string) =>
  d1
    .prepare("SELECT delete_everything, choices FROM deletion_jobs WHERE account_id = ?")
    .bind(accountId)
    .first<{ delete_everything: number; choices: string | null }>();

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: "delete-everything" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const file of listMigrations(MIGRATIONS_DIR)) {
    for (const statement of migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))) {
      await d1.prepare(statement).run();
    }
  }
  for (const id of ["acc_insert", "acc_update"]) {
    await d1
      .prepare(
        "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      )
      .bind(id, `${id}@example.com`, `pku_${id}`)
      .run();
  }
});

afterAll(async () => {
  await mf?.dispose();
});

describe("a deletion job that deletes everything, on D1, after every migration", () => {
  it("refuses an insert that holds answers, and takes one that holds none", async () => {
    expect(await refusal(addJob("acc_insert", 1, "{}"))).toContain(REFUSAL);
    expect(await jobOf("acc_insert")).toBeNull();
    await addJob("acc_insert", 1, null);
    expect(await jobOf("acc_insert")).toEqual({ delete_everything: 1, choices: null });
  });

  it("refuses an update that would put answers beside the flag, or the flag beside answers", async () => {
    await addJob("acc_update", 0, '{"osn:organisation:org_1":{"choice":"delete"}}');
    expect(
      await refusal(
        d1
          .prepare("UPDATE deletion_jobs SET delete_everything = 1 WHERE account_id = ?")
          .bind("acc_update")
          .run(),
      ),
    ).toContain(REFUSAL);
    expect(
      await refusal(
        d1
          .prepare("UPDATE deletion_jobs SET choices = '{}' WHERE account_id = ?")
          .bind("acc_insert")
          .run(),
      ),
    ).toContain(REFUSAL);
    expect((await jobOf("acc_update"))?.delete_everything).toBe(0);
    expect((await jobOf("acc_insert"))?.choices).toBeNull();
  });
});
