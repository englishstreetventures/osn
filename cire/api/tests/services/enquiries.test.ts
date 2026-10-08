import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  budgetItems,
  directoryVendors,
  vendorEnquiries,
  vendors,
  weddings,
} from "@cire/db";
import type { SendEmailInput } from "@shared/email";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import {
  decodeEnquiryCursor,
  type EnquiryCursor,
  type EnquiryPageRequest,
} from "../../src/lib/enquiry-page";
import type { DirectoryVendorRow } from "../../src/services/directory";
import {
  createEnquiryService,
  EnquiryAwaitingVendor,
  type EnquiryRow,
  flushBufferedEnquiry,
  listingEnquiriesQuery,
  weddingEnquiriesQuery,
  ZapUnavailable,
} from "../../src/services/enquiries";
import { type ZapChatClient, ZapChatRejected } from "../../src/services/zap-bridge";
import { recordStatements } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

// ---------------------------------------------------------------------------
// Fixtures — a claimed + an unclaimed directory listing under the seed wedding.
// ---------------------------------------------------------------------------

const CLAIMED_VENDOR_ID = "dv_claimed";
const UNCLAIMED_VENDOR_ID = "dv_unclaimed";
const VENDOR_PROFILE_ID = "usr_vendor";
const ORGANISER_PROFILE_ID = "usr_organiser";

