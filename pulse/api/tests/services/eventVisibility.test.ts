import { expect, it } from "@effect/vitest";
import { events, eventRsvps } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { buildVisibilityFilter } from "../../src/services/eventVisibility";
import { createTestLayer, seedEvent } from "../helpers/db";

const FUTURE = (ms: number) => new Date(Date.now() + ms).toISOString();

const provide = <A, E>(effect: Effect.Effect<A, E, Db>) =>
  effect.pipe(Effect.provide(createTestLayer()));

const selectVisible = (viewerId: string | null) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return yield* Effect.promise(() =>
      db.select().from(events).where(buildVisibilityFilter(viewerId)),
    );
  });

const insertRsvp = (eventId: string, profileId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.insert(eventRsvps).values({
        id: `rsvp_${eventId}_${profileId}`,
        eventId,
        profileId,
        status: "going",
        createdAt: new Date(),
      }),
    );
  });

it.effect("anonymous viewer sees public events only", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({ title: "Public", startTime: FUTURE(60_000), visibility: "public" });
      yield* seedEvent({
        title: "Private",
        startTime: FUTURE(60_000),
        visibility: "private",
        createdByProfileId: "usr_alice",
      });
      const rows = yield* selectVisible(null);
      expect(rows.map((r) => r.title)).toEqual(["Public"]);
    }),
  ),
);

it.effect("authenticated viewer sees own private events", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({
        title: "Mine",
        startTime: FUTURE(60_000),
        visibility: "private",
        createdByProfileId: "usr_alice",
      });
      yield* seedEvent({
        title: "Other",
        startTime: FUTURE(60_000),
        visibility: "private",
        createdByProfileId: "usr_bob",
      });
      const rows = yield* selectVisible("usr_alice");
      expect(rows.map((r) => r.title).toSorted()).toEqual(["Mine"]);
    }),
  ),
);

it.effect("authenticated viewer sees private events they have an RSVP row on", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* seedEvent({
        title: "Invited",
        startTime: FUTURE(60_000),
        visibility: "private",
        createdByProfileId: "usr_alice",
      });
      yield* insertRsvp(event.id, "usr_bob");
      const rows = yield* selectVisible("usr_bob");
      expect(rows.map((r) => r.title)).toEqual(["Invited"]);
    }),
  ),
);

it.effect("predicate is composable with additional WHERE filters", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({ title: "Music", startTime: FUTURE(60_000), category: "music" });
      yield* seedEvent({ title: "Sports", startTime: FUTURE(60_000), category: "sports" });
      const { db } = yield* Db;
      const rows = yield* Effect.promise(() =>
        db
          .select()
          .from(events)
          .where(and(buildVisibilityFilter(null), eq(events.category, "music"))),
      );
      expect(rows.map((r) => r.title)).toEqual(["Music"]);
    }),
  ),
);

it.effect("authenticated viewer with no RSVP and not the organiser sees only public events", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({ title: "Public", startTime: FUTURE(60_000) });
      yield* seedEvent({
        title: "Strangers only",
        startTime: FUTURE(60_000),
        visibility: "private",
        createdByProfileId: "usr_alice",
      });
      const rows = yield* selectVisible("usr_outsider");
      expect(rows.map((r) => r.title)).toEqual(["Public"]);
    }),
  ),
);
