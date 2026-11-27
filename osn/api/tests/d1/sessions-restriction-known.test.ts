import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

/**
 * A session's restriction record is a known one, and only on a restricted
 * row, on real D1, whoever writes it. Migration
 * 20261126022912_sessions_restriction_known creates two triggers that refuse
 * a `restricted_amr` outside 'webauthn', 'otp', 'totp' and 'signup', or one
 * beside a NULL `restricted_until`, on insert and on an update of either
 * column, and changes no stored row.
 *
 * Every database here is built from the migration files, never from
 * `createSchemaSql()`, so it tests the DDL production runs rather than the
 * test copy of it. The refusals run on the whole chain, so a later migration
 * that drops the triggers turns them red. The migration's own behaviour runs
 * on the chain up to and including its file, with rows stored before it.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "drizzle");
const RESTRICTION_CHECK = "20261126022912_sessions_restriction_known.sql";
const REFUSAL = "session restriction record is not known or has no deadline";
const TRIGGERS = ["sessions_restriction_known", "sessions_restriction_known_update"];

/** Every migration, in the order a deployed database applies them. */
const CHAIN = listMigrations(MIGRATIONS_DIR);
/** The chain before the check: the database the migration meets. */
const BEFORE_CHECK = CHAIN.slice(0, CHAIN.indexOf(RESTRICTION_CHECK));

const statementsOf = (file: string): readonly string[] =>
  migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

let mf: Miniflare;

/** A fresh in-memory D1 database, with `files` applied in order and one account. */
async function database(binding: string, files: readonly string[]): Promise<D1Database> {
  const d1 = (await mf.getD1Database(binding)) as unknown as D1Database;
  for (const file of files) await applyFile(d1, file);
  await d1
    .prepare(
      "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES ('acc_r', 'r@example.com', 'pku_r', 1, 1)",
    )
    .run();
  return d1;
}

async function applyFile(d1: D1Database, file: string): Promise<void> {
  for (const statement of statementsOf(file)) await d1.prepare(statement).run();
}

/** A session on the one account, with the restriction pair given. */
const addSession = (d1: D1Database, id: string, until: number | null, amr: string | null) =>
  d1
    .prepare(
      `INSERT INTO sessions (id, account_id, family_id, expires_at, created_at, restricted_until, restricted_amr)
       VALUES (?, 'acc_r', ?, 900, 100, ?, ?)`,
    )
    .bind(id, `sfam_${id}`, until, amr)
    .run();

const setRestriction = (d1: D1Database, id: string, until: number | null, amr: string | null) =>
  d1
    .prepare("UPDATE sessions SET restricted_until = ?, restricted_amr = ? WHERE id = ?")
    .bind(until, amr, id)
    .run();

const restrictionOf = (d1: D1Database, id: string) =>
  d1
    .prepare("SELECT restricted_until, restricted_amr FROM sessions WHERE id = ?")
    .bind(id)
    .first<{ restricted_until: number | null; restricted_amr: string | null }>();

const sessionRows = async (d1: D1Database) =>
  (await d1.prepare("SELECT * FROM sessions ORDER BY id").all<Record<string, unknown>>()).results;

