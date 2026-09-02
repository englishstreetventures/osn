import { describe, it, expect } from "bun:test";

import { weddingEntitlements, weddingHosts, weddings } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { weddingEditor } from "../../src/middleware/wedding-editor";
import { weddingEntitlement } from "../../src/middleware/wedding-entitlement";
import { weddingMember } from "../../src/middleware/wedding-member";
import { countingDb, appRequest, jsonBody } from "../test-helpers";

/**
 * Proves P-W1 (osn-tracker#116): folding the entitlement check into the role
 * gate's own authorize() query must (a) drop a GATED route's query count —
 * previously the role gate's own 1-2 queries PLUS a separate
 * `entitlementService.has()` query — and (b) leave every route that mounts
 * ONLY a role gate, no entitlement gate, at EXACTLY the query count it always
 * had. (b) is the one a naive "always fetch the set in the role gate" fix
 * would silently break, which is why it gets its own assertions here rather
 * than trusting (a) to cover it.
 */

const WEDDING_ID = "wed_fold";
const OWNER = "usr_owner";
const COHOST = "usr_cohost";

// No explicit `Db` return type: these tests reach for `$client.exec` to break
// one table on purpose, and `Db` does not surface the underlying client.
function buildDb(opts: { grantVendors: boolean }) {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(weddings)
    .values({
      id: WEDDING_ID,
      slug: "fold-wedding",
      displayName: "Fold Wedding",
      ownerOsnProfileId: OWNER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_cohost",
      weddingId: WEDDING_ID,
      osnProfileId: COHOST,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: now,
    })
    .run();
  if (opts.grantVendors) {
    db.insert(weddingEntitlements)
      .values({
        weddingId: WEDDING_ID,
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
      })
      .run();
  }
  return db;
}

function gatedApp(db: Db, profileId: string) {
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/w/:weddingId", (g) =>
      g
        .use(weddingMember(db, "vendors"))
        .use(weddingEntitlement(db, "vendors"))
        .get("/thing", () => ({ ok: true })),
    );
}

function gatedEditorApp(db: Db, profileId: string) {
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/w/:weddingId", (g) =>
      g
        .use(weddingEditor(db, "vendors"))
        .use(weddingEntitlement(db, "vendors"))
        .post("/thing", () => ({ ok: true })),
    );
}

/** Mirrors a route file that mounts ONLY the role gate — tasks.ts, budget.ts,
 *  invite.ts, organiser-hosts.ts, and the rest of the ~dozen route files
 *  weddingEntitlement never touches. */
function ungatedApp(db: Db, profileId: string) {
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/w/:weddingId", (g) => g.use(weddingMember(db)).get("/thing", () => ({ ok: true })));
}

/**
 * A route whose role gate folds ONE key while the entitlement gate asks for
 * ANOTHER. Nothing in the tree does this today — every pairing in `routes/`
 * matches — but the mismatch guard is what makes the fold safe to extend, so
 * it is worth a test rather than a comment. If the guard ever stops working,
 * the fold answers "registry" with the "vendors" row and the gate lets a
 * caller past an entitlement they do not hold.
 */
function mismatchedApp(db: Db, profileId: string) {
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/w/:weddingId", (g) =>
      g
        .use(weddingMember(db, "vendors"))
        .use(weddingEntitlement(db, "registry"))
        .get("/thing", () => ({ ok: true })),
    );
}

/** The entitlement gate with no role gate above it at all. */
function standaloneApp(db: Db, profileId: string) {
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId, weddingId: WEDDING_ID }))
    .group("/w/:weddingId", (g) =>
      g.use(weddingEntitlement(db, "vendors")).get("/thing", () => ({ ok: true })),
    );
}

function ungatedEditorApp(db: Db, profileId: string) {
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: profileId }))
    .group("/w/:weddingId", (g) => g.use(weddingEditor(db)).post("/thing", () => ({ ok: true })));
}

