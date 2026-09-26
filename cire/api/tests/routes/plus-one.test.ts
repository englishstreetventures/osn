import { beforeEach, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { CIRE_METRICS } from "../../src/metrics";
import { PLUS_ONE_NAME_MAX } from "../../src/schemas/plus-one";
import { hostCodeService } from "../../src/services/host-code";
import { appRequest, jsonBody } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import {
  allowPlusOne,
  eventIdsOf,
  fillToCap,
  guestNamed,
  seedPlusOne,
} from "../test-helpers/plus-one";

let db: TestDb;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = createDb(":memory:");
  seedDb(db);
  app = createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });
});

/** Claim a household code and return its session cookie. */
async function cookieFor(publicId: string): Promise<string> {
  const res = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicId }),
  });
  expect(res.status).toBe(200);
  const token = parseSessionToken(res.headers.get("Set-Cookie"));
  if (!token) throw new Error("no session cookie");
  return `cire_session=${token}`;
}

const SAMPLETON = "TESTTWO-OAK-BB22";

function put(guestId: string, cookie: string | null, body: unknown, origin?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return appRequest(app, `/api/plus-one/${guestId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

function del(guestId: string, cookie: string | null, origin?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return appRequest(app, `/api/plus-one/${guestId}`, { method: "DELETE", headers });
}

/** Open the organiser's host preview and return its cookie and its one guest. */
async function hostPreview(): Promise<{ cookie: string; guestId: string }> {
  const { publicId } = await Effect.runPromise(
    hostCodeService
      .ensureForWedding(BOOTSTRAP_WEDDING_ID, "cire-wedding")
      .pipe(Effect.provideService(DbService, db)),
  );
  const cookie = await cookieFor(publicId);
  const [hostGuest] = db
    .select({ id: guests.id })
    .from(guests)
    .innerJoin(families, eq(guests.familyId, families.id))
    .where(eq(families.kind, "host"))
    .all();
  if (!hostGuest) throw new Error("no host guest");
  return { cookie, guestId: hostGuest.id };
}

function closeRsvps() {
  db.update(weddings)
    .set({ rsvpDeadline: "2000-01-01", rsvpDeadlineTimezone: "UTC" })
    .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
    .run();
}

const blocked = (reason: string) => counterValue(CIRE_METRICS.plusOneBlocked, { reason });
const changed = (action: string) =>
  counterValue(CIRE_METRICS.plusOneChanged, { action, actor: "guest" });

function plusOnesOf(inviterId: string) {
  return db.select().from(guests).where(eq(guests.plusOneOfGuestId, inviterId)).all();
}

describe("PUT /api/plus-one/:guestId", () => {
  it("401s without a session", async () => {
    const bo = guestNamed(db, "Bo");
    expect((await put(bo.id, null, { firstName: "Sam" })).status).toBe(401);
  });

  it("403s a state-changing request from a foreign origin", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    const res = await put(bo.id, cookie, { firstName: "Sam" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(plusOnesOf(bo.id)).toHaveLength(0);
  });

  it("names, then renames, the plus-one of a permitted member", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    const added = await counterValue(CIRE_METRICS.plusOneChanged, {
      action: "added",
      actor: "guest",
    });

    const res = await put(bo.id, cookie, { firstName: "Sam", lastName: "Guest" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: boolean;
      plusOne: { guestId: string; firstName: string; plusOneOf: string; eventIds: string[] };
    };
    expect(body.created).toBe(true);
    expect(body.plusOne).toMatchObject({ firstName: "Sam", plusOneOf: bo.id });
    expect(body.plusOne.eventIds.toSorted()).toEqual(eventIdsOf(db, bo.id));
    expect(
      await counterValue(CIRE_METRICS.plusOneChanged, { action: "added", actor: "guest" }),
    ).toBe(added + 1);

    const renamed = await put(bo.id, cookie, { firstName: "Samira" });
    expect(renamed.status).toBe(200);
    expect(await jsonBody(renamed)).toMatchObject({
      created: false,
      plusOne: { guestId: body.plusOne.guestId, firstName: "Samira", lastName: "" },
    });
  });

  it("400s a blank, oversized or control-character name", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    for (const body of [
      {},
      { firstName: "   " },
      { firstName: "x".repeat(PLUS_ONE_NAME_MAX + 1) },
      { firstName: "Sam\u0007" },
      { firstName: "Sam", lastName: "‮gnirts" },
    ]) {
      expect((await put(bo.id, cookie, body)).status).toBe(400);
    }
    expect(plusOnesOf(bo.id)).toHaveLength(0);
  });

  it("403s a member without permission", async () => {
    const bo = guestNamed(db, "Bo");
    const cookie = await cookieFor(SAMPLETON);
    const res = await put(bo.id, cookie, { firstName: "Sam" });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "plus_one_not_allowed" });
  });

  it("404s a guest of another household", async () => {
    const ada = guestNamed(db, "Ada");
    allowPlusOne(db, ada.id);
    const cookie = await cookieFor(SAMPLETON);
    const res = await put(ada.id, cookie, { firstName: "Sam" });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "guest_not_found" });
    expect(plusOnesOf(ada.id)).toHaveLength(0);
  });

  it("403s rsvp_closed after the deadline", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    closeRsvps();
    const res = await put(bo.id, cookie, { firstName: "Sam" });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "rsvp_closed" });
  });

  it("403s the organiser's host preview, and counts it", async () => {
    const { cookie, guestId } = await hostPreview();
    // Permission on, so only the preview guard can refuse.
    allowPlusOne(db, guestId);
    const before = await blocked("preview");
    const res = await put(guestId, cookie, { firstName: "Sam" });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "Preview sessions cannot change plus-ones" });
    expect(plusOnesOf(guestId)).toHaveLength(0);
    expect(await blocked("preview")).toBe(before + 1);
  });

  it("401s a cookie that names no live session", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const res = await put(bo.id, "cire_session=not-a-real-token", { firstName: "Sam" });
    expect(res.status).toBe(401);
    expect(plusOnesOf(bo.id)).toHaveLength(0);
  });

  it("413s an oversized body before parsing it", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    const body = JSON.stringify({ firstName: "Sam", padding: "x".repeat(8 * 1024) });
    const res = await appRequest(app, `/api/plus-one/${bo.id}`, {
      method: "PUT",
      // The declared length is what the guard reads, as a browser sends it.
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        Cookie: cookie,
      },
      body,
    });
    expect(res.status).toBe(413);
    expect(await jsonBody(res)).toEqual({ error: "Payload too large" });
    expect(plusOnesOf(bo.id)).toHaveLength(0);
  });

  it("400s a body that is not JSON", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    const res = await appRequest(app, `/api/plus-one/${bo.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
  });

  it("409s plus_one_cannot_invite for a plus-one bringing one", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    allowPlusOne(db, samId);
    const cookie = await cookieFor(SAMPLETON);
    const res = await put(samId, cookie, { firstName: "Pat" });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "plus_one_cannot_invite" });
  });

  it("409s guest_capacity at the wedding's guest cap, and counts it", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    fillToCap(db);
    const cookie = await cookieFor(SAMPLETON);
    const before = await blocked("capacity");
    const res = await put(bo.id, cookie, { firstName: "Sam" });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "guest_capacity" });
    expect(plusOnesOf(bo.id)).toHaveLength(0);
    expect(await blocked("capacity")).toBe(before + 1);
  });

  it("counts a rename, and not a rename to the same name", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    await put(bo.id, cookie, { firstName: "Sam" });
    const before = await changed("renamed");
    await put(bo.id, cookie, { firstName: "Samira" });
    expect(await changed("renamed")).toBe(before + 1);
    const same = await put(bo.id, cookie, { firstName: " Samira " });
    expect(await jsonBody(same)).toMatchObject({
      created: false,
      plusOne: { firstName: "Samira" },
    });
    expect(await changed("renamed")).toBe(before + 1);
  });

  it("counts the not_allowed and deadline refusals", async () => {
    const bo = guestNamed(db, "Bo");
    const cookie = await cookieFor(SAMPLETON);
    const notAllowed = await blocked("not_allowed");
    await put(bo.id, cookie, { firstName: "Sam" });
    expect(await blocked("not_allowed")).toBe(notAllowed + 1);

    allowPlusOne(db, bo.id);
    closeRsvps();
    const deadline = await blocked("deadline");
    await put(bo.id, cookie, { firstName: "Sam" });
    expect(await blocked("deadline")).toBe(deadline + 1);
  });
});

