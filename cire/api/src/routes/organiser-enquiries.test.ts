import { beforeAll, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  directoryVendors,
  events,
  families,
  guests,
  vendorEnquiries,
  weddingHosts,
  weddings,
} from "@cire/db";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import type { ZapChatClient } from "../services/zap-bridge";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Owner of the seeded sample wedding (DEV_OWNER_PROFILE_ID).
const BOOTSTRAP_OWNER = "usr_dev_bootstrap_owner";
const OTHER_WEDDING_ID = "wed_other";
const OTHER_OWNER = "usr_bob";

// Directory listings seeded per app: one CLAIMED (chat provisions eagerly), one
// UNCLAIMED (first message buffers), plus a listing owned by the OTHER wedding's
// enquiry for the cross-tenant test.
const DV_CLAIMED = "dv_claimed";
const DV_UNCLAIMED = "dv_unclaimed";
const DV_OTHER = "dv_other";
const VENDOR_PROFILE = "usr_vendor_claimer";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/**
 * An in-memory fake ZapChatClient: provisions sequential chat ids, records sent
 * messages, and lists them back. Enough to exercise open/reply/getMessages.
 */
function makeFakeZap() {
  let chatSeq = 0;
  let msgSeq = 0;
  const messagesByChat = new Map<
    string,
    Array<{ id: string; senderProfileId: string; body: string; createdAt: number }>
  >();
  const client: ZapChatClient = {
    async provisionC2bChat() {
      const chatId = `chat_${++chatSeq}`;
      messagesByChat.set(chatId, []);
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
  return { client, messagesByChat };
}

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
  db.insert(events)
    .values({
      id: "evt_other",
      weddingId: OTHER_WEDDING_ID,
      slug: "other-party",
      name: "Other Party",
      description: "",
      startAt: "2027-01-01T16:00:00+10:00",
      endAt: "2027-01-01T22:00:00+10:00",
      timezone: "Australia/Sydney",
      sortOrder: 0,
    })
    .run();
  db.insert(families)
    .values({
      id: "fam_other",
      weddingId: OTHER_WEDDING_ID,
      publicId: "OTHER-ZZZ-0000",
      familyName: "Other",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(guests)
    .values({
      id: "gst_other",
      familyId: "fam_other",
      firstName: "Olive",
      lastName: "Other",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Seed the three directory listings used across the enquiry tests. */
function seedListings(db: Db) {
  const now = new Date();
  db.insert(directoryVendors)
    .values([
      {
        id: DV_CLAIMED,
        ownerOrgId: "org_photos",
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
        leadForwardEmail: "leads@vendor.test",
        claimedByProfileId: VENDOR_PROFILE,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: DV_UNCLAIMED,
        ownerOrgId: null,
        name: "Unclaimed Florals",
        description: null,
        email: "unclaimed@vendor.test",
        phone: null,
        website: null,
        instagram: null,
        locationText: null,
        priceBand: null,
        priceMinMinor: null,
        priceMaxMinor: null,
        listed: "live",
        leadForwardEmail: null,
        claimedByProfileId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: DV_OTHER,
        ownerOrgId: "org_other",
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
        claimedByProfileId: VENDOR_PROFILE,
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
    enquiryZapClient: zap,
    enquiryEmailLayer: email.layer,
    ...(opts.enquiryLimiter ? { enquiryLimiter: opts.enquiryLimiter } : {}),
  });
  return { db, app, email, fakeZap: fake };
}

async function req(
  app: ReturnType<typeof buildApp>["app"],
  path: string,
  init: RequestInit & { profileId?: string } = {},
) {
  const { profileId, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (profileId) headers.set("Authorization", `Bearer ${await auth.sign(profileId)}`);
  if (rest.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return appRequest(app, path, { ...rest, headers });
}

const enquiriesPath = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/enquiries`;

/** Open a claimed-vendor enquiry and return its id (helper for reply/budget tests). */
async function openClaimed(app: ReturnType<typeof buildApp>["app"]) {
  const res = await req(app, enquiriesPath, {
    method: "POST",
    profileId: BOOTSTRAP_OWNER,
    body: JSON.stringify({
      directoryVendorId: DV_CLAIMED,
      category: "photography",
      message: "Are you free on our date?",
    }),
  });
  const body = (await res.json()) as { enquiry: { id: string } };
  return { status: res.status, id: body.enquiry.id };
}

describe("GET /api/organiser/weddings/:weddingId/enquiries", () => {
  it("is 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, enquiriesPath);
    expect(res.status).toBe(401);
  });

  it("lists only this wedding's enquiries (cross-tenant hidden)", async () => {
    const { app, db } = buildApp();
    // Open one enquiry in the bootstrap wedding.
    const opened = await openClaimed(app);
    expect(opened.status).toBe(201);

    // Plant a foreign enquiry directly under the OTHER wedding — it must NOT
    // appear in the bootstrap owner's list.
    const now = new Date();
    db.insert(directoryVendors)
      .values({
        id: "dv_foreign",
        ownerOrgId: null,
        name: "Foreign Vendor",
        listed: "live",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Vendor CRM row for the foreign enquiry (FK target).
    db.run(
      `INSERT INTO vendors (id, wedding_id, directory_vendor_id, name, category, status, sort_order, created_at, updated_at)
       VALUES ('ven_foreign', '${OTHER_WEDDING_ID}', 'dv_foreign', 'Foreign', 'florals', 'researching', 0, ${now.getTime()}, ${now.getTime()})`,
    );
    db.insert(vendorEnquiries)
      .values({
        id: "enq_foreign",
        weddingId: OTHER_WEDDING_ID,
        directoryVendorId: "dv_foreign",
        vendorId: "ven_foreign",
        zapChatId: null,
        pendingBody: "hi",
        status: "open",
        createdBy: OTHER_OWNER,
        quotedMinor: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await req(app, enquiriesPath, { profileId: BOOTSTRAP_OWNER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enquiries: { id: string; weddingId: string }[] };
    expect(body.enquiries).toHaveLength(1);
    expect(body.enquiries[0]!.id).toBe(opened.id);
    expect(body.enquiries.every((e) => e.weddingId === BOOTSTRAP_WEDDING_ID)).toBe(true);
  });
});

describe("POST /api/organiser/weddings/:weddingId/enquiries", () => {
  it("is 403 read_only_role for a viewer co-host (weddingEditor gate)", async () => {
    const { app, db } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_enq_viewer",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_viewer_enq",
        addedByOsnProfileId: BOOTSTRAP_OWNER,
        role: "viewer",
        createdAt: new Date(),
      })
      .run();
    const res = await req(app, enquiriesPath, {
      method: "POST",
      profileId: "usr_viewer_enq",
      body: JSON.stringify({
        directoryVendorId: DV_CLAIMED,
        category: "photography",
        message: "hi",
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: "read_only_role" });
  });

  it("opens a thread and is idempotent on repeat (same id)", async () => {
    const { app } = buildApp();
    const first = await openClaimed(app);
    expect(first.status).toBe(201);
    expect(first.id).toMatch(/^enq_/);

    const second = await openClaimed(app);
    // Idempotent — same enquiry id, no second thread.
    expect(second.id).toBe(first.id);
  });

  it("returns 400 for a missing message", async () => {
    const { app } = buildApp();
    const res = await req(app, enquiriesPath, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({ directoryVendorId: DV_CLAIMED, category: "photography" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when the zap client is disabled and the listing is claimed", async () => {
    const { app } = buildApp({ zap: null });
    const res = await req(app, enquiriesPath, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({
        directoryVendorId: DV_CLAIMED,
        category: "photography",
        message: "hi",
      }),
    });
    expect(res.status).toBe(503);
  });
});

describe("enquiry-new email links (host/path correctness)", () => {
  // The default createApp origins apply here (buildApp injects no override):
  //   organiserOrigin = https://host.cireweddings.com  (thread deep-link)
  //   vendorPortalOrigin = https://vendor.cireweddings.com (claim CTA)
  const ORGANISER_ORIGIN = "https://host.cireweddings.com";
  const VENDOR_PORTAL_ORIGIN = "https://vendor.cireweddings.com";

  it("unclaimed listing: claim CTA is a consumable vendor-portal /claim?token= link", async () => {
    const { app, email } = buildApp();
    const res = await req(app, enquiriesPath, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({
        directoryVendorId: DV_UNCLAIMED,
        category: "florals",
        message: "hello unclaimed vendor",
      }),
    });
    expect(res.status).toBe(201);

    // The enquiry-new email to the unclaimed listing carries the claim CTA.
    const sent = email.recorded().find((e) => e.to === "unclaimed@vendor.test");
    expect(sent).toBeDefined();
    expect(sent!.template).toBe("enquiry-new");

    // CTA lives on the vendor portal origin and uses the canonical token flow —
    // consumable by POST /api/vendor/claims/:token/consume. Assert the exact
    // consumable shape and reject the old dead-link shape.
    const claimRe = new RegExp(
      `${VENDOR_PORTAL_ORIGIN.replace(/[.]/g, "\\.")}/claim\\?token=[A-Za-z0-9_-]+`,
    );
    expect(sent!.text).toMatch(claimRe);
    expect(sent!.html).toMatch(claimRe);
    // NOT the guest invite origin, and NOT the hand-rolled ?listing= URL.
    expect(sent!.text).not.toContain("?listing=");
    expect(sent!.text).not.toContain("/vendor/claim?listing=");
    expect(sent!.text).not.toContain("localhost:4321");
    expect(sent!.text).not.toContain("invite.cireweddings.com");
  });

  it("claimed listing: Reply link is a thread URL on the organiser origin", async () => {
    const { app, email } = buildApp();
    const opened = await openClaimed(app);
    expect(opened.status).toBe(201);

    const sent = email.recorded().find((e) => e.to === "claimed@vendor.test");
    expect(sent).toBeDefined();
    expect(sent!.template).toBe("enquiry-new");

    // The thread deep-link is an ORGANISER surface → host.cireweddings.com,
    // never the guest invite origin.
    const threadRe = new RegExp(
      `${ORGANISER_ORIGIN.replace(/[.]/g, "\\.")}/vendors/enquiries/${opened.id}`,
    );
    expect(sent!.text).toMatch(threadRe);
    expect(sent!.html).toMatch(threadRe);
    expect(sent!.text).not.toContain("localhost:4321");
    expect(sent!.text).not.toContain("invite.cireweddings.com");
  });
});

describe("POST /api/organiser/weddings/:weddingId/enquiries/:id/messages (reply)", () => {
  it("posts a reply into a provisioned thread → 201", async () => {
    const { app } = buildApp();
    const opened = await openClaimed(app);
    const res = await req(app, `${enquiriesPath}/${opened.id}/messages`, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({ message: "Following up!" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { body: string } };
    expect(body.message.body).toBe("Following up!");
  });

  it("returns 409 awaiting_vendor on an unprovisioned (unclaimed) enquiry", async () => {
    const { app } = buildApp();
    // Open against the UNCLAIMED listing — buffers, no zapChatId.
    const opened = await req(app, enquiriesPath, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({
        directoryVendorId: DV_UNCLAIMED,
        category: "florals",
        message: "buffered first message",
      }),
    });
    expect(opened.status).toBe(201);
    const id = ((await opened.json()) as { enquiry: { id: string } }).enquiry.id;

    const res = await req(app, `${enquiriesPath}/${id}/messages`, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({ message: "any second reply" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "awaiting_vendor" });
  });
});

describe("GET /api/organiser/weddings/:weddingId/enquiries/:id/messages", () => {
  it("returns the buffered pending message for an unprovisioned enquiry", async () => {
    const { app } = buildApp();
    const opened = await req(app, enquiriesPath, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({
        directoryVendorId: DV_UNCLAIMED,
        category: "florals",
        message: "the buffered body",
      }),
    });
    const id = ((await opened.json()) as { enquiry: { id: string } }).enquiry.id;
    const res = await req(app, `${enquiriesPath}/${id}/messages`, { profileId: BOOTSTRAP_OWNER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { body: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.body).toBe("the buffered body");
  });

  it("returns 404 for another wedding's enquiry (cross-tenant)", async () => {
    const { app, db } = buildApp();
    // Plant an enquiry under the OTHER wedding.
    const now = new Date();
    db.run(
      `INSERT INTO vendors (id, wedding_id, directory_vendor_id, name, category, status, sort_order, created_at, updated_at)
       VALUES ('ven_x', '${OTHER_WEDDING_ID}', '${DV_OTHER}', 'Other', 'photography', 'researching', 0, ${now.getTime()}, ${now.getTime()})`,
    );
    db.insert(vendorEnquiries)
      .values({
        id: "enq_x",
        weddingId: OTHER_WEDDING_ID,
        directoryVendorId: DV_OTHER,
        vendorId: "ven_x",
        zapChatId: "chat_x",
        pendingBody: null,
        status: "open",
        createdBy: OTHER_OWNER,
        quotedMinor: null,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // The bootstrap owner asks for it through THEIR wedding's route → 404.
    const res = await req(app, `${enquiriesPath}/enq_x/messages`, { profileId: BOOTSTRAP_OWNER });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/organiser/weddings/:weddingId/enquiries/:id/add-to-budget", () => {
  it("creates a budget item from the quote → 201", async () => {
    const { app, db } = buildApp();
    const opened = await openClaimed(app);
    // Attach a quote to the enquiry so add-to-budget has an amount to carry.
    db.update(vendorEnquiries)
      .set({ quotedMinor: 250_000, status: "quoted" })
      .where(eq(vendorEnquiries.id, opened.id))
      .run();

    const res = await req(app, `${enquiriesPath}/${opened.id}/add-to-budget`, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { budgetItemId: string };
    expect(body.budgetItemId).toMatch(/^bit_/);
  });

  it("returns 404 for another wedding's enquiry (cross-tenant)", async () => {
    const { app, db } = buildApp();
    const now = new Date();
    db.run(
      `INSERT INTO vendors (id, wedding_id, directory_vendor_id, name, category, status, sort_order, created_at, updated_at)
       VALUES ('ven_y', '${OTHER_WEDDING_ID}', '${DV_OTHER}', 'Other', 'photography', 'researching', 0, ${now.getTime()}, ${now.getTime()})`,
    );
    db.insert(vendorEnquiries)
      .values({
        id: "enq_y",
        weddingId: OTHER_WEDDING_ID,
        directoryVendorId: DV_OTHER,
        vendorId: "ven_y",
        zapChatId: "chat_y",
        pendingBody: null,
        status: "quoted",
        createdBy: OTHER_OWNER,
        quotedMinor: 100_000,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const res = await req(app, `${enquiriesPath}/enq_y/add-to-budget`, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST enquiries is rate-limited per user", () => {
  it("429s once the per-user open limit is exceeded (limiter maxRequests=1)", async () => {
    const { app } = buildApp({
      enquiryLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const first = await req(app, enquiriesPath, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({
        directoryVendorId: DV_CLAIMED,
        category: "photography",
        message: "one",
      }),
    });
    expect(first.status).toBe(201);
    const second = await req(app, enquiriesPath, {
      method: "POST",
      profileId: BOOTSTRAP_OWNER,
      body: JSON.stringify({
        directoryVendorId: DV_UNCLAIMED,
        category: "florals",
        message: "two",
      }),
    });
    expect(second.status).toBe(429);
  });
});
