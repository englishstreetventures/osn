import { describe, it, expect, afterEach, beforeAll } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guestAccountLinks,
  guests,
  rsvps,
  weddingFaqs,
  weddingInviteCustomisations,
  weddings,
} from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { createStaticFlags } from "@shared/feature-flags";
import { createRateLimiter } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { setExecutionCtx } from "../../src/lib/execution-ctx";
import { hostCodeService } from "../../src/services/host-code";
import { eff } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";

interface FamilyMember {
  guestId: string;
  firstName: string;
  lastName: string;
  eventIds: string[];
}

interface ClaimEvent {
  id: string;
  name: string;
}

interface ClaimOk {
  familyId: string;
  publicId: string;
  familyName: string;
  members: FamilyMember[];
  events: ClaimEvent[];
  rsvps: unknown[];
  rsvpDeadline: unknown;
  closing: { message: string | null };
  faq: { visible: boolean; entries: { question: string; answer: string }[] };
  preview: boolean;
  accountLink: unknown;
}

const db = createDb(":memory:");
const app = createApp(db, {
  claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
});

beforeAll(() => {
  seedDb(db);
});

// Tests simulate the Cloudflare edge by setting `cf-connecting-ip` — the
// fail-closed limiter (C4) denies requests without a resolvable IP, so every
// rate-limited route needs one in tests.
const post = (body: unknown) =>
  Effect.promise(() =>
    Promise.resolve(
      app.fetch(
        new Request("http://localhost/api/claim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": "203.0.113.7",
            Origin: "http://localhost:4321",
          },
          body: JSON.stringify(body),
        }),
      ),
    ),
  );

describe("POST /api/claim", () => {
  it(
    "returns 400 when fields are missing",
    eff(
      Effect.gen(function* () {
        const res = yield* post({});
        expect(res.status).toBe(400);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Missing or invalid fields");
      }),
    ),
  );

  it(
    "returns 400 when publicId is empty",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "" });
        expect(res.status).toBe(400);
      }),
    ),
  );

  it(
    "returns 401 for an unknown publicId",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "FAKE-XYZ-9999" });
        expect(res.status).toBe(401);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Invalid credentials");
      }),
    ),
  );

  it(
    "returns 200 with family details for valid publicId",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTONE-IVY-AA11" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.familyName).toBe("Testfamily");
        expect(data.members).toHaveLength(1);
        expect(data.members[0]!.firstName).toBe("Ada");
        expect(typeof data.members[0]!.guestId).toBe("string");
        expect(data.members[0]!.eventIds.toSorted()).toEqual(
          [eventsData.catholic.id, eventsData.reception.id, eventsData.hindu.id].toSorted(),
        );
        expect(data.events).toHaveLength(3);
      }),
    ),
  );

  it(
    "returns all five events for the default demo code TESTFOR-JOY-DD44",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTFOR-JOY-DD44" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.events.map((e) => e.id).toSorted()).toEqual(
          [
            eventsData.catholic.id,
            eventsData["kitchen-tea"].id,
            eventsData.mehendi.id,
            eventsData.hindu.id,
            eventsData.reception.id,
          ].toSorted(),
        );
        expect(data.events.find((e) => e.id === eventsData["kitchen-tea"].id)?.name).toBe(
          "Kitchen Tea",
        );
      }),
    ),
  );

  it(
    "returns 400 when the body is not valid JSON",
    eff(
      Effect.gen(function* () {
        const res = yield* Effect.promise(() =>
          Promise.resolve(
            app.fetch(
              new Request("http://localhost/api/claim", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "cf-connecting-ip": "203.0.113.7",
                  Origin: "http://localhost:4321",
                },
                body: "{not-json",
              }),
            ),
          ),
        );
        expect(res.status).toBe(400);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Missing or invalid fields");
      }),
    ),
  );

  it(
    "uppercases the publicId before lookup",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "testone-ivy-aa11" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.publicId).toBe("TESTONE-IVY-AA11");
      }),
    ),
  );

  it(
    "sets a Set-Cookie session header on a successful claim",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTONE-IVY-AA11" });
        expect(res.status).toBe(200);
        const setCookie = res.headers.get("Set-Cookie");
        expect(setCookie).not.toBeNull();
        expect(setCookie).toContain("cire_session=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).toContain("Path=/");
        expect(setCookie!.includes("Domain=")).toBe(false);
      }),
    ),
  );

  it(
    "exposes familyId on the claim response",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTONE-IVY-AA11" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(typeof data.familyId).toBe("string");
        expect(data.familyId.length).toBeGreaterThan(0);
      }),
    ),
  );
});

