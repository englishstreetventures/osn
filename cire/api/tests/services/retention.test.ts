import { describe, it, expect } from "bun:test";

import {
  weddings,
  families,
  guests,
  guestEvents,
  events,
  rsvps,
  imports,
  weddingInviteCustomisations,
  registryClaims,
  registryContributions,
  registrySettings,
  registryItems,
  weddingHosts,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService, dbQuery } from "../../src/db";
import { createDb, seedDb, type TestDb } from "../../src/db/setup";
import {
  CIRE_METRICS,
  type GiftSummaryUnmailedReason,
  type GiftSummaryWrittenResult,
} from "../../src/metrics";
import type { DeletableBucket } from "../../src/services/r2-cleanup";
import {
  type GiftSummaryNotice,
  MAX_WEDDINGS_PER_SWEEP,
  retentionService,
  RETENTION_AFTER_FINAL_EVENT_MS,
  GIFT_SUMMARY_HOLD_BACK_MS,
} from "../../src/services/retention";
import { TestDbLayer } from "../db/test-layer";
import { effWith, failStatements, recordStatements } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

const withDb = effWith(TestDbLayer);

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * In-memory delete-only R2 stub recording every key passed to `.delete()`.
 * Supports BOTH the single-key and the array (multi-key) delete form so the
 * reaper's array-first/per-key-fallback path is exercised. `failKeys` forces a
 * throw for the named keys (best-effort path); `rejectArray` simulates a
 * binding that throws synchronously on the array form (falls back to
 * per-key); `rejectArrayAsync` simulates a binding whose array form rejects
 * asynchronously (a real delete failure — no per-key fallback).
 */
function createDeleteStub(
  opts: { failKeys?: Set<string>; rejectArray?: boolean; rejectArrayAsync?: boolean } = {},
): DeletableBucket & {
  deleted: Set<string>;
} {
  const deleted = new Set<string>();
  const failKeys = opts.failKeys ?? new Set<string>();
  const removeOne = (key: string) => {
    if (failKeys.has(key)) throw new Error(`forced failure for ${key}`);
    deleted.add(key);
  };
  return {
    deleted,
    delete(keys: string | string[]) {
      if (Array.isArray(keys)) {
        if (opts.rejectArray) throw new Error("array delete unsupported");
        if (opts.rejectArrayAsync) return Promise.reject(new Error("array delete failed"));
        for (const k of keys) removeOne(k);
      } else {
        removeOne(keys);
      }
      return Promise.resolve();
    },
  };
}

/**
 * Build a self-contained wedding with one family, one guest, and one RSVP
 * (carrying dietary + consent), plus a set of events. Returns the ids so a test
 * can assert on what survives the sweep. Scoped to its own wedding so it never
 * collides with the bootstrap seed.
 */
function makeWedding(opts: {
  /** ISO days; an object entry marks that one event open-ended (endAt ""). */
  eventDates: (string | { date: string; openEnded: boolean })[];
  withImport?: boolean;
  /** Give the import an applied change's before-image keys as well. */
  withBeforeImage?: boolean;
  /** Add a `wedding_invite_customisations` row with hero/story image keys. */
  withInviteImages?: boolean;
  /** Give the FIRST event an `event_image_key`. */
  withEventImage?: boolean;
  /** Store the "" no-stated-end sentinel instead of a real endAt on every event. */
  openEnded?: boolean;
}): Effect.Effect<
  {
    weddingId: string;
    familyId: string;
    guestId: string;
    rsvpId: string;
    sheetKeys: string[];
    assetKeys: string[];
  },
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

    insertWedding(db, {
      id: weddingId,
      slug: `slug-${weddingId}`,
      displayName: "Test Wedding",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_test"],
    });

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

    const assetKeys: string[] = [];
    opts.eventDates.forEach((entry, i) => {
      const date = typeof entry === "string" ? entry : entry.date;
      const openEnded = typeof entry === "string" ? (opts.openEnded ?? false) : entry.openEnded;
      const eventImageKey =
        opts.withEventImage && i === 0 ? `assets/${weddingId}/event-${crypto.randomUUID()}` : null;
      if (eventImageKey) assetKeys.push(eventImageKey);
      db.insert(events)
        .values({
          id: `${weddingId}-ev-${i}`,
          weddingId,
          slug: `${weddingId}-ev-${i}`,
          name: `Event ${i}`,
          startAt: `${date}T10:00:00+11:00`,
          endAt: openEnded ? "" : `${date}T12:00:00+11:00`,
          timezone: "Australia/Sydney",
          eventImageKey,
        })
        .run();
    });

    if (opts.withInviteImages) {
      const heroKey = `assets/${weddingId}/hero-${crypto.randomUUID()}`;
      const storyKey = `assets/${weddingId}/story-${crypto.randomUUID()}`;
      assetKeys.push(heroKey, storyKey);
      db.insert(weddingInviteCustomisations)
        .values({
          weddingId,
          heroImageKey: heroKey,
          storyImageKey: storyKey,
          updatedAt: now,
        })
        .run();
    }

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
      // Invitation links — the sweep deletes these explicitly too (its contract
      // is to not depend on FK cascade), so seed one per event to exercise the
      // guest_events delete with real rows.
      for (let i = 0; i < opts.eventDates.length; i++) {
        db.insert(guestEvents)
          .values({ guestId, eventId: `${weddingId}-ev-${i}` })
          .run();
      }
    }

    const sheetKeys: string[] = [];
    if (opts.withImport) {
      const eventsR2Key = `imports/${weddingId}/events.csv`;
      const guestsR2Key = `imports/${weddingId}/guests.csv`;
      sheetKeys.push(eventsR2Key, guestsR2Key);
      const beforeEventsR2Key = opts.withBeforeImage
        ? `imports/${weddingId}/before/events.csv`
        : null;
      const beforeGuestsR2Key = opts.withBeforeImage
        ? `imports/${weddingId}/before/guests.csv`
        : null;
      if (beforeEventsR2Key && beforeGuestsR2Key) {
        sheetKeys.push(beforeEventsR2Key, beforeGuestsR2Key);
      }
      db.insert(imports)
        .values({
          id: crypto.randomUUID(),
          weddingId,
          uploadedAt: now.getTime(),
          format: "csv",
          eventsR2Key,
          guestsR2Key,
          beforeEventsR2Key,
          beforeGuestsR2Key,
          summary: "{}",
          status: "applied",
        })
        .run();
    }

    return { weddingId, familyId, guestId, rsvpId, sheetKeys, assetKeys };
  });
}

