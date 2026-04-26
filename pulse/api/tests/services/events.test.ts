import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import * as metrics from "../../src/metrics";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  listTodayEvents,
  updateEvent,
} from "../../src/services/events";
import { createTestLayer, seedCloseFriend, seedEvent } from "../helpers/db";

const FUTURE = "2030-06-01T10:00:00.000Z";
const PAST = "2020-01-01T10:00:00.000Z";
const STARTED = new Date(Date.now() - 60_000).toISOString();
const ENDED = new Date(Date.now() - 30_000).toISOString();

const ALICE = { createdByProfileId: "usr_alice", createdByName: "Alice", createdByAvatar: null };

const provide = <A, E>(effect: Effect.Effect<A, E, any>) =>
  effect.pipe(Effect.provide(createTestLayer()));

it.effect("getEvent returns event", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "Concert", startTime: FUTURE }, ALICE);
      const fetched = yield* getEvent(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe("Concert");
    }),
  ),
);

it.effect("getEvent fails with EventNotFound for unknown id", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(getEvent("nonexistent"));
      expect(error._tag).toBe("EventNotFound");
    }),
  ),
);

it.effect("listEvents returns empty list when no events", () =>
  provide(
    Effect.gen(function* () {
      const events = yield* listEvents({});
      expect(events).toEqual([]);
    }),
  ),
);

it.effect("listEvents returns all events regardless of time", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Future", startTime: FUTURE }, ALICE);
      yield* seedEvent({ title: "Past", startTime: PAST });
      const events = yield* listEvents({});
      expect(events.length).toBe(2);
    }),
  ),
);

it.effect("listEvents filters by status", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Upcoming Event", startTime: FUTURE }, ALICE);
      yield* seedEvent({ title: "Ongoing Event", startTime: STARTED, status: "ongoing" });
      const events = yield* listEvents({ status: "ongoing" });
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Ongoing Event");
    }),
  ),
);

it.effect("listEvents filters by category", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Music Event", startTime: FUTURE, category: "music" }, ALICE);
      yield* createEvent({ title: "Sports Event", startTime: FUTURE, category: "sports" }, ALICE);
      const events = yield* listEvents({ category: "music" });
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Music Event");
    }),
  ),
);

it.effect("listEvents boosts events organised by close friends to the top", () =>
  provide(
    Effect.gen(function* () {
      // Stranger's event is earliest by startTime (would normally come first).
      yield* seedEvent({
        title: "Stranger's Show",
        startTime: "2030-06-01T10:00:00.000Z",
        createdByProfileId: "usr_stranger",
      });
      // Close-friend's event is later by startTime; should be boosted above.
      yield* seedEvent({
        title: "Friend's Party",
        startTime: "2030-06-02T10:00:00.000Z",
        createdByProfileId: "usr_friend",
      });
      yield* seedCloseFriend("usr_alice", "usr_friend");

      const events = yield* listEvents({ viewerId: "usr_alice" });
      expect(events.length).toBe(2);
      expect(events[0]!.title).toBe("Friend's Party");
      expect(events[1]!.title).toBe("Stranger's Show");
    }),
  ),
);

it.effect("listEvents preserves chronological order when no close friends are set", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({
        title: "Earlier",
        startTime: "2030-06-01T10:00:00.000Z",
        createdByProfileId: "usr_anyone",
      });
      yield* seedEvent({
        title: "Later",
        startTime: "2030-06-02T10:00:00.000Z",
        createdByProfileId: "usr_other",
      });
      const events = yield* listEvents({ viewerId: "usr_alice" });
      expect(events.map((e) => e.title)).toEqual(["Earlier", "Later"]);
    }),
  ),
);

