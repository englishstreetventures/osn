import { describe, it, expect } from "bun:test";

import {
  families,
  guestAccountLinks,
  guestEvents,
  guests,
  rsvpChanges,
  rsvps,
  sessions,
} from "@cire/db";
import { createStaticFlags } from "@shared/feature-flags";
import { createRateLimiter } from "@shared/rate-limit";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { organiserSessionService } from "../../src/services/organiser-session";
import type { OsnAccountResolver } from "../../src/services/osn-bridge";
import { rsvpService } from "../../src/services/rsvp";
import { jsonBody } from "../test-helpers";
import { seedPlusOne } from "../test-helpers/plus-one";

// Seeded families (cire/db/seed/data/guests.ts):
//   TESTONE-IVY-AA11 Testfamily → Ada
//   TESTTWO-OAK-BB22 Sampleton  → Bo, Cleo, Dot
const TESTFAMILY = "TESTONE-IVY-AA11";
const SAMPLETON = "TESTTWO-OAK-BB22";
const SLUG = "cire-wedding";
const IP = "203.0.113.7";
const ORIGIN = "http://localhost:4321";

/** Any profile resolves to its own account, so only a same-profile sign-in matches. */
const ownAccount: OsnAccountResolver = async (profileId) => ({
  ok: true,
  accountId: `acc_${profileId}`,
});

function buildApp(flagOn = true, resolver: OsnAccountResolver = ownAccount) {
  const db = createDb(":memory:");
  seedDb(db);
  const limiter = () => createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 });
  const app = createApp(db, {
    claimLimiter: limiter(),
    claimSessionLimiter: limiter(),
    rsvpLimiter: limiter(),
    plusOneLimiter: limiter(),
    accountLinkLimiter: limiter(),
    resolveOsnAccountId: resolver,
    osnIssuerUrl: "https://id.musubi.test",
    flags: createStaticFlags({ "cire.account-linking": flagOn }),
  });
  return { db, app };
}

type App = ReturnType<typeof createApp>;

function guestId(db: TestDb, firstName: string): string {
  const row = db
    .select({ id: guests.id })
    .from(guests)
    .where(eq(guests.firstName, firstName))
    .get();
  if (!row) throw new Error(`no seeded guest named ${firstName}`);
  return row.id;
}

function firstEventOf(db: TestDb, id: string): string {
  const row = db
    .select({ eventId: guestEvents.eventId })
    .from(guestEvents)
    .where(eq(guestEvents.guestId, id))
    .get();
  if (!row) throw new Error("guest has no invitation");
  return row.eventId;
}

async function claim(app: App, publicId: string): Promise<{ cookie: string; body: unknown }> {
  const res = await app.fetch(
    new Request("http://localhost/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": IP, Origin: ORIGIN },
      body: JSON.stringify({ publicId }),
    }),
  );
  expect(res.status).toBe(200);
  const token = parseSessionToken(res.headers.get("Set-Cookie"));
  return { cookie: `cire_session=${token}`, body: await jsonBody(res) };
}