/** A seeded database the test holds the concrete handle of — `failStatements` needs it. */
function freshDb(): TestDb {
  const db = createDb(":memory:");
  seedDb(db);
  return db;
}

const runOn = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));

const GIFT_STAMP = new Date("2025-05-11T00:00:00.000Z");

/** One settled money gift from `familyId`. */
function addGift(
  weddingId: string,
  familyId: string,
  opts: { amountMinor?: number; currency?: string; at?: Date } = {},
): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const at = opts.at ?? GIFT_STAMP;
    db.insert(registryContributions)
      .values({
        id: `rct_${crypto.randomUUID()}`,
        weddingId,
        itemId: null,
        familyId,
        status: "succeeded",
        amountMinor: opts.amountMinor ?? 5_000,
        currency: opts.currency ?? "AUD",
        stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
        createdAt: at,
        updatedAt: at,
      })
      .run();
  });
}

/** {@link makeWedding} with a published registry and one settled gift. */
function makeGiftedWedding(
  eventDate: string,
  opts: { withImport?: boolean; amountMinor?: number } = {},
): ReturnType<typeof makeWedding> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const wedding = yield* makeWedding({ eventDates: [eventDate], withImport: opts.withImport });
    db.insert(registrySettings)
      .values({
        weddingId: wedding.weddingId,
        published: true,
        createdAt: GIFT_STAMP,
        updatedAt: GIFT_STAMP,
      })
      .run();
    yield* addGift(wedding.weddingId, wedding.familyId, { amountMinor: opts.amountMinor });
    return wedding;
  });
}

const guestCount = (db: TestDb, guestId: string): number =>
  db.select().from(guests).where(eq(guests.id, guestId)).all().length;

const importsLeft = (db: TestDb, weddingId: string): number =>
  db.select().from(imports).where(eq(imports.weddingId, weddingId)).all().length;

const contributionCount = (db: TestDb, weddingId: string): number =>
  db
    .select()
    .from(registryContributions)
    .where(eq(registryContributions.weddingId, weddingId))
    .all().length;

const storedSummary = (db: TestDb, weddingId: string): string | null =>
  db
    .select({ json: registrySettings.giftSummaryJson })
    .from(registrySettings)
    .where(eq(registrySettings.weddingId, weddingId))
    .get()?.json ?? null;

const written = (result: GiftSummaryWrittenResult) =>
  counterValue(CIRE_METRICS.giftSummaryWritten, { result });

const unmailed = (reason: GiftSummaryUnmailedReason) =>
  counterValue(CIRE_METRICS.giftSummaryUnmailed, { reason });