it.effect("listEvents does not boost for anonymous viewers", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({
        title: "Stranger",
        startTime: "2030-06-01T10:00:00.000Z",
        createdByProfileId: "usr_stranger",
      });
      yield* seedEvent({
        title: "Friend",
        startTime: "2030-06-02T10:00:00.000Z",
        createdByProfileId: "usr_friend",
      });
      // The seed exists but the viewer is anonymous — order stays chronological.
      yield* seedCloseFriend("usr_alice", "usr_friend");
      const events = yield* listEvents({});
      expect(events.map((e) => e.title)).toEqual(["Stranger", "Friend"]);
    }),
  ),
);

it.effect("listTodayEvents returns only today's events", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({ title: "Today Event", startTime: new Date() });
      yield* createEvent({ title: "Future Event", startTime: FUTURE }, ALICE);
      const events = yield* listTodayEvents;
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Today Event");
    }),
  ),
);

it.effect("createEvent returns event with evt_ prefix", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent({ title: "Test", startTime: FUTURE }, ALICE);
      expect(event.id).toMatch(/^evt_/);
      expect(event.title).toBe("Test");
      expect(event.status).toBe("upcoming");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for missing title", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(createEvent({ startTime: FUTURE }, ALICE));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for empty title", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(createEvent({ title: "", startTime: FUTURE }, ALICE));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for past startTime", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(createEvent({ title: "Test", startTime: PAST }, ALICE));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for startTime equal to now", () =>
  provide(
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const error = yield* Effect.flip(createEvent({ title: "Test", startTime: now }, ALICE));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent accepts endTime exactly at MAX_EVENT_DURATION_HOURS", () =>
  provide(
    Effect.gen(function* () {
      const start = new Date("2030-06-01T10:00:00.000Z");
      const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
      const event = yield* createEvent(
        { title: "Weekend party", startTime: start.toISOString(), endTime: end.toISOString() },
        ALICE,
      );
      expect(event.endTime).toEqual(end);
    }),
  ),
);

it.effect(
  "createEvent fails with ValidationError when duration exceeds MAX_EVENT_DURATION_HOURS",
  () =>
    provide(
      Effect.gen(function* () {
        const start = new Date("2030-06-01T10:00:00.000Z");
        const end = new Date(start.getTime() + 48 * 60 * 60 * 1000 + 60 * 1000);
        const error = yield* Effect.flip(
          createEvent(
            { title: "Too long", startTime: start.toISOString(), endTime: end.toISOString() },
            ALICE,
          ),
        );
        expect(error._tag).toBe("ValidationError");
      }),
    ),
);

it.effect("createEvent emits duration_exceeds_max validation-failure metric", () =>
  provide(
    Effect.gen(function* () {
      const spy = vi.spyOn(metrics, "metricEventValidationFailure");
      const start = new Date("2030-06-01T10:00:00.000Z");
      const end = new Date(start.getTime() + 49 * 60 * 60 * 1000);
      yield* Effect.flip(
        createEvent(
          { title: "Too long", startTime: start.toISOString(), endTime: end.toISOString() },
          ALICE,
        ),
      );
      expect(spy).toHaveBeenCalledWith("create", "duration_exceeds_max");
      spy.mockRestore();
    }),
  ),
);

it.effect("updateEvent emits duration_exceeds_max validation-failure metric", () =>
  provide(
    Effect.gen(function* () {
      const start = new Date("2030-06-01T10:00:00.000Z");
      const created = yield* createEvent(
        { title: "Dinner", startTime: start.toISOString() },
        ALICE,
      );
      const spy = vi.spyOn(metrics, "metricEventValidationFailure");
      const tooFar = new Date(start.getTime() + 49 * 60 * 60 * 1000).toISOString();
      yield* Effect.flip(updateEvent(created.id, { endTime: tooFar }, "usr_alice"));
      expect(spy).toHaveBeenCalledWith("update", "duration_exceeds_max");
      spy.mockRestore();
    }),
  ),
);

it.effect("updateEvent rejects endTime-only patch that pushes duration over cap", () =>
  provide(
    Effect.gen(function* () {
      const start = new Date("2030-06-01T10:00:00.000Z");
      const created = yield* createEvent(
        { title: "Dinner", startTime: start.toISOString() },
        ALICE,
      );
      const tooFar = new Date(start.getTime() + 49 * 60 * 60 * 1000).toISOString();
      const error = yield* Effect.flip(updateEvent(created.id, { endTime: tooFar }, "usr_alice"));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("updateEvent rejects startTime-only patch that pushes duration over cap", () =>
  provide(
    Effect.gen(function* () {
      // Seed an existing event with an explicit endTime 2h after startTime.
      const start = new Date("2030-06-01T10:00:00.000Z");
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      const created = yield* createEvent(
        { title: "Dinner", startTime: start.toISOString(), endTime: end.toISOString() },
        ALICE,
      );
      // Patching only startTime 49h earlier makes the effective duration 51h.
      const muchEarlier = new Date(start.getTime() - 49 * 60 * 60 * 1000).toISOString();
      const error = yield* Effect.flip(
        updateEvent(created.id, { startTime: muchEarlier }, "usr_alice"),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect(
  "updateEvent accepts endTime moved to exactly MAX_EVENT_DURATION_HOURS past startTime",
  () =>
    provide(
      Effect.gen(function* () {
        const start = new Date("2030-06-01T10:00:00.000Z");
        const created = yield* createEvent(
          { title: "Dinner", startTime: start.toISOString() },
          ALICE,
        );
        const atCap = new Date(start.getTime() + 48 * 60 * 60 * 1000).toISOString();
        const updated = yield* updateEvent(created.id, { endTime: atCap }, "usr_alice");
        expect(updated.endTime?.toISOString()).toBe(atCap);
      }),
    ),
);

it.effect("getEvent finishes events whose explicit endTime has passed", () =>
  provide(
    Effect.gen(function* () {
      const startedAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      const endedAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const seeded = yield* seedEvent({
        title: "Already over",
        startTime: startedAgo,
        endTime: endedAgo,
        status: "ongoing",
      });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("finished");
    }),
  ),
);

it.effect("getEvent marks no-endTime events maybe_finished between 8h and 12h past startTime", () =>
  provide(
    Effect.gen(function* () {
      const ninehAgo = new Date(Date.now() - 9 * 60 * 60 * 1000);
      const seeded = yield* seedEvent({
        title: "Soft grace",
        startTime: ninehAgo,
        status: "ongoing",
      });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("maybe_finished");
    }),
  ),
);

it.effect("maybe_finished is display-only — the DB row stays 'ongoing'", () =>
  provide(
    Effect.gen(function* () {
      const ninehAgo = new Date(Date.now() - 9 * 60 * 60 * 1000);
      const seeded = yield* seedEvent({
        title: "Not persisted",
        startTime: ninehAgo,
        status: "ongoing",
      });
      // First read projects maybe_finished in-memory.
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("maybe_finished");
      // But the DB row still says ongoing — a direct SELECT via a second
      // getEvent re-derives from the stored ongoing row, not a persisted
      // maybe_finished one. Count status_transitions: none should fire
      // for maybe_finished (only ongoing → finished at 12h is persisted).
      const spy = vi.spyOn(metrics, "metricEventStatusTransition");
      const refetched = yield* getEvent(seeded.id);
      expect(refetched.status).toBe("maybe_finished");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }),
  ),
);

it.effect("getEvent auto-finishes no-endTime events after AUTO_CLOSE_NO_END_TIME_HOURS", () =>
  provide(
    Effect.gen(function* () {
      const longAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
      const seeded = yield* seedEvent({
        title: "Stale ongoing",
        startTime: longAgo,
        status: "ongoing",
      });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("finished");
    }),
  ),
);

it.effect("getEvent keeps no-endTime events ongoing before MAYBE_FINISHED_AFTER_HOURS", () =>
  provide(
    Effect.gen(function* () {
      const recent = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const seeded = yield* seedEvent({
        title: "Fresh ongoing",
        startTime: recent,
        status: "ongoing",
      });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("ongoing");
    }),
  ),
);

it.effect("organiser can manually mark a maybe_finished event as finished", () =>
  provide(
    Effect.gen(function* () {
      const ninehAgo = new Date(Date.now() - 9 * 60 * 60 * 1000);
      const seeded = yield* seedEvent({
        title: "Organiser closes early",
        startTime: ninehAgo,
        status: "maybe_finished",
      });
      const updated = yield* updateEvent(
        seeded.id,
        { status: "finished" },
        seeded.createdByProfileId,
      );
      expect(updated.status).toBe("finished");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for bad startTime", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createEvent({ title: "Test", startTime: "not-a-date" }, ALICE),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for invalid imageUrl", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createEvent({ title: "Test", startTime: FUTURE, imageUrl: "not-a-url" }, ALICE),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent accepts valid imageUrl", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        {
          title: "Test",
          startTime: FUTURE,
          imageUrl: "https://example.com/image.jpg",
        },
        ALICE,
      );
      expect(event.imageUrl).toBe("https://example.com/image.jpg");
    }),
  ),
);

it.effect("updateEvent updates fields", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "Original", startTime: FUTURE }, ALICE);
      const updated = yield* updateEvent(created.id, { title: "Updated" }, "usr_alice");
      expect(updated.title).toBe("Updated");
      expect(updated.startTime).toEqual(created.startTime);
    }),
  ),
);

it.effect("updateEvent fails with EventNotFound for unknown id", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(updateEvent("nonexistent", { title: "Updated" }));
      expect(error._tag).toBe("EventNotFound");
    }),
  ),
);

