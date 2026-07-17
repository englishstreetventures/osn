import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  directoryVendorCategories,
  directoryVendors,
  vendorClaims,
  vendors,
  weddings,
} from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { createDirectoryService, ClaimInvalid } from "./directory";
import { VendorNotInWedding } from "./vendors";

const OTHER_WEDDING = "wed_other";
const TEST_ORIGIN = "https://vendor.test.example.com";

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddings)
    .values({
      id: OTHER_WEDDING,
      slug: "other",
      displayName: "Other Wedding",
      ownerOsnProfileId: "usr_bob",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return db;
}

const directoryService = createDirectoryService({ vendorPortalOrigin: TEST_ORIGIN });

const run = <A, E>(db: ReturnType<typeof createDb>, e: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(e.pipe(Effect.provideService(DbService, db)));

describe("directoryService.upsertListingForOrg", () => {
  it("creates a live listing with the given category set", async () => {
    const db = db0();
    const res = await run(
      db,
      directoryService.upsertListingForOrg("org_alpha", {
        name: "Bloom Florals",
        description: "Beautiful flowers",
        email: "hello@bloom.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: "Sydney",
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: ["florals", "decoration"],
      }),
    );
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    const dto = res.value;
    expect(dto.ownerOrgId).toBe("org_alpha");
    expect(dto.name).toBe("Bloom Florals");
    expect(dto.listed).toBe("live");
    expect(dto.categories.sort()).toEqual(["decoration", "florals"]);
    // Check the DB has exactly one row for org
    const rows = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.ownerOrgId, "org_alpha"))
      .all();
    expect(rows.length).toBe(1);
  });

  it("updates the existing row on second call (upsert = one row) and replaces categories", async () => {
    const db = db0();
    const first = await run(
      db,
      directoryService.upsertListingForOrg("org_beta", {
        name: "Beta Venue",
        description: null,
        email: "hi@beta.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: ["venue", "catering"],
      }),
    );
    expect(Exit.isSuccess(first)).toBe(true);

    const second = await run(
      db,
      directoryService.upsertListingForOrg("org_beta", {
        name: "Beta Venue Updated",
        description: "Great place",
        email: "hi@beta.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: ["venue"],
      }),
    );
    expect(Exit.isSuccess(second)).toBe(true);
    if (!Exit.isSuccess(second)) throw new Error("failed");
    const dto = second.value;
    expect(dto.name).toBe("Beta Venue Updated");
    expect(dto.categories).toEqual(["venue"]);

    // Only one row in DB for this org
    const dvRows = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.ownerOrgId, "org_beta"))
      .all();
    expect(dvRows.length).toBe(1);

    // Categories replaced, not appended
    const catRows = db
      .select()
      .from(directoryVendorCategories)
      .where(eq(directoryVendorCategories.directoryVendorId, dto.id))
      .all();
    expect(catRows.length).toBe(1);
    expect(catRows[0]!.category).toBe("venue");
  });
});

describe("directoryService.getListingByOrg", () => {
  it("returns null for a non-existent org", async () => {
    const db = db0();
    const res = await run(db, directoryService.getListingByOrg("org_nobody"));
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    expect(res.value).toBeNull();
  });

  it("returns the listing after upsert", async () => {
    const db = db0();
    await run(
      db,
      directoryService.upsertListingForOrg("org_gamma", {
        name: "Gamma Photo",
        description: null,
        email: "g@gamma.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: ["photography"],
      }),
    );
    const res = await run(db, directoryService.getListingByOrg("org_gamma"));
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    expect(res.value).not.toBeNull();
    expect(res.value!.name).toBe("Gamma Photo");
    expect(res.value!.categories).toEqual(["photography"]);
  });
});

