import { describe, it, expect } from "bun:test";

import {
  weddings,
  emailSuppressions,
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
  seatingAssignments,
  seatingPlans,
  seatingTables,
  weddingHosts,
} from "@cire/db";
import { eq, sql as rawSql } from "drizzle-orm";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { DbService, dbQuery } from "../../src/db";
import { createDb, seedDb, type TestDb } from "../../src/db/setup";
import {
  CIRE_METRICS,
  type GiftSummaryUnmailedReason,
  type GiftSummaryWrittenResult,
} from "../../src/metrics";
import type { DeletableBucket } from "../../src/services/r2-cleanup";
import {
  CREATION_BOUND_WARNING_MS,
  creationBoundAt,
  creationCutoffSeconds,
  type GiftSummary,
  type GiftSummaryNotice,
  GIFT_SUMMARY_MAX_LISTED,
  GIFT_SUMMARY_STORE_CHUNK_CHARS,
  MAX_LISTED_GIFTS_PER_SWEEP,
  MAX_WEDDINGS_PER_SWEEP,
  packGiftSummaries,
  retentionService,
  RETENTION_AFTER_FINAL_EVENT_MS,
  GIFT_SUMMARY_HOLD_BACK_MS,
} from "../../src/services/retention";
import { weddingsService } from "../../src/services/weddings";
import { TestDbLayer } from "../db/test-layer";
import { effWith, failStatements, recordStatements } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

const withDb = effWith(TestDbLayer);

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

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

/** An event's Start and End, stored exactly as given. */
interface StoredTimes {
  startAt: string;
  endAt: string;
}

/**
 * A wedding with one household and one guest, whose events hold `times` as
 * given — including values neither write door accepts, which a stored row or a
 * revert can still hold. {@link makeWedding} stores dated events only.
 */