describe("DELETE /api/plus-one/:guestId", () => {
  it("removes the plus-one, and is idempotent", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const cookie = await cookieFor(SAMPLETON);
    await put(bo.id, cookie, { firstName: "Sam" });

    const first = await del(bo.id, cookie);
    expect(first.status).toBe(200);
    expect(await jsonBody(first)).toEqual({ removed: true });
    expect(plusOnesOf(bo.id)).toHaveLength(0);

    expect(await jsonBody(await del(bo.id, cookie))).toEqual({ removed: false });
  });

  it("401s without a session, or with a cookie that names no live session", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    expect((await del(bo.id, null)).status).toBe(401);
    expect((await del(bo.id, "cire_session=not-a-real-token")).status).toBe(401);
    expect(plusOnesOf(bo.id)).toHaveLength(1);
  });

  it("404s another household's plus-one, and deletes nothing", async () => {
    const ada = guestNamed(db, "Ada");
    seedPlusOne(db, ada.id, { firstName: "Sam" });
    const cookie = await cookieFor(SAMPLETON);
    const res = await del(ada.id, cookie);
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "guest_not_found" });
    expect(plusOnesOf(ada.id)).toHaveLength(1);
  });

  it("403s a foreign origin, and deletes nothing", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    const cookie = await cookieFor(SAMPLETON);
    expect((await del(bo.id, cookie, "https://evil.example")).status).toBe(403);
    expect(plusOnesOf(bo.id)).toHaveLength(1);
  });

  it("403s the organiser's host preview", async () => {
    const { cookie, guestId } = await hostPreview();
    const res = await del(guestId, cookie);
    expect(res.status).toBe(403);
  });

  it("403s rsvp_closed after the deadline, and deletes nothing", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    const cookie = await cookieFor(SAMPLETON);
    closeRsvps();
    const res = await del(bo.id, cookie);
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({ error: "rsvp_closed" });
    expect(plusOnesOf(bo.id)).toHaveLength(1);
  });

  it("counts a removal once, not the idempotent repeat", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    const cookie = await cookieFor(SAMPLETON);
    const before = await changed("removed");
    await del(bo.id, cookie);
    await del(bo.id, cookie);
    expect(await changed("removed")).toBe(before + 1);
  });
});