it.effect("updateEvent fails with ValidationError for empty title", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "Original", startTime: FUTURE }, ALICE);
      const error = yield* Effect.flip(updateEvent(created.id, { title: "" }, "usr_alice"));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("updateEvent fails with ValidationError for invalid imageUrl", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "Original", startTime: FUTURE }, ALICE);
      const error = yield* Effect.flip(
        updateEvent(created.id, { imageUrl: "not-a-url" }, "usr_alice"),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("deleteEvent removes the event", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "To Delete", startTime: FUTURE }, ALICE);
      yield* deleteEvent(created.id, "usr_alice");
      const error = yield* Effect.flip(getEvent(created.id));
      expect(error._tag).toBe("EventNotFound");
    }),
  ),
);

it.effect("deleteEvent fails with EventNotFound for unknown id", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(deleteEvent("nonexistent"));
      expect(error._tag).toBe("EventNotFound");
    }),
  ),
);

// ── Ownership ────────────────────────────────────────────────────────────────

it.effect("createEvent stores createdByProfileId, createdByName, createdByAvatar", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        { title: "Owned", startTime: FUTURE },
        { createdByProfileId: "usr_alice", createdByName: "Alice", createdByAvatar: null },
      );
      expect(event.createdByProfileId).toBe("usr_alice");
      expect(event.createdByName).toBe("Alice");
      expect(event.createdByAvatar).toBeNull();
    }),
  ),
);