// The per-IP limiter must gate the real endpoint, not just exist as a
// plugin — a refactor that drops `.use(rateLimitMiddleware(...))` from
// `createClaimRoutes` should fail here.
describe("POST /api/claim rate limiting (S-C2)", () => {
  it("returns 429 with Retry-After once the per-IP limit is exhausted", async () => {
    const rlApp = createApp(db, {
      claimLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const send = () =>
      rlApp.fetch(
        new Request("http://localhost/api/claim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": "203.0.113.7",
            Origin: "http://localhost:4321",
          },
          body: JSON.stringify({ publicId: "FAKE-XYZ-9999" }),
        }),
      );

    const first = await send();
    expect(first.status).toBe(401); // unknown code — but it reached the handler

    const second = await send();
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("60");
  });
});

// migration 0019: each EventSummary carries imageUrl — the first-party path to
// the event's optional image (or null when none). The path's ?v= is the server-
// derived FNV digest of the R2 key, never the timestamp the wedding-slot images
// use (events have no updated_at).
describe("POST /api/claim event imageUrl (migration 0019)", () => {
  it("populates imageUrl for an event with a key, null for the rest", async () => {
    // Point one seeded event at an R2 key directly (no upload needed — the public
    // claim payload only needs the column populated).
    db.update(events)
      .set({ eventImageKey: "assets/wed_bootstrap/event-1234abcd" })
      .where(eq(events.id, eventsData.catholic.id))
      .run();

    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.7",
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify({ publicId: "TESTFOR-JOY-DD44" }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      events: { id: string; imageUrl: string | null }[];
    };
    const withImage = data.events.find((e) => e.id === eventsData.catholic.id);
    expect(withImage?.imageUrl).toContain(
      `/api/invite/cire-wedding/event/${eventsData.catholic.id}/image`,
    );
    expect(withImage?.imageUrl).toMatch(/\?v=[0-9a-f]+$/);

    // An event without a key reports null (graceful no-image collapse).
    const noImage = data.events.find((e) => e.id === eventsData.reception.id);
    expect(noImage?.imageUrl).toBeNull();

    // Cleanup so other tests on the shared db see no image.
    db.update(events)
      .set({ eventImageKey: null })
      .where(eq(events.id, eventsData.catholic.id))
      .run();
  });

  // The claim response is the DELIVERY BOUNDARY for the RSVP deadline — the
  // guest site reads it from here, not from the public invite payload. The
  // service's own tests assert what `lookup` returns; this asserts what
  // actually crosses the wire, so a future reshaping of the route's response
  // can't silently stop the deadline reaching guests (the invite would go back
  // to offering an open RSVP form while the server still refused the write).
  it("carries the wedding's RSVP deadline on the claim response", async () => {
    db.update(weddings)
      .set({
        rsvpDeadline: "2999-09-01",
        rsvpDeadlineTimezone: "Australia/Sydney",
        updatedAt: new Date(),
      })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();

    const res = await Effect.runPromise(post({ publicId: "TESTONE-IVY-AA11" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      rsvpDeadline: { date: string; timezone: string; closesAt: string; closed: boolean } | null;
    };
    expect(data.rsvpDeadline).toEqual({
      date: "2999-09-01",
      timezone: "Australia/Sydney",
      // End of the 1st in Sydney — the instant the guest site locks on.
      closesAt: "2999-09-01T13:59:59.999Z",
      closed: false,
    });

    // Cleanup: the suite shares one db, and a leaked deadline would change what
    // every later claim reports.
    db.update(weddings)
      .set({ rsvpDeadline: null, rsvpDeadlineTimezone: null, updatedAt: new Date() })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
  });

  it("reports no deadline when the wedding has none set", async () => {
    const res = await Effect.runPromise(post({ publicId: "TESTONE-IVY-AA11" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { rsvpDeadline: unknown };
    // Explicitly null on the wire, not absent — the guest site distinguishes
    // "no deadline" from "an older API that doesn't send the field" and treats
    // both as open, but only the first is a promise this endpoint makes.
    expect(data.rsvpDeadline).toBeNull();
  });
});

// The FAQ is written for the invited household, like the events: it rides the
// claim response and never the public invite read.
describe("POST /api/claim FAQ (migration 0064)", () => {
  const seedFaq = (id: string, question: string, sortOrder: number) =>
    db
      .insert(weddingFaqs)
      .values({
        id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        question,
        answer: `${question} — yes.`,
        sortOrder,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

  const setFaqSwitch = (faqVisible: boolean) =>
    db
      .insert(weddingInviteCustomisations)
      .values({ weddingId: BOOTSTRAP_WEDDING_ID, faqVisible, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: weddingInviteCustomisations.weddingId,
        set: { faqVisible, updatedAt: new Date() },
      })
      .run();

  const claimFaq = async () => {
    const res = await Effect.runPromise(post({ publicId: "TESTONE-IVY-AA11" }));
    expect(res.status).toBe(200);
    return ((await res.json()) as ClaimOk).faq;
  };

  // The suite shares one database, so a failed assertion must not leave entries
  // or a switched-off FAQ behind for the next test.
  afterEach(() => {
    db.delete(weddingFaqs).where(eq(weddingFaqs.weddingId, BOOTSTRAP_WEDDING_ID)).run();
    setFaqSwitch(true);
  });

  it("carries the entries in the organiser's order", async () => {
    seedFaq("faq_route_b", "Parking?", 1);
    seedFaq("faq_route_a", "Children?", 0);
    expect(await claimFaq()).toEqual({
      visible: true,
      // The text alone: the id is what the builder edits by, not the guest page.
      entries: [
        { question: "Children?", answer: "Children? — yes." },
        { question: "Parking?", answer: "Parking? — yes." },
      ],
    });
  });

  it("sends the switch and no entries while the FAQ is switched off", async () => {
    seedFaq("faq_route_off", "Parking?", 0);
    setFaqSwitch(false);
    expect(await claimFaq()).toEqual({ visible: false, entries: [] });
  });

  it("reports an empty FAQ as switched on with no entries", async () => {
    expect(await claimFaq()).toEqual({ visible: true, entries: [] });
  });

  it("never puts the entries on the public invite read", async () => {
    seedFaq("faq_route_public", "A question only guests with a code see", 0);
    const res = await app.fetch(new Request("http://localhost/api/invite/cire-wedding"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("A question only guests with a code see");
    expect(Object.keys(JSON.parse(text) as object)).not.toContain("faq");
  });
});

// ── GET /api/claim/session ────────────────────────────────────────────────────
// The restore read. Its whole job is to hand a household that ALREADY proved
// membership the same payload `POST /api/claim` gives, without a second code
// entry — so the tests below pin both halves: it returns the identical view,
// and it never becomes a second way IN.

describe("GET /api/claim/session", () => {
  const sessionApp = createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    claimSessionLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });

  const claimFor = async (publicId: string) => {
    const res = await sessionApp.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify({ publicId }),
      }),
    );
    const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    return { body: (await res.json()) as ClaimOk, cookie };
  };

  // The seed wedding's slug — the restore is scoped to the wedding the page is
  // rendering, so every call names one.
  const SLUG = "cire-wedding";

  const getSession = (cookie?: string, slug: string | null = SLUG) =>
    sessionApp.fetch(
      new Request(
        `http://localhost/api/claim/session${slug === null ? "" : `?slug=${encodeURIComponent(slug)}`}`,
        {
          headers: {
            "cf-connecting-ip": "203.0.113.9",
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
      ),
    );

  it("returns 401 with no session cookie", async () => {
    const res = await getSession();
    expect(res.status).toBe(401);
  });

  it("returns 401 for a bogus session token", async () => {
    const res = await getSession("cire_session=not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns the same invite the claim did — whole payload, not a subset", async () => {
    // Seed the fields a bare fixture leaves empty, so the comparison below is
    // not `[] === []` on the parts guests care most about: an existing RSVP
    // (what pre-fills the modal on a return visit), a deadline (whose banner
    // must be computed by the same function as the write path's 403) and a
    // closing note (the credential-gated section whose ONLY delivery point is
    // this payload). Without the seed a regression that emptied `rsvps` would pass.
    const { body: seedClaim } = await claimFor("TESTONE-IVY-AA11");
    const guestId = seedClaim.members[0]!.guestId;
    const eventId = (seedClaim.events[0] as { id: string }).id;
    db.insert(rsvps)
      .values({
        id: "rsvp_restore_parity",
        guestId,
        eventId,
        status: "attending",
        dietary: "no shellfish",
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
    db.update(weddings)
      .set({ rsvpDeadline: "2999-09-01", rsvpDeadlineTimezone: "Australia/Sydney" })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    db.insert(weddingInviteCustomisations)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        footerMessage: "With love, always",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: weddingInviteCustomisations.weddingId,
        set: { footerMessage: "With love, always", updatedAt: new Date() },
      })
      .run();
    db.insert(weddingFaqs)
      .values({
        id: "faq_restore_parity",
        weddingId: BOOTSTRAP_WEDDING_ID,
        question: "Is there parking?",
        answer: "Yes.",
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const { body: claimed, cookie } = await claimFor("TESTONE-IVY-AA11");
    const res = await getSession(cookie);
    expect(res.status).toBe(200);
    const restored = (await res.json()) as ClaimOk;

    // Sanity: the seed actually landed, so the parity assertion is non-vacuous.
    expect(claimed.rsvps.length).toBeGreaterThan(0);
    expect(claimed.rsvpDeadline).not.toBeNull();
    expect(claimed.closing.message).toBe("With love, always");
    expect(claimed.faq.entries).toHaveLength(1);

    // Whole-object, not field-by-field: `buildClaimResponse` exists so the two
    // entry points cannot drift, and this pins every field ClaimResponse gains.
    expect(restored).toEqual(claimed);

    db.delete(rsvps).where(eq(rsvps.id, "rsvp_restore_parity")).run();
    db.delete(weddingFaqs).where(eq(weddingFaqs.id, "faq_restore_parity")).run();
    db.update(weddings)
      .set({ rsvpDeadline: null, rsvpDeadlineTimezone: null })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
  });

  it("emits no Set-Cookie on the success path — a restore is a read, not a renewal", async () => {
    const { cookie } = await claimFor("TESTONE-IVY-AA11");
    const res = await getSession(cookie);
    expect(res.status).toBe(200);
    // Pinning the absence deliberately: this route runs on every invite page
    // load, so a sliding-window renewal creeping in here would turn a 30-day
    // session into an effectively immortal one.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("accepts NO claim code — it is a restore, not a second credential surface", async () => {
    const { body: one } = await claimFor("TESTONE-IVY-AA11");
    const { cookie: cookieFour } = await claimFor("TESTFOR-JOY-DD44");

    // A caller holding family four's session cannot name family one, by query
    // string or by body: the route reads only the cookie-derived family id.
    const res = await sessionApp.fetch(
      new Request(`http://localhost/api/claim/session?slug=${SLUG}&publicId=TESTONE-IVY-AA11`, {
        headers: { "cf-connecting-ip": "203.0.113.9", Cookie: cookieFour },
      }),
    );
    expect(res.status).toBe(200);
    const restored = (await res.json()) as ClaimOk;
    expect(restored.familyId).not.toBe(one.familyId);
    expect(restored.publicId).toBe("TESTFOR-JOY-DD44");
  });

  it("401s and CLEARS the cookie once the family is deactivated", async () => {
    const { cookie, body } = await claimFor("TESTFOR-JOY-DD44");
    // Sanity: the session works before the withdrawal.
    expect((await getSession(cookie)).status).toBe(200);

    db.update(families)
      .set({ deactivatedAt: new Date() })
      .where(eq(families.id, body.familyId))
      .run();

    const res = await getSession(cookie);
    expect(res.status).toBe(401);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toContain("cire_session=");
    expect(setCookie).toContain("Max-Age=0");

    // Restore the fixture for any later test in this file.
    db.update(families).set({ deactivatedAt: null }).where(eq(families.id, body.familyId)).run();
  });

  it("never caches — the payload is selected entirely by the cookie", async () => {
    const { cookie } = await claimFor("TESTONE-IVY-AA11");
    const res = await getSession(cookie);
    expect(res.status).toBe(200);
    // The body carries guest names, per-event dietary free text (Art. 9) and the
    // credential-gated closing note. `no-store` keeps it out of every cache whatever a
    // future page rule says; `Vary: Cookie` stops any cache that ignores that
    // from replaying one household's invite to another.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toContain("Cookie");
  });

  it("carries the no-store headers on the 401 path too", async () => {
    const res = await getSession();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("400s without a slug — an unscoped restore has no correct answer", async () => {
    const { cookie } = await claimFor("TESTONE-IVY-AA11");
    const res = await getSession(cookie, null);
    expect(res.status).toBe(400);
  });

  it("refuses a session belonging to a DIFFERENT wedding, without clearing it", async () => {
    // The guest site serves every wedding from one origin, so a guest holding
    // wedding A's session can open wedding B's link. Restoring there would paint
    // A's events into B's shell — and an RSVP sent from that state writes to A's
    // events while the guest believes they answered B's.
    const { cookie } = await claimFor("TESTONE-IVY-AA11");
    db.insert(weddings)
      .values({
        id: "wed_other_restore",
        slug: "someone-elses-wedding",
        displayName: "Other Wedding",
        ownerOsnProfileId: "prof_other",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .run();

    const res = await getSession(cookie, "someone-elses-wedding");
    expect(res.status).toBe(401);
    // The session is perfectly valid — just not for this wedding. Clearing it
    // would sign a guest out of their OWN invite for opening someone else's link.
    expect(res.headers.get("Set-Cookie")).toBeNull();

    // ...and it still restores on its own wedding.
    expect((await getSession(cookie)).status).toBe(200);

    db.delete(weddings).where(eq(weddings.id, "wed_other_restore")).run();
  });

  it("does not burn the claim endpoint's brute-force budget", async () => {
    // A tight claim limiter alongside a normal session limiter: the restore
    // must not be gated by the credential-surface budget, or a household
    // reloading its invite would 429 itself.
    const tightApp = createApp(db, {
      claimLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
      claimSessionLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    });
    const claimRes = await tightApp.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.22",
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
      }),
    );
    expect(claimRes.status).toBe(200);
    const cookie = claimRes.headers.get("Set-Cookie")!.split(";")[0]!;

    // The claim budget (1/min) is now spent — the restore is unaffected.
    for (let i = 0; i < 5; i++) {
      const res = await tightApp.fetch(
        new Request(`http://localhost/api/claim/session?slug=${SLUG}`, {
          headers: { "cf-connecting-ip": "203.0.113.22", Cookie: cookie },
        }),
      );
      expect(res.status).toBe(200);
    }
  });

  it("restore traffic does not lock a household out of claiming", async () => {
    // The mirror of the test above. Both directions are needed: a single shared
    // limiter satisfies the first test (it only ever spends the claim side)
    // while breaking this one — page-load traffic from a household behind NAT
    // would exhaust the shared bucket and 429 a legitimate claim.
    const tightApp = createApp(db, {
      claimLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
      claimSessionLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const ip = "203.0.113.44";
    const session = () =>
      tightApp.fetch(
        new Request(`http://localhost/api/claim/session?slug=${SLUG}`, {
          headers: { "cf-connecting-ip": ip },
        }),
      );
    await session();
    expect((await session()).status).toBe(429);

    const claimRes = await tightApp.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": ip,
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify({ publicId: "TESTONE-IVY-AA11" }),
      }),
    );
    expect(claimRes.status).toBe(200);
  });

  it("enforces its own limiter once that budget is spent", async () => {
    const cappedApp = createApp(db, {
      claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
      claimSessionLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
    });
    const req = () =>
      cappedApp.fetch(
        new Request(`http://localhost/api/claim/session?slug=${SLUG}`, {
          headers: { "cf-connecting-ip": "203.0.113.33" },
        }),
      );
    await req();
    await req();
    expect((await req()).status).toBe(429);
  });
});

describe("POST /api/claim/signout", () => {
  const signoutApp = createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
    claimSessionLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });

  const SLUG = "cire-wedding";

  const claimFor = async (publicId: string) => {
    const res = await signoutApp.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.11",
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify({ publicId }),
      }),
    );
    return res.headers.get("Set-Cookie")!.split(";")[0]!;
  };

  const signout = (cookie?: string) =>
    signoutApp.fetch(
      new Request("http://localhost/api/claim/signout", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          Origin: "http://localhost:4321",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }),
    );

  const getSession = (cookie: string) =>
    signoutApp.fetch(
      new Request(`http://localhost/api/claim/session?slug=${SLUG}`, {
        headers: { "cf-connecting-ip": "203.0.113.11", Cookie: cookie },
      }),
    );

  it("revokes the session so the restore no longer resolves", async () => {
    const cookie = await claimFor("TESTONE-IVY-AA11");
    // Precondition: the cookie really does open the invite.
    expect((await getSession(cookie)).status).toBe(200);

    const res = await signout(cookie);
    expect(res.status).toBe(204);
    // The cookie is cleared in the browser…
    expect(res.headers.get("Set-Cookie")).toContain("cire_session=");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");

    // …and the token is dead SERVER-side, which is the half that matters. A
    // cleared cookie alone would leave a live credential for anyone who
    // captured the token; this is what makes the control a real sign-out
    // rather than the local-state reset it started as.
    expect((await getSession(cookie)).status).toBe(401);
  });

  it("is idempotent — a second sign-out with the dead cookie still answers 204", async () => {
    const cookie = await claimFor("TESTTWO-OAK-BB22");
    expect((await signout(cookie)).status).toBe(204);

    // Deliberately NOT 401. The route mounts no `sessionAuth`: the case that
    // most needs to succeed is a stale cookie still sitting in a browser, and
    // answering 401 there would leave it in place.
    const second = await signout(cookie);
    expect(second.status).toBe(204);
    expect(second.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("answers 204 and still clears the cookie with no session at all", async () => {
    const res = await signout();
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("does not revoke a DIFFERENT household's session", async () => {
    const mine = await claimFor("TESTONE-IVY-AA11");
    const theirs = await claimFor("TESTTWO-OAK-BB22");

    expect((await signout(mine)).status).toBe(204);

    // Signing out is scoped to the token presented — nothing else.
    expect((await getSession(theirs)).status).toBe(200);
  });

  it("is covered by the origin guard like every other state-changing POST", async () => {
    const cookie = await claimFor("TESTONE-IVY-AA11");
    const res = await signoutApp.fetch(
      new Request("http://localhost/api/claim/signout", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          Origin: "https://evil.example",
          Cookie: cookie,
        },
      }),
    );
    expect(res.status).toBe(403);
    // And the session survives a blocked cross-origin attempt.
    expect((await getSession(cookie)).status).toBe(200);
  });
});

// The account-link state rides both responses so the guest site draws the
// account-link box in the same pass as the welcome panel, without asking for
// it. Linking is offered only when the flag is on AND the deployment can
// complete a link (an ARC resolver); `signedIn` reflects the OSN sign-in cookie
// a link is made with.
describe("account-link state on POST /api/claim and GET /api/claim/session", () => {
  const SLUG = "cire-wedding";
  const IP = "203.0.113.21";

  function buildApp(opts: { flag: boolean; canLink?: boolean }) {
    const linkDb = createDb(":memory:");
    seedDb(linkDb);
    const linkApp = createApp(linkDb, {
      claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
      claimSessionLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
      flags: createStaticFlags({ "cire.account-linking": opts.flag }),
      resolveOsnAccountId:
        opts.canLink === false ? undefined : async () => ({ ok: true, accountId: "acc_secret" }),
    });
    return { linkDb, linkApp };
  }

  async function claim(
    linkApp: ReturnType<typeof createApp>,
    publicId: string,
    cookie?: string,
  ): Promise<{ body: ClaimOk; household: string }> {
    const res = await linkApp.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": IP,
          Origin: "http://localhost:4321",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({ publicId }),
      }),
    );
    expect(res.status).toBe(200);
    return {
      body: (await res.json()) as ClaimOk,
      household: res.headers.get("Set-Cookie")!.split(";")[0]!,
    };
  }

  async function restore(linkApp: ReturnType<typeof createApp>, cookie: string) {
    const res = await linkApp.fetch(
      new Request(`http://localhost/api/claim/session?slug=${SLUG}`, {
        headers: { "cf-connecting-ip": IP, Cookie: cookie },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as ClaimOk;
  }

  function linkSeat(linkDb: ReturnType<typeof createDb>, firstName: string): string {
    const [guest] = linkDb
      .select({ id: guests.id, familyId: guests.familyId, weddingId: families.weddingId })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(and(eq(guests.firstName, firstName), eq(families.publicId, "TESTTWO-OAK-BB22")))
      .all();
    const now = new Date();
    linkDb
      .insert(guestAccountLinks)
      .values({
        id: `gal_${firstName}`,
        guestId: guest!.id,
        familyId: guest!.familyId,
        weddingId: guest!.weddingId,
        osnAccountId: "acc_secret",
        osnProfileId: "usr_secret",
        linkedAt: now,
        updatedAt: now,
      })
      .run();
    return guest!.id;
  }

  it("keeps the claim response out of every cache, as the restore does", async () => {
    // Both carry the same payload, and it now depends on a second cookie.
    const { linkApp } = buildApp({ flag: true });
    const res = await linkApp.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": IP,
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify({ publicId: "TESTTWO-OAK-BB22" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("Origin, Cookie");
  });

  it("keeps a slow flag refresh alive past the response that stopped waiting for it", async () => {
    // The payload stops waiting for the flag after its cap, but the refresh it
    // started is shared with every later request in the isolate. On Workers a
    // finished request's outstanding I/O is cancelled unless it was handed to
    // `waitUntil`, which would leave that shared refresh unsettled for good.
    let release!: (on: boolean) => void;
    const slowFlag = new Promise<boolean>((resolve) => (release = resolve));
    const linkDb = createDb(":memory:");
    seedDb(linkDb);
    const linkApp = createApp(linkDb, {
      claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
      resolveOsnAccountId: async () => ({ ok: true, accountId: "acc_secret" }),
      flags: {
        forRequest: async () => {
          const on = await slowFlag;
          return { isOn: () => on, getValue: () => false };
        },
      },
    });
    const request = new Request("http://localhost/api/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": IP,
        Origin: "http://localhost:4321",
      },
      body: JSON.stringify({ publicId: "TESTTWO-OAK-BB22" }),
    });
    const kept: Promise<unknown>[] = [];
    setExecutionCtx(request, { waitUntil: (promise) => kept.push(promise) });

    const res = await linkApp.fetch(request);
    const body = (await res.json()) as ClaimOk;
    // The response did not wait for the flag.
    expect(body.accountLink).toEqual({ enabled: false });
    // The flag check was handed to the request's context, and settles later.
    expect(kept).toHaveLength(1);
    release(true);
    expect(await kept[0]).toBe(true);
  });

  it("reports linking off on both responses while the flag is off", async () => {
    const { linkApp } = buildApp({ flag: false });
    const { body, household } = await claim(linkApp, "TESTTWO-OAK-BB22");
    expect(body.accountLink).toEqual({ enabled: false });
    expect((await restore(linkApp, household)).accountLink).toEqual({ enabled: false });
  });

  it("reports linking off when the deployment cannot complete a link", async () => {
    const { linkApp } = buildApp({ flag: true, canLink: false });
    const { body } = await claim(linkApp, "TESTTWO-OAK-BB22");
    expect(body.accountLink).toEqual({ enabled: false });
  });

  it("carries the linked seats, signed out, with no OSN sign-in cookie", async () => {
    const { linkDb, linkApp } = buildApp({ flag: true });
    const bo = linkSeat(linkDb, "Bo");
    const { body, household } = await claim(linkApp, "TESTTWO-OAK-BB22");
    expect(body.accountLink).toEqual({ enabled: true, signedIn: false, linkedGuestIds: [bo] });
    expect((await restore(linkApp, household)).accountLink).toEqual(body.accountLink);
  });

  it("reports signed in when the request carries a live OSN sign-in", async () => {
    const { linkDb, linkApp } = buildApp({ flag: true });
    const bo = linkSeat(linkDb, "Bo");
    const osn = `cire_org_session=${await seedOrganiserSession(linkDb, "usr_guest")}`;

    const { body, household } = await claim(linkApp, "TESTTWO-OAK-BB22", osn);
    expect(body.accountLink).toEqual({ enabled: true, signedIn: true, linkedGuestIds: [bo] });

    // The restore carries both cookies, as the browser sends them.
    const restored = await restore(linkApp, `${household}; ${osn}`);
    expect(restored.accountLink).toEqual(body.accountLink);

    // Neither response names the OSN account or profile behind a link.
    expect(JSON.stringify(body)).not.toContain("acc_secret");
    expect(JSON.stringify(body)).not.toContain("usr_secret");
    expect(JSON.stringify(restored)).not.toContain("acc_secret");
  });

  it("reports signed out for an OSN sign-in cookie that is not a live session", async () => {
    const { linkApp } = buildApp({ flag: true });
    const { body } = await claim(linkApp, "TESTTWO-OAK-BB22", "cire_org_session=not-a-session");
    expect(body.accountLink).toEqual({ enabled: true, signedIn: false, linkedGuestIds: [] });
  });

  it("never offers linking to the host preview, even with the organiser signed in", async () => {
    const { linkDb, linkApp } = buildApp({ flag: true });
    const { publicId } = await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID, SLUG)
        .pipe(Effect.provideService(DbService, linkDb)),
    );
    // The organiser opening their own preview holds a live OSN session, and
    // the browser sends it with the preview claim.
    const osn = `cire_org_session=${await seedOrganiserSession(linkDb, "usr_owner")}`;

    const { body } = await claim(linkApp, publicId, osn);
    expect(body.preview).toBe(true);
    expect(body.accountLink).toEqual({ enabled: false });
  });
});