function call(app: App, method: string, path: string, cookie: string | null, body?: unknown) {
  const headers: Record<string, string> = { "cf-connecting-ip": IP, Origin: ORIGIN };
  if (cookie) headers["Cookie"] = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const restore = (app: App, cookie: string) =>
  call(app, "GET", `/api/claim/session?slug=${SLUG}`, cookie);

/** A live `cire_org_session` for `profileId`, as the OIDC callback mints it. */
async function signIn(
  db: TestDb,
  profileId: string,
  avatarUrl = "https://id.musubi.test/avatars/alice.png",
): Promise<string> {
  const { token } = await Effect.runPromise(
    organiserSessionService
      .create({
        osnProfileId: profileId,
        osnSub: `sub_${profileId}`,
        email: null,
        handle: "alice",
        displayName: "Alice A",
        avatarUrl,
      })
      .pipe(Effect.provideService(DbService, db)),
  );
  return `cire_org_session=${token}`;
}

function linkRow(db: TestDb, guest: string, profileId: string) {
  const now = new Date();
  const family = db
    .select({ familyId: guests.familyId, weddingId: families.weddingId })
    .from(guests)
    .innerJoin(families, eq(families.id, guests.familyId))
    .where(eq(guests.id, guest))
    .get()!;
  db.insert(guestAccountLinks)
    .values({
      id: `gal_${crypto.randomUUID()}`,
      guestId: guest,
      familyId: family.familyId,
      weddingId: family.weddingId,
      osnAccountId: `acc_${profileId}`,
      osnProfileId: profileId,
      linkedAt: now,
      updatedAt: now,
    })
    .run();
}

describe("claim payload", () => {
  it("names no member for a household of several, and the one member of a household of one", async () => {
    const { db, app } = buildApp();
    const several = await claim(app, SAMPLETON);
    expect((several.body as { member: unknown }).member).toBeNull();
    const one = await claim(app, TESTFAMILY);
    expect((one.body as { member: unknown }).member).toEqual({ guestId: guestId(db, "Ada") });
    // The session starts with that member.
    const rows = db.select({ member: sessions.memberGuestId }).from(sessions).all();
    expect(rows.map((r) => r.member)).toContain(guestId(db, "Ada"));
  });

  it("leaves the payload as it was with the flag off", async () => {
    const { app } = buildApp(false);
    const { body } = await claim(app, TESTFAMILY);
    expect(body).not.toHaveProperty("member");
  });

  it("chooses the one member on restore when the session has none", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, TESTFAMILY);
    db.update(sessions).set({ memberGuestId: null }).run();
    const res = await restore(app, cookie);
    expect(((await jsonBody(res)) as { member: unknown }).member).toEqual({
      guestId: guestId(db, "Ada"),
    });
    expect(db.select({ member: sessions.memberGuestId }).from(sessions).get()?.member).toBe(
      guestId(db, "Ada"),
    );
  });
});

describe("POST / DELETE /api/claim/member", () => {
  it("records the household's own member and answers with the link state", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const res = await call(app, "POST", "/api/claim/member", cookie, {
      guestId: guestId(db, "Bo"),
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      member: { guestId: guestId(db, "Bo") },
      accountLink: { enabled: true, signedIn: false, linkedGuestIds: [] },
    });
    const restored = (await jsonBody(await restore(app, cookie))) as { member: unknown };
    expect(restored.member).toEqual({ guestId: guestId(db, "Bo") });
  });

  it("refuses another household's guest, a plus-one, and no session", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const other = await call(app, "POST", "/api/claim/member", cookie, {
      guestId: guestId(db, "Ada"),
    });
    expect(other.status).toBe(403);
    expect(await jsonBody(other)).toEqual({ error: "not_household_member" });

    const sam = seedPlusOne(db, guestId(db, "Bo"), { firstName: "Sam" });
    const plusOne = await call(app, "POST", "/api/claim/member", cookie, { guestId: sam });
    expect(plusOne.status).toBe(403);
    expect(await jsonBody(plusOne)).toEqual({ error: "plus_one_seat" });

    const none = await call(app, "POST", "/api/claim/member", null, { guestId: guestId(db, "Bo") });
    expect(none.status).toBe(401);
  });

  it("answers 400 to a missing, mistyped or non-JSON body", async () => {
    const { app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    for (const body of [{}, { guestId: 123 }, { guestId: "" }]) {
      const res = await call(app, "POST", "/api/claim/member", cookie, body);
      expect(res.status).toBe(400);
    }
    const raw = await app.fetch(
      new Request("http://localhost/api/claim/member", {
        method: "POST",
        headers: { Cookie: cookie, "cf-connecting-ip": IP, Origin: ORIGIN },
        body: "not json",
      }),
    );
    expect(raw.status).toBe(400);
  });

  it("answers 401 to a cookie naming no live session, and DELETE clears nothing else", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    const bad = "cire_session=not-a-real-token";
    const post = await call(app, "POST", "/api/claim/member", bad, { guestId: guestId(db, "Bo") });
    expect(post.status).toBe(401);
    expect((await call(app, "DELETE", "/api/claim/member", bad)).status).toBe(401);
    expect(db.select({ member: sessions.memberGuestId }).from(sessions).get()?.member).toBe(
      guestId(db, "Bo"),
    );
  });

  it("answers 404 with the flag off", async () => {
    const { db, app } = buildApp(false);
    const { cookie } = await claim(app, SAMPLETON);
    const res = await call(app, "POST", "/api/claim/member", cookie, {
      guestId: guestId(db, "Bo"),
    });
    expect(res.status).toBe(404);
  });

  it("clears the choice, idempotently, and keeps the household claimed", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    expect((await call(app, "DELETE", "/api/claim/member", cookie)).status).toBe(204);
    expect((await call(app, "DELETE", "/api/claim/member", cookie)).status).toBe(204);
    const res = await restore(app, cookie);
    expect(res.status).toBe(200);
    expect(((await jsonBody(res)) as { member: unknown }).member).toBeNull();
  });
});

