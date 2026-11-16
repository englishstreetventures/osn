import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { weddingHosts } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { RESTORE_WINDOW_S } from "../../src/db/live-wedding";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { MAX_EXPORT_SEATS } from "../../src/services/account-export";
import { appRequest, failStatements } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { OSN_ISSUER, osnArc } from "../test-helpers/osn-arc";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

/**
 * osn-api's account-export call on cire-api: who may make it, what it refuses,
 * and what it answers about the person's seats. Each test names its failure
 * mode in `NEW-FEAT.md` (C1–C11).
 */

const EXPORT = "/internal/account-export";
const PORTAL = "https://host.example.test";
const P = "usr_person";
const P2 = "usr_person_second";
const CO = "usr_co_owner";
const STRANGER = "usr_stranger";

let arc: Awaited<ReturnType<typeof osnArc>>;
let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});
beforeEach(async () => {
  arc = await osnArc();
});
afterEach(() => {
  arc.restore();
});

const seat = (
  db: TestDb,
  weddingId: string,
  osnProfileId: string,
  role: "owner" | "editor" | "viewer" | "helper",
  addedBy: string,
  createdAt = new Date("2026-09-01T00:00:00Z"),
) =>
  db
    .insert(weddingHosts)
    .values({
      id: `whost_${weddingId}_${osnProfileId}`,
      weddingId,
      osnProfileId,
      addedByOsnProfileId: addedBy,
      role,
      createdAt,
    })
    .run();

function setup(organiserOrigin = PORTAL) {
  const db = createDb(":memory:");
  const app = createApp(db, { osnIssuerUrl: OSN_ISSUER, osnTestKey: auth.key, organiserOrigin });
  return { db, app };
}

const post = (app: ReturnType<typeof createApp>, authorization: string | null, body: unknown) =>
  appRequest(app, EXPORT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const exportBody = (profileIds: readonly string[] = [P]) => ({
  account_id: "acc_person",
  profile_ids: profileIds,
});

/** The NDJSON answer as parsed lines. */
async function lines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const records = (all: Record<string, unknown>[]) =>
  all.map((line) => line.record as Record<string, unknown>);

describe("ARC on the account export (refusals)", () => {
  it("C1: no token is refused before anything is read", async () => {
    const { db, app } = setup();
    insertWedding(db, { id: "w1", slug: "w1", displayName: "One", owners: [P] });
    const reads = failStatements(db, () => true);
    const res = await post(app, null, exportBody());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(reads.failed()).toBe(0);
    reads.restore();
  });

  it("C2: a token from an issuer other than osn-api is refused", async () => {
    const { app } = setup();
    const res = await post(
      app,
      await arc.token("account:export", { iss: "zap-api" }),
      exportBody(),
    );
    expect(res.status).toBe(401);
  });

  it("C3: a token for another app's audience is refused", async () => {
    const { app } = setup();
    const res = await post(
      app,
      await arc.token("account:export", { aud: "pulse-api" }),
      exportBody(),
    );
    expect(res.status).toBe(401);
  });

  it("C4: a deletion scope does not open the export", async () => {
    const { app } = setup();
    for (const scope of ["account:erase", "account:deletion-preview"]) {
      const res = await post(app, await arc.token(scope), exportBody());
      expect({ scope, status: res.status }).toEqual({ scope, status: 401 });
    }
  });

  it("C4b: the export scope opens neither deletion call", async () => {
    const { db, app } = setup();
    insertWedding(db, { id: "w1", slug: "w1", displayName: "One", owners: [P] });
    const token = await arc.token("account:export");
    const erase = await appRequest(app, "/internal/account-deleted", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ accountId: "acc_person", profileIds: [P], choices: {} }),
    });
    expect(erase.status).toBe(401);
    const preview = await appRequest(app, "/internal/account-deletion-preview", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ profileIds: [P], deletesAt: 1 }),
    });
    expect(preview.status).toBe(401);
    expect(
      db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, P)).all(),
    ).toHaveLength(1);
  });

  it("C5: a body outside the contract is refused", async () => {
    const { app } = setup();
    const token = await arc.token("account:export");
    for (const body of [
      "{not json",
      { account_id: "acc_person" },
      { profile_ids: [P] },
      exportBody(["not-a-profile"]),
      exportBody(["xusr_a"]),
      exportBody(["usr_a-b"]),
      exportBody(Array.from({ length: 101 }, (_, i) => `usr_${i}`)),
      { account_id: "", profile_ids: [P] },
    ]) {
      const res = await post(app, token, body);
      expect({
        body: JSON.stringify(body).slice(0, 50),
        status: res.status,
        answer: await res.json(),
      }).toEqual({
        body: JSON.stringify(body).slice(0, 50),
        status: 400,
        answer: { error: "invalid_request" },
      });
    }
  });
});

