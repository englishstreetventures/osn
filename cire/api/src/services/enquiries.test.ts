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
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import {
  createEnquiryService,
  EnquiryAwaitingVendor,
  type EnquiryRow,
  ZapUnavailable,
} from "./enquiries";
import type { ZapChatClient } from "./zap-bridge";

// ---------------------------------------------------------------------------
// Fixtures — a claimed + an unclaimed directory listing under the seed wedding.
// ---------------------------------------------------------------------------

const CLAIMED_VENDOR_ID = "dv_claimed";
const UNCLAIMED_VENDOR_ID = "dv_unclaimed";
const VENDOR_PROFILE_ID = "usr_vendor";
const ORGANISER_PROFILE_ID = "usr_organiser";

function db0(): Db {
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

const run = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) =>
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

const openInput = (
  over: Partial<Parameters<ReturnType<typeof createEnquiryService>["open"]>[0]> = {},
) => ({
  weddingId: BOOTSTRAP_WEDDING_ID,
  weddingName: "Alex & Sam",
  directoryVendorId: CLAIMED_VENDOR_ID,
  category: "florist",
  message: "Are you free on our date?",
  createdBy: ORGANISER_PROFILE_ID,
  vendorEmail: "claimed@vendor.test",
  leadForwardEmail: null,
  claimUrl: "https://claim.test/abc",
  ...over,
});

// Read an enquiry row straight from the DB, cast to EnquiryRow for reuse.
function readEnquiry(db: Db, id: string): EnquiryRow {
  const row = db.select().from(vendorEnquiries).where(eq(vendorEnquiries.id, id)).get();
  if (!row) throw new Error(`enquiry ${id} not found`);
  return row as unknown as EnquiryRow;
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

    const res = await run(
      db,
      svc.open(
        openInput({
          directoryVendorId: UNCLAIMED_VENDOR_ID,
          vendorEmail: "unclaimed@vendor.test",
          leadForwardEmail: "leads@wildflower.test",
        }),
      ),
    );
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
    // no future onVendorClaimed flush), so the route surfaces 503 to retry.
    expect(Exit.isFailure(res)).toBe(true);
    if (Exit.isFailure(res)) {
      expect(res.cause._tag === "Fail" && res.cause.error instanceof ZapUnavailable).toBe(true);
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
      expect(res.cause._tag === "Fail" && res.cause.error instanceof EnquiryAwaitingVendor).toBe(
        true,
      );
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

    // P-W2: the fetch is capped (limit 50) to stay under the Workers 6MB wall.
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
      expect(res.cause._tag === "Fail" && res.cause.error instanceof EnquiryAwaitingVendor).toBe(
        true,
      );
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
      svc.addToBudget({ enquiry: enq, vendorName: "Bloom & Co", category: "florist" }),
    );
    if (!Exit.isSuccess(res)) throw new Error("addToBudget failed");

    const item = db
      .select()
      .from(budgetItems)
      .where(eq(budgetItems.id, res.value.budgetItemId))
      .get();
    expect(item).toBeTruthy();
    expect(item!.name).toBe("Bloom & Co");
    expect(item!.category).toBe("florist");
    expect(item!.quotedMinor).toBe(250000);
    expect(item!.estimateMinor).toBeNull();
  });
});

describe("enquiryService.onVendorClaimed", () => {
  it("provisions + flushes each buffered enquiry, nulling pendingBody", async () => {
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

    const res = await run(
      db,
      svc.onVendorClaimed({
        directoryVendorId: UNCLAIMED_VENDOR_ID,
        vendorProfileId: VENDOR_PROFILE_ID,
      }),
    );
    expect(Exit.isSuccess(res)).toBe(true);

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

  it("flushes ALL buffered enquiries under bounded concurrency (parallel, not serial)", async () => {
    const db = db0();
    const zap = fakeZap();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: zap.client,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });

    // Seed 12 buffered enquiries against the SAME unclaimed listing, each under
    // its own wedding (the (wedding, listing) uniq index forbids duplicates on
    // one wedding). All: open, zapChatId null, pendingBody set.
    const now = new Date();
    const N = 12;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const wid = `wed_flush_${i}`;
      const vid = `ven_flush_${i}`;
      const eid = `enq_flush_${i}`;
      ids.push(eid);
      db.insert(weddings)
        .values({
          id: wid,
          slug: `flush-${i}`,
          displayName: `Flush ${i}`,
          ownerOsnProfileId: ORGANISER_PROFILE_ID,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(vendors)
        .values({
          id: vid,
          weddingId: wid,
          directoryVendorId: UNCLAIMED_VENDOR_ID,
          name: "CRM",
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
          id: eid,
          weddingId: wid,
          directoryVendorId: UNCLAIMED_VENDOR_ID,
          vendorId: vid,
          zapChatId: null,
          pendingBody: `body ${i}`,
          status: "open",
          createdBy: ORGANISER_PROFILE_ID,
          quotedMinor: null,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const res = await run(
      db,
      svc.onVendorClaimed({
        directoryVendorId: UNCLAIMED_VENDOR_ID,
        vendorProfileId: VENDOR_PROFILE_ID,
      }),
    );
    expect(Exit.isSuccess(res)).toBe(true);

    // Every buffered enquiry provisioned a chat + flushed its pending body.
    expect(zap.provisionCalls).toHaveLength(N);
    expect(zap.sendCalls).toHaveLength(N);
    for (const eid of ids) {
      const after = readEnquiry(db, eid);
      expect(after.zapChatId).not.toBeNull();
      expect(after.pendingBody).toBeNull();
    }
    // The bodies match one-to-one (order-agnostic — the flush runs concurrently).
    expect(new Set(zap.sendCalls.map((c) => c.body))).toEqual(
      new Set(Array.from({ length: N }, (_, i) => `body ${i}`)),
    );
  });

  it("is a no-op (never fails) when zap is null", async () => {
    const db = db0();
    const email = fakeEmail();
    const svc = createEnquiryService({
      zap: null,
      sendEmail: email.sendEmail,
      threadBaseUrl: THREAD_BASE,
    });
    // Buffer directly: open against an unclaimed listing with zap null.
    const opened = await run(db, svc.open(openInput({ directoryVendorId: UNCLAIMED_VENDOR_ID })));
    if (!Exit.isSuccess(opened)) throw new Error("open failed");

    const res = await run(
      db,
      svc.onVendorClaimed({
        directoryVendorId: UNCLAIMED_VENDOR_ID,
        vendorProfileId: VENDOR_PROFILE_ID,
      }),
    );
    expect(Exit.isSuccess(res)).toBe(true);
    const after = readEnquiry(db, opened.value.id);
    expect(after.zapChatId).toBeNull();
    expect(after.pendingBody).toBe("Are you free on our date?");
  });
});
