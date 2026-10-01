// The operator tool's SQL runs here against SQLite built from cire's real
// migrations, through a runner that stands in for `wrangler d1 execute --json`
// and returns its shape (one result object per statement, rows in `results`,
// no `meta.changes`, as a local run gives). So these tests prove the statements
// against the schema production has — the checks, the guarded UPDATEs with
// RETURNING — not just the strings.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  confirmSql,
  parseArgs,
  rejectSql,
  run,
  showSql,
  targetArgs,
  type Runner,
} from "../cire-vendor-claim-review";

const ROOT = join(import.meta.dir, "..", "..");

/** A schema as production has it: every migration in `dir`, in name order. */
function migratedDb(dir: string): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}

function setup() {
  const db = migratedDb(join(ROOT, "cire", "db", "migrations"));
  const osn = migratedDb(join(ROOT, "osn", "db", "drizzle"));
  // Only the columns the lookup reads matter; the profile needs no account row.
  osn.exec("PRAGMA foreign_keys = OFF;");
  osn.run(
    `INSERT INTO users (id, account_id, handle, created_at, updated_at) VALUES ('usr_v', 'acc_v', 'bloomvendor', 0, 0)`,
  );
  osn.run(
    `INSERT INTO organisations (id, handle, name, owner_id, created_at, updated_at) VALUES ('org_v', 'bloom', 'Bloom Florals', 'usr_v', 0, 0)`,
  );
  osn.run(
    `INSERT INTO organisation_members (id, organisation_id, profile_id, role, created_at) VALUES ('orgm_v', 'org_v', 'usr_v', 'admin', 0)`,
  );
  db.run(
    `INSERT INTO directory_vendors (id, name, email, website, created_at, updated_at, review_org_id, review_profile_id, review_requested_at)
     VALUES ('dv_pending', 'Bloom', 'hi@bloom.test', 'bloom.test', 0, 0, 'org_v', 'usr_v', 100)`,
  );
  db.run(
    `INSERT INTO directory_vendors (id, name, created_at, updated_at) VALUES ('dv_free', 'Free', 0, 0)`,
  );
  const sent: string[] = [];
  const runner: Runner = async (target, _env, sql) => {
    sent.push(sql);
    return [{ results: (target === "cire" ? db : osn).query(sql).all() }];
  };
  const lines: string[] = [];
  return { db, osn, runner, sent, lines, print: (l: string) => lines.push(l) };
}

const row = (db: Database, id: string) =>
  db.query("SELECT * FROM directory_vendors WHERE id = ?").get(id) as Record<string, unknown>;

describe("parseArgs", () => {
  test("requires --env", () => {
    expect(parseArgs(["list"])).toHaveProperty("error");
  });

  test("defaults confirm and reject to a dry run", () => {
    expect(parseArgs(["confirm", "dv_a", "--env", "dev"])).toEqual({
      command: "confirm",
      listingId: "dv_a",
      env: "dev",
      apply: false,
    });
  });

  test("refuses a listing id that is not a dv_ id or could break out of SQL", () => {
    expect(parseArgs(["confirm", "x", "--env", "dev"])).toHaveProperty("error");
    expect(parseArgs(["reject", "dv_a' OR 1=1 --", "--env", "dev"])).toHaveProperty("error");
  });

  test("refuses an unknown env and an unknown flag", () => {
    expect(parseArgs(["list", "--env", "staging"])).toHaveProperty("error");
    expect(parseArgs(["list", "--env", "dev", "--force"])).toHaveProperty("error");
  });
});

describe("SQL builders", () => {
  test("refuse an id with a quote in it", () => {
    expect(() => showSql("dv_a'")).toThrow();
    expect(() => confirmSql("dv_a", "org'", "usr_a")).toThrow();
    expect(() => rejectSql("dv_a", "org_a; DROP TABLE x")).toThrow();
  });

  test("target each tier's database, and never --remote without --env", () => {
    expect(targetArgs("cire", "production")).toEqual([
      "cire-db",
      "--env",
      "production",
      "--remote",
    ]);
    expect(targetArgs("cire", "dev")).toEqual(["cire-db-dev", "--env", "dev", "--remote"]);
    expect(targetArgs("cire", "local")).toEqual(["cire-db", "--local"]);
    expect(targetArgs("osn", "production")).toEqual([
      "osn-db-prod",
      "--env",
      "production",
      "--remote",
    ]);
    expect(targetArgs("osn", "local")).toEqual(["osn-db", "--local"]);
  });
});

