import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

/**
 * An organisation member's role is 'admin' or 'member' on real D1, whoever
 * writes it. Migration 20261107024712_organisation_member_role_check creates
 * two triggers that refuse any other value on insert and on update, then stops
 * if a stored row already holds another value.
 *
 * Every database here is built from the migration files, never from
 * `createSchemaSql()`, so it tests the DDL production runs rather than the
 * test copy of it. The refusals run on the whole chain, so a later migration
 * that drops the triggers turns them red. The migration's own behaviour runs
 * on the chain up to and including its file, with rows stored before it.
 *
 * Each statement goes through `prepare().run()` on its own. Wrangler and
 * Alchemy each send a file as one query instead; the tests do not depend on
 * which, since every statement of the file runs again safely whichever part of
 * a failed run survived.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "drizzle");
const ROLE_CHECK = "20261107024712_organisation_member_role_check.sql";
const REFUSAL = "organisation member role is not admin or member";
const TRIGGERS = ["organisation_members_role_known", "organisation_members_role_known_update"];

/** Every migration, in the order a deployed database applies them. */
const CHAIN = listMigrations(MIGRATIONS_DIR);
/** The chain before the role check: the database the migration meets. */
const BEFORE_ROLE_CHECK = CHAIN.slice(0, CHAIN.indexOf(ROLE_CHECK));

const statementsOf = (file: string): readonly string[] =>
  migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

let mf: Miniflare;

/** A fresh in-memory D1 database, with `files` applied in order. */
async function database(binding: string, files: readonly string[]): Promise<D1Database> {
  const d1 = (await mf.getD1Database(binding)) as unknown as D1Database;
  for (const file of files) await applyFile(d1, file);
  return d1;
}

async function applyFile(d1: D1Database, file: string): Promise<void> {
  for (const statement of statementsOf(file)) await d1.prepare(statement).run();
}

/**
 * The rows a member points at. D1 enforces foreign keys, so a member needs its
 * organisation and its profile, and the profile needs its account.
 */
async function seedParents(d1: D1Database): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES ('acc_role', 'role@example.com', 'pku_role', 1, 1)",
    )
    .run();
  for (let n = 1; n <= 8; n++) {
    await d1
      .prepare(
        "INSERT INTO users (id, account_id, handle, created_at, updated_at) VALUES (?, 'acc_role', ?, 1, 1)",
      )
      .bind(`usr_${n}`, `roleuser${n}`)
      .run();
  }
  await d1
    .prepare(
      "INSERT INTO organisations (id, handle, name, owner_id, created_at, updated_at) VALUES ('org_role', 'roleorg', 'Role Org', 'usr_8', 1, 1)",
    )
    .run();
}

const addMember = (d1: D1Database, id: string, profileId: string, role: string) =>
  d1
    .prepare(
      "INSERT INTO organisation_members (id, organisation_id, profile_id, role, created_at) VALUES (?, 'org_role', ?, ?, 1)",
    )
    .bind(id, profileId, role)
    .run();

const setRole = (d1: D1Database, id: string, role: string) =>
  d1.prepare("UPDATE organisation_members SET role = ? WHERE id = ?").bind(role, id).run();

const roleOf = async (d1: D1Database, id: string) =>
  (
    await d1
      .prepare("SELECT role FROM organisation_members WHERE id = ?")
      .bind(id)
      .first<{ role: string }>()
  )?.role;

const memberCount = async (d1: D1Database) =>
  (await d1.prepare("SELECT count(*) AS n FROM organisation_members").first<{ n: number }>())?.n;

const triggerNames = async (d1: D1Database) =>
  (
    await d1
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'organisation_members' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);

/** The error a write fails with, or "accepted" when D1 takes it. */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
    return "accepted";
  } catch (error) {
    return String(error);
  }
}

/** Applies the role check one statement at a time, stopping at the first that fails. */
async function applyRoleCheck(d1: D1Database): Promise<{ failedAt: number; error: string }> {
  const statements = statementsOf(ROLE_CHECK);
  for (const [index, statement] of statements.entries()) {
    const error = await refusal(d1.prepare(statement).run());
    if (error !== "accepted") return { failedAt: index, error };
  }
  return { failedAt: -1, error: "" };
}

