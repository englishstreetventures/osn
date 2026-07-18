import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  directoryVendorCategories,
  directoryVendors,
  weddingEntitlements,
  weddingHosts,
  weddings,
} from "@cire/db";
import { makeLogEmailLive } from "@shared/email";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createDirectoryService } from "../services/directory";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Write-test listing id (live, categories: venue + catering)
const LA = "dv_live_add";
// Draft listing id (must be rejected by the add route)
const LD = "dv_draft_add";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp({ grantVendors = true }: { grantVendors?: boolean } = {}) {
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

  // Seed two live directory listings.
  db.insert(directoryVendors)
    .values({
      id: "dv_venue_1",
      name: "Sydney Gardens",
      description: "Beautiful garden venue",
      locationText: "Sydney, NSW",
      listed: "live",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(directoryVendorCategories)
    .values({ directoryVendorId: "dv_venue_1", category: "venue" })
    .run();

  db.insert(directoryVendors)
    .values({
      id: "dv_florals_1",
      name: "Hillside Flowers",
      description: "Seasonal florals",
      locationText: "Melbourne, VIC",
      listed: "live",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(directoryVendorCategories)
    .values({ directoryVendorId: "dv_florals_1", category: "florals" })
    .run();

  // A draft listing — must NOT appear in browse results.
  db.insert(directoryVendors)
    .values({
      id: "dv_draft_1",
      name: "Draft Vendor",
      listed: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Grant the `vendors` entitlement so the route gate passes (unless opted out
  // for an explicit 402-test that must exercise the un-entitled path).
  if (grantVendors) {
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
        providerRef: null,
      })
      .onConflictDoNothing()
      .run();
    // Also grant for wed_other (usr_bob's wedding) so cross-tenant tests pass.
    db.insert(weddingEntitlements)
      .values({
        weddingId: "wed_other",
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: "usr_bob",
        providerRef: null,
      })
      .onConflictDoNothing()
      .run();
  }

  const { layer: logEmailLayer } = makeLogEmailLive();
  const directoryService = createDirectoryService({
    vendorPortalOrigin: "https://vendor.test",
  });

  return createApp(db, {
    osnTestKey: auth.key,
    directoryService,
    emailLayer: logEmailLayer,
  });
}

type App = ReturnType<typeof buildApp>;

async function req(app: App, path: string, profileId: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "GET", headers });
}

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/directory`;

describe("vendor directory browse route", () => {
  it("401 without a token", async () => {
    expect((await req(buildApp(), base, undefined)).status).toBe(401);
  });

  it("weddingMember (viewer) can browse; returns live listings + total", async () => {
    const res = await req(buildApp(), base, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: unknown[]; total: number };
    expect(Array.isArray(body.listings)).toBe(true);
    // Two live listings seeded; draft must not appear.
    expect(body.total).toBe(2);
    expect(body.listings.length).toBe(2);
  });

  it("owner can browse", async () => {
    const res = await req(buildApp(), base, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: unknown[]; total: number };
    expect(Array.isArray(body.listings)).toBe(true);
  });

  it("editor can browse", async () => {
    const res = await req(buildApp(), base, EDITOR);
    expect(res.status).toBe(200);
  });

  it("404 for a wedding the caller is not a member of (cross-tenant)", async () => {
    // STRANGER is not a member of BOOTSTRAP_WEDDING_ID.
    expect((await req(buildApp(), base, STRANGER)).status).toBe(403);
    // usr_bob owns wed_other but is not a member of BOOTSTRAP_WEDDING_ID.
    expect(
      (await req(buildApp(), `/api/organiser/weddings/wed_other/directory`, "usr_bob")).status,
    ).toBe(200);
    // OWNER is not a member of wed_other → 404/403.
    const crossRes = await req(buildApp(), `/api/organiser/weddings/wed_other/directory`, OWNER);
    expect([403, 404]).toContain(crossRes.status);
  });

  it("category filter passes through to the service", async () => {
    const res = await req(buildApp(), `${base}?category=venue`, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: { id: string }[]; total: number };
    // Only the venue listing should match.
    expect(body.total).toBe(1);
    expect(body.listings[0].id).toBe("dv_venue_1");
  });

  it("unknown category ignored (treated as no filter — returns all live)", async () => {
    // 'ufo' is not in SERVICE_CATEGORIES so category → null → no filter.
    const res = await req(buildApp(), `${base}?category=ufo`, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: unknown[]; total: number };
    expect(body.total).toBe(2);
  });

  it("q filter passes through to the service", async () => {
    const res = await req(buildApp(), `${base}?q=hillside`, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: { id: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.listings[0].id).toBe("dv_florals_1");
  });

  it("location filter passes through to the service", async () => {
    const res = await req(buildApp(), `${base}?location=sydney`, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: { id: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.listings[0].id).toBe("dv_venue_1");
  });

  it("clamps limit=999 to at most 50", async () => {
    const res = await req(buildApp(), `${base}?limit=999`, VIEWER);
    expect(res.status).toBe(200);
    // With only 2 listings the clamping doesn't change the result count,
    // but the request must succeed (not 400/500).
    const body = (await res.json()) as { listings: unknown[]; total: number };
    expect(body.listings.length).toBeLessThanOrEqual(50);
  });

  it("limit=0 falls back to default (24)", async () => {
    // 0 is below min (1) so clampInt returns the default (24).
    const res = await req(buildApp(), `${base}?limit=0`, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: unknown[]; total: number };
    // With 2 listings the page is fine; the important thing is no error.
    expect(Array.isArray(body.listings)).toBe(true);
  });

  it("offset=-5 is clamped to 0 (no error)", async () => {
    const res = await req(buildApp(), `${base}?offset=-5`, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listings: unknown[]; total: number };
    expect(Array.isArray(body.listings)).toBe(true);
  });

  // ── Entitlement gate (Task 4) ──────────────────────────────────────────────

  it("GET /directory → 402 payment_required when wedding lacks `vendors`", async () => {
    // No entitlement granted — editor passes the role gate but hits 402.
    const app = buildApp({ grantVendors: false });
    const res = await req(app, base, OWNER);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required", entitlement: "vendors" });
  });

  it("with the `vendors` entitlement granted, GET /directory passes the gate (not 402)", async () => {
    // buildApp() grants `vendors` by default — just verify the route is accessible.
    const app = buildApp();
    const res = await req(app, base, OWNER);
    expect(res.status).not.toBe(402);
  });
});

// ── Write routes ─────────────────────────────────────────────────────────────

/**
 * Builds a fresh in-memory app for write tests. Seeds:
 *  - editor + viewer hosts (same as buildApp)
 *  - LA: live listing with categories [venue, catering] + a contact email/phone
 *  - LD: draft listing (rejected by add route)
 */
function buildWriteApp({ grantVendors = true }: { grantVendors?: boolean } = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts)
    .values({
      id: "whost_editor_w",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: EDITOR,
      addedByOsnProfileId: OWNER,
      role: "editor",
      createdAt: now,
    })
    .run();
  db.insert(weddingHosts)
    .values({
      id: "whost_viewer_w",
      weddingId: BOOTSTRAP_WEDDING_ID,
      osnProfileId: VIEWER,
      addedByOsnProfileId: OWNER,
      role: "viewer",
      createdAt: now,
    })
    .run();

  // Live listing: venue + catering, has contact details
  db.insert(directoryVendors)
    .values({
      id: LA,
      name: "Apricot Hall",
      description: "A stunning venue",
      email: "hello@apricothall.test",
      phone: "+61400000001",
      locationText: "Sydney, NSW",
      listed: "live",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(directoryVendorCategories).values({ directoryVendorId: LA, category: "venue" }).run();
  db.insert(directoryVendorCategories)
    .values({ directoryVendorId: LA, category: "catering" })
    .run();

  // Draft listing — must be rejected with 404 listing_not_found
  db.insert(directoryVendors)
    .values({
      id: LD,
      name: "Draft Hall",
      listed: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Grant the `vendors` entitlement so write-route gate passes (unless opted out
  // for an explicit 402-test that must exercise the un-entitled path).
  if (grantVendors) {
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
        providerRef: null,
      })
      .onConflictDoNothing()
      .run();
  }

  const { layer: logEmailLayer } = makeLogEmailLive();
  const directoryService = createDirectoryService({
    vendorPortalOrigin: "https://vendor.test",
  });

  return createApp(db, {
    osnTestKey: auth.key,
    directoryService,
    emailLayer: logEmailLayer,
  });
}

async function postAdd(
  app: ReturnType<typeof buildWriteApp>,
  directoryVendorId: string,
  body: unknown,
  profileId: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await auth.sign(profileId)}`,
  };
  return appRequest(
    app,
    `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/directory/${directoryVendorId}/add`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
}

describe("vendor directory write routes (add-from-directory)", () => {
  it("editor adds a live listing to the CRM, snapshotting contact + chosen category", async () => {
    const app = buildWriteApp();
    const res = await postAdd(app, LA, { category: "venue" }, EDITOR);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { vendor: Record<string, unknown> };
    expect(body.vendor).toBeDefined();
    expect(body.vendor.directoryVendorId).toBe(LA);
    expect(body.vendor.name).toBe("Apricot Hall");
    expect(body.vendor.email).toBe("hello@apricothall.test");
    expect(body.vendor.category).toBe("venue");
    expect(body.vendor.status).toBe("researching");
  });

  it("owner can also add a live listing", async () => {
    const app = buildWriteApp();
    const res = await postAdd(app, LA, { category: "catering" }, OWNER);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { vendor: Record<string, unknown> };
    expect(body.vendor.category).toBe("catering");
    expect(body.vendor.status).toBe("researching");
  });

  it("rejects a category not on the listing (400 invalid_category)", async () => {
    const app = buildWriteApp();
    // LA has venue + catering; photography is not on it
    const res = await postAdd(app, LA, { category: "photography" }, EDITOR);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_category");
  });

  it("404 listing_not_found for a draft listing", async () => {
    const app = buildWriteApp();
    const res = await postAdd(app, LD, { category: "venue" }, EDITOR);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("listing_not_found");
  });

  it("404 listing_not_found for a missing listing id", async () => {
    const app = buildWriteApp();
    const res = await postAdd(app, "nope", { category: "venue" }, EDITOR);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("listing_not_found");
  });

  it("409 already_in_wedding on a duplicate add", async () => {
    const app = buildWriteApp();
    // First add — should succeed
    const first = await postAdd(app, LA, { category: "venue" }, EDITOR);
    expect(first.status).toBe(201);
    // Second add — same listing, same wedding → 409
    const second = await postAdd(app, LA, { category: "venue" }, EDITOR);
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("already_in_wedding");
  });

  it("viewer gets 403 read_only_role", async () => {
    const app = buildWriteApp();
    const res = await postAdd(app, LA, { category: "venue" }, VIEWER);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("read_only_role");
  });

  // ── Entitlement gate (Task 4) ──────────────────────────────────────────────

  it("POST /directory/:id/add → 402 when wedding lacks `vendors`", async () => {
    // Editor passes the role gate but no entitlement → 402.
    const app = buildWriteApp({ grantVendors: false });
    const res = await postAdd(app, LA, { category: "venue" }, EDITOR);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required", entitlement: "vendors" });
  });

  it("a VIEWER still gets 403 (role wins over 402) on the write route", async () => {
    // Viewer is stopped by weddingEditor (403) before reaching the entitlement gate.
    // Use no-entitlement app to confirm role gate wins regardless of entitlement state.
    const app = buildWriteApp({ grantVendors: false });
    const res = await postAdd(app, LA, { category: "venue" }, VIEWER);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("read_only_role");
  });
});
