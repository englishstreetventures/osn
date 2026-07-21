import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  directoryVendors,
  vendorEnquiries,
  vendors,
  weddings,
} from "@cire/db";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import type { OsnOrgMembershipResolver, OsnProfileOrgsResolver } from "../services/osn-bridge";
import type { ZapChatClient } from "../services/zap-bridge";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// ── Constants ─────────────────────────────────────────────────────────────────

/** The vendor operator — member of ORG_OK (owns DV_CLAIMED). */
const VENDOR = "usr_vendor";

/** The org that owns DV_CLAIMED (the vendor's claimed listing). */
const ORG_OK = "org_ok";
/** The org that owns DV_OTHER (a different tenant). */
const ORG_X = "org_x";

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

/**
 * Stub `profileOrgs(profileId)` — the caller's org ids, used to SCOPE the list
 * query before the scan:
 *   - VENDOR → [ORG_OK]   (member of the org that owns DV_CLAIMED)
 *   - anyone else → []    (fail-closed: empty list, no cross-tenant scan)
 */
const stubProfileOrgs: OsnProfileOrgsResolver = async (profileId) => {
  if (profileId === VENDOR) return [ORG_OK];
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
  db.insert(weddings)
    .values({
      id: OTHER_WEDDING_ID,
      slug: "other-wedding",
      displayName: "Other Wedding",
      ownerOsnProfileId: OTHER_OWNER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
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
  } = {},
) {
  const now = new Date();
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
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { directoryVendorId, weddingId, vendorId, enquiryId };
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
    const body = (await res.json()) as { enquiries: { id: string; directoryVendorId: string }[] };
    // VENDOR's profileOrgs is [ORG_OK]; the query is scoped to ORG_OK's listings,
    // so only the ORG_OK enquiry surfaces — the ORG_X row is never read.
    expect(body.enquiries).toHaveLength(1);
    expect(body.enquiries[0]!.id).toBe(mine.enquiryId);
    expect(body.enquiries.every((e) => e.directoryVendorId === DV_CLAIMED)).toBe(true);
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
    const body = (await res.json()) as { enquiries: unknown[] };
    expect(body.enquiries).toHaveLength(0);
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
    db.insert(weddings)
      .values({
        id: usdWeddingId,
        slug: "usd-wedding",
        displayName: "USD Wedding",
        ownerOsnProfileId: COUPLE,
        currency: "USD",
        createdAt: now,
        updatedAt: now,
      })
      .run();
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

describe("claim-flush wiring (POST /api/vendor/claims/:token/consume)", () => {
  it("flushes buffered enquiries: provisions chat + sends pending body", async () => {
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
    const { createDirectoryService } = await import("../services/directory");
    const { Effect } = await import("effect");
    const { DbService } = await import("../db");
    const svc = createDirectoryService();
    const claim = await Effect.runPromise(
      svc.issueClaimForListing(dvId).pipe(Effect.provideService(DbService, db)),
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

    // VENDOR consumes the claim into ORG_OK.
    const res = await req(app, "POST", `/api/vendor/claims/${claim!.claimToken}/consume`, VENDOR, {
      orgId: ORG_OK,
    });
    expect(res.status).toBe(200);

    // The listing now records the claiming profile (central fix).
    const dvRow = db.select().from(directoryVendors).where(eq(directoryVendors.id, dvId)).get();
    expect(dvRow!.claimedByProfileId).toBe(VENDOR);
    expect(dvRow!.ownerOrgId).toBe(ORG_OK);

    // The buffered enquiry was flushed: chat provisioned + pending body cleared.
    const enqRow = db.select().from(vendorEnquiries).where(eq(vendorEnquiries.id, enquiryId)).get();
    expect(enqRow!.zapChatId).not.toBeNull();
    expect(enqRow!.pendingBody).toBeNull();

    // The fake zap recorded the provision (couple + vendor) and the pending send.
    expect(fakeZap.provisions.length).toBeGreaterThanOrEqual(1);
    const sent = fakeZap.messagesByChat.get(enqRow!.zapChatId!) ?? [];
    expect(sent.map((m) => m.body)).toContain("please quote our spring wedding");
  });
});
