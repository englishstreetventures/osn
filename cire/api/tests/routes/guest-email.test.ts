import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";

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
import { CIRE_METRICS } from "../../src/metrics";
import { hashGuestEmail } from "../../src/services/email-suppression";
import { guestEmailService, MAX_OPT_OUTS_PER_SEAT } from "../../src/services/guest-email";
import { hostCodeService } from "../../src/services/host-code";
import { jsonBody } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";

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

/**
 * Store `address` on the seat as the hosts would, with its hash. `attestedBy`
 * null is a hosts' address whose attesting organiser is no longer named (their
 * erasure, or a revert after they left the wedding).
 */
async function hostsAdded(
  db: TestDb,
  id: string,
  address: string,
  attestedBy: string | null = "usr_owner",
) {
  db.update(guests)
    .set({
      email: address,
      emailHash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, address),
      emailSource: "organiser_attested",
      emailConsentAt: new Date(0),
      emailConsentVersion: ORGANISER_EMAIL_ATTESTATION.version,
      emailAttestedByOsnProfileId: attestedBy,
    })
    .where(eq(guests.id, id))
    .run();
}

/** Every row of the wedding's suppression list. */
function optOuts(db: TestDb) {
  return db
    .select({
      hash: emailSuppressions.emailHash,
      guestId: emailSuppressions.guestId,
      reason: emailSuppressions.reason,
    })
    .from(emailSuppressions)
    .all();
}

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
    expect(await jsonBody(res)).toEqual({ error: "not_a_guest" });
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
    expect(await jsonBody(res)).toEqual({ error: "Not found" });
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

  // `DELETE` builds its own seat request, so each seat refusal is checked on
  // it too: a refused removal leaves the address and writes no opt-out.
  describe("DELETE", () => {
    function seed(db: TestDb, id: string) {
      db.update(guests)
        .set({
          email: ADDRESS,
          emailSource: "guest",
          emailConsentAt: new Date(0),
          emailConsentVersion: GUEST_EMAIL_CONSENT.version,
        })
        .where(eq(guests.id, id))
        .run();
    }

    function expectKept(db: TestDb, id: string) {
      expect(emailRow(db, id)?.email).toBe(ADDRESS);
      expect(db.select().from(emailSuppressions).all()).toEqual([]);
    }

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
      seed(db, hostSeat!.id);
      const res = await remove(app, cookie, hostSeat!.id);
      expect(res.status).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "not_a_guest" });
      expectKept(db, hostSeat!.id);
    });

    it("answers 404 where the member step is off for the wedding", async () => {
      const { db, app } = buildApp(new Set([BOOTSTRAP_WEDDING_ID]));
      const cookie = await claim(app, TESTFAMILY);
      const ada = guestId(db, "Ada");
      seed(db, ada);
      const res = await remove(app, cookie, ada);
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: "Not found" });
      expectKept(db, ada);
    });

    it("refuses a household that has not said who is answering", async () => {
      const { db, app } = buildApp();
      const cookie = await claim(app, SAMPLETON);
      const cleo = guestId(db, "Cleo");
      seed(db, cleo);
      const res = await remove(app, cookie, cleo);
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: "member_required" });
      expectKept(db, cleo);
    });
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

  // Anyone holding the household code can type any address on a seat, so
  // removing one the seat typed says nothing about whose mailbox it is: the
  // withdrawal binds this seat alone, never the wedding's other seats.
  it("records a withdrawal for this seat only when it removes an address the guest gave", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    expect((await save(app, cookie, cleo)).status).toBe(200);

    const res = await remove(app, cookie, cleo);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ email: null });
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
    const ownRow = [
      {
        hash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, ADDRESS),
        guestId: cleo,
        reason: "guest_removed_own" as const,
      },
    ];
    expect(optOuts(db)).toEqual(ownRow);

    // Removing again changes nothing and still answers as removed.
    const again = await remove(app, cookie, cleo);
    expect(again.status).toBe(200);
    expect(optOuts(db)).toEqual(ownRow);
  });

  // The hosts put the address back on the seat that withdrew it, and the guest
  // removes it again: that removal is of the hosts' address, so it stands for
  // the whole wedding, not for the seat alone.
  it("turns the seat's own withdrawal into a wedding-wide opt-out when it removes the hosts' re-add", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    expect((await save(app, cookie, cleo)).status).toBe(200);
    expect((await remove(app, cookie, cleo)).status).toBe(200);
    await hostsAdded(db, cleo, ADDRESS);

    expect((await remove(app, cookie, cleo)).status).toBe(200);
    expect(optOuts(db)).toEqual([
      {
        hash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, ADDRESS),
        guestId: cleo,
        reason: "guest_removed",
      },
    ]);
  });

  // The hosts attested that the guest agreed to this address; the guest's
  // removal says they did not, and stands for the whole wedding.
  it("records the seat's opt-out when it removes an address the hosts added", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    await hostsAdded(db, cleo, ADDRESS);
    const cookie = await answeringAs(app, db, "Cleo");

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

    const again = await remove(app, cookie, cleo);
    expect(again.status).toBe(200);
    expect(optOuts(db)).toHaveLength(1);
  });

  // What makes an address the hosts' is its source, not the attester's id,
  // which an organiser's erasure or a revert can leave NULL.
  it("records the opt-out for a hosts' address whose attesting organiser is no longer named", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    await hostsAdded(db, cleo, ADDRESS, null);
    const cookie = await answeringAs(app, db, "Cleo");

    expect((await remove(app, cookie, cleo)).status).toBe(200);
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
    expect(optOuts(db)).toEqual([
      {
        hash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, ADDRESS),
        guestId: cleo,
        reason: "guest_removed",
      },
    ]);
  });

  // One household cannot undo another seat's opt-out by saving the same
  // address on its own seat; only the seat that withdrew it can.
  it("clears an opt-out only when the seat that made it puts the address back", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    await hostsAdded(db, cleo, ADDRESS);
    const cleoCookie = await answeringAs(app, db, "Cleo");
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

describe("guest email routes — bodies and failed writes", () => {
  // Input refusals: a body missing a field, or carrying an address past the
  // raw cap, is refused before anything is read or written.
  it("refuses a body missing a field or carrying an oversized address", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    for (const body of [
      { memberGuestId: cleo, email: ADDRESS },
      { email: ADDRESS, consentVersion: GUEST_EMAIL_CONSENT.version },
      {
        memberGuestId: cleo,
        email: `${"a".repeat(1015)}@example.test`,
        consentVersion: GUEST_EMAIL_CONSENT.version,
      },
    ]) {
      const res = await call(app, "PUT", PATH, cookie, body);
      expect(res.status).toBe(400);
      expect(await jsonBody(res)).toEqual({ error: "Missing or invalid fields" });
    }
    const removed = await call(app, "DELETE", PATH, cookie, {});
    expect(removed.status).toBe(400);
    expect(await jsonBody(removed)).toEqual({ error: "Missing or invalid fields" });
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
  });

  it("answers 500 and leaves the stored address as it was when the write fails", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    expect((await save(app, cookie, cleo)).status).toBe(200);
    db.$client.run(
      "CREATE TRIGGER fail_email BEFORE UPDATE OF email ON guests BEGIN SELECT RAISE(ABORT, 'x'); END;",
    );

    const saved = await save(app, cookie, cleo, "other@example.test");
    expect(saved.status).toBe(500);
    expect(await jsonBody(saved)).toEqual({ error: "Could not save your email" });
    const removed = await remove(app, cookie, cleo);
    expect(removed.status).toBe(500);
    expect(await jsonBody(removed)).toEqual({ error: "Could not remove your email" });
    expect(emailRow(db, cleo)?.email).toBe(ADDRESS);
  });
});