function db0(): TestDb {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(directoryVendors)
    .values({
      id: CLAIMED_VENDOR_ID,
      name: "Bloom & Co",
      email: "claimed@vendor.test",
      phone: "0400000001",
      claimedByProfileId: VENDOR_PROFILE_ID,
      leadForwardEmail: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(directoryVendors)
    .values({
      id: UNCLAIMED_VENDOR_ID,
      name: "Wildflower Studio",
      email: "unclaimed@vendor.test",
      phone: "0400000002",
      claimedByProfileId: null,
      leadForwardEmail: "leads@wildflower.test",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

const run = <A, E>(db: TestDb, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provideService(DbService, db)));

// ---------------------------------------------------------------------------
// Fake injected deps.
// ---------------------------------------------------------------------------

interface ProvisionCall {
  memberProfileIds: string[];
  createdByProfileId: string;
  title?: string;
}
interface SendCall {
  chatId: string;
  senderProfileId: string;
  body: string;
}

function fakeZap() {
  const provisionCalls: ProvisionCall[] = [];
  const sendCalls: SendCall[] = [];
  const listCalls: Array<{ chatId: string; opts?: { limit?: number; before?: number } }> = [];
  let chatSeq = 0;
  let msgSeq = 0;
  const listed: Record<
    string,
    Array<{ id: string; senderProfileId: string; body: string; createdAt: number }>
  > = {};
  const client: ZapChatClient = {
    async provisionC2bChat(input) {
      provisionCalls.push(input);
      chatSeq += 1;
      return { chatId: `chat_${chatSeq}` };
    },
    async sendC2bMessage(chatId, input) {
      sendCalls.push({ chatId, senderProfileId: input.senderProfileId, body: input.body });
      msgSeq += 1;
      const createdAt = 1_700_000_000_000 + msgSeq;
      (listed[chatId] ??= []).push({
        id: `msg_${msgSeq}`,
        senderProfileId: input.senderProfileId,
        body: input.body,
        createdAt,
      });
      return { messageId: `msg_${msgSeq}`, createdAt };
    },
    async listC2bMessages(chatId, opts) {
      listCalls.push({ chatId, ...(opts ? { opts } : {}) });
      return { messages: listed[chatId] ?? [] };
    },
  };
  return { client, provisionCalls, sendCalls, listCalls };
}

function fakeEmail() {
  const sent: SendEmailInput[] = [];
  const sendEmail = (msg: SendEmailInput): Effect.Effect<void, never, never> => {
    sent.push(msg);
    return Effect.void;
  };
  return { sendEmail, sent };
}

const THREAD_BASE = "https://host.cireweddings.test/enquiries";

// Mirrors the two directory_vendors rows db0() seeds, keyed by id, so
// openInput()'s default `listing` always matches whichever directoryVendorId
// is in effect (default or overridden) rather than going stale.
const LISTING_BY_VENDOR_ID: Record<string, DirectoryVendorRow> = {
  [CLAIMED_VENDOR_ID]: {
    id: CLAIMED_VENDOR_ID,
    ownerOrgId: null,
    reviewOrgId: null,
    email: "claimed@vendor.test",
    name: "Bloom & Co",
    phone: "0400000001",
    claimedByProfileId: VENDOR_PROFILE_ID,
    leadForwardEmail: null,
  },
  [UNCLAIMED_VENDOR_ID]: {
    id: UNCLAIMED_VENDOR_ID,
    ownerOrgId: null,
    reviewOrgId: null,
    email: "unclaimed@vendor.test",
    name: "Wildflower Studio",
    phone: "0400000002",
    claimedByProfileId: null,
    leadForwardEmail: "leads@wildflower.test",
  },
};

const openInput = (
  over: Partial<Parameters<ReturnType<typeof createEnquiryService>["open"]>[0]> = {},
) => {
  const directoryVendorId = over.directoryVendorId ?? CLAIMED_VENDOR_ID;
  return {
    weddingId: BOOTSTRAP_WEDDING_ID,
    weddingName: "Alex & Sam",
    directoryVendorId,
    category: "florist",
    message: "Are you free on our date?",
    createdBy: ORGANISER_PROFILE_ID,
    listing: LISTING_BY_VENDOR_ID[directoryVendorId] ?? null,
    claimUrl: "https://claim.test/abc",
    ...over,
  };
};

// Read an enquiry row straight from the DB, cast to EnquiryRow for reuse.
function readEnquiry(db: TestDb, id: string): EnquiryRow {
  const row = db.select().from(vendorEnquiries).where(eq(vendorEnquiries.id, id)).get();
  if (!row) throw new Error(`enquiry ${id} not found`);
  return row as unknown as EnquiryRow;
}

// ---------------------------------------------------------------------------
// Inbox paging fixtures
// ---------------------------------------------------------------------------

const FIRST_PAGE: EnquiryPageRequest = { limit: 50, after: null };

/** Epoch second `s` as the Date a timestamp column takes. */
const at = (s: number) => new Date(s * 1000);

/** A list-only service: the inbox reads touch neither zap nor email. */
const inboxService = () =>
  createEnquiryService({ zap: null, sendEmail: fakeEmail().sendEmail, threadBaseUrl: THREAD_BASE });

/** One enquiry in the seed wedding, against its own made-up listing. */
function seedCoupleEnquiry(db: TestDb, id: string, lastMessageAt: Date): void {
  const now = new Date();
  const vendorId = `ven_${id}`;
  db.insert(vendors)
    .values({
      id: vendorId,
      weddingId: BOOTSTRAP_WEDDING_ID,
      directoryVendorId: `dv_${id}`,
      name: `Vendor ${id}`,
      category: "florist",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(vendorEnquiries)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      directoryVendorId: `dv_${id}`,
      vendorId,
      status: "open",
      createdBy: ORGANISER_PROFILE_ID,
      lastMessageAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** A bare database for the vendor inbox: no seed wedding, so every row is the test's own. */
function inboxDb(): TestDb {
  return createDb(":memory:");
}

function seedListing(db: TestDb, id: string, ownerOrgId: string): void {
  const now = new Date();
  db.insert(directoryVendors)
    .values({ id, ownerOrgId, name: `Listing ${id}`, createdAt: now, updatedAt: now })
    .run();
}

/** An enquiry from wedding `wedding` (created on first use) to listing `listing`. */
function seedVendorEnquiry(
  db: TestDb,
  e: { id: string; listing: string; wedding: string; s: number },
): void {
  const now = new Date();
  if (!db.select().from(weddings).where(eq(weddings.id, e.wedding)).get()) {
    insertWedding(db, { id: e.wedding, slug: e.wedding, displayName: `Wedding ${e.wedding}` });
  }
  const vendorId = `ven_${e.id}`;
  db.insert(vendors)
    .values({
      id: vendorId,
      weddingId: e.wedding,
      directoryVendorId: e.listing,
      name: `CRM ${e.wedding}`,
      category: "photography",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(vendorEnquiries)
    .values({
      id: e.id,
      weddingId: e.wedding,
      directoryVendorId: e.listing,
      vendorId,
      status: "open",
      createdBy: ORGANISER_PROFILE_ID,
      lastMessageAt: at(e.s),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

async function inbox(db: TestDb, orgIds: string[], page: EnquiryPageRequest) {
  const res = await run(db, inboxService().vendorInbox(orgIds, page));
  if (!Exit.isSuccess(res)) throw new Error("vendorInbox failed");
  return res.value;
}

/** Follow `nextCursor` from page one to the end, collecting ids in order. */
async function walk(
  read: (
    after: EnquiryCursor | null,
  ) => Promise<{ enquiries: { id: string }[]; nextCursor: string | null }>,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let after: EnquiryCursor | null = null;
  let pages = 0;
  for (;;) {
    // Sequential by nature: each page's cursor comes from the one before.
    // eslint-disable-next-line no-await-in-loop
    const page = await read(after);
    pages++;
    ids.push(...page.enquiries.map((e) => e.id));
    if (page.nextCursor === null) return { ids, pages };
    after = decodeEnquiryCursor(page.nextCursor);
    if (after === null) throw new Error(`unreadable cursor ${page.nextCursor}`);
    if (pages > 50) throw new Error("walk did not end");
  }
}

/** The plan SQLite chooses for a Drizzle query, one detail line per step. */
function planOf(db: TestDb, query: { toSQL(): { sql: string; params: unknown[] } }): string {
  const { sql, params } = query.toSQL();
  return (
    db.$client.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
      detail: string;
    }>
  )
    .map((r) => r.detail)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enquiryService.open", () => {
  it("on a CLAIMED listing provisions a chat, sends the first message, emails the vendor", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });

    const res = await run(db, svc.open(openInput()));
    if (!Exit.isSuccess(res)) throw new Error("open failed");

    // Chat provisioned with [createdBy, claimedByProfileId].
    expect(zap.provisionCalls).toHaveLength(1);
    expect(zap.provisionCalls[0]!.memberProfileIds).toEqual([
      ORGANISER_PROFILE_ID,
      VENDOR_PROFILE_ID,
    ]);
    expect(zap.provisionCalls[0]!.createdByProfileId).toBe(ORGANISER_PROFILE_ID);
    // First message sent.
    expect(zap.sendCalls).toHaveLength(1);
    expect(zap.sendCalls[0]!.body).toBe("Are you free on our date?");

    // Enquiry row: zapChatId set, pendingBody null, status 'open'.
    const enq = readEnquiry(db, res.value.id);
    expect(enq.zapChatId).toBe("chat_1");
    expect(enq.pendingBody).toBeNull();
    expect(enq.status).toBe("open");

    // A CRM vendors row was created with directoryVendorId set.
    const ven = db
      .select()
      .from(vendors)
      .where(eq(vendors.directoryVendorId, CLAIMED_VENDOR_ID))
      .get();
    expect(ven).toBeTruthy();
    expect(ven!.directoryVendorId).toBe(CLAIMED_VENDOR_ID);
    expect(enq.vendorId).toBe(ven!.id);

    // Email: enquiry-new, unclaimed:false.
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.template).toBe("enquiry-new");
    expect(email.sent[0]!.to).toBe("claimed@vendor.test");
    const data = email.sent[0]!.data as { unclaimed: boolean };
    expect(data.unclaimed).toBe(false);
  });

  it("on an UNCLAIMED listing buffers pendingBody, leaves zapChatId null, emails with claim CTA", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });

    const res = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(res)) throw new Error("open failed");

    // No provision on an unclaimed listing.
    expect(zap.provisionCalls).toHaveLength(0);
    expect(zap.sendCalls).toHaveLength(0);

    const enq = readEnquiry(db, res.value.id);
    expect(enq.zapChatId).toBeNull();
    expect(enq.pendingBody).toBe("Are you free on our date?");

    // enquiry-new with unclaimed:true + a claimUrl, plus a copy to leadForwardEmail.
    const news = email.sent.filter((m) => m.template === "enquiry-new");
    expect(news.length).toBeGreaterThanOrEqual(1);
    const primary = news.find((m) => m.to === "unclaimed@vendor.test")!;
    expect(primary).toBeTruthy();
    const data = primary.data as { unclaimed: boolean; claimUrl?: string };
    expect(data.unclaimed).toBe(true);
    expect(data.claimUrl).toBe("https://claim.test/abc");
    // A separate copy to the lead-forward address.
    expect(email.sent.some((m) => m.to === "leads@wildflower.test")).toBe(true);
  });

  it("on a CLAIMED listing with zap null fails ZapUnavailable and writes no enquiry/vendor row", async () => {
    const db = db0();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: null,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });

    const res = await run(db, svc.open(openInput({ directoryVendorId: CLAIMED_VENDOR_ID })));

    // Fails ZapUnavailable — the message must not strand (a claimed listing gets
    // no future buffered-enquiry flush), so the route surfaces 503 to retry.
    expect(Exit.isFailure(res)).toBe(true);
    if (Exit.isFailure(res)) {
      expect(
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof ZapUnavailable,
      ).toBe(true);
    }

    // No orphaned rows: the failure happens BEFORE the enquiry INSERT, and no
    // vendors CRM row is left behind for the claimed listing either.
    expect(db.select().from(vendorEnquiries).all()).toHaveLength(0);
    expect(
      db.select().from(vendors).where(eq(vendors.directoryVendorId, CLAIMED_VENDOR_ID)).all(),
    ).toHaveLength(0);
    // No email went out.
    expect(email.sent).toHaveLength(0);
  });

  it("is idempotent on (weddingId, directoryVendorId) — repeat reuses the thread, no second provision/email", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });

    const first = await run(db, svc.open(openInput()));
    const second = await run(db, svc.open(openInput({ message: "second attempt" })));
    if (!Exit.isSuccess(first) || !Exit.isSuccess(second)) throw new Error("open failed");

    expect(second.value.id).toBe(first.value.id);
    // No re-provision, no second email.
    expect(zap.provisionCalls).toHaveLength(1);
    expect(email.sent.filter((m) => m.template === "enquiry-new")).toHaveLength(1);
    // Only one enquiry + one vendor row.
    expect(db.select().from(vendorEnquiries).all()).toHaveLength(1);
    expect(
      db.select().from(vendors).where(eq(vendors.directoryVendorId, CLAIMED_VENDOR_ID)).all(),
    ).toHaveLength(1);
  });
});

