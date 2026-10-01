import { describe, it, expect } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  guestAccountLinks,
  guests,
  rsvps,
  weddingFaqs,
  weddings,
} from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { ORGANISER_DIETARY_ATTESTATION, PLUS_ONE_DIETARY_ATTESTATION } from "@cire/dietary";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../../src/db";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { DIETARY_CONSENT_VERSION } from "../../src/schemas/rsvp";
import {
  type AccountLinkGate,
  claimService,
  decodePalette,
  InvalidCredentials,
  withPlusOnesAfterInviters,
} from "../../src/services/claim";
import { hostCodeService } from "../../src/services/host-code";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { allowPlusOne, eventIdsOf, guestNamed, seedPlusOne } from "../test-helpers/plus-one";

/** Read a family's `first_opened_at` (epoch-ms or null) by public id. */
function firstOpenedAt(db: Db, publicId: string): Effect.Effect<number | null> {
  return Effect.gen(function* () {
    const rows = yield* Effect.promise(() =>
      Promise.resolve(
        db
          .select({ firstOpenedAt: families.firstOpenedAt })
          .from(families)
          .where(eq(families.publicId, publicId))
          .all(),
      ),
    );
    const row = rows[0];
    if (!row) throw new Error(`no family ${publicId}`);
    return row.firstOpenedAt === null ? null : row.firstOpenedAt.getTime();
  });
}

const withDb = effWith(TestDbLayer);

const CATHOLIC_ID = eventsData.catholic.id;
const KITCHEN_TEA_ID = eventsData["kitchen-tea"].id;
const MEHENDI_ID = eventsData.mehendi.id;
const HINDU_ID = eventsData.hindu.id;
const RECEPTION_ID = eventsData.reception.id;