describe("guest email routes — the member step and opt-outs", () => {
  // The permit side of the excluded-wedding gate: with account linking on,
  // the wedding has the member step and its guests reach their address.
  it("lets a guest of an excluded wedding save once account linking is on", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const limiter = () => createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 });
    const app = createApp(db, {
      claimLimiter: limiter(),
      claimSessionLimiter: limiter(),
      rsvpLimiter: limiter(),
      plusOneLimiter: limiter(),
      accountLinkLimiter: limiter(),
      resolveOsnAccountId: async (profileId) => ({ ok: true, accountId: `acc_${profileId}` }),
      osnIssuerUrl: "https://id.musubi.test",
      flags: createStaticFlags({ "cire.account-linking": true }),
      memberStepExcludedWeddings: new Set([BOOTSTRAP_WEDDING_ID]),
    });
    const cookie = await claim(app, TESTFAMILY);
    const ada = guestId(db, "Ada");
    const res = await save(app, cookie, ada, "ada@example.test");
    expect(res.status).toBe(200);
    expect(emailRow(db, ada)?.email).toBe("ada@example.test");
  });

  // An organiser may store an address the guest withdrew; when the same seat
  // removes it again, the second opt-out meets the first and must not fail.
  it("removes again after an organiser re-adds a withdrawn address", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    await hostsAdded(db, cleo, ADDRESS);
    const cookie = await answeringAs(app, db, "Cleo");
    expect((await remove(app, cookie, cleo)).status).toBe(200);
    expect(optOuts(db)).toHaveLength(1);
    await hostsAdded(db, cleo, ADDRESS);

    const res = await remove(app, cookie, cleo);
    expect(res.status).toBe(200);
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
    expect(optOuts(db)).toHaveLength(1);
  });

  // The opt-out is decided on, and names, the address the row holds when the
  // removal runs, not one read before it: an organiser's address landing in
  // between is withdrawn for the wedding, and the guest's own in place of the
  // hosts' is withdrawn for the seat alone.
  it("records the address the row holds when the removal runs", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    const [family] = db
      .select({ familyId: guests.familyId })
      .from(guests)
      .where(eq(guests.id, cleo))
      .all();
    const readSeat = () =>
      Effect.runPromise(
        guestEmailService
          .resolveSeat({
            familyId: family!.familyId,
            sessionMember: cleo,
            bodyMember: cleo,
            memberStepOff: Promise.resolve(new Set()),
          })
          .pipe(Effect.provideService(DbService, db)),
      );
    const removeOwn = (seat: Awaited<ReturnType<typeof readSeat>>) =>
      Effect.runPromise(
        guestEmailService.removeOwn(seat).pipe(Effect.provideService(DbService, db)),
      );

    // The guest's own address is read; the hosts' replaces it before the batch.
    expect((await save(app, cookie, cleo)).status).toBe(200);
    const ownRead = await readSeat();
    await hostsAdded(db, cleo, "changed@example.test");
    await removeOwn(ownRead);
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
    const changed = {
      hash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "changed@example.test"),
      guestId: cleo,
      reason: "guest_removed" as const,
    };
    expect(optOuts(db)).toEqual([changed]);

    // The hosts' address is read; the guest's own replaces it before the batch.
    await hostsAdded(db, cleo, "hosts@example.test");
    const hostsRead = await readSeat();
    db.update(guests)
      .set({
        email: ADDRESS,
        emailHash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, ADDRESS),
        emailSource: "guest",
        emailConsentVersion: GUEST_EMAIL_CONSENT.version,
        emailAttestedByOsnProfileId: null,
      })
      .where(eq(guests.id, cleo))
      .run();
    await removeOwn(hostsRead);
    expect(emailRow(db, cleo)).toEqual(NOTHING_STORED);
    expect(optOuts(db)).toEqual([
      changed,
      {
        hash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, ADDRESS),
        guestId: cleo,
        reason: "guest_removed_own",
      },
    ]);
  });

  // Each removal of a different address adds a row, as does replacing one the
  // hosts added; one session, typing and removing addresses on its own, must
  // not grow the list without end.
  it(`refuses a new address once the seat holds ${MAX_OPT_OUTS_PER_SEAT} opt-outs`, async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    for (let i = 0; i < MAX_OPT_OUTS_PER_SEAT; i += 1) {
      expect((await save(app, cookie, cleo, `cleo${i}@example.test`)).status).toBe(200);
      expect((await remove(app, cookie, cleo)).status).toBe(200);
    }
    const refusedBefore = await counterValue(CIRE_METRICS.guestEmailBlocked, {
      reason: "too_many_changes",
    });
    const res = await save(app, cookie, cleo, "one-more@example.test");
    expect(res.status).toBe(429);
    expect(await counterValue(CIRE_METRICS.guestEmailBlocked, { reason: "too_many_changes" })).toBe(
      refusedBefore + 1,
    );
    expect(await jsonBody(res)).toEqual({ error: "too_many_changes" });
    expect(emailRow(db, cleo)?.email).toBeNull();
    expect(db.select().from(emailSuppressions).all()).toHaveLength(MAX_OPT_OUTS_PER_SEAT);
  });

  // Giving back an address the seat withdrew deletes that seat's row, so it
  // never raises the count the cap bounds: the guest notice's "unless you add
  // it back yourself" holds for a seat at the cap too.
  it("lets a seat at the cap give back an address it withdrew, and drops that opt-out", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    for (let i = 0; i < MAX_OPT_OUTS_PER_SEAT; i += 1) {
      expect((await save(app, cookie, cleo, `cleo${i}@example.test`)).status).toBe(200);
      expect((await remove(app, cookie, cleo)).status).toBe(200);
    }
    const res = await save(app, cookie, cleo, "cleo3@example.test");
    expect(res.status).toBe(200);
    expect(emailRow(db, cleo)?.email).toBe("cleo3@example.test");
    const hashes = db
      .select({ hash: emailSuppressions.emailHash })
      .from(emailSuppressions)
      .all()
      .map((r) => r.hash);
    expect(hashes).toHaveLength(MAX_OPT_OUTS_PER_SEAT - 1);
    expect(hashes).not.toContain(await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "cleo3@example.test"));
  });
});

