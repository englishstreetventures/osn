import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryContributions,
  weddingHosts,
  weddings,
  weddingUpgradePurchases,
} from "@cire/db";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { AppOptions } from "../../src/app";
import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { RESTORE_WINDOW_S } from "../../src/db/live-wedding";
import { createDb, DEV_OWNER_PROFILE_ID, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { formatRestoreUntil } from "../../src/lib/owner-notice-email";
import { CIRE_METRICS } from "../../src/metrics";
import { CLAIM_TTL_MS } from "../../src/services/changes";
import { maintenanceSweeps } from "../../src/services/maintenance-sweeps";
import { weddingLifecycleService } from "../../src/services/wedding-lifecycle";
import { appRequest, jsonBody } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

/**
 * An owner deletes a wedding (soft), any owner restores it inside the window.
 *
 * On bun:sqlite each batch runs its statements one at a time, outside a
 * transaction, so what these tests show is what each guarded statement's
 * predicate refuses — not atomicity between two racing requests. That is the
 * Miniflare D1 tier's job (`tests/db/d1-integration.test.ts`).
 */

const CREATOR = DEV_OWNER_PROFILE_ID;
const SECOND = "usr_second_owner";
const SLUG = "cire-wedding";
const CODE = "TESTONE-IVY-AA11";
const DAY_MS = 24 * 60 * 60 * 1000;

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp(lifecycleLimit = 1000, overrides: Partial<AppOptions> = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  for (const [osnProfileId, role] of [
    [SECOND, "owner"],
    ["usr_editor", "editor"],
    ["usr_viewer", "viewer"],
    ["usr_helper", "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id: `whost_${osnProfileId}`,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: CREATOR,
        role,
        createdAt: now,
      })
      .run();
  }
  const app = createApp(db, {
    osnTestKey: auth.key,
    weddingLifecycleLimiter: createRateLimiter({ maxRequests: lifecycleLimit, windowMs: 60_000 }),
    claimLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    claimSessionLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    ...overrides,
  });
  return { app, db };
}

type App = ReturnType<typeof buildApp>["app"];

async function organiser(
  app: App,
  method: string,
  path: string,
  profileId: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return appRequest(app, path, init);
}

const del = (app: App, profileId: string | null, body: unknown = { confirmSlug: SLUG }) =>
  organiser(app, "DELETE", `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}`, profileId, body);

const restore = (app: App, profileId: string | null) =>
  organiser(app, "POST", `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/restore`, profileId);

const weddingRow = (db: TestDb) =>
  db
    .select({ deletedAt: weddings.deletedAt, deletedBy: weddings.deletedByOsnProfileId })
    .from(weddings)
    .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
    .get();

/** Move the wedding's deletion back in time, as the days passing would. */
function backdateDeletion(db: TestDb, days: number) {
  db.update(weddings)
    .set({ deletedAt: new Date(Date.now() - days * DAY_MS) })
    .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
    .run();
}

async function claimCookie(app: App): Promise<Response> {
  return appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicId: CODE }),
  });
}