describe("claimService.lookup", () => {
  it(
    "returns family + members + events for valid publicId (single guest)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(result.familyName).toBe("Testfamily");
        expect(result.publicId).toBe("TESTONE-IVY-AA11");
        expect(result.members).toHaveLength(1);
        const priya = result.members[0]!;
        expect(priya.firstName).toBe("Ada");
        expect(priya.lastName).toBe("Testfamily");
        expect(typeof priya.guestId).toBe("string");
        expect(priya.guestId.length).toBeGreaterThan(0);
        expect([...priya.eventIds].toSorted()).toEqual(
          [CATHOLIC_ID, HINDU_ID, RECEPTION_ID].toSorted(),
        );
        expect(result.events.map((e) => e.id).toSorted()).toEqual(
          [CATHOLIC_ID, HINDU_ID, RECEPTION_ID].toSorted(),
        );
        expect(result.rsvps).toEqual([]);
        expect(result.preview).toBe(false);
      }),
    ),
  );

  it(
    "exposes guestId on every member",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTTWO-OAK-BB22");
        for (const m of result.members) {
          expect(typeof m.guestId).toBe("string");
          expect(m.guestId.length).toBeGreaterThan(0);
        }
        // All guestIds within a family are unique
        const ids = new Set(result.members.map((m) => m.guestId));
        expect(ids.size).toBe(result.members.length);
      }),
    ),
  );

  it(
    "surfaces extended event metadata (startAt, endAt, timezone, address, palette, urls)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        const catholic = result.events.find((e) => e.id === CATHOLIC_ID)!;
        expect(catholic.startAt).toBe(eventsData.catholic.startAt);
        expect(catholic.endAt).toBe(eventsData.catholic.endAt);
        expect(catholic.timezone).toBe("Australia/Sydney");
        expect(catholic.address).toBe(eventsData.catholic.address);
        expect(catholic.dressCodeDescription).toBe(eventsData.catholic.dressCodeDescription);
        expect(catholic.dressCodePalette).toEqual(eventsData.catholic.dressCodePalette);
        expect(catholic.pinterestUrl).toBe(eventsData.catholic.pinterestUrl);
        expect(catholic.mapsUrl).toBe(eventsData.catholic.mapsUrl);
        expect(catholic.sortOrder).toBe(0);
      }),
    ),
  );

  it(
    "orders events by sortOrder",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        const orders = result.events.map((e) => e.sortOrder);
        expect(orders).toEqual([...orders].toSorted((a, b) => a - b));
      }),
    ),
  );

  it(
    "returns each member's own eventIds — Sampleton kid is hindu-only",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTTWO-OAK-BB22");
        expect(result.familyName).toBe("Sampleton");
        const byName = new Map(result.members.map((m) => [m.firstName, m]));
        expect([...(byName.get("Bo")?.eventIds ?? [])].toSorted()).toEqual(
          [RECEPTION_ID, HINDU_ID].toSorted(),
        );
        expect([...(byName.get("Cleo")?.eventIds ?? [])].toSorted()).toEqual(
          [RECEPTION_ID, HINDU_ID].toSorted(),
        );
        expect(byName.get("Dot")?.eventIds).toEqual([HINDU_ID]);
        expect(result.events.map((e) => e.id).toSorted()).toEqual(
          [RECEPTION_ID, HINDU_ID].toSorted(),
        );
      }),
    ),
  );

  it(
    "returns all five events for the Placeholders (default demo code invites everyone)",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTFOR-JOY-DD44");
        expect(result.events.map((e) => e.id).toSorted()).toEqual(
          [CATHOLIC_ID, KITCHEN_TEA_ID, MEHENDI_ID, HINDU_ID, RECEPTION_ID].toSorted(),
        );
      }),
    ),
  );

  it(
    "fails with InvalidCredentials for an unknown publicId",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(claimService.lookup("FAKE-XYZ-9999"));
        expect(error._tag).toBe("InvalidCredentials");
        expect(error).toBeInstanceOf(InvalidCredentials);
      }),
    ),
  );

  it(
    "reports dietaryConsentCurrent per row, false once the stored version is superseded",
    withDb(
      Effect.gen(function* () {
        // This is the second, independent computation of the same rule — the
        // RSVP service has its own — and neither was asserted anywhere. The
        // sheet re-lights its picker from `dietaryPresets` and decides whether
        // the consent box may open ticked from this boolean, so a row consented
        // against superseded wording has to come back `false`.
        const db = yield* DbService;
        const now = new Date();
        const adaRows = yield* Effect.promise(() =>
          Promise.resolve(
            db.select({ id: guests.id }).from(guests).where(eq(guests.firstName, "Ada")).all(),
          ),
        );
        const ada = adaRows[0];
        if (!ada) throw new Error("no guest Ada");

        const insertRsvp = (eventId: string, version: string) =>
          Effect.promise(() =>
            Promise.resolve(
              db
                .insert(rsvps)
                .values({
                  id: crypto.randomUUID(),
                  guestId: ada.id,
                  eventId,
                  status: "attending",
                  dietary: "",
                  dietaryPresets: "halal",
                  consentSource: "guest",
                  dietaryConsentAt: now,
                  dietaryConsentVersion: version,
                  createdAt: now,
                })
                .run(),
            ),
          );

        yield* insertRsvp(HINDU_ID, DIETARY_CONSENT_VERSION);
        yield* insertRsvp(RECEPTION_ID, "2000-01-01");

        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        const current = result.rsvps.find((r) => r.eventId === HINDU_ID);
        const stale = result.rsvps.find((r) => r.eventId === RECEPTION_ID);
        expect(current?.dietaryConsentCurrent).toBe(true);
        expect(stale?.dietaryConsentCurrent).toBe(false);
        // Both rows still carry the data; only the "still current?" answer moves.
        expect(current?.dietaryPresets).toEqual(["halal"]);
        expect(stale?.dietaryPresets).toEqual(["halal"]);
      }),
    ),
  );
});