const SWEEP_AT = new Date("2026-06-17T04:00:00.000Z");

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
        // EXACT count — the sweep reads the guests-delete result by position in
        // the batch result array (rsvps, guest_events, guests, …), so an
        // off-by-one there would report an rsvp/link count instead. One guest
        // was seeded; the metric subject must be exactly 1.
        expect(deleted).toBe(1);

        const guestRows = yield* dbQuery(() =>
          db.select().from(guests).where(eq(guests.id, guestId)).all(),
        );
        expect(guestRows.length).toBe(0);
        const rsvpRows = yield* dbQuery(() =>
          db.select().from(rsvps).where(eq(rsvps.id, rsvpId)).all(),
        );
        expect(rsvpRows.length).toBe(0);
        // The invitation links go via the sweep's own explicit delete, not FK
        // cascade (two were seeded — one per event).
        const linkRows = yield* dbQuery(() =>
          db.select().from(guestEvents).where(eq(guestEvents.guestId, guestId)).all(),
        );
        expect(linkRows.length).toBe(0);
        // The family row (a guest-PII container) goes too.
        const famRows = yield* dbQuery(() =>
          db.select().from(families).where(eq(families.id, familyId)).all(),
        );
        expect(famRows.length).toBe(0);
        // The wedding + its events shell is intentionally kept.
        const evRows = yield* dbQuery(() =>
          db.select().from(events).where(eq(events.weddingId, weddingId)).all(),
        );
        expect(evRows.length).toBe(2);
        const wedRows = yield* dbQuery(() =>
          db.select().from(weddings).where(eq(weddings.id, weddingId)).all(),
        );
        expect(wedRows.length).toBe(1);
      }),
    ),
  );

  it(
    "sweeps a plus-one with their household and counts them exactly",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { familyId, guestId } = yield* makeWedding({ eventDates: ["2025-04-01"] });
        // A plus-one inserted AFTER their inviter, so the guests delete meets
        // the inviter first and the foreign key's cascade takes the plus-one.
        // The count must still hold each of them exactly once.
        const at = new Date();
        yield* dbQuery(() =>
          db
            .insert(guests)
            .values({
              id: `${guestId}_plus`,
              familyId,
              firstName: "Sam",
              source: "manual",
              plusOneOfGuestId: guestId,
              createdAt: at,
              updatedAt: at,
            })
            .run(),
        );

        expect(yield* retentionService.sweepExpiredGuestData(now)).toBe(2);
        const left = yield* dbQuery(() =>
          db.select().from(guests).where(eq(guests.familyId, familyId)).all(),
        );
        expect(left).toEqual([]);
      }),
    ),
  );

  it("takes the longest-overdue weddings first when the cohort is over the per-run cap, and the rest on the next run", async () => {
    const db = freshDb();
    const now = new Date("2026-06-17T04:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse("2023-01-01T00:00:00.000Z");

    // One more expired wedding than one run will take, each a day later than
    // the last, and inserted newest-first so row order cannot stand in for the
    // ORDER BY.
    const seeded = await runOn(
      db,
      Effect.gen(function* () {
        const out = [];
        for (let i = MAX_WEDDINGS_PER_SWEEP; i >= 0; i--) {
          const date = new Date(start + i * day).toISOString().slice(0, 10);
          out.push(yield* makeWedding({ eventDates: [date] }));
        }
        return out;
      }),
    );
    const newest = seeded[0]!;
    const oldest = seeded[seeded.length - 1]!;

    expect(await runOn(db, retentionService.sweepExpiredGuestData(now))).toBe(
      MAX_WEDDINGS_PER_SWEEP,
    );
    // The one wedding the cap left behind is the most recent, not an
    // arbitrary one.
    expect({
      newest: guestCount(db, newest.guestId),
      oldest: guestCount(db, oldest.guestId),
    }).toEqual({ newest: 1, oldest: 0 });

    // The swept weddings keep their events, but hold nothing left to delete,
    // so they no longer fill the cohort: the next run reaches the newest.
    expect(await runOn(db, retentionService.sweepExpiredGuestData(now))).toBe(1);
    expect(guestCount(db, newest.guestId)).toBe(0);
  });

  it("counts and logs a sweep whose cohort read fails", async () => {
    const db = freshDb();
    await runOn(db, makeWedding({ eventDates: ["2025-04-01"] }));
    const before = await counterValue(CIRE_METRICS.guestDataSwept, { result: "error" });
    // A failed read surfaces as a defect, not a typed failure; it must still
    // be counted and logged here rather than only in the runtime's record.
    const fault = failStatements(db, (sql) => sql.includes('from "events"'));

    let failed = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        retentionService.sweepExpiredGuestData(SWEEP_AT).pipe(Effect.provideService(DbService, db)),
      );
      failed = Exit.isFailure(exit);
    });

    expect(fault.failed()).toBe(1);
    expect(failed).toBe(true);
    expect(logs).toContain("guest-data retention sweep failed");
    expect(await counterValue(CIRE_METRICS.guestDataSwept, { result: "error" })).toBe(before + 1);
  });

  it(
    "removes the dietary free-text and consent records along with the rsvp row",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { guestId } = yield* makeWedding({ eventDates: ["2024-01-01"] });

        yield* retentionService.sweepExpiredGuestData(now);

        const remaining = yield* dbQuery(() =>
          db.select().from(rsvps).where(eq(rsvps.guestId, guestId)).all(),
        );
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

        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(1);
        expect(
          (yield* dbQuery(() => db.select().from(rsvps).where(eq(rsvps.id, rsvpId)).all())).length,
        ).toBe(1);
      }),
    ),
  );

  it(
    "keeps a RECENT wedding whose events are all open-ended (endAt '' falls back to startAt)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        // Final event 2 months ago, but every endAt is the "" sentinel — a naive
        // max(end_at) would aggregate to "" < cutoff and sweep it immediately.
        const { guestId, rsvpId } = yield* makeWedding({
          eventDates: ["2026-03-01", "2026-04-15"],
          openEnded: true,
        });

        yield* retentionService.sweepExpiredGuestData(now);

        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(1);
        expect(
          (yield* dbQuery(() => db.select().from(rsvps).where(eq(rsvps.id, rsvpId)).all())).length,
        ).toBe(1);
      }),
    ),
  );

  it(
    "keeps a MIXED wedding: old dated event + recent open-ended event (per-row effective end)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        // A wrong implementation that aggregates end_at and start_at separately
        // (max(max(end_at), max(start_at))) or drops ''-end rows passes the
        // all-dated and all-open-ended tests but diverges here: the dated event
        // ended >1 year ago, and only the open-ended event's RECENT start keeps
        // the wedding alive.
        const { guestId, rsvpId } = yield* makeWedding({
          eventDates: ["2025-04-01", { date: "2026-04-15", openEnded: true }],
        });

        yield* retentionService.sweepExpiredGuestData(now);

        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(1);
        expect(
          (yield* dbQuery(() => db.select().from(rsvps).where(eq(rsvps.id, rsvpId)).all())).length,
        ).toBe(1);
      }),
    ),
  );

  it(
    "sweeps a MIXED wedding once every per-row effective end is past the cutoff",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { guestId } = yield* makeWedding({
          eventDates: ["2025-03-01", { date: "2025-04-15", openEnded: true }],
        });

        yield* retentionService.sweepExpiredGuestData(now);

        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(0);
      }),
    ),
  );

  it(
    "still sweeps an EXPIRED wedding whose events are all open-ended (startAt >1 year ago)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { guestId } = yield* makeWedding({
          eventDates: ["2025-04-01"],
          openEnded: true,
        });

        yield* retentionService.sweepExpiredGuestData(now);

        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(0);
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

        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(1);
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

        expect(
          (yield* dbQuery(() =>
            db.select().from(imports).where(eq(imports.weddingId, weddingId)).all(),
          )).length,
        ).toBe(0);
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
        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(0);
      }),
    ),
  );

  it(
    "deletes the expired wedding's uploaded-sheet R2 objects (cire-sheets bucket)",
    withDb(
      Effect.gen(function* () {
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { sheetKeys } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
        });
        // Sanity: the fixture produced both the events + guests sheet keys.
        expect(sheetKeys.length).toBe(2);

        const sheets = createDeleteStub();
        yield* retentionService.sweepExpiredGuestData(now, { sheets });

        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(true);
        expect(sheets.deleted.size).toBe(2);
      }),
    ),
  );

  it(
    "leaves the KEPT invite's cire-assets images untouched (rows survive the sweep)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        // Expired wedding WITH invite + event images. The sweep keeps the
        // wedding/events shell + the customisation row, so its images must NOT
        // be deleted (the invite stays live) — even though sheets are reaped.
        const { weddingId, assetKeys, sheetKeys } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
          withInviteImages: true,
          withEventImage: true,
        });
        expect(assetKeys.length).toBe(3);

        const sheets = createDeleteStub();
        yield* retentionService.sweepExpiredGuestData(now, { sheets });

        // Sheets reaped…
        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(true);
        // …but the customisation row + its image keys survive in D1.
        const cust = yield* dbQuery(() =>
          db
            .select()
            .from(weddingInviteCustomisations)
            .where(eq(weddingInviteCustomisations.weddingId, weddingId))
            .all(),
        );
        expect(cust.length).toBe(1);
        expect(cust[0]?.heroImageKey).not.toBeNull();
        // And the event row keeps its image key.
        const evs = yield* dbQuery(() =>
          db.select().from(events).where(eq(events.weddingId, weddingId)).all(),
        );
        expect(evs.some((e) => e.eventImageKey !== null)).toBe(true);
      }),
    ),
  );

  it(
    "falls back to per-key delete when the binding rejects the array form",
    withDb(
      Effect.gen(function* () {
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { sheetKeys } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
        });
        // rejectArray ⇒ the array-delete throws; the reaper must retry per-key.
        const sheets = createDeleteStub({ rejectArray: true });
        yield* retentionService.sweepExpiredGuestData(now, { sheets });
        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(true);
      }),
    ),
  );

  it(
    "does not fall back to per-key delete when the array form rejects asynchronously",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, guestId, sheetKeys } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
        });
        // rejectArrayAsync ⇒ the array delete rejects after being called — a
        // real delete failure, not a feature gap, so there is no per-key retry.
        const sheets = createDeleteStub({ rejectArrayAsync: true });

        // The sweep still resolves (best-effort) and the D1 rows are gone.
        const deleted = yield* retentionService.sweepExpiredGuestData(now, { sheets });
        expect(deleted).toBeGreaterThanOrEqual(1);
        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(0);
        expect(
          (yield* dbQuery(() =>
            db.select().from(imports).where(eq(imports.weddingId, weddingId)).all(),
          )).length,
        ).toBe(0);
        // No per-key fallback ran, so nothing was recorded as deleted.
        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(false);
        expect(sheets.deleted.size).toBe(0);
      }),
    ),
  );

  it(
    "does NOT abort the sweep when an R2 delete fails (best-effort)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, guestId, sheetKeys } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
        });
        // Force the (array) delete to throw for this bucket; per-key retry also
        // throws for the failing keys ⇒ the chunk is logged + counted, not raised.
        const sheets = createDeleteStub({ failKeys: new Set(sheetKeys), rejectArray: true });

        // The sweep still resolves (no rejection) and the D1 rows are gone.
        const deleted = yield* retentionService.sweepExpiredGuestData(now, { sheets });
        expect(deleted).toBeGreaterThanOrEqual(1);
        expect(
          (yield* dbQuery(() => db.select().from(guests).where(eq(guests.id, guestId)).all()))
            .length,
        ).toBe(0);
        expect(
          (yield* dbQuery(() =>
            db.select().from(imports).where(eq(imports.weddingId, weddingId)).all(),
          )).length,
        ).toBe(0);
        // The failing keys were never recorded as deleted.
        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(false);
      }),
    ),
  );

  it(
    "deletes an applied change's before-image objects along with its uploads",
    withDb(
      Effect.gen(function* () {
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { sheetKeys } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
          withBeforeImage: true,
        });
        expect(sheetKeys.length).toBe(4);

        const sheets = createDeleteStub();
        yield* retentionService.sweepExpiredGuestData(now, { sheets });

        expect([...sheets.deleted].toSorted()).toEqual([...sheetKeys].toSorted());
      }),
    ),
  );

  it(
    "leaves a non-expired wedding's R2 objects untouched",
    withDb(
      Effect.gen(function* () {
        const now = new Date("2026-06-17T04:00:00.000Z");
        // Final event 2 months ago ⇒ NOT expired.
        const { sheetKeys } = yield* makeWedding({
          eventDates: ["2026-04-15"],
          withImport: true,
        });
        const sheets = createDeleteStub();
        yield* retentionService.sweepExpiredGuestData(now, { sheets });

        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(false);
        expect(sheets.deleted.size).toBe(0);
      }),
    ),
  );

  it(
    "collects R2 keys BEFORE deleting the rows (ordering correctness)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, sheetKeys } = yield* makeWedding({
          eventDates: ["2024-06-01"],
          withImport: true,
        });

        // If the keys were collected only AFTER the row deletes, the `imports`
        // rows would already be gone and nothing would be handed to the reaper —
        // so correct ordering is proven by the reaper still receiving every key.
        const sheets = createDeleteStub();
        yield* retentionService.sweepExpiredGuestData(now, { sheets });

        // The `imports` rows are gone…
        expect(
          (yield* dbQuery(() =>
            db.select().from(imports).where(eq(imports.weddingId, weddingId)).all(),
          )).length,
        ).toBe(0);
        // …yet every sheet key they referenced was reaped (proving pre-delete collect).
        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(true);
        expect(sheets.deleted.size).toBe(sheetKeys.length);
      }),
    ),
  );
});