/** A request carrying the organiser session cookie, as the portal sends it. */
function withCookie(
  app: App,
  method: string,
  path: string,
  token: string,
  extra: { body?: unknown; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { cookie: `cire_org_session=${token}` };
  if (extra.origin) headers.Origin = extra.origin;
  const init: RequestInit = { method, headers };
  if (extra.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(extra.body);
  }
  return appRequest(app, path, init);
}

const WEDDING_PATH = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}`;

/** Make every UPDATE of `weddings` fail, as a driver error would, after the
 *  gate (a read) has already passed. */
function failWeddingWrites(db: TestDb) {
  db.$client.exec(
    "CREATE TRIGGER fail_wedding_update BEFORE UPDATE ON weddings BEGIN SELECT RAISE(ABORT, 'boom'); END;",
  );
}

function purchase(db: TestDb, fields: Partial<typeof weddingUpgradePurchases.$inferInsert>) {
  const now = new Date();
  db.insert(weddingUpgradePurchases)
    .values({
      id: `upg_${crypto.randomUUID()}`,
      weddingId: BOOTSTRAP_WEDDING_ID,
      entitlement: "vendors",
      status: "pending",
      createdByOsnProfileId: CREATOR,
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
    .run();
}

function gift(db: TestDb, fields: Partial<typeof registryContributions.$inferInsert>) {
  const [family] = db.select({ id: families.id }).from(families).limit(1).all();
  const now = new Date();
  db.insert(registryContributions)
    .values({
      id: `rcon_${crypto.randomUUID()}`,
      weddingId: BOOTSTRAP_WEDDING_ID,
      familyId: family!.id,
      status: "pending",
      amountMinor: 5_000,
      currency: "AUD",
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
    .run();
}

describe("DELETE /api/organiser/weddings/:weddingId", () => {
  it.each([
    ["the creator", CREATOR],
    ["an invited second owner", SECOND],
  ])("lets %s soft-delete the wedding with its slug", async (_name, profileId) => {
    const { app, db } = buildApp();
    const before = await counterValue(CIRE_METRICS.weddingDeleted, { result: "ok" });
    const res = await del(app, profileId);
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as {
      deleted: boolean;
      weddingId: string;
      restoreUntil: string;
    };
    expect(body.deleted).toBe(true);
    expect(body.weddingId).toBe(BOOTSTRAP_WEDDING_ID);
    const row = weddingRow(db)!;
    expect(row.deletedBy).toBe(profileId);
    expect(row.deletedAt).not.toBeNull();
    expect(new Date(body.restoreUntil).getTime()).toBe(row.deletedAt!.getTime() + 7 * DAY_MS);
    expect(await counterValue(CIRE_METRICS.weddingDeleted, { result: "ok" })).toBe(before + 1);
  });

  it.each([["usr_editor"], ["usr_viewer"], ["usr_helper"], ["usr_stranger"]])(
    "refuses %s with 403 and changes nothing",
    async (profileId) => {
      const { app, db } = buildApp();
      const res = await del(app, profileId);
      expect(res.status).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "forbidden" });
      expect(weddingRow(db)!.deletedAt).toBeNull();
    },
  );

  it("needs a signed-in organiser", async () => {
    const { app } = buildApp();
    expect((await del(app, null)).status).toBe(401);
  });

  it("answers an unknown wedding, and an already-deleted one, as not found", async () => {
    const { app } = buildApp();
    const unknown = await organiser(app, "DELETE", "/api/organiser/weddings/wed_nope", CREATOR, {
      confirmSlug: SLUG,
    });
    expect(unknown.status).toBe(404);
    expect((await del(app, CREATOR)).status).toBe(200);
    const again = await del(app, SECOND);
    expect(again.status).toBe(404);
    expect(await jsonBody(again)).toEqual({ error: "wedding_not_found" });
  });

  it("needs a body", async () => {
    const { app, db } = buildApp();
    const res = await organiser(
      app,
      "DELETE",
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}`,
      CREATOR,
    );
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
    expect(weddingRow(db)!.deletedAt).toBeNull();
  });

  it.each([["the-wrong-wedding"], [SLUG.toUpperCase()], [` ${SLUG} `]])(
    "refuses the confirmation %p, which is not exactly the slug",
    async (confirmSlug) => {
      const { app, db } = buildApp();
      const res = await del(app, CREATOR, { confirmSlug });
      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "confirmation_mismatch" });
      expect(weddingRow(db)!.deletedAt).toBeNull();
    },
  );

  describe("waits for money that can still move", () => {
    it("refuses while an upgrade checkout under a day old can be paid", async () => {
      const { app, db } = buildApp();
      purchase(db, { checkoutSessionId: "cs_live", createdAt: new Date(Date.now() - 3_600_000) });
      const res = await del(app, CREATOR);
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "purchase_in_flight" });
      expect(weddingRow(db)!.deletedAt).toBeNull();
    });

    it("does not wait on a checkout Stripe has already closed", async () => {
      const { app, db } = buildApp();
      purchase(db, { checkoutSessionId: "cs_old", createdAt: new Date(Date.now() - 2 * DAY_MS) });
      expect((await del(app, CREATOR)).status).toBe(200);
    });

    it("refuses while another request is still opening a checkout, and not after", async () => {
      const fresh = buildApp();
      purchase(fresh.db, { checkoutSessionId: null, createdAt: new Date(Date.now() - 5_000) });
      expect((await del(fresh.app, CREATOR)).status).toBe(409);

      const stale = buildApp();
      purchase(stale.db, { checkoutSessionId: null, createdAt: new Date(Date.now() - 120_000) });
      expect((await del(stale.app, CREATOR)).status).toBe(200);
    });

    it("refuses while a gift's checkout page under a day old can be paid, and not after", async () => {
      const open = buildApp();
      gift(open.db, {
        stripeCheckoutSessionId: "cs_gift_open",
        createdAt: new Date(Date.now() - 3_600_000),
      });
      const res = await del(open.app, CREATOR);
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "gift_in_flight" });
      expect(weddingRow(open.db)!.deletedAt).toBeNull();

      // Stripe closed the page a day after it opened, unpaid.
      const closed = buildApp();
      gift(closed.db, {
        stripeCheckoutSessionId: "cs_gift_closed",
        createdAt: new Date(Date.now() - 2 * DAY_MS),
      });
      expect((await del(closed.app, CREATOR)).status).toBe(200);
    });

    it("refuses while a completed gift's delayed debit may still settle, and not after a week", async () => {
      const settling = buildApp();
      gift(settling.db, {
        stripeCheckoutSessionId: "cs_gift_debit",
        stripePaymentIntentId: "pi_gift_debit",
        createdAt: new Date(Date.now() - 3 * DAY_MS),
      });
      const res = await del(settling.app, CREATOR);
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "gift_in_flight" });

      const stale = buildApp();
      gift(stale.db, {
        stripeCheckoutSessionId: "cs_gift_stale",
        stripePaymentIntentId: "pi_gift_stale",
        createdAt: new Date(Date.now() - 8 * DAY_MS),
      });
      expect((await del(stale.app, CREATOR)).status).toBe(200);
    });

    it("never waits on a pending gift that got no checkout session, however new", async () => {
      // Any guest can write one by starting a gift; it must not hold the
      // owners' delete. The purge still waits on it.
      const { app, db } = buildApp();
      gift(db, { stripeCheckoutSessionId: null, createdAt: new Date(Date.now() - 5_000) });
      expect((await del(app, CREATOR)).status).toBe(200);
      expect(weddingRow(db)!.deletedAt).not.toBeNull();
    });
  });

  it("refuses while a change is mid-apply, and not once its claim has expired", async () => {
    const live = buildApp();
    live.db
      .update(weddings)
      .set({ changeClaim: "tok", changeClaimedAt: Date.now() - 1_000 })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    const res = await del(live.app, CREATOR);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "change_in_progress" });

    const dead = buildApp();
    dead.db
      .update(weddings)
      .set({ changeClaim: "tok", changeClaimedAt: Date.now() - CLAIM_TTL_MS - 1_000 })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    expect((await del(dead.app, CREATOR)).status).toBe(200);
  });

  it("writes nothing for a caller who is no longer an owner when the statement runs", async () => {
    // The gate read can be stale by the time the write lands; the write's own
    // owner-seat predicate is what refuses a demoted caller.
    const { db } = buildApp();
    const exit = await Effect.runPromiseExit(
      weddingLifecycleService
        .softDelete({
          weddingId: BOOTSTRAP_WEDDING_ID,
          osnProfileId: "usr_editor",
          confirmSlug: SLUG,
        })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain('"reason":"forbidden"');
    expect(weddingRow(db)!.deletedAt).toBeNull();
  });

  it("is rate limited per user", async () => {
    const { app } = buildApp(1);
    expect((await del(app, CREATOR, { confirmSlug: "nope" })).status).toBe(400);
    expect((await del(app, CREATOR)).status).toBe(429);
  });

  it("deletes on the portal's session cookie, and refuses a dead one", async () => {
    const { app, db } = buildApp();
    const dead = await withCookie(app, "DELETE", WEDDING_PATH, "not-a-live-session-token", {
      body: { confirmSlug: SLUG },
    });
    expect(dead.status).toBe(401);
    expect(weddingRow(db)!.deletedAt).toBeNull();

    const token = await seedOrganiserSession(db, CREATOR);
    const res = await withCookie(app, "DELETE", WEDDING_PATH, token, {
      body: { confirmSlug: SLUG },
    });
    expect(res.status).toBe(200);
    expect(weddingRow(db)!.deletedAt).not.toBeNull();
  });

  it("refuses a cross-origin delete that carries a live session cookie", async () => {
    const { app, db } = buildApp();
    const token = await seedOrganiserSession(db, CREATOR);
    const res = await withCookie(app, "DELETE", WEDDING_PATH, token, {
      body: { confirmSlug: SLUG },
      origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    expect(weddingRow(db)!.deletedAt).toBeNull();
  });

  it("answers a failed write with 500 and counts it as an error", async () => {
    const { app, db } = buildApp();
    failWeddingWrites(db);
    const before = await counterValue(CIRE_METRICS.weddingDeleted, { result: "error" });
    const res = await del(app, CREATOR);
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "Could not delete wedding" });
    expect(await counterValue(CIRE_METRICS.weddingDeleted, { result: "error" })).toBe(before + 1);
    expect(weddingRow(db)!.deletedAt).toBeNull();
  });

  it.each([
    ["an empty confirmation", "", "Missing or invalid fields"],
    ["200 characters, within the bound but not the slug", "x".repeat(200), "confirmation_mismatch"],
    ["201 characters, over the bound", "x".repeat(201), "Missing or invalid fields"],
  ])("answers %s with 400", async (_name, confirmSlug, error) => {
    const { app, db } = buildApp();
    const res = await del(app, CREATOR, { confirmSlug });
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error });
    expect(weddingRow(db)!.deletedAt).toBeNull();
  });
});

