import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestEvents,
  guests,
  rsvps,
  weddingHosts,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { appRequest } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function setupDb() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_editor",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_viewer",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: VIEWER,
      addedByOsnProfileId: OWNER,
      role: "viewer",
      createdAt: now,
    })
    .run();
  db.insert(weddings)
    .values({
      id: "wed_other",
      slug: "other-wedding",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

function buildApp() {
  return createApp(setupDb(), { osnTestKey: auth.key });
}
type App = ReturnType<typeof buildApp>;

/** The app plus its database, with one event on the other wedding. */
function buildAppWithDb() {
  const db = setupDb();
  db.insert(events)
    .values({
      id: "evt_other",
      weddingId: "wed_other",
      slug: "other-reception",
      name: "Reception",
      startAt: "2027-03-01T15:00:00+11:00",
      endAt: "",
      timezone: "Australia/Sydney",
    })
    .run();
  return { db, app: createApp(db, { osnTestKey: auth.key }) };
}

async function req(
  app: App,
  method: string,
  path: string,
  profileId: string | undefined,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/budget`;
const ITEM = { category: "venue", name: "Reception venue", estimateMinor: 1200000 };

describe("budget routes", () => {
  it("401 without a token", async () => {
    expect((await req(buildApp(), "GET", base, undefined)).status).toBe(401);
  });

  it("member (viewer) may read", async () => {
    expect((await req(buildApp(), "GET", base, VIEWER)).status).toBe(200);
  });

  it("viewer may NOT create an item (403 read_only_role)", async () => {
    const res = await req(buildApp(), "POST", `${base}/items`, VIEWER, ITEM);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("stranger is forbidden", async () => {
    expect((await req(buildApp(), "GET", base, STRANGER)).status).toBe(403);
  });

  it("editor creates an item, adds a payment, marks it paid, and deletes", async () => {
    const app = buildApp();
    const created = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    expect(created.status).toBe(200);
    const { item } = (await created.json()) as { item: { id: string } };

    const snap = await req(app, "GET", base, EDITOR);
    const body = (await snap.json()) as { items: unknown[]; currency: string };
    expect(body.items.length).toBe(1);
    expect(body.currency).toBe("AUD");

    const pay = await req(app, "POST", `${base}/items/${item.id}/payments`, EDITOR, {
      label: "Deposit",
      amountMinor: 250000,
      dueAt: "2026-03-01",
    });
    expect(pay.status).toBe(200);
    const { payment } = (await pay.json()) as { payment: { id: string; paidAt: number | null } };
    expect(payment.paidAt).toBeNull();

    const paid = await req(
      app,
      "PATCH",
      `${base}/items/${item.id}/payments/${payment.id}`,
      EDITOR,
      {
        paid: true,
      },
    );
    expect(paid.status).toBe(200);
    expect(
      ((await paid.json()) as { payment: { paidAt: number | null } }).payment.paidAt,
    ).not.toBeNull();

    const del = await req(app, "DELETE", `${base}/items/${item.id}`, EDITOR);
    expect(del.status).toBe(200);
  });

  it("400 on an unknown category", async () => {
    const res = await req(buildApp(), "POST", `${base}/items`, EDITOR, {
      category: "ufo",
      name: "x",
    });
    expect(res.status).toBe(400);
  });

  it("404 patching an item under the wrong wedding (tenancy)", async () => {
    const app = buildApp();
    const created = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    const { item } = (await created.json()) as { item: { id: string } };
    const otherPath = `/api/organiser/weddings/wed_other/budget/items/${item.id}`;
    const res = await req(app, "PATCH", otherPath, "usr_bob", { name: "hijack" });
    expect(res.status).toBe(404);
  });

  it("404 patching a payment under the wrong parent item or wrong wedding (tenancy)", async () => {
    const app = buildApp();

    // Create item A with a payment under it.
    const createdA = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    const { item: itemA } = (await createdA.json()) as { item: { id: string } };
    const payRes = await req(app, "POST", `${base}/items/${itemA.id}/payments`, EDITOR, {
      label: "Deposit",
      amountMinor: 100000,
      dueAt: "2026-06-01",
    });
    const { payment: paymentA } = (await payRes.json()) as { payment: { id: string } };

    // Create item B (same wedding).
    const createdB = await req(app, "POST", `${base}/items`, EDITOR, {
      ...ITEM,
      name: "Catering",
    });
    const { item: itemB } = (await createdB.json()) as { item: { id: string } };

    // PATCH paymentA via item B's path — wrong parent item → 404 payment_not_found.
    const wrongItem = await req(
      app,
      "PATCH",
      `${base}/items/${itemB.id}/payments/${paymentA.id}`,
      EDITOR,
      { paid: true },
    );
    expect(wrongItem.status).toBe(404);
    expect(((await wrongItem.json()) as { error: string }).error).toBe("payment_not_found");

    // PATCH paymentA via wed_other's budget path — wrong wedding → 404 budget_item_not_found.
    const otherPath = `/api/organiser/weddings/wed_other/budget/items/${itemA.id}/payments/${paymentA.id}`;
    const wrongWedding = await req(app, "PATCH", otherPath, "usr_bob", { paid: true });
    expect(wrongWedding.status).toBe(404);
  });

  it("owner may set the cap; editor may not (403)", async () => {
    const app = buildApp();
    const editorTry = await req(app, "PUT", `${base}/total`, EDITOR, { budgetTotalMinor: 4500000 });
    expect(editorTry.status).toBe(403);

    const ownerSet = await req(app, "PUT", `${base}/total`, OWNER, { budgetTotalMinor: 4500000 });
    expect(ownerSet.status).toBe(200);

    const snap = await req(app, "GET", base, OWNER);
    expect(((await snap.json()) as { budgetTotalMinor: number }).budgetTotalMinor).toBe(4500000);
  });
});

describe("budget routes — per-head lines", () => {
  interface ItemBody {
    id: string;
    estimateMinor: number | null;
    unitPriceMinor: number | null;
    eventIds: string[] | null;
    headcount: { expected: number; confirmed: number } | null;
  }

  it("creates a per-head line, returns its headcount, and prices it in the snapshot", async () => {
    const { db, app } = buildAppWithDb();
    // A fresh event with a known guest list: three seeded guests invited, one
    // attending, one declined, one yet to reply → 2 expected, 1 confirmed.
    const now = new Date();
    db.insert(events)
      .values({
        id: "evt_welcome",
        weddingId: BOOTSTRAP_WEDDING_ID,
        slug: "welcome-drinks",
        name: "Welcome drinks",
        startAt: "2027-03-01T18:00:00+11:00",
        endAt: "",
        timezone: "Australia/Sydney",
      })
      .run();
    const [g1, g2, g3] = db
      .select({ id: guests.id })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();
    for (const g of [g1!, g2!, g3!]) {
      db.insert(guestEvents).values({ guestId: g.id, eventId: "evt_welcome" }).run();
    }
    for (const [g, status] of [
      [g1!, "attending"],
      [g2!, "declined"],
    ] as const) {
      db.insert(rsvps)
        .values({
          id: `rsvp_${g.id}`,
          guestId: g.id,
          eventId: "evt_welcome",
          status,
          createdAt: now,
        })
        .run();
    }

    const res = await req(app, "POST", `${base}/items`, OWNER, {
      category: "catering",
      name: "Dinner",
      perHead: { unitPriceMinor: 8_500, eventIds: ["evt_welcome"] },
    });
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as { item: ItemBody };
    expect(item.unitPriceMinor).toBe(8_500);
    expect(item.eventIds).toEqual(["evt_welcome"]);
    expect(item.headcount).toEqual({ expected: 2, confirmed: 1 });

    const snap = (await (await req(app, "GET", base, VIEWER)).json()) as {
      events: { id: string; name: string }[];
      rsvpsClosed: boolean;
      rollup: { totals: { estimateMinor: number } };
    };
    expect(snap.events).toContainEqual({ id: "evt_welcome", name: "Welcome drinks" });
    expect(snap.rsvpsClosed).toBe(false);
    expect(snap.rollup.totals.estimateMinor).toBe(17_000);
  });

  // The portal reaches these writes with the organiser session cookie, so the
  // cookie path has to hold for them, not only the bearer the tests above send.
  it("accepts a per-head write on a session cookie and refuses a dead one or none", async () => {
    const { db, app } = buildAppWithDb();
    const perHeadBody = JSON.stringify({
      category: "catering",
      name: "Dinner",
      perHead: { unitPriceMinor: 100 },
    });
    const token = await seedOrganiserSession(db, EDITOR);
    const ok = await appRequest(app, `${base}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `cire_org_session=${token}` },
      body: perHeadBody,
    });
    expect(ok.status).toBe(200);
    const { item } = (await ok.json()) as { item: ItemBody };
    expect(item.unitPriceMinor).toBe(100);

    const dead = await appRequest(app, `${base}/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: "cire_org_session=not-a-live-session-token",
      },
      body: perHeadBody,
    });
    expect(dead.status).toBe(401);

    const none = await req(app, "PATCH", `${base}/items/${item.id}`, undefined, {
      perHead: { unitPriceMinor: 5 },
    });
    expect(none.status).toBe(401);
    const stranger = await req(app, "PATCH", `${base}/items/${item.id}`, STRANGER, {
      perHead: { unitPriceMinor: 5 },
    });
    expect(stranger.status).toBe(403);
  });

  it("400 unknown_event for another wedding's event, on create and on edit", async () => {
    const { app } = buildAppWithDb();
    const created = await req(app, "POST", `${base}/items`, EDITOR, {
      category: "catering",
      name: "Dinner",
      perHead: { unitPriceMinor: 100, eventIds: ["evt_other"] },
    });
    expect(created.status).toBe(400);
    expect(((await created.json()) as { error: string }).error).toBe("unknown_event");

    const fixed = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    const { item } = (await fixed.json()) as { item: ItemBody };
    const patched = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      perHead: { unitPriceMinor: 100, eventIds: ["evt_other"] },
    });
    expect(patched.status).toBe(400);
    expect(((await patched.json()) as { error: string }).error).toBe("unknown_event");
  });

  it("400 for an empty event list, a negative price, or a per-head line with a fixed estimate", async () => {
    const app = buildApp();
    for (const perHead of [
      { unitPriceMinor: 100, eventIds: [] },
      { unitPriceMinor: -1 },
      { unitPriceMinor: 1.5 },
    ]) {
      const res = await req(app, "POST", `${base}/items`, EDITOR, {
        category: "catering",
        name: "Dinner",
        perHead,
      });
      expect(res.status).toBe(400);
    }
    const both = await req(app, "POST", `${base}/items`, EDITOR, {
      category: "catering",
      name: "Dinner",
      estimateMinor: 500,
      perHead: { unitPriceMinor: 100 },
    });
    expect(both.status).toBe(400);

    const fixed = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    const { item } = (await fixed.json()) as { item: ItemBody };
    const patched = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      estimateMinor: 500,
      perHead: { unitPriceMinor: 100 },
    });
    expect(patched.status).toBe(400);
  });

  it("turns a fixed line per head and back, carrying the last figure as its estimate", async () => {
    const app = buildApp();
    const fixed = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    const { item } = (await fixed.json()) as { item: ItemBody };

    const perHead = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      perHead: { unitPriceMinor: 100, eventIds: null },
    });
    expect(perHead.status).toBe(200);
    const on = ((await perHead.json()) as { item: ItemBody }).item;
    expect(on).toMatchObject({ unitPriceMinor: 100, eventIds: null, estimateMinor: null });

    const back = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      perHead: null,
      estimateMinor: 4_200,
    });
    expect(back.status).toBe(200);
    const off = ((await back.json()) as { item: ItemBody }).item;
    expect(off).toMatchObject({ unitPriceMinor: null, headcount: null, estimateMinor: 4_200 });
  });

  it("viewer may NOT make a line per head (403 read_only_role)", async () => {
    const app = buildApp();
    const fixed = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    const { item } = (await fixed.json()) as { item: ItemBody };
    const res = await req(app, "PATCH", `${base}/items/${item.id}`, VIEWER, {
      perHead: { unitPriceMinor: 100 },
    });
    expect(res.status).toBe(403);
  });
});