describe("claimService.getAllGuests", () => {
  it(
    "returns one row per guest across all families (6 total)",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        expect(rows).toHaveLength(6);
      }),
    ),
  );

  it(
    "each row carries the family publicId so the organiser can share it",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        for (const row of rows) {
          expect(row.publicId).toMatch(/^[A-Z]+-[A-Z]+-[A-Z0-9]+$/);
        }
      }),
    ),
  );

  it(
    "each row exposes its guestId",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        for (const row of rows) {
          expect(typeof row.guestId).toBe("string");
          expect(row.guestId.length).toBeGreaterThan(0);
        }
      }),
    ),
  );

  it(
    "each row exposes a nickname field (null when unset) so the editor can preserve it",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        for (const row of rows) {
          // The column is nullable; the wire shape must be `string | null`, never
          // undefined — the editor round-trips this through DesiredState.
          expect(row.nickname === null || typeof row.nickname === "string").toBe(true);
        }
      }),
    ),
  );

  it(
    "each row exposes its familyId and a null codeSharedAt by default",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        for (const row of rows) {
          expect(typeof row.familyId).toBe("string");
          expect(row.familyId.length).toBeGreaterThan(0);
          // Seed never marks a family shared.
          expect(row.codeSharedAt).toBeNull();
        }
      }),
    ),
  );

  it(
    "exposes firstOpenedAt — null by default, epoch-ms once a guest has opened",
    withDb(
      Effect.gen(function* () {
        // Untouched by the seed → every family is "never opened".
        const before = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        for (const row of before) expect(row.firstOpenedAt).toBeNull();

        // A real guest claim records the open; it then surfaces as epoch-ms.
        yield* claimService.lookup("TESTONE-IVY-AA11");
        const after = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        const opened = after.filter((r) => r.familyName === "Testfamily");
        expect(opened.length).toBeGreaterThan(0);
        for (const row of opened) expect(typeof row.firstOpenedAt).toBe("number");
      }),
    ),
  );

  it(
    "each guest has at least one event",
    withDb(
      Effect.gen(function* () {
        const rows = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        expect(rows.every((r) => r.events.length > 0)).toBe(true);
      }),
    ),
  );

  it(
    "skips guest rows whose family is missing from the families table",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        // Plant a legacy orphan row. FK enforcement (now on, matching D1)
        // forbids creating one normally, so toggle it off for this insert —
        // the service must still skip such rows defensively.
        db.run(sql`PRAGMA foreign_keys = OFF`);
        db.insert(guests)
          .values({
            id: crypto.randomUUID(),
            familyId: "non-existent-family-id",
            firstName: "Orphan",
            lastName: "Guest",
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.run(sql`PRAGMA foreign_keys = ON`);

        const rows = yield* claimService.getAllGuests(BOOTSTRAP_WEDDING_ID);
        expect(rows).toHaveLength(6);
        expect(rows.find((r) => r.firstName === "Orphan")).toBeUndefined();
      }),
    ),
  );
});

describe("claimService.lookup — first-open recording", () => {
  it(
    "records first_opened_at on the FIRST guest claim",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        expect(yield* firstOpenedAt(db, "TESTONE-IVY-AA11")).toBeNull();

        yield* claimService.lookup("TESTONE-IVY-AA11");

        const opened = yield* firstOpenedAt(db, "TESTONE-IVY-AA11");
        expect(opened).not.toBeNull();
        expect(opened).toBeGreaterThan(0);
      }),
    ),
  );

  it(
    "is idempotent — a SECOND claim never overwrites the first open",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* claimService.lookup("TESTONE-IVY-AA11");
        const first = yield* firstOpenedAt(db, "TESTONE-IVY-AA11");
        expect(first).not.toBeNull();

        // Re-claim (e.g. a guest re-opening the link / a page reload).
        yield* claimService.lookup("TESTONE-IVY-AA11");
        const second = yield* firstOpenedAt(db, "TESTONE-IVY-AA11");
        // Unchanged: reflects first contact, not the latest open.
        expect(second).toBe(first);
      }),
    ),
  );

  it(
    "does NOT record an open for a host-preview claim (kind === 'host')",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        // Plant the synthetic per-wedding host preview family.
        db.insert(families)
          .values({
            id: "fam_host",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "HOST-PREVIEWCODE0000",
            familyName: "Wedding Host",
            kind: "host",
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const result = yield* claimService.lookup("HOST-PREVIEWCODE0000");
        // The organiser's own preview — never counts as a guest opening.
        expect(result.preview).toBe(true);
        expect(yield* firstOpenedAt(db, "HOST-PREVIEWCODE0000")).toBeNull();
      }),
    ),
  );

  it(
    "returns rsvpDeadline: null when the wedding has no deadline set",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        // The shape every wedding created before the feature carries.
        expect(result.rsvpDeadline).toBeNull();
      }),
    ),
  );

  it(
    "resolves a future deadline to an open instant",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        db.update(weddings)
          .set({
            rsvpDeadline: "2999-09-01",
            rsvpDeadlineTimezone: "Australia/Sydney",
            updatedAt: new Date(),
          })
          .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
          .run();

        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(result.rsvpDeadline).toEqual({
          date: "2999-09-01",
          timezone: "Australia/Sydney",
          // End of the 1st in Sydney (AEST, +10) — the client re-derives
          // `closed` from this as the clock moves past it.
          closesAt: "2999-09-01T13:59:59.999Z",
          closed: false,
        });
      }),
    ),
  );

  it(
    "reports a past deadline as closed",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        db.update(weddings)
          .set({ rsvpDeadline: "2020-01-01", rsvpDeadlineTimezone: "UTC", updatedAt: new Date() })
          .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
          .run();

        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(result.rsvpDeadline?.closed).toBe(true);
        expect(result.rsvpDeadline?.closesAt).toBe("2020-01-01T23:59:59.999Z");
      }),
    ),
  );

  it(
    "defaults a zone-less deadline to UTC",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        db.update(weddings)
          .set({ rsvpDeadline: "2999-09-01", rsvpDeadlineTimezone: null, updatedAt: new Date() })
          .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
          .run();

        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(result.rsvpDeadline?.timezone).toBe("UTC");
        expect(result.rsvpDeadline?.closesAt).toBe("2999-09-01T23:59:59.999Z");
      }),
    ),
  );

  it("best-effort: a first-open write failure does NOT fail the claim", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    // Make the recording UPDATE throw — every other query (the reads) still
    // works, so the claim must still resolve the family's invite.
    const realUpdate = db.update.bind(db);
    let updateCalls = 0;
    (db as unknown as { update: typeof db.update }).update = ((
      table: Parameters<typeof db.update>[0],
    ) => {
      updateCalls += 1;
      throw new Error("simulated D1 write failure");
      // eslint-disable-next-line no-unreachable
      return realUpdate(table);
    }) as typeof db.update;

    const result = await Effect.runPromise(
      claimService.lookup("TESTONE-IVY-AA11").pipe(Effect.provideService(DbService, db)),
    );

    // The write was attempted (and threw) but the claim still succeeded.
    expect(updateCalls).toBeGreaterThan(0);
    expect(result.familyName).toBe("Testfamily");
    expect(result.publicId).toBe("TESTONE-IVY-AA11");
  });
});