describe("POST /api/organiser/weddings/:weddingId/restore", () => {
  it("lets any owner restore, and every guest path works again with the same cookie and code", async () => {
    const { app, db } = buildApp();
    const claimed = await claimCookie(app);
    expect(claimed.status).toBe(200);
    const cookie = `cire_session=${parseSessionToken(claimed.headers.get("Set-Cookie"))}`;

    expect((await del(app, CREATOR)).status).toBe(200);
    // Gone for guests: the slug, the code and the session.
    expect((await appRequest(app, `/api/invite/${SLUG}`)).status).toBe(404);
    expect((await claimCookie(app)).status).toBe(401);
    const refused = await appRequest(app, `/api/claim/session?slug=${SLUG}`, {
      headers: { Cookie: cookie },
    });
    expect(refused.status).toBe(401);
    // Refused, not revoked: no cookie is cleared.
    expect(refused.headers.get("Set-Cookie")).toBeNull();

    const res = await restore(app, SECOND);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ restored: true, weddingId: BOOTSTRAP_WEDDING_ID });
    expect(weddingRow(db)).toEqual({ deletedAt: null, deletedBy: null });

    expect((await appRequest(app, `/api/invite/${SLUG}`)).status).toBe(200);
    expect((await claimCookie(app)).status).toBe(200);
    const back = await appRequest(app, `/api/claim/session?slug=${SLUG}`, {
      headers: { Cookie: cookie },
    });
    expect(back.status).toBe(200);
  });

  it("refuses a live wedding", async () => {
    const { app } = buildApp();
    const res = await restore(app, CREATOR);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "not_deleted" });
  });

  it("refuses once the restore window has closed", async () => {
    const { app, db } = buildApp();
    expect((await del(app, CREATOR)).status).toBe(200);
    backdateDeletion(db, 8);
    const res = await restore(app, CREATOR);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "restore_window_passed" });
  });

  it("refuses a co-host, and a stranger", async () => {
    const { app } = buildApp();
    expect((await del(app, CREATOR)).status).toBe(200);
    for (const profileId of ["usr_editor", "usr_stranger"]) {
      const res = await restore(app, profileId);
      expect(res.status).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "forbidden" });
    }
  });

  it("restores on the portal's session cookie, and refuses a dead one or none", async () => {
    const { app, db } = buildApp();
    expect((await del(app, CREATOR)).status).toBe(200);
    const restorePath = `${WEDDING_PATH}/restore`;

    expect((await restore(app, null)).status).toBe(401);
    const dead = await withCookie(app, "POST", restorePath, "not-a-live-session-token");
    expect(dead.status).toBe(401);
    expect(weddingRow(db)!.deletedAt).not.toBeNull();

    const token = await seedOrganiserSession(db, SECOND);
    const res = await withCookie(app, "POST", restorePath, token);
    expect(res.status).toBe(200);
    expect(weddingRow(db)!.deletedAt).toBeNull();
  });

  it("counts each outcome by its label", async () => {
    const name = CIRE_METRICS.weddingRestored;
    const read = async () => ({
      ok: await counterValue(name, { result: "ok" }),
      notDeleted: await counterValue(name, { result: "not_deleted" }),
      windowPassed: await counterValue(name, { result: "restore_window_passed" }),
      forbidden: await counterValue(name, { result: "forbidden" }),
    });
    const before = await read();

    const live = buildApp();
    expect((await restore(live.app, CREATOR)).status).toBe(409);

    const late = buildApp();
    expect((await del(late.app, CREATOR)).status).toBe(200);
    backdateDeletion(late.db, 8);
    expect((await restore(late.app, CREATOR)).status).toBe(409);

    // The gate refuses a co-host before the service runs, so the service's
    // `forbidden` label is the write's own refusal: a caller the gate admitted
    // who holds no owner seat by the time the statement runs.
    const demoted = buildApp();
    expect((await del(demoted.app, CREATOR)).status).toBe(200);
    demoted.db
      .update(weddingHosts)
      .set({ role: "editor" })
      .where(eq(weddingHosts.osnProfileId, SECOND))
      .run();
    const refused = await Effect.runPromiseExit(
      weddingLifecycleService
        .restore({ weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId: SECOND })
        .pipe(Effect.provideService(DbService, demoted.db)),
    );
    expect(JSON.stringify(refused)).toContain('"reason":"forbidden"');

    const ok = buildApp();
    expect((await del(ok.app, CREATOR)).status).toBe(200);
    expect((await restore(ok.app, SECOND)).status).toBe(200);

    expect(await read()).toEqual({
      ok: before.ok + 1,
      notDeleted: before.notDeleted + 1,
      windowPassed: before.windowPassed + 1,
      forbidden: before.forbidden + 1,
    });
  });

  it("answers a failed write with 500 and counts it as an error", async () => {
    const { app, db } = buildApp();
    expect((await del(app, CREATOR)).status).toBe(200);
    failWeddingWrites(db);
    const before = await counterValue(CIRE_METRICS.weddingRestored, { result: "error" });
    const res = await restore(app, CREATOR);
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "Could not restore wedding" });
    expect(await counterValue(CIRE_METRICS.weddingRestored, { result: "error" })).toBe(before + 1);
    expect(weddingRow(db)!.deletedAt).not.toBeNull();
  });

  it("answers 404 once the purge has run", async () => {
    const { app, db } = buildApp();
    expect((await del(app, CREATOR)).status).toBe(200);
    backdateDeletion(db, 8);
    const run = await Effect.runPromise(
      maintenanceSweeps.purgeDeletedWeddings().pipe(Effect.provideService(DbService, db)),
    );
    expect(run.purged).toBe(1);
    const res = await restore(app, CREATOR);
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "wedding_not_found" });
  });
});