it.effect("deleteEvent succeeds when requestingProfileId matches createdByProfileId", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        { title: "Mine", startTime: FUTURE },
        { createdByProfileId: "usr_alice", createdByName: "Alice", createdByAvatar: null },
      );
      yield* deleteEvent(event.id, "usr_alice");
      const error = yield* Effect.flip(getEvent(event.id));
      expect(error._tag).toBe("EventNotFound");
    }),
  ),
);

it.effect("deleteEvent fails with NotEventOwner when requestingProfileId does not match", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        { title: "Not Mine", startTime: FUTURE },
        { createdByProfileId: "usr_alice", createdByName: "Alice", createdByAvatar: null },
      );
      const error = yield* Effect.flip(deleteEvent(event.id, "usr_bob"));
      expect(error._tag).toBe("NotEventOwner");
    }),
  ),
);

it.effect("deleteEvent fails with NotEventOwner when no requestingProfileId provided", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent({ title: "Mine", startTime: FUTURE }, ALICE);
      const error = yield* Effect.flip(deleteEvent(event.id));
      expect(error._tag).toBe("NotEventOwner");
    }),
  ),
);

it.effect("updateEvent fails with NotEventOwner when requestingProfileId does not match", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        { title: "Not Mine", startTime: FUTURE },
        { createdByProfileId: "usr_alice", createdByName: "Alice", createdByAvatar: null },
      );
      const error = yield* Effect.flip(updateEvent(event.id, { title: "Hijacked" }, "usr_bob"));
      expect(error._tag).toBe("NotEventOwner");
    }),
  ),
);

