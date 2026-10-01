// The operator tool's SQL runs against a real SQLite table here, through a
// runner that stands in for `wrangler d1 execute --json` and returns the same
// shape (one result object per statement, `meta.changes` on writes). So these
// tests prove the statements themselves — the checks, the guarded UPDATEs and
// `unixepoch()` — not just the strings.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  confirmSql,
  parseArgs,
  rejectSql,
  run,
  showSql,
  targetArgs,
  type Runner,
} from "../cire-vendor-claim-review";

const DDL = `
CREATE TABLE directory_vendors (
  id TEXT PRIMARY KEY,
  owner_org_id TEXT,
  name TEXT NOT NULL,
  email TEXT,
  website TEXT,
  listed TEXT NOT NULL DEFAULT 'draft',
  claimed_by_profile_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  review_org_id TEXT,
  review_profile_id TEXT,
  review_requested_at INTEGER,
  handoff_due_at INTEGER
);
CREATE UNIQUE INDEX directory_vendors_owner_uniq ON directory_vendors(owner_org_id);
CREATE UNIQUE INDEX directory_vendors_review_org_uniq ON directory_vendors(review_org_id);
`;

function setup() {
  const db = new Database(":memory:");
  db.exec(DDL);
  db.run(
    `INSERT INTO directory_vendors (id, name, email, website, created_at, updated_at, review_org_id, review_profile_id, review_requested_at)
     VALUES ('dv_pending', 'Bloom', 'hi@bloom.test', 'bloom.test', 0, 0, 'org_v', 'usr_v', 100)`,
  );
  db.run(
    `INSERT INTO directory_vendors (id, name, created_at, updated_at) VALUES ('dv_free', 'Free', 0, 0)`,
  );
  const sent: string[] = [];
  const runner: Runner = async (_env, sql) => {
    sent.push(sql);
    if (/^select/i.test(sql)) return [{ results: db.query(sql).all(), meta: { changes: 0 } }];
    const res = db.run(sql);
    return [{ results: [], meta: { changes: res.changes } }];
  };
  const lines: string[] = [];
  return { db, runner, sent, lines, print: (l: string) => lines.push(l) };
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

  test("target each tier's database", () => {
    expect(targetArgs("production")).toEqual(["cire-db", "--env", "production", "--remote"]);
    expect(targetArgs("dev")).toEqual(["cire-db-dev", "--env", "dev", "--remote"]);
    expect(targetArgs("local")).toEqual(["cire-db", "--local"]);
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
    // Seconds, the unit Drizzle's `mode: "timestamp"` reads.
    expect(Math.abs((r.handoff_due_at as number) - Date.now() / 1000)).toBeLessThan(60);
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
    expect(r.handoff_due_at).toBeNull();
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

  test("reports a claim that changed between the check and the write", async () => {
    const t = setup();
    const racing: Runner = async (env, sql) => {
      if (/^update/i.test(sql)) {
        t.db.run("UPDATE directory_vendors SET review_org_id = NULL WHERE id = 'dv_pending'");
      }
      return t.runner(env, sql);
    };
    expect(await run(["confirm", "dv_pending", "--env", "dev", "--apply"], racing, t.print)).toBe(
      1,
    );
    expect(t.lines.join("\n")).toContain("changed 0 rows");
    expect(row(t.db, "dv_pending").owner_org_id).toBeNull();
  });
});
