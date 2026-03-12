import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createTestLayer } from "../helpers/db";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  listTodayEvents,
  updateEvent,
} from "../../src/services/events";

const FUTURE = "2030-06-01T10:00:00.000Z";
const PAST = "2020-01-01T10:00:00.000Z";

const provide = <A, E>(effect: Effect.Effect<A, E, any>) =>
  effect.pipe(Effect.provide(createTestLayer()));

it.effect("getEvent returns event", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "Concert", startTime: FUTURE });
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
      const events = yield* listEvents({ upcoming: "false" });
      expect(events).toEqual([]);
    }),
  ),
);

it.effect("listEvents returns future events by default", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Future", startTime: FUTURE });
      yield* createEvent({ title: "Past", startTime: PAST });
      const events = yield* listEvents({});
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Future");
    }),
  ),
);

it.effect("listEvents filters by status", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Upcoming Event", startTime: FUTURE });
      yield* createEvent({ title: "Ongoing Event", startTime: FUTURE, status: "ongoing" });
      const events = yield* listEvents({ upcoming: "false", status: "ongoing" });
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Ongoing Event");
    }),
  ),
);

it.effect("listEvents filters by category", () =>
  provide(
    Effect.gen(function* () {
      yield* createEvent({ title: "Music Event", startTime: FUTURE, category: "music" });
      yield* createEvent({ title: "Sports Event", startTime: FUTURE, category: "sports" });
      const events = yield* listEvents({ category: "music" });
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Music Event");
    }),
  ),
);

it.effect("listTodayEvents returns only today's events", () =>
  provide(
    Effect.gen(function* () {
      const now = new Date().toISOString();
      yield* createEvent({ title: "Today Event", startTime: now });
      yield* createEvent({ title: "Future Event", startTime: FUTURE });
      const events = yield* listTodayEvents;
      expect(events.length).toBe(1);
      expect(events[0]!.title).toBe("Today Event");
    }),
  ),
);

it.effect("createEvent returns event with evt_ prefix", () =>
  provide(
    Effect.gen(function* () {
      const event = yield* createEvent({ title: "Test", startTime: FUTURE });
      expect(event.id).toMatch(/^evt_/);
      expect(event.title).toBe("Test");
      expect(event.status).toBe("upcoming");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for missing title", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(createEvent({ startTime: FUTURE }));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for empty title", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(createEvent({ title: "", startTime: FUTURE }));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("createEvent fails with ValidationError for bad startTime", () =>
  provide(
    Effect.gen(function* () {
      const error = yield* Effect.flip(createEvent({ title: "Test", startTime: "not-a-date" }));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("updateEvent updates fields", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "Original", startTime: FUTURE });
      const updated = yield* updateEvent(created.id, { title: "Updated" });
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
      const created = yield* createEvent({ title: "Original", startTime: FUTURE });
      const error = yield* Effect.flip(updateEvent(created.id, { title: "" }));
      expect(error._tag).toBe("ValidationError");
    }),
  ),
);

it.effect("deleteEvent removes the event", () =>
  provide(
    Effect.gen(function* () {
      const created = yield* createEvent({ title: "To Delete", startTime: FUTURE });
      yield* deleteEvent(created.id);
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
