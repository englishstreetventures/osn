import { describe, expect, it } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { Elysia } from "elysia";

import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { weddingEditor } from "../../src/middleware/wedding-editor";
import { weddingMember } from "../../src/middleware/wedding-member";
import { weddingOwner } from "../../src/middleware/wedding-owner";
import { weddingRunSheet } from "../../src/middleware/wedding-run-sheet";
import { weddingTier } from "../../src/middleware/wedding-tier";
import type { PaidTier, Tier } from "../../src/services/tiers";
import { appRequest, countingDb, jsonBody, setTier } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";

/**
 * The plan-tier gate, and the claim it rests on: the role gate in front of it
 * has already read the wedding's tier from the row it authorises against, so a
 * gated route costs exactly the queries the role gate always cost. A role gate
 * that stopped parking `weddingTier` would still answer correctly — the tier
 * gate reads it itself — so the select counts here are what fail instead.
 */

const WEDDING_ID = "wed_tier";
const OWNER = "usr_owner";
const EDITOR = "usr_editor";
const HELPER = "usr_helper";

// No explicit `Db` return type: one test writes a raw tier through `$client`.
function buildDb(tier: Tier) {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(weddings)
    .values({
      id: WEDDING_ID,
      slug: "tier-wedding",
      displayName: "Tier Wedding",
      ownerOsnProfileId: OWNER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const [osnProfileId, role] of [
    [EDITOR, "editor"],
    [HELPER, "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id: `whost_${role}`,
        weddingId: WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: now,
      })
      .run();
  }
  setTier(db, WEDDING_ID, tier);
  return db;
}

const paymentRequired = (tier: PaidTier) => ({ error: "payment_required", tier });
const path = `/w/${WEDDING_ID}/thing`;
const post = { method: "POST" };

type RoleGate = "member" | "editor" | "owner" | "runSheet";

function gated(db: Db, caller: string, gate: RoleGate, min: PaidTier) {
  const role =
    gate === "member"
      ? weddingMember(db)
      : gate === "editor"
        ? weddingEditor(db)
        : gate === "owner"
          ? weddingOwner(db)
          : weddingRunSheet(db);
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: caller }))
    .group("/w/:weddingId", (g) =>
      g
        .use(role)
        .use(weddingTier(db, min))
        .get("/thing", () => ({ ok: true }))
        .post("/thing", () => ({ ok: true })),
    );
}

function ungated(db: Db, caller: string, gate: RoleGate) {
  const role =
    gate === "member"
      ? weddingMember(db)
      : gate === "editor"
        ? weddingEditor(db)
        : gate === "owner"
          ? weddingOwner(db)
          : weddingRunSheet(db);
  return new Elysia({ aot: false })
    .derive(() => ({ osnProfileId: caller }))
    .group("/w/:weddingId", (g) => g.use(role).get("/thing", () => ({ ok: true })));
}

/** The tier gate with no role gate above it at all. */
function standalone(db: Db, min: PaidTier) {
  return new Elysia({ aot: false }).group("/w/:weddingId", (g) =>
    g.use(weddingTier(db, min)).get("/thing", () => ({ ok: true })),
  );
}

describe("weddingTier", () => {
  it("refuses an Ivory wedding a Gold route with 402 and the tier that unlocks it", async () => {
    const res = await appRequest(gated(buildDb("ivory"), OWNER, "member", "gold"), path);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual(paymentRequired("gold"));
  });

  it("refuses a Gold wedding a Crimson route, naming Crimson", async () => {
    const res = await appRequest(gated(buildDb("gold"), OWNER, "member", "crimson"), path);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual(paymentRequired("crimson"));
  });

  it("admits a wedding on the tier, and one above it", async () => {
    for (const [tier, min] of [
      ["gold", "gold"],
      ["crimson", "gold"],
      ["crimson", "crimson"],
    ] as const) {
      const res = await appRequest(gated(buildDb(tier), OWNER, "member", min), path);
      expect(res.status, `${tier} on a ${min} route`).toBe(200);
      expect(await jsonBody(res)).toEqual({ ok: true });
    }
  });

  it("reads a tier it does not recognise as Ivory", async () => {
    const db = buildDb("crimson");
    db.$client.exec(`UPDATE weddings SET tier = 'platinum' WHERE id = '${WEDDING_ID}'`);
    const res = await appRequest(gated(db, OWNER, "member", "gold"), path);
    expect(res.status).toBe(402);
  });

  it("counts each refusal by the tier the route needs, and nothing it admits", async () => {
    const name = CIRE_METRICS.tierGatePaymentRequired;
    const gold = await counterValue(name, { required_tier: "gold" });
    const crimson = await counterValue(name, { required_tier: "crimson" });

    await appRequest(gated(buildDb("ivory"), OWNER, "member", "gold"), path);
    await appRequest(gated(buildDb("gold"), OWNER, "member", "gold"), path);
    await appRequest(gated(buildDb("gold"), OWNER, "member", "crimson"), path);

    expect(await counterValue(name, { required_tier: "gold" })).toBe(gold + 1);
    expect(await counterValue(name, { required_tier: "crimson" })).toBe(crimson + 1);
  });
});