describe("enquiryService.reply", () => {
  it("on an unprovisioned enquiry fails EnquiryAwaitingVendor", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const enq = readEnquiry(db, opened.value.id);

    const res = await run(
      db,
      svc.reply({
        enquiry: enq,
        senderProfileId: ORGANISER_PROFILE_ID,
        senderName: "Alex",
        recipientEmail: "unclaimed@vendor.test",
        recipientName: "Wildflower Studio",
        message: "ping",
      }),
    );
    expect(Exit.isFailure(res)).toBe(true);
    if (Exit.isFailure(res)) {
      expect(
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof EnquiryAwaitingVendor,
      ).toBe(true);
    }
  });

  it("on a provisioned enquiry sends to zap + emails the other party", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput()));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const enq = readEnquiry(db, opened.value.id);

    const before = zap.sendCalls.length;
    const emailBefore = email.sent.length;
    const res = await run(
      db,
      svc.reply({
        enquiry: enq,
        senderProfileId: VENDOR_PROFILE_ID,
        senderName: "Bloom & Co",
        recipientEmail: "couple@wedding.test",
        recipientName: "Alex",
        message: "Yes we are free!",
      }),
    );
    if (!Exit.isSuccess(res)) throw new Error("reply failed");

    expect(zap.sendCalls.length).toBe(before + 1);
    expect(zap.sendCalls.at(-1)!.body).toBe("Yes we are free!");
    expect(res.value.body).toBe("Yes we are free!");

    const replyEmails = email.sent.slice(emailBefore).filter((m) => m.template === "enquiry-reply");
    expect(replyEmails).toHaveLength(1);
    expect(replyEmails[0]!.to).toBe("couple@wedding.test");
  });
});