describe("guest email routes — a guest's correction of a hosts' address", () => {
  // The guest has said the hosts' address is wrong. Kept as an opt-out for
  // the seat, so a later sheet or revert that puts it back is caught.
  it("records the hosts' address it replaces as the seat's opt-out", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    await hostsAdded(db, cleo, "typo@example.test");
    const cookie = await answeringAs(app, db, "Cleo");

    expect((await save(app, cookie, cleo)).status).toBe(200);
    expect(emailRow(db, cleo)?.email).toBe(ADDRESS);
    expect(optOuts(db)).toEqual([
      {
        hash: await hashGuestEmail(BOOTSTRAP_WEDDING_ID, "typo@example.test"),
        guestId: cleo,
        reason: "guest_corrected",
      },
    ]);
  });

  it("records nothing when the guest replaces an address they gave themselves", async () => {
    const { db, app } = buildApp();
    const cookie = await answeringAs(app, db, "Cleo");
    const cleo = guestId(db, "Cleo");
    expect((await save(app, cookie, cleo, "first@example.test")).status).toBe(200);
    expect((await save(app, cookie, cleo)).status).toBe(200);
    expect(emailRow(db, cleo)?.email).toBe(ADDRESS);
    expect(optOuts(db)).toEqual([]);
  });

  // Saving the hosts' own address takes it as the guest's: nothing withdrawn.
  it("records nothing when the guest keeps the hosts' address as their own", async () => {
    const { db, app } = buildApp();
    const cleo = guestId(db, "Cleo");
    await hostsAdded(db, cleo, ADDRESS);
    const cookie = await answeringAs(app, db, "Cleo");
    expect((await save(app, cookie, cleo, ADDRESS.toUpperCase())).status).toBe(200);
    expect(emailRow(db, cleo)).toMatchObject({ email: ADDRESS, source: "guest" });
    expect(optOuts(db)).toEqual([]);
  });
});

