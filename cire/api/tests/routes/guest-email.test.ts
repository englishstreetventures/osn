import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, emailSuppressions, families, guests } from "@cire/db";
import { GUEST_EMAIL_CONSENT, ORGANISER_EMAIL_ATTESTATION } from "@cire/guest-email";
import { createStaticFlags } from "@shared/feature-flags";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { parseSessionToken } from "../../src/lib/cookie";
import { hashGuestEmail } from "../../src/services/email-suppression";
import { hostCodeService } from "../../src/services/host-code";
import { jsonBody } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";

// Seeded families (cire/db/seed/data/guests.ts):
//   TESTONE-IVY-AA11 Testfamily → Ada
//   TESTTWO-OAK-BB22 Sampleton  → Bo, Cleo, Dot
const TESTFAMILY = "TESTONE-IVY-AA11";
const SAMPLETON = "TESTTWO-OAK-BB22";
const IP = "203.0.113.9";
const ORIGIN = "http://localhost:4321";
const PATH = "/api/claim/member/email";
const ADDRESS = "cleo.sampleton@example.test";

function buildApp(memberStepExcludedWeddings?: ReadonlySet<string>) {
  const db = createDb(":memory:");
  seedDb(db);
  const limiter = () => createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 });
  const app = createApp(db, {
    claimLimiter: limiter(),
    claimSessionLimiter: limiter(),
    rsvpLimiter: limiter(),
    plusOneLimiter: limiter(),
    accountLinkLimiter: limiter(),
    flags: createStaticFlags({ "cire.account-linking": false }),
    memberStepExcludedWeddings,
  });
  return { db, app };
}

type App = ReturnType<typeof createApp>;

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

async function claim(app: App, publicId: string): Promise<string> {
  const res = await call(app, "POST", "/api/claim", null, { publicId });
  expect(res.status).toBe(200);
  return `cire_session=${parseSessionToken(res.headers.get("Set-Cookie"))}`;
}

function guestId(db: TestDb, firstName: string): string {
  const row = db
    .select({ id: guests.id })
    .from(guests)
    .where(eq(guests.firstName, firstName))
    .get();
  if (!row) throw new Error(`no seeded guest named ${firstName}`);
  return row.id;
}

/** A Sampleton session that has said it is `firstName`. */
async function answeringAs(app: App, db: TestDb, firstName: string): Promise<string> {
  const cookie = await claim(app, SAMPLETON);
  const res = await call(app, "POST", "/api/claim/member", cookie, {
    guestId: guestId(db, firstName),
  });
  expect(res.status).toBe(200);
  return cookie;
}

function save(app: App, cookie: string | null, member: string, email: string = ADDRESS) {
  return call(app, "PUT", PATH, cookie, {
    memberGuestId: member,
    email,
    consentVersion: GUEST_EMAIL_CONSENT.version,
  });
}

function remove(app: App, cookie: string | null, member: string) {
  return call(app, "DELETE", PATH, cookie, { memberGuestId: member });
}

function emailRow(db: TestDb, id: string) {
  return db
    .select({
      email: guests.email,
      source: guests.emailSource,
      consentAt: guests.emailConsentAt,
      version: guests.emailConsentVersion,
      attestedBy: guests.emailAttestedByOsnProfileId,
    })
    .from(guests)
    .where(eq(guests.id, id))
    .get();
}

const NOTHING_STORED = {
  email: null,
  source: null,
  consentAt: null,
  version: null,
  attestedBy: null,
};

describe("guest email routes — refusals", () => {
  it("refuses a request with no household session", async () => {
    const { db, app } = buildApp();
    const res = await save(app, null, guestId(db, "Cleo"));
    expect(res.status).toBe(401);
    expect(emailRow(db, guestId(db, "Cleo"))).toEqual(NOTHING_STORED);
  });

  // The organiser's preview household is not a guest seat: nobody there can
  // consent to anything, even with a body crafted around the hidden box.
  it("refuses the host preview household", async () => {
    const { db, app } = buildApp();
    const { publicId } = await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID, "cire-wedding")
        .pipe(Effect.provideService(DbService, db)),
    );
    const cookie = await claim(app, publicId);
    const [hostSeat] = db
      .select({ id: guests.id })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(eq(families.publicId, publicId))
      .all();
    const res = await save(app, cookie, hostSeat!.id);
    expect(res.status).toBe(403);
    expect(emailRow(db, hostSeat!.id)?.email).toBeNull();
  });

  // In a wedding kept out of the member step while account linking is off,
  // `POST /api/claim/member` answers 404 and the page draws no member. A
  // session still holding an earlier member must not reach the address.
  it("answers 404 where the member step is off for the wedding", async () => {
    const { db, app } = buildApp(new Set([BOOTSTRAP_WEDDING_ID]));
    const cookie = await claim(app, TESTFAMILY);
    const ada = guestId(db, "Ada");
    const res = await save(app, cookie, ada);
    expect(res.status).toBe(404);
    expect(emailRow(db, ada)).toEqual(NOTHING_STORED);
  });

  it("refuses a household that has not said who is answering", async () => {
    const { db, app } = buildApp();
    const cookie = await claim(app, SAMPLETON);
    const cleo = guestId(db, "Cleo");
    const res = await save(app, cookie, cleo);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "member_required" });
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
  });

  // The page names one member; a second tab may have chosen another since.
  // The address goes on the seat the page showed or nowhere.
  it("refuses a body naming a member the session no longer holds", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Bo");
    const cleo = guestId(db, "Cleo");
    const res = await save(app, cookie, cleo);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "member_changed" });
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
    expect(emailRow(db, guestId(db, "Bo"))).toEqual(NOTHING_STORED);

    const removed = await remove(app, cookie, cleo);
    expect(removed.status).toBe(409);
  });

  it("refuses an invalid address and stores nothing", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    const res = await save(app, cookie, cleo, "Cleo <cleo@example.test>");
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ error: "invalid_email" });
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
  });

  // The version is the evidence of which words were on screen. A page built
  // before the wording changed must not store consent to words it never showed.
  it("refuses a consent version that is not the current one, and stores nothing", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    for (const consentVersion of ["guest-email-2020-01-01", ORGANISER_EMAIL_ATTESTATION.version]) {
      const res = await call(app, "PUT", PATH, cookie, {
        memberGuestId: cleo,
        email: ADDRESS,
        consentVersion,
      });
      expect(res.status).toBe(422);
      expect(await jsonBody(res)).toEqual({ error: "email_consent_outdated" });
    }
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
  });
});