describe("enquiryService.getMessages", () => {
  it("returns the synthesized pending message when unprovisioned", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const enq = readEnquiry(db, opened.value.id);

    const res = await run(db, svc.getMessages(enq));
    if (!Exit.isSuccess(res)) throw new Error("getMessages failed");
    expect(res.value).toHaveLength(1);
    expect(res.value[0]!.id).toBe("pending");
    expect(res.value[0]!.body).toBe("Are you free on our date?");
    expect(res.value[0]!.senderProfileId).toBe(ORGANISER_PROFILE_ID);
  });

  it("returns the zap messages when provisioned", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput()));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const enq = readEnquiry(db, opened.value.id);

    const res = await run(db, svc.getMessages(enq));
    if (!Exit.isSuccess(res)) throw new Error("getMessages failed");
    expect(res.value).toHaveLength(1);
    expect(res.value[0]!.body).toBe("Are you free on our date?");
    expect(res.value[0]!.id).not.toBe("pending");

    // The fetch is capped (limit 50) to stay under the Workers 6MB wall.
    const listCall = zap.listCalls.find((c) => c.chatId === enq.zapChatId);
    expect(listCall).toBeDefined();
    expect(listCall!.opts?.limit).toBe(50);
  });
});

describe("enquiryService.quote", () => {
  it("sets vendor_enquiries.quotedMinor AND vendors.quotedMinor, status 'quoted', emails couple", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput()));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const enq = readEnquiry(db, opened.value.id);

    const res = await run(
      db,
      svc.quote({
        enquiry: enq,
        senderProfileId: VENDOR_PROFILE_ID,
        amountMinor: 250000,
        note: "Includes setup",
        coupleEmail: "couple@wedding.test",
        vendorName: "Bloom & Co",
        currency: "AUD",
      }),
    );
    if (!Exit.isSuccess(res)) throw new Error("quote failed");

    const updated = readEnquiry(db, enq.id);
    expect(updated.quotedMinor).toBe(250000);
    expect(updated.status).toBe("quoted");

    const ven = db.select().from(vendors).where(eq(vendors.id, enq.vendorId)).get();
    expect(ven!.quotedMinor).toBe(250000);

    // A quote message went to zap, carrying the formatted amount + note.
    expect(
      zap.sendCalls.some((c) => c.body.includes("2,500") && c.body.includes("Includes setup")),
    ).toBe(true);

    const quoteEmails = email.sent.filter((m) => m.template === "enquiry-quote");
    expect(quoteEmails).toHaveLength(1);
    expect(quoteEmails[0]!.to).toBe("couple@wedding.test");
    const data = quoteEmails[0]!.data as { amountFormatted: string };
    expect(data.amountFormatted).toContain("2,500");
  });

  it("fails EnquiryAwaitingVendor when the enquiry is unprovisioned", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const enq = readEnquiry(db, opened.value.id);

    const res = await run(
      db,
      svc.quote({
        enquiry: enq,
        senderProfileId: VENDOR_PROFILE_ID,
        amountMinor: 100,
        coupleEmail: "couple@wedding.test",
        vendorName: "Wildflower Studio",
        currency: "AUD",
      }),
    );
    expect(Exit.isFailure(res)).toBe(true);
    if (Exit.isFailure(res)) {
      expect(
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof EnquiryAwaitingVendor,
      ).toBe(true);
    }
  });
});

