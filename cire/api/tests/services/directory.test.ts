import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  directoryVendorCategories,
  directoryVendors,
  vendorClaims,
  vendors,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import {
  createDirectoryService,
  ClaimInvalid,
  ListingAwaitingConfirmation,
  OrgAlreadyHasListing,
} from "../../src/services/directory";
import { VendorNotInWedding } from "../../src/services/vendors";
import { recordStatements } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

const OTHER_WEDDING = "wed_other";
const TEST_ORIGIN = "https://vendor.test.example.com";

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  insertWedding(db, {
    id: OTHER_WEDDING,
    slug: "other",
    displayName: "Other Wedding",
    createdAt: new Date(),
    updatedAt: new Date(),
    owners: ["usr_bob"],
  });
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
    expect(dto.categories.toSorted()).toEqual(["decoration", "florals"]);
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

  const deltaBody = (name: string, categories: string[]) => ({
    name,
    description: `${name} description`,
    email: "hi@delta.com",
    phone: null,
    website: null,
    instagram: null,
    locationText: "Perth",
    priceBand: null,
    priceMinMinor: null,
    priceMaxMinor: null,
    categories,
  });

  const isSelect = (s: { sql: string }) => /^select\b/i.test(s.sql);

  it("answers a first save from what it wrote, reading nothing back", async () => {
    const db = db0();
    const statements = recordStatements(db);

    const res = await run(
      db,
      directoryService.upsertListingForOrg("org_delta", deltaBody("Delta", ["venue", "cake"])),
    );
    if (!Exit.isSuccess(res)) throw new Error("failed");

    // The one read is the probe for an existing listing; the categories it
    // just wrote are not read back.
    expect(statements.filter(isSelect)).toHaveLength(1);
    expect(
      statements.some((s) => s.sql.includes('"directory_vendor_categories"') && isSelect(s)),
    ).toBe(false);
    // Category order is the key order a read of the table gives.
    expect(res.value.categories).toEqual(["cake", "venue"]);
  });

  it("writes nothing when the listing changes owner between the probe and the update", async () => {
    const db = db0();
    const first = await run(
      db,
      directoryService.upsertListingForOrg("org_delta", deltaBody("Delta", ["venue"])),
    );
    if (!Exit.isSuccess(first)) throw new Error("first save failed");
    // Another org takes the listing after this save has found it by owner.
    const client = db.$client;
    const prepare = client.prepare.bind(client);
    Object.defineProperty(client, "prepare", {
      configurable: true,
      value: (sql: string) => {
        if (/^update "directory_vendors"/i.test(sql)) {
          prepare("UPDATE directory_vendors SET owner_org_id = 'org_other' WHERE id = ?1").run(
            first.value.id,
          );
        }
        return prepare(sql);
      },
    });

    const res = await run(
      db,
      directoryService.upsertListingForOrg("org_delta", deltaBody("Delta Renamed", ["cake"])),
    );
    expect(Exit.isFailure(res)).toBe(true);

    const row = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.id, first.value.id))
      .get();
    expect(row!.ownerOrgId).toBe("org_other");
    expect(row!.name).toBe("Delta");
    const cats = db
      .select({ category: directoryVendorCategories.category })
      .from(directoryVendorCategories)
      .where(eq(directoryVendorCategories.directoryVendorId, first.value.id))
      .all()
      .map((r) => r.category);
    expect(cats).toEqual(["venue"]);
  });

  // Answering from the body is correct only because a duplicate category
  // fails the replace batch on the (directory_vendor_id, category) key. That
  // the stored set survives the failure is D1's batch atomicity, tested in
  // tests/db/d1-integration.test.ts; bun:sqlite runs the batch unwrapped.
  it("fails a save that repeats a category, first save or update", async () => {
    const db = db0();
    const dup = await run(
      db,
      directoryService.upsertListingForOrg("org_dup", deltaBody("Dup", ["venue", "venue"])),
    );
    expect(Exit.isFailure(dup)).toBe(true);

    const saved = await run(
      db,
      directoryService.upsertListingForOrg("org_dup", deltaBody("Dup", ["cake"])),
    );
    expect(Exit.isSuccess(saved)).toBe(true);
    const again = await run(
      db,
      directoryService.upsertListingForOrg("org_dup", deltaBody("Dup", ["florals", "florals"])),
    );
    expect(Exit.isFailure(again)).toBe(true);
  });

  it("answers an update from the UPDATE itself, reading nothing back", async () => {
    const db = db0();
    const first = await run(
      db,
      directoryService.upsertListingForOrg("org_delta", deltaBody("Delta", ["venue"])),
    );
    if (!Exit.isSuccess(first)) throw new Error("first save failed");
    const statements = recordStatements(db);

    const res = await run(
      db,
      directoryService.upsertListingForOrg(
        "org_delta",
        deltaBody("Delta Renamed", ["photography", "cake", "florals"]),
      ),
    );
    if (!Exit.isSuccess(res)) throw new Error("update failed");

    expect(statements.filter(isSelect)).toHaveLength(1);
    expect(
      statements.some((s) => s.sql.includes('"directory_vendor_categories"') && isSelect(s)),
    ).toBe(false);

    const dto = res.value;
    expect(dto.id).toBe(first.value.id);
    expect(dto.name).toBe("Delta Renamed");
    expect(dto.description).toBe("Delta Renamed description");
    // Stored at second precision; the first save answers from memory.
    expect(dto.createdAt).toBe(Math.floor(first.value.createdAt / 1000) * 1000);
    expect(dto.categories).toEqual(["cake", "florals", "photography"]);
    // The UPDATE returns every column; the answer carries the listing fields
    // only, never the lead-forwarding address or the claiming profile.
    expect(Object.keys(dto).toSorted()).toEqual(
      [
        "id",
        "ownerOrgId",
        "name",
        "description",
        "email",
        "phone",
        "website",
        "instagram",
        "locationText",
        "priceBand",
        "priceMinMinor",
        "priceMaxMinor",
        "listed",
        "awaitingConfirmation",
        "categories",
        "createdAt",
        "updatedAt",
      ].toSorted(),
    );
  });
});