describe("the restore window's edge", () => {
  // Restore admits `deleted_at > now - window`; the purge takes
  // `deleted_at <= now - window`. At exactly the window the wedding is the
  // purge's and not restorable; one second inside, the other way round.
  const nowS = Math.floor(Date.now() / 1000);
  const now = new Date(nowS * 1000);

  function deletedAt(db: TestDb, seconds: number) {
    db.update(weddings)
      .set({ deletedAt: new Date(seconds * 1000), deletedByOsnProfileId: CREATOR })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
  }
  const restoreAt = (db: TestDb) =>
    Effect.runPromiseExit(
      weddingLifecycleService
        .restore({ weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId: CREATOR, now })
        .pipe(Effect.provideService(DbService, db)),
    );
  const purgeAt = (db: TestDb) =>
    Effect.runPromise(
      maintenanceSweeps.purgeDeletedWeddings(now).pipe(Effect.provideService(DbService, db)),
    );

  it("at exactly the window: refused for restore, taken by the purge", async () => {
    const { db } = buildApp();
    deletedAt(db, nowS - RESTORE_WINDOW_S);
    expect(JSON.stringify(await restoreAt(db))).toContain('"reason":"restore_window_passed"');
    expect((await purgeAt(db)).purged).toBe(1);
    expect(weddingRow(db)).toBeUndefined();
  });

  it("one second inside the window: restorable, and left by the purge", async () => {
    const restorable = buildApp();
    deletedAt(restorable.db, nowS - RESTORE_WINDOW_S + 1);
    const exit = await restoreAt(restorable.db);
    expect(exit._tag).toBe("Success");
    expect(weddingRow(restorable.db)!.deletedAt).toBeNull();

    const kept = buildApp();
    deletedAt(kept.db, nowS - RESTORE_WINDOW_S + 1);
    expect((await purgeAt(kept.db)).purged).toBe(0);
    expect(weddingRow(kept.db)!.deletedAt).not.toBeNull();
  });
});

