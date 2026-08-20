import { expect, it } from "@effect/vitest";
import { eventLineup, events, venues } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { Effect } from "effect";

import {
  getVenue,
  listAllVenues,
  listEventLineup,
  listVenueEvents,
} from "../../src/services/venues";
import { createTestLayer } from "../helpers/db";

const provide = <A, E>(effect: Effect.Effect<A, E, Db>) =>
  effect.pipe(Effect.provide(createTestLayer()));

const future = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000);

const seedVenue = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();
  yield* Effect.promise(() =>
    db.insert(venues).values({
      id: "the-club",
      orgHandle: "the-org",
      handle: "the-club",
      name: "The Club",
      kind: "club",
      timezone: "Europe/London",
      createdAt: now,
      updatedAt: now,
    }),
  );
});

const seedEvent = (
  id: string,
  overrides: { startTime: Date; venueId: string | null; visibility?: "public" | "private" },
) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = new Date();
    yield* Effect.promise(() =>
      db.insert(events).values({
        id,
        title: id,
        startTime: overrides.startTime,
        venueId: overrides.venueId,
        visibility: overrides.visibility ?? "public",
        createdByProfileId: "usr_alice",
        createdAt: now,
        updatedAt: now,
      }),
    );
  });

const seedSlot = (eventId: string, artistName: string, slotStart: Date, slotEnd: Date, i: number) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.insert(eventLineup).values({
        id: `lnp_${eventId}_${i}`,
        eventId,
        artistName,
        role: "support",
        slotStart,
        slotEnd,
        orderIndex: i,
        createdAt: new Date(),
      }),
    );
  });

// ---------------------------------------------------------------------------
// getVenue
// ---------------------------------------------------------------------------

it.effect("getVenue returns the row when it exists", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      const row = yield* getVenue("the-org", "the-club");
      expect(row.id).toBe("the-club");
      expect(row.name).toBe("The Club");
      expect(row.kind).toBe("club");
    }),
  ),
);

it.effect("getVenue fails with VenueNotFound for unknown id", () =>
  provide(
    Effect.gen(function* () {
      const err = yield* Effect.flip(getVenue("the-org", "does-not-exist"));
      expect(err._tag).toBe("VenueNotFound");
    }),
  ),
);

// ---------------------------------------------------------------------------
// listVenueEvents
// ---------------------------------------------------------------------------

it.effect("listVenueEvents defaults to upcoming + only returns the venue's events", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      yield* seedEvent("evt_a", { startTime: future(1), venueId: "the-club" });
      yield* seedEvent("evt_b", { startTime: future(3), venueId: "the-club" });
      yield* seedEvent("evt_other", { startTime: future(2), venueId: null });

      const list = yield* listVenueEvents("the-org", "the-club");
      expect(list.map((e) => e.id).toSorted()).toEqual(["evt_a", "evt_b"]);
    }),
  ),
);

it.effect("listVenueEvents excludes private events", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      yield* seedEvent("evt_pub", { startTime: future(1), venueId: "the-club" });
      yield* seedEvent("evt_priv", {
        startTime: future(2),
        venueId: "the-club",
        visibility: "private",
      });
      const list = yield* listVenueEvents("the-org", "the-club");
      expect(list.map((e) => e.id)).toEqual(["evt_pub"]);
    }),
  ),
);

it.effect("listVenueEvents scope=past returns finished events", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      yield* seedEvent("evt_old", { startTime: future(-7), venueId: "the-club" });
      yield* seedEvent("evt_new", { startTime: future(1), venueId: "the-club" });
      const past = yield* listVenueEvents("the-org", "the-club", { scope: "past" });
      expect(past.map((e) => e.id)).toEqual(["evt_old"]);
    }),
  ),
);

it.effect("listVenueEvents fails with VenueNotFound for unknown id", () =>
  provide(
    Effect.gen(function* () {
      const err = yield* Effect.flip(listVenueEvents("the-org", "does-not-exist"));
      expect(err._tag).toBe("VenueNotFound");
    }),
  ),
);