function makeWeddingWithTimes(
  db: TestDb,
  times: readonly StoredTimes[],
  /** When the wedding was created; now by default. */
  createdAt: Date = new Date(),
): { weddingId: string; familyId: string; guestId: string } {
  const now = new Date();
  const weddingId = `wed_${crypto.randomUUID()}`;
  const familyId = crypto.randomUUID();
  const guestId = crypto.randomUUID();
  insertWedding(db, {
    id: weddingId,
    slug: `slug-${weddingId}`,
    displayName: "Test Wedding",
    createdAt,
    updatedAt: createdAt,
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
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  times.forEach(({ startAt, endAt }, i) => {
    db.insert(events)
      .values({
        id: `${weddingId}-ev-${i}`,
        weddingId,
        slug: `${weddingId}-ev-${i}`,
        name: `Event ${i}`,
        startAt,
        endAt,
        timezone: "Australia/Sydney",
      })
      .run();
  });
  return { weddingId, familyId, guestId };
}

/** Each captured line saying the sweep kept weddings it cannot date. */
const undatedLines = (logs: string): string[] =>
  logs.split("\n").filter((line) => line.includes("kept weddings it cannot date"));

/** Each captured line saying the sweep deleted weddings it cannot date, by their creation. */
const createdBoundLines = (logs: string): string[] =>
  logs.split("\n").filter((line) => line.includes("three years after they were created"));

/** Each captured line saying the sweep deleted weddings with no events, by their creation. */
const noEventLines = (logs: string): string[] =>
  logs.split("\n").filter((line) => line.includes("deleted weddings that have no events"));

const guestCount = (db: TestDb, guestId: string): number =>
  db.select().from(guests).where(eq(guests.id, guestId)).all().length;

const familyCount = (db: TestDb, weddingId: string): number =>
  db.select().from(families).where(eq(families.weddingId, weddingId)).all().length;

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

/** Each captured line saying the notices were not delivered, annotations and all. */
const undelivered = (logs: string): string[] =>
  logs.split("\n").filter((line) => line.includes("gift summary notices not delivered"));

const SWEEP_AT = new Date("2026-06-17T04:00:00.000Z");

describe("RETENTION_AFTER_FINAL_EVENT_MS", () => {
  it("is exactly 365 days in milliseconds", () => {
    expect(RETENTION_AFTER_FINAL_EVENT_MS).toBe(YEAR_MS);
  });
});

describe("retentionService.sweepExpiredGuestData", () => {
  // The sweep deletes guest data itself rather than leaning on the cascade, so
  // a database with foreign keys off still loses every seat — a seat says who
  // sat beside whom. The tables are the wedding's shell, like its events, and
  // stay.
  it("deletes the swept households' seats without the cascade, and keeps the tables", async () => {
    const db = freshDb();
    const { weddingId, guestId } = await runOn(
      db,
      makeWedding({ eventDates: ["2025-04-01", "2025-05-10"] }),
    );
    const now = new Date();
    /** A selected plan at the event, one table, and the guest seated there. */
    const seatOne = (wedding: string, eventId: string, guest: string, key: string) => {
      db.insert(seatingPlans)
        .values({
          id: `spl_${key}`,
          weddingId: wedding,
          eventId,
          name: "Plan 1",
          selected: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(seatingTables)
        .values({
          id: `stb_${key}`,
          weddingId: wedding,
          eventId,
          planId: `spl_${key}`,
          name: "Table 1",
          capacity: 8,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(seatingAssignments)
        .values({
          tableId: `stb_${key}`,
          planId: `spl_${key}`,
          eventId,
          guestId: guest,
          createdAt: now,
        })
        .run();
    };
    seatOne(weddingId, `${weddingId}-ev-0`, guestId, "kept");
    // A wedding whose events are still ahead keeps its seats.
    const live = await runOn(db, makeWedding({ eventDates: ["2027-01-10"] }));
    seatOne(live.weddingId, `${live.weddingId}-ev-0`, live.guestId, "live");
    db.$client.exec("PRAGMA foreign_keys = OFF;");

    // Exactly one guest: the guests delete is still found among the batch's
    // results with a seat delete ahead of it.
    expect(await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT))).toBe(1);
    expect(
      db.select({ tableId: seatingAssignments.tableId }).from(seatingAssignments).all(),
    ).toEqual([{ tableId: "stb_live" }]);
    expect(
      db
        .select({ id: seatingTables.id })
        .from(seatingTables)
        .all()
        .map((t) => t.id)
        .toSorted(),
    ).toEqual(["stb_kept", "stb_live"]);
    // The plans stay with the tables, as part of the wedding's shell.
    expect(
      db
        .select({ id: seatingPlans.id })
        .from(seatingPlans)
        .all()
        .map((p) => p.id)
        .toSorted(),
    ).toEqual(["spl_kept", "spl_live"]);
  });

  // A suppression row hangs off the wedding, not a household, so a wedding
  // whose households are all gone still holds one. Both must go at the year;
  // a wedding still ahead keeps its own.
  it("deletes an expired wedding's email suppressions, households or not, and keeps a live wedding's", async () => {
    const db = freshDb();
    const now = new Date();
    const suppress = (weddingId: string, guestId: string | null) =>
      db
        .insert(emailSuppressions)
        .values({
          id: crypto.randomUUID(),
          weddingId,
          emailHash: `hash-${weddingId}`,
          guestId,
          reason: "guest_removed",
          createdAt: now,
        })
        .run();
    const withHousehold = await runOn(db, makeWedding({ eventDates: ["2025-04-01"] }));
    suppress(withHousehold.weddingId, withHousehold.guestId);
    const emptied = await runOn(db, makeWedding({ eventDates: ["2025-04-01"] }));
    suppress(emptied.weddingId, null);
    db.delete(families).where(eq(families.id, emptied.familyId)).run();
    const live = await runOn(db, makeWedding({ eventDates: ["2027-01-10"] }));
    suppress(live.weddingId, live.guestId);

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    expect(
      db
        .select({ weddingId: emailSuppressions.weddingId })
        .from(emailSuppressions)
        .all()
        .map((r) => r.weddingId),
    ).toEqual([live.weddingId]);
  });

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
    "sweeps a plus-one with their household",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date("2026-06-17T04:00:00.000Z");
        const { familyId, guestId } = yield* makeWedding({ eventDates: ["2025-04-01"] });
        // A plus-one inserted AFTER their inviter, so the guests delete meets
        // the inviter first and the foreign key's cascade takes the plus-one.
        // The count of rows the cascade reports differs by driver (bun:sqlite
        // reports 1 on Bun 1.4.4, D1 reports 2), so the exact count is asserted
        // on the real D1 tier in d1-integration.test.ts.
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

        yield* retentionService.sweepExpiredGuestData(now);
        const left = yield* dbQuery(() =>
          db.select().from(guests).where(eq(guests.familyId, familyId)).all(),
        );
        expect(left).toEqual([]);
      }),
    ),
  );

  it("takes the longest-overdue weddings first when the cohort is over the per-run cap, and the rest on the next run, then a wedding due by its creation, ahead of a wedding it cannot date, which it still counts", async () => {
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
    // No event of this wedding can be dated, so it has no final event to sort
    // by. It must not take a due wedding's place under the cap, and the count
    // must still include it while the due weddings fill every place.
    makeWeddingWithTimes(db, [{ startAt: "TBD by the couple", endAt: "" }]);
    // No event of this one can be dated either, but it was created more than
    // three years before the run, so it is due — after every wedding the year
    // rule makes due.
    const byCreation = makeWeddingWithTimes(
      db,
      [{ startAt: "TBD by the couple", endAt: "" }],
      new Date("2022-01-01T00:00:00.000Z"),
    );

    let firstRun: number | undefined;
    const logs = await captureLogs(async () => {
      firstRun = await runOn(db, retentionService.sweepExpiredGuestData(now));
    });
    expect(firstRun).toBe(MAX_WEDDINGS_PER_SWEEP);
    expect(undatedLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    // Every wedding this run deleted was due by the year rule.
    expect(createdBoundLines(logs)).toEqual([]);
    // The one wedding the cap left behind is the most recent, not an
    // arbitrary one.
    expect({
      newest: guestCount(db, newest.guestId),
      oldest: guestCount(db, oldest.guestId),
      byCreation: guestCount(db, byCreation.guestId),
    }).toEqual({ newest: 1, oldest: 0, byCreation: 1 });

    // The swept weddings keep their events, but hold nothing left to delete,
    // so they no longer fill the cohort: the next run reaches the newest.
    expect(await runOn(db, retentionService.sweepExpiredGuestData(now))).toBe(2);
    expect(guestCount(db, newest.guestId)).toBe(0);
    expect(guestCount(db, byCreation.guestId)).toBe(0);
  });

  // A wedding with no events is due by its creation too, and takes its place
  // in the same order as one with an event the sweep cannot read.
  const TBD_EVENT: readonly StoredTimes[] = [{ startAt: "TBD by the couple", endAt: "" }];
  it.each([
    {
      olderHas: "an event it cannot date",
      newerHas: "one too",
      older: TBD_EVENT,
      newer: TBD_EVENT,
    },
    { olderHas: "no events", newerHas: "an event it cannot date", older: [], newer: TBD_EVENT },
    { olderHas: "an event it cannot date", newerHas: "no events", older: TBD_EVENT, newer: [] },
  ])(
    "takes the weddings due by their creation oldest first, after the weddings the year rule makes due, when the cap leaves room for one: the older with $olderHas, the newer with $newerHas",
    async ({ older: olderTimes, newer: newerTimes }) => {
      const db = freshDb();
      const now = new Date("2026-06-17T04:00:00.000Z");
      const day = 24 * 60 * 60 * 1000;
      const start = Date.parse("2023-01-01T00:00:00.000Z");
      // One place fewer than the cap for the year rule's weddings, so a single
      // place is left for the two weddings due by their creation.
      const dated = await runOn(
        db,
        Effect.gen(function* () {
          const out = [];
          for (let i = 0; i < MAX_WEDDINGS_PER_SWEEP - 1; i++) {
            const date = new Date(start + i * day).toISOString().slice(0, 10);
            out.push(yield* makeWedding({ eventDates: [date] }));
          }
          return out;
        }),
      );
      // The newer one is inserted first, so row order cannot stand in for the
      // ORDER BY.
      const newer = makeWeddingWithTimes(db, newerTimes, new Date("2022-01-01T00:00:00.000Z"));
      const older = makeWeddingWithTimes(db, olderTimes, new Date("2021-01-01T00:00:00.000Z"));

      expect(await runOn(db, retentionService.sweepExpiredGuestData(now))).toBe(
        MAX_WEDDINGS_PER_SWEEP,
      );

      expect(dated.filter((w) => guestCount(db, w.guestId) > 0)).toEqual([]);
      expect({
        older: guestCount(db, older.guestId),
        newer: guestCount(db, newer.guestId),
      }).toEqual({ older: 0, newer: 1 });
    },
  );

  it("counts and logs a sweep whose cohort read fails", async () => {
    const db = freshDb();
    await runOn(db, makeWedding({ eventDates: ["2025-04-01"] }));
    const before = await counterValue(CIRE_METRICS.guestDataSwept, { result: "error" });
    // A failed read surfaces as a defect, not a typed failure; it must still
    // be counted and logged here rather than only in the runtime's record.
    const fault = failStatements(db, (sql) => sql.includes('from "weddings" left join "events"'));

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

  // The sweep compares stored Starts and Ends as text against a `YYYY-MM-DD`
  // cutoff, which is exact only for a value that begins with its date. A
  // stored row can hold any text, and a revert can restore one. Each row below
  // seeds one wedding with a dated event
  // long past and one event the sweep cannot date, on a day with nothing else
  // due: the wedding is kept, counted in one warning line, and neither its id
  // nor the stored value reaches the log. The values are distinctive so the
  // log check cannot pass or fail on unrelated text.
  const PAST = { startAt: "2025-03-01T10:00:00+11:00", endAt: "2025-03-01T12:00:00+11:00" };
  it.each([
    {
      shape: "a Start that sorts after every date",
      odd: { startAt: "TBD by the couple", endAt: "" },
      stored: ["TBD by the couple"],
    },
    {
      shape: "a Start that sorts before every cutoff",
      odd: { startAt: "1st Nov 2026 at Wattle Grove", endAt: "" },
      stored: ["1st Nov 2026 at Wattle Grove"],
    },
    { shape: "a blank Start and End", odd: { startAt: "", endAt: "" }, stored: [] },
    {
      shape: "a dated Start and an End that sorts after every date",
      odd: { startAt: "2025-04-01T10:00:00+11:00", endAt: "late, after the speeches" },
      stored: ["late, after the speeches"],
    },
    {
      shape: "a dated Start and an End that sorts before every cutoff",
      odd: { startAt: "2025-04-01T10:00:00+11:00", endAt: "1st Nov 2026 at Wattle Grove" },
      stored: ["1st Nov 2026 at Wattle Grove"],
    },
    {
      shape: "a Start whose date follows a space",
      odd: { startAt: " 2025-04-01T10:00:00+11:00", endAt: "" },
      stored: [],
    },
  ])("keeps and counts a wedding with one event holding $shape", async ({ odd, stored }) => {
    const db = freshDb();
    const { weddingId, guestId } = makeWeddingWithTimes(db, [PAST, odd]);

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(guestCount(db, guestId)).toBe(1);
    expect(undatedLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    for (const secret of [weddingId, ...stored]) expect(logs).not.toContain(secret);
  });

  it("keeps and counts a young wedding it cannot date even when a readable event is still ahead", async () => {
    // The readable event does not decide when its guest data goes: the event
    // it cannot date puts it on the three years from its creation, so it is
    // kept for that, and counted with the rest.
    const db = freshDb();
    const { guestId } = makeWeddingWithTimes(db, [
      { startAt: "2027-01-10T10:00:00+11:00", endAt: "" },
      { startAt: "TBD by the couple", endAt: "" },
    ]);

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(guestCount(db, guestId)).toBe(1);
    expect(undatedLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
  });

  it("does not count a wedding it cannot date that holds no guest data", async () => {
    // Nothing is left to delete, so nothing is being kept.
    const db = freshDb();
    const { familyId } = makeWeddingWithTimes(db, [{ startAt: "TBD by the couple", endAt: "" }]);
    db.delete(families).where(eq(families.id, familyId)).run();

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(undatedLines(logs)).toEqual([]);
  });

  // A wedding with an event the sweep cannot date has no final event to count a
  // year from. Its guest data goes three years after the wedding was created
  // instead, whatever its readable dates say.
  it("deletes a wedding it cannot date three years after it was created, and keeps and counts younger ones", async () => {
    const db = freshDb();
    // Swept on 2026-06-17: three years and a day.
    const createdAt = new Date("2023-06-16T04:00:00.000Z");
    const old = makeWeddingWithTimes(db, [{ startAt: "TBD by the couple", endAt: "" }], createdAt);
    const youngAt = [
      // Two years and eleven months.
      new Date("2023-07-17T04:00:00.000Z"),
      // An hour short of three calendar years, though more than 1,095 days:
      // the years are calendar years, so the anniversary is never early.
      new Date("2023-06-17T05:00:00.000Z"),
      // Three calendar years to the second: kept until the next run.
      new Date("2023-06-17T04:00:00.000Z"),
    ];
    const young = youngAt.map((at) =>
      makeWeddingWithTimes(db, [{ startAt: "TBD by the couple", endAt: "" }], at),
    );
    // Due by the year rule in the same run, so the line below counts only the
    // weddings deleted by their creation, not every wedding the run deleted.
    const dated = await runOn(db, makeWedding({ eventDates: ["2025-03-01"] }));

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(guestCount(db, old.guestId)).toBe(0);
    expect(guestCount(db, dated.guestId)).toBe(0);
    expect(young.map((w) => guestCount(db, w.guestId))).toEqual([1, 1, 1]);
    // The kept count is the young ones alone; the deleted one has its own line.
    expect(undatedLines(logs)).toEqual([expect.stringContaining('"weddings":3')]);
    expect(createdBoundLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    // Every wedding here has an event, so none is counted as having none.
    expect(noEventLines(logs)).toEqual([]);
    // Counts only: no id, no stored value, no creation date in any form.
    for (const secret of [
      old.weddingId,
      ...young.map((w) => w.weddingId),
      "TBD by the couple",
      createdAt.toISOString().slice(0, 10),
      String(Math.floor(createdAt.getTime() / 1000)),
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  // The owner's rule: one event the sweep cannot date puts the whole wedding on
  // the three years from its creation, whatever its readable events say. A
  // wedding planned more than three years ahead can therefore lose its guest
  // data before its readable event, which the owner accepted.
  it.each([
    {
      shape: "a readable event a year and more past",
      readable: { startAt: "2025-03-01T10:00:00+11:00", endAt: "2025-03-01T12:00:00+11:00" },
    },
    {
      shape: "a readable event three months past",
      readable: { startAt: "2026-03-14T10:00:00+11:00", endAt: "2026-03-14T12:00:00+11:00" },
    },
    {
      shape: "a readable event still to come",
      readable: { startAt: "2027-01-10T10:00:00+11:00", endAt: "" },
    },
  ])(
    "deletes a wedding created four years before the run with an event it cannot date and $shape",
    async ({ readable }) => {
      const db = freshDb();
      const { guestId } = makeWeddingWithTimes(
        db,
        [readable, { startAt: "TBD by the couple", endAt: "" }],
        new Date(SWEEP_AT.getTime() - 4 * YEAR_MS),
      );

      const logs = await captureLogs(() =>
        runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
      );

      expect(guestCount(db, guestId)).toBe(0);
      expect(createdBoundLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    },
  );

  it("keeps a wedding created four years before the run whose dates all read, its final event two months past", async () => {
    // The three years from creation applies only to a wedding with an event the
    // sweep cannot date; this one is on the year rule alone.
    const db = freshDb();
    const { guestId } = makeWeddingWithTimes(
      db,
      [{ startAt: "2026-04-15T10:00:00+10:00", endAt: "2026-04-15T12:00:00+10:00" }],
      new Date(SWEEP_AT.getTime() - 4 * YEAR_MS),
    );

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(guestCount(db, guestId)).toBe(1);
    expect(undatedLines(logs)).toEqual([]);
    expect(createdBoundLines(logs)).toEqual([]);
  });

  // `created_at` holds epoch seconds. A value that does not read as seconds
  // says nothing about when the wedding was created, so it keeps the wedding.
  it.each([
    { shape: "milliseconds", stored: Date.parse("2022-01-01T00:00:00.000Z") },
    { shape: "text", stored: "2022-01-01" },
  ])(
    "keeps and counts a wedding it cannot date whose stored creation time is in $shape",
    async ({ stored }) => {
      const db = freshDb();
      const { weddingId, guestId } = makeWeddingWithTimes(db, [
        { startAt: "TBD by the couple", endAt: "" },
      ]);
      db.run(rawSql`update ${weddings} set created_at = ${stored} where id = ${weddingId}`);

      const logs = await captureLogs(() =>
        runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
      );

      expect(guestCount(db, guestId)).toBe(1);
      expect(undatedLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
      expect(createdBoundLines(logs)).toEqual([]);
    },
  );

  // A wedding with no events has no date to count a year from, so it is
  // treated as one the sweep cannot date: its guest data goes three calendar
  // years after it was created. A wedding being set up has no events either,
  // so a young one is kept, and is not counted: nothing about it is wrong.
  it("deletes a wedding with no events three years after it was created, and keeps younger ones", async () => {
    const db = freshDb();
    // Swept on 2026-06-17: three years and a day.
    const createdAt = new Date("2023-06-16T04:00:00.000Z");
    const old = makeWeddingWithTimes(db, [], createdAt);
    const young = [
      // Two years and eleven months.
      new Date("2023-07-17T04:00:00.000Z"),
      // An hour short of three calendar years, though more than 1,095 days.
      new Date("2023-06-17T05:00:00.000Z"),
      // Three calendar years to the second: kept until the next run.
      new Date("2023-06-17T04:00:00.000Z"),
    ].map((at) => makeWeddingWithTimes(db, [], at));
    // Due by its creation in the same run for an event the sweep cannot read,
    // so each line below counts only its own kind.
    const undatable = makeWeddingWithTimes(
      db,
      [{ startAt: "TBD by the couple", endAt: "" }],
      new Date("2023-01-15T00:00:00.000Z"),
    );

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(guestCount(db, old.guestId)).toBe(0);
    expect(familyCount(db, old.weddingId)).toBe(0);
    expect(guestCount(db, undatable.guestId)).toBe(0);
    expect(young.map((w) => guestCount(db, w.guestId))).toEqual([1, 1, 1]);
    // The wedding itself is kept, as for every swept wedding.
    expect(db.select().from(weddings).where(eq(weddings.id, old.weddingId)).all()).toHaveLength(1);
    expect(noEventLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    expect(createdBoundLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    // The young ones are not counted as kept.
    expect(undatedLines(logs)).toEqual([]);
    // Counts only: no id and no creation date in any form.
    for (const secret of [
      old.weddingId,
      ...young.map((w) => w.weddingId),
      createdAt.toISOString().slice(0, 10),
      String(Math.floor(createdAt.getTime() / 1000)),
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it.each([
    { shape: "an import", only: "import" as const },
    { shape: "an email opt-out", only: "suppression" as const },
  ])(
    "deletes $shape, the only guest data of a wedding with no events, three years after it was created",
    async ({ only }) => {
      const db = freshDb();
      const sheets = createDeleteStub();
      const wedding = makeWeddingWithTimes(db, [], new Date(SWEEP_AT.getTime() - 4 * YEAR_MS));
      db.delete(guests).where(eq(guests.familyId, wedding.familyId)).run();
      db.delete(families).where(eq(families.id, wedding.familyId)).run();
      const sheetKeys = [
        `imports/${wedding.weddingId}/events.csv`,
        `imports/${wedding.weddingId}/guests.csv`,
      ];
      if (only === "import") {
        db.insert(imports)
          .values({
            id: crypto.randomUUID(),
            weddingId: wedding.weddingId,
            uploadedAt: Date.now(),
            format: "csv",
            eventsR2Key: sheetKeys[0]!,
            guestsR2Key: sheetKeys[1]!,
            summary: "{}",
            status: "applied",
          })
          .run();
      } else {
        db.insert(emailSuppressions)
          .values({
            id: crypto.randomUUID(),
            weddingId: wedding.weddingId,
            emailHash: `hash-${wedding.weddingId}`,
            guestId: null,
            reason: "guest_removed",
            createdAt: new Date(),
          })
          .run();
      }

      const logs = await captureLogs(() =>
        runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT, { sheets })),
      );

      expect(importsLeft(db, wedding.weddingId)).toBe(0);
      expect(
        db
          .select()
          .from(emailSuppressions)
          .where(eq(emailSuppressions.weddingId, wedding.weddingId))
          .all(),
      ).toEqual([]);
      expect([...sheets.deleted].toSorted()).toEqual(only === "import" ? sheetKeys.toSorted() : []);
      expect(noEventLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    },
  );

  it("does not take a wedding with no events that holds no guest data", async () => {
    // Nothing is left to delete, so it is neither deleted nor kept.
    const db = freshDb();
    const { familyId } = makeWeddingWithTimes(db, [], new Date(SWEEP_AT.getTime() - 4 * YEAR_MS));
    db.delete(families).where(eq(families.id, familyId)).run();

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(noEventLines(logs)).toEqual([]);
    expect(undatedLines(logs)).toEqual([]);
  });

  it("keeps a young wedding with no events without counting it, beside a young wedding it cannot date", async () => {
    const db = freshDb();
    const created = new Date("2025-01-01T00:00:00.000Z");
    const noEvents = makeWeddingWithTimes(db, [], created);
    const undatable = makeWeddingWithTimes(
      db,
      [{ startAt: "TBD by the couple", endAt: "" }],
      created,
    );

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    expect(guestCount(db, noEvents.guestId)).toBe(1);
    expect(guestCount(db, undatable.guestId)).toBe(1);
    // The one it cannot date, and not the one with no events.
    expect(undatedLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
    expect(noEventLines(logs)).toEqual([]);
  });

  // With no events, the creation time is all the sweep has. One it cannot read
  // keeps the wedding, and the wedding is counted, so the keep is seen.
  it.each([
    { shape: "milliseconds", stored: Date.parse("2022-01-01T00:00:00.000Z") },
    { shape: "text", stored: "2022-01-01" },
  ])(
    "keeps and counts a wedding with no events whose stored creation time is in $shape",
    async ({ stored }) => {
      const db = freshDb();
      const { weddingId, guestId } = makeWeddingWithTimes(db, []);
      db.run(rawSql`update ${weddings} set created_at = ${stored} where id = ${weddingId}`);

      const logs = await captureLogs(() =>
        runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
      );

      expect(guestCount(db, guestId)).toBe(1);
      expect(undatedLines(logs)).toEqual([expect.stringContaining('"weddings":1')]);
      expect(noEventLines(logs)).toEqual([]);
    },
  );

  // A wedding more than three years old whose events are all removed has no
  // events from then on: the next run deletes its guest data, whatever its
  // removed events said.
  it("deletes the guest data of a wedding more than three years old at the first run after its last event is removed", async () => {
    const db = freshDb();
    const wedding = makeWeddingWithTimes(
      db,
      [{ startAt: "2026-03-14T10:00:00+11:00", endAt: "2026-03-14T12:00:00+11:00" }],
      new Date(SWEEP_AT.getTime() - 4 * YEAR_MS),
    );

    // Its event is three months past, so the year rule keeps it.
    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));
    expect(guestCount(db, wedding.guestId)).toBe(1);

    db.delete(events).where(eq(events.weddingId, wedding.weddingId)).run();
    await runOn(db, retentionService.sweepExpiredGuestData(new Date(SWEEP_AT.getTime() + DAY_MS)));

    expect(guestCount(db, wedding.guestId)).toBe(0);
    expect(familyCount(db, wedding.weddingId)).toBe(0);
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
          contributions: GiftSummary["contributions"];
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
          { currency: "AUD", amountMinor: 17_500, count: 2 },
          { currency: "JPY", amountMinor: 3_000, count: 1 },
        ]);
        // Each money gift, as given and on its day — and the unsettled one is
        // not among them. Two arrived on the same day, so compared as a set.
        expect(summary.contributions.gifts).toHaveLength(3);
        for (const listed of [
          { on: "2025-05-11", amountMinor: 12_500, currency: "AUD" },
          { on: "2025-05-11", amountMinor: 5_000, currency: "AUD" },
          { on: "2025-05-20", amountMinor: 3_000, currency: "JPY" },
        ]) {
          expect(summary.contributions.gifts).toContainEqual(listed);
        }
        expect(summary.contributions.gifts.at(-1)?.on).toBe("2025-05-20");
        // NO NAMES. Who gave and what they wrote are what the sweep deletes,
        // and the summary must not be that deletion undone in the row next door.
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

  it("totals gifts stored as aud and AUD on one summary line", async () => {
    const db = freshDb();
    const { weddingId, familyId } = await runOn(db, makeWedding({ eventDates: ["2025-05-10"] }));
    db.insert(registrySettings)
      .values({ weddingId, published: true, createdAt: GIFT_STAMP, updatedAt: GIFT_STAMP })
      .run();
    await runOn(db, addGift(weddingId, familyId, { currency: "aud", amountMinor: 2_000 }));
    await runOn(db, addGift(weddingId, familyId, { currency: "AUD", amountMinor: 3_000 }));

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    const summary = JSON.parse(storedSummary(db, weddingId) ?? "{}") as GiftSummary;
    expect(summary.contributions.totals).toEqual([
      { currency: "AUD", amountMinor: 5_000, count: 2 },
    ]);
    // The listed gifts carry the same code as the total they add to.
    expect(summary.contributions.gifts.map((gift) => gift.currency)).toEqual(["AUD", "AUD"]);
  });

  it("dates a wedding with only claims, or only money gifts, by the gifts it had", async () => {
    // The two kinds are counted by separate reads, each with its own min and
    // max. A wedding with one kind only must take its range from that read
    // alone; in the mixed wedding above, the claims fall on the first gift's
    // day, so dropping their dates from the range would go unseen there.
    const db = freshDb();
    const claimsOnly = await runOn(db, makeWedding({ eventDates: ["2025-05-10"] }));
    const giftsOnly = await runOn(db, makeWedding({ eventDates: ["2025-05-10"] }));
    for (const { weddingId } of [claimsOnly, giftsOnly]) {
      db.insert(registrySettings)
        .values({ weddingId, published: true, createdAt: GIFT_STAMP, updatedAt: GIFT_STAMP })
        .run();
    }
    // The claims read groups by status, so the two reserved claims are what
    // tell its own min from its max.
    for (const [index, [status, on]] of (
      [
        ["reserved", "2025-04-15"],
        ["purchased", "2025-03-20"],
        ["reserved", "2025-03-02"],
      ] as const
    ).entries()) {
      const at = new Date(`${on}T09:00:00.000Z`);
      const itemId = `reg_${index}_${crypto.randomUUID()}`;
      db.insert(registryItems)
        .values({
          id: itemId,
          weddingId: claimsOnly.weddingId,
          kind: "product",
          title: `Gift ${index}`,
          quantityWanted: 1,
          sortOrder: index,
          createdAt: at,
          updatedAt: at,
        })
        .run();
      db.insert(registryClaims)
        .values({
          id: `rcl_${crypto.randomUUID()}`,
          weddingId: claimsOnly.weddingId,
          itemId,
          familyId: claimsOnly.familyId,
          quantity: 1,
          status,
          createdAt: at,
          updatedAt: at,
        })
        .run();
    }
    // The money read groups by currency, in code order, so the AUD group with
    // the latest gift is read before the JPY one: the range must be the widest
    // of the groups, not the last one read.
    for (const [currency, on] of [
      ["AUD", "2025-05-20"],
      ["AUD", "2025-02-10"],
      ["JPY", "2025-03-15"],
    ] as const) {
      await runOn(
        db,
        addGift(giftsOnly.weddingId, giftsOnly.familyId, {
          currency,
          at: new Date(`${on}T09:00:00.000Z`),
        }),
      );
    }

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    const range = (weddingId: string) => {
      const summary = JSON.parse(storedSummary(db, weddingId) ?? "{}") as GiftSummary;
      return [summary.firstGiftOn, summary.lastGiftOn];
    };
    expect(range(claimsOnly.weddingId)).toEqual(["2025-03-02", "2025-04-15"]);
    expect(range(giftsOnly.weddingId)).toEqual(["2025-02-10", "2025-05-20"]);
  });

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
        expect(notice?.retainedFrom).toEqual({ rule: "final-event", on: "2025-05-10" });
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
        let deleted: number | undefined;
        const logs = yield* Effect.promise(() =>
          captureLogs(async () => {
            deleted = await Effect.runPromise(
              retentionService
                .sweepExpiredGuestData(now, {}, () =>
                  Effect.die(new Error("mail transport unreachable")),
                )
                .pipe(Effect.provideService(DbService, db)),
            );
          }),
        );

        expect(deleted).toBe(1);
        // Told apart from a hang, so a notifier that breaks every run is not
        // read as a mail host that is down.
        expect(undelivered(logs)).toEqual([expect.stringContaining('"reason":"defect"')]);
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

  it("stops waiting on a notifier that hangs after 30 seconds, and returns what it deleted", async () => {
    // A hang, not a failure, is what would stop the sweep: the notifier's error
    // channel is `never`. On the test clock the 30 seconds pass at once.
    const db = freshDb();
    const wedding = await runOn(db, makeGiftedWedding("2025-05-10"));

    let deleted: number | undefined;
    const logs = await captureLogs(async () => {
      deleted = await Effect.runPromise(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>();
          const sweep = yield* Effect.forkChild(
            retentionService.sweepExpiredGuestData(SWEEP_AT, {}, () =>
              Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          );
          yield* Deferred.await(reached);
          // Let the timeout's timer reach the test clock before moving it.
          yield* TestClock.withLive(Effect.sleep("20 millis"));

          yield* TestClock.adjust("29 seconds");
          expect(sweep.pollUnsafe()).toBeUndefined();

          yield* TestClock.adjust("1 second");
          // Polled rather than joined: without the bound the sweep never ends,
          // and a join would wait for it.
          const exit = sweep.pollUnsafe();
          expect(exit).toBeDefined();
          return yield* Fiber.join(sweep);
        }).pipe(Effect.provide(TestClock.layer()), Effect.provideService(DbService, db)),
      );
    });

    expect(deleted).toBe(1);
    expect(guestCount(db, wedding.guestId)).toBe(0);
    expect(storedSummary(db, wedding.weddingId)).not.toBeNull();
    expect(undelivered(logs)).toEqual([expect.stringContaining('"reason":"timeout"')]);
  });

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

    const { statements, closedId, openEndedId, undatableId, noEventsId } = await Effect.runPromise(
      Effect.gen(function* () {
        const closed = yield* makeWedding({ eventDates: ["2025-03-01", "2025-05-10"] });
        // The last event has no stated end, so its start is its effective end.
        const openEnded = yield* makeWedding({
          eventDates: ["2025-02-01", { date: "2025-04-20", openEnded: true }],
        });
        // No event it can date, created more than three years before the run:
        // due by its creation, in the same read and the same statements.
        const undatable = makeWeddingWithTimes(
          db,
          [{ startAt: "TBD by the couple", endAt: "" }],
          new Date("2023-01-15T00:00:00.000Z"),
        );
        // No events at all, created more than three years before the run:
        // due by its creation as well, in the same read and statements.
        const noEvents = makeWeddingWithTimes(db, [], new Date("2023-02-20T00:00:00.000Z"));
        for (const { weddingId, familyId } of [closed, openEnded, undatable, noEvents]) {
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
          undatableId: undatable.weddingId,
          noEventsId: noEvents.weddingId,
        };
      }).pipe(Effect.provideService(DbService, db)),
    );

    // Every statement the sweep runs, counted on the code before the bound by
    // creation: both bounds by creation ride on the same read and the same
    // batched writes, so the daily cron's query budget does not move.
    expect(statements).toHaveLength(16);
    // Any read naming the table counts, a join as much as a FROM. The seat
    // delete names `events` too — it reaches the seats through their events —
    // but as the scope of a write, so it is counted on its own.
    const eventReads = statements.filter(
      (s) => s.sql.startsWith("select") && s.sql.includes('"events"'),
    );
    expect(eventReads).toHaveLength(1);
    const writesNamingEvents = statements.filter(
      (s) => !s.sql.startsWith("select") && s.sql.includes('"events"'),
    );
    expect(writesNamingEvents.map((s) => s.sql.slice(0, 40))).toEqual([
      'delete from "seating_assignments" where ',
    ]);

    const retainedFrom = new Map(seen.map((n) => [n.weddingId, n.retainedFrom]));
    expect(retainedFrom.get(closedId)).toEqual({ rule: "final-event", on: "2025-05-10" });
    expect(retainedFrom.get(openEndedId)).toEqual({ rule: "final-event", on: "2025-04-20" });
    expect(retainedFrom.get(undatableId)).toEqual({ rule: "created", on: "2023-01-15" });
    expect(retainedFrom.get(noEventsId)).toEqual({ rule: "created", on: "2023-02-20" });
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
      totals: [{ currency: "AUD", amountMinor: 5_000, count: 1 }],
      gifts: [{ on: "2025-05-11", amountMinor: 5_000, currency: "AUD" }],
    });
    expect(contributionCount(db, wedding.weddingId)).toBe(0);
    expect(importsLeft(db, wedding.weddingId)).toBe(0);
    expect(wedding.sheetKeys.every((key) => sheets.deleted.has(key))).toBe(true);
  });

  it("holds back the whole cohort when its gifts cannot be read", async () => {
    const db = freshDb();
    // Both inside the 30-day hold-back: due on 2026-06-01 and 2026-06-05.
    const gifted = await runOn(db, makeGiftedWedding("2025-06-01", { withImport: true }));
    const plain = await runOn(db, makeWedding({ eventDates: ["2025-06-05"] }));
    const before = await written("read_failed");
    const fault = failStatements(db, (sql) => sql.includes('from "registry_contributions"'));
    const sheets = createDeleteStub();

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT, { sheets })),
    );

    expect(fault.failed()).toBe(1);
    expect(logs).toContain("gift summaries not written");
    // One read covers the cohort, so a failed one cannot say which weddings had
    // gifts: none is deleted, the one that never had a gift included.
    expect(await written("read_failed")).toBe(before + 2);
    expect(guestCount(db, gifted.guestId)).toBe(1);
    expect(guestCount(db, plain.guestId)).toBe(1);
    // Nothing was deleted, so no sheet is reaped either.
    expect(sheets.deleted.size).toBe(0);
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
      addGift(wedding.weddingId, familyId, {
        amountMinor: 3_000,
        currency: "JPY",
        at: new Date("2026-06-18T01:00:00.000Z"),
      }),
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
          { currency: "AUD", amountMinor: 17_500, count: 2 },
          { currency: "JPY", amountMinor: 3_000, count: 1 },
        ],
        // The earlier sweep's gift first, then the new ones, oldest first.
        gifts: [
          { on: "2025-05-11", amountMinor: 12_500, currency: "AUD" },
          { on: "2026-06-18", amountMinor: 5_000, currency: "AUD" },
          { on: "2026-06-18", amountMinor: 3_000, currency: "JPY" },
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

describe("each money gift, listed in the kept summary", () => {
  /** `n` settled gifts on `weddingId`, one a minute from `start`, in chunks. */
  function addGifts(db: TestDb, weddingId: string, familyId: string, n: number, start: Date) {
    const rows = Array.from({ length: n }, (_, i) => {
      const at = new Date(start.getTime() + i * 60_000);
      return {
        id: `rct_${crypto.randomUUID()}`,
        weddingId,
        itemId: null,
        familyId,
        status: "succeeded" as const,
        amountMinor: 1_000 + i,
        currency: "AUD",
        stripeCheckoutSessionId: `cs_${crypto.randomUUID()}`,
        createdAt: at,
        updatedAt: at,
      };
    });
    // bun:sqlite binds at most 999 parameters a statement; 50 rows is 500.
    for (let i = 0; i < rows.length; i += 50) {
      db.insert(registryContributions)
        .values(rows.slice(i, i + 50))
        .run();
    }
  }

  /** A wedding with a published registry and `n` gifts, its last event on `eventDate`. */
  async function weddingWithGifts(db: TestDb, eventDate: string, n: number) {
    const wedding = await runOn(db, makeWedding({ eventDates: [eventDate] }));
    db.insert(registrySettings)
      .values({
        weddingId: wedding.weddingId,
        published: true,
        createdAt: GIFT_STAMP,
        updatedAt: GIFT_STAMP,
      })
      .run();
    addGifts(db, wedding.weddingId, wedding.familyId, n, GIFT_STAMP);
    return wedding;
  }

  const kept = (db: TestDb, weddingId: string): GiftSummary | null => {
    const raw = storedSummary(db, weddingId);
    return raw === null ? null : (JSON.parse(raw) as GiftSummary);
  };

  it("lists the oldest gifts up to the cap, and counts and totals every one", async () => {
    const db = freshDb();
    const n = GIFT_SUMMARY_MAX_LISTED + 5;
    const wedding = await weddingWithGifts(db, "2025-06-01", n);

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    const summary = kept(db, wedding.weddingId);
    expect(summary?.contributions.count).toBe(n);
    // 1,000 + 1,001 + … + 1,204.
    const total = n * 1_000 + (n * (n - 1)) / 2;
    expect(summary?.contributions.totals).toEqual([
      { currency: "AUD", amountMinor: total, count: n },
    ]);
    expect(summary?.contributions.gifts).toHaveLength(GIFT_SUMMARY_MAX_LISTED);
    // Oldest first, and the oldest are the ones kept.
    expect(summary?.contributions.gifts[0]).toEqual({
      on: "2025-05-11",
      amountMinor: 1_000,
      currency: "AUD",
    });
    expect(summary?.contributions.gifts.at(-1)?.amountMinor).toBe(
      1_000 + GIFT_SUMMARY_MAX_LISTED - 1,
    );
  });

  it("leaves a wedding past the run's budget for the next run, and takes the giftless ones behind it", async () => {
    // Enough full lists to fill the budget, then one more, then a wedding
    // with no money gift. All a year past their last event and inside the
    // hold-back (swept 2026-06-17: due after 2025-05-18, before 2025-06-17),
    // oldest first.
    const db = freshDb();
    const full = MAX_LISTED_GIFTS_PER_SWEEP / GIFT_SUMMARY_MAX_LISTED;
    const fitting = [];
    for (let i = 0; i < full; i++) {
      fitting.push(
        await weddingWithGifts(db, `2025-05-${String(20 + i)}`, GIFT_SUMMARY_MAX_LISTED),
      );
    }
    const over = await weddingWithGifts(db, "2025-06-01", GIFT_SUMMARY_MAX_LISTED);
    // A claim as well: the claims read must hold it back too, or a summary of
    // its claims alone would be stored while its rows stay to be counted again.
    const itemId = `reg_${crypto.randomUUID()}`;
    db.insert(registryItems)
      .values({
        id: itemId,
        weddingId: over.weddingId,
        kind: "product",
        title: "Copper pan",
        quantityWanted: 1,
        sortOrder: 0,
        createdAt: GIFT_STAMP,
        updatedAt: GIFT_STAMP,
      })
      .run();
    db.insert(registryClaims)
      .values({
        id: `rcl_${crypto.randomUUID()}`,
        weddingId: over.weddingId,
        itemId,
        familyId: over.familyId,
        quantity: 1,
        status: "reserved",
        createdAt: GIFT_STAMP,
        updatedAt: GIFT_STAMP,
      })
      .run();
    const giftless = await runOn(db, makeWedding({ eventDates: ["2025-06-02"] }));

    const logs = await captureLogs(() =>
      runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
    );

    for (const wedding of fitting) {
      expect(guestCount(db, wedding.guestId)).toBe(0);
      expect(kept(db, wedding.weddingId)?.contributions.gifts).toHaveLength(
        GIFT_SUMMARY_MAX_LISTED,
      );
    }
    // Waiting, untouched: its households and gifts are still there to count.
    expect(guestCount(db, over.guestId)).toBe(1);
    expect(storedSummary(db, over.weddingId)).toBeNull();
    expect(contributionCount(db, over.weddingId)).toBe(GIFT_SUMMARY_MAX_LISTED);
    expect(logs).toContain("deferred to the next run");
    expect(logs).not.toContain(over.weddingId);
    // A wedding with nothing to list never waits behind one that has a lot.
    expect(guestCount(db, giftless.guestId)).toBe(0);

    // The next run, it leads the cohort and is taken.
    await runOn(db, retentionService.sweepExpiredGuestData(new Date("2026-06-18T04:00:00.000Z")));
    expect(guestCount(db, over.guestId)).toBe(0);
    expect(kept(db, over.weddingId)?.contributions.count).toBe(GIFT_SUMMARY_MAX_LISTED);
    expect(kept(db, over.weddingId)?.claims).toEqual({ reserved: 1, purchased: 0 });
  });

  it("never makes a wedding past the hold-back ceiling wait, and lists only what the budget has room for", async () => {
    // Every one of these is more than 30 days past its retention date, so the
    // privacy notice's year outranks the budget: all are taken, with records.
    // But the list is cut to what the budget can afford, so a backlog of
    // overdue weddings cannot take the cron past its CPU or its batch.
    const db = freshDb();
    const full = MAX_LISTED_GIFTS_PER_SWEEP / GIFT_SUMMARY_MAX_LISTED;
    const fitting = [];
    for (let i = 0; i < full - 1; i++) {
      fitting.push(
        await weddingWithGifts(
          db,
          `2025-04-${String(i + 1).padStart(2, "0")}`,
          GIFT_SUMMARY_MAX_LISTED,
        ),
      );
    }
    // Leaves room for 50 more: the next overdue wedding lists 50 of its 200.
    const nearlyFull = await weddingWithGifts(db, "2025-04-10", GIFT_SUMMARY_MAX_LISTED - 50);
    const partial = await weddingWithGifts(db, "2025-04-11", GIFT_SUMMARY_MAX_LISTED);
    const none = await weddingWithGifts(db, "2025-04-12", GIFT_SUMMARY_MAX_LISTED);
    // Inside the hold-back, behind a run that has spent its budget: with
    // nothing to list it still has no reason to wait.
    const giftless = await runOn(db, makeWedding({ eventDates: ["2025-06-02"] }));

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    for (const wedding of [...fitting, nearlyFull, partial, none, giftless]) {
      expect(guestCount(db, wedding.guestId)).toBe(0);
    }
    for (const wedding of fitting) {
      expect(kept(db, wedding.weddingId)?.contributions.gifts).toHaveLength(
        GIFT_SUMMARY_MAX_LISTED,
      );
    }
    // The oldest 50 listed; every gift still counted and totalled.
    const cut = kept(db, partial.weddingId);
    expect(cut?.contributions.count).toBe(GIFT_SUMMARY_MAX_LISTED);
    expect(cut?.contributions.gifts).toHaveLength(50);
    expect(cut?.contributions.gifts[0]?.amountMinor).toBe(1_000);
    expect(cut?.contributions.gifts.at(-1)?.amountMinor).toBe(1_049);
    const unlisted = kept(db, none.weddingId);
    expect(unlisted?.contributions.count).toBe(GIFT_SUMMARY_MAX_LISTED);
    expect(unlisted?.contributions.gifts).toEqual([]);
    expect(unlisted?.contributions.totals[0]?.count).toBe(GIFT_SUMMARY_MAX_LISTED);
  });

  /** A household that arrives after the sweep, bringing the wedding back. */
  function returningHousehold(db: TestDb, weddingId: string, at: Date): string {
    const familyId = crypto.randomUUID();
    db.insert(families)
      .values({
        id: familyId,
        weddingId,
        publicId: `PUB-late-${familyId}`,
        familyName: "Late",
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return familyId;
  }

  /** Put `summary` on a wedding's settings row, as an earlier sweep would. */
  function keep(db: TestDb, weddingId: string, summary: unknown) {
    db.update(registrySettings)
      .set({ giftSummaryJson: JSON.stringify(summary), giftSummaryAt: GIFT_STAMP })
      .where(eq(registrySettings.weddingId, weddingId))
      .run();
  }

  /** A stored summary listing `n` gifts of 1,000 + i, all on 2025-05-11. */
  const storedList = (n: number): GiftSummary => ({
    sweptOn: "2026-06-01",
    firstGiftOn: "2025-05-11",
    lastGiftOn: "2025-05-11",
    claims: { reserved: 0, purchased: 0 },
    contributions: {
      count: n,
      totals: [{ currency: "AUD", amountMinor: n * 1_000 + (n * (n - 1)) / 2, count: n }],
      gifts: Array.from({ length: n }, (_, i) => ({
        on: "2025-05-11",
        amountMinor: 1_000 + i,
        currency: "AUD",
      })),
    },
  });

  it("adds new gifts to a summary kept before gifts were listed, and leaves its counts unknown", async () => {
    // A summary stored before this record listed gifts has totals with no
    // count. A count added to one would sit beside a total of more gifts than
    // it says, so the merged total keeps no count; a new currency keeps its own.
    const db = freshDb();
    const wedding = await weddingWithGifts(db, "2025-06-01", 3);
    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));
    keep(db, wedding.weddingId, {
      sweptOn: "2026-06-17",
      firstGiftOn: "2025-05-11",
      lastGiftOn: "2025-05-11",
      claims: { reserved: 0, purchased: 0 },
      contributions: { count: 3, totals: [{ currency: "AUD", amountMinor: 3_003 }] },
    });
    const later = new Date("2026-06-18T00:00:00.000Z");
    const familyId = returningHousehold(db, wedding.weddingId, later);
    await runOn(db, addGift(wedding.weddingId, familyId, { amountMinor: 100, at: later }));
    await runOn(
      db,
      addGift(wedding.weddingId, familyId, {
        amountMinor: 300,
        currency: "JPY",
        at: new Date("2026-06-18T01:00:00.000Z"),
      }),
    );

    await runOn(db, retentionService.sweepExpiredGuestData(new Date("2026-06-20T04:00:00.000Z")));

    const summary = kept(db, wedding.weddingId);
    expect(summary?.contributions.count).toBe(5);
    expect(summary?.contributions.totals).toEqual([
      { currency: "AUD", amountMinor: 3_103 },
      { currency: "JPY", amountMinor: 300, count: 1 },
    ]);
    // Only the new gifts can be listed; the three before are counted, unlisted.
    expect(summary?.contributions.gifts).toEqual([
      { on: "2026-06-18", amountMinor: 100, currency: "AUD" },
      { on: "2026-06-18", amountMinor: 300, currency: "JPY" },
    ]);
  });

  it("merges a stored aud total with a new AUD gift into one summary line", async () => {
    // A stored summary is text, so it keeps whatever case its rows had; the
    // merge must still read aud and AUD as one currency.
    const db = freshDb();
    const wedding = await weddingWithGifts(db, "2025-06-01", 0);
    keep(db, wedding.weddingId, {
      sweptOn: "2026-06-01",
      firstGiftOn: "2025-05-11",
      lastGiftOn: "2025-05-11",
      claims: { reserved: 0, purchased: 0 },
      contributions: {
        count: 1,
        totals: [{ currency: "aud", amountMinor: 2_000, count: 1 }],
        gifts: [{ on: "2025-05-11", amountMinor: 2_000, currency: "aud" }],
      },
    });
    await runOn(db, addGift(wedding.weddingId, wedding.familyId, { amountMinor: 3_000 }));

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    const summary = kept(db, wedding.weddingId);
    expect(summary?.contributions.totals).toEqual([
      { currency: "AUD", amountMinor: 5_000, count: 2 },
    ]);
    expect(summary?.contributions.gifts.map((gift) => gift.currency)).toEqual(["AUD", "AUD"]);
  });

  it("keeps the oldest gifts when a returning wedding's list passes the cap", async () => {
    const db = freshDb();
    const wedding = await weddingWithGifts(db, "2025-06-01", 150);
    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));
    const later = new Date("2026-06-18T00:00:00.000Z");
    const familyId = returningHousehold(db, wedding.weddingId, later);
    addGifts(db, wedding.weddingId, familyId, 100, later);

    await runOn(db, retentionService.sweepExpiredGuestData(new Date("2026-06-20T04:00:00.000Z")));

    const summary = kept(db, wedding.weddingId);
    expect(summary?.contributions.count).toBe(250);
    expect(summary?.contributions.gifts).toHaveLength(GIFT_SUMMARY_MAX_LISTED);
    expect(summary?.contributions.gifts[0]).toEqual({
      on: "2025-05-11",
      amountMinor: 1_000,
      currency: "AUD",
    });
    expect(summary?.contributions.gifts[149]?.on).toBe("2025-05-11");
    expect(summary?.contributions.gifts[150]?.on).toBe("2026-06-18");
  });

  it("counts a returning wedding's stored list against the run's budget", async () => {
    // Its record is rewritten — stored list and new gift together — so the
    // stored gifts are encoded and mailed this run, and they count.
    const db = freshDb();
    const room = MAX_LISTED_GIFTS_PER_SWEEP - 100;
    for (let i = 0; i < room / GIFT_SUMMARY_MAX_LISTED; i++) {
      await weddingWithGifts(db, `2025-05-${String(20 + i)}`, GIFT_SUMMARY_MAX_LISTED);
    }
    await weddingWithGifts(db, "2025-05-30", room % GIFT_SUMMARY_MAX_LISTED);
    const returning = await weddingWithGifts(db, "2025-06-01", 1);
    keep(db, returning.weddingId, storedList(150));

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    // 151 listed would pass the budget with the rest already in: it waits.
    expect(guestCount(db, returning.guestId)).toBe(1);
    expect(kept(db, returning.weddingId)?.contributions.gifts).toHaveLength(150);
  });

  it("spends none of the budget on a returning wedding with nothing new", async () => {
    // Nothing new means no summary rewritten and nothing mailed, so its stored
    // list costs this run nothing and holds nobody back.
    const db = freshDb();
    const idle = await weddingWithGifts(db, "2025-05-19", 0);
    keep(db, idle.weddingId, storedList(GIFT_SUMMARY_MAX_LISTED));
    const full = MAX_LISTED_GIFTS_PER_SWEEP / GIFT_SUMMARY_MAX_LISTED;
    const others = [];
    for (let i = 0; i < full; i++) {
      others.push(await weddingWithGifts(db, `2025-05-${String(20 + i)}`, GIFT_SUMMARY_MAX_LISTED));
    }

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    for (const wedding of others) expect(guestCount(db, wedding.guestId)).toBe(0);
    // Swept, and its record left exactly as it was.
    expect(guestCount(db, idle.guestId)).toBe(0);
    expect(kept(db, idle.weddingId)).toEqual(storedList(GIFT_SUMMARY_MAX_LISTED));
  });

  it("lists a negative amount as nothing, and totals what it lists", async () => {
    // The amount column has no CHECK; a negative row must not subtract from
    // what the couple were given, in the list or in the total.
    const db = freshDb();
    const wedding = await weddingWithGifts(db, "2025-06-01", 1);
    await runOn(
      db,
      addGift(wedding.weddingId, wedding.familyId, {
        amountMinor: -500,
        at: new Date("2025-05-12T00:00:00.000Z"),
      }),
    );

    await runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT));

    const summary = kept(db, wedding.weddingId);
    expect(summary?.contributions.gifts).toEqual([
      { on: "2025-05-11", amountMinor: 1_000, currency: "AUD" },
      { on: "2025-05-12", amountMinor: 0, currency: "AUD" },
    ]);
    const listedSum = (summary?.contributions.gifts ?? []).reduce((n, g) => n + g.amountMinor, 0);
    expect(summary?.contributions.totals[0]?.amountMinor).toBe(listedSum);
  });
});

describe("packGiftSummaries", () => {
  const summary = (gifts: number): GiftSummary => ({
    sweptOn: "2026-06-17",
    firstGiftOn: "2025-05-11",
    lastGiftOn: "2025-06-11",
    claims: { reserved: 99, purchased: 99 },
    contributions: {
      count: gifts,
      totals: [{ currency: "AUD", amountMinor: 999_999_999, count: gifts }],
      gifts: Array.from({ length: gifts }, () => ({
        on: "2025-05-11",
        amountMinor: 999_999_999,
        currency: "AUD",
      })),
    },
  });

  it("keeps a run at the budget to a handful of statements, each under the chunk size", () => {
    // The worst run the budget allows: every listed gift a nine-digit amount,
    // packed into full lists, and the rest of the wedding cap with records but
    // no gifts listed.
    const summaries = new Map<string, GiftSummary>();
    const full = MAX_LISTED_GIFTS_PER_SWEEP / GIFT_SUMMARY_MAX_LISTED;
    for (let i = 0; i < MAX_WEDDINGS_PER_SWEEP; i++) {
      summaries.set(crypto.randomUUID(), summary(i < full ? GIFT_SUMMARY_MAX_LISTED : 0));
    }
    const packs = packGiftSummaries(summaries);
    // Far under the 50 statements a D1 batch takes, with the deletes beside it.
    expect(packs.length).toBeLessThanOrEqual(6);
    for (const pack of packs) {
      expect(pack.payload.length).toBeLessThanOrEqual(GIFT_SUMMARY_STORE_CHUNK_CHARS);
    }
    // Every wedding exactly once, and each payload says which.
    const ids = packs.flatMap((pack) => pack.weddingIds);
    expect(ids.toSorted()).toEqual([...summaries.keys()].toSorted());
    for (const pack of packs) {
      const entries = JSON.parse(pack.payload) as { weddingId: string; summary: string }[];
      expect(entries.map((entry) => entry.weddingId)).toEqual(pack.weddingIds);
      for (const entry of entries) {
        expect(JSON.parse(entry.summary)).toEqual(summaries.get(entry.weddingId));
      }
    }
  });

  it("sends a summary longer than the budget alone rather than splitting it", () => {
    const summaries = new Map([
      ["wed_a", summary(1)],
      ["wed_big", summary(GIFT_SUMMARY_MAX_LISTED)],
      ["wed_c", summary(1)],
    ]);
    const packs = packGiftSummaries(summaries, 2_000);
    expect(packs.map((pack) => pack.weddingIds)).toEqual([["wed_a"], ["wed_big"], ["wed_c"]]);
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

  it.each([
    {
      shape: "no event it can date",
      // Its retention date is three years after it was created: 2023-06-17
      // for a run on 2026-06-17. On the 30th day past that it is still held
      // for its record; a day later it is not.
      onCeiling: { createdAt: "2023-05-18T04:00:00.000Z", dated: [], undated: true },
      pastCeiling: { createdAt: "2023-05-17T04:00:00.000Z", dated: [], undated: true },
    },
    {
      shape: "a readable event three months past",
      // The readable event does not move its retention date, which is still
      // three years after its creation: the 30 days count from there alone.
      onCeiling: { createdAt: "2023-05-18T04:00:00.000Z", dated: ["2026-03-14"], undated: true },
      pastCeiling: { createdAt: "2023-05-17T04:00:00.000Z", dated: ["2026-03-14"], undated: true },
    },
    {
      shape: "no events at all",
      // Treated as a wedding it cannot date, so the same dates hold.
      onCeiling: { createdAt: "2023-05-18T04:00:00.000Z", dated: [], undated: false },
      pastCeiling: { createdAt: "2023-05-17T04:00:00.000Z", dated: [], undated: false },
    },
  ])(
    "counts the 30 days from the three years of a wedding it cannot date, with $shape",
    async ({ onCeiling: onCeilingAt, pastCeiling: pastCeilingAt }) => {
      const db = freshDb();
      const undatableGifted = async ({
        createdAt,
        dated,
        undated,
      }: {
        createdAt: string;
        dated: readonly string[];
        /** Give it an event whose Start the sweep cannot read. */
        undated: boolean;
      }) => {
        const wedding = makeWeddingWithTimes(
          db,
          [
            ...(undated ? [{ startAt: "TBD by the couple", endAt: "" }] : []),
            ...dated.map((day) => ({
              startAt: `${day}T10:00:00+11:00`,
              endAt: `${day}T12:00:00+11:00`,
            })),
          ],
          new Date(createdAt),
        );
        db.insert(registrySettings)
          .values({
            weddingId: wedding.weddingId,
            published: true,
            createdAt: GIFT_STAMP,
            updatedAt: GIFT_STAMP,
          })
          .run();
        await runOn(db, addGift(wedding.weddingId, wedding.familyId));
        return wedding;
      };
      const onCeiling = await undatableGifted(onCeilingAt);
      const pastCeiling = await undatableGifted(pastCeilingAt);
      const before = await written("abandoned");
      failStatements(db, (sql) => sql.includes('from "registry_contributions"'));

      const logs = await captureLogs(() =>
        runOn(db, retentionService.sweepExpiredGuestData(SWEEP_AT)),
      );

      expect(guestCount(db, onCeiling.guestId)).toBe(1);
      expect(guestCount(db, pastCeiling.guestId)).toBe(0);
      expect(storedSummary(db, pastCeiling.weddingId)).toBeNull();
      expect(logs).toContain("deleted past the 30-day hold-back");
      expect(await written("abandoned")).toBe(before + 1);
    },
  );

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

  it("mails nothing about summaries a failed batch did not store, and returns what the retry deleted", async () => {
    const db = freshDb();
    // Past the ceiling, so the retry deletes them without their summaries;
    // only the one with gifts had a summary to lose...
    const past = await runOn(db, makeGiftedWedding("2025-05-01"));
    const pastGiftless = await runOn(db, makeWedding({ eventDates: ["2025-05-02"] }));
    // ...and inside the hold-back, so it waits for the next run.
    const held = await runOn(db, makeGiftedWedding("2025-06-01"));
    const abandoned = await written("abandoned");
    let suppressionDeletes = 0;
    let ownerReads = 0;
    // The first statement of the first batch, the one carrying both summaries.
    // A D1 batch that fails commits nothing; failing its first statement is how
    // bun:sqlite, which runs them one by one, ends in the same place.
    const fault = failStatements(db, (sql) => {
      if (sql.includes('join "wedding_hosts"')) ownerReads += 1;
      return sql.startsWith('delete from "email_suppressions"') && ++suppressionDeletes === 1;
    });
    let calls = 0;

    let deleted: number | undefined;
    await captureLogs(async () => {
      deleted = await runOn(
        db,
        retentionService.sweepExpiredGuestData(SWEEP_AT, {}, () =>
          Effect.sync(() => {
            calls += 1;
          }),
        ),
      );
    });

    expect(fault.failed()).toBe(1);
    expect(deleted).toBe(2);
    expect(await written("abandoned")).toBe(abandoned + 1);
    // The email says "this is the record we kept"; with no record kept, none
    // goes, and nobody is even looked up to send it to.
    expect(calls).toBe(0);
    expect(ownerReads).toBe(0);
    expect(storedSummary(db, past.weddingId)).toBeNull();
    expect(storedSummary(db, held.weddingId)).toBeNull();
    expect(guestCount(db, past.guestId)).toBe(0);
    expect(guestCount(db, pastGiftless.guestId)).toBe(0);
    expect(guestCount(db, held.guestId)).toBe(1);
    expect(contributionCount(db, held.weddingId)).toBe(1);
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

// The day a wedding's three years from creation run out, worked out once and
// shared by the sweep and the organiser portal's warning: the sweep never takes
// a wedding before it, and takes it at every run after.
describe("the three-year bound from creation", () => {
  it("takes no wedding created on the 1 March three years before a 29 February run, until its anniversary", async () => {
    const db = freshDb();
    const undated = [{ startAt: "TBD by the couple", endAt: "" }];
    // Its anniversary is 1 March 2028: a run at 04:00 on 29 February is early.
    const firstOfMarch = makeWeddingWithTimes(db, undated, new Date("2025-03-01T01:00:00.000Z"));
    // Its anniversary, 28 February 2028, has passed.
    const lastOfFebruary = makeWeddingWithTimes(db, undated, new Date("2025-02-28T23:00:00.000Z"));

    await runOn(db, retentionService.sweepExpiredGuestData(new Date("2028-02-29T04:00:00.000Z")));

    expect(guestCount(db, firstOfMarch.guestId)).toBe(1);
    expect(guestCount(db, lastOfFebruary.guestId)).toBe(0);
  });

  it("never takes a wedding before its bound, and takes it at every run after", () => {
    const failures: string[] = [];
    const HOUR = 60 * 60 * 1000;
    const minute = 60 * 1000;
    for (
      let day = Date.parse("2023-01-01T00:00:00.000Z");
      day < Date.parse("2026-01-01T00:00:00.000Z");
      day += DAY_MS
    ) {
      for (const offset of [
        30 * minute,
        3 * HOUR + 59 * minute,
        4 * HOUR + minute,
        23 * HOUR + 30 * minute,
      ]) {
        const createdAt = Math.floor((day + offset) / 1000);
        const bound = creationBoundAt(createdAt).getTime();
        // Two days either side of the anniversary, at midnight, the cron's
        // hour and the last minute of the day.
        const anniversary = new Date(day);
        anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 3);
        for (let d = -2; d <= 2; d++) {
          for (const at of [0, 4 * HOUR, 23 * HOUR + 59 * minute]) {
            const run = anniversary.getTime() + d * DAY_MS + at;
            const taken = createdAt < creationCutoffSeconds(run);
            if (taken && bound > run) failures.push(`early: created ${createdAt}, run ${run}`);
            if (bound < run && !taken) failures.push(`late: created ${createdAt}, run ${run}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("is three calendar years on, and 1 March for a wedding created on 29 February", () => {
    const at = (iso: string) => creationBoundAt(Date.parse(iso) / 1000).toISOString();
    expect(at("2023-11-30T12:00:00.000Z")).toBe("2026-11-30T12:00:00.000Z");
    expect(at("2024-02-29T23:30:00.000Z")).toBe("2027-03-01T00:00:00.000Z");
  });
});

describe("the organiser portal's warning of the three-year bound", () => {
  const AT = SWEEP_AT;
  const undated = [{ startAt: "TBD by the couple", endAt: "" }];
  /** The created_at whose bound falls `days` days after the run. */
  const boundIn = (days: number) => {
    const created = new Date(AT.getTime() + days * DAY_MS);
    created.setUTCFullYear(created.getUTCFullYear() - 3);
    return created;
  };
  const listed = async (db: TestDb, at: Date = AT) => {
    const list = await runOn(db, weddingsService.listForMember("usr_test", at));
    return new Map(list.weddings.map((w) => [w.id, w.guestDataBound]));
  };

  it("warns 89 days before the bound, from the bound, and not 91 days before", async () => {
    const db = freshDb();
    const near = makeWeddingWithTimes(db, undated, boundIn(89));
    const far = makeWeddingWithTimes(db, undated, boundIn(91));

    const bounds = await listed(db);

    expect(bounds.get(near.weddingId)).toEqual({
      state: "near",
      reason: "unreadable-date",
      from: new Date(AT.getTime() + 89 * DAY_MS).toISOString(),
      events: [],
      eventCount: 0,
    });
    expect(bounds.get(far.weddingId)).toBeUndefined();
    expect(CREATION_BOUND_WARNING_MS).toBe(90 * DAY_MS);
  });

  it("says passed exactly for the weddings the sweep takes at the same instant", async () => {
    const db = freshDb();
    const passed = makeWeddingWithTimes(db, undated, boundIn(-1));
    const passedEmpty = makeWeddingWithTimes(db, [], boundIn(-1));
    const near = makeWeddingWithTimes(db, undated, boundIn(30));
    const nearEmpty = makeWeddingWithTimes(db, [], boundIn(30));
    // Its last event is two months past, so the year rule keeps it; the
    // three years from its creation do not apply to a wedding whose dates read.
    const dated = makeWeddingWithTimes(
      db,
      [{ startAt: "2026-04-15T10:00:00+10:00", endAt: "2026-04-15T12:00:00+10:00" }],
      new Date(AT.getTime() - 4 * YEAR_MS),
    );

    const bounds = await listed(db);
    await runOn(db, retentionService.sweepExpiredGuestData(AT));

    expect(bounds.get(passed.weddingId)).toMatchObject({
      state: "passed",
      reason: "unreadable-date",
    });
    expect(bounds.get(passedEmpty.weddingId)).toMatchObject({
      state: "passed",
      reason: "no-events",
    });
    expect(bounds.get(near.weddingId)).toMatchObject({ state: "near", reason: "unreadable-date" });
    expect(bounds.get(nearEmpty.weddingId)).toMatchObject({ state: "near", reason: "no-events" });
    expect(bounds.get(dated.weddingId)).toBeUndefined();
    expect(
      [passed, passedEmpty, near, nearEmpty, dated].map((w) => guestCount(db, w.guestId)),
    ).toEqual([0, 0, 1, 1, 1]);
  });

  // The sweep keeps such a wedding, so the portal has nothing to warn of.
  it.each([
    { shape: "milliseconds", stored: Date.parse("2022-01-01T00:00:00.000Z") },
    { shape: "text", stored: "2022-01-01" },
  ])("does not warn for a wedding whose stored creation time is in $shape", async ({ stored }) => {
    const db = freshDb();
    const withEvent = makeWeddingWithTimes(db, undated);
    const empty = makeWeddingWithTimes(db, []);
    for (const id of [withEvent.weddingId, empty.weddingId]) {
      db.run(rawSql`update ${weddings} set created_at = ${stored} where id = ${id}`);
    }

    const bounds = await listed(db);

    expect(bounds.get(withEvent.weddingId)).toBeUndefined();
    expect(bounds.get(empty.weddingId)).toBeUndefined();
  });

  it("warns for an End it cannot read beside a Start it can", async () => {
    const db = freshDb();
    const wedding = makeWeddingWithTimes(
      db,
      [{ startAt: "2027-02-06T15:00:00+11:00", endAt: "late" }],
      boundIn(10),
    );

    expect((await listed(db)).get(wedding.weddingId)).toMatchObject({
      state: "near",
      reason: "unreadable-date",
    });
  });

  it("warns whether or not the wedding holds guest data now", async () => {
    const db = freshDb();
    const wedding = makeWeddingWithTimes(db, undated, boundIn(-400));
    db.delete(guests).where(eq(guests.familyId, wedding.familyId)).run();
    db.delete(families).where(eq(families.id, wedding.familyId)).run();

    expect((await listed(db)).get(wedding.weddingId)).toMatchObject({ state: "passed" });
  });

  it("warns only an owner and an editor of the wedding", async () => {
    const db = freshDb();
    const wedding = makeWeddingWithTimes(db, undated, boundIn(-1));
    const seat = (osnProfileId: string, role: "editor" | "viewer" | "helper") =>
      db
        .insert(weddingHosts)
        .values({
          id: `whost_${osnProfileId}`,
          weddingId: wedding.weddingId,
          osnProfileId,
          addedByOsnProfileId: "usr_test",
          role,
          createdAt: new Date(),
        })
        .run();
    seat("usr_editor", "editor");
    seat("usr_viewer", "viewer");
    seat("usr_helper", "helper");

    const boundFor = async (profile: string) =>
      (await runOn(db, weddingsService.listForMember(profile, AT))).weddings[0]?.guestDataBound;

    expect(await boundFor("usr_test")).toMatchObject({ state: "passed" });
    expect(await boundFor("usr_editor")).toMatchObject({ state: "passed" });
    expect(await boundFor("usr_viewer")).toBeUndefined();
    expect(await boundFor("usr_helper")).toBeUndefined();
  });

  it("names only the events it cannot date, in the editor's order, at most three, and counts them all", async () => {
    const db = freshDb();
    const wedding = makeWeddingWithTimes(db, [], boundIn(-1));
    const event = (name: string, sortOrder: number, startAt: string) =>
      db
        .insert(events)
        .values({
          id: `${wedding.weddingId}-${sortOrder}`,
          weddingId: wedding.weddingId,
          slug: `ev-${sortOrder}`,
          name,
          startAt,
          endAt: "",
          timezone: "Australia/Sydney",
          sortOrder,
        })
        .run();
    event("Dated", 0, "2027-02-06T15:00:00+11:00");
    event("Fifth", 5, "TBD");
    event("", 2, "TBD");
    event("Third", 3, "2027-02-06");
    event("First", 1, "soon");
    event("Fourth", 4, "TBD");
    const other = makeWeddingWithTimes(db, undated, boundIn(-1));

    const names = await runOn(
      db,
      retentionService.undatedEventNames([wedding.weddingId, other.weddingId]),
    );

    expect(names.get(wedding.weddingId)).toEqual({ names: ["First", "", "Third"], count: 5 });
    expect(names.get(other.weddingId)).toEqual({ names: ["Event 0"], count: 1 });
  });

  it("reads nothing for no weddings", async () => {
    const db = freshDb();
    const statements = recordStatements(db);

    const names = await runOn(db, retentionService.undatedEventNames([]));

    expect(names.size).toBe(0);
    expect(statements).toHaveLength(0);
  });

  // The cycle the warning exists for: past its three years, a wedding that
  // still cannot be dated loses each household added to it at the next run.
  it("deletes a household added after the sweep at the next day's run", async () => {
    const db = freshDb();
    const wedding = makeWeddingWithTimes(
      db,
      [
        { startAt: "TBD by the couple", endAt: "" },
        { startAt: "2027-06-17T10:00:00+10:00", endAt: "" },
      ],
      new Date(AT.getTime() - 4 * YEAR_MS),
    );
    await runOn(db, retentionService.sweepExpiredGuestData(AT));
    expect(familyCount(db, wedding.weddingId)).toBe(0);

    const now = new Date();
    db.insert(families)
      .values({
        id: crypto.randomUUID(),
        weddingId: wedding.weddingId,
        publicId: `PUB-again-${wedding.weddingId}`,
        familyName: "Jones",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(familyCount(db, wedding.weddingId)).toBe(1);

    await runOn(db, retentionService.sweepExpiredGuestData(new Date(AT.getTime() + DAY_MS)));

    expect(familyCount(db, wedding.weddingId)).toBe(0);
  });
});