describe("what the export answers about the person's seats", () => {
  it("C6: only the named profiles' seats, other owners counted and never named", async () => {
    const { db, app } = setup();
    insertWedding(db, { id: "w_shared", slug: "shared", displayName: "Shared", owners: [] });
    seat(db, "w_shared", CO, "owner", CO, new Date("2026-08-01T00:00:00Z"));
    seat(db, "w_shared", P, "owner", CO);
    seat(db, "w_shared", "usr_editor", "editor", CO);
    insertWedding(db, { id: "w_helped", slug: "helped", displayName: "Helped", owners: [] });
    seat(db, "w_helped", STRANGER, "owner", STRANGER);
    seat(db, "w_helped", P2, "helper", STRANGER, new Date("2026-09-02T00:00:00Z"));
    insertWedding(db, { id: "w_elsewhere", slug: "else", displayName: "Else", owners: [STRANGER] });

    const ok = await counterValue(CIRE_METRICS.accountExportRequests, { result: "ok" });
    const res = await post(app, await arc.token("account:export"), exportBody([P, P2]));
    expect(res.status).toBe(200);
    expect(await counterValue(CIRE_METRICS.accountExportRequests, { result: "ok" })).toBe(ok + 1);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const all = await lines(res);
    expect(all.every((line) => line.section === "cire.weddings")).toBe(true);
    expect(records(all)).toEqual([
      {
        weddingId: "w_shared",
        name: "Shared",
        profileId: P,
        role: "owner",
        seatAddedAt: "2026-09-01T00:00:00.000Z",
        seatAddedBy: CO,
        otherOwners: 1,
        deletedAt: null,
        restoreUntil: null,
        deletedByYou: false,
        download: `${PORTAL}/#/w/w_shared/settings/export`,
      },
      {
        weddingId: "w_helped",
        name: "Helped",
        profileId: P2,
        role: "helper",
        seatAddedAt: "2026-09-02T00:00:00.000Z",
        seatAddedBy: STRANGER,
        otherOwners: 1,
        deletedAt: null,
        restoreUntil: null,
        deletedByYou: false,
        download: null,
      },
    ]);
    // The editor on the shared wedding, and the wedding the person has no
    // seat on, appear nowhere; a co-owner only as who added the seat.
    const text = JSON.stringify(all);
    expect(text).not.toContain("usr_editor");
    expect(text).not.toContain("w_elsewhere");
    expect(text.split(CO).length - 1).toBe(1);
  });

  it("C7: a deleted wedding tells an owner and the one who deleted it, and nobody else", async () => {
    const { db, app } = setup();
    const deletedAt = new Date("2026-10-01T00:00:00Z");
    const restoreUntil = new Date((deletedAt.getTime() / 1000 + RESTORE_WINDOW_S) * 1000);
    insertWedding(db, {
      id: "w_gone_owned",
      slug: "gone-owned",
      displayName: "Gone owned",
      owners: [P],
      deletedAt,
      deletedByOsnProfileId: P,
    });
    insertWedding(db, {
      id: "w_gone_cohost",
      slug: "gone-cohost",
      displayName: "Gone co-hosted",
      owners: [STRANGER],
      deletedAt,
      deletedByOsnProfileId: STRANGER,
    });
    seat(db, "w_gone_cohost", P, "editor", STRANGER);
    // Past its window and not yet purged: the seat is still held.
    insertWedding(db, {
      id: "w_gone_long",
      slug: "gone-long",
      displayName: "Gone long ago",
      owners: [P, STRANGER],
      deletedAt: new Date("2026-01-01T00:00:00Z"),
      deletedByOsnProfileId: STRANGER,
    });

    const res = await post(app, await arc.token("account:export"), exportBody());
    const byId = new Map(records(await lines(res)).map((r) => [r.weddingId, r]));
    expect(byId.size).toBe(3);
    expect(byId.get("w_gone_owned")).toMatchObject({
      role: "owner",
      deletedAt: deletedAt.toISOString(),
      restoreUntil: restoreUntil.toISOString(),
      deletedByYou: true,
      download: null,
    });
    expect(byId.get("w_gone_cohost")).toMatchObject({
      role: "editor",
      deletedAt: null,
      restoreUntil: null,
      deletedByYou: false,
      download: null,
    });
    expect(byId.get("w_gone_long")).toMatchObject({
      role: "owner",
      deletedAt: "2026-01-01T00:00:00.000Z",
      deletedByYou: false,
      download: null,
    });
  });

  it("C8: past the seat cap, the answer ends with a degraded line", async () => {
    const { db, app } = setup();
    for (let i = 0; i <= MAX_EXPORT_SEATS; i++) {
      insertWedding(db, { id: `w_${i}`, slug: `w-${i}`, displayName: `W ${i}`, owners: [P] });
    }
    const all = await lines(await post(app, await arc.token("account:export"), exportBody()));
    expect(all).toHaveLength(MAX_EXPORT_SEATS + 1);
    expect(all.slice(0, MAX_EXPORT_SEATS).every((line) => line.section === "cire.weddings")).toBe(
      true,
    );
    expect(all.at(-1)).toEqual({ degraded: "cire", reason: "too_many_weddings" });
  });

  it("C8: exactly at the seat cap, the answer is whole", async () => {
    const { db, app } = setup();
    for (let i = 0; i < MAX_EXPORT_SEATS; i++) {
      insertWedding(db, { id: `w_${i}`, slug: `w-${i}`, displayName: `W ${i}`, owners: [P] });
    }
    const all = await lines(await post(app, await arc.token("account:export"), exportBody()));
    expect(all).toHaveLength(MAX_EXPORT_SEATS);
    expect(all.some((line) => "degraded" in line)).toBe(false);
  });

  it("C9: a call naming no profile gets an empty answer", async () => {
    const { db, app } = setup();
    insertWedding(db, { id: "w1", slug: "w1", displayName: "One", owners: [P] });
    const res = await post(app, await arc.token("account:export"), exportBody([]));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("C9: a person with no seat gets an empty answer", async () => {
    const { db, app } = setup();
    insertWedding(db, { id: "w1", slug: "w1", displayName: "One", owners: [STRANGER] });
    const res = await post(app, await arc.token("account:export"), exportBody());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("C10: a failed read answers 500 and logs no profile id", async () => {
    const { db, app } = setup();
    insertWedding(db, { id: "w1", slug: "w1", displayName: "One", owners: [P] });
    const before = await counterValue(CIRE_METRICS.accountExportRequests, { result: "error" });
    const reads = failStatements(db, (sql) => sql.includes('"wedding_hosts"'));
    const token = await arc.token("account:export");
    let status = 0;
    let body: unknown;
    const logs = await captureLogs(async () => {
      const res = await post(app, token, exportBody());
      status = res.status;
      body = await res.json();
    });
    reads.restore();
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal_error" });
    expect(reads.failed()).toBeGreaterThan(0);
    expect(logs).toContain("account export failed");
    expect(logs).not.toContain(P);
    expect(await counterValue(CIRE_METRICS.accountExportRequests, { result: "error" })).toBe(
      before + 1,
    );
  });

  it("C11: the download link needs an https portal, or http on a loopback host", async () => {
    for (const [origin, link] of [
      ["http://host.example.test", null],
      ["ftp://localhost", null],
      ["http://[::1]:4322", "http://[::1]:4322/#/w/w1/settings/export"],
      ["http://localhost:4322", "http://localhost:4322/#/w/w1/settings/export"],
      ["http://127.0.0.1:4322", "http://127.0.0.1:4322/#/w/w1/settings/export"],
      ["https://host.example.test/", `${PORTAL}/#/w/w1/settings/export`],
    ] as const) {
      const { db, app } = setup(origin);
      insertWedding(db, { id: "w1", slug: "w1", displayName: "One", owners: [P] });
      const [record] = records(
        await lines(await post(app, await arc.token("account:export"), exportBody())),
      );
      expect({ origin, download: record?.download }).toEqual({ origin, download: link });
    }
  });
});