describe("claimService.restore", () => {
  /** The family id behind a public claim code, for calling `restore` directly. */
  function familyIdFor(db: Db, publicId: string): Effect.Effect<string> {
    return Effect.gen(function* () {
      const rows = yield* Effect.promise(() =>
        Promise.resolve(
          db
            .select({ id: families.id })
            .from(families)
            .where(eq(families.publicId, publicId))
            .all(),
        ),
      );
      const row = rows[0];
      if (!row) throw new Error(`no family ${publicId}`);
      return row.id;
    });
  }

  it(
    "returns the SAME payload lookup does, field for field",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        // An FAQ entry, so the FAQ half of the compare is not `[] === []`.
        yield* Effect.promise(() =>
          Promise.resolve(
            db
              .insert(weddingFaqs)
              .values({
                id: "faq_service_parity",
                weddingId: BOOTSTRAP_WEDDING_ID,
                question: "Is there parking?",
                answer: "Yes.",
                sortOrder: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .run(),
          ),
        );
        const claimed = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(claimed.faq.entries).toEqual([{ question: "Is there parking?", answer: "Yes." }]);
        const restored = yield* claimService.restore(yield* familyIdFor(db, "TESTONE-IVY-AA11"));
        // Whole-object, not field-by-field: `buildClaimResponse` exists precisely
        // so the two entry points cannot serve different views of one household,
        // and a whole-object compare pins every field ClaimResponse ever gains.
        expect(restored).toEqual(claimed);
      }),
    ),
  );

  it(
    "does NOT record a first open — a restore is not first contact",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        expect(yield* firstOpenedAt(db, "TESTONE-IVY-AA11")).toBeNull();

        yield* claimService.restore(yield* familyIdFor(db, "TESTONE-IVY-AA11"));

        // Still null. This is the invariant the shared `buildClaimResponse`
        // creates room to break: moving the first-open write into the builder
        // would compile, keep every other test green, and start stamping
        // `first_opened_at` (and inflating `invite_opened`) on every page load.
        expect(yield* firstOpenedAt(db, "TESTONE-IVY-AA11")).toBeNull();
      }),
    ),
  );

  it(
    "leaves an ALREADY-recorded first open untouched",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* claimService.lookup("TESTONE-IVY-AA11");
        const first = yield* firstOpenedAt(db, "TESTONE-IVY-AA11");
        expect(first).not.toBeNull();

        yield* claimService.restore(yield* familyIdFor(db, "TESTONE-IVY-AA11"));

        expect(yield* firstOpenedAt(db, "TESTONE-IVY-AA11")).toBe(first);
      }),
    ),
  );

  it(
    "carries the host-preview flag — an organiser restoring a preview is still previewing",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        db.insert(families)
          .values({
            id: "fam_host_restore",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "HOST-RESTORECODE0000",
            familyName: "Host Preview",
            kind: "host",
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const restored = yield* claimService.restore("fam_host_restore");

        // `preview` gates the RSVP no-op and hides the account-link affordance;
        // a restore reporting `false` would show an organiser a live RSVP
        // surface against a synthetic household.
        expect(restored.preview).toBe(true);
      }),
    ),
  );

  it(
    "fails InvalidCredentials for a family id that no longer exists",
    withDb(
      Effect.gen(function* () {
        // Unreachable over HTTP — `sessions.family_id` cascades on delete, so
        // `sessionAuth` 401s first. That is exactly why it is tested here: the
        // guard is the production safety net for the case where the cascade
        // does NOT hold (SQLite/D1 enforce FKs only under `PRAGMA
        // foreign_keys=ON`), and without it a stale session is a 500, not a 401.
        const err = yield* Effect.flip(claimService.restore("fam_does_not_exist"));
        expect(err).toBeInstanceOf(InvalidCredentials);
      }),
    ),
  );

  it(
    "fails InvalidCredentials once the family is deactivated",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const id = yield* familyIdFor(db, "TESTFOR-JOY-DD44");
        db.update(families).set({ deactivatedAt: new Date() }).where(eq(families.id, id)).run();

        const err = yield* Effect.flip(claimService.restore(id));
        expect(err).toBeInstanceOf(InvalidCredentials);
      }),
    ),
  );
});

