import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, directoryVendors, vendorEnquiries, vendors } from "@cire/db";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import type { Db } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { ENQUIRY_PAGE_MAX } from "../../src/lib/enquiry-page";
import type {
  OsnOrgMembershipResolver,
  OsnProfileOrgsResolver,
} from "../../src/services/osn-bridge";
import type { ZapChatClient } from "../../src/services/zap-bridge";
import { appRequest, boundParameterCount, jsonBody, recordStatements } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

// ── Constants ─────────────────────────────────────────────────────────────────

/** The vendor operator — member of ORG_OK (owns DV_CLAIMED). */
const VENDOR = "usr_vendor";

/** The org that owns DV_CLAIMED (the vendor's claimed listing). */
const ORG_OK = "org_ok";
/** The org that owns DV_OTHER (a different tenant). */
const ORG_X = "org_x";

/** A vendor operator in ORG_OK and 99 other orgs — osn's page-size ceiling. */
const VENDOR_MANY = "usr_vendor_many";

const DV_CLAIMED = "dv_claimed";
const DV_OTHER = "dv_other";

const COUPLE = "usr_couple";
const OTHER_OWNER = "usr_bob";
const OTHER_WEDDING_ID = "wed_other";

/**
 * Stub `orgMembership(orgId, profileId)`:
 *   - (ORG_OK, VENDOR) → "admin"
 *   - everything else  → null
 */
const stubOrgMembership: OsnOrgMembershipResolver = async (orgId, profileId) => {
  if (orgId === ORG_OK && profileId === VENDOR) return "admin";
  return null;
};