describe("directoryService.seedFromCrm", () => {
  it("creates a draft listing, links the CRM vendor, returns token and claimUrl", async () => {
    const db = db0();
    // Create a vendor CRM row for the bootstrap wedding
    const vendorId = `ven_${crypto.randomUUID()}`;
    db.insert(vendors)
      .values({
        id: vendorId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        directoryVendorId: null,
        name: "Test Vendor",
        category: "florals",
        status: "researching",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const res = await run(
      db,
      directoryService.seedFromCrm(BOOTSTRAP_WEDDING_ID, vendorId, {
        name: "Seed Vendor",
        description: null,
        email: "seed@vendor.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: ["florals"],
      }),
    );
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    const { claimToken, claimUrl, directoryVendorId } = res.value;

    expect(claimToken).toBeTruthy();
    expect(claimUrl).toContain(claimToken);
    expect(claimUrl).toContain(TEST_ORIGIN);
    expect(directoryVendorId).toBeTruthy();

    // The draft listing was created
    const dvRow = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.id, directoryVendorId))
      .get();
    expect(dvRow).toBeTruthy();
    expect(dvRow!.listed).toBe("draft");
    expect(dvRow!.ownerOrgId).toBeNull();

    // CRM row was linked
    const crmRow = db.select().from(vendors).where(eq(vendors.id, vendorId)).get();
    expect(crmRow!.directoryVendorId).toBe(directoryVendorId);

    // The stored token_hash is NOT the plaintext token
    const claimRow = db
      .select()
      .from(vendorClaims)
      .where(eq(vendorClaims.directoryVendorId, directoryVendorId))
      .get();
    expect(claimRow).toBeTruthy();
    expect(claimRow!.tokenHash).not.toBe(claimToken);
    // token_hash is a 64-char hex SHA-256
    expect(claimRow!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails VendorNotInWedding when vendor belongs to a different wedding", async () => {
    const db = db0();
    const vendorId = `ven_${crypto.randomUUID()}`;
    // Insert vendor under OTHER_WEDDING
    db.insert(vendors)
      .values({
        id: vendorId,
        weddingId: OTHER_WEDDING,
        directoryVendorId: null,
        name: "Other Vendor",
        category: "venue",
        status: "researching",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const res = await run(
      db,
      directoryService.seedFromCrm(BOOTSTRAP_WEDDING_ID, vendorId, {
        name: "Hijack Vendor",
        description: null,
        email: "hijack@bad.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: [],
      }),
    );
    expect(
      Exit.isFailure(res) &&
        res.cause._tag === "Fail" &&
        res.cause.error instanceof VendorNotInWedding,
    ).toBe(true);
  });
});

describe("directoryService.getClaimPreview", () => {
  it("returns listing summary for a fresh token", async () => {
    const db = db0();
    const vendorId = `ven_${crypto.randomUUID()}`;
    db.insert(vendors)
      .values({
        id: vendorId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        directoryVendorId: null,
        name: "Preview Vendor",
        category: "catering",
        status: "researching",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const seedRes = await run(
      db,
      directoryService.seedFromCrm(BOOTSTRAP_WEDDING_ID, vendorId, {
        name: "Preview Listing",
        description: null,
        email: "preview@vendor.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: [],
      }),
    );
    expect(Exit.isSuccess(seedRes)).toBe(true);
    if (!Exit.isSuccess(seedRes)) throw new Error("seed failed");
    const { claimToken, directoryVendorId } = seedRes.value;

    const previewRes = await run(db, directoryService.getClaimPreview(claimToken));
    expect(Exit.isSuccess(previewRes)).toBe(true);
    if (!Exit.isSuccess(previewRes)) throw new Error("failed");
    expect(previewRes.value).not.toBeNull();
    expect(previewRes.value!.directoryVendorId).toBe(directoryVendorId);
    expect(previewRes.value!.name).toBe("Preview Listing");
    expect("email" in previewRes.value!).toBe(false);
  });

  it("returns null for an unknown token", async () => {
    const db = db0();
    const res = await run(db, directoryService.getClaimPreview("totally-made-up-token"));
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    expect(res.value).toBeNull();
  });
});

describe("directoryService.consumeClaim", () => {
  async function seedVendorAndClaim(db: ReturnType<typeof createDb>) {
    const vendorId = `ven_${crypto.randomUUID()}`;
    db.insert(vendors)
      .values({
        id: vendorId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        directoryVendorId: null,
        name: "Claim Vendor",
        category: "music",
        status: "researching",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const seedRes = await run(
      db,
      directoryService.seedFromCrm(BOOTSTRAP_WEDDING_ID, vendorId, {
        name: "Claim Listing",
        description: null,
        email: "claim@vendor.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        categories: ["music"],
      }),
    );
    if (!Exit.isSuccess(seedRes)) throw new Error("seed failed");
    return seedRes.value;
  }

  it("binds owner_org_id, flips listed to live, stamps consumed_at", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_consumer"));
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    const dto = res.value;
    expect(dto.ownerOrgId).toBe("org_consumer");
    expect(dto.listed).toBe("live");
    expect(dto.id).toBe(directoryVendorId);

    // consumed_at is stamped
    const claimRow = db
      .select()
      .from(vendorClaims)
      .where(eq(vendorClaims.directoryVendorId, directoryVendorId))
      .get();
    expect(claimRow!.consumedAt).not.toBeNull();
  });

  it("second consumeClaim with same token fails ClaimInvalid (single-use)", async () => {
    const db = db0();
    const { claimToken } = await seedVendorAndClaim(db);

    await run(db, directoryService.consumeClaim(claimToken, "org_first"));
    const second = await run(db, directoryService.consumeClaim(claimToken, "org_second"));
    expect(
      Exit.isFailure(second) &&
        second.cause._tag === "Fail" &&
        second.cause.error instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("single-use guarantee: consumed_at stamped AND listing bound atomically on success", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_atomic"));
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("consume failed");

    // Both writes must have landed: token burned and listing bound.
    const claimRow = db
      .select()
      .from(vendorClaims)
      .where(eq(vendorClaims.directoryVendorId, directoryVendorId))
      .get();
    expect(claimRow!.consumedAt).not.toBeNull(); // token burned

    const dvRow = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.id, directoryVendorId))
      .get();
    expect(dvRow!.ownerOrgId).toBe("org_atomic"); // listing bound
    expect(dvRow!.listed).toBe("live"); // flipped live

    // Reuse attempt must fail — consumed_at gate fires before any write.
    const reuse = await run(db, directoryService.consumeClaim(claimToken, "org_reuse"));
    expect(
      Exit.isFailure(reuse) &&
        reuse.cause._tag === "Fail" &&
        reuse.cause.error instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("fails ClaimInvalid for an expired token", async () => {
    const db = db0();
    // Manually insert a claim that expired in the past
    const dvId = `dv_${crypto.randomUUID()}`;
    db.insert(directoryVendors)
      .values({
        id: dvId,
        ownerOrgId: null,
        name: "Expired Listing",
        description: null,
        email: "expired@vendor.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "draft",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const fakeToken = "expiredtoken123";
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fakeToken));
    const hash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    db.insert(vendorClaims)
      .values({
        id: `clm_${crypto.randomUUID()}`,
        directoryVendorId: dvId,
        tokenHash: hash,
        email: "expired@vendor.com",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() - 1000), // already expired
        consumedAt: null,
      })
      .run();

    const res = await run(db, directoryService.consumeClaim(fakeToken, "org_late"));
    expect(
      Exit.isFailure(res) && res.cause._tag === "Fail" && res.cause.error instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("fails ClaimInvalid for an unknown token", async () => {
    const db = db0();
    const res = await run(db, directoryService.consumeClaim("no-such-token", "org_x"));
    expect(
      Exit.isFailure(res) && res.cause._tag === "Fail" && res.cause.error instanceof ClaimInvalid,
    ).toBe(true);
  });
});
