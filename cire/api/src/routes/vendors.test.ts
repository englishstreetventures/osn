import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingEntitlements, weddingHosts, weddings } from "@cire/db";
import { makeLogEmailLive } from "@shared/email";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createDirectoryService } from "../services/directory";
import type { VendorDto } from "../services/vendors";
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
    // Also grant for wed_other so tenancy tests involving usr_bob's wedding pass.
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

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/vendors`;
const VENDOR = { name: "Hillside Flowers", category: "florals" };

describe("vendor CRM routes", () => {
  it("401 without a token", async () => {
    expect((await req(buildApp(), "GET", base, undefined)).status).toBe(401);
  });

  it("member (viewer) may read the list", async () => {
    const res = await req(buildApp(), "GET", base, VIEWER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vendors: VendorDto[] };
    expect(Array.isArray(body.vendors)).toBe(true);
  });

  it("viewer write → 403 read_only_role", async () => {
    const res = await req(buildApp(), "POST", base, VIEWER, VENDOR);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("stranger is forbidden", async () => {
    expect((await req(buildApp(), "GET", base, STRANGER)).status).toBe(403);
  });

  it("editor creates, reads back in list, updates, and deletes", async () => {
    const app = buildApp();

    const created = await req(app, "POST", base, EDITOR, VENDOR);
    expect(created.status).toBe(200);
    const { vendor } = (await created.json()) as { vendor: VendorDto };
    expect(vendor.name).toBe("Hillside Flowers");
    expect(vendor.category).toBe("florals");
    expect(vendor.status).toBe("researching");

    const list = await req(app, "GET", base, VIEWER);
    expect(list.status).toBe(200);
    const { vendors } = (await list.json()) as { vendors: VendorDto[] };
    expect(vendors.length).toBe(1);
    expect(vendors[0].id).toBe(vendor.id);

    const patched = await req(app, "PATCH", `${base}/${vendor.id}`, EDITOR, {
      status: "booked",
      notes: "Confirmed for the ceremony",
    });
    expect(patched.status).toBe(200);
    const { vendor: updated } = (await patched.json()) as { vendor: VendorDto };
    expect(updated.status).toBe("booked");
    expect(updated.notes).toBe("Confirmed for the ceremony");

    const del = await req(app, "DELETE", `${base}/${vendor.id}`, EDITOR);
    expect(del.status).toBe(200);

    const listAfter = await req(app, "GET", base, VIEWER);
    const { vendors: remaining } = (await listAfter.json()) as { vendors: VendorDto[] };
    expect(remaining.length).toBe(0);
  });

  it("400 on unknown category", async () => {
    const res = await req(buildApp(), "POST", base, EDITOR, { name: "X", category: "ufo" });
    expect(res.status).toBe(400);
  });

  it("reorder: literal /reorder registers before /:vendorId", async () => {
    const app = buildApp();
    const a = await req(app, "POST", base, EDITOR, { name: "A", category: "florals" });
    const { vendor: vA } = (await a.json()) as { vendor: VendorDto };
    const b = await req(app, "POST", base, EDITOR, { name: "B", category: "florals" });
    const { vendor: vB } = (await b.json()) as { vendor: VendorDto };

    const reorder = await req(app, "POST", `${base}/reorder`, EDITOR, {
      status: "researching",
      orderedIds: [vB.id, vA.id],
    });
    expect(reorder.status).toBe(200);
    expect(((await reorder.json()) as { ok: boolean }).ok).toBe(true);

    const list = await req(app, "GET", base, OWNER);
    const { vendors } = (await list.json()) as { vendors: VendorDto[] };
    expect(vendors[0].id).toBe(vB.id);
    expect(vendors[1].id).toBe(vA.id);
  });

  it("404 patching a vendor under the wrong wedding (tenancy)", async () => {
    const app = buildApp();
    const created = await req(app, "POST", base, EDITOR, VENDOR);
    const { vendor } = (await created.json()) as { vendor: VendorDto };

    const otherPath = `/api/organiser/weddings/wed_other/vendors/${vendor.id}`;
    const res = await req(app, "PATCH", otherPath, "usr_bob", { name: "hijack" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("vendor_not_found");
  });

  it("list-in-directory seeds a draft listing and returns claimUrl", async () => {
    const app = buildApp();
    const created = await req(app, "POST", base, EDITOR, VENDOR);
    const { vendor } = (await created.json()) as { vendor: VendorDto };

    const seedRes = await req(app, "POST", `${base}/${vendor.id}/list-in-directory`, EDITOR, {
      name: "Hillside Flowers",
      email: "contact@hillside.com",
      categories: ["florals"],
      description: null,
      phone: null,
      website: null,
      instagram: null,
      locationText: null,
    });
    expect(seedRes.status).toBe(200);
    const result = (await seedRes.json()) as {
      directoryVendorId: string;
      claimUrl: string;
    };
    expect(result.directoryVendorId).toBeDefined();
    expect(result.claimUrl).toMatch(/^https:\/\/vendor\.test\/claim\?token=/);

    // The linked CRM vendor row should have directoryVendorId set now.
    const list = await req(app, "GET", base, OWNER);
    const { vendors } = (await list.json()) as { vendors: VendorDto[] };
    const linked = vendors.find((v) => v.id === vendor.id);
    expect(linked?.directoryVendorId).toBe(result.directoryVendorId);
  });

  it("list-in-directory with unknown vendor id → 404 vendor_not_found", async () => {
    const res = await req(buildApp(), "POST", `${base}/ven_nonexistent/list-in-directory`, EDITOR, {
      name: "Ghost Vendor",
      email: "ghost@example.com",
      categories: ["florals"],
      description: null,
      phone: null,
      website: null,
      instagram: null,
      locationText: null,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("vendor_not_found");
  });

  // ── Entitlement gate (Task 4) ──────────────────────────────────────────────

  it("GET /vendors → 402 payment_required when wedding lacks `vendors`", async () => {
    const res = await req(buildApp({ grantVendors: false }), "GET", base, OWNER);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required", entitlement: "vendors" });
  });

  it("POST /vendors → 402 payment_required when wedding lacks `vendors`", async () => {
    const res = await req(buildApp({ grantVendors: false }), "POST", base, EDITOR, VENDOR);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required", entitlement: "vendors" });
  });

  it("a VIEWER still gets 403 (role wins over 402) on the write route", async () => {
    // weddingEditor fires before weddingEntitlement → viewer gets 403, not 402.
    const res = await req(buildApp({ grantVendors: false }), "POST", base, VIEWER, VENDOR);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("with the `vendors` entitlement granted, GET /vendors passes the gate (not 402)", async () => {
    const res = await req(buildApp(), "GET", base, OWNER);
    expect(res.status).not.toBe(402);
  });
});