describe("enquiryService.addToBudget", () => {
  it("inserts a budget_items row with quotedMinor from the enquiry", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput()));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    await run(
      db,
      svc.quote({
        enquiry: readEnquiry(db, opened.value.id),
        senderProfileId: VENDOR_PROFILE_ID,
        amountMinor: 250000,
        coupleEmail: "couple@wedding.test",
        vendorName: "Bloom & Co",
        currency: "AUD",
      }),
    );
    const enq = readEnquiry(db, opened.value.id);

    const res = await run(
      db,
      svc.addToBudget({ enquiry: enq, vendorName: "Bloom & Co", category: "florals" }),
    );
    if (!Exit.isSuccess(res)) throw new Error("addToBudget failed");

    const item = db
      .select()
      .from(budgetItems)
      .where(eq(budgetItems.id, res.value.budgetItemId))
      .get();
    expect(item).toBeTruthy();
    expect(item!.name).toBe("Bloom & Co");
    expect(item!.category).toBe("florals");
    expect(item!.quotedMinor).toBe(250000);
    expect(item!.estimateMinor).toBeNull();
  });
});

describe("flushBufferedEnquiry", () => {
  it("provisions a chat, sends the buffered body and nulls pendingBody", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    // Buffer an enquiry against the unclaimed listing.
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const before = readEnquiry(db, opened.value.id);
    expect(before.zapChatId).toBeNull();
    expect(before.pendingBody).toBe("Are you free on our date?");

    const res = await run(db, flushBufferedEnquiry(zap.client, before, VENDOR_PROFILE_ID));
    expect(Exit.isSuccess(res) && res.value).toBe(true);

    const after = readEnquiry(db, opened.value.id);
    expect(after.zapChatId).toBe("chat_1");
    expect(after.pendingBody).toBeNull();

    // Provisioned with [createdBy, vendorProfileId] and flushed the buffered body.
    expect(zap.provisionCalls).toHaveLength(1);
    expect(zap.provisionCalls[0]!.memberProfileIds).toEqual([
      ORGANISER_PROFILE_ID,
      VENDOR_PROFILE_ID,
    ]);
    expect(zap.sendCalls).toHaveLength(1);
    expect(zap.sendCalls[0]!.body).toBe("Are you free on our date?");
  });

  it("leaves the enquiry buffered when the send fails, so a later run retries it", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const failing: ZapChatClient = {
      ...zap.client,
      sendC2bMessage: async () => {
        throw new Error("zap down");
      },
    };

    const res = await run(
      db,
      flushBufferedEnquiry(failing, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID),
    );
    expect(Exit.isSuccess(res) && res.value).toBe(false);
    const after = readEnquiry(db, opened.value.id);
    expect(after.zapChatId).toBeNull();
    expect(after.pendingBody).toBe("Are you free on our date?");
  });

  it("leaves the enquiry buffered when provisioning fails", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const failing: ZapChatClient = {
      ...zap.client,
      provisionC2bChat: async () => {
        throw new Error("zap down");
      },
    };
    const res = await run(
      db,
      flushBufferedEnquiry(failing, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID),
    );
    expect(Exit.isSuccess(res) && res.value).toBe(false);
    expect(readEnquiry(db, opened.value.id).pendingBody).toBe("Are you free on our date?");
    expect(zap.sendCalls).toHaveLength(0);
  });

  it("does not provision for an enquiry with nothing buffered", async () => {
    const db = db0();
    const zap = fakeZap();
    const res = await run(
      db,
      flushBufferedEnquiry(
        zap.client,
        { id: "enq_x", createdBy: "usr_x", pendingBody: null, handoffChatId: null },
        VENDOR_PROFILE_ID,
      ),
    );
    expect(Exit.isSuccess(res) && res.value).toBe(false);
    expect(zap.provisionCalls).toHaveLength(0);
  });

  it("does nothing for an enquiry already handed over", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const stale = readEnquiry(db, opened.value.id);
    await run(db, flushBufferedEnquiry(zap.client, stale, VENDOR_PROFILE_ID));

    // A second runner holding the stale row provisions, but cannot overwrite.
    const second = await run(db, flushBufferedEnquiry(zap.client, stale, VENDOR_PROFILE_ID));
    expect(Exit.isSuccess(second) && second.value).toBe(false);
    const after = readEnquiry(db, opened.value.id);
    expect(after.zapChatId).toBe("chat_1");
    expect(after.handoffChatId).toBeNull();
  });

  it("keeps the chat of a failed send for the retry, with no visible thread", async () => {
    const db = db0();
    const zap = fakeZap();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: fakeEmail().sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    const failing: ZapChatClient = {
      ...zap.client,
      sendC2bMessage: async () => {
        throw new Error("zap down");
      },
    };
    await run(
      db,
      flushBufferedEnquiry(failing, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID),
    );
    const staged = readEnquiry(db, opened.value.id);
    expect(staged.handoffChatId).toBe("chat_1");
    expect(staged.zapChatId).toBeNull();

    // The retry sends into the staged chat and provisions nothing.
    const res = await run(db, flushBufferedEnquiry(zap.client, staged, VENDOR_PROFILE_ID));
    expect(Exit.isSuccess(res) && res.value).toBe(true);
    expect(zap.provisionCalls).toHaveLength(1);
    expect(zap.sendCalls.map((c) => c.chatId)).toEqual(["chat_1"]);
    const after = readEnquiry(db, opened.value.id);
    expect(after.zapChatId).toBe("chat_1");
    expect(after.handoffChatId).toBeNull();
    expect(after.pendingBody).toBeNull();
  });

  it("drops a reused chat zap refuses for good, so the next attempt provisions afresh", async () => {
    const db = db0();
    const zap = fakeZap();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: fakeEmail().sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    db.update(vendorEnquiries)
      .set({ handoffChatId: "chat_gone" })
      .where(eq(vendorEnquiries.id, opened.value.id))
      .run();
    const lost: ZapChatClient = {
      ...zap.client,
      listC2bMessages: async () => {
        throw new ZapChatRejected(404, "zap-api GET returned 404");
      },
    };

    await run(db, flushBufferedEnquiry(lost, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID));
    expect(readEnquiry(db, opened.value.id).handoffChatId).toBeNull();

    const res = await run(
      db,
      flushBufferedEnquiry(zap.client, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID),
    );
    expect(Exit.isSuccess(res) && res.value).toBe(true);
    expect(readEnquiry(db, opened.value.id).zapChatId).toBe("chat_1");
  });

  it("keeps a reused chat through a transient failure", async () => {
    const db = db0();
    const zap = fakeZap();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: fakeEmail().sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    db.update(vendorEnquiries)
      .set({ handoffChatId: "chat_kept" })
      .where(eq(vendorEnquiries.id, opened.value.id))
      .run();
    const flaky: ZapChatClient = {
      ...zap.client,
      listC2bMessages: async () => {
        throw new Error("zap-api GET returned 503");
      },
    };
    await run(db, flushBufferedEnquiry(flaky, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID));
    expect(readEnquiry(db, opened.value.id).handoffChatId).toBe("chat_kept");
  });

  it("does not re-send when a delivered send is followed by a failure", async () => {
    const db = db0();
    const zap = fakeZap();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: fakeEmail().sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    // The send lands in zap, then the attempt fails before recording it.
    const landsThenFails: ZapChatClient = {
      ...zap.client,
      sendC2bMessage: async (chatId, input) => {
        await zap.client.sendC2bMessage(chatId, input);
        throw new Error("connection reset");
      },
    };
    await run(
      db,
      flushBufferedEnquiry(landsThenFails, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID),
    );
    expect(readEnquiry(db, opened.value.id).handoffChatId).toBe("chat_1");

    const res = await run(
      db,
      flushBufferedEnquiry(zap.client, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID),
    );
    expect(Exit.isSuccess(res) && res.value).toBe(true);
    expect(zap.sendCalls).toHaveLength(1);
    expect(zap.provisionCalls).toHaveLength(1);
    expect(readEnquiry(db, opened.value.id).zapChatId).toBe("chat_1");
  });

  it("does not send twice when an earlier run sent but failed to record it", async () => {
    const db = db0();
    const zap = fakeZap();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: fakeEmail().sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");
    // The chat was staged and the body landed in it, but the final write never ran.
    await zap.client.sendC2bMessage("chat_staged", {
      senderProfileId: ORGANISER_PROFILE_ID,
      body: "Are you free on our date?",
    });
    db.update(vendorEnquiries)
      .set({ handoffChatId: "chat_staged" })
      .where(eq(vendorEnquiries.id, opened.value.id))
      .run();

    const res = await run(
      db,
      flushBufferedEnquiry(zap.client, readEnquiry(db, opened.value.id), VENDOR_PROFILE_ID),
    );
    expect(Exit.isSuccess(res) && res.value).toBe(true);
    expect(zap.sendCalls).toHaveLength(1);
    expect(zap.provisionCalls).toHaveLength(0);
    expect(readEnquiry(db, opened.value.id).zapChatId).toBe("chat_staged");
  });
});