describe("run", () => {
  test("list prints the pending claims", async () => {
    const t = setup();
    expect(await run(["list", "--env", "dev"], t.runner, t.print)).toBe(0);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain("dv_pending");
  });

  test("confirm without --apply writes nothing", async () => {
    const t = setup();
    expect(await run(["confirm", "dv_pending", "--env", "dev"], t.runner, t.print)).toBe(0);
    expect(t.sent.filter((s) => /^update/i.test(s))).toHaveLength(0);
    expect(row(t.db, "dv_pending").review_org_id).toBe("org_v");
    expect(t.lines.join("\n")).toContain("Dry run");
  });

  test("confirm --apply moves the claim into the owner columns and makes it live", async () => {
    // updated_at is written in seconds, the unit Drizzle's `mode: "timestamp"` reads.
    const t = setup();
    expect(await run(["confirm", "dv_pending", "--env", "dev", "--apply"], t.runner, t.print)).toBe(
      0,
    );
    const r = row(t.db, "dv_pending");
    expect(r.owner_org_id).toBe("org_v");
    expect(r.claimed_by_profile_id).toBe("usr_v");
    expect(r.listed).toBe("live");
    expect(r.review_org_id).toBeNull();
    expect(r.review_profile_id).toBeNull();
    expect(r.review_requested_at).toBeNull();
    expect(Math.abs((r.updated_at as number) - Date.now() / 1000)).toBeLessThan(60);
  });

  test("reject --apply clears the claim and leaves the listing unowned", async () => {
    const t = setup();
    expect(await run(["reject", "dv_pending", "--env", "dev", "--apply"], t.runner, t.print)).toBe(
      0,
    );
    const r = row(t.db, "dv_pending");
    expect(r.review_org_id).toBeNull();
    expect(r.owner_org_id).toBeNull();
    expect(r.listed).toBe("draft");
  });

  test("refuses a listing with no pending claim, or none at all", async () => {
    const t = setup();
    expect(await run(["confirm", "dv_free", "--env", "dev", "--apply"], t.runner, t.print)).toBe(1);
    expect(await run(["reject", "dv_none", "--env", "dev", "--apply"], t.runner, t.print)).toBe(1);
    expect(t.sent.filter((s) => /^update/i.test(s))).toHaveLength(0);
  });

  test("refuses to confirm when the org already owns another listing", async () => {
    const t = setup();
    t.db.run("UPDATE directory_vendors SET owner_org_id = 'org_v' WHERE id = 'dv_free'");
    expect(await run(["confirm", "dv_pending", "--env", "dev", "--apply"], t.runner, t.print)).toBe(
      1,
    );
    expect(t.lines.join("\n")).toContain("already owns listing dv_free");
    expect(row(t.db, "dv_pending").owner_org_id).toBeNull();
  });

  test("confirm shows the claimant's organisation from OSN", async () => {
    const t = setup();
    expect(await run(["confirm", "dv_pending", "--env", "dev"], t.runner, t.print)).toBe(0);
    const out = t.lines.join("\n");
    expect(out).toContain('Organisation "Bloom Florals" (@bloom)');
    expect(out).toContain("Claimant @bloomvendor is a admin of @bloom");
  });

  test("refuses to confirm when the claimant has left the organisation", async () => {
    const t = setup();
    t.osn.run("DELETE FROM organisation_members");
    expect(await run(["confirm", "dv_pending", "--env", "dev", "--apply"], t.runner, t.print)).toBe(
      1,
    );
    expect(t.lines.join("\n")).toContain("no longer a member of @bloom");
    expect(row(t.db, "dv_pending").owner_org_id).toBeNull();
  });

  test("refuses to confirm a claim for an organisation OSN does not have", async () => {
    const t = setup();
    t.db.run("UPDATE directory_vendors SET review_org_id = 'org_gone' WHERE id = 'dv_pending'");
    expect(await run(["confirm", "dv_pending", "--env", "dev", "--apply"], t.runner, t.print)).toBe(
      1,
    );
    expect(t.lines.join("\n")).toContain("OSN has no organisation");
  });

  test("reports a claim that changed between the check and the write", async () => {
    const t = setup();
    const racing: Runner = async (target, env, sql) => {
      if (/^update/i.test(sql)) {
        t.db.run("UPDATE directory_vendors SET review_org_id = NULL WHERE id = 'dv_pending'");
      }
      return t.runner(target, env, sql);
    };
    expect(await run(["confirm", "dv_pending", "--env", "dev", "--apply"], racing, t.print)).toBe(
      1,
    );
    expect(t.lines.join("\n")).toContain("changed 0 rows");
    expect(row(t.db, "dv_pending").owner_org_id).toBeNull();
  });
});