describe("claim payload account-link state", () => {
  /** A gate that answers the flag with `on` and counts how often it was asked. */
  function gate(on: boolean | (() => Promise<boolean>), osnSessionToken: string | null = null) {
    const calls: string[] = [];
    const g: AccountLinkGate = {
      enabledFor: (familyId) => {
        calls.push(familyId);
        return typeof on === "function" ? on() : Promise.resolve(on);
      },
      osnSessionToken,
    };
    return { gate: g, calls };
  }

  /** Link Bo's seat in the Sampleton household directly, as the link POST would. */
  function linkBo(db: Db): Effect.Effect<string> {
    return Effect.promise(async () => {
      const [family] = await db
        .select()
        .from(families)
        .where(eq(families.publicId, "TESTTWO-OAK-BB22"))
        .all();
      const [bo] = await db
        .select()
        .from(guests)
        .where(and(eq(guests.familyId, family!.id), eq(guests.firstName, "Bo")))
        .all();
      const now = new Date();
      await db
        .insert(guestAccountLinks)
        .values({
          id: "gal_test",
          guestId: bo!.id,
          familyId: family!.id,
          weddingId: family!.weddingId,
          osnAccountId: "acc_secret",
          osnProfileId: "usr_bo",
          linkedAt: now,
          updatedAt: now,
        })
        .run();
      return bo!.id;
    });
  }

  it(
    "reports linking off when the caller supplies no gate",
    withDb(
      Effect.gen(function* () {
        const result = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(result.accountLink).toEqual({ enabled: false });
      }),
    ),
  );

  it(
    "reports linking off when the flag is off for the household",
    withDb(
      Effect.gen(function* () {
        const { gate: g, calls } = gate(false);
        const result = yield* claimService.lookup("TESTONE-IVY-AA11", g);
        expect(result.accountLink).toEqual({ enabled: false });
        expect(calls).toEqual([result.familyId]);
      }),
    ),
  );

  it(
    "carries the linked seats and the OSN sign-in when linking is on",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const boId = yield* linkBo(db);
        const token = yield* Effect.promise(() => seedOrganiserSession(db, "usr_bo"));

        const signedOut = yield* claimService.lookup("TESTTWO-OAK-BB22", gate(true).gate);
        expect(signedOut.accountLink).toEqual({
          enabled: true,
          signedIn: false,
          linkedGuestIds: [boId],
        });

        const signedIn = yield* claimService.lookup("TESTTWO-OAK-BB22", gate(true, token).gate);
        expect(signedIn.accountLink).toEqual({
          enabled: true,
          signedIn: true,
          linkedGuestIds: [boId],
        });
        // The account id stays server-to-server.
        expect(JSON.stringify(signedIn)).not.toContain("acc_secret");

        // The restore reports the same state as the claim.
        const restored = yield* claimService.restore(signedIn.familyId, gate(true, token).gate);
        expect(restored.accountLink).toEqual(signedIn.accountLink);
      }),
    ),
  );

  it(
    "never offers linking to the host preview, and never reads the organiser's sign-in for it",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const { publicId } = yield* hostCodeService.ensureForWedding(
          BOOTSTRAP_WEDDING_ID,
          "cire-wedding",
        );
        // The organiser opening the preview holds a live OSN session.
        const token = yield* Effect.promise(() => seedOrganiserSession(db, "usr_owner"));
        const { gate: g, calls } = gate(true, token);

        const result = yield* claimService.lookup(publicId, g);
        expect(result.preview).toBe(true);
        expect(result.accountLink).toEqual({ enabled: false });
        expect(calls).toEqual([]);
      }),
    ),
  );

  it(
    "still opens the invite, with linking off, when the link state cannot be read",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        // A deploy whose link table is missing: the read throws.
        db.run(sql`DROP TABLE guest_account_links`);
        const result = yield* claimService.lookup("TESTTWO-OAK-BB22", gate(true).gate);
        expect(result.accountLink).toEqual({ enabled: false });
        expect(result.members).toHaveLength(3);
      }),
    ),
  );

  it(
    "still opens the invite, with linking off, when the flag provider throws",
    withDb(
      Effect.gen(function* () {
        const { gate: g } = gate(() => Promise.reject(new Error("flag outage")));
        const result = yield* claimService.lookup("TESTONE-IVY-AA11", g);
        expect(result.accountLink).toEqual({ enabled: false });
      }),
    ),
  );

  it(
    "does not hold the invite for a flag that never answers",
    withDb(
      Effect.gen(function* () {
        const { gate: g } = gate(() => new Promise<boolean>(() => {}));
        const { familyId } = yield* claimService.lookup("TESTONE-IVY-AA11");
        const started = Date.now();
        const result = yield* claimService.restore(familyId, g);
        const waited = Date.now() - started;
        expect(result.accountLink).toEqual({ enabled: false });
        expect(result.events.length).toBeGreaterThan(0);
        // It waited for the flag (`ACCOUNT_LINK_FLAG_WAIT`, 250 ms) and no
        // longer, with room either side for a slow test machine's timers.
        expect(waited).toBeGreaterThanOrEqual(200);
        expect(waited).toBeLessThan(1_000);
      }),
    ),
  );
});