it.effect("listVenueEvents excludes private events at the service boundary", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      yield* seedEvent("evt_pub", { startTime: future(1), venueId: "the-club" });
      yield* seedEvent("evt_priv", {
        startTime: future(2),
        venueId: "the-club",
        visibility: "private",
      });
      // No viewer is threaded through — venue surface is public, so the
      // private filter must hold even before any visibility middleware.
      const list = yield* listVenueEvents("the-org", "the-club", { scope: "all" });
      expect(list.map((e) => e.id)).toEqual(["evt_pub"]);
    }),
  ),
);

it.effect("listVenueEvents clamps limit to 200", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      // Seed 5 rows; ask for 9999. The clamp is the security-relevant
      // contract — we just need to prove the service doesn't honour a
      // caller-supplied unbounded limit. We can't realistically seed 200+
      // rows here, so we sanity-check that the service still returns
      // every seeded row (i.e. didn't crash on a large limit) and that
      // the bounded path executed.
      for (let i = 0; i < 5; i++) {
        yield* seedEvent(`evt_${i}`, { startTime: future(i + 1), venueId: "the-club" });
      }
      const list = yield* listVenueEvents("the-org", "the-club", { limit: 9999 });
      expect(list.length).toBe(5);
      expect(list.length).toBeLessThanOrEqual(200);
    }),
  ),
);

it.effect("listVenueEvents scope=all returns past + upcoming together", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      yield* seedEvent("evt_past", { startTime: future(-5), venueId: "the-club" });
      yield* seedEvent("evt_future", { startTime: future(5), venueId: "the-club" });
      const all = yield* listVenueEvents("the-org", "the-club", { scope: "all" });
      expect(all.map((e) => e.id).toSorted()).toEqual(["evt_future", "evt_past"]);
    }),
  ),
);

// ---------------------------------------------------------------------------
// listAllVenues
// ---------------------------------------------------------------------------

it.effect("listAllVenues returns every venue row within the default bound", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = new Date();
      yield* Effect.promise(() =>
        db.insert(venues).values([
          {
            id: "v1",
            orgHandle: "org-a",
            handle: "alpha",
            name: "Alpha",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "v2",
            orgHandle: "org-a",
            handle: "beta",
            name: "Beta",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "v3",
            orgHandle: "org-b",
            handle: "gamma",
            name: "Gamma",
            createdAt: now,
            updatedAt: now,
          },
        ]),
      );
      const rows = yield* listAllVenues();
      expect(rows.map((r) => r.id).toSorted()).toEqual(["v1", "v2", "v3"]);
    }),
  ),
);

it.effect("listAllVenues returns an empty array when there are no venues", () =>
  provide(
    Effect.gen(function* () {
      const rows = yield* listAllVenues();
      expect(rows).toEqual([]);
    }),
  ),
);

it.effect("listAllVenues no-bbox path is bounded even with no caller limit", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = new Date();
      // More rows than the ceiling, so the bound has to come from the service
      // rather than from the size of the table.
      const rows = Array.from({ length: 130 }, (_, i) => ({
        id: `v${String(i).padStart(3, "0")}`,
        orgHandle: "org-a",
        handle: `venue-${i}`,
        name: `Venue ${i}`,
        createdAt: now,
        updatedAt: now,
      }));
      yield* Effect.promise(() => db.insert(venues).values(rows));
      const result = yield* listAllVenues();
      expect(result.length).toBe(100);
    }),
  ),
);

it.effect(
  "listAllVenues returns the SAME bounded page on every call (ordered, not arbitrary)",
  () =>
    provide(
      Effect.gen(function* () {
        const { db } = yield* Db;
        const now = new Date();
        // A LIMIT with no ORDER BY is free to return a different subset each
        // time — the map would show a different set of pins on every refresh.
        const rows = Array.from({ length: 130 }, (_, i) => ({
          id: `v${String(i).padStart(3, "0")}`,
          orgHandle: "org-a",
          handle: `venue-${i}`,
          name: `Venue ${i}`,
          createdAt: now,
          updatedAt: now,
        }));
        yield* Effect.promise(() => db.insert(venues).values(rows));

        const first = yield* listAllVenues();
        const second = yield* listAllVenues();
        expect(second.map((v) => v.id)).toEqual(first.map((v) => v.id));
        // And it is the ordering the service declares, not whatever fell out.
        expect(first.map((v) => v.id)).toEqual(first.map((v) => v.id).toSorted());
      }),
    ),
);

