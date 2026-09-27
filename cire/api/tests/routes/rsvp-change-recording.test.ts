import { beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests, rsvpChanges, rsvps, weddings } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { createRateLimiter } from "@shared/rate-limit";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { CIRE_METRICS } from "../../src/metrics";
import { hostCodeService } from "../../src/services/host-code";
import { appRequest } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// Which guest-side RSVP writes land in the change log. The log itself is
// tested in tests/services/rsvp-changes.test.ts; this file pins the wiring in
// `POST /api/rsvp` and that the organiser's own recording path stays out.

const HINDU = eventsData.hindu.id;
const RECEPTION = eventsData.reception.id;
// The seed mints family and guest ids at random; these are read back per test.
const TESTONE_CODE = "TESTONE-IVY-AA11";
const TESTTWO_CODE = "TESTTWO-OAK-BB22";
let ADA: string;
let BO: string;
let TESTONE_FAMILY: string;
const OWNER = "usr_dev_bootstrap_owner";
const ORIGIN = "http://localhost:4321";

let auth: OsnTestAuth;
let db: TestDb;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

beforeEach(() => {
  db = createDb(":memory:");
  seedDb(db);
  app = createApp(db, {
    osnTestKey: auth.key,
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });
  const byName = (firstName: string) =>
    db
      .select({ id: guests.id, familyId: guests.familyId })
      .from(guests)
      .where(eq(guests.firstName, firstName))
      .all()[0]!;
  ADA = byName("Ada").id;
  TESTONE_FAMILY = byName("Ada").familyId;
  BO = byName("Bo").id;
  const [family] = db
    .select({ publicId: families.publicId })
    .from(families)
    .where(eq(families.id, TESTONE_FAMILY))
    .all();
  expect(family?.publicId).toBe(TESTONE_CODE);
});

async function cookieFor(publicId: string): Promise<string> {
  const res = await appRequest(app, "/api/claim", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      Origin: ORIGIN,
    },
    body: JSON.stringify({ publicId }),
  });
  expect(res.status).toBe(200);
  return `cire_session=${parseSessionToken(res.headers.get("Set-Cookie"))}`;
}

type Reply = { guestId: string; eventId: string; status: string; dietary?: string };

async function submit(cookie: string, replies: Reply[]): Promise<Response> {
  return appRequest(app, "/api/rsvp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify({
      rsvps: replies.map((r) => ({ dietary: "", dietaryPresets: [], dietaryConsent: false, ...r })),
    }),
  });
}

const logged = () =>
  db
    .select({
      weddingId: rsvpChanges.weddingId,
      familyId: rsvpChanges.familyId,
      guestId: rsvpChanges.guestId,
      eventId: rsvpChanges.eventId,
      kind: rsvpChanges.kind,
    })
    .from(rsvpChanges)
    .orderBy(asc(rsvpChanges.seq))
    .all();

