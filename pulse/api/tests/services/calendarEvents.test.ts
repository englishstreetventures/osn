import { Database } from "bun:sqlite";

import { it, expect } from "@effect/vitest";
import * as schema from "@pulse/db/schema";
import { eventRsvps } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";

import { listMyCalendarEvents } from "../../src/services/events";
import { upsertRsvp } from "../../src/services/rsvps";
import { createTestLayer, seedEvent } from "../helpers/db";

// Db layer over a schema-less SQLite — every query fails at execution
// ("no such table"), exercising the DatabaseError channel.
const noSchemaLayer = () =>
  Layer.succeed(Db, { db: drizzle(new Database(":memory:"), { schema }) });

const VIEWER = "usr_me";
const OTHER = "usr_alice";

const now = Date.now();
const inDays = (n: number) => new Date(now + n * 86_400_000).toISOString();
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

// Insert a raw RSVP row (used for the organiser-only "invited" status,
// which upsertRsvp never accepts from end users).
const seedRsvpRow = (eventId: string, profileId: string, status: "invited") =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.insert(eventRsvps).values({
        id: `rsvp_${eventId}_${profileId}`,
        eventId,
        profileId,
        status,
        createdAt: new Date(),
      }),
    );
  });

it.effect("returns events the viewer is going to, ordered by start time", () =>
  Effect.gen(function* () {
    const later = yield* seedEvent({
      title: "Later",
      startTime: inDays(3),
      createdByProfileId: OTHER,
    });
    const sooner = yield* seedEvent({
      title: "Sooner",
      startTime: inDays(1),
      createdByProfileId: OTHER,
    });
    yield* upsertRsvp(later.id, VIEWER, { status: "going" });
    yield* upsertRsvp(sooner.id, VIEWER, { status: "going" });

    const entries = yield* listMyCalendarEvents(VIEWER);
    expect(entries.map((e) => e.event.title)).toEqual(["Sooner", "Later"]);
    expect(entries.every((e) => e.myStatus === "going")).toBe(true);
    expect(entries.every((e) => e.isHost === false)).toBe(true);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("includes maybe RSVPs with myStatus 'maybe'", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Maybe",
      startTime: inDays(2),
      createdByProfileId: OTHER,
    });
    yield* upsertRsvp(event.id, VIEWER, { status: "maybe" });

    const entries = yield* listMyCalendarEvents(VIEWER);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.myStatus).toBe("maybe");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("includes hosted events without an RSVP row, flagged isHost", () =>
  Effect.gen(function* () {
    yield* seedEvent({ title: "Mine", startTime: inDays(2), createdByProfileId: VIEWER });

    const entries = yield* listMyCalendarEvents(VIEWER);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isHost).toBe(true);
    expect(entries[0]!.myStatus).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("excludes not_going and invited RSVPs when the viewer is not the host", () =>
  Effect.gen(function* () {
    const declined = yield* seedEvent({
      title: "Declined",
      startTime: inDays(2),
      createdByProfileId: OTHER,
    });
    const invited = yield* seedEvent({
      title: "Invited",
      startTime: inDays(2),
      createdByProfileId: OTHER,
    });
    yield* upsertRsvp(declined.id, VIEWER, { status: "not_going" });
    yield* seedRsvpRow(invited.id, VIEWER, "invited");

    const entries = yield* listMyCalendarEvents(VIEWER);
    expect(entries).toEqual([]);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("excludes cancelled events the viewer was going to", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Cancelled",
      startTime: inDays(2),
      status: "cancelled",
      createdByProfileId: OTHER,
    });
    yield* upsertRsvp(event.id, VIEWER, { status: "going" });

    const entries = yield* listMyCalendarEvents(VIEWER);
    expect(entries).toEqual([]);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("excludes past events", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Past",
      startTime: daysAgo(2),
      createdByProfileId: OTHER,
    });
    yield* upsertRsvp(event.id, VIEWER, { status: "going" });

    const entries = yield* listMyCalendarEvents(VIEWER);
    expect(entries).toEqual([]);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("returns a single entry when the viewer hosts AND RSVP'd their own event", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "My Own Party",
      startTime: inDays(2),
      createdByProfileId: VIEWER,
    });
    yield* upsertRsvp(event.id, VIEWER, { status: "going" });

    const entries = yield* listMyCalendarEvents(VIEWER);
    // Both UNION arms surface this row; dedupe collapses them while
    // preserving the attending row's myStatus.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.isHost).toBe(true);
    expect(entries[0]!.myStatus).toBe("going");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("clamps the result count to the requested limit", () =>
  Effect.gen(function* () {
    for (let i = 0; i < 3; i++) {
      const event = yield* seedEvent({
        title: `E${i}`,
        startTime: inDays(i + 1),
        createdByProfileId: OTHER,
      });
      yield* upsertRsvp(event.id, VIEWER, { status: "going" });
    }
    const entries = yield* listMyCalendarEvents(VIEWER, { limit: 2 });
    expect(entries).toHaveLength(2);
  }).pipe(Effect.provide(createTestLayer())),
);

// T-S5 — applyTransitions preserves row order, so the parallel myStatus
// array zips back by index. Interleave transitioning (already-started,
// stored "upcoming") and non-transitioning (future) events with different
// myStatus/isHost values and assert each returned entry's pairing.
it.effect("keeps myStatus/isHost paired to the right event when transitions interleave", () =>
  Effect.gen(function* () {
    const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();

    // Seeded out of start-time order on purpose so the merge sort + zip is
    // exercised, not just the insertion order.
    const upcomingGoing = yield* seedEvent({
      title: "Upcoming Going",
      startTime: inDays(1),
      createdByProfileId: OTHER,
    });
    const startedMaybe = yield* seedEvent({
      title: "Started Maybe",
      startTime: minutesAgo(2),
      createdByProfileId: OTHER,
    });
    const upcomingHosted = yield* seedEvent({
      title: "Upcoming Hosted",
      startTime: inDays(2),
      createdByProfileId: VIEWER,
    });
    const startedHosted = yield* seedEvent({
      title: "Started Hosted",
      startTime: minutesAgo(1),
      createdByProfileId: VIEWER,
    });
    yield* upsertRsvp(upcomingGoing.id, VIEWER, { status: "going" });
    yield* upsertRsvp(startedMaybe.id, VIEWER, { status: "maybe" });
    yield* upsertRsvp(upcomingHosted.id, VIEWER, { status: "going" });

    const entries = yield* listMyCalendarEvents(VIEWER);

    // Chronological order survives the transition pass.
    expect(entries.map((e) => e.event.id)).toEqual([
      startedMaybe.id,
      startedHosted.id,
      upcomingGoing.id,
      upcomingHosted.id,
    ]);

    // Each entry keeps ITS OWN myStatus/isHost — a shifted zip would swap
    // neighbours' values.
    const byId = new Map(entries.map((e) => [e.event.id, e]));
    expect(byId.get(startedMaybe.id)!.myStatus).toBe("maybe");
    expect(byId.get(startedMaybe.id)!.isHost).toBe(false);
    expect(byId.get(startedHosted.id)!.myStatus).toBeNull();
    expect(byId.get(startedHosted.id)!.isHost).toBe(true);
    expect(byId.get(upcomingGoing.id)!.myStatus).toBe("going");
    expect(byId.get(upcomingGoing.id)!.isHost).toBe(false);
    expect(byId.get(upcomingHosted.id)!.myStatus).toBe("going");
    expect(byId.get(upcomingHosted.id)!.isHost).toBe(true);

    // The started rows actually transitioned (upcoming → ongoing) while the
    // future rows did not — proving the mix was genuinely interleaved.
    expect(byId.get(startedMaybe.id)!.event.status).toBe("ongoing");
    expect(byId.get(startedHosted.id)!.event.status).toBe("ongoing");
    expect(byId.get(upcomingGoing.id)!.event.status).toBe("upcoming");
    expect(byId.get(upcomingHosted.id)!.event.status).toBe("upcoming");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("fails with DatabaseError when the underlying query errors", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(listMyCalendarEvents(VIEWER));
    expect(err._tag).toBe("DatabaseError");
  }).pipe(Effect.provide(noSchemaLayer())),
);
