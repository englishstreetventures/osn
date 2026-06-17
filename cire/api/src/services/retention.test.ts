import { describe, it, expect } from "bun:test";

import { weddings, families, guests, events, rsvps, imports } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { retentionService, RETENTION_AFTER_FINAL_EVENT_MS } from "./retention";

const withDb = effWith(TestDbLayer);

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Build a self-contained wedding with one family, one guest, and one RSVP
 * (carrying dietary + consent), plus a set of events. Returns the ids so a test
 * can assert on what survives the sweep. Scoped to its own wedding so it never
 * collides with the bootstrap seed.
 */
function makeWedding(opts: {
  eventDates: string[];
  withImport?: boolean;
}): Effect.Effect<
  { weddingId: string; familyId: string; guestId: string; rsvpId: string },
  never,
  DbService
> {
  return Effect.gen(function* () {
    // The test layer is bun:sqlite — synchronous; call `.run()` directly.
    const db = yield* DbService;
    const now = new Date();
    const weddingId = `wed_${crypto.randomUUID()}`;
    const familyId = crypto.randomUUID();
    const guestId = crypto.randomUUID();
    const rsvpId = crypto.randomUUID();

    db.insert(weddings)
      .values({
        id: weddingId,
        slug: `slug-${weddingId}`,
        displayName: "Test Wedding",
        ownerOsnProfileId: "usr_test",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(families)
      .values({
        id: familyId,
        weddingId,
        publicId: `PUB-${weddingId}`,
        familyName: "Smith",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(guests)
      .values({
        id: guestId,
        familyId,
        firstName: "Alex",
        lastName: "Smith",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    opts.eventDates.forEach((date, i) => {
      db.insert(events)
        .values({
          id: `${weddingId}-ev-${i}`,
          weddingId,
          slug: `${weddingId}-ev-${i}`,
          name: `Event ${i}`,
          date,
          location: "Somewhere",
          startAt: `${date}T10:00:00+11:00`,
          endAt: `${date}T12:00:00+11:00`,
          timezone: "Australia/Sydney",
        })
        .run();
    });

    // RSVP carries the special-category dietary free-text + consent records.
    const firstEventId = opts.eventDates.length > 0 ? `${weddingId}-ev-0` : undefined;
    if (firstEventId) {
      db.insert(rsvps)
        .values({
          id: rsvpId,
          guestId,
          eventId: firstEventId,
          status: "attending",
          dietary: "nut allergy",
          dietaryConsentAt: now,
          dietaryConsentVersion: "v1",
          createdAt: now,
        })
        .run();
    }

    if (opts.withImport) {
      db.insert(imports)
        .values({
          id: crypto.randomUUID(),
          weddingId,
          uploadedAt: now.getTime(),
          format: "csv",
          eventsR2Key: `imports/${weddingId}/events.csv`,
          guestsR2Key: `imports/${weddingId}/guests.csv`,
          summary: "{}",
          status: "applied",
        })
        .run();
    }

    return { weddingId, familyId, guestId, rsvpId };
  });
}

describe("RETENTION_AFTER_FINAL_EVENT_MS", () => {
  it("is exactly 365 days in milliseconds", () => {
    expect(RETENTION_AFTER_FINAL_EVENT_MS).toBe(YEAR_MS);
  });
});

describe("retentionService.sweepExpiredGuestData", () => {
  it(
    "deletes guests + rsvps for a wedding whose final event is >1 year before now",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        // Final event ~13 months ago.
        const { weddingId, familyId, guestId, rsvpId } = yield* makeWedding({
          eventDates: ["2025-04-01", "2025-05-10"],
        });

        const deleted = yield* retentionService.sweepExpiredGuestData(now);
        expect(deleted).toBeGreaterThanOrEqual(1);

        const guestRows = db.select().from(guests).where(eq(guests.id, guestId)).all();
        expect(guestRows.length).toBe(0);
        const rsvpRows = db.select().from(rsvps).where(eq(rsvps.id, rsvpId)).all();
        expect(rsvpRows.length).toBe(0);
        // The family row (a guest-PII container) goes too.
        const famRows = db.select().from(families).where(eq(families.id, familyId)).all();
        expect(famRows.length).toBe(0);
        // The wedding + its events shell is intentionally kept.
        const evRows = db.select().from(events).where(eq(events.weddingId, weddingId)).all();
        expect(evRows.length).toBe(2);
        const wedRows = db.select().from(weddings).where(eq(weddings.id, weddingId)).all();
        expect(wedRows.length).toBe(1);
      }),
    ),
  );

  it(
    "removes the dietary free-text and consent records along with the rsvp row",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { guestId } = yield* makeWedding({ eventDates: ["2024-01-01"] });

        yield* retentionService.sweepExpiredGuestData(now);

        const remaining = db.select().from(rsvps).where(eq(rsvps.guestId, guestId)).all();
        expect(remaining.length).toBe(0);
      }),
    ),
  );

  it(
    "keeps guests + rsvps for a wedding whose final event is <1 year before now",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        // Final event 2 months ago.
        const { guestId, rsvpId } = yield* makeWedding({
          eventDates: ["2026-03-01", "2026-04-15"],
        });

        yield* retentionService.sweepExpiredGuestData(now);

        expect(db.select().from(guests).where(eq(guests.id, guestId)).all().length).toBe(1);
        expect(db.select().from(rsvps).where(eq(rsvps.id, rsvpId)).all().length).toBe(1);
      }),
    ),
  );

  it(
    "keeps a wedding that has no events at all (cannot prove the window lapsed)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { guestId } = yield* makeWedding({ eventDates: [] });

        yield* retentionService.sweepExpiredGuestData(now);

        expect(db.select().from(guests).where(eq(guests.id, guestId)).all().length).toBe(1);
      }),
    ),
  );

  it(
    "deletes imports rows for an expired wedding",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
        });

        yield* retentionService.sweepExpiredGuestData(now);

        expect(db.select().from(imports).where(eq(imports.weddingId, weddingId)).all().length).toBe(
          0,
        );
      }),
    ),
  );

  it(
    "treats a wedding whose final event is exactly 1 year + 1ms ago as expired",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        // now is well past a 2024 event → expired.
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { guestId } = yield* makeWedding({ eventDates: ["2025-06-16"] });

        const deleted = yield* retentionService.sweepExpiredGuestData(now);
        expect(deleted).toBeGreaterThanOrEqual(1);
        expect(db.select().from(guests).where(eq(guests.id, guestId)).all().length).toBe(0);
      }),
    ),
  );
});