describe("POST /api/rsvp → change log", () => {
  it("logs a first reply as new, one row per pair, under the household", async () => {
    const cookie = await cookieFor(TESTONE_CODE);
    const res = await submit(cookie, [
      { guestId: ADA, eventId: HINDU, status: "attending" },
      { guestId: ADA, eventId: RECEPTION, status: "declined" },
    ]);
    expect(res.status).toBe(200);
    expect(logged()).toEqual([
      {
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: TESTONE_FAMILY,
        guestId: ADA,
        eventId: HINDU,
        kind: "reply_new",
      },
      {
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: TESTONE_FAMILY,
        guestId: ADA,
        eventId: RECEPTION,
        kind: "reply_new",
      },
    ]);
  });

  it("logs nothing for a re-submit that changes nothing", async () => {
    const cookie = await cookieFor(TESTONE_CODE);
    const replies = [{ guestId: ADA, eventId: HINDU, status: "attending" }];
    await submit(cookie, replies);
    await submit(cookie, replies);
    expect(logged()).toHaveLength(1);
  });

  it("logs only the pair whose answer changed, as an edit", async () => {
    const cookie = await cookieFor(TESTONE_CODE);
    await submit(cookie, [
      { guestId: ADA, eventId: HINDU, status: "attending" },
      { guestId: ADA, eventId: RECEPTION, status: "attending" },
    ]);
    await submit(cookie, [
      { guestId: ADA, eventId: HINDU, status: "attending" },
      { guestId: ADA, eventId: RECEPTION, status: "maybe" },
    ]);
    expect(logged().map((r) => [r.eventId, r.kind])).toEqual([
      [HINDU, "reply_new"],
      [RECEPTION, "reply_new"],
      [RECEPTION, "reply_edited"],
    ]);
  });

  it("logs a pair named twice in one body once", async () => {
    const cookie = await cookieFor(TESTONE_CODE);
    await submit(cookie, [
      { guestId: ADA, eventId: HINDU, status: "declined" },
      { guestId: ADA, eventId: HINDU, status: "attending" },
    ]);
    expect(logged()).toHaveLength(1);
    expect(db.select({ status: rsvps.status }).from(rsvps).all()).toEqual([
      { status: "attending" },
    ]);
  });

  it("counts each change it logs", async () => {
    const before = await counterValue(CIRE_METRICS.rsvpChangeRecorded, { kind: "reply_new" });
    const cookie = await cookieFor(TESTTWO_CODE);
    await submit(cookie, [{ guestId: BO, eventId: HINDU, status: "attending" }]);
    expect(await counterValue(CIRE_METRICS.rsvpChangeRecorded, { kind: "reply_new" })).toBe(
      before + 1,
    );
  });

  it("logs nothing for a refused host-preview submit", async () => {
    const { publicId } = await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID, "cire-wedding")
        .pipe(Effect.provideService(DbService, db)),
    );
    const cookie = await cookieFor(publicId);
    const hostGuest = db
      .select({ id: guests.id, firstName: guests.firstName })
      .from(guests)
      .all()
      .find((g) => g.firstName === "Wedding")!.id;
    const res = await submit(cookie, [{ guestId: hostGuest, eventId: HINDU, status: "attending" }]);
    expect(res.status).toBe(403);
    expect(logged()).toEqual([]);
  });

  it("logs nothing for a submit refused after the deadline", async () => {
    db.update(weddings)
      .set({ rsvpDeadline: "2020-01-01", rsvpDeadlineTimezone: "UTC" })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    const cookie = await cookieFor(TESTONE_CODE);
    const res = await submit(cookie, [{ guestId: ADA, eventId: HINDU, status: "attending" }]);
    expect(res.status).toBe(403);
    expect(logged()).toEqual([]);
  });

  it("logs nothing for a submit naming another household's guest", async () => {
    const cookie = await cookieFor(TESTONE_CODE);
    const res = await submit(cookie, [
      { guestId: ADA, eventId: HINDU, status: "attending" },
      { guestId: BO, eventId: HINDU, status: "attending" },
    ]);
    expect(res.status).toBe(403);
    expect(logged()).toEqual([]);
  });

  it("logs nothing for dietary data sent without consent", async () => {
    const cookie = await cookieFor(TESTONE_CODE);
    const res = await submit(cookie, [
      { guestId: ADA, eventId: HINDU, status: "attending", dietary: "no nuts" },
    ]);
    expect(res.status).toBe(422);
    expect(logged()).toEqual([]);
  });

  it("logs nothing when the same dietary answer is sent again", async () => {
    const cookie = await cookieFor(TESTONE_CODE);
    const body = {
      rsvps: [
        {
          guestId: ADA,
          eventId: HINDU,
          status: "attending",
          dietary: "no shellfish please",
          dietaryPresets: ["nuts", "vegetarian"],
          dietaryConsent: true,
        },
      ],
    };
    const send = () =>
      appRequest(app, "/api/rsvp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify(body),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(logged().map((r) => r.kind)).toEqual(["reply_new"]);
  });

  it("never logs a reply an organiser records", async () => {
    const res = await appRequest(
      app,
      `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/guests/${ADA}/rsvps/${HINDU}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await auth.sign(OWNER)}`,
        },
        body: JSON.stringify({
          status: "attending",
          dietary: "",
          dietaryPresets: [],
          dietaryConsent: false,
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(logged()).toEqual([]);
  });
});
