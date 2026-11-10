import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

/**
 * An account's email holds no capital letter on real D1, whoever writes it.
 * Migration 20261110132140_account_email_lower_case creates two triggers that
 * refuse one on insert and on an update of `email`, and changes no stored row.
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
const EMAIL_CHECK = "20261110132140_account_email_lower_case.sql";
const REFUSAL = "account email is not lower case";
const TRIGGERS = ["accounts_email_lower_case", "accounts_email_lower_case_update"];

/** Every migration, in the order a deployed database applies them. */
const CHAIN = listMigrations(MIGRATIONS_DIR);
/** The chain before the email check: the database the migration meets. */
const BEFORE_EMAIL_CHECK = CHAIN.slice(0, CHAIN.indexOf(EMAIL_CHECK));

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

const addAccount = (d1: D1Database, id: string, email: string) =>
  d1
    .prepare(
      "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    )
    .bind(id, email, `pku_${id}`)
    .run();

const setEmail = (d1: D1Database, id: string, email: string) =>
  d1.prepare("UPDATE accounts SET email = ? WHERE id = ?").bind(email, id).run();

const emailOf = async (d1: D1Database, id: string) =>
  (await d1.prepare("SELECT email FROM accounts WHERE id = ?").bind(id).first<{ email: string }>())
    ?.email;

const accountRows = async (d1: D1Database) =>
  (await d1.prepare("SELECT * FROM accounts ORDER BY id").all<Record<string, unknown>>()).results;

const accountCount = async (d1: D1Database) =>
  (await d1.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>())?.n;

const triggerNames = async (d1: D1Database) =>
  (
    await d1
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'accounts' ORDER BY name",
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

/** Applies the email check one statement at a time, stopping at the first that fails. */
async function applyEmailCheck(d1: D1Database): Promise<{ failedAt: number; error: string }> {
  const statements = statementsOf(EMAIL_CHECK);
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
      FULL: "email-full",
      STORED: "email-stored",
      RERUN: "email-rerun",
    },
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("an account's email on D1, after every migration", () => {
  let d1: D1Database;

  beforeAll(async () => {
    expect(CHAIN).toContain(EMAIL_CHECK);
    d1 = await database("FULL", CHAIN);
  });

  it("refuses an insert of an email with a capital anywhere in it", async () => {
    const before = await accountCount(d1);
    const emails = ["Alice@x.com", "alice@X.com", "ALICE@X.COM", "alicE@x.com"];
    for (const [index, email] of emails.entries()) {
      expect(await refusal(addAccount(d1, `acc_bad_${index}`, email))).toContain(REFUSAL);
    }
    expect(await accountCount(d1)).toBe(before);
  });

  it("refuses an update of an email to one with a capital", async () => {
    await addAccount(d1, "acc_update", "update@x.com");

    expect(await refusal(setEmail(d1, "acc_update", "Update@x.com"))).toContain(REFUSAL);
    expect(await emailOf(d1, "acc_update")).toBe("update@x.com");
  });

  it("names neither the row nor the value it refuses", async () => {
    const error = await refusal(addAccount(d1, "acc_secret", "Secret.Person@x.com"));
    expect(error).toContain(REFUSAL);
    for (const detail of ["acc_secret", "Secret.Person", "x.com"]) {
      expect(error).not.toContain(detail);
    }
  });

  // What every writer stores: JavaScript's `toLowerCase()` of what was typed,
  // or a lower-case literal. A lower-case letter outside A to Z passes too.
  it("takes a lower-case email on insert and on update, ASCII or not", async () => {
    await addAccount(d1, "acc_ok", "ok@x.com");
    await setEmail(d1, "acc_ok", "renamed@x.com");
    await addAccount(d1, "acc_accent", "zoë@x.com");

    expect(await emailOf(d1, "acc_ok")).toBe("renamed@x.com");
    expect(await emailOf(d1, "acc_accent")).toBe("zoë@x.com");
  });
});

describe("the email check over rows stored before it", () => {
  let d1: D1Database;
  let before: Record<string, unknown>[];
  let outcome: { failedAt: number; error: string };

  beforeAll(async () => {
    d1 = await database("STORED", BEFORE_EMAIL_CHECK);
    await addAccount(d1, "acc_lone", "Lone.Person@Example.COM");
    // A pair that differs only in case, one of them lower case.
    await addAccount(d1, "acc_pair_a", "Pair@x.com");
    await addAccount(d1, "acc_pair_b", "pair@x.com");
    // A pair that differs only in case, neither of them lower case.
    await addAccount(d1, "acc_caps_a", "Caps@x.com");
    await addAccount(d1, "acc_caps_b", "CAPS@x.com");
    await addAccount(d1, "acc_plain", "plain@x.com");
    before = await accountRows(d1);
    outcome = await applyEmailCheck(d1);
  });

  it("completes, and leaves every row exactly as it was", async () => {
    expect(outcome).toEqual({ failedAt: -1, error: "" });
    expect(await accountRows(d1)).toEqual(before);
    expect(await triggerNames(d1)).toEqual(TRIGGERS);
  });

  it("lets such a row change any column but take a new email with a capital", async () => {
    await d1.prepare("UPDATE accounts SET last_recovered_at = 5 WHERE id = 'acc_caps_a'").run();
    expect(await emailOf(d1, "acc_caps_a")).toBe("Caps@x.com");

    expect(await refusal(setEmail(d1, "acc_lone", "Other.Person@x.com"))).toContain(REFUSAL);
    await setEmail(d1, "acc_lone", "lone.person@example.com");
    expect(await emailOf(d1, "acc_lone")).toBe("lone.person@example.com");
  });
});

it("the email check runs again from the top, after a whole run and after a part-run", async () => {
  const d1 = await database("RERUN", BEFORE_EMAIL_CHECK);
  await addAccount(d1, "acc_again", "Again@x.com");

  // A run that stopped after its first statement, then the whole file twice.
  await d1.prepare(statementsOf(EMAIL_CHECK)[0]!).run();
  await applyFile(d1, EMAIL_CHECK);
  await applyFile(d1, EMAIL_CHECK);

  expect(await triggerNames(d1)).toEqual(TRIGGERS);
  expect(await emailOf(d1, "acc_again")).toBe("Again@x.com");
});
