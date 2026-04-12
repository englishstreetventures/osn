import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { canViewEvent, loadVisibleEvent } from "../../src/services/eventAccess";
import { upsertRsvp } from "../../src/services/rsvps";
import { createTestLayer, seedEvent } from "../helpers/db";

// canViewEvent and loadVisibleEvent are the single source of truth for
// "is this viewer allowed to see this event?". The discovery feed
// (`listEvents`) and every direct-fetch route (`/events/:id`, `/ics`,
// `/comms`, `/rsvps[/counts/latest]`) MUST agree, or private events
// become bypassable by direct ID. These tests pin the rule at the
// service layer so a refactor can't silently desync the routes.

const FUTURE = "2030-06-01T10:00:00.000Z";
const provide = <A, E>(eff: Effect.Effect<A, E, never>) => eff;

it.effect("canViewEvent returns true for public events to anyone", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Public", startTime: FUTURE, visibility: "public" });
    expect(yield* canViewEvent(event, null)).toBe(true);
    expect(yield* canViewEvent(event, "usr_random")).toBe(true);
  }).pipe(Effect.provide(createTestLayer()), provide),
);

it.effect("canViewEvent hides private events from unauthenticated callers", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: FUTURE,
      visibility: "private",
      createdByUserId: "usr_alice",
    });
    expect(yield* canViewEvent(event, null)).toBe(false);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("canViewEvent shows private events to their organiser", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: FUTURE,
      visibility: "private",
      createdByUserId: "usr_alice",
    });
    expect(yield* canViewEvent(event, "usr_alice")).toBe(true);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("canViewEvent hides private events from random authenticated viewers", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: FUTURE,
      visibility: "private",
      createdByUserId: "usr_alice",
    });
    expect(yield* canViewEvent(event, "usr_bob")).toBe(false);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("canViewEvent shows private events to viewers who have an RSVP row", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: FUTURE,
      visibility: "private",
      createdByUserId: "usr_alice",
    });
    // Bob has an RSVP for the event (e.g. organiser shared the link).
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    expect(yield* canViewEvent(event, "usr_bob")).toBe(true);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("loadVisibleEvent returns null for non-existent events", () =>
  Effect.gen(function* () {
    const result = yield* loadVisibleEvent("evt_missing", "usr_alice");
    expect(result).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("loadVisibleEvent returns null for events the viewer can't see", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: FUTURE,
      visibility: "private",
      createdByUserId: "usr_alice",
    });
    const result = yield* loadVisibleEvent(event.id, "usr_bob");
    expect(result).toBeNull();
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("loadVisibleEvent returns the event when the viewer can see it", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Public",
      startTime: FUTURE,
      visibility: "public",
    });
    const result = yield* loadVisibleEvent(event.id, null);
    expect(result?.id).toBe(event.id);
  }).pipe(Effect.provide(createTestLayer())),
);
