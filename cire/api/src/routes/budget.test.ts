import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingHosts, weddings } from "@cire/db";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { appRequest } from "../test-helpers";
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

function buildApp() {
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
  return createApp(db, { osnTestKey: auth.key });
}
type App = ReturnType<typeof buildApp>;

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
