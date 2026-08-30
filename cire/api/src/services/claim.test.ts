import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests, weddings } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../db";
import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { claimService, InvalidCredentials } from "./claim";

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
        const claimed = yield* claimService.lookup("TESTONE-IVY-AA11");
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