describe("the delete notice", () => {
  const ADDRESSES: Record<string, string> = {
    [CREATOR]: "creator@example.test",
    [SECOND]: "second@example.test",
    usr_editor: "editor@example.test",
  };

  function noticeApp() {
    const mail = makeLogEmailLive();
    const built = buildApp(1000, {
      emailLayer: mail.layer,
      organiserEmailLookup: async (ids) => ({
        answered: true,
        emails: new Map(ids.flatMap((id) => (ADDRESSES[id] ? [[id, ADDRESSES[id]] as const] : []))),
      }),
      resolveOsnProfileDisplays: async (ids) =>
        new Map(
          ids.includes(CREATOR)
            ? [[CREATOR, { handle: "creator", displayName: "Cee Reator" }]]
            : [],
        ),
    });
    return { ...built, mail };
  }

  it("mails every owner once, the deleter included, naming the deleter and the 7-day window", async () => {
    const { app, mail } = noticeApp();
    const res = await del(app, CREATOR);
    expect(res.status).toBe(200);
    const { restoreUntil } = (await res.json()) as { restoreUntil: string };

    const sent = mail.recorded();
    // Every owner, the deleter first; never the editor.
    expect(sent.map((m) => m.to)).toEqual(["creator@example.test", "second@example.test"]);
    expect(sent[0]?.text).toContain("You deleted");
    const notice = sent[1];
    expect(notice?.template).toBe("wedding-delete-started");
    expect(notice?.text).toContain("Cee Reator (@creator) deleted");
    expect(notice?.text).toContain(
      `restore it for 7 days: until ${formatRestoreUntil(new Date(restoreUntil))}`,
    );
  });

  it("sends nothing for a refused delete", async () => {
    const { app, mail } = noticeApp();
    const res = await del(app, CREATOR, { confirmSlug: "not-the-slug" });
    expect(res.status).toBe(400);
    expect(mail.recorded()).toEqual([]);
  });
});