describe("plus-ones in the claim payload and the organiser guest read", () => {
  const setUp = () => {
    const db = createDb(":memory:");
    seedDb(db);
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam", lastName: "Guest" });
    const run = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
      Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));
    return { db, bo, samId, run };
  };

  it("lists the plus-one straight after the member who brought them", async () => {
    const { db, bo, samId, run } = setUp();
    // Reorder the household so Bo is last: the plus-one still follows Bo, not
    // the stale sort order copied when they were named.
    db.update(guests).set({ sortOrder: 9 }).where(eq(guests.id, bo.id)).run();

    const claim = await run(claimService.lookup("TESTTWO-OAK-BB22"));
    const order = claim.members.map((m) => m.firstName);
    expect(order).toEqual(["Cleo", "Dot", "Bo", "Sam"]);

    const sam = claim.members.find((m) => m.guestId === samId)!;
    expect(sam).toMatchObject({ plusOneOf: bo.id, plusOneAllowed: false, lastName: "Guest" });
    expect(sam.eventIds.toSorted()).toEqual(eventIdsOf(db, bo.id));
    expect(claim.members.find((m) => m.guestId === bo.id)).toMatchObject({
      plusOneAllowed: true,
      plusOneOf: null,
    });
  });

  /**
   * "Current" decides whether a consent box may open already ticked, so it has
   * to mean "this row's record was made by the person that box speaks for,
   * against the words it shows now". A member's own box is the guest's; a
   * plus-one's is the household's attestation. A record anyone else made — an
   * organiser's phone reply above all — never pre-ticks either.
   */
  it("counts a reply's consent as current only against the copy its box shows", async () => {
    const { db, bo, samId, run } = setUp();
    const events = eventIdsOf(db, bo.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const [first, second] = events as [string, string];
    const reply = (
      guestId: string,
      eventId: string,
      consentSource: "guest" | "organiser_attested" | "inviter_attested",
      version: string,
    ) =>
      db
        .insert(rsvps)
        .values({
          id: crypto.randomUUID(),
          guestId,
          eventId,
          status: "attending",
          dietary: "",
          dietaryPresets: "nuts",
          consentSource,
          dietaryConsentAt: new Date(),
          dietaryConsentVersion: version,
          createdAt: new Date(),
        })
        .run();
    reply(bo.id, first, "guest", DIETARY_CONSENT_VERSION);
    reply(bo.id, second, "organiser_attested", ORGANISER_DIETARY_ATTESTATION.version);
    reply(samId, first, "inviter_attested", PLUS_ONE_DIETARY_ATTESTATION.version);
    reply(samId, second, "inviter_attested", DIETARY_CONSENT_VERSION);

    const claim = await run(claimService.lookup("TESTTWO-OAK-BB22"));
    const current = (guestId: string, eventId: string) =>
      claim.rsvps.find((r) => r.guestId === guestId && r.eventId === eventId)
        ?.dietaryConsentCurrent;
    expect(current(bo.id, first)).toBe(true);
    expect(current(bo.id, second)).toBe(false);
    expect(current(samId, first)).toBe(true);
    expect(current(samId, second)).toBe(false);
  });

  it("carries both fields on every organiser guest row", async () => {
    const { bo, samId, run } = setUp();
    const rows = await run(claimService.getAllGuests(BOOTSTRAP_WEDDING_ID));
    expect(rows.find((r) => r.guestId === samId)).toMatchObject({
      plusOneOf: bo.id,
      plusOneAllowed: false,
    });
    expect(rows.find((r) => r.guestId === bo.id)).toMatchObject({
      plusOneOf: null,
      plusOneAllowed: true,
    });
    const ada = rows.find((r) => r.firstName === "Ada")!;
    expect(ada).toMatchObject({ plusOneOf: null, plusOneAllowed: false });
  });
});