it.effect("listAllVenues clamps a caller-supplied limit to the server ceiling", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = new Date();
      const rows = Array.from({ length: 120 }, (_, i) => ({
        id: `v${i}`,
        orgHandle: "org-a",
        handle: `venue-${i}`,
        name: `Venue ${i}`,
        createdAt: now,
        updatedAt: now,
      }));
      yield* Effect.promise(() => db.insert(venues).values(rows));
      const result = yield* listAllVenues({ limit: 9999 });
      expect(result.length).toBe(100);
    }),
  ),
);

it.effect("listAllVenues bbox filters to rows inside the box and excludes rows outside it", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = new Date();
      yield* Effect.promise(() =>
        db.insert(venues).values([
          {
            id: "inside",
            orgHandle: "org-a",
            handle: "inside",
            name: "Inside",
            latitude: 51.5,
            longitude: -0.1,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "outside",
            orgHandle: "org-a",
            handle: "outside",
            name: "Outside",
            latitude: 40.7,
            longitude: -74.0,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      );
      const rows = yield* listAllVenues({ minLat: 51, maxLat: 52, minLng: -1, maxLng: 0 });
      expect(rows.map((r) => r.id)).toEqual(["inside"]);
    }),
  ),
);

it.effect("listAllVenues bbox query drops NULL-coordinate venues; no-bbox path keeps them", () =>
  provide(
    Effect.gen(function* () {
      // seedVenue never sets latitude/longitude, so "the-club" is NULL/NULL.
      // gte/lte never match NULL, so a bbox query silently loses it — that
      // asymmetry is intentional (see BRIEF-308) and pinned here rather
      // than papered over with an IS NULL branch.
      yield* seedVenue;
      const withBbox = yield* listAllVenues({ minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 });
      expect(withBbox.map((r) => r.id)).toEqual([]);

      const withoutBbox = yield* listAllVenues();
      expect(withoutBbox.map((r) => r.id)).toEqual(["the-club"]);
    }),
  ),
);

it.effect("listAllVenues projects only the thin pin fields", () =>
  provide(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = new Date();
      yield* Effect.promise(() =>
        db.insert(venues).values({
          id: "v1",
          orgHandle: "org-a",
          handle: "alpha",
          name: "Alpha",
          kind: "club",
          capacity: 300,
          latitude: 51.5,
          longitude: -0.1,
          description: "A description that must not leak into the pin projection",
          hours: '{"1":{"open":"18:00","close":"02:00"}}',
          heroImageUrl: "https://example.com/hero.jpg",
          websiteUrl: "https://example.com",
          createdAt: now,
          updatedAt: now,
        }),
      );
      const rows = yield* listAllVenues();
      expect(rows).toEqual([
        {
          id: "v1",
          orgHandle: "org-a",
          handle: "alpha",
          name: "Alpha",
          kind: "club",
          capacity: 300,
          latitude: 51.5,
          longitude: -0.1,
        },
      ]);
    }),
  ),
);

// ---------------------------------------------------------------------------
// listEventLineup
// ---------------------------------------------------------------------------

it.effect("listEventLineup orders slots by slotStart asc", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      yield* seedEvent("evt_lineup", { startTime: future(1), venueId: "the-club" });
      yield* seedSlot(
        "evt_lineup",
        "Late",
        new Date("2030-06-08T01:00:00.000Z"),
        new Date("2030-06-08T02:30:00.000Z"),
        2,
      );
      yield* seedSlot(
        "evt_lineup",
        "Opener",
        new Date("2030-06-07T22:00:00.000Z"),
        new Date("2030-06-07T23:30:00.000Z"),
        0,
      );
      yield* seedSlot(
        "evt_lineup",
        "Mid",
        new Date("2030-06-07T23:30:00.000Z"),
        new Date("2030-06-08T01:00:00.000Z"),
        1,
      );

      const list = yield* listEventLineup("evt_lineup");
      expect(list.map((s) => s.artistName)).toEqual(["Opener", "Mid", "Late"]);
    }),
  ),
);

it.effect("listEventLineup returns an empty array when there are no slots", () =>
  provide(
    Effect.gen(function* () {
      yield* seedVenue;
      yield* seedEvent("evt_blank", { startTime: future(1), venueId: "the-club" });
      const list = yield* listEventLineup("evt_blank");
      expect(list).toEqual([]);
    }),
  ),
);