describe("the suppression hash", () => {
  // Stored opt-outs outlive deploys: the hash must stay exactly SHA-256 of
  // `wedding_id:address` in lower-case hex, checked here against an
  // independent computation rather than against itself.
  it("is the SHA-256 hex of the wedding id and the address", async () => {
    expect(await hashGuestEmail("wed_1", "ada@example.test")).toBe(
      createHash("sha256").update("wed_1:ada@example.test").digest("hex"),
    );
  });
});

describe("guest email metrics", () => {
  it("counts each refusal by reason and each change by who made it", async () => {
    const { db, app } = buildApp();
    const blocked = (reason: string) => counterValue(CIRE_METRICS.guestEmailBlocked, { reason });
    const changed = (action: string) =>
      counterValue(CIRE_METRICS.guestEmailChanged, { by: "guest", action });
    const before = {
      required: await blocked("member_required"),
      invalid: await blocked("invalid"),
      outdated: await blocked("consent_outdated"),
      set: await changed("set"),
      cleared: await changed("cleared"),
    };
    const unchosen = await claim(app, SAMPLETON);
    const cleo = guestId(db, "Cleo");
    await save(app, unchosen, cleo);
    const cookie = await answeringAs(app, db, "Cleo");
    await save(app, cookie, cleo, "not an address");
    await call(app, "PUT", PATH, cookie, {
      memberGuestId: cleo,
      email: ADDRESS,
      consentVersion: "guest-email-2020-01-01",
    });
    await save(app, cookie, cleo);
    await remove(app, cookie, cleo);
    // A second removal finds no address and changes nothing, so counts nothing.
    expect((await remove(app, cookie, cleo)).status).toBe(200);
    expect(await blocked("member_required")).toBe(before.required + 1);
    expect(await blocked("invalid")).toBe(before.invalid + 1);
    expect(await blocked("consent_outdated")).toBe(before.outdated + 1);
    expect(await changed("set")).toBe(before.set + 1);
    expect(await changed("cleared")).toBe(before.cleared + 1);
  });
});
