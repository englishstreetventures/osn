import { describe, expect, it } from "bun:test";

import { directoryVendors, vendorEnquiries, vendors, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { claimReviewService } from "../../src/services/claim-review";
import type { ZapChatClient } from "../../src/services/zap-bridge";
import { captureLogs } from "../test-helpers/capture-logs";

const COUPLE = "usr_couple";
const VENDOR = "usr_vendor";

function fakeZap() {
  const provisions: string[][] = [];
  const sent: string[] = [];
  let seq = 0;
  const client: ZapChatClient = {
    async provisionC2bChat(input) {
      provisions.push(input.memberProfileIds);
      seq += 1;
      return { chatId: `chat_${seq}` };
    },
    async sendC2bMessage(_chatId, input) {
      sent.push(input.body);
      return { messageId: `msg_${seq}`, createdAt: 0 };
    },
    async listC2bMessages() {
      return { messages: [] };
    },
  } as ZapChatClient;
  return { client, provisions, sent };
}

function listing(db: TestDb, id: string, claimedBy: string | null, reviewOrgId: string | null) {
  const now = new Date();
  db.insert(directoryVendors)
    .values({
      id,
      ownerOrgId: claimedBy ? `org_${id}` : null,
      claimedByProfileId: claimedBy,
      reviewOrgId,
      reviewProfileId: reviewOrgId ? VENDOR : null,
      name: id,
      listed: claimedBy ? "live" : "draft",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** `n` buffered enquiries to `dvId`, one per wedding (one thread per wedding and listing). */
function buffer(db: TestDb, dvId: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // Seconds apart: timestamps are stored at second precision.
    const now = new Date(Date.now() + i * 1000);
    const wid = `wed_${dvId}_${i}`;
    db.insert(weddings)
      .values({
        id: wid,
        slug: wid,
        displayName: wid,
        ownerOsnProfileId: COUPLE,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(vendors)
      .values({
        id: `ven_${wid}`,
        weddingId: wid,
        directoryVendorId: dvId,
        name: "CRM",
        category: "florist",
        status: "researching",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const id = `enq_${wid}`;
    db.insert(vendorEnquiries)
      .values({
        id,
        weddingId: wid,
        directoryVendorId: dvId,
        vendorId: `ven_${wid}`,
        zapChatId: null,
        pendingBody: `body ${dvId} ${i}`,
        status: "open",
        createdBy: COUPLE,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    ids.push(id);
  }
  return ids;
}

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  return db;
}

const sweep = (db: TestDb, zap: ZapChatClient | null, limit?: number) =>
  Effect.runPromise(
    claimReviewService.sweep(zap, limit).pipe(Effect.provideService(DbService, db)),
  );

const enquiry = (db: TestDb, id: string) =>
  db.select().from(vendorEnquiries).where(eq(vendorEnquiries.id, id)).get()!;

describe("claimReviewService.sweep", () => {
  it("hands a confirmed listing's buffered enquiries to its vendor", async () => {
    const db = db0();
    listing(db, "dv_confirmed", VENDOR, null);
    const [id] = buffer(db, "dv_confirmed", 1);
    const zap = fakeZap();

    const res = await sweep(db, zap.client);
    expect(res.handedOff).toBe(1);
    expect(zap.provisions).toEqual([[COUPLE, VENDOR]]);
    expect(zap.sent).toEqual(["body dv_confirmed 0"]);
    expect(enquiry(db, id!).zapChatId).toBe("chat_1");
    expect(enquiry(db, id!).pendingBody).toBeNull();
  });

  it("leaves enquiries to unclaimed and pending listings buffered", async () => {
    const db = db0();
    listing(db, "dv_unclaimed", null, null);
    listing(db, "dv_pending", null, "org_pending");
    const ids = [...buffer(db, "dv_unclaimed", 1), ...buffer(db, "dv_pending", 1)];
    const zap = fakeZap();

    const res = await sweep(db, zap.client);
    expect(res).toEqual({ handedOff: 0, pending: 1 });
    expect(zap.provisions).toHaveLength(0);
    for (const id of ids) expect(enquiry(db, id).pendingBody).not.toBeNull();
  });

  it("skips enquiries that are closed or already have a chat", async () => {
    const db = db0();
    listing(db, "dv_confirmed", VENDOR, null);
    const [closed, chatted] = buffer(db, "dv_confirmed", 2);
    db.update(vendorEnquiries)
      .set({ status: "closed" })
      .where(eq(vendorEnquiries.id, closed!))
      .run();
    db.update(vendorEnquiries)
      .set({ zapChatId: "chat_existing" })
      .where(eq(vendorEnquiries.id, chatted!))
      .run();
    const zap = fakeZap();

    expect((await sweep(db, zap.client)).handedOff).toBe(0);
    expect(zap.provisions).toHaveLength(0);
  });

  it("takes at most `limit` enquiries a run, oldest first, and the rest the next run", async () => {
    const db = db0();
    listing(db, "dv_busy", VENDOR, null);
    const ids = buffer(db, "dv_busy", 12);
    const zap = fakeZap();

    expect((await sweep(db, zap.client, 10)).handedOff).toBe(10);
    expect(enquiry(db, ids[0]!).zapChatId).not.toBeNull();
    expect(enquiry(db, ids[11]!).zapChatId).toBeNull();
    expect((await sweep(db, zap.client, 10)).handedOff).toBe(2);
    expect((await sweep(db, zap.client, 10)).handedOff).toBe(0);
    expect(zap.provisions).toHaveLength(12);
  });

  it("retries an enquiry whose hand-off failed", async () => {
    const db = db0();
    listing(db, "dv_flaky", VENDOR, null);
    const [id] = buffer(db, "dv_flaky", 1);
    const zap = fakeZap();
    const down = {
      ...zap.client,
      sendC2bMessage: async () => {
        throw new Error("zap down");
      },
    } as ZapChatClient;

    expect((await sweep(db, down)).handedOff).toBe(0);
    expect(enquiry(db, id!).pendingBody).not.toBeNull();
    expect((await sweep(db, zap.client)).handedOff).toBe(1);
    expect(enquiry(db, id!).pendingBody).toBeNull();
  });

  it("without vendor chat, hands nothing off and keeps every enquiry buffered", async () => {
    const db = db0();
    listing(db, "dv_confirmed", VENDOR, null);
    const [id] = buffer(db, "dv_confirmed", 1);

    const logs = await captureLogs(async () => {
      expect((await sweep(db, null)).handedOff).toBe(0);
    });
    expect(enquiry(db, id!).pendingBody).not.toBeNull();
    expect(logs).toContain("vendor chat is not configured");
  });

  it("logs the number of claims waiting for an operator", async () => {
    const db = db0();
    listing(db, "dv_p1", null, "org_a");
    listing(db, "dv_p2", null, "org_b");

    let pending = -1;
    const logs = await captureLogs(async () => {
      pending = (await sweep(db, null)).pending;
    });
    expect(pending).toBe(2);
    expect(logs).toContain("vendor claims awaiting operator review");
  });
});
