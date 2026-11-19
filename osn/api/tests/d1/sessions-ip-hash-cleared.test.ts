import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

import { listMigrations, migrationStatements } from "../../../../scripts/migration-files";

/**
 * Migration 20261119031316_clear_sessions_ip_hash empties `sessions.ip_hash`
 * on real D1 and changes nothing else: no other column of a session, no row
 * count, and not `security_events.ip_hash`, which the security-events banner
 * still reads.
 *
 * The database is built from the migration files up to the one under test,
 * never from `createSchemaSql()`, which no longer declares the column. Rows of
 * two accounts are stored before the migration runs, as production holds them.
 */

const MF_TIMEOUT_MS = 30_000;
setDefaultTimeout(MF_TIMEOUT_MS);

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "db", "drizzle");
const CLEAR = "20261119031316_clear_sessions_ip_hash.sql";

const CHAIN = listMigrations(MIGRATIONS_DIR);
/** The chain before the migration: the database it meets. */
const BEFORE_CLEAR = CHAIN.slice(0, CHAIN.indexOf(CLEAR));

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

/** A session with every column set; `ipHash` null for a row that never had one. */
const addSession = (d1: D1Database, id: string, accountId: string, ipHash: string | null) =>
  d1
    .prepare(
      `INSERT INTO sessions (id, account_id, family_id, expires_at, created_at, authenticated_at,
         ua_label, ip_hash, last_used_at, restricted_until, restricted_amr, replaced_at)
       VALUES (?, ?, ?, 900, 100, 90, 'Firefox on macOS', ?, 200, 300, 'otp', 400)`,
    )
    .bind(id, accountId, `sfam_${id}`, ipHash)
    .run();

const sessionRows = async (d1: D1Database) =>
  (await d1.prepare("SELECT * FROM sessions ORDER BY id").all<Record<string, unknown>>()).results;

const securityEventRows = async (d1: D1Database) =>
  (await d1.prepare("SELECT * FROM security_events ORDER BY id").all<Record<string, unknown>>())
    .results;

let mf: Miniflare;
let d1: D1Database;
let sessionsBefore: Record<string, unknown>[];
let eventsBefore: Record<string, unknown>[];

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: "sessions-ip-hash-cleared" },
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  expect(CHAIN).toContain(CLEAR);
  for (const file of BEFORE_CLEAR) await applyFile(d1, file);

  await addAccount(d1, "acc_one");
  await addAccount(d1, "acc_two");
  await addSession(d1, "ses_one_a", "acc_one", "a".repeat(64));
  await addSession(d1, "ses_one_b", "acc_one", null);
  await addSession(d1, "ses_two_a", "acc_two", "b".repeat(64));
  await d1
    .prepare(
      `INSERT INTO security_events (id, account_id, kind, created_at, acknowledged_at, ip_hash, ua_label)
       VALUES ('sev_one', 'acc_one', 'passkey_register', 100, NULL, ?, 'Firefox on macOS')`,
    )
    .bind("c".repeat(64))
    .run();

  sessionsBefore = await sessionRows(d1);
  eventsBefore = await securityEventRows(d1);
  await applyFile(d1, CLEAR);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("clearing sessions.ip_hash", () => {
  it("leaves no session of either account holding an IP hash", async () => {
    const after = await sessionRows(d1);
    expect(after.map((row) => [row.id, row.ip_hash])).toEqual([
      ["ses_one_a", null],
      ["ses_one_b", null],
      ["ses_two_a", null],
    ]);
  });

  it("changes no other column of any session and removes no row", async () => {
    const withoutIpHash = (rows: Record<string, unknown>[]) =>
      rows.map(({ ip_hash: _ipHash, ...rest }) => rest);
    expect(withoutIpHash(await sessionRows(d1))).toEqual(withoutIpHash(sessionsBefore));
  });

  it("leaves the security events' IP hash as it was", async () => {
    expect(await securityEventRows(d1)).toEqual(eventsBefore);
    expect(eventsBefore[0]?.ip_hash).toBe("c".repeat(64));
  });
});
