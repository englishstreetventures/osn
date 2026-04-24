import { expect, it } from "@effect/vitest";
import { events, eventSeries, type EventSeries } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { updateEvent } from "../../src/services/events";
import {
  cancelSeries,
  createSeries,
  expandRRule,
  getSeries,
  listInstances,
  MAX_SERIES_INSTANCES,
  parseRRule,
  updateSeries,
} from "../../src/services/series";
import { createTestLayer } from "../helpers/db";

const ALICE = { createdByProfileId: "usr_alice", createdByName: "Alice", createdByAvatar: null };
const BOB = { createdByProfileId: "usr_bob", createdByName: "Bob", createdByAvatar: null };
const futureIso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const provide = <A, E>(effect: Effect.Effect<A, E, any>) =>
  effect.pipe(Effect.provide(createTestLayer()));

// ---------------------------------------------------------------------------
// RRULE parsing
// ---------------------------------------------------------------------------

it.effect("parseRRule accepts FREQ=WEEKLY;COUNT=4", () =>
  Effect.gen(function* () {
    const parsed = yield* parseRRule("FREQ=WEEKLY;COUNT=4");
    expect(parsed.freq).toBe("WEEKLY");
    expect(parsed.count).toBe(4);
  }),
);

it.effect("parseRRule rejects unsupported FREQ", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(parseRRule("FREQ=YEARLY;COUNT=2"));
    expect(err._tag).toBe("SeriesRRuleInvalid");
    expect(err.reason).toBe("unsupported_freq");
  }),
);

it.effect("parseRRule rejects missing termination", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(parseRRule("FREQ=WEEKLY"));
    expect(err.reason).toBe("missing_termination");
  }),
);

it.effect("parseRRule rejects COUNT > MAX_SERIES_INSTANCES", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(parseRRule(`FREQ=WEEKLY;COUNT=${MAX_SERIES_INSTANCES + 1}`));
    expect(err.reason).toBe("too_many_instances");
  }),
);

it.effect("parseRRule rejects BYDAY with MONTHLY", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(parseRRule("FREQ=MONTHLY;BYDAY=MO;COUNT=3"));
    expect(err.reason).toBe("parse_error");
  }),
);

// ---------------------------------------------------------------------------
// expandRRule
// ---------------------------------------------------------------------------

it.effect("expandRRule WEEKLY produces N instances 7 days apart", () =>
  Effect.succeed(undefined).pipe(
    Effect.flatMap(() =>
      Effect.sync(() => {
        const dtstart = new Date("2030-06-04T18:00:00.000Z"); // Tuesday
        const parsed = { freq: "WEEKLY" as const, interval: 1, byDay: null, count: 4, until: null };
        const dates = expandRRule(parsed, dtstart, new Date("2100-01-01"));
        expect(dates).toHaveLength(4);
        expect(dates[1]!.getTime() - dates[0]!.getTime()).toBe(7 * 86_400_000);
      }),
    ),
  ),
);

it.effect("expandRRule respects COUNT cap", () =>
  Effect.sync(() => {
    const dtstart = new Date("2030-06-04T18:00:00.000Z");
    const parsed = { freq: "WEEKLY" as const, interval: 1, byDay: null, count: 3, until: null };
    const dates = expandRRule(parsed, dtstart, new Date("2100-01-01"));
    expect(dates).toHaveLength(3);
  }),
);

it.effect("expandRRule MONTHLY walks by month", () =>
  Effect.sync(() => {
    const dtstart = new Date("2030-06-01T18:00:00.000Z");
    const parsed = { freq: "MONTHLY" as const, interval: 1, byDay: null, count: 3, until: null };
    const dates = expandRRule(parsed, dtstart, new Date("2100-01-01"));
    expect(dates).toHaveLength(3);
    expect(dates[1]!.getUTCMonth()).toBe((dates[0]!.getUTCMonth() + 1) % 12);
  }),
);

// ---------------------------------------------------------------------------
// createSeries
// ---------------------------------------------------------------------------

it.effect("createSeries materializes instances with seriesId set", () =>
  provide(
    Effect.gen(function* () {
      const { series, instances } = yield* createSeries(
        {
          title: "Weekly Yoga",
          rrule: "FREQ=WEEKLY;COUNT=4",
          dtstart: futureIso(7),
          category: "wellness",
          timezone: "America/New_York",
        },
        ALICE,
      );
      expect(series.id).toMatch(/^srs_/);
      expect(instances).toHaveLength(4);
      for (const i of instances) {
        expect(i.seriesId).toBe(series.id);
        expect(i.instanceOverride).toBe(false);
      }
    }),
  ),
);