/** Minimal org summary in the shape osn-api's internal profile-orgs route returns. */
function orgSummary(id: string, handle: string, name: string) {
  return {
    id,
    handle,
    name,
    description: null,
    avatarUrl: null,
    ownerId: VENDOR,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Stub `profileOrgs(profileId)` — the caller's orgs, used to SCOPE the list
 * query before the scan:
 *   - VENDOR → [ORG_OK]   (member of the org that owns DV_CLAIMED)
 *   - anyone else → []    (fail-closed: empty list, no cross-tenant scan)
 */
const stubProfileOrgs: OsnProfileOrgsResolver = async (profileId) => {
  if (profileId === VENDOR) return [orgSummary(ORG_OK, "ok-events", "OK Events")];
  if (profileId === VENDOR_MANY) {
    return [
      orgSummary(ORG_OK, "ok-events", "OK Events"),
      ...Array.from({ length: 99 }, (_, i) =>
        orgSummary(`org_filler_${i}`, `filler-${i}`, "Filler"),
      ),
    ];
  }
  return [];
};

// ── Auth ──────────────────────────────────────────────────────────────────────

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

// ── Fake Zap ──────────────────────────────────────────────────────────────────

function makeFakeZap() {
  let chatSeq = 0;
  let msgSeq = 0;
  const provisions: Array<{ memberProfileIds: string[]; createdByProfileId: string }> = [];
  const messagesByChat = new Map<
    string,
    Array<{ id: string; senderProfileId: string; body: string; createdAt: number }>
  >();
  const client: ZapChatClient = {
    async provisionC2bChat(input) {
      const chatId = `chat_${++chatSeq}`;
      messagesByChat.set(chatId, []);
      provisions.push({
        memberProfileIds: input.memberProfileIds,
        createdByProfileId: input.createdByProfileId,
      });
      return { chatId };
    },
    async sendC2bMessage(chatId, input) {
      const messageId = `msg_${++msgSeq}`;
      const createdAt = Date.now();
      const arr = messagesByChat.get(chatId) ?? [];
      arr.push({
        id: messageId,
        senderProfileId: input.senderProfileId,
        body: input.body,
        createdAt,
      });
      messagesByChat.set(chatId, arr);
      return { messageId, createdAt };
    },
    async listC2bMessages(chatId) {
      return { messages: messagesByChat.get(chatId) ?? [] };
    },
  };
  return { client, provisions, messagesByChat };
}

// ── Seeding ───────────────────────────────────────────────────────────────────

function seedOtherWedding(db: Db) {
  const now = new Date();
  insertWedding(db, {
    id: OTHER_WEDDING_ID,
    slug: "other-wedding",
    displayName: "Other Wedding",
    createdAt: now,
    updatedAt: now,
    owners: [OTHER_OWNER],
  });
}

/** Two listings: DV_CLAIMED (ORG_OK, claimed by VENDOR), DV_OTHER (ORG_X). */
function seedListings(db: Db) {
  const now = new Date();
  db.insert(directoryVendors)
    .values([
      {
        id: DV_CLAIMED,
        ownerOrgId: ORG_OK,
        name: "Claimed Photography",
        description: null,
        email: "claimed@vendor.test",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        leadForwardEmail: null,
        claimedByProfileId: VENDOR,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: DV_OTHER,
        ownerOrgId: ORG_X,
        name: "Other Vendor",
        description: null,
        email: "other@vendor.test",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        leadForwardEmail: null,
        claimedByProfileId: "usr_other_vendor",
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
}

interface BuildOpts {
  zap?: ZapChatClient | null;
  enquiryLimiter?: ReturnType<typeof createRateLimiter>;
}

function buildApp(opts: BuildOpts = {}) {
  const db = createDb(":memory:");
  seedDb(db);
  seedOtherWedding(db);
  seedListings(db);
  const email = makeLogEmailLive();
  const fake = makeFakeZap();
  const zap = opts.zap === undefined ? fake.client : opts.zap;
  const app = createApp(db, {
    osnTestKey: auth.key,
    orgMembership: stubOrgMembership,
    profileOrgs: stubProfileOrgs,
    enquiryZapClient: zap,
    enquiryEmailLayer: email.layer,
    ...(opts.enquiryLimiter ? { enquiryLimiter: opts.enquiryLimiter } : {}),
  });
  return { db, app, email, fakeZap: fake };
}

async function req(
  app: ReturnType<typeof buildApp>["app"],
  method: string,
  path: string,
  profileId?: string,
  body?: unknown,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Seed a provisioned enquiry directly: a CLAIMED-listing thread (DV_CLAIMED) for
 * the bootstrap wedding with a live zap chat + CRM vendor row. Returns the ids.
 */
function seedProvisionedEnquiry(
  db: Db,
  opts: {
    directoryVendorId?: string;
    weddingId?: string;
    vendorId?: string;
    enquiryId?: string;
    lastMessageAt?: Date;
  } = {},
) {
  const now = new Date();
  const lastMessageAt = opts.lastMessageAt ?? now;
  const directoryVendorId = opts.directoryVendorId ?? DV_CLAIMED;
  const weddingId = opts.weddingId ?? BOOTSTRAP_WEDDING_ID;
  const vendorId = opts.vendorId ?? `ven_${crypto.randomUUID()}`;
  const enquiryId = opts.enquiryId ?? `enq_${crypto.randomUUID()}`;
  db.insert(vendors)
    .values({
      id: vendorId,
      weddingId,
      directoryVendorId,
      name: "CRM Vendor",
      category: "photography",
      status: "researching",
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
  db.insert(vendorEnquiries)
    .values({
      id: enquiryId,
      weddingId,
      directoryVendorId,
      vendorId,
      zapChatId: "chat_seeded",
      pendingBody: null,
      status: "open",
      createdBy: COUPLE,
      quotedMinor: null,
      lastMessageAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { directoryVendorId, weddingId, vendorId, enquiryId };
}

/**
 * `count` weddings, each with one enquiry to DV_CLAIMED a second apart.
 * Returns the enquiry ids oldest first.
 */
function seedManyWeddingsEnquiring(db: Db, count: number): string[] {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const weddingId = `wed_many_${n}`;
    insertWedding(db, { id: weddingId, slug: `many-${n}`, displayName: `Couple ${n}` });
    const { enquiryId } = seedProvisionedEnquiry(db, {
      directoryVendorId: DV_CLAIMED,
      weddingId,
      enquiryId: `enq_many_${String(n).padStart(3, "0")}`,
      lastMessageAt: new Date((1_780_000_000 + n) * 1000),
    });
    ids.push(enquiryId);
  }
  return ids;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/vendor/enquiries", () => {
  it("is 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", "/api/vendor/enquiries");
    expect(res.status).toBe(401);
  });

  it("lists only enquiries on the caller's own org's listings (scoped, not full scan)", async () => {
    const { app, db } = buildApp();
    // Mine (DV_CLAIMED / ORG_OK) + a foreign one (DV_OTHER / ORG_X).
    const mine = seedProvisionedEnquiry(db, { directoryVendorId: DV_CLAIMED });
    seedProvisionedEnquiry(db, {
      directoryVendorId: DV_OTHER,
      weddingId: OTHER_WEDDING_ID,
      enquiryId: "enq_foreign",
    });

    const res = await req(app, "GET", "/api/vendor/enquiries", VENDOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enquiries: { id: string; directoryVendorId: string; weddingName: string }[];
    };
    // VENDOR's profileOrgs is [ORG_OK]; the query is scoped to ORG_OK's listings,
    // so only the ORG_OK enquiry surfaces — the ORG_X row is never read.
    expect(body.enquiries).toHaveLength(1);
    expect(body.enquiries[0]!.id).toBe(mine.enquiryId);
    expect(body.enquiries.every((e) => e.directoryVendorId === DV_CLAIMED)).toBe(true);
    // The enquiring wedding's display name must be present on every item.
    const item = body.enquiries[0] as {
      id: string;
      directoryVendorId: string;
      weddingName: string;
    };
    expect(typeof item.weddingName).toBe("string");
    expect(item.weddingName.length).toBeGreaterThan(0);
  });

  it("orders the inbox newest-first by lastMessageAt (SQL ORDER BY, not insert order)", async () => {
    const { app, db } = buildApp();
    // Insert the OLDER thread FIRST so rowid order and timestamp order diverge —
    // the only thing that can produce newest-first is the query's ORDER BY
    // (the JS sort it replaced is gone).
    seedProvisionedEnquiry(db, {
      directoryVendorId: DV_CLAIMED,
      enquiryId: "enq_older",
      lastMessageAt: new Date("2026-07-01T00:00:00Z"),
    });
    seedProvisionedEnquiry(db, {
      directoryVendorId: DV_CLAIMED,
      weddingId: OTHER_WEDDING_ID,
      enquiryId: "enq_newer",
      lastMessageAt: new Date("2026-07-20T00:00:00Z"),
    });

    const res = await req(app, "GET", "/api/vendor/enquiries", VENDOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enquiries: { id: string }[] };
    expect(body.enquiries.map((e) => e.id)).toEqual(["enq_newer", "enq_older"]);
  });

  it("binds the caller's org ids as one parameter, however many orgs they are in", async () => {
    // osn answers up to 100 orgs a profile, and D1 refuses a statement over 100
    // parameters — the org ids alone would fill it.
    const { app, db } = buildApp();
    const mine = seedProvisionedEnquiry(db, { directoryVendorId: DV_CLAIMED });

    const statements = recordStatements(db);
    const res = await req(app, "GET", "/api/vendor/enquiries", VENDOR_MANY);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { enquiries: { id: string }[] };
    expect(body.enquiries.map((e) => e.id)).toEqual([mine.enquiryId]);
    const reads = statements.filter((s) =>
      s.sql.includes('"directory_vendors"."owner_org_id" in ('),
    );
    expect(reads).toHaveLength(1);
    expect(boundParameterCount(reads[0]!.sql)).toBe(1);
  });

  it("never answers more than a page, however large the limit asked for", async () => {
    const { app, db } = buildApp();
    seedManyWeddingsEnquiring(db, ENQUIRY_PAGE_MAX + 1);

    const res = await req(app, "GET", "/api/vendor/enquiries?limit=999", VENDOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enquiries: { id: string }[]; nextCursor: string | null };
    expect(body.enquiries).toHaveLength(ENQUIRY_PAGE_MAX);
    expect(body.nextCursor).not.toBeNull();
  });

  it("pages by nextCursor through the caller's enquiries only, each once, newest first", async () => {
    const { app, db } = buildApp();
    const mine = seedManyWeddingsEnquiring(db, 5);
    // Another tenant's enquiries, newer than all of mine, from the same weddings.
    for (let n = 0; n < 5; n++) {
      seedProvisionedEnquiry(db, {
        directoryVendorId: DV_OTHER,
        weddingId: `wed_many_${n}`,
        enquiryId: `enq_foreign_${n}`,
        lastMessageAt: new Date((1_790_000_000 + n) * 1000),
      });
    }

    const seen: string[] = [];
    let path = "/api/vendor/enquiries?limit=2";
    for (let pages = 1; ; pages++) {
      // Sequential by nature: each page's cursor comes from the one before.
      // eslint-disable-next-line no-await-in-loop
      const res = await req(app, "GET", path, VENDOR);
      expect(res.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await res.json()) as { enquiries: { id: string }[]; nextCursor: string | null };
      expect(body.enquiries.length).toBeLessThanOrEqual(2);
      seen.push(...body.enquiries.map((e) => e.id));
      if (body.nextCursor === null) break;
      expect(pages).toBeLessThan(5);
      path = `/api/vendor/enquiries?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    expect(seen).toEqual(mine.toReversed());
  });

  it("refuses a cursor it did not write with 400 invalid_cursor", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", "/api/vendor/enquiries?cursor=page-two", VENDOR);
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "invalid_cursor" });
  });

  it("fails closed to an empty list when the caller resolves to no orgs", async () => {
    const { app, db } = buildApp();
    // Seed enquiries in BOTH orgs — none belong to a caller with no memberships.
    seedProvisionedEnquiry(db, { directoryVendorId: DV_CLAIMED });
    seedProvisionedEnquiry(db, {
      directoryVendorId: DV_OTHER,
      weddingId: OTHER_WEDDING_ID,
      enquiryId: "enq_foreign",
    });

    // OTHER_OWNER is authenticated but stubProfileOrgs returns [] → empty list,
    // never an unscoped cross-tenant scan.
    const res = await req(app, "GET", "/api/vendor/enquiries", OTHER_OWNER);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ enquiries: [], nextCursor: null });
  });
});

describe("GET /api/vendor/enquiries/:id/messages", () => {
  it("returns 404 for an enquiry outside the caller's org (cross-tenant)", async () => {
    const { app, db } = buildApp();
    const foreign = seedProvisionedEnquiry(db, {
      directoryVendorId: DV_OTHER,
      weddingId: OTHER_WEDDING_ID,
      enquiryId: "enq_foreign",
    });
    // VENDOR is a member of ORG_OK, not ORG_X → must not learn the row exists.
    const res = await req(
      app,
      "GET",
      `/api/vendor/enquiries/${foreign.enquiryId}/messages`,
      VENDOR,
    );
    expect(res.status).toBe(404);
  });

  it("returns the thread for the caller's own enquiry", async () => {
    const { app, db, fakeZap } = buildApp();
    const mine = seedProvisionedEnquiry(db);
    // Prime a message on the seeded chat.
    await fakeZap.client.sendC2bMessage("chat_seeded", {
      senderProfileId: COUPLE,
      body: "hi vendor",
    });
    const res = await req(app, "GET", `/api/vendor/enquiries/${mine.enquiryId}/messages`, VENDOR);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { body: string }[] };
    expect(body.messages.map((m) => m.body)).toContain("hi vendor");
  });
});

describe("POST /api/vendor/enquiries/:id/quote", () => {
  it("sets vendors.quoted_minor + enquiry.quoted_minor + status quoted → 201", async () => {
    const { app, db } = buildApp();
    const mine = seedProvisionedEnquiry(db);

    const res = await req(app, "POST", `/api/vendor/enquiries/${mine.enquiryId}/quote`, VENDOR, {
      amountMinor: 250_000,
      note: "Full-day coverage",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { enquiry: { quotedMinor: number; status: string } };
    expect(body.enquiry.quotedMinor).toBe(250_000);
    expect(body.enquiry.status).toBe("quoted");

    const enqRow = db
      .select()
      .from(vendorEnquiries)
      .where(eq(vendorEnquiries.id, mine.enquiryId))
      .get();
    expect(enqRow!.quotedMinor).toBe(250_000);
    expect(enqRow!.status).toBe("quoted");

    const venRow = db.select().from(vendors).where(eq(vendors.id, mine.vendorId)).get();
    expect(venRow!.quotedMinor).toBe(250_000);
  });

  it("is 404 for a cross-tenant enquiry", async () => {
    const { app, db } = buildApp();
    const foreign = seedProvisionedEnquiry(db, {
      directoryVendorId: DV_OTHER,
      weddingId: OTHER_WEDDING_ID,
      enquiryId: "enq_foreign",
    });
    const res = await req(app, "POST", `/api/vendor/enquiries/${foreign.enquiryId}/quote`, VENDOR, {
      amountMinor: 100,
    });
    expect(res.status).toBe(404);
  });

  it("formats the quote in the wedding's own currency (USD, not hardcoded AUD)", async () => {
    const { app, db, fakeZap } = buildApp();
    // A wedding that thinks in USD, plus a claimed-listing enquiry under it.
    const now = new Date();
    const usdWeddingId = "wed_usd";
    insertWedding(db, {
      id: usdWeddingId,
      slug: "usd-wedding",
      displayName: "USD Wedding",
      currency: "USD",
      createdAt: now,
      updatedAt: now,
      owners: [COUPLE],
    });
    const mine = seedProvisionedEnquiry(db, {
      weddingId: usdWeddingId,
      enquiryId: "enq_usd",
    });

    const res = await req(app, "POST", `/api/vendor/enquiries/${mine.enquiryId}/quote`, VENDOR, {
      amountMinor: 250_000,
    });
    expect(res.status).toBe(201);

    // The quote message forwarded into the zap chat carries the USD-formatted
    // amount ($2,500.00), never the AUD glyph (A$).
    const chatMessages = fakeZap.messagesByChat.get("chat_seeded") ?? [];
    const quoteMsg = chatMessages.find((m) => m.body.startsWith("Quote:"));
    expect(quoteMsg).toBeDefined();
    expect(quoteMsg!.body).toContain("$2,500.00");
    expect(quoteMsg!.body).not.toContain("A$");
  });
});

describe("POST /api/vendor/enquiries/:id/messages (reply)", () => {
  it("appends a reply → 201", async () => {
    const { app, db } = buildApp();
    const mine = seedProvisionedEnquiry(db);
    const res = await req(app, "POST", `/api/vendor/enquiries/${mine.enquiryId}/messages`, VENDOR, {
      message: "Thanks for reaching out!",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { body: string } };
    expect(body.message.body).toBe("Thanks for reaching out!");
  });

  it("is 429 once the per-user write limit is exceeded", async () => {
    const { app, db } = buildApp({
      enquiryLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const mine = seedProvisionedEnquiry(db);
    const first = await req(
      app,
      "POST",
      `/api/vendor/enquiries/${mine.enquiryId}/messages`,
      VENDOR,
      {
        message: "one",
      },
    );
    expect(first.status).toBe(201);
    const second = await req(
      app,
      "POST",
      `/api/vendor/enquiries/${mine.enquiryId}/messages`,
      VENDOR,
      { message: "two" },
    );
    expect(second.status).toBe(429);
  });
});

describe("claim hold and hand-off (POST /api/vendor/claims/:token/consume)", () => {
  it("holds the claim with enquiries buffered, then hands them over once an operator confirms", async () => {
    const { app, db, fakeZap } = buildApp();
    // Seed an UNCLAIMED listing with a live claim token, plus a buffered enquiry.
    const now = new Date();
    const dvId = "dv_to_claim";
    db.insert(directoryVendors)
      .values({
        id: dvId,
        ownerOrgId: null,
        name: "To Claim Florals",
        description: null,
        email: "toclaim@vendor.test",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "draft",
        leadForwardEmail: null,
        claimedByProfileId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Mint a real claim token via the directory service so consume can burn it.
    const { createDirectoryService } = await import("../../src/services/directory");
    const { Effect } = await import("effect");
    const { DbService } = await import("../../src/db");
    const svc = createDirectoryService();
    const claim = await Effect.runPromise(
      svc
        .issueClaimForListing({
          id: dvId,
          ownerOrgId: null,
          reviewOrgId: null,
          email: "toclaim@vendor.test",
          name: "To Claim Florals",
          phone: null,
          claimedByProfileId: null,
          leadForwardEmail: null,
        })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(claim).not.toBeNull();

    // Buffered enquiry: open, no zapChatId, pendingBody set.
    const vendorId = "ven_buffered";
    const enquiryId = "enq_buffered";
    db.insert(vendors)
      .values({
        id: vendorId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        directoryVendorId: dvId,
        name: "CRM Florals",
        category: "florals",
        status: "researching",
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
    db.insert(vendorEnquiries)
      .values({
        id: enquiryId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        directoryVendorId: dvId,
        vendorId,
        zapChatId: null,
        pendingBody: "please quote our spring wedding",
        status: "open",
        createdBy: COUPLE,
        quotedMinor: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // ORG_OK already owns DV_CLAIMED, and an org owns at most one listing: the
    // claim is refused with 409 and the token is left live.
    const refused = await req(
      app,
      "POST",
      `/api/vendor/claims/${claim!.claimToken}/consume`,
      VENDOR,
      { orgId: ORG_OK },
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()) as unknown).toEqual({ error: "org_has_listing" });
    expect(
      db.select().from(directoryVendors).where(eq(directoryVendors.id, dvId)).get()!.ownerOrgId,
    ).toBeNull();

    // Free ORG_OK, then the same token claims the listing.
    db.update(directoryVendors)
      .set({ ownerOrgId: null })
      .where(eq(directoryVendors.ownerOrgId, ORG_OK))
      .run();
    const res = await req(app, "POST", `/api/vendor/claims/${claim!.claimToken}/consume`, VENDOR, {
      orgId: ORG_OK,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listing: { awaitingConfirmation: boolean } };
    expect(body.listing.awaitingConfirmation).toBe(true);

    // Held: the listing is not bound to the claimant, and nothing is handed over.
    const held = db.select().from(directoryVendors).where(eq(directoryVendors.id, dvId)).get();
    expect(held!.claimedByProfileId).toBeNull();
    expect(held!.ownerOrgId).toBeNull();
    expect(held!.reviewOrgId).toBe(ORG_OK);
    expect(held!.reviewProfileId).toBe(VENDOR);
    const buffered = db
      .select()
      .from(vendorEnquiries)
      .where(eq(vendorEnquiries.id, enquiryId))
      .get();
    expect(buffered!.zapChatId).toBeNull();
    expect(buffered!.pendingBody).toBe("please quote our spring wedding");
    expect(fakeZap.provisions).toHaveLength(0);

    // The claimant cannot reach the buffered enquiry yet.
    const list = await req(app, "GET", "/api/vendor/enquiries", VENDOR);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { enquiries: { id: string }[] };
    expect(Array.isArray(listed.enquiries)).toBe(true);
    expect(listed.enquiries.map((e) => e.id)).not.toContain(enquiryId);
    const thread = await req(app, "GET", `/api/vendor/enquiries/${enquiryId}`, VENDOR);
    expect(thread.status).toBe(404);

    // The operator confirms (the same UPDATE the review script sends), and the
    // daily sweep hands the buffered enquiry over.
    db.$client.exec(
      `UPDATE directory_vendors SET owner_org_id = review_org_id, claimed_by_profile_id = review_profile_id, listed = 'live', review_org_id = NULL, review_profile_id = NULL, review_requested_at = NULL, updated_at = unixepoch() WHERE id = '${dvId}'`,
    );
    const { claimReviewService } = await import("../../src/services/claim-review");
    const swept = await Effect.runPromise(
      claimReviewService.sweep(fakeZap.client).pipe(Effect.provideService(DbService, db)),
    );
    expect(swept.handedOff).toBe(1);

    const enqRow = db.select().from(vendorEnquiries).where(eq(vendorEnquiries.id, enquiryId)).get();
    expect(enqRow!.zapChatId).not.toBeNull();
    expect(enqRow!.pendingBody).toBeNull();

    // The fake zap recorded the provision (couple + vendor) and the pending send.
    expect(fakeZap.provisions.length).toBeGreaterThanOrEqual(1);
    const sent = fakeZap.messagesByChat.get(enqRow!.zapChatId!) ?? [];
    expect(sent.map((m) => m.body)).toContain("please quote our spring wedding");
  });
});
