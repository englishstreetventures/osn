import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingFaqs, weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { asc, eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { FAQ_LIMITS } from "../../src/schemas/invite-faq";
import { appRequest, jsonBody } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Fixed local dev owner of the seeded sample wedding (DEV_OWNER_PROFILE_ID).
const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_faq_editor";
const VIEWER = "usr_faq_viewer";
const HELPER = "usr_faq_helper";
const STRANGER = "usr_faq_stranger";
const OTHER_WEDDING = "wed_faq_other";

const inviteBase = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/invite`;
const faqBase = `${inviteBase}/faqs`;

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp(opts?: { inviteLimiter?: RateLimiterBackend }) {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  for (const [id, osnProfileId, role] of [
    ["whost_faq_editor", EDITOR, "editor"],
    ["whost_faq_viewer", VIEWER, "viewer"],
    ["whost_faq_helper", HELPER, "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: now,
      })
      .run();
  }
  db.insert(weddings)
    .values({
      id: OTHER_WEDDING,
      slug: "faq-other",
      displayName: "Other",
      ownerOsnProfileId: STRANGER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const app = createApp(db, {
    osnTestKey: auth.key,
    // Generous per-test limiter so the shared module default can't bleed across
    // tests; the rate-limit test below injects a tight one.
    inviteLimiter:
      opts?.inviteLimiter ?? createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
  });
  return { db, app };
}
type App = ReturnType<typeof buildApp>["app"];

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
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Faq = { id: string; question: string; answer: string };

async function create(app: App, question: string, answer = "Yes.", profileId = OWNER) {
  const res = await req(app, "POST", faqBase, profileId, { question, answer });
  expect(res.status).toBe(200);
  return ((await res.json()) as { faq: Faq }).faq;
}

async function organiserFaqs(app: App, profileId = OWNER): Promise<Faq[] | undefined> {
  const res = await req(app, "GET", `${inviteBase}?include=faqs`, profileId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { faqs?: Faq[] }).faqs;
}

describe("invite FAQ routes (migration 0064)", () => {
  describe("auth and roles", () => {
    it("401s without a token", async () => {
      const { app } = buildApp();
      expect(
        (await req(app, "POST", faqBase, undefined, { question: "Q", answer: "A" })).status,
      ).toBe(401);
    });

    // STRANGER owns another wedding, so this is also the cross-wedding case.
    it("403s a stranger, never 401", async () => {
      const { app } = buildApp();
      const res = await req(app, "POST", faqBase, STRANGER, { question: "Q", answer: "A" });
      expect(res.status).toBe(403);
    });

    it("403s a viewer co-host with read_only_role on every write", async () => {
      const { app } = buildApp();
      const entry = await create(app, "Parking?");
      for (const [method, path, body] of [
        ["POST", faqBase, { question: "Q", answer: "A" }],
        ["PUT", `${faqBase}/${entry.id}`, { question: "Q", answer: "A" }],
        ["PUT", `${faqBase}/order`, { orderedIds: [entry.id] }],
        ["DELETE", `${faqBase}/${entry.id}`, undefined],
      ] as const) {
        const res = await req(app, method, path, VIEWER, body);
        expect(res.status).toBe(403);
        expect(await jsonBody(res)).toEqual({ error: "read_only_role" });
      }
      expect(await organiserFaqs(app)).toEqual([entry]);
    });

    it("403s a helper co-host — the run sheet is all a helper may touch", async () => {
      const { app } = buildApp();
      const res = await req(app, "POST", faqBase, HELPER, { question: "Q", answer: "A" });
      expect(res.status).toBe(403);
      expect(await organiserFaqs(app)).toEqual([]);
    });

    it("lets an editor co-host add, change, reorder and delete entries", async () => {
      const { app } = buildApp();
      const a = await create(app, "Parking?", "Yes.", EDITOR);
      const b = await create(app, "Children?", "Ceremony only.", EDITOR);

      const upd = await req(app, "PUT", `${faqBase}/${a.id}`, EDITOR, {
        question: "Is there parking?",
        answer: "Sixty spaces.",
      });
      expect(upd.status).toBe(200);
      expect(await jsonBody(upd)).toEqual({
        faq: { id: a.id, question: "Is there parking?", answer: "Sixty spaces." },
      });

      const order = await req(app, "PUT", `${faqBase}/order`, EDITOR, { orderedIds: [b.id, a.id] });
      expect(order.status).toBe(200);
      expect(await jsonBody(order)).toEqual({ ok: true });
      expect((await organiserFaqs(app))!.map((e) => e.id)).toEqual([b.id, a.id]);

      const del = await req(app, "DELETE", `${faqBase}/${b.id}`, EDITOR);
      expect(del.status).toBe(200);
      expect(await jsonBody(del)).toEqual({ ok: true });
      expect((await organiserFaqs(app))!.map((e) => e.id)).toEqual([a.id]);
    });

    it("401s a dead session cookie or a malformed bearer, and stores nothing", async () => {
      const { app } = buildApp();
      const credentials: Record<string, string>[] = [
        { cookie: "cire_org_session=not-a-live-session-token" },
        { authorization: "Bearer not-a-jwt" },
      ];
      for (const headers of credentials) {
        const res = await appRequest(app, faqBase, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ question: "Parking?", answer: "Yes." }),
        });
        expect(res.status).toBe(401);
        expect(await jsonBody(res)).toEqual({ error: "unauthorised" });
      }
      expect(await organiserFaqs(app)).toEqual([]);
    });

    // The builder reaches these routes with the organiser session cookie, not a
    // bearer token, so the cookie path is the one that has to hold.
    it("saves for an organiser session cookie", async () => {
      const { app, db } = buildApp();
      const token = await seedOrganiserSession(db, OWNER);
      const res = await appRequest(app, faqBase, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: `cire_org_session=${token}` },
        body: JSON.stringify({ question: "Parking?", answer: "Yes." }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("the organiser read", () => {
    it("adds the entries, in order, only when asked with ?include=faqs", async () => {
      const { app } = buildApp();
      const a = await create(app, "Parking?");
      const b = await create(app, "Children?");

      expect(await organiserFaqs(app)).toEqual([a, b]);

      // Without the query every other reader gets the customisation unchanged.
      const plain = await req(app, "GET", inviteBase, OWNER);
      expect(plain.status).toBe(200);
      expect(Object.keys((await plain.json()) as object)).not.toContain("faqs");
    });

    it("reads an empty list for a wedding with no entries", async () => {
      const { app } = buildApp();
      expect(await organiserFaqs(app)).toEqual([]);
    });

    it("refuses the entries to a stranger, a helper and a caller with no token", async () => {
      const { app } = buildApp();
      // One entry, so an empty list cannot pass by chance.
      await create(app, "Parking?");
      for (const [profileId, status] of [
        [STRANGER, 403],
        [HELPER, 403],
        [undefined, 401],
      ] as const) {
        const res = await req(app, "GET", `${inviteBase}?include=faqs`, profileId);
        expect(res.status).toBe(status);
        expect(Object.keys((await res.json()) as object)).not.toContain("faqs");
      }
    });

    it("lets a viewer read the entries", async () => {
      const { app } = buildApp();
      const a = await create(app, "Parking?");
      expect(await organiserFaqs(app, VIEWER)).toEqual([a]);
    });

    it("never carries another wedding's entries", async () => {
      const { app, db } = buildApp();
      db.insert(weddingFaqs)
        .values({
          id: "faq_other_wedding",
          weddingId: OTHER_WEDDING,
          question: "Theirs",
          answer: "Theirs.",
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
      expect(await organiserFaqs(app)).toEqual([]);
    });
  });

  describe("validation", () => {
    it("400s a missing, blank, over-long or non-string field, and stores nothing", async () => {
      const { app } = buildApp();
      for (const body of [
        {},
        { question: "Parking?" },
        { answer: "Yes." },
        { question: "   ", answer: "Yes." },
        { question: "Parking?", answer: "\n\t " },
        { question: "x".repeat(FAQ_LIMITS.questionMax + 1), answer: "Yes." },
        { question: "Parking?", answer: "x".repeat(FAQ_LIMITS.answerMax + 1) },
        { question: 7, answer: "Yes." },
        "not json",
        "null",
      ]) {
        const res = await req(app, "POST", faqBase, OWNER, body);
        expect(res.status).toBe(400);
        expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
      }
      expect(await organiserFaqs(app)).toEqual([]);
    });

    it("accepts both fields at exactly their caps", async () => {
      const { app } = buildApp();
      const entry = await create(
        app,
        "q".repeat(FAQ_LIMITS.questionMax),
        "a".repeat(FAQ_LIMITS.answerMax),
      );
      expect(entry.question).toHaveLength(FAQ_LIMITS.questionMax);
      expect(entry.answer).toHaveLength(FAQ_LIMITS.answerMax);
    });

    it("400s a bad update body and leaves the entry as it was", async () => {
      const { app } = buildApp();
      const entry = await create(app, "Parking?");
      for (const body of [{}, { question: "Only a question" }, { question: "", answer: "A" }]) {
        const res = await req(app, "PUT", `${faqBase}/${entry.id}`, OWNER, body);
        expect(res.status).toBe(400);
      }
      expect(await organiserFaqs(app)).toEqual([entry]);
    });

    it("400s an order body that is not a bounded list of ids", async () => {
      const { app } = buildApp();
      const tooMany = Array.from({ length: FAQ_LIMITS.maxEntries + 1 }, (_, i) => `faq_${i}`);
      for (const body of [
        {},
        { orderedIds: "faq_1" },
        { orderedIds: [""] },
        { orderedIds: tooMany },
      ]) {
        const res = await req(app, "PUT", `${faqBase}/order`, OWNER, body);
        expect(res.status).toBe(400);
      }
    });
  });

  describe("reorder bounds", () => {
    it("accepts a full list of exactly the cap", async () => {
      const { app } = buildApp();
      const ids = Array.from({ length: FAQ_LIMITS.maxEntries }, (_, i) => `faq_${i}`);
      const res = await req(app, "PUT", `${faqBase}/order`, OWNER, { orderedIds: ids });
      expect(res.status).toBe(200);
    });

    it("accepts an empty list and changes nothing", async () => {
      const { app } = buildApp();
      const a = await create(app, "A");
      const b = await create(app, "B");
      const res = await req(app, "PUT", `${faqBase}/order`, OWNER, { orderedIds: [] });
      expect(res.status).toBe(200);
      expect((await organiserFaqs(app))!.map((e) => e.id)).toEqual([a.id, b.id]);
    });

    it("gives a repeated id its last position, and leaves ids it omits where they were", async () => {
      const { app, db } = buildApp();
      const a = await create(app, "A");
      const b = await create(app, "B");
      const c = await create(app, "C");
      // `a` twice: each position is written in turn, so the last one stands.
      // `c` omitted: it keeps its stored position.
      await req(app, "PUT", `${faqBase}/order`, OWNER, { orderedIds: [a.id, b.id, a.id] });
      const rows = db
        .select({ id: weddingFaqs.id, sortOrder: weddingFaqs.sortOrder })
        .from(weddingFaqs)
        .orderBy(asc(weddingFaqs.id))
        .all();
      expect(Object.fromEntries(rows.map((r) => [r.id, r.sortOrder]))).toEqual({
        [a.id]: 2,
        [b.id]: 1,
        [c.id]: 2,
      });
    });
  });

  describe("limits and tenancy", () => {
    it(`409s the entry past ${FAQ_LIMITS.maxEntries}, and stores nothing`, async () => {
      const { app } = buildApp();
      for (let i = 0; i < FAQ_LIMITS.maxEntries; i++) {
        // Sequential: each create is counted by the next.
        // eslint-disable-next-line no-await-in-loop
        await create(app, `Question ${i}`);
      }
      const res = await req(app, "POST", faqBase, OWNER, { question: "One more", answer: "No." });
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "faq_limit_reached" });
      expect(await organiserFaqs(app)).toHaveLength(FAQ_LIMITS.maxEntries);
    });

    it("404s an unknown id on update and delete", async () => {
      const { app } = buildApp();
      const upd = await req(app, "PUT", `${faqBase}/faq_missing`, OWNER, {
        question: "Q",
        answer: "A",
      });
      expect(upd.status).toBe(404);
      expect(await jsonBody(upd)).toEqual({ error: "faq_not_found" });
      const del = await req(app, "DELETE", `${faqBase}/faq_missing`, OWNER);
      expect(del.status).toBe(404);
      expect(await jsonBody(del)).toEqual({ error: "faq_not_found" });
    });

    it("404s another wedding's entry through this wedding's path, and leaves it alone", async () => {
      const { app, db } = buildApp();
      const now = new Date();
      db.insert(weddingFaqs)
        .values({
          id: "faq_theirs",
          weddingId: OTHER_WEDDING,
          question: "Theirs",
          answer: "Theirs.",
          sortOrder: 5,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const upd = await req(app, "PUT", `${faqBase}/faq_theirs`, OWNER, {
        question: "Mine now",
        answer: "Mine.",
      });
      expect(upd.status).toBe(404);
      expect((await req(app, "DELETE", `${faqBase}/faq_theirs`, OWNER)).status).toBe(404);
      // A foreign id in an order is a no-op, not an error.
      expect(
        (await req(app, "PUT", `${faqBase}/order`, OWNER, { orderedIds: ["faq_theirs"] })).status,
      ).toBe(200);

      const [row] = db.select().from(weddingFaqs).where(eq(weddingFaqs.id, "faq_theirs")).all();
      expect(row).toMatchObject({ question: "Theirs", answer: "Theirs.", sortOrder: 5 });
    });

    it("stores a dense order from 0", async () => {
      const { app, db } = buildApp();
      const a = await create(app, "A");
      const b = await create(app, "B");
      const c = await create(app, "C");
      await req(app, "PUT", `${faqBase}/order`, OWNER, { orderedIds: [c.id, a.id, b.id] });
      const rows = db
        .select({ id: weddingFaqs.id, sortOrder: weddingFaqs.sortOrder })
        .from(weddingFaqs)
        .orderBy(asc(weddingFaqs.sortOrder))
        .all();
      expect(rows).toEqual([
        { id: c.id, sortOrder: 0 },
        { id: a.id, sortOrder: 1 },
        { id: b.id, sortOrder: 2 },
      ]);
    });
  });

  describe("failures", () => {
    it("answers a failed write with a plain 500 on every route", async () => {
      const { app, db } = buildApp();
      // A D1 error reaches the handler as a defect; dropping the table is the
      // cheapest way to raise one here.
      db.$client.exec("DROP TABLE wedding_faqs");
      for (const [method, path, body] of [
        ["POST", faqBase, { question: "Q", answer: "A" }],
        ["PUT", `${faqBase}/faq_1`, { question: "Q", answer: "A" }],
        ["PUT", `${faqBase}/order`, { orderedIds: ["faq_1"] }],
        ["DELETE", `${faqBase}/faq_1`, undefined],
      ] as const) {
        const res = await req(app, method, path, OWNER, body);
        expect(res.status).toBe(500);
        expect(await jsonBody(res)).toEqual({ error: "Internal error" });
      }
    });

    it("answers the organiser read with a plain 500 when the FAQ read fails", async () => {
      const { app, db } = buildApp();
      db.$client.exec("DROP TABLE wedding_faqs");
      const res = await req(app, "GET", `${inviteBase}?include=faqs`, OWNER);
      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "Internal error" });
      // The plain read does not touch the table.
      expect((await req(app, "GET", inviteBase, OWNER)).status).toBe(200);
    });

    it("shares the invite builder's per-IP write limiter", async () => {
      const { app } = buildApp({
        inviteLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
      });
      const first = await req(app, "POST", faqBase, OWNER, { question: "Q", answer: "A" });
      expect(first.status).not.toBe(429);
      const second = await req(app, "POST", faqBase, OWNER, { question: "Q2", answer: "A" });
      expect(second.status).toBe(429);
    });
  });

  // `cire.invite.faq.write` is how a refused write shows on a dashboard; each
  // outcome is counted once, under its own labels.
  describe("the write counter", () => {
    const written = (action: string, result: string) =>
      counterValue(CIRE_METRICS.inviteFaqWrite, { action, result });

    async function expectCounted(
      action: string,
      result: string,
      write: () => Promise<Response>,
    ): Promise<void> {
      const before = await written(action, result);
      await write();
      expect(await written(action, result)).toBe(before + 1);
    }

    it("counts each write by action and outcome", async () => {
      const { app } = buildApp();
      await expectCounted("create", "ok", () =>
        req(app, "POST", faqBase, OWNER, { question: "Parking?", answer: "Yes." }),
      );
      const [entry] = (await organiserFaqs(app))!;
      await expectCounted("update", "ok", () =>
        req(app, "PUT", `${faqBase}/${entry!.id}`, OWNER, { question: "Q", answer: "A" }),
      );
      await expectCounted("reorder", "ok", () =>
        req(app, "PUT", `${faqBase}/order`, OWNER, { orderedIds: [entry!.id] }),
      );
      await expectCounted("update", "not_found", () =>
        req(app, "PUT", `${faqBase}/faq_missing`, OWNER, { question: "Q", answer: "A" }),
      );
      await expectCounted("remove", "not_found", () =>
        req(app, "DELETE", `${faqBase}/faq_missing`, OWNER),
      );
      await expectCounted("remove", "ok", () =>
        req(app, "DELETE", `${faqBase}/${entry!.id}`, OWNER),
      );
    });

    it("counts a create refused at the cap as limit_reached, not ok", async () => {
      const { app } = buildApp();
      for (let i = 0; i < FAQ_LIMITS.maxEntries; i++) {
        // eslint-disable-next-line no-await-in-loop
        await create(app, `Question ${i}`);
      }
      const okBefore = await written("create", "ok");
      await expectCounted("create", "limit_reached", () =>
        req(app, "POST", faqBase, OWNER, { question: "One more", answer: "No." }),
      );
      expect(await written("create", "ok")).toBe(okBefore);
    });
  });
});
