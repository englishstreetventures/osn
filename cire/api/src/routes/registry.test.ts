import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingEntitlements, weddingHosts, weddings } from "@cire/db";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import type { RegistryItemDto, RegistrySnapshot } from "../services/registry";
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

/**
 * `grantRegistry` defaults to FALSE — the opposite of the other module tests, and
 * deliberately so. Shipping locked is the headline property of this feature, so
 * the default fixture is the production one (no grant anywhere), and a test that
 * wants the feature has to say so.
 */
function buildApp({ grantRegistry = false }: { grantRegistry?: boolean } = {}) {
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

  if (grantRegistry) {
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "registry",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
        providerRef: null,
      })
      .onConflictDoNothing()
      .run();
  }

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

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/registry`;
const ITEM = { title: "Copper pan", priceMinor: 12_000, quantityWanted: 2 };

/** Create one item on an entitled app and return it. */
async function seedItem(app: App): Promise<RegistryItemDto> {
  const res = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
  expect(res.status).toBe(200);
  return ((await res.json()) as { item: RegistryItemDto }).item;
}

describe("registry ships locked", () => {
  // This block is the point of the whole PR: with no entitlement row — which is
  // every wedding in production — nothing is reachable. If any of these ever go
  // green as 200, the feature has silently launched.
  const routes: Array<[string, string, unknown?]> = [
    ["GET", base],
    ["PUT", `${base}/settings`, { published: true }],
    ["POST", `${base}/items`, ITEM],
    ["PATCH", `${base}/items/reorder`, { orderedIds: ["reg_x"] }],
    ["PATCH", `${base}/items/reg_x`, { title: "x" }],
    ["DELETE", `${base}/items/reg_x`],
    ["POST", `${base}/gifts/claim/rcl_x/thanked`, { thanked: true }],
  ];

  for (const [method, path, body] of routes) {
    it(`${method} ${path.replace(base, "…")} → 402 payment_required`, async () => {
      const res = await req(buildApp(), method, path, OWNER, body);
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: "payment_required", entitlement: "registry" });
    });
  }

  it("401 without a token, before the entitlement gate is consulted", async () => {
    expect((await req(buildApp(), "GET", base, undefined)).status).toBe(401);
  });

  it("a stranger gets 403, not 402 — the role gate runs first", async () => {
    // Ordering matters: a 402 to a non-member would leak which weddings exist
    // and which features they hold.
    expect((await req(buildApp(), "GET", base, STRANGER)).status).toBe(403);
  });
});

describe("registry routes (entitled)", () => {
  it("viewer may read, editor may write, viewer may not write", async () => {
    const app = buildApp({ grantRegistry: true });
    expect((await req(app, "GET", base, VIEWER)).status).toBe(200);

    const viewerWrite = await req(app, "POST", `${base}/items`, VIEWER, ITEM);
    expect(viewerWrite.status).toBe(403);
    expect(((await viewerWrite.json()) as { error: string }).error).toBe("read_only_role");

    expect((await req(app, "POST", `${base}/items`, EDITOR, ITEM)).status).toBe(200);
  });

  it("reads back an unpublished, empty registry", async () => {
    const res = await req(buildApp({ grantRegistry: true }), "GET", base, OWNER);
    const body = (await res.json()) as RegistrySnapshot;
    expect(body.settings.published).toBe(false);
    expect(body.items).toEqual([]);
    expect(body.gifts).toEqual([]);
    expect(body.currency).toBe("AUD");
    expect(body.contributionsPrimaryMinor).toBe(0);
  });

  it("runs the item lifecycle end to end", async () => {
    const app = buildApp({ grantRegistry: true });
    const item = await seedItem(app);
    expect(item.title).toBe("Copper pan");
    expect(item.quantityWanted).toBe(2);
    expect(item.quantityClaimed).toBe(0);

    const patched = await req(app, "PATCH", `${base}/items/${item.id}`, EDITOR, {
      title: "Copper saucepan",
      priceMinor: null,
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { item: RegistryItemDto }).item.priceMinor).toBeNull();

    expect((await req(app, "DELETE", `${base}/items/${item.id}`, EDITOR)).status).toBe(200);
    const after = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(after.items).toEqual([]);
  });

  it("404s an item id from another wedding", async () => {
    const app = buildApp({ grantRegistry: true });
    const item = await seedItem(app);
    // wed_other has no entitlement, so its own routes 402 — the tenancy check
    // that matters is that BOOTSTRAP's route refuses an id it does not own.
    const res = await req(app, "PATCH", `${base}/items/reg_not_mine`, EDITOR, { title: "x" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("registry_item_not_found");
    // The real item is untouched.
    const snap = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(snap.items[0]!.id).toBe(item.id);
  });

  it("rejects a non-https external URL", async () => {
    // `external_url` reaches an <a href> on the guest site. A javascript: or
    // data: value there is a script sink (precedent CON-S-L2), so the scheme is
    // checked at the boundary, not just the shape.
    const app = buildApp({ grantRegistry: true });
    for (const externalUrl of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://shop.example/thing",
      "not a url",
    ]) {
      const res = await req(app, "POST", `${base}/items`, EDITOR, { title: "T", externalUrl });
      expect(res.status).toBe(400);
    }
    const ok = await req(app, "POST", `${base}/items`, EDITOR, {
      title: "T",
      externalUrl: "https://shop.example/thing",
    });
    expect(ok.status).toBe(200);
  });

  it("rejects a malformed body and an out-of-range quantity", async () => {
    const app = buildApp({ grantRegistry: true });
    expect((await req(app, "POST", `${base}/items`, EDITOR, { title: "" })).status).toBe(400);
    expect(
      (await req(app, "POST", `${base}/items`, EDITOR, { title: "T", quantityWanted: 0 })).status,
    ).toBe(400);
    expect(
      (await req(app, "POST", `${base}/items`, EDITOR, { title: "T", quantityWanted: 1000 }))
        .status,
    ).toBe(400);
    // Malformed JSON degrades to the schema's 400, not a framework parse error.
    const raw = await appRequest(app, `${base}/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign(EDITOR)}`,
      },
      body: "{ not json",
    });
    expect(raw.status).toBe(400);
  });

  it("reorders items", async () => {
    const app = buildApp({ grantRegistry: true });
    const a = await seedItem(app);
    const bRes = await req(app, "POST", `${base}/items`, EDITOR, { title: "Kettle" });
    const b = ((await bRes.json()) as { item: RegistryItemDto }).item;

    expect(
      (await req(app, "PATCH", `${base}/items/reorder`, EDITOR, { orderedIds: [b.id, a.id] }))
        .status,
    ).toBe(200);
    const snap = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(snap.items.map((i) => i.id)).toEqual([b.id, a.id]);
  });

  it("saves settings but refuses to enable cash gifts without a live Stripe account", async () => {
    const app = buildApp({ grantRegistry: true });
    const saved = await req(app, "PUT", `${base}/settings`, EDITOR, {
      published: true,
      message: "No boxed gifts please",
    });
    expect(saved.status).toBe(200);

    // Offering a contribute button that cannot take money is worse than not
    // offering one — the guest believes they paid.
    const cash = await req(app, "PUT", `${base}/settings`, EDITOR, { cashGiftsEnabled: true });
    expect(cash.status).toBe(409);
    expect(((await cash.json()) as { error: string }).error).toBe("stripe_not_ready");

    const snap = (await (await req(app, "GET", base, OWNER)).json()) as RegistrySnapshot;
    expect(snap.settings.published).toBe(true);
    expect(snap.settings.cashGiftsEnabled).toBe(false);
  });

  it("400s an unknown gift kind in the path rather than guessing a table", async () => {
    const app = buildApp({ grantRegistry: true });
    const res = await req(app, "POST", `${base}/gifts/wishes/rcl_x/thanked`, EDITOR, {
      thanked: true,
    });
    expect(res.status).toBe(400);
  });

  it("404s a thank-you for a gift that is not this wedding's", async () => {
    const app = buildApp({ grantRegistry: true });
    const res = await req(app, "POST", `${base}/gifts/claim/rcl_nope/thanked`, EDITOR, {
      thanked: true,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("registry_gift_not_found");
  });
});