it.effect("createSeries rejects past dtstart", () =>
  provide(
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        createSeries(
          { title: "Past", rrule: "FREQ=WEEKLY;COUNT=2", dtstart: "2020-01-01T00:00:00Z" },
          ALICE,
        ),
      );
      expect(err._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createSeries rejects invalid RRULE", () =>
  provide(
    Effect.gen(function* () {
      const err = yield* Effect.flip(
        createSeries({ title: "X", rrule: "FREQ=WEEKLY", dtstart: futureIso(5) }, ALICE),
      );
      expect(err._tag).toBe("SeriesRRuleInvalid");
    }),
  ),
);

// ---------------------------------------------------------------------------
// listInstances + visibility
// ---------------------------------------------------------------------------

it.effect("listInstances returns upcoming by default", () =>
  provide(
    Effect.gen(function* () {
      const { series } = yield* createSeries(
        { title: "W", rrule: "FREQ=WEEKLY;COUNT=3", dtstart: futureIso(2) },
        ALICE,
      );
      const upcoming = yield* listInstances(series.id, { scope: "upcoming", viewerId: null });
      expect(upcoming.length).toBe(3);
      const past = yield* listInstances(series.id, { scope: "past", viewerId: null });
      expect(past.length).toBe(0);
    }),
  ),
);

it.effect("listInstances on unknown series fails with SeriesNotFound", () =>
  provide(
    Effect.gen(function* () {
      const err = yield* Effect.flip(listInstances("srs_missing", { viewerId: null }));
      expect(err._tag).toBe("SeriesNotFound");
    }),
  ),
);

// ---------------------------------------------------------------------------
// updateSeries — bulk propagation + override respect
// ---------------------------------------------------------------------------

it.effect("updateSeries propagates to non-override instances only", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const { series, instances } = yield* createSeries(
        { title: "W", rrule: "FREQ=WEEKLY;COUNT=4", dtstart: futureIso(2), venue: "Original" },
        ALICE,
      );
      // Flip one instance to override by patching it directly.
      yield* updateEvent(instances[1]!.id, { venue: "Custom" }, "usr_alice");

      yield* updateSeries(series.id, { venue: "Updated" }, "usr_alice");

      const rows = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.seriesId, series.id)),
      );
      const overrideRow = rows.find((r) => r.id === instances[1]!.id)!;
      const normalRow = rows.find((r) => r.id === instances[0]!.id)!;
      expect(overrideRow.venue).toBe("Custom");
      expect(normalRow.venue).toBe("Updated");
    }),
  ),
);

it.effect("updateSeries rejects non-owner with NotEventOwner", () =>
  provide(
    Effect.gen(function* () {
      const { series } = yield* createSeries(
        { title: "W", rrule: "FREQ=WEEKLY;COUNT=2", dtstart: futureIso(2) },
        ALICE,
      );
      const err = yield* Effect.flip(
        updateSeries(series.id, { title: "Hax" }, BOB.createdByProfileId),
      );
      expect(err._tag).toBe("NotEventOwner");
    }),
  ),
);

// ---------------------------------------------------------------------------
// cancelSeries
// ---------------------------------------------------------------------------

it.effect("cancelSeries cancels future instances and marks series cancelled", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const { series } = yield* createSeries(
        { title: "W", rrule: "FREQ=WEEKLY;COUNT=3", dtstart: futureIso(2) },
        ALICE,
      );
      const result = yield* cancelSeries(series.id, "usr_alice");
      expect(result.cancelled).toBe(3);

      const rows = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.seriesId, series.id)),
      );
      for (const r of rows) expect(r.status).toBe("cancelled");

      const fresh = yield* getSeries(series.id);
      expect(fresh.status).toBe("cancelled");
    }),
  ),
);

// ---------------------------------------------------------------------------
// Single-instance patch flips instanceOverride
// ---------------------------------------------------------------------------

it.effect("patching a series instance flips instanceOverride=true", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const { instances } = yield* createSeries(
        { title: "W", rrule: "FREQ=WEEKLY;COUNT=2", dtstart: futureIso(2) },
        ALICE,
      );
      yield* updateEvent(instances[0]!.id, { venue: "Changed" }, "usr_alice");
      const rows = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.id, instances[0]!.id)),
      );
      expect(rows[0]!.instanceOverride).toBe(true);

      const other = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.id, instances[1]!.id)),
      );
      expect(other[0]!.instanceOverride).toBe(false);
    }),
  ),
);

// ---------------------------------------------------------------------------
// Metadata smoke: series row is reachable and carries timezone + rrule
// ---------------------------------------------------------------------------

it.effect("getSeries returns metadata with rrule and timezone", () =>
  provide(
    Effect.gen(function* () {
      const { series } = yield* createSeries(
        {
          title: "W",
          rrule: "FREQ=WEEKLY;COUNT=2",
          dtstart: futureIso(2),
          timezone: "America/New_York",
        },
        ALICE,
      );
      const row: EventSeries = yield* getSeries(series.id);
      expect(row.rrule).toBe("FREQ=WEEKLY;COUNT=2");
      expect(row.timezone).toBe("America/New_York");
    }),
  ),
);

// Silence unused warning for eventSeries import (kept for type side-effect symmetry)
void eventSeries;
void and;