const triggerNames = async (d1: D1Database) =>
  (
    await d1
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sessions' ORDER BY name",
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

beforeAll(async () => {
  // One workerd process; each binding is its own in-memory database.
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: {
      FULL: "restriction-full",
      STORED: "restriction-stored",
      RERUN: "restriction-rerun",
    },
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("a session's restriction record on D1, after every migration", () => {
  let d1: D1Database;

  beforeAll(async () => {
    expect(CHAIN).toContain(RESTRICTION_CHECK);
    d1 = await database("FULL", CHAIN);
  });

  it("refuses an insert of a value osn-api does not know, or of a value with no deadline", async () => {
    expect(await refusal(addSession(d1, "ses_bogus", 900, "bogus"))).toContain(REFUSAL);
    expect(await refusal(addSession(d1, "ses_no_deadline", null, "signup"))).toContain(REFUSAL);
    expect(await refusal(addSession(d1, "ses_no_deadline_otp", null, "otp"))).toContain(REFUSAL);
    expect(await restrictionOf(d1, "ses_bogus")).toBeNull();
    expect(await restrictionOf(d1, "ses_no_deadline")).toBeNull();
    expect(await restrictionOf(d1, "ses_no_deadline_otp")).toBeNull();
  });

  it("takes a sign-up's record, a recovery's factor, an ordinary row and a restricted row with no record", async () => {
    await addSession(d1, "ses_signup", 900, "signup");
    for (const amr of ["webauthn", "otp", "totp"]) await addSession(d1, `ses_${amr}`, 900, amr);
    await addSession(d1, "ses_ordinary", null, null);
    // The shape restricted rows written before migration 0009 hold.
    await addSession(d1, "ses_unrecorded", 900, null);

    expect(await restrictionOf(d1, "ses_signup")).toEqual({
      restricted_until: 900,
      restricted_amr: "signup",
    });
    expect(await restrictionOf(d1, "ses_totp")).toEqual({
      restricted_until: 900,
      restricted_amr: "totp",
    });
    expect(await restrictionOf(d1, "ses_ordinary")).toEqual({
      restricted_until: null,
      restricted_amr: null,
    });
    expect(await restrictionOf(d1, "ses_unrecorded")).toEqual({
      restricted_until: 900,
      restricted_amr: null,
    });
  });

  it("refuses an update to an unknown value, or one that drops the deadline and keeps the value", async () => {
    await addSession(d1, "ses_update", 900, "signup");

    expect(await refusal(setRestriction(d1, "ses_update", 900, "bogus"))).toContain(REFUSAL);
    expect(
      await refusal(
        d1.prepare("UPDATE sessions SET restricted_until = NULL WHERE id = 'ses_update'").run(),
      ),
    ).toContain(REFUSAL);
    expect(await refusal(setRestriction(d1, "ses_update", null, "otp"))).toContain(REFUSAL);
    expect(await restrictionOf(d1, "ses_update")).toEqual({
      restricted_until: 900,
      restricted_amr: "signup",
    });
  });

  it("takes the lift, which clears both", async () => {
    await addSession(d1, "ses_lift", 900, "signup");

    await setRestriction(d1, "ses_lift", null, null);

    expect(await restrictionOf(d1, "ses_lift")).toEqual({
      restricted_until: null,
      restricted_amr: null,
    });
  });

  it("names neither the row nor the value it refuses", async () => {
    const error = await refusal(addSession(d1, "ses_secret_row", 900, "secret-value"));
    expect(error).toContain(REFUSAL);
    for (const detail of ["ses_secret_row", "secret-value", "acc_r"]) {
      expect(error).not.toContain(detail);
    }
  });
});

describe("the restriction check over rows stored before it", () => {
  let d1: D1Database;
  let before: Record<string, unknown>[];

  beforeAll(async () => {
    d1 = await database("STORED", BEFORE_CHECK);
    await addSession(d1, "ses_signup", 900, "signup");
    await addSession(d1, "ses_otp", 900, "otp");
    await addSession(d1, "ses_ordinary", null, null);
    await addSession(d1, "ses_unrecorded", 900, null);
    // A pair no writer produces, which the check refuses only when it is
    // written again.
    await addSession(d1, "ses_unpaired", null, "otp");
    before = await sessionRows(d1);
    await applyFile(d1, RESTRICTION_CHECK);
  });

  it("completes, and leaves every row exactly as it was", async () => {
    expect(await sessionRows(d1)).toEqual(before);
    expect(await triggerNames(d1)).toEqual(TRIGGERS);
  });

  it("lets a stored row change its other columns, and judges a new restriction record", async () => {
    await d1.prepare("UPDATE sessions SET last_used_at = 5, expires_at = 950").run();
    expect(await restrictionOf(d1, "ses_unpaired")).toEqual({
      restricted_until: null,
      restricted_amr: "otp",
    });

    expect(await refusal(setRestriction(d1, "ses_unrecorded", 900, "bogus"))).toContain(REFUSAL);
    await setRestriction(d1, "ses_unpaired", null, null);
    expect(await restrictionOf(d1, "ses_unpaired")).toEqual({
      restricted_until: null,
      restricted_amr: null,
    });
  });
});

it("the restriction check runs again from the top, after a whole run and after a part-run", async () => {
  const d1 = await database("RERUN", BEFORE_CHECK);
  await addSession(d1, "ses_again", 900, "signup");

  // A run that stopped after its first statement, then the whole file twice.
  await d1.prepare(statementsOf(RESTRICTION_CHECK)[0]!).run();
  await applyFile(d1, RESTRICTION_CHECK);
  await applyFile(d1, RESTRICTION_CHECK);

  expect(await triggerNames(d1)).toEqual(TRIGGERS);
  expect(await restrictionOf(d1, "ses_again")).toEqual({
    restricted_until: 900,
    restricted_amr: "signup",
  });
});