describe("plus-ones in the organiser household counts", () => {
  it("counts a named plus-one in their household, and a permission alone not at all", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const run = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
      Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));
    const bo = guestNamed(db, "Bo");
    const count = async () =>
      (await run(claimService.getAllHouseholds(BOOTSTRAP_WEDDING_ID))).find(
        (h) => h.familyId === bo.familyId,
      )!.guestCount;
    const before = await count();

    allowPlusOne(db, bo.id);
    expect(await count()).toBe(before);

    seedPlusOne(db, bo.id, { firstName: "Sam" });
    expect(await count()).toBe(before + 1);
  });
});

describe("withPlusOnesAfterInviters", () => {
  const m = (guestId: string, plusOneOf: string | null = null) => ({ guestId, plusOneOf });

  it("moves each plus-one to sit right after their inviter", () => {
    const out = withPlusOnesAfterInviters([m("a"), m("b"), m("q", "a"), m("p", "b")]);
    expect(out.map((x) => x.guestId)).toEqual(["a", "q", "b", "p"]);
  });

  it("keeps a plus-one whose inviter is not in the list, where it was", () => {
    const out = withPlusOnesAfterInviters([m("a"), m("p", "gone"), m("b"), m("q", "a")]);
    expect(out.map((x) => x.guestId)).toEqual(["a", "q", "p", "b"]);
  });

  it("leaves a household with no plus-one as it is", () => {
    const members = [m("a"), m("b")];
    expect(withPlusOnesAfterInviters(members)).toEqual(members);
  });
});

describe("decodePalette", () => {
  it("keeps swatches whose colour is on the allow-list", () => {
    const raw = JSON.stringify([
      { name: "Blush", color: "#f4c2c2" },
      { name: "Marigold", color: "oklch(76% 0.15 75)" },
    ]);
    expect(decodePalette(raw)).toEqual({
      palette: [
        { name: "Blush", color: "#f4c2c2" },
        { name: "Marigold", color: "oklch(76% 0.15 75)" },
      ],
      malformed: false,
    });
  });

  it("drops a stored swatch whose colour is not a colour, so no renderer ever sees it", () => {
    const raw = JSON.stringify([
      { name: "Blue", color: "url(https://attacker.example/p.gif)" },
      { name: "Gold", color: "gold" },
      { name: "Sage", color: "#b2ac88" },
    ]);
    expect(decodePalette(raw)).toEqual({
      palette: [{ name: "Sage", color: "#b2ac88" }],
      malformed: false,
    });
  });
});