describe("weddingTier behind a role gate costs no query of its own", () => {
  // Owner: one select (the wedding row). Co-host: two (the wedding row, then
  // the seat). The same with the tier gate mounted as without it.
  const cases: { gate: RoleGate; caller: string; selects: number }[] = [
    { gate: "member", caller: OWNER, selects: 1 },
    { gate: "member", caller: EDITOR, selects: 2 },
    { gate: "editor", caller: OWNER, selects: 1 },
    { gate: "editor", caller: EDITOR, selects: 2 },
    { gate: "owner", caller: OWNER, selects: 1 },
    { gate: "runSheet", caller: OWNER, selects: 1 },
    { gate: "runSheet", caller: HELPER, selects: 2 },
  ];

  for (const { gate, caller, selects } of cases) {
    it(`${gate} gate, ${caller}: ${selects} select(s) admitted or refused`, async () => {
      const unGated = countingDb(buildDb("gold"));
      expect((await appRequest(ungated(unGated.db, caller, gate), path)).status).toBe(200);
      expect(unGated.selectCount()).toBe(selects);

      const admitted = countingDb(buildDb("gold"));
      expect((await appRequest(gated(admitted.db, caller, gate, "gold"), path)).status).toBe(200);
      expect(admitted.selectCount()).toBe(selects);

      const refused = countingDb(buildDb("ivory"));
      const res = await appRequest(gated(refused.db, caller, gate, "gold"), path);
      expect(res.status).toBe(402);
      expect(await jsonBody(res)).toEqual(paymentRequired("gold"));
      expect(refused.selectCount()).toBe(selects);
    });
  }

  it("reads the tier itself when mounted with no role gate, at one select", async () => {
    const { db, selectCount } = countingDb(buildDb("gold"));
    const res = await appRequest(standalone(db, "gold"), path);
    expect(res.status).toBe(200);
    expect(selectCount()).toBe(1);
  });

  it("fails closed with 402 when its own read throws", async () => {
    const throwing = new Proxy({} as Db, {
      get() {
        return () => {
          throw new Error("simulated D1 transient failure");
        };
      },
    });
    const res = await appRequest(standalone(throwing, "gold"), path);
    expect(res.status).toBe(402);
    expect(await jsonBody(res)).toEqual(paymentRequired("gold"));
  });
});

describe("the role gate's refusal wins over the tier gate's", () => {
  it("refuses a co-host on an owner route with 403, on an Ivory wedding, reading nothing more", async () => {
    const { db, selectCount } = countingDb(buildDb("ivory"));
    const res = await appRequest(gated(db, EDITOR, "owner", "gold"), path, post);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "forbidden" });
    expect(selectCount()).toBe(1);
  });

  it("refuses a stranger with 403, never 402, so nobody learns which weddings paid", async () => {
    const res = await appRequest(gated(buildDb("ivory"), "usr_stranger", "member", "gold"), path);
    expect(res.status).toBe(403);
  });

  it("answers 404 for an unknown wedding", async () => {
    const res = await appRequest(
      gated(buildDb("ivory"), OWNER, "member", "gold"),
      "/w/wed_missing/thing",
    );
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "wedding_not_found" });
  });

  it("refuses a helper outside the run sheet with 403 before the tier is read", async () => {
    const res = await appRequest(gated(buildDb("ivory"), HELPER, "member", "gold"), path);
    expect(res.status).toBe(403);
  });
});

describe("the tier is the wedding's own", () => {
  it("is not lifted by another wedding on Crimson", async () => {
    const db = buildDb("ivory");
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_paid",
        slug: "paid-wedding",
        displayName: "Paid Wedding",
        ownerOsnProfileId: OWNER,
        tier: "crimson",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const gate of ["member", "editor", "owner", "runSheet"] as const) {
      const res = await appRequest(gated(db, OWNER, gate, "gold"), path);
      expect(res.status, gate).toBe(402);
    }
  });
});