beforeAll(async () => {
  // One workerd process; each binding is its own in-memory database.
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: {
      FULL: "role-full",
      STOPPED: "role-stopped",
      CLEAN: "role-clean",
      RERUN: "role-rerun",
    },
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("an organisation member's role on D1, after every migration", () => {
  let d1: D1Database;

  beforeAll(async () => {
    expect(CHAIN).toContain(ROLE_CHECK);
    d1 = await database("FULL", CHAIN);
    await seedParents(d1);
  });

  it("refuses an insert of any role but 'admin' or 'member'", async () => {
    const before = await memberCount(d1);
    const roles = ["owner", "Admin", "admin ", ""];
    for (const [index, role] of roles.entries()) {
      expect(await refusal(addMember(d1, `orgm_bad_${index}`, `usr_${index + 1}`, role))).toContain(
        REFUSAL,
      );
    }
    expect(await memberCount(d1)).toBe(before);
  });

  it("refuses an update to any role but 'admin' or 'member'", async () => {
    await addMember(d1, "orgm_update", "usr_5", "member");

    expect(await refusal(setRole(d1, "orgm_update", "owner"))).toContain(REFUSAL);
    expect(await roleOf(d1, "orgm_update")).toBe("member");
  });

  // E2E writes both roles too, but on a database built from the test copy of
  // the triggers, not from the migration, and the lockstep test compares the
  // two without case. This is the one check that the migration's own value
  // list takes the exact spellings the API stores.
  it("takes 'admin' and 'member' on insert and on update", async () => {
    await addMember(d1, "orgm_admin", "usr_6", "admin");
    await addMember(d1, "orgm_member", "usr_7", "member");
    await setRole(d1, "orgm_member", "admin");
    expect(await roleOf(d1, "orgm_member")).toBe("admin");
    await setRole(d1, "orgm_member", "member");

    expect(await roleOf(d1, "orgm_admin")).toBe("admin");
    expect(await roleOf(d1, "orgm_member")).toBe("member");
  });
});

describe("the role check over a stored role outside the set", () => {
  let outcome: { failedAt: number; error: string };
  let d1: D1Database;

  beforeAll(async () => {
    d1 = await database("STOPPED", BEFORE_ROLE_CHECK);
    await seedParents(d1);
    await addMember(d1, "orgm_stored_owner", "usr_1", "owner");
    outcome = await applyRoleCheck(d1);
  });

  it("stops at its last statement with the trigger's refusal, and leaves the row alone", async () => {
    expect(outcome.failedAt).toBe(statementsOf(ROLE_CHECK).length - 1);
    expect(outcome.error).toContain(REFUSAL);
    expect(await roleOf(d1, "orgm_stored_owner")).toBe("owner");
  });

  it("names neither the row nor its value", () => {
    expect(outcome.error).toContain(REFUSAL);
    for (const detail of ["orgm_stored_owner", "usr_1", "owner"]) {
      expect(outcome.error).not.toContain(detail);
    }
  });
});

it("the role check leaves stored 'admin' and 'member' rows exactly as they were", async () => {
  const d1 = await database("CLEAN", BEFORE_ROLE_CHECK);
  await seedParents(d1);
  await addMember(d1, "orgm_kept_admin", "usr_1", "admin");
  await addMember(d1, "orgm_kept_member", "usr_2", "member");
  const rows = async () =>
    (await d1.prepare("SELECT * FROM organisation_members ORDER BY id").all()).results;
  const before = await rows();
  expect(before).toHaveLength(2);

  expect(await applyRoleCheck(d1)).toEqual({ failedAt: -1, error: "" });

  expect(await rows()).toEqual(before);
  expect(await triggerNames(d1)).toEqual(TRIGGERS);
});

it("the role check runs again from the top once a stopped run's row is fixed", async () => {
  const d1 = await database("RERUN", BEFORE_ROLE_CHECK);
  await seedParents(d1);
  await addMember(d1, "orgm_fixed", "usr_1", "owner");
  expect((await applyRoleCheck(d1)).error).toContain(REFUSAL);
  // The stopped run left its triggers behind; the re-run must cope with them.
  expect(await triggerNames(d1)).toEqual(TRIGGERS);

  await setRole(d1, "orgm_fixed", "member");
  await applyFile(d1, ROLE_CHECK);

  expect(await triggerNames(d1)).toEqual(TRIGGERS);
  expect(await roleOf(d1, "orgm_fixed")).toBe("member");
});