describe("the parting gift summary", () => {
  /**
   * Gifts are guest data: claims and contributions hang off `families`, so the
   * sweep's family delete cascades them away. The window is deliberate — cire
   * holds no funds and has no record-keeping duty of its own — but the couple
   * should not find the record simply gone, so a summary lands on the settings
   * row the sweep keeps. `wiki/compliance/retention.md`.
   */
  it(
    "counts what arrived, and leaves it where the sweep cannot reach",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, familyId } = yield* makeWedding({
          eventDates: ["2025-04-01", "2025-05-10"],
        });
        const stamp = new Date("2025-05-11T00:00:00.000Z");
        db.insert(registrySettings)
          .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
          .run();
        const item = `reg_${crypto.randomUUID()}`;
        db.insert(registryItems)
          .values({
            id: item,
            weddingId,
            kind: "product",
            title: "Copper pan",
            quantityWanted: 3,
            sortOrder: 0,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();
        // One claim row per (item, family) is the unique constraint, so the
        // three states go on three items.
        for (const [index, [status, quantity]] of (
          [
            ["reserved", 1],
            ["purchased", 2],
            ["released", 5],
          ] as const
        ).entries()) {
          const itemId = `reg_${index}_${crypto.randomUUID()}`;
          db.insert(registryItems)
            .values({
              id: itemId,
              weddingId,
              kind: "product",
              title: `Gift ${index}`,
              quantityWanted: 9,
              sortOrder: index,
              createdAt: stamp,
              updatedAt: stamp,
            })
            .run();
          db.insert(registryClaims)
            .values({
              id: `rcl_${crypto.randomUUID()}`,
              weddingId,
              itemId,
              familyId,
              quantity,
              status,
              createdAt: stamp,
              updatedAt: stamp,
            })
            .run();
        }
        const gift = (
          status: "succeeded" | "pending",
          amountMinor: number,
          currency: string,
          at: Date = stamp,
        ) =>
          db
            .insert(registryContributions)
            .values({
              id: `rct_${crypto.randomUUID()}`,
              weddingId,
              itemId: null,
              familyId,
              status,
              amountMinor,
              currency,
              stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
              message: "Enjoy Japan",
              displayName: "The Ashworths",
              createdAt: at,
              updatedAt: at,
            })
            .run();
        gift("succeeded", 12_500, "AUD");
        gift("succeeded", 5_000, "AUD");
        gift("succeeded", 3_000, "JPY", new Date("2025-05-20T00:00:00.000Z"));
        // Latest of all of them AND unsettled: it must move neither the totals
        // nor the range, which is what proves the range is taken from the same
        // rows as the counts.
        gift("pending", 99_999, "AUD", new Date("2026-01-05T00:00:00.000Z"));

        const writtenBefore = yield* Effect.promise(() => written("ok"));
        yield* retentionService.sweepExpiredGuestData(now);
        expect(yield* Effect.promise(() => written("ok"))).toBe(writtenBefore + 1);

        const row = yield* dbQuery(() =>
          db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).get(),
        );
        expect(row?.giftSummaryAt).not.toBeNull();
        const summary = JSON.parse(row?.giftSummaryJson ?? "{}") as {
          sweptOn: string;
          firstGiftOn: string;
          lastGiftOn: string;
          claims: { reserved: number; purchased: number };
          contributions: { count: number; totals: { currency: string; amountMinor: number }[] };
        };
        expect(summary.sweptOn).toBe("2026-06-17");
        // The span the counted gifts actually arrived over — epoch seconds out
        // of `min()`/`max()`, rendered as ISO days. The released claim and the
        // unsettled charge fall outside it for the same reason they fall
        // outside the totals.
        expect(summary.firstGiftOn).toBe("2025-05-11");
        expect(summary.lastGiftOn).toBe("2025-05-20");
        // A released claim is what they did NOT receive; counting it would
        // overstate the record.
        expect(summary.claims).toEqual({ reserved: 1, purchased: 2 });
        // Only money that actually moved, summed per currency — never converted.
        expect(summary.contributions.count).toBe(3);
        expect(summary.contributions.totals).toEqual([
          { currency: "AUD", amountMinor: 17_500 },
          { currency: "JPY", amountMinor: 3_000 },
        ]);
        // AGGREGATES ONLY. The detail is gone, and the summary must not be the
        // deletion undone in the row next door.
        const raw = row?.giftSummaryJson ?? "";
        expect(raw).not.toContain("Ashworth");
        expect(raw).not.toContain("Enjoy Japan");
        expect(raw).not.toContain(familyId);
        // And the gifts themselves went with the households.
        const contributionsLeft = yield* dbQuery(() =>
          db
            .select()
            .from(registryContributions)
            .where(eq(registryContributions.weddingId, weddingId))
            .all(),
        );
        expect(contributionsLeft.length).toBe(0);
        const claimsLeft = yield* dbQuery(() =>
          db.select().from(registryClaims).where(eq(registryClaims.weddingId, weddingId)).all(),
        );
        expect(claimsLeft.length).toBe(0);
      }),
    ),
  );

  it(
    "hands the notifier one notice per swept wedding, and only after the detail is gone",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, familyId } = yield* makeWedding({ eventDates: ["2025-05-10"] });
        const stamp = new Date("2025-05-11T00:00:00.000Z");
        db.insert(registrySettings)
          .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
          .run();
        db.insert(registryContributions)
          .values({
            id: `rct_${crypto.randomUUID()}`,
            weddingId,
            itemId: null,
            familyId,
            status: "succeeded",
            amountMinor: 12_500,
            currency: "AUD",
            stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
            message: "Enjoy Japan",
            displayName: "The Ashworths",
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();

        const seen: GiftSummaryNotice[][] = [];
        let rowsLeftWhenNotified = -1;
        const notify = (notices: readonly GiftSummaryNotice[]) =>
          Effect.gen(function* () {
            seen.push([...notices]);
            // The email says the detail is gone, so it must not be sent while
            // it is still there. Counted at the moment of the call, not after.
            const left = yield* dbQuery(() =>
              db
                .select()
                .from(registryContributions)
                .where(eq(registryContributions.weddingId, weddingId))
                .all(),
            );
            rowsLeftWhenNotified = left.length;
          });

        yield* retentionService.sweepExpiredGuestData(now, {}, notify);

        expect(seen.length).toBe(1);
        expect(rowsLeftWhenNotified).toBe(0);
        const notice = seen[0]?.[0];
        expect(notice?.weddingId).toBe(weddingId);
        expect(notice?.ownerOsnProfileIds).toEqual(["usr_test"]);
        expect(notice?.finalEventOn).toBe("2025-05-10");
        expect(notice?.summary.contributions.count).toBe(1);
        // The notice carries aggregates only, same as the stored summary.
        const asText = JSON.stringify(notice);
        expect(asText).not.toContain("Ashworth");
        expect(asText).not.toContain("Enjoy Japan");
      }),
    ),
  );

  it(
    "writes a soft-deleted wedding's summary but mails none of its owners",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, familyId } = yield* makeWedding({ eventDates: ["2025-05-10"] });
        const stamp = new Date("2025-05-11T00:00:00.000Z");
        db.insert(registrySettings)
          .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
          .run();
        db.insert(registryContributions)
          .values({
            id: `rct_${crypto.randomUUID()}`,
            weddingId,
            itemId: null,
            familyId,
            status: "succeeded",
            amountMinor: 5_000,
            currency: "AUD",
            stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();
        db.update(weddings)
          .set({
            deletedAt: new Date("2026-06-15T00:00:00.000Z"),
            deletedByOsnProfileId: "usr_test",
          })
          .where(eq(weddings.id, weddingId))
          .run();

        const seen: GiftSummaryNotice[][] = [];
        yield* retentionService.sweepExpiredGuestData(now, {}, (notices) =>
          Effect.sync(() => void seen.push([...notices])),
        );

        // Nobody is mailed about a wedding its owners deleted...
        expect(seen.flat()).toEqual([]);
        // ...and the summary is still written, so a restore finds it.
        const [settings] = yield* dbQuery(() =>
          db
            .select({ summary: registrySettings.giftSummaryJson })
            .from(registrySettings)
            .where(eq(registrySettings.weddingId, weddingId))
            .all(),
        );
        expect(settings?.summary).not.toBeNull();
      }),
    ),
  );

  it(
    "names every owner of a swept wedding on its notice, oldest seat first, and no co-host",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, familyId } = yield* makeWedding({ eventDates: ["2025-05-10"] });
        const stamp = new Date("2025-05-11T00:00:00.000Z");
        const later = new Date(Date.now() + 60_000);
        for (const [osnProfileId, role] of [
          ["usr_second_owner", "owner"],
          ["usr_planner", "editor"],
        ] as const) {
          db.insert(weddingHosts)
            .values({
              id: `whost_${osnProfileId}_${weddingId}`,
              weddingId,
              osnProfileId,
              addedByOsnProfileId: "usr_test",
              role,
              createdAt: later,
            })
            .run();
        }
        db.insert(registrySettings)
          .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
          .run();
        db.insert(registryContributions)
          .values({
            id: `rct_${crypto.randomUUID()}`,
            weddingId,
            itemId: null,
            familyId,
            status: "succeeded",
            amountMinor: 5_000,
            currency: "AUD",
            stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();

        const seen: GiftSummaryNotice[] = [];
        yield* retentionService.sweepExpiredGuestData(now, {}, (notices) =>
          Effect.sync(() => {
            seen.push(...notices);
          }),
        );

        const notice = seen.find((n) => n.weddingId === weddingId);
        expect(notice?.ownerOsnProfileIds).toEqual(["usr_test", "usr_second_owner"]);
      }),
    ),
  );

  it(
    "does not call the notifier when the cohort produced no summaries",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId } = yield* makeWedding({ eventDates: ["2025-04-01"] });
        const stamp = new Date("2025-05-11T00:00:00.000Z");
        db.insert(registrySettings)
          .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
          .run();

        let calls = 0;
        yield* retentionService.sweepExpiredGuestData(now, {}, () =>
          Effect.sync(() => {
            calls += 1;
          }),
        );

        // No gifts, no summary, nothing to tell them about.
        expect(calls).toBe(0);
      }),
    ),
  );

  it(
    "sweeps normally when the notifier dies",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId, familyId, guestId } = yield* makeWedding({
          eventDates: ["2025-05-10"],
        });
        const stamp = new Date("2025-05-11T00:00:00.000Z");
        db.insert(registrySettings)
          .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
          .run();
        db.insert(registryContributions)
          .values({
            id: `rct_${crypto.randomUUID()}`,
            weddingId,
            itemId: null,
            familyId,
            status: "succeeded",
            amountMinor: 4_000,
            currency: "AUD",
            stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .run();

        // The notifier's error channel is `never` by contract, so the only
        // shape a broken one can take is a defect. The sweep has already
        // committed its deletes by then and must not fail on the courtesy.
        const deleted = yield* retentionService.sweepExpiredGuestData(now, {}, () =>
          Effect.die(new Error("mail transport unreachable")),
        );

        expect(deleted).toBe(1);
        const guestsLeft = yield* dbQuery(() =>
          db.select().from(guests).where(eq(guests.id, guestId)).all(),
        );
        expect(guestsLeft.length).toBe(0);
        const row = yield* dbQuery(() =>
          db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).get(),
        );
        // The stored summary is the durable half and survives regardless.
        expect(row?.giftSummaryJson).not.toBeNull();
      }),
    ),
  );

  it(
    "writes nothing for a wedding that never had a gift",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { weddingId } = yield* makeWedding({ eventDates: ["2025-04-01"] });
        const stamp = new Date("2025-05-11T00:00:00.000Z");
        db.insert(registrySettings)
          .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
          .run();

        yield* retentionService.sweepExpiredGuestData(now);

        const row = yield* dbQuery(() =>
          db.select().from(registrySettings).where(eq(registrySettings.weddingId, weddingId)).get(),
        );
        // An empty summary is noise on a page; its absence says the same thing
        // more quietly.
        expect(row?.giftSummaryJson).toBeNull();
      }),
    ),
  );

  it("reads the final events once, in the cohort query, and still dates each notice by its own wedding", async () => {
    // Not `withDb`: counting statements needs the concrete bun:sqlite handle,
    // which the service `Db` type does not expose.
    const db = createDb(":memory:");
    seedDb(db);
    const now = new Date("2026-06-17T04:00:00.000Z");
    const stamp = new Date("2025-05-11T00:00:00.000Z");
    const seen: GiftSummaryNotice[] = [];

    const { statements, closedId, openEndedId } = await Effect.runPromise(
      Effect.gen(function* () {
        const closed = yield* makeWedding({ eventDates: ["2025-03-01", "2025-05-10"] });
        // The last event has no stated end, so its start is its effective end.
        const openEnded = yield* makeWedding({
          eventDates: ["2025-02-01", { date: "2025-04-20", openEnded: true }],
        });
        for (const { weddingId, familyId } of [closed, openEnded]) {
          db.insert(registrySettings)
            .values({ weddingId, published: true, createdAt: stamp, updatedAt: stamp })
            .run();
          db.insert(registryContributions)
            .values({
              id: `rct_${crypto.randomUUID()}`,
              weddingId,
              itemId: null,
              familyId,
              status: "succeeded",
              amountMinor: 5_000,
              currency: "AUD",
              stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
              createdAt: stamp,
              updatedAt: stamp,
            })
            .run();
        }

        // Installed after the seeding above, so only the sweep's statements
        // are recorded; the notifier runs no query of its own.
        const recorded = recordStatements(db);
        yield* retentionService.sweepExpiredGuestData(now, {}, (notices) =>
          Effect.sync(() => {
            seen.push(...notices);
          }),
        );
        return {
          statements: recorded,
          closedId: closed.weddingId,
          openEndedId: openEnded.weddingId,
        };
      }).pipe(Effect.provideService(DbService, db)),
    );

    // Any statement naming the table counts, a join as much as a FROM. The
    // sweep never writes to `events`, so every match is a read.
    const eventReads = statements.filter((s) => s.sql.includes('"events"'));
    expect(eventReads).toHaveLength(1);

    const finalEventOn = new Map(seen.map((n) => [n.weddingId, n.finalEventOn]));
    expect(finalEventOn.get(closedId)).toBe("2025-05-10");
    expect(finalEventOn.get(openEndedId)).toBe("2025-04-20");
  });

  it("stores no summary while the delete does not commit, and counts each gift once when it does", async () => {
    const db = freshDb();
    const sheets = createDeleteStub();
    // Inside the 30-day hold-back, so nothing is deleted without its record.
    const wedding = await runOn(db, makeGiftedWedding("2025-06-01", { withImport: true }));
    const writeFailed = await written("write_failed");
    const sweepErrors = await counterValue(CIRE_METRICS.guestDataSwept, { result: "error" });
    // The families delete is in the same batch as the summary, ahead of it.
    const fault = failStatements(db, (sql) => sql.startsWith('delete from "families"'));

    let failed = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        retentionService
          .sweepExpiredGuestData(SWEEP_AT, { sheets })
          .pipe(Effect.provideService(DbService, db)),
      );
      failed = Exit.isFailure(exit);
    });

    expect(fault.failed()).toBe(1);
    expect(failed).toBe(true);
    expect(logs).toContain("gift summaries not written");
    expect(await written("write_failed")).toBe(writeFailed + 1);
    expect(await counterValue(CIRE_METRICS.guestDataSwept, { result: "error" })).toBe(
      sweepErrors + 1,
    );
    // No summary, and the gift it would have counted is still there to count,
    // with its import rows and the sheets they name.
    expect(storedSummary(db, wedding.weddingId)).toBeNull();
    expect(contributionCount(db, wedding.weddingId)).toBe(1);
    expect(importsLeft(db, wedding.weddingId)).toBeGreaterThan(0);
    expect(wedding.sheetKeys.filter((key) => sheets.deleted.has(key))).toEqual([]);

    // The database recovers: the next run counts the same gift once, not twice.
    fault.restore();
    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT, { sheets }));
    const summary = JSON.parse(storedSummary(db, wedding.weddingId) ?? "{}");
    expect(summary.contributions).toEqual({
      count: 1,
      totals: [{ currency: "AUD", amountMinor: 5_000 }],
    });
    expect(contributionCount(db, wedding.weddingId)).toBe(0);
    expect(importsLeft(db, wedding.weddingId)).toBe(0);
    expect(wedding.sheetKeys.every((key) => sheets.deleted.has(key))).toBe(true);
  });

  it("holds back the whole cohort when its gifts cannot be read", async () => {
    const db = freshDb();
    // Both inside the 30-day hold-back: due on 2026-06-01 and 2026-06-05.
    const gifted = await runOn(db, makeGiftedWedding("2025-06-01"));
    const plain = await runOn(db, makeWedding({ eventDates: ["2025-06-05"] }));
    const before = await written("read_failed");
    const fault = failStatements(db, (sql) => sql.includes('from "registry_contributions"'));

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(fault.failed()).toBe(1);
    expect(logs).toContain("gift summaries not written");
    // One read covers the cohort, so a failed one cannot say which weddings had
    // gifts: none is deleted, the one that never had a gift included.
    expect(await written("read_failed")).toBe(before + 2);
    expect(guestCount(db, gifted.guestId)).toBe(1);
    expect(guestCount(db, plain.guestId)).toBe(1);
  });

  it("keeps the summary and deletes on time when the owners cannot be read", async () => {
    const db = freshDb();
    const wedding = await runOn(db, makeGiftedWedding("2025-05-10"));
    const before = await unmailed("owners_unread");
    const fault = failStatements(db, (sql) => sql.includes('join "wedding_hosts"'));
    const seen: GiftSummaryNotice[] = [];

    const logs = await captureLogs(() =>
      runOn(
        db,
        retentionService.sweepExpiredGuestData(SWEEP_AT, {}, (notices) =>
          Effect.sync(() => {
            seen.push(...notices);
          }),
        ),
      ),
    );

    expect(fault.failed()).toBe(1);
    // The summary is stored, so the line must not say it was lost.
    expect(logs).toContain("owners not read");
    expect(logs).not.toContain("gift summaries not written");
    expect(await unmailed("owners_unread")).toBe(before + 1);
    expect(seen).toEqual([]);
    expect(storedSummary(db, wedding.weddingId)).not.toBeNull();
    expect(guestCount(db, wedding.guestId)).toBe(0);
  });

  it("adds a returning wedding's new gifts to the summary it already holds", async () => {
    const db = freshDb();
    const wedding = await runOn(db, makeGiftedWedding("2025-05-10", { amountMinor: 12_500 }));
    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    // A household that arrives after the sweep — a re-import, or the host's
    // own preview household — brings the wedding back into the cohort, and
    // gives again.
    const later = new Date("2026-06-18T00:00:00.000Z");
    const familyId = crypto.randomUUID();
    db.insert(families)
      .values({
        id: familyId,
        weddingId: wedding.weddingId,
        publicId: `PUB-late-${familyId}`,
        familyName: "Late",
        createdAt: later,
        updatedAt: later,
      })
      .run();
    await runOn(db, addGift(wedding.weddingId, familyId, { amountMinor: 5_000, at: later }));
    await runOn(
      db,
      addGift(wedding.weddingId, familyId, { amountMinor: 3_000, currency: "JPY", at: later }),
    );
    const itemId = `reg_${crypto.randomUUID()}`;
    db.insert(registryItems)
      .values({
        id: itemId,
        weddingId: wedding.weddingId,
        kind: "product",
        title: "Copper pan",
        quantityWanted: 2,
        sortOrder: 0,
        createdAt: later,
        updatedAt: later,
      })
      .run();
    db.insert(registryClaims)
      .values({
        id: `rcl_${crypto.randomUUID()}`,
        weddingId: wedding.weddingId,
        itemId,
        familyId,
        quantity: 1,
        status: "reserved",
        createdAt: later,
        updatedAt: later,
      })
      .run();
    const seen: GiftSummaryNotice[] = [];

    await runOn(
      db,
      retentionService.sweepExpiredGuestData(new Date("2026-06-20T04:00:00.000Z"), {}, (notices) =>
        Effect.sync(() => {
          seen.push(...notices);
        }),
      ),
    );

    // The record is everything ever swept, not only the latest rows.
    const summary = JSON.parse(storedSummary(db, wedding.weddingId) ?? "{}");
    expect(summary).toEqual({
      sweptOn: "2026-06-20",
      firstGiftOn: "2025-05-11",
      lastGiftOn: "2026-06-18",
      claims: { reserved: 1, purchased: 0 },
      contributions: {
        count: 3,
        totals: [
          { currency: "AUD", amountMinor: 17_500 },
          { currency: "JPY", amountMinor: 3_000 },
        ],
      },
    });
    expect(seen[0]?.summary).toEqual(summary);
  });

  it("keeps a returning wedding's summary as it is, and mails nothing, when it brings no new gift", async () => {
    const db = freshDb();
    const wedding = await runOn(db, makeGiftedWedding("2025-05-10"));
    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));
    const first = storedSummary(db, wedding.weddingId);
    expect(first).not.toBeNull();

    const later = new Date("2026-06-18T00:00:00.000Z");
    const familyId = crypto.randomUUID();
    db.insert(families)
      .values({
        id: familyId,
        weddingId: wedding.weddingId,
        publicId: `PUB-quiet-${familyId}`,
        familyName: "Quiet",
        createdAt: later,
        updatedAt: later,
      })
      .run();
    const seen: GiftSummaryNotice[] = [];

    await runOn(
      db,
      retentionService.sweepExpiredGuestData(new Date("2026-06-20T04:00:00.000Z"), {}, (notices) =>
        Effect.sync(() => {
          seen.push(...notices);
        }),
      ),
    );

    // The household is swept; the record and the couple's inbox are left alone.
    expect(db.select().from(families).where(eq(families.id, familyId)).all()).toHaveLength(0);
    expect(storedSummary(db, wedding.weddingId)).toBe(first);
    expect(seen).toEqual([]);
  });

  it("deletes on time, but stores and mails nothing, for a gift with no registry row to land on", async () => {
    const db = freshDb();
    const wedding = await runOn(db, makeWedding({ eventDates: ["2025-05-10"] }));
    await runOn(db, addGift(wedding.weddingId, wedding.familyId));
    const okBefore = await written("ok");
    const seen: GiftSummaryNotice[] = [];

    const logs = await captureLogs(() =>
      runOn(
        db,
        retentionService.sweepExpiredGuestData(SWEEP_AT, {}, (notices) =>
          Effect.sync(() => {
            seen.push(...notices);
          }),
        ),
      ),
    );

    // Holding it back would wait for a row nothing creates.
    expect(guestCount(db, wedding.guestId)).toBe(0);
    expect(logs).toContain("no registry row to land on");
    expect(seen).toEqual([]);
    expect(await written("ok")).toBe(okBefore);
  });
});

