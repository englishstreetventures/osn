import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

/**
 * Migration 20261126014432_end_passkeyless_sessions, on real D1: it ends the
 * ordinary sessions of every account that holds no passkey, and nothing else —
 * not a session of an account with a passkey, not a restricted session (a
 * recovery's or a sign-up's), and no session of an account with a deletion
 * job, whose kept session may be its only way to cancel. No other table
 * changes.
 *
 * The database is built from the migration files up to the one under test,
 * and the rows are stored before it runs, as a deployed database holds them.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "drizzle");
const END = "20261126014432_end_passkeyless_sessions.sql";

const CHAIN = listMigrations(MIGRATIONS_DIR);
/** The chain before the migration: the database it meets. */
const BEFORE_END = CHAIN.slice(0, CHAIN.indexOf(END));

const statementsOf = (file: string): readonly string[] =>
  migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

async function applyFile(d1: D1Database, file: string): Promise<void> {
  for (const statement of statementsOf(file)) await d1.prepare(statement).run();
}

const addAccount = (d1: D1Database, id: string) =>
  d1
    .prepare(
      "INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
    )
    .bind(id, `${id}@example.com`, `pku_${id}`)
    .run();

const addPasskey = (d1: D1Database, id: string, accountId: string) =>
  d1
    .prepare(
      "INSERT INTO passkeys (id, account_id, credential_id, public_key, created_at) VALUES (?, ?, ?, 'AQIDBA==', 1)",
    )
    .bind(id, accountId, `cred_${id}`)
    .run();

/** A session; `restrictedUntil` set makes it a restricted one, with `amr` as its record. */
const addSession = (
  d1: D1Database,
  id: string,
  accountId: string,
  restricted: { until: number; amr: string } | null = null,
) =>
  d1
    .prepare(
      `INSERT INTO sessions (id, account_id, family_id, expires_at, created_at, authenticated_at,
         ua_label, last_used_at, restricted_until, restricted_amr)
       VALUES (?, ?, ?, 900, 100, 90, 'Firefox on macOS', 200, ?, ?)`,
    )
    .bind(id, accountId, `sfam_${id}`, restricted?.until ?? null, restricted?.amr ?? null)
    .run();

const ids = async (d1: D1Database, table: string) =>
  (await d1.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results.map(
    (row) => row.id,
  );

const rowsOf = async (d1: D1Database, table: string) =>
  (await d1.prepare(`SELECT * FROM ${table} ORDER BY 1`).all<Record<string, unknown>>()).results;

let mf: Miniflare;
let d1: D1Database;
let sessionsBefore: Record<string, unknown>[];
const untouched: Record<string, Record<string, unknown>[]> = {};

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: "sessions-passkeyless-ended" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  expect(CHAIN).toContain(END);
  for (const file of BEFORE_END) await applyFile(d1, file);

  // An account with a passkey: its sessions are its own business.
  await addAccount(d1, "acc_keyed");
  await addPasskey(d1, "pk_keyed", "acc_keyed");
  await addSession(d1, "ses_keyed", "acc_keyed");
  // An account with none, signed in the way a sign-up before this release
  // left it, beside a sign-up's restricted session and a recovery's.
  await addAccount(d1, "acc_bare");
  await addSession(d1, "ses_bare_a", "acc_bare");
  await addSession(d1, "ses_bare_b", "acc_bare");
  await addSession(d1, "ses_bare_signup", "acc_bare", { until: 900, amr: "signup" });
  await addSession(d1, "ses_bare_recovery", "acc_bare", { until: 900, amr: "otp" });
  // An account with none and a deletion job, as a job written before the
  // restore record leaves it: the kept session is how it cancels.
  await addAccount(d1, "acc_leaving");
  await addSession(d1, "ses_leaving", "acc_leaving");
  await d1
    .prepare(
      "INSERT INTO deletion_jobs (account_id, soft_deleted_at, hard_delete_at, cancel_session_id) VALUES ('acc_leaving', 1, 2, 'ses_leaving')",
    )
    .run();

  sessionsBefore = await rowsOf(d1, "sessions");
  for (const table of ["accounts", "passkeys", "deletion_jobs"]) {
    untouched[table] = await rowsOf(d1, table);
  }
  await applyFile(d1, END);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("ending the sessions of accounts with no passkey", () => {
  it("ends the ordinary sessions of an account with no passkey, and only those", async () => {
    expect(await ids(d1, "sessions")).toEqual([
      "ses_bare_recovery",
      "ses_bare_signup",
      "ses_keyed",
      "ses_leaving",
    ]);
  });

  it("changes nothing in a session it keeps", async () => {
    const kept = new Set(await ids(d1, "sessions"));
    expect(await rowsOf(d1, "sessions")).toEqual(
      sessionsBefore.filter((row) => kept.has(row.id as string)),
    );
  });

  it("changes no account, passkey or deletion job", async () => {
    for (const table of ["accounts", "passkeys", "deletion_jobs"]) {
      expect(await rowsOf(d1, table)).toEqual(untouched[table]!);
    }
  });

  it("finds nothing more to end when it runs again", async () => {
    const before = await ids(d1, "sessions");
    await applyFile(d1, END);
    expect(await ids(d1, "sessions")).toEqual(before);
  });
});
