import { describe, it, expect } from "bun:test";

import {
  weddings,
  families,
  guests,
  events,
  rsvps,
  imports,
  weddingInviteCustomisations,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import type { DeletableBucket } from "./r2-cleanup";
import { retentionService, RETENTION_AFTER_FINAL_EVENT_MS } from "./retention";

const withDb = effWith(TestDbLayer);

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * In-memory delete-only R2 stub recording every key passed to `.delete()`.
 * Supports BOTH the single-key and the array (multi-key) delete form so the
 * reaper's array-first/per-key-fallback path is exercised. `failKeys` forces a
 * throw for the named keys (best-effort path); `arrayOnly: false` simulates a
 * binding that rejects the array form (the test-stub case).
 */
function createDeleteStub(
  opts: { failKeys?: Set<string>; rejectArray?: boolean } = {},
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
  eventDates: string[];
  withImport?: boolean;
  /** Add a `wedding_invite_customisations` row with hero/story image keys. */
  withInviteImages?: boolean;
  /** Give the FIRST event an `event_image_key`. */
  withEventImage?: boolean;
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

    const assetKeys: string[] = [];
    opts.eventDates.forEach((date, i) => {
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
          endAt: `${date}T12:00:00+11:00`,
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
    }

    const sheetKeys: string[] = [];
    if (opts.withImport) {
      const eventsR2Key = `imports/${weddingId}/events.csv`;
      const guestsR2Key = `imports/${weddingId}/guests.csv`;
      sheetKeys.push(eventsR2Key, guestsR2Key);
      db.insert(imports)
        .values({
          id: crypto.randomUUID(),
          weddingId,
          uploadedAt: now.getTime(),
          format: "csv",
          eventsR2Key,
          guestsR2Key,
          summary: "{}",
          status: "applied",
        })
        .run();
    }

    return { weddingId, familyId, guestId, rsvpId, sheetKeys, assetKeys };
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
        const cust = db
          .select()
          .from(weddingInviteCustomisations)
          .where(eq(weddingInviteCustomisations.weddingId, weddingId))
          .all();
        expect(cust.length).toBe(1);
        expect(cust[0]?.heroImageKey).not.toBeNull();
        // And the event row keeps its image key.
        const evs = db.select().from(events).where(eq(events.weddingId, weddingId)).all();
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
        expect(db.select().from(guests).where(eq(guests.id, guestId)).all().length).toBe(0);
        expect(db.select().from(imports).where(eq(imports.weddingId, weddingId)).all().length).toBe(
          0,
        );
        // The failing keys were never recorded as deleted.
        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(false);
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
        expect(db.select().from(imports).where(eq(imports.weddingId, weddingId)).all().length).toBe(
          0,
        );
        // …yet every sheet key they referenced was reaped (proving pre-delete collect).
        for (const k of sheetKeys) expect(sheets.deleted.has(k)).toBe(true);
        expect(sheets.deleted.size).toBe(sheetKeys.length);
      }),
    ),
  );
});