describe("the gift summary hold-back ceiling", () => {
  it("is 30 days", () => {
    expect(GIFT_SUMMARY_HOLD_BACK_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("deletes a wedding more than 30 days past due without its record, and holds back one on the 30th day", async () => {
    // Swept on 2026-06-17: the retention date of a wedding whose last event
    // was 2025-05-18 is 2026-05-18, 30 days back — still held. One a day
    // older is past the ceiling.
    const db = freshDb();
    const onCeiling = await runOn(db, makeGiftedWedding("2025-05-18"));
    const pastCeiling = await runOn(db, makeGiftedWedding("2025-05-17"));
    const before = await written("abandoned");
    failStatements(db, (sql) => sql.includes('from "registry_contributions"'));

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(guestCount(db, onCeiling.guestId)).toBe(1);
    expect(guestCount(db, pastCeiling.guestId)).toBe(0);
    expect(storedSummary(db, pastCeiling.weddingId)).toBeNull();
    expect(logs).toContain("deleted past the 30-day hold-back");
    // The count only: no wedding id reaches the line.
    expect(logs).not.toContain(pastCeiling.weddingId);
    expect(await written("abandoned")).toBe(before + 1);
  });

  it("deletes a wedding past the ceiling without its summary when the batch with the summary fails", async () => {
    const db = freshDb();
    const wedding = await runOn(db, makeGiftedWedding("2025-05-01"));
    const abandoned = await written("abandoned");
    const writeFailed = await written("write_failed");
    let updates = 0;
    // Only the first batch writes a summary; the retry without it must commit.
    failStatements(db, (sql) => sql.startsWith('update "registry_settings"') && ++updates === 1);

    let ok = false;
    const logs = await captureLogs(async () => {
      const exit = await Effect.runPromiseExit(
        retentionService.sweepExpiredGuestData(SWEEP_AT).pipe(Effect.provideService(DbService, db)),
      );
      ok = Exit.isSuccess(exit);
    });

    expect(ok).toBe(true);
    expect(logs).toContain("gift summaries not written — held back from the delete");
    expect(logs).toContain("deleted past the 30-day hold-back");
    expect(await written("write_failed")).toBe(writeFailed + 1);
    expect(await written("abandoned")).toBe(abandoned + 1);
    expect(storedSummary(db, wedding.weddingId)).toBeNull();
    expect(guestCount(db, wedding.guestId)).toBe(0);
    expect(contributionCount(db, wedding.weddingId)).toBe(0);
  });
});

describe("the retention cohort", () => {
  it("sweeps a wedding whose only guest data left is an import", async () => {
    const db = freshDb();
    const sheets = createDeleteStub();
    const wedding = await runOn(db, makeWedding({ eventDates: ["2025-04-01"], withImport: true }));
    // No household left, but its uploaded sheets still carry guest data.
    db.delete(guests).where(eq(guests.familyId, wedding.familyId)).run();
    db.delete(families).where(eq(families.id, wedding.familyId)).run();

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT, { sheets }));

    expect(importsLeft(db, wedding.weddingId)).toBe(0);
    expect(wedding.sheetKeys.every((key) => sheets.deleted.has(key))).toBe(true);
  });
});