describe("enquiryService.list", () => {
  it("returns the couple inbox newest-first by lastMessageAt (SQL ORDER BY)", async () => {
    const db = db0();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: null,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });

    // Two threads in the SAME wedding against different listings, inserted
    // OLDER-FIRST so rowid order and timestamp order diverge — only the
    // query's ORDER BY (which replaced the JS sort) yields newest-first.
    const now = new Date();
    const seed = (n: number, dvId: string, lastMessageAt: Date) => {
      const vid = `ven_list_${n}`;
      db.insert(vendors)
        .values({
          id: vid,
          weddingId: BOOTSTRAP_WEDDING_ID,
          directoryVendorId: dvId,
          name: `Vendor ${n}`,
          category: "florist",
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
          id: `enq_list_${n}`,
          weddingId: BOOTSTRAP_WEDDING_ID,
          directoryVendorId: dvId,
          vendorId: vid,
          zapChatId: null,
          pendingBody: "buffered",
          status: "open",
          createdBy: ORGANISER_PROFILE_ID,
          quotedMinor: null,
          lastMessageAt,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    };
    seed(1, CLAIMED_VENDOR_ID, new Date("2026-07-01T00:00:00Z"));
    seed(2, UNCLAIMED_VENDOR_ID, new Date("2026-07-20T00:00:00Z"));

    const res = await run(db, svc.list(BOOTSTRAP_WEDDING_ID, FIRST_PAGE));
    if (!Exit.isSuccess(res)) throw new Error("list failed");
    expect(res.value.enquiries.map((e) => e.id)).toEqual(["enq_list_2", "enq_list_1"]);
    // The join columns ride along.
    expect(res.value.enquiries[0]!.vendorName).toBe("Vendor 2");
    expect(res.value.nextCursor).toBeNull();
  });

  it("never returns more than the page it was asked for, and says where the next one starts", async () => {
    const db = db0();
    for (let n = 0; n < 5; n++) seedCoupleEnquiry(db, `enq_cap_${n}`, at(100 + n));

    const res = await run(db, inboxService().list(BOOTSTRAP_WEDDING_ID, { limit: 2, after: null }));
    if (!Exit.isSuccess(res)) throw new Error("list failed");
    expect(res.value.enquiries.map((e) => e.id)).toEqual(["enq_cap_4", "enq_cap_3"]);
    expect(res.value.nextCursor).toBe(`${100 + 3}.enq_cap_3`);
  });

  it("walks every enquiry exactly once when a page boundary falls inside one second", async () => {
    const db = db0();
    // Four enquiries share second 200, so a page of two splits them; `id`
    // decides their order and where page two picks up.
    const expected = [
      ["enq_t_z", 300],
      ["enq_t_d", 200],
      ["enq_t_c", 200],
      ["enq_t_b", 200],
      ["enq_t_a", 200],
      ["enq_t_y", 100],
      ["enq_t_x", 50],
    ] as const;
    // Inserted in an order that matches neither rowid nor the answer.
    for (const [id, s] of expected.toReversed()) seedCoupleEnquiry(db, id, at(s));

    const seen = await walk(async (after) => {
      const res = await run(db, inboxService().list(BOOTSTRAP_WEDDING_ID, { limit: 2, after }));
      if (!Exit.isSuccess(res)) throw new Error("list failed");
      return res.value;
    });
    expect(seen.pages).toBe(4);
    expect(seen.ids).toEqual(expected.map(([id]) => id));
  });

  it("ends on an exact multiple of the page size without a phantom empty page", async () => {
    const db = db0();
    for (let n = 0; n < 4; n++) seedCoupleEnquiry(db, `enq_ex_${n}`, at(100 + n));

    const seen = await walk(async (after) => {
      const res = await run(db, inboxService().list(BOOTSTRAP_WEDDING_ID, { limit: 2, after }));
      if (!Exit.isSuccess(res)) throw new Error("list failed");
      return res.value;
    });
    expect(seen.pages).toBe(2);
    expect(seen.ids).toHaveLength(4);
  });

  it("reads one statement through the keyset index, with no sort", () => {
    const db = db0();
    for (const after of [null, { lastMessageAt: 100, id: "enq_x" }]) {
      const plan = planOf(
        db,
        weddingEnquiriesQuery(db, BOOTSTRAP_WEDDING_ID, { limit: 50, after }),
      );
      expect(plan).toMatch(
        after
          ? /SEARCH vendor_enquiries USING INDEX vendor_enquiries_wedding_last_msg_idx \(wedding_id=\? AND \(last_message_at,id\)<\(\?,\?\)\)/
          : /SEARCH vendor_enquiries USING INDEX vendor_enquiries_wedding_last_msg_idx \(wedding_id=\?\)/,
      );
      expect(plan).not.toContain("TEMP B-TREE");
    }
  });
});