describe("guest email routes — the stored record", () => {
  // A guest's own save replaces whatever an organiser attested: the evidence
  // is now the guest's tick, so no organiser stays named on it.
  it("stores the guest's own consent, replacing an organiser's attestation", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    db.update(guests)
      .set({
        email: "old@example.test",
        emailSource: "organiser_attested",
        emailConsentAt: new Date(0),
        emailConsentVersion: ORGANISER_EMAIL_ATTESTATION.version,
        emailAttestedByOsnProfileId: "usr_owner",
      })
      .where(eq(guests.id, cleo))
      .run();
    const cookie = await answeringAs(app, db, "Cleo");

    const res = await save(app, cookie, cleo, "  Cleo.Sampleton@Example.TEST ");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ email: { address: ADDRESS, source: "guest" } });
    const row = emailRow(db, cleo)!;
    expect(row).toMatchObject({
      email: ADDRESS,
      source: "guest",
      version: GUEST_EMAIL_CONSENT.version,
      attestedBy: null,
    });
    expect(row.consentAt?.getTime()).toBeGreaterThan(0);
  });

  it("removes every part of the record and records the opt-out for the seat", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    expect((await save(app, cookie, cleo)).status).toBe(200);

    const res = await remove(app, cookie, cleo);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ email: null });
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
    const hash = await hashGuestEmail(BOOTSTRAP_WEDDING_ID, ADDRESS);
    expect(
      db
        .select({
          weddingId: emailSuppressions.weddingId,
          hash: emailSuppressions.emailHash,
          guestId: emailSuppressions.guestId,
          reason: emailSuppressions.reason,
        })
        .from(emailSuppressions)
        .all(),
    ).toEqual([{ weddingId: BOOTSTRAP_WEDDING_ID, hash, guestId: cleo, reason: "guest_removed" }]);

    // Removing again changes nothing and still answers as removed.
    const again = await remove(app, cookie, cleo);
    expect(again.status).toBe(200);
    expect(db.select().from(emailSuppressions).all()).toHaveLength(1);
  });

  // One household cannot undo another seat's opt-out by saving the same
  // address on its own seat; only the seat that withdrew it can.
  it("clears an opt-out only when the seat that made it puts the address back", async () => {
    const { db, app } = buildApp();
    const cleoCookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    expect((await save(app, cleoCookie, cleo)).status).toBe(200);
    expect((await remove(app, cleoCookie, cleo)).status).toBe(200);

    const boCookie = await answeringAs(app, db, "Bo");
    const bo = guestId(db, "Bo");
    expect((await save(app, boCookie, bo)).status).toBe(200);
    expect(
      db
        .select({ guestId: emailSuppressions.guestId })
        .from(emailSuppressions)
        .all()
        .map((r) => r.guestId),
    ).toEqual([cleo]);

    const cleoAgain = await answeringAs(app, db, "Cleo");
    expect((await save(app, cleoAgain, cleo)).status).toBe(200);
    expect(db.select().from(emailSuppressions).all()).toEqual([]);
  });
});

describe("guest email in the claim payload", () => {
  // The household sees the address of the member it says it is, never a list
  // of every member's.
  it("carries the chosen member's address and no other member's", async () => {
    const { db, app } = buildApp();
    const bo = guestId(db, "Bo");
    db.update(guests)
      .set({
        email: "bo@example.test",
        emailSource: "organiser_attested",
        emailConsentAt: new Date(),
        emailConsentVersion: ORGANISER_EMAIL_ATTESTATION.version,
        emailAttestedByOsnProfileId: "usr_owner",
      })
      .where(eq(guests.id, bo))
      .run();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    expect((await save(app, cookie, cleo)).status).toBe(200);

    const restored = await call(app, "GET", "/api/claim/session?slug=cire-wedding", cookie);
    const text = await restored.text();
    expect(JSON.parse(text).member).toEqual({
      guestId: cleo,
      email: { address: ADDRESS, source: "guest" },
    });
    expect(text).not.toContain("bo@example.test");

    const chosen = await call(app, "POST", "/api/claim/member", cookie, { guestId: bo });
    expect(((await jsonBody(chosen)) as { member: unknown }).member).toEqual({
      guestId: bo,
      email: { address: "bo@example.test", source: "organiser_attested" },
    });
  });
});

describe("guest email routes — logs", () => {
  // `email` is a redacted key, but a message string is not redacted: no line
  // may carry the address however the request ends.
  it("never writes the address to a log line", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    const logs = await captureLogs(async () => {
      const cookie = await claim(app, SAMPLETON);
      await save(app, cookie, cleo, "refused-before-member@example.test");
      await call(app, "POST", "/api/claim/member", cookie, { guestId: cleo });
      await save(app, cookie, cleo, "not an address@example.test");
      await save(app, cookie, cleo);
      await remove(app, cookie, cleo);
    });
    expect(logs).not.toContain("example.test");
  });
});