describe("P-W1: role-gate/entitlement-gate query fold", () => {
  it("a co-host on a GATED route costs 2 selects, not 3", async () => {
    const db = buildDb({ grantVendors: true });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(gatedApp(counted, COHOST), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ ok: true });
    expect(selectCount()).toBe(2);
  });

  it("an owner on a GATED route costs 1 select, not 2", async () => {
    const db = buildDb({ grantVendors: true });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(gatedApp(counted, OWNER), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(200);
    expect(selectCount()).toBe(1);
  });

  it("the fold still answers correctly when the entitlement is ABSENT (402), at the same reduced cost", async () => {
    const db = buildDb({ grantVendors: false });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(gatedApp(counted, COHOST), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual({ error: "payment_required", entitlement: "vendors" });
    expect(selectCount()).toBe(2);
  });

  it("weddingEditor's fold matches weddingMember's — 2 selects for a co-host, granted", async () => {
    const db = buildDb({ grantVendors: true });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(gatedEditorApp(counted, COHOST), `/w/${WEDDING_ID}/thing`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(selectCount()).toBe(2);
  });

  it("a co-host on a route with ONLY the role gate (no entitlement gate) still costs 2 selects — UNCHANGED", async () => {
    const db = buildDb({ grantVendors: true });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(ungatedApp(counted, COHOST), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(200);
    // Same 2 selects authorize() has always cost a co-host (owner-row lookup +
    // host-row lookup). A regression here means the role gate started paying
    // for the entitlement fold even though nothing downstream asked for it —
    // exactly the repo-wide regression this task exists to avoid.
    expect(selectCount()).toBe(2);
  });

  it("an owner on a route with ONLY the role gate still costs 1 select — UNCHANGED", async () => {
    const db = buildDb({ grantVendors: true });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(ungatedApp(counted, OWNER), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(200);
    expect(selectCount()).toBe(1);
  });

  it("weddingEditor with no entitlement key: co-host still 2 selects, owner still 1 — UNCHANGED", async () => {
    const dbCohost = buildDb({ grantVendors: true });
    const { db: countedCohost, selectCount: countCohost } = countingDb(dbCohost);
    const resCohost = await appRequest(
      ungatedEditorApp(countedCohost, COHOST),
      `/w/${WEDDING_ID}/thing`,
      { method: "POST" },
    );
    expect(resCohost.status).toBe(200);
    expect(countCohost()).toBe(2);

    const dbOwner = buildDb({ grantVendors: true });
    const { db: countedOwner, selectCount: countOwner } = countingDb(dbOwner);
    const resOwner = await appRequest(
      ungatedEditorApp(countedOwner, OWNER),
      `/w/${WEDDING_ID}/thing`,
      {
        method: "POST",
      },
    );
    expect(resOwner.status).toBe(200);
    expect(countOwner()).toBe(1);
  });

  // The mismatch guard. A fold carries the key it answers; a gate asking a
  // DIFFERENT key must ignore it and pay for its own query rather than trust
  // an answer to a question it did not ask.
  it("refuses a fold for a different key, and falls back to its own query", async () => {
    // "vendors" granted, "registry" NOT — so trusting the mismatched fold
    // would wrongly let the caller through.
    const db = buildDb({ grantVendors: true });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(mismatchedApp(counted, COHOST), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual({ error: "payment_required", entitlement: "registry" });
    // 2 for the role gate, plus the fallback has() the mismatch forced.
    expect(selectCount()).toBe(3);
  });

  it("answers correctly with no role gate above it, at the old cost", async () => {
    const db = buildDb({ grantVendors: true });
    const { db: counted, selectCount } = countingDb(db);
    const res = await appRequest(standaloneApp(counted, COHOST), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(200);
    expect(selectCount()).toBe(1);
  });

  // S-L1 (found reviewing this branch): folding the entitlement probe into the
  // role query folded their failure modes together too. A defect confined to
  // `wedding_entitlements` used to deny only the entitlement half — a scoped
  // 402 — while the role check, a separate query, still answered. In one
  // SELECT it would take the whole route down with a generic 500. The fold now
  // catches its own defect and falls back to the plain role query, which
  // restores the old contract.
  it("degrades to a scoped 402, not a 500, when the entitlement table is broken", async () => {
    const db = buildDb({ grantVendors: true });
    // Break ONLY the entitlement side. The role tables are untouched, so the
    // plain fallback can still answer who the caller is.
    db.$client.exec("DROP TABLE wedding_entitlements");
    const res = await appRequest(gatedApp(db, COHOST), `/w/${WEDDING_ID}/thing`);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual({ error: "payment_required", entitlement: "vendors" });
  });

  it("still answers the owner's role through the fallback when the fold breaks", async () => {
    const db = buildDb({ grantVendors: true });
    db.$client.exec("DROP TABLE wedding_entitlements");
    const res = await appRequest(ungatedApp(db, OWNER), `/w/${WEDDING_ID}/thing`);
    // No entitlement gate on this route at all, so a broken entitlement table
    // must not touch it — the role gate passes no key and never folds.
    expect(res.status).toBe(200);
  });
});