describe("directoryService.issueClaimForListing", () => {
  it("returns null for a listing with ownerOrgId already set (no claim minted)", async () => {
    const db = db0();
    const dvId = `dv_${crypto.randomUUID()}`;
    db.insert(directoryVendors)
      .values({
        id: dvId,
        ownerOrgId: "org_owner",
        name: "Owned Listing",
        description: null,
        email: "owned@vendor.com",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const res = await run(
      db,
      directoryService.issueClaimForListing({
        id: dvId,
        ownerOrgId: "org_owner",
        reviewOrgId: null,
        email: "owned@vendor.com",
        name: "Owned Listing",
        phone: null,
        claimedByProfileId: null,
        leadForwardEmail: null,
      }),
    );
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    expect(res.value).toBeNull();

    // No claim row was inserted for this listing.
    const claimRows = db
      .select()
      .from(vendorClaims)
      .where(eq(vendorClaims.directoryVendorId, dvId))
      .all();
    expect(claimRows.length).toBe(0);
  });

  it("returns null for a null row (no listing found)", async () => {
    const db = db0();
    const res = await run(db, directoryService.issueClaimForListing(null));
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    expect(res.value).toBeNull();
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
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof VendorNotInWedding,
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

  it("returns null for a live token whose listing is already claimed", async () => {
    const db = db0();
    const dvId = "dv_claimed_preview";
    db.insert(directoryVendors)
      .values({
        id: dvId,
        ownerOrgId: "org_owner",
        name: "Claimed Listing",
        listed: "live",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const token = await mintToken(db, dvId);

    const res = await run(db, directoryService.getClaimPreview(token));
    expect(Exit.isSuccess(res) && res.value).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const db = db0();
    const res = await run(db, directoryService.getClaimPreview("totally-made-up-token"));
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    expect(res.value).toBeNull();
  });
});

// ── consumeClaim helpers ──────────────────────────────────────────────────────

const LISTING_BODY = {
  name: "Own Listing",
  description: null,
  email: "own@vendor.com",
  phone: null,
  website: null,
  instagram: null,
  locationText: null,
  priceBand: null,
  priceMinMinor: null,
  priceMaxMinor: null,
  categories: [],
};

function failedWith(
  exit: Exit.Exit<unknown, unknown>,
  cls: typeof ClaimInvalid | typeof OrgAlreadyHasListing | typeof ListingAwaitingConfirmation,
): boolean {
  return (
    Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof cls
  );
}

async function tokenHash(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function claimOf(db: ReturnType<typeof createDb>, token: string) {
  const hash = await tokenHash(token);
  return db.select().from(vendorClaims).where(eq(vendorClaims.tokenHash, hash)).get();
}

function listingOf(db: ReturnType<typeof createDb>, id: string) {
  return db.select().from(directoryVendors).where(eq(directoryVendors.id, id)).get()!;
}

/** A second live claim token for `directoryVendorId`, inserted directly. */
async function mintToken(db: ReturnType<typeof createDb>, directoryVendorId: string) {
  const token = `tok_${crypto.randomUUID()}`;
  const hash = await tokenHash(token);
  db.insert(vendorClaims)
    .values({
      id: `clm_${crypto.randomUUID()}`,
      directoryVendorId,
      tokenHash: hash,
      email: "claim@vendor.com",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    })
    .run();
  return token;
}

/** Run `effect` once, just before the claim's bind statement is prepared. */
function interceptBeforeBind(db: ReturnType<typeof createDb>, effect: () => unknown) {
  const client = db.$client;
  const prepare = client.prepare.bind(client);
  let fired = false;
  Object.defineProperty(client, "prepare", {
    configurable: true,
    value: (sql: string) => {
      if (!fired && /^update "directory_vendors"/i.test(sql)) {
        fired = true;
        effect();
      }
      return prepare(sql);
    },
  });
}

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

  it("holds the claim for an operator: owner stays null, listing stays draft, token burned", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);

    const res = await run(
      db,
      directoryService.consumeClaim(claimToken, "org_consumer", "usr_claimer"),
    );
    expect(Exit.isSuccess(res)).toBe(true);
    if (!Exit.isSuccess(res)) throw new Error("failed");
    const dto = res.value;
    expect(dto.ownerOrgId).toBeNull();
    expect(dto.listed).toBe("draft");
    expect(dto.awaitingConfirmation).toBe(true);
    expect(dto.id).toBe(directoryVendorId);

    const dv = listingOf(db, directoryVendorId);
    expect(dv.reviewOrgId).toBe("org_consumer");
    expect(dv.reviewRequestedAt).not.toBeNull();

    // consumed_at is stamped
    const claimRow = db
      .select()
      .from(vendorClaims)
      .where(eq(vendorClaims.directoryVendorId, directoryVendorId))
      .get();
    expect(claimRow!.consumedAt).not.toBeNull();
  });

  it("records the claiming profile as pending, never as the claimant", async () => {
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
    // The enquiry service decides "claimed" on claimedByProfileId, so it must
    // stay null until an operator confirms: no chat reaches the claimant.
    expect(dvRow!.claimedByProfileId).toBeNull();
    expect(dvRow!.ownerOrgId).toBeNull();
    expect(dvRow!.reviewProfileId).toBe("usr_the_claimer");
    expect(dvRow!.reviewOrgId).toBe("org_claimer");
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
        Option.getOrUndefined(Cause.findErrorOption(second.cause)) instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("single-use guarantee: consumed_at stamped AND claim recorded on success", async () => {
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
    expect(dvRow!.reviewOrgId).toBe("org_atomic"); // claim recorded
    expect(dvRow!.listed).toBe("draft"); // not live until confirmed

    // Reuse attempt must fail — consumed_at gate fires before any write.
    const reuse = await run(
      db,
      directoryService.consumeClaim(claimToken, "org_reuse", "usr_reuse"),
    );
    expect(
      Exit.isFailure(reuse) &&
        Option.getOrUndefined(Cause.findErrorOption(reuse.cause)) instanceof ClaimInvalid,
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
      Exit.isFailure(res) &&
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("fails ClaimInvalid for an unknown token", async () => {
    const db = db0();
    const res = await run(db, directoryService.consumeClaim("no-such-token", "org_x", "usr_x"));
    expect(
      Exit.isFailure(res) &&
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof ClaimInvalid,
    ).toBe(true);
  });

  it("burns the token before it binds the listing, and reads nothing back", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);
    const statements = recordStatements(db);

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_order", "usr_order"));
    if (!Exit.isSuccess(res)) throw new Error("consume failed");

    const sqls = statements.map((s) => s.sql);
    const burn = sqls.findIndex((s) => /^update "vendor_claims"/i.test(s));
    const bind = sqls.findIndex((s) => /^update "directory_vendors"/i.test(s));
    const burnOthers = sqls.findLastIndex((s) => /^update "vendor_claims"/i.test(s));
    // The burn is the first statement: it carries every pre-check in its own
    // WHERE, so nothing reads the claim before it.
    expect(burn).toBe(0);
    expect(bind).toBeGreaterThan(burn);
    expect(burnOthers).toBeGreaterThan(bind);
    // Burn, bind, burn of the other tokens, categories — the listing id comes
    // back from the burn and the bound row from the bind, so neither is read.
    expect(sqls).toHaveLength(4);
    expect(
      sqls.filter((s) => /^select\b/i.test(s) && s.includes('"directory_vendors"')),
    ).toHaveLength(0);

    expect(res.value.id).toBe(directoryVendorId);
    expect(res.value.ownerOrgId).toBeNull();
    expect(res.value.awaitingConfirmation).toBe(true);
    expect(res.value.listed).toBe("draft");
    expect(res.value.categories).toEqual(["music"]);
    expect(Object.keys(res.value)).not.toContain("claimedByProfileId");
    expect(Object.keys(res.value)).not.toContain("leadForwardEmail");
    expect(Object.keys(res.value)).not.toContain("reviewProfileId");
  });

  it("binds nothing when another consume burns the token first", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);
    // A concurrent consume wins the race: the token is spent just before this
    // call's burn runs, and the burn's `consumed_at IS NULL` refuses it.
    const client = db.$client;
    const prepare = client.prepare.bind(client);
    Object.defineProperty(client, "prepare", {
      configurable: true,
      value: (sql: string) => {
        if (/^update "vendor_claims"/i.test(sql)) {
          prepare("UPDATE vendor_claims SET consumed_at = ?1 WHERE directory_vendor_id = ?2").run(
            Math.floor(Date.now() / 1000),
            directoryVendorId,
          );
        }
        return prepare(sql);
      },
    });

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_late", "usr_late"));
    expect(
      Exit.isFailure(res) &&
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof ClaimInvalid,
    ).toBe(true);

    const dvRow = db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.id, directoryVendorId))
      .get();
    expect(dvRow!.ownerOrgId).toBeNull();
    expect(dvRow!.claimedByProfileId).toBeNull();
    expect(dvRow!.listed).toBe("draft");
  });

  it("fails ClaimInvalid, with the token burned, when the listing is gone at bind", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);
    // The listing goes after the pre-check and the burn, as the bind starts.
    // The claim's foreign key cascades, so this state needs the check off.
    db.$client.exec("PRAGMA foreign_keys = OFF;");
    interceptBeforeBind(db, () =>
      db.$client.prepare("DELETE FROM directory_vendors WHERE id = ?1").run(directoryVendorId),
    );

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_gone", "usr_gone"));
    expect(failedWith(res, ClaimInvalid)).toBe(true);

    const claimRow = db
      .select()
      .from(vendorClaims)
      .where(eq(vendorClaims.directoryVendorId, directoryVendorId))
      .get();
    expect(claimRow!.consumedAt).not.toBeNull();
  });

  it("fails ClaimInvalid without burning the token when the listing is already gone", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);
    db.$client.exec("PRAGMA foreign_keys = OFF;");
    db.delete(directoryVendors).where(eq(directoryVendors.id, directoryVendorId)).run();

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_gone", "usr_gone"));
    expect(failedWith(res, ClaimInvalid)).toBe(true);
    expect((await claimOf(db, claimToken))!.consumedAt).toBeNull();
  });

  it("a second live token cannot move a pending claim to another org", async () => {
    const db = db0();
    const { claimToken: first, directoryVendorId } = await seedVendorAndClaim(db);
    const second = await mintToken(db, directoryVendorId);

    const won = await run(db, directoryService.consumeClaim(second, "org_vendor", "usr_vendor"));
    expect(Exit.isSuccess(won)).toBe(true);

    const res = await run(db, directoryService.consumeClaim(first, "org_other", "usr_other"));
    expect(failedWith(res, ClaimInvalid)).toBe(true);
    const dv = listingOf(db, directoryVendorId);
    expect(dv.reviewOrgId).toBe("org_vendor");
    expect(dv.reviewProfileId).toBe("usr_vendor");
    expect(dv.ownerOrgId).toBeNull();
  });

  it("burns every other live token for the listing on a successful claim", async () => {
    const db = db0();
    const { claimToken: first, directoryVendorId } = await seedVendorAndClaim(db);
    const second = await mintToken(db, directoryVendorId);
    // A token for another listing is left alone.
    const elsewhere = await seedVendorAndClaim(db);

    const res = await run(db, directoryService.consumeClaim(second, "org_vendor", "usr_vendor"));
    expect(Exit.isSuccess(res)).toBe(true);

    expect((await claimOf(db, first))!.consumedAt).not.toBeNull();
    expect((await claimOf(db, second))!.consumedAt).not.toBeNull();
    expect((await claimOf(db, elsewhere.claimToken))!.consumedAt).toBeNull();
  });

  it("a live token for a claimed listing fails ClaimInvalid and is not burned", async () => {
    const db = db0();
    const { directoryVendorId } = await seedVendorAndClaim(db);
    db.update(directoryVendors)
      .set({ ownerOrgId: "org_vendor", claimedByProfileId: "usr_vendor" })
      .where(eq(directoryVendors.id, directoryVendorId))
      .run();
    const stray = await mintToken(db, directoryVendorId);

    // The org check would also refuse here; the listing check answers first.
    const res = await run(db, directoryService.consumeClaim(stray, "org_vendor", "usr_x"));
    expect(failedWith(res, ClaimInvalid)).toBe(true);
    expect((await claimOf(db, stray))!.consumedAt).toBeNull();
    expect(listingOf(db, directoryVendorId).claimedByProfileId).toBe("usr_vendor");
  });

  it("binds nothing when the listing is claimed between the pre-check and the bind", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);
    interceptBeforeBind(db, () =>
      db.$client
        .prepare("UPDATE directory_vendors SET owner_org_id = 'org_first' WHERE id = ?1")
        .run(directoryVendorId),
    );

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_late", "usr_late"));
    expect(failedWith(res, ClaimInvalid)).toBe(true);
    expect(listingOf(db, directoryVendorId).ownerOrgId).toBe("org_first");
    expect(listingOf(db, directoryVendorId).claimedByProfileId).toBeNull();
  });

  // A refusal is the burn matching no row, then one read to name the refusal.
  it("refuses in two statements, the first the burn, spending nothing", async () => {
    const db = db0();
    await run(db, directoryService.upsertListingForOrg("org_has", LISTING_BODY));
    const { claimToken } = await seedVendorAndClaim(db);
    const statements = recordStatements(db);

    const conflict = await run(db, directoryService.consumeClaim(claimToken, "org_has", "usr_has"));
    expect(failedWith(conflict, OrgAlreadyHasListing)).toBe(true);
    expect(statements.map((s) => s.sql.split(" ")[0]!.toLowerCase())).toEqual(["update", "select"]);
    expect((await claimOf(db, claimToken))!.consumedAt).toBeNull();

    statements.length = 0;
    const unknown = await run(db, directoryService.consumeClaim("no-such-token", "org_x", "usr_x"));
    expect(failedWith(unknown, ClaimInvalid)).toBe(true);
    expect(statements).toHaveLength(2);
  });

  // `expires_at` is stored in whole seconds; a token is live while its expiry
  // is not before the call, to the millisecond, whichever statement decides.
  it("refuses a token that expired a millisecond before the call, leaving it unspent", async () => {
    const db = db0();
    const { claimToken } = await seedVendorAndClaim(db);
    const hash = await tokenHash(claimToken);
    db.update(vendorClaims)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(vendorClaims.tokenHash, hash))
      .run();

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_late", "usr_late"));
    expect(failedWith(res, ClaimInvalid)).toBe(true);
    expect((await claimOf(db, claimToken))!.consumedAt).toBeNull();
  });

  it("fails OrgAlreadyHasListing, leaving the token live, when the org owns a listing", async () => {
    const db = db0();
    await run(db, directoryService.upsertListingForOrg("org_has", LISTING_BODY));
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_has", "usr_has"));
    expect(failedWith(res, OrgAlreadyHasListing)).toBe(true);
    expect((await claimOf(db, claimToken))!.consumedAt).toBeNull();
    expect(listingOf(db, directoryVendorId).ownerOrgId).toBeNull();

    // The same token still claims into an org with no listing.
    const ok = await run(db, directoryService.consumeClaim(claimToken, "org_free", "usr_has"));
    expect(Exit.isSuccess(ok)).toBe(true);
  });

  it("fails OrgAlreadyHasListing when the org gains a pending claim between the pre-check and the bind", async () => {
    const db = db0();
    const { claimToken, directoryVendorId } = await seedVendorAndClaim(db);
    const second = await mintToken(db, directoryVendorId);
    interceptBeforeBind(db, () =>
      db.$client
        .prepare(
          "INSERT INTO directory_vendors (id, review_org_id, name, listed, created_at, updated_at) VALUES ('dv_raced', 'org_race', 'Raced', 'draft', 0, 0)",
        )
        .run(),
    );

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_race", "usr_race"));
    expect(failedWith(res, OrgAlreadyHasListing)).toBe(true);
    expect(listingOf(db, directoryVendorId).reviewOrgId).toBeNull();
    // The bind failed first, so the listing's other tokens stay live.
    expect((await claimOf(db, second))!.consumedAt).toBeNull();
  });

  it("a bind failure that is not an owner conflict stays a defect, with the token burned", async () => {
    const db = db0();
    const { claimToken } = await seedVendorAndClaim(db);
    interceptBeforeBind(db, () => {
      throw new Error("disk I/O error");
    });

    const res = await run(db, directoryService.consumeClaim(claimToken, "org_none", "usr_none"));
    expect(Exit.isFailure(res)).toBe(true);
    if (!Exit.isFailure(res)) throw new Error("expected failure");
    expect(Option.isNone(Cause.findErrorOption(res.cause))).toBe(true);
    expect((await claimOf(db, claimToken))!.consumedAt).not.toBeNull();
  });

  it("the unique owner index refuses a second listing for one org and allows many unowned", () => {
    const db = db0();
    const row = (id: string, ownerOrgId: string | null) => ({
      id,
      ownerOrgId,
      name: id,
      listed: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    db.insert(directoryVendors)
      .values([row("dv_n1", null), row("dv_n2", null)])
      .run();
    db.insert(directoryVendors).values(row("dv_o1", "org_one")).run();
    expect(() => db.insert(directoryVendors).values(row("dv_o2", "org_one")).run()).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("a listing already pending fails ClaimInvalid and does not burn the token", async () => {
    const db = db0();
    const { claimToken: first, directoryVendorId } = await seedVendorAndClaim(db);
    const second = await mintToken(db, directoryVendorId);
    db.update(directoryVendors)
      .set({ reviewOrgId: "org_first", reviewProfileId: "usr_first" })
      .where(eq(directoryVendors.id, directoryVendorId))
      .run();

    const res = await run(db, directoryService.consumeClaim(second, "org_second", "usr_second"));
    expect(failedWith(res, ClaimInvalid)).toBe(true);
    expect((await claimOf(db, second))!.consumedAt).toBeNull();
    expect((await claimOf(db, first))!.consumedAt).toBeNull();
    expect(listingOf(db, directoryVendorId).reviewOrgId).toBe("org_first");
  });

  it("fails OrgAlreadyHasListing when the org has a claim pending on another listing", async () => {
    const db = db0();
    const pending = await seedVendorAndClaim(db);
    const ok = await run(db, directoryService.consumeClaim(pending.claimToken, "org_v", "usr_v"));
    expect(Exit.isSuccess(ok)).toBe(true);
    const other = await seedVendorAndClaim(db);

    const res = await run(db, directoryService.consumeClaim(other.claimToken, "org_v", "usr_v"));
    expect(failedWith(res, OrgAlreadyHasListing)).toBe(true);
    expect((await claimOf(db, other.claimToken))!.consumedAt).toBeNull();
  });

  it("the unique pending-org index refuses a second pending claim for one org", () => {
    const db = db0();
    const row = (id: string) => ({
      id,
      reviewOrgId: "org_one",
      name: id,
      listed: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    db.insert(directoryVendors).values(row("dv_p1")).run();
    expect(() => db.insert(directoryVendors).values(row("dv_p2")).run()).toThrow(
      /UNIQUE constraint failed/,
    );
  });
});

describe("a claim held for an operator", () => {
  async function held(db: ReturnType<typeof createDb>) {
    const vendorId = `ven_${crypto.randomUUID()}`;
    db.insert(vendors)
      .values({
        id: vendorId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        directoryVendorId: null,
        name: "Held Vendor",
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
    const seeded = await run(
      db,
      directoryService.seedFromCrm(BOOTSTRAP_WEDDING_ID, vendorId, {
        ...LISTING_BODY,
        name: "Held Listing",
        categories: ["music"],
      }),
    );
    if (!Exit.isSuccess(seeded)) throw new Error("seed failed");
    const spare = await mintToken(db, seeded.value.directoryVendorId);
    const ok = await run(
      db,
      directoryService.consumeClaim(seeded.value.claimToken, "org_held", "usr_held"),
    );
    if (!Exit.isSuccess(ok)) throw new Error("consume failed");
    return { dvId: seeded.value.directoryVendorId, spare };
  }

  it("shows to the claiming org as awaiting confirmation", async () => {
    const db = db0();
    const { dvId } = await held(db);
    const res = await run(db, directoryService.getListingByOrg("org_held"));
    if (!Exit.isSuccess(res)) throw new Error("read failed");
    expect(res.value?.id).toBe(dvId);
    expect(res.value?.awaitingConfirmation).toBe(true);
    expect(res.value?.listed).toBe("draft");
  });

  it("refuses the claiming org's save, which would put it live", async () => {
    const db = db0();
    const { dvId } = await held(db);
    const res = await run(db, directoryService.upsertListingForOrg("org_held", LISTING_BODY));
    expect(failedWith(res, ListingAwaitingConfirmation)).toBe(true);
    expect(listingOf(db, dvId).listed).toBe("draft");
    expect(db.select().from(directoryVendors).all()).toHaveLength(1);
  });

  it("is not claimable: no preview, no new claim CTA", async () => {
    const db = db0();
    const { dvId } = await held(db);
    // The spare token was burned by the consume; mint a fresh one directly.
    const fresh = await mintToken(db, dvId);
    const preview = await run(db, directoryService.getClaimPreview(fresh));
    expect(Exit.isSuccess(preview) && preview.value).toBeNull();

    const dv = listingOf(db, dvId);
    const issued = await run(db, directoryService.issueClaimForListing(dv));
    expect(Exit.isSuccess(issued) && issued.value).toBeNull();
  });

  it("stays out of browse and the live-listing read", async () => {
    const db = db0();
    const { dvId } = await held(db);
    const browse = await run(
      db,
      directoryService.browse(BOOTSTRAP_WEDDING_ID, { limit: 50, offset: 0 }),
    );
    if (!Exit.isSuccess(browse)) throw new Error("browse failed");
    expect(browse.value.listings.map((l) => l.id)).not.toContain(dvId);
    const live = await run(db, directoryService.getLiveListingById(dvId, BOOTSTRAP_WEDDING_ID));
    expect(Exit.isSuccess(live) && live.value).toBeNull();
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
    insertWedding(db, {
      id: "W1",
      slug: "wedding-w1",
      displayName: "Wedding W1",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_w1"],
    });
    insertWedding(db, {
      id: "W2",
      slug: "wedding-w2",
      displayName: "Wedding W2",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_w2"],
    });

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
    expect((await run(svc.getLiveListingById("LA", "W1")))!.categories.toSorted()).toEqual([
      "catering",
      "venue",
    ]);
    expect(await run(svc.getLiveListingById("LD", "W1"))).toBeNull(); // draft
    expect(await run(svc.getLiveListingById("nope", "W1"))).toBeNull();
  });

  it("getLiveListingById says whether THIS wedding's CRM already links the listing", async () => {
    // W1 links LA only; LB is live and linked nowhere; W2 links nothing.
    expect((await run(svc.getLiveListingById("LA", "W1")))!.inWedding).toBe(true);
    expect((await run(svc.getLiveListingById("LB", "W1")))!.inWedding).toBe(false);
    expect((await run(svc.getLiveListingById("LA", "W2")))!.inWedding).toBe(false);
  });

  it("getLiveListingById reads the listing, its categories and the wedding link in one statement, hit or miss", async () => {
    // A fresh database per id so each count covers that one call and nothing
    // the seed did. Missing and draft are the misses; LA is the hit.
    for (const id of ["LA", "nope", "LD"]) {
      const db = makeDb();
      const statements = recordStatements(db);
      await Effect.runPromise(
        svc.getLiveListingById(id, "W1").pipe(Effect.provideService(DbService, db)),
      );
      expect({ id, statements: statements.length }).toEqual({ id, statements: 1 });
    }
  });

  it("getLiveListingById returns a live listing with no categories, with an empty list", async () => {
    const db = makeDb();
    const now = new Date();
    db.insert(directoryVendors)
      .values({
        id: "LE",
        ownerOrgId: "org_le",
        name: "Empty Categories Co",
        description: "Listed before choosing a category",
        email: "hi@empty.example.com",
        phone: "0400 000 000",
        website: null,
        instagram: null,
        locationText: "Perth",
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const listing = await Effect.runPromise(
      svc.getLiveListingById("LE", "W1").pipe(Effect.provideService(DbService, db)),
    );

    // An inner join would drop the listing entirely and return null here.
    expect(listing).not.toBeNull();
    expect(listing!.id).toBe("LE");
    expect(listing!.name).toBe("Empty Categories Co");
    expect(listing!.email).toBe("hi@empty.example.com");
    expect(listing!.phone).toBe("0400 000 000");
    expect(listing!.listed).toBe("live");
    expect(listing!.categories).toEqual([]);
  });

  it("getLiveListingById returns every category once, with the listing fields intact", async () => {
    const db = makeDb();
    const listing = await Effect.runPromise(
      svc.getLiveListingById("LA", "W1").pipe(Effect.provideService(DbService, db)),
    );

    // One result row per category comes back from the join; the DTO must
    // still be one listing, not one per category.
    expect(listing!.id).toBe("LA");
    expect(listing!.name).toBe("Acorn Estate");
    expect(listing!.description).toBe("Beautiful garden venue for weddings");
    expect(listing!.locationText).toBe("Sydney");
    expect(typeof listing!.createdAt).toBe("number");
    expect(listing!.categories.toSorted()).toEqual(["catering", "venue"]);
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