it.effect("updateEvent succeeds when requestingProfileId matches createdByProfileId", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        { title: "Mine", startTime: FUTURE },
        { createdByProfileId: "usr_alice", createdByName: "Alice", createdByAvatar: null },
      );
      const updated = yield* updateEvent(event.id, { title: "Updated" }, "usr_alice");
      expect(updated.title).toBe("Updated");
    }),
  ),
);

it.effect("getEvent auto-transitions upcoming → ongoing when startTime passed", () =>
  provide(
    Effect.gen(function* () {
      const seeded = yield* seedEvent({ title: "Started", startTime: STARTED });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("ongoing");
    }),
  ),
);

it.effect("getEvent auto-transitions to finished when endTime passed", () =>
  provide(
    Effect.gen(function* () {
      const seeded = yield* seedEvent({
        title: "Ended",
        startTime: STARTED,
        endTime: ENDED,
      });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("finished");
    }),
  ),
);

it.effect("getEvent does not transition cancelled events", () =>
  provide(
    Effect.gen(function* () {
      const seeded = yield* seedEvent({
        title: "Cancelled",
        startTime: STARTED,
        status: "cancelled",
      });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("cancelled");
    }),
  ),
);

it.effect("getEvent does not transition finished events", () =>
  provide(
    Effect.gen(function* () {
      const seeded = yield* seedEvent({
        title: "Finished",
        startTime: STARTED,
        status: "finished",
      });
      const fetched = yield* getEvent(seeded.id);
      expect(fetched.status).toBe("finished");
    }),
  ),
);

it.effect("listEvents returns transitioned statuses", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({ title: "Started", startTime: STARTED });
      const results = yield* listEvents({});
      const started = results.find((e) => e.title === "Started");
      expect(started?.status).toBe("ongoing");
    }),
  ),
);

it.effect("listTodayEvents returns transitioned statuses", () =>
  provide(
    Effect.gen(function* () {
      yield* seedEvent({ title: "Today Started", startTime: STARTED });
      const results = yield* listTodayEvents;
      const started = results.find((e) => e.title === "Today Started");
      expect(started?.status).toBe("ongoing");
    }),
  ),
);

it.effect("listEvents respects limit param", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Event 1", startTime: FUTURE }, ALICE);
      yield* createEvent({ title: "Event 2", startTime: FUTURE }, ALICE);
      yield* createEvent({ title: "Event 3", startTime: FUTURE }, ALICE);
      const events = yield* listEvents({ limit: "2" });
      expect(events.length).toBe(2);
    }),
  ),
);

it.effect("createEvent fails with ValidationError for invalid status", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createEvent({ title: "Test", startTime: FUTURE, status: "invalid" }, ALICE),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("updateEvent fails with ValidationError for invalid status", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "Original", startTime: FUTURE }, ALICE);
      const error = yield* Effect.flip(updateEvent(created.id, { status: "invalid" }, "usr_alice"));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

// ── Discovery visibility filter ──────────────────────────────────────────────
//
// listEvents now hides `visibility = "private"` events from non-owners and
// from unauthenticated callers. The viewer's own private events stay visible
// so they can manage them. The route layer (events.new.test.ts) covers the
// HTTP surface; these cases pin the invariant at the service layer so the
// authorization check can't silently regress during a refactor.

