import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  directoryVendorCategories,
  directoryVendors,
  vendorClaims,
  vendors,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";
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

    const res = await run(
      db,
      directoryService.consumeClaim(claimToken, "org_consumer", "usr_claimer"),
    );
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

  it("records claimed_by_profile_id alongside owner_org_id in the same bind", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);

    const res = await run(
      db,
      directoryService.consumeClaim(claimToken, "org_claimer", "usr_the_claimer"),
    );
    expect(Exit.isSuccess(res)).toBe(true);

    const dvRow = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.id, directoryVendorId))
      .get();
    // The central fix: the claiming profile is persisted so the enquiry service
    // reads this listing as CLAIMED (its open() branches on claimedByProfileId).
    expect(dvRow!.claimedByProfileId).toBe("usr_the_claimer");
    expect(dvRow!.ownerOrgId).toBe("org_claimer");
  });

  it("second consumeClaim with same token fails ClaimInvalid (single-use)", async () => {
    const db = db0();
    const { claimToken } = await seedVendorAndClaim(db);

    await run(db, directoryService.consumeClaim(claimToken, "org_first", "usr_first"));
    const second = await run(
      db,
      directoryService.consumeClaim(claimToken, "org_second", "usr_second"),
    );
    expect(
      Exit.isFailure(second) &&
        second.cause._tag === "Fail" &&
        second.cause.error instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("single-use guarantee: consumed_at stamped AND listing bound atomically on success", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);

    const res = await run(
      db,
      directoryService.consumeClaim(claimToken, "org_atomic", "usr_atomic"),
    );
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
    const reuse = await run(
      db,
      directoryService.consumeClaim(claimToken, "org_reuse", "usr_reuse"),
    );
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

    const res = await run(db, directoryService.consumeClaim(fakeToken, "org_late", "usr_late"));
    expect(
      Exit.isFailure(res) && res.cause._tag === "Fail" && res.cause.error instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("fails ClaimInvalid for an unknown token", async () => {
    const db = db0();
    const res = await run(db, directoryService.consumeClaim("no-such-token", "org_x", "usr_x"));
    expect(
      Exit.isFailure(res) && res.cause._tag === "Fail" && res.cause.error instanceof ClaimInvalid,
    ).toBe(true);
  });
});

// ── browse + getLiveListingById ────────────────────────────────────────────────
// Seed: live listing LA (categories venue+catering, Sydney, "garden venue" desc),
//       live listing LB (photography, Melbourne, name "Bloom Photo"),
//       draft listing LD (venue),
//       wedding W1 (with a CRM vendor linked to LA), wedding W2 (no vendors).
describe("directoryService.browse + getLiveListingById", () => {
  function makeDb() {
    const db = createDb(":memory:");
    const now = new Date();

    // Weddings W1 and W2
    db.insert(weddings)
      .values({
        id: "W1",
        slug: "wedding-w1",
        displayName: "Wedding W1",
        ownerOsnProfileId: "usr_w1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(weddings)
      .values({
        id: "W2",
        slug: "wedding-w2",
        displayName: "Wedding W2",
        ownerOsnProfileId: "usr_w2",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Live listing LA — venue + catering, Sydney, description contains "garden venue"
    db.insert(directoryVendors)
      .values({
        id: "LA",
        ownerOrgId: "org_la",
        name: "Acorn Estate",
        description: "Beautiful garden venue for weddings",
        email: "hello@acorn.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: "Sydney",
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(directoryVendorCategories)
      .values([
        { directoryVendorId: "LA", category: "venue" },
        { directoryVendorId: "LA", category: "catering" },
      ])
      .run();

    // Live listing LB — photography, Melbourne, name "Bloom Photo"
    db.insert(directoryVendors)
      .values({
        id: "LB",
        ownerOrgId: "org_lb",
        name: "Bloom Photo",
        description: null,
        email: "hi@bloom.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: "Melbourne",
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(directoryVendorCategories)
      .values([{ directoryVendorId: "LB", category: "photography" }])
      .run();

    // Draft listing LD — venue (excluded from browse)
    db.insert(directoryVendors)
      .values({
        id: "LD",
        ownerOrgId: null,
        name: "Draft Venue",
        description: null,
        email: null,
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "draft",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(directoryVendorCategories)
      .values([{ directoryVendorId: "LD", category: "venue" }])
      .run();

    // CRM vendor in W1 linked to LA (so inWedding=true for LA in W1)
    db.insert(vendors)
      .values({
        id: "ven_w1_la",
        weddingId: "W1",
        directoryVendorId: "LA",
        name: "Acorn Estate",
        category: "venue",
        status: "confirmed",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return db;
  }

  const svc = createDirectoryService({ vendorPortalOrigin: TEST_ORIGIN });

  function run<A, E>(e: Effect.Effect<A, E, DbService>) {
    const db = makeDb();
    return Effect.runPromise(e.pipe(Effect.provideService(DbService, db)));
  }

  it("returns only live listings", async () => {
    const { listings, total } = await run(svc.browse("W1", { limit: 24, offset: 0 }));
    const ids = listings.map((l) => l.id);
    expect(ids).toContain("LA");
    expect(ids).toContain("LB");
    expect(ids).not.toContain("LD"); // draft excluded
    expect(total).toBe(2);
  });

  it("filters by category", async () => {
    const { listings } = await run(
      svc.browse("W1", { category: "photography", limit: 24, offset: 0 }),
    );
    expect(listings.map((l) => l.id)).toEqual(["LB"]);
  });

  it("filters by keyword across name and description", async () => {
    expect(
      (await run(svc.browse("W1", { q: "garden", limit: 24, offset: 0 }))).listings.map(
        (l) => l.id,
      ),
    ).toEqual(["LA"]); // description hit
    expect(
      (await run(svc.browse("W1", { q: "bloom", limit: 24, offset: 0 }))).listings.map((l) => l.id),
    ).toEqual(["LB"]); // name hit, case-insensitive
  });

  it("filters by location", async () => {
    expect(
      (await run(svc.browse("W1", { location: "sydney", limit: 24, offset: 0 }))).listings.map(
        (l) => l.id,
      ),
    ).toEqual(["LA"]);
  });

  it("paginates with a stable order and reports total", async () => {
    const page1 = await run(svc.browse("W1", { limit: 1, offset: 0 }));
    const page2 = await run(svc.browse("W1", { limit: 1, offset: 1 }));
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(page1.listings[0]!.id).not.toBe(page2.listings[0]!.id);
  });

  it("sets inWedding true only for listings already in THIS wedding's CRM", async () => {
    const w1 = await run(svc.browse("W1", { limit: 24, offset: 0 }));
    const w2 = await run(svc.browse("W2", { limit: 24, offset: 0 }));
    expect(w1.listings.find((l) => l.id === "LA")!.inWedding).toBe(true);
    expect(w1.listings.find((l) => l.id === "LB")!.inWedding).toBe(false);
    expect(w2.listings.find((l) => l.id === "LA")!.inWedding).toBe(false); // scoped to wedding
  });

  it("getLiveListingById returns a live listing with categories, null for draft/missing", async () => {
    expect((await run(svc.getLiveListingById("LA")))!.categories.sort()).toEqual([
      "catering",
      "venue",
    ]);
    expect(await run(svc.getLiveListingById("LD"))).toBeNull(); // draft
    expect(await run(svc.getLiveListingById("nope"))).toBeNull();
  });

  it("keyword filter treats % literally (escapeLike fires)", async () => {
    // Seed a fresh db with two live listings whose names distinguish literal vs wildcard matching.
    // "100% Cotton Linens" contains a literal '%'.
    // "10000 Roses" does NOT — but an unescaped '%' in the query "100%" would act as a wildcard
    // and match both ("100" + anything). With escapeLike the '%' is escaped so only the listing
    // that literally contains "100%" in its name is returned.
    const db = makeDb();
    const now = new Date();
    db.insert(directoryVendors)
      .values({
        id: "LC",
        ownerOrgId: "org_lc",
        name: "100% Cotton Linens",
        description: null,
        email: "lc@test.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(directoryVendors)
      .values({
        id: "LE",
        ownerOrgId: "org_le",
        name: "10000 Roses",
        description: null,
        email: "le@test.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const { listings } = await Effect.runPromise(
      svc
        .browse("W1", { q: "100%", limit: 24, offset: 0 })
        .pipe(Effect.provideService(DbService, db)),
    );
    const ids = listings.map((l) => l.id);
    // Must match "100% Cotton Linens" (literal %)
    expect(ids).toContain("LC");
    // Must NOT match "10000 Roses" (a wildcard % would make "100%" match "10000...")
    expect(ids).not.toContain("LE");
  });
});