describe("enquiryService.vendorInbox", () => {
  it("lists only the enquiries on listings the caller's organisations own", async () => {
    const db = inboxDb();
    seedListing(db, "dv_mine", "org_mine");
    seedListing(db, "dv_theirs", "org_theirs");
    seedVendorEnquiry(db, { id: "enq_mine", listing: "dv_mine", wedding: "wed_a", s: 100 });
    seedVendorEnquiry(db, { id: "enq_theirs", listing: "dv_theirs", wedding: "wed_a", s: 200 });

    const page = await inbox(db, ["org_mine", "org_none"], FIRST_PAGE);
    expect(page.enquiries.map((e) => e.id)).toEqual(["enq_mine"]);
    expect(page.enquiries[0]).toMatchObject({
      directoryVendorId: "dv_mine",
      weddingName: "Wedding wed_a",
      vendorName: "CRM wed_a",
      category: "photography",
      lastMessageAt: at(100).getTime(),
    });
    expect(page.nextCursor).toBeNull();
  });

  it("answers an empty page from one statement when the organisations own no listing", async () => {
    const db = inboxDb();
    seedListing(db, "dv_theirs", "org_theirs");
    seedVendorEnquiry(db, { id: "enq_theirs", listing: "dv_theirs", wedding: "wed_a", s: 200 });

    const statements = recordStatements(db);
    const page = await inbox(db, ["org_mine"], FIRST_PAGE);
    expect(page).toEqual({ enquiries: [], nextCursor: null });
    expect(statements).toHaveLength(1);
  });

  it("walks one listing's inbox exactly once across a boundary inside one second", async () => {
    const db = inboxDb();
    seedListing(db, "dv_mine", "org_mine");
    const expected = [
      ["enq_v_9", 500],
      ["enq_v_4", 400],
      ["enq_v_3", 400],
      ["enq_v_2", 400],
      ["enq_v_1", 300],
    ] as const;
    for (const [id, s] of expected.toReversed()) {
      seedVendorEnquiry(db, { id, listing: "dv_mine", wedding: `wed_${id}`, s });
    }

    const seen = await walk((after) => inbox(db, ["org_mine"], { limit: 2, after }));
    expect(seen.ids).toEqual(expected.map(([id]) => id));
    expect(seen.pages).toBe(3);
  });

  it("merges several listings into one newest-first inbox, page by page", async () => {
    const db = inboxDb();
    seedListing(db, "dv_one", "org_one");
    seedListing(db, "dv_two", "org_two");
    // Interleaved in time across the two listings, with a tie between them.
    const rows = [
      ["enq_1a", "dv_one", 100],
      ["enq_2a", "dv_two", 150],
      ["enq_1b", "dv_one", 200],
      ["enq_2b", "dv_two", 200],
      ["enq_2c", "dv_two", 250],
      ["enq_1c", "dv_one", 300],
    ] as const;
    for (const [id, listing, s] of rows) {
      seedVendorEnquiry(db, { id, listing, wedding: `wed_${id}`, s });
    }

    const seen = await walk((after) => inbox(db, ["org_one", "org_two"], { limit: 2, after }));
    expect(seen.ids).toEqual(["enq_1c", "enq_2c", "enq_2b", "enq_1b", "enq_2a", "enq_1a"]);
  });

  it("reads at most five listings per statement and at most a page and one from each", async () => {
    const db = inboxDb();
    const orgs: string[] = [];
    for (let n = 0; n < 6; n++) {
      seedListing(db, `dv_${n}`, `org_${n}`);
      orgs.push(`org_${n}`);
      // Three enquiries on each listing, so each could answer more than a page of one.
      for (let k = 0; k < 3; k++) {
        seedVendorEnquiry(db, {
          id: `enq_${n}_${k}`,
          listing: `dv_${n}`,
          wedding: `wed_${n}_${k}`,
          s: 1000 + n * 10 + k,
        });
      }
    }

    const statements = recordStatements(db);
    const page = await inbox(db, orgs, { limit: 1, after: null });
    expect(page.enquiries.map((e) => e.id)).toEqual(["enq_5_2"]);
    expect(page.nextCursor).toBe("1052.enq_5_2");

    // The listing lookup, then two reads: five arms and one.
    const reads = statements.filter((s) => s.sql.includes('"vendor_enquiries"'));
    expect(statements).toHaveLength(3);
    expect(reads.map((s) => s.sql.split(" union all ").length).toSorted()).toEqual([1, 5]);
    // Each arm stops at limit + 1 = 2 rows: 12 rows from six listings, not 18.
    expect(reads.flatMap((s) => s.rowCounts).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it("leaves out a soft-deleted wedding's enquiries without short-filling the page", async () => {
    const db = inboxDb();
    seedListing(db, "dv_mine", "org_mine");
    seedVendorEnquiry(db, { id: "enq_live_1", listing: "dv_mine", wedding: "wed_1", s: 100 });
    seedVendorEnquiry(db, { id: "enq_gone", listing: "dv_mine", wedding: "wed_2", s: 200 });
    seedVendorEnquiry(db, { id: "enq_live_3", listing: "dv_mine", wedding: "wed_3", s: 300 });
    db.update(weddings)
      .set({ deletedAt: at(400) })
      .where(eq(weddings.id, "wed_2"))
      .run();

    const page = await inbox(db, ["org_mine"], { limit: 2, after: null });
    expect(page.enquiries.map((e) => e.id)).toEqual(["enq_live_3", "enq_live_1"]);
    expect(page.nextCursor).toBeNull();
  });

  it("reads each listing through the keyset index, with no sort", () => {
    const db = inboxDb();
    const shapes: Array<[string, ...string[]]> = [["dv_a"], ["dv_a", "dv_b", "dv_c"]];
    for (const listings of shapes) {
      for (const after of [null, { lastMessageAt: 100, id: "enq_x" }]) {
        const plan = planOf(db, listingEnquiriesQuery(db, listings, { limit: 50, after }));
        const seeks = plan.match(
          after
            ? /SEARCH vendor_enquiries USING INDEX vendor_enquiries_directory_last_msg_idx \(directory_vendor_id=\? AND \(last_message_at,id\)<\(\?,\?\)\)/g
            : /SEARCH vendor_enquiries USING INDEX vendor_enquiries_directory_last_msg_idx \(directory_vendor_id=\?\)/g,
        );
        expect(seeks).toHaveLength(listings.length);
        expect(plan).not.toContain("TEMP B-TREE");
        expect(plan).not.toMatch(/SCAN vendor_enquiries/);
      }
    }
  });
});