describe("DELETE /api/claim/member when the write fails", () => {
  it("answers 500, so the page does not show a member it did not clear", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    db.run(
      sql`CREATE TRIGGER refuse_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    const res = await call(app, "DELETE", "/api/claim/member", cookie);
    expect(res.status).toBe(500);
    expect(db.select({ member: sessions.memberGuestId }).from(sessions).get()?.member).toBe(
      guestId(db, "Bo"),
    );
  });
});

describe("return visit: the account the box may show", () => {
  type Link = { signedIn: boolean; account?: Record<string, unknown> };

  async function linkState(app: App, cookie: string): Promise<Link> {
    const body = (await jsonBody(await restore(app, cookie))) as { accountLink: Link };
    return body.accountLink;
  }

  it("shows this browser's account for an unlinked member", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    const org = await signIn(db, "usr_alice");
    const state = await linkState(app, `${cookie}; ${org}`);
    expect(state.account).toEqual({
      displayName: "Alice A",
      handle: "alice",
      avatarUrl: "https://id.musubi.test/avatars/alice.png",
      matchesMember: false,
    });
  });

  it("drops a picture from any host but musubi's own", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    const org = await signIn(db, "usr_alice", "https://tracker.example/pixel.png");
    const state = await linkState(app, `${cookie}; ${org}`);
    expect(state.account?.["avatarUrl"]).toBeNull();
    expect(state.account?.["handle"]).toBe("alice");
  });

  it("shows it, matched, for a member linked to this account", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    linkRow(db, guestId(db, "Bo"), "usr_alice");
    const org = await signIn(db, "usr_alice");
    const state = await linkState(app, `${cookie}; ${org}`);
    expect(state.account?.["matchesMember"]).toBe(true);
  });

  it("shows no account for a member linked to a different one", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    linkRow(db, guestId(db, "Bo"), "usr_bob");
    const org = await signIn(db, "usr_alice");
    const state = await linkState(app, `${cookie}; ${org}`);
    expect(state.signedIn).toBe(true);
    expect(state).not.toHaveProperty("account");
  });

  it("matches across profiles of one account, and reads an ARC failure as a mismatch", async () => {
    const sameAccount: OsnAccountResolver = async () => ({ ok: true, accountId: "acc_usr_bob" });
    const shared = buildApp(true, sameAccount);
    const a = await claim(shared.app, SAMPLETON);
    await call(shared.app, "POST", "/api/claim/member", a.cookie, {
      guestId: guestId(shared.db, "Bo"),
    });
    linkRow(shared.db, guestId(shared.db, "Bo"), "usr_bob");
    const org = await signIn(shared.db, "usr_alice");
    expect((await linkState(shared.app, `${a.cookie}; ${org}`)).account?.["matchesMember"]).toBe(
      true,
    );

    const down = buildApp(true, async () => {
      throw new Error("ECONNREFUSED");
    });
    const b = await claim(down.app, SAMPLETON);
    await call(down.app, "POST", "/api/claim/member", b.cookie, {
      guestId: guestId(down.db, "Bo"),
    });
    linkRow(down.db, guestId(down.db, "Bo"), "usr_bob");
    const org2 = await signIn(down.db, "usr_alice");
    const state = await linkState(down.app, `${b.cookie}; ${org2}`);
    expect(state.signedIn).toBe(true);
    expect(state).not.toHaveProperty("account");
  });

  it("reads a resolver that never answers as a mismatch, within the wait", async () => {
    const stalled = buildApp(true, () => new Promise(() => {}));
    const a = await claim(stalled.app, SAMPLETON);
    await call(stalled.app, "POST", "/api/claim/member", a.cookie, {
      guestId: guestId(stalled.db, "Bo"),
    });
    linkRow(stalled.db, guestId(stalled.db, "Bo"), "usr_bob");
    const org = await signIn(stalled.db, "usr_alice");
    const started = Date.now();
    const state = await linkState(stalled.app, `${a.cookie}; ${org}`);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(state).not.toHaveProperty("account");
  });

  it("asks osn-api once for a profile across repeat restores", async () => {
    const asked: string[] = [];
    const counted: OsnAccountResolver = async (profileId) => {
      asked.push(profileId);
      return { ok: true, accountId: "acc_usr_bob" };
    };
    const { db, app } = buildApp(true, counted);
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    linkRow(db, guestId(db, "Bo"), "usr_bob");
    const org = await signIn(db, "usr_alice");
    asked.length = 0;
    expect((await linkState(app, `${cookie}; ${org}`)).account?.["matchesMember"]).toBe(true);
    expect((await linkState(app, `${cookie}; ${org}`)).account?.["matchesMember"]).toBe(true);
    expect(asked).toEqual(["usr_alice"]);
  });

  it("aborts the lookup's request once the wait is over", async () => {
    let signal: AbortSignal | undefined;
    const stalled = buildApp(true, (_profileId, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    });
    const a = await claim(stalled.app, SAMPLETON);
    await call(stalled.app, "POST", "/api/claim/member", a.cookie, {
      guestId: guestId(stalled.db, "Bo"),
    });
    linkRow(stalled.db, guestId(stalled.db, "Bo"), "usr_bob");
    const org = await signIn(stalled.db, "usr_alice");
    signal = undefined;
    await linkState(stalled.app, `${a.cookie}; ${org}`);
    expect(signal?.aborted).toBe(true);
  });

  it("shows no account when signed out", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    await call(app, "POST", "/api/claim/member", cookie, { guestId: guestId(db, "Bo") });
    linkRow(db, guestId(db, "Bo"), "usr_alice");
    const state = await linkState(app, cookie);
    expect(state.signedIn).toBe(false);
    expect(state).not.toHaveProperty("account");
  });
});

describe("POST /api/rsvp and the member step", () => {
  const reply = (guest: string, eventId: string) => ({
    rsvps: [
      {
        guestId: guest,
        eventId,
        status: "attending",
        dietary: "",
        dietaryPresets: [],
        dietaryConsent: false,
      },
    ],
  });

  it("refuses a household of several that has chosen no one (409 member_required)", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    const res = await call(app, "POST", "/api/rsvp", cookie, reply(bo, firstEventOf(db, bo)));
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "member_required" });
    expect(db.select().from(rsvps).all()).toHaveLength(0);
  });

  it("asks no choice of one member who brought a plus-one", async () => {
    const { db, app } = buildApp();
    const ada = guestId(db, "Ada");
    seedPlusOne(db, ada, { firstName: "Sam" });
    const { cookie, body } = await claim(app, TESTFAMILY);
    expect((body as { member: unknown }).member).toEqual({ guestId: ada });
    const res = await call(app, "POST", "/api/rsvp", cookie, reply(ada, firstEventOf(db, ada)));
    expect(res.status).toBe(200);
    expect(db.select().from(rsvps).get()?.submittedByGuestId).toBe(ada);
  });

  it("stamps the sender on the reply, its change row and the read-back", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    const cleo = guestId(db, "Cleo");
    await call(app, "POST", "/api/claim/member", cookie, { guestId: cleo });
    const res = await call(app, "POST", "/api/rsvp", cookie, reply(bo, firstEventOf(db, bo)));
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as { rsvps: { submittedBy: unknown }[] };
    expect(body.rsvps[0]?.submittedBy).toEqual({ guestId: cleo, firstName: "Cleo" });
    const row = db.select().from(rsvps).get();
    expect(row?.submittedByGuestId).toBe(cleo);
    expect(row?.submittedViaLink).toBe(false);
    expect(db.select().from(rsvpChanges).get()?.actorGuestId).toBe(cleo);
  });

  it("marks a reply sent while signed in as the member's linked account", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    await call(app, "POST", "/api/claim/member", cookie, { guestId: bo });
    linkRow(db, bo, "usr_alice");
    const org = await signIn(db, "usr_alice");
    const res = await call(
      app,
      "POST",
      "/api/rsvp",
      `${cookie}; ${org}`,
      reply(bo, firstEventOf(db, bo)),
    );
    expect(res.status).toBe(200);
    expect(db.select().from(rsvps).get()?.submittedViaLink).toBe(true);
  });

  it("asks osn-api afresh for the stamp, so an erased profile stops matching at once", async () => {
    let known = true;
    const resolver: OsnAccountResolver = async () =>
      known ? { ok: true, accountId: "acc_usr_bob" } : { ok: false, reason: "profile_not_found" };
    const { db, app } = buildApp(true, resolver);
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    await call(app, "POST", "/api/claim/member", cookie, { guestId: bo });
    linkRow(db, bo, "usr_bob");
    const org = await signIn(db, "usr_alice");
    // A restore caches usr_alice → acc_usr_bob.
    await restore(app, `${cookie}; ${org}`);
    known = false;
    const res = await call(
      app,
      "POST",
      "/api/rsvp",
      `${cookie}; ${org}`,
      reply(bo, firstEventOf(db, bo)),
    );
    expect(res.status).toBe(200);
    expect(db.select().from(rsvps).get()?.submittedViaLink).toBe(false);
  });

  it("asks for no member, and stamps none, with the flag off", async () => {
    const { db, app } = buildApp(false);
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    const res = await call(app, "POST", "/api/rsvp", cookie, reply(bo, firstEventOf(db, bo)));
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as { rsvps: object[] };
    expect(body.rsvps[0]).not.toHaveProperty("submittedBy");
    expect(db.select().from(rsvps).get()?.submittedByGuestId).toBeNull();
  });

  it("lets an organiser's write replace a member's stamp", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    await call(app, "POST", "/api/claim/member", cookie, { guestId: bo });
    const eventId = firstEventOf(db, bo);
    await call(app, "POST", "/api/rsvp", cookie, reply(bo, eventId));
    await Effect.runPromise(
      rsvpService
        .recordStatus({ guestId: bo, eventId, status: "declined" })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(db.select().from(rsvps).get()?.submittedByGuestId).toBeNull();
    // A member's later write stamps the row again.
    await call(app, "POST", "/api/rsvp", cookie, reply(bo, eventId));
    expect(db.select().from(rsvps).get()?.submittedByGuestId).toBe(bo);
    await Effect.runPromise(
      rsvpService
        .submitRsvp({
          guestId: bo,
          eventId,
          status: "attending",
          dietary: "",
          dietaryPresets: [],
          dietaryConsent: false,
          consentSource: "organiser_attested",
        })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(db.select().from(rsvps).get()?.submittedByGuestId).toBeNull();
  });

  it("keeps a member's replies for others when that member is deleted", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    const dot = guestId(db, "Dot");
    await call(app, "POST", "/api/claim/member", cookie, { guestId: dot });
    await call(app, "POST", "/api/rsvp", cookie, reply(bo, firstEventOf(db, bo)));
    db.delete(guests).where(eq(guests.id, dot)).run();
    const row = db.select().from(rsvps).get();
    expect(row?.guestId).toBe(bo);
    expect(row?.submittedByGuestId).toBeNull();
    expect(db.select({ member: sessions.memberGuestId }).from(sessions).get()?.member).toBeNull();
  });
});

describe("plus-one changes record their actor", () => {
  it("writes the session's member on the change row", async () => {
    const { db, app } = buildApp();
    const { cookie } = await claim(app, SAMPLETON);
    const bo = guestId(db, "Bo");
    db.update(guests).set({ plusOneAllowed: true }).where(eq(guests.id, bo)).run();
    await call(app, "POST", "/api/claim/member", cookie, { guestId: bo });
    const res = await call(app, "PUT", `/api/plus-one/${bo}`, cookie, {
      firstName: "Sam",
      lastName: "Guest",
    });
    expect(res.status).toBe(200);
    expect(db.select().from(rsvpChanges).get()?.actorGuestId).toBe(bo);
  });
});