it.effect("listEvents hides private events from unauthenticated callers", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Public", startTime: FUTURE }, ALICE);
      yield* createEvent({ title: "Private", startTime: FUTURE, visibility: "private" }, ALICE);
      const events = yield* listEvents({});
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Public");
    }),
  ),
);

it.effect("listEvents hides private events from non-owner viewers", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Public", startTime: FUTURE }, ALICE);
      yield* createEvent(
        { title: "Alice's private", startTime: FUTURE, visibility: "private" },
        ALICE,
      );
      const events = yield* listEvents({ viewerId: "usr_bob" });
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Public");
    }),
  ),
);

it.effect("listEvents shows private events to their own creator", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Public", startTime: FUTURE }, ALICE);
      yield* createEvent(
        { title: "Alice's private", startTime: FUTURE, visibility: "private" },
        ALICE,
      );
      const events = yield* listEvents({ viewerId: "usr_alice" });
      expect(events.length).toBe(2);
      expect(events.map((e) => e.title).toSorted()).toEqual(["Alice's private", "Public"]);
    }),
  ),
);

// ---------------------------------------------------------------------------
// Price fields
// ---------------------------------------------------------------------------

it.effect("createEvent stores price as minor units (USD 18.50 → 1850)", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        { title: "Paid", startTime: FUTURE, priceAmount: 18.5, priceCurrency: "USD" },
        ALICE,
      );
      expect(event.priceAmount).toBe(1850);
      expect(event.priceCurrency).toBe("USD");
    }),
  ),
);

it.effect("createEvent stores JPY as minor units at 0 exponent (¥500 → 500)", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent(
        { title: "Yen", startTime: FUTURE, priceAmount: 500, priceCurrency: "JPY" },
        ALICE,
      );
      expect(event.priceAmount).toBe(500);
      expect(event.priceCurrency).toBe("JPY");
    }),
  ),
);

it.effect("createEvent leaves price null when omitted", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent({ title: "Free", startTime: FUTURE }, ALICE);
      expect(event.priceAmount).toBeNull();
      expect(event.priceCurrency).toBeNull();
    }),
  ),
);

it.effect("createEvent rejects priceAmount > 99999.99", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createEvent(
          { title: "Too pricey", startTime: FUTURE, priceAmount: 100000, priceCurrency: "USD" },
          ALICE,
        ),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent rejects priceAmount without priceCurrency", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createEvent({ title: "Dangling price", startTime: FUTURE, priceAmount: 10 }, ALICE),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent rejects priceCurrency without priceAmount", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createEvent({ title: "Dangling currency", startTime: FUTURE, priceCurrency: "USD" }, ALICE),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent rejects unsupported currency", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        createEvent(
          { title: "Bad ccy", startTime: FUTURE, priceAmount: 10, priceCurrency: "XYZ" },
          ALICE,
        ),
      );
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("updateEvent clears price when both fields set to null", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent(
        { title: "Paid", startTime: FUTURE, priceAmount: 10, priceCurrency: "USD" },
        ALICE,
      );
      const updated = yield* updateEvent(
        created.id,
        { priceAmount: null, priceCurrency: null },
        "usr_alice",
      );
      expect(updated.priceAmount).toBeNull();
      expect(updated.priceCurrency).toBeNull();
    }),
  ),
);

it.effect("updateEvent leaves price unchanged when fields omitted", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent(
        { title: "Paid", startTime: FUTURE, priceAmount: 10, priceCurrency: "USD" },
        ALICE,
      );
      const updated = yield* updateEvent(created.id, { title: "Still paid" }, "usr_alice");
      expect(updated.priceAmount).toBe(1000);
      expect(updated.priceCurrency).toBe("USD");
    }),
  ),
);
