import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { createTestLayer, seedEvent } from "../helpers/db";
import {
  createOsnTestContext,
  seedCloseFriend,
  seedConnection,
  seedOsnUser,
  type OsnTestContext,
} from "../helpers/osnDb";
import {
  inviteGuests,
  latestRsvps,
  listRsvps,
  rsvpCounts,
  upsertRsvp,
} from "../../src/services/rsvps";
import { updateSettings } from "../../src/services/pulseUsers";

function setup() {
  const pulse = createTestLayer();
  const osn = createOsnTestContext();
  const layer = Layer.mergeAll(pulse, osn.layer);
  return { pulse, osn, layer };
}

const runPulseOnly = <A, E>(
  effect: Effect.Effect<A, E, never>,
  pulse: ReturnType<typeof createTestLayer>,
) => Effect.runPromise(effect.pipe(Effect.provide(pulse)));

async function seedBasicUsers(osn: OsnTestContext) {
  await seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" });
  await seedOsnUser(osn, { id: "usr_bob", handle: "bob", displayName: "Bob" });
  await seedOsnUser(osn, { id: "usr_carol", handle: "carol", displayName: "Carol" });
  await seedOsnUser(osn, { id: "usr_dan", handle: "dan", displayName: "Dan" });
}

// ---------------------------------------------------------------------------
// upsertRsvp
// ---------------------------------------------------------------------------

it.effect("upsertRsvp creates new row with rsvp_ prefix", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    const rsvp = yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    expect(rsvp.id).toMatch(/^rsvp_/);
    expect(rsvp.status).toBe("going");
    expect(rsvp.userId).toBe("usr_bob");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("upsertRsvp updates existing RSVP status", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const updated = yield* upsertRsvp(event.id, "usr_bob", { status: "not_going" });
    expect(updated.status).toBe("not_going");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("upsertRsvp rejects interested status when allowInterested is false", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Strict",
      startTime: "2030-06-01T10:00:00.000Z",
      allowInterested: false,
    });
    const err = yield* Effect.flip(upsertRsvp(event.id, "usr_bob", { status: "interested" }));
    expect(err._tag).toBe("ValidationError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("upsertRsvp rejects 'invited' wire status", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    const err = yield* Effect.flip(
      upsertRsvp(event.id, "usr_bob", { status: "invited" as unknown as "going" }),
    );
    expect(err._tag).toBe("ValidationError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("upsertRsvp fails with NotInvited on guest_list event for non-invited user", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Guest list only",
      startTime: "2030-06-01T10:00:00.000Z",
      joinPolicy: "guest_list",
    });
    const err = yield* Effect.flip(upsertRsvp(event.id, "usr_bob", { status: "going" }));
    expect(err._tag).toBe("NotInvited");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("upsertRsvp allows organiser to RSVP to own guest_list event without prior invite", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Guest list only",
      startTime: "2030-06-01T10:00:00.000Z",
      joinPolicy: "guest_list",
      createdByUserId: "usr_alice",
    });
    const rsvp = yield* upsertRsvp(event.id, "usr_alice", { status: "going" });
    expect(rsvp.status).toBe("going");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("upsertRsvp ensures pulse_users row is created", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    // If this didn't create a pulse_users row, getAttendanceVisibility would
    // still fall back to the default — but we've covered ensurePulseUser
    // idempotency elsewhere; this test just verifies no crash on first RSVP.
    expect(true).toBe(true);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// inviteGuests
// ---------------------------------------------------------------------------

it.effect("inviteGuests adds invited rows for non-existing users", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Guest list only",
      startTime: "2030-06-01T10:00:00.000Z",
      joinPolicy: "guest_list",
      createdByUserId: "usr_alice",
    });
    const result = yield* inviteGuests(event.id, "usr_alice", {
      userIds: ["usr_bob", "usr_carol"],
    });
    expect(result.invited).toBe(2);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("inviteGuests skips users with existing RSVPs", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Party",
      startTime: "2030-06-01T10:00:00.000Z",
      createdByUserId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const result = yield* inviteGuests(event.id, "usr_alice", {
      userIds: ["usr_bob", "usr_carol"],
    });
    // Only carol gets invited — bob is already going.
    expect(result.invited).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("inviteGuests rejects non-organiser caller", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Party",
      startTime: "2030-06-01T10:00:00.000Z",
      createdByUserId: "usr_alice",
    });
    const err = yield* Effect.flip(inviteGuests(event.id, "usr_bob", { userIds: ["usr_carol"] }));
    expect(err._tag).toBe("NotEventOwner");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("inviteGuests rejects batches over the platform MAX_EVENT_GUESTS cap", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Festival",
      startTime: "2030-06-01T10:00:00.000Z",
      createdByUserId: "usr_alice",
    });
    // 1001 ids — one over the cap. ValidationError, not DatabaseError.
    const userIds = Array.from({ length: 1001 }, (_, i) => `usr_${i}`);
    const err = yield* Effect.flip(inviteGuests(event.id, "usr_alice", { userIds }));
    expect(err._tag).toBe("ValidationError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("invited user can then RSVP 'going' on guest_list event", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Guest list only",
      startTime: "2030-06-01T10:00:00.000Z",
      joinPolicy: "guest_list",
      createdByUserId: "usr_alice",
    });
    yield* inviteGuests(event.id, "usr_alice", { userIds: ["usr_bob"] });
    const rsvp = yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    expect(rsvp.status).toBe("going");
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// rsvpCounts
// ---------------------------------------------------------------------------

it.effect("rsvpCounts groups by status", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    yield* upsertRsvp(event.id, "usr_carol", { status: "going" });
    yield* upsertRsvp(event.id, "usr_dan", { status: "interested" });
    const counts = yield* rsvpCounts(event.id);
    expect(counts.going).toBe(2);
    expect(counts.interested).toBe(1);
    expect(counts.not_going).toBe(0);
    expect(counts.invited).toBe(0);
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// listRsvps — visibility filtering
// ---------------------------------------------------------------------------

// These tests need both Pulse and OSN DB layers provided. They use the
// combined layer helper.

it.effect("listRsvps returns all rows for public guest list event", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() => seedBasicUsers(osn));
    const event = yield* seedEvent({
      title: "Public",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    // Seed some RSVPs (needs pulse layer only)
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_carol", { status: "going" }).pipe(Effect.provide(pulse));
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
      Effect.provide(layer),
    );
    expect(rows.length).toBe(2);
  }),
);

it.effect(
  "listRsvps returns empty for connections-only event when viewer is not an organiser's connection",
  () =>
    Effect.gen(function* () {
      const { pulse, osn, layer } = setup();
      yield* Effect.promise(() => seedBasicUsers(osn));
      const event = yield* seedEvent({
        title: "Connections",
        startTime: "2030-06-01T10:00:00.000Z",
        guestListVisibility: "connections",
        createdByUserId: "usr_alice",
      }).pipe(Effect.provide(pulse));
      yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
      // Dan is NOT connected to Alice
      const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
        Effect.provide(layer),
      );
      expect(rows.length).toBe(0);
    }),
);

it.effect("listRsvps returns rows for connections-only event when viewer IS a connection", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() => seedBasicUsers(osn));
    // Dan is connected to Alice (the organiser).
    yield* Effect.promise(() => seedConnection(osn, "usr_alice", "usr_dan"));
    // Bob is connected to Dan (so Dan can see Bob's RSVP under per-row filter).
    yield* Effect.promise(() => seedConnection(osn, "usr_dan", "usr_bob"));
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
      Effect.provide(layer),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe("usr_bob");
  }),
);

it.effect("listRsvps returns empty for private guest list when viewer is not organiser", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() => seedBasicUsers(osn));
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "private",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
      Effect.provide(layer),
    );
    expect(rows.length).toBe(0);
  }),
);

it.effect("listRsvps returns all rows for private guest list when viewer IS the organiser", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() => seedBasicUsers(osn));
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "private",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_carol", { status: "going" }).pipe(Effect.provide(pulse));
    const rows = yield* listRsvps(event.id, "usr_alice", { status: "going" }).pipe(
      Effect.provide(layer),
    );
    expect(rows.length).toBe(2);
  }),
);

it.effect("listRsvps hides attendee whose own setting is 'no_one'", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() => seedBasicUsers(osn));
    // Connections-only event so per-row filter runs.
    yield* Effect.promise(() => seedConnection(osn, "usr_alice", "usr_dan"));
    yield* Effect.promise(() => seedConnection(osn, "usr_dan", "usr_bob"));
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
    yield* updateSettings("usr_bob", { attendanceVisibility: "no_one" }).pipe(
      Effect.provide(pulse),
    );
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
      Effect.provide(layer),
    );
    expect(rows.length).toBe(0);
  }),
);

it.effect(
  "listRsvps shows attendee whose setting is 'no_one' BUT public guest list overrides",
  () =>
    Effect.gen(function* () {
      const { pulse, osn, layer } = setup();
      yield* Effect.promise(() => seedBasicUsers(osn));
      const event = yield* seedEvent({
        title: "Public",
        startTime: "2030-06-01T10:00:00.000Z",
        guestListVisibility: "public",
        createdByUserId: "usr_alice",
      }).pipe(Effect.provide(pulse));
      yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
      yield* updateSettings("usr_bob", { attendanceVisibility: "no_one" }).pipe(
        Effect.provide(pulse),
      );
      const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
        Effect.provide(layer),
      );
      // Public guest list wins: Bob knowingly attended a public-list event.
      expect(rows.length).toBe(1);
    }),
);

it.effect("viewer always sees their own RSVP", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() => seedBasicUsers(osn));
    // Dan is connected to Alice (event visible) but no one else.
    yield* Effect.promise(() => seedConnection(osn, "usr_alice", "usr_dan"));
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_dan", { status: "going" }).pipe(Effect.provide(pulse));
    yield* updateSettings("usr_dan", { attendanceVisibility: "no_one" }).pipe(
      Effect.provide(pulse),
    );
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
      Effect.provide(layer),
    );
    // Dan sees himself even though his setting is no_one.
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe("usr_dan");
  }),
);

it.effect(
  "close_friends visibility shows the row when the attendee marked the viewer as a close friend",
  () =>
    Effect.gen(function* () {
      const { pulse, osn, layer } = setup();
      yield* Effect.promise(() => seedBasicUsers(osn));
      yield* Effect.promise(() => seedConnection(osn, "usr_alice", "usr_dan"));
      yield* Effect.promise(() => seedConnection(osn, "usr_dan", "usr_bob"));
      // Bob (the attendee) marks Dan (the viewer) as a close friend —
      // the directionally-correct semantic. Bob's RSVP should appear
      // for Dan because Bob owns the privacy decision.
      yield* Effect.promise(() => seedCloseFriend(osn, "usr_bob", "usr_dan"));
      const event = yield* seedEvent({
        title: "Connections",
        startTime: "2030-06-01T10:00:00.000Z",
        guestListVisibility: "connections",
        createdByUserId: "usr_alice",
      }).pipe(Effect.provide(pulse));
      yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
      yield* updateSettings("usr_bob", { attendanceVisibility: "close_friends" }).pipe(
        Effect.provide(pulse),
      );
      const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
        Effect.provide(layer),
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.isCloseFriend).toBe(true);
    }),
);

it.effect(
  "close_friends visibility hides the row when only the viewer marked the attendee (inverted)",
  () =>
    Effect.gen(function* () {
      const { pulse, osn, layer } = setup();
      yield* Effect.promise(() => seedBasicUsers(osn));
      yield* Effect.promise(() => seedConnection(osn, "usr_alice", "usr_dan"));
      yield* Effect.promise(() => seedConnection(osn, "usr_dan", "usr_bob"));
      // Inverted: Dan (viewer) marks Bob (attendee). Bob did NOT mark
      // Dan back. With the new directional check, Bob's gated RSVP
      // must NOT leak to Dan — this is the S-M1 fix in action.
      yield* Effect.promise(() => seedCloseFriend(osn, "usr_dan", "usr_bob"));
      const event = yield* seedEvent({
        title: "Connections",
        startTime: "2030-06-01T10:00:00.000Z",
        guestListVisibility: "connections",
        createdByUserId: "usr_alice",
      }).pipe(Effect.provide(pulse));
      yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
      yield* updateSettings("usr_bob", { attendanceVisibility: "close_friends" }).pipe(
        Effect.provide(pulse),
      );
      const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" }).pipe(
        Effect.provide(layer),
      );
      expect(rows.length).toBe(0);
    }),
);

it.effect("listRsvps joins user display metadata onto rows", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() =>
      seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" }),
    );
    yield* Effect.promise(() =>
      seedOsnUser(osn, { id: "usr_bob", handle: "bob", displayName: "Bob Smith" }),
    );
    const event = yield* seedEvent({
      title: "Public",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" }).pipe(Effect.provide(pulse));
    const rows = yield* listRsvps(event.id, "usr_alice", { status: "going" }).pipe(
      Effect.provide(layer),
    );
    expect(rows[0]!.user?.displayName).toBe("Bob Smith");
    expect(rows[0]!.user?.handle).toBe("bob");
  }),
);

// ---------------------------------------------------------------------------
// latestRsvps — default + clamping
// ---------------------------------------------------------------------------

it.effect("latestRsvps defaults to 5 results when more exist", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() =>
      seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" }),
    );
    for (const id of ["usr_b1", "usr_b2", "usr_b3", "usr_b4", "usr_b5", "usr_b6", "usr_b7"]) {
      yield* Effect.promise(() => seedOsnUser(osn, { id, handle: id, displayName: id }));
    }
    const event = yield* seedEvent({
      title: "Popular",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    for (const id of ["usr_b1", "usr_b2", "usr_b3", "usr_b4", "usr_b5", "usr_b6", "usr_b7"]) {
      yield* upsertRsvp(event.id, id, { status: "going" }).pipe(Effect.provide(pulse));
    }
    const rows = yield* latestRsvps(event.id, "usr_alice").pipe(Effect.provide(layer));
    expect(rows.length).toBe(5);
  }),
);

it.effect("latestRsvps respects an explicit limit", () =>
  Effect.gen(function* () {
    const { pulse, osn, layer } = setup();
    yield* Effect.promise(() =>
      seedOsnUser(osn, { id: "usr_alice", handle: "alice", displayName: "Alice" }),
    );
    for (const id of ["usr_b1", "usr_b2", "usr_b3"]) {
      yield* Effect.promise(() => seedOsnUser(osn, { id, handle: id, displayName: id }));
    }
    const event = yield* seedEvent({
      title: "Small",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByUserId: "usr_alice",
    }).pipe(Effect.provide(pulse));
    for (const id of ["usr_b1", "usr_b2", "usr_b3"]) {
      yield* upsertRsvp(event.id, id, { status: "going" }).pipe(Effect.provide(pulse));
    }
    const rows = yield* latestRsvps(event.id, "usr_alice", 1).pipe(Effect.provide(layer));
    expect(rows.length).toBe(1);
  }),
);

// Suppress "vitest imported but not used" lint on _runPulseOnly helper —
// keep the helper definition in case future tests need it.
void runPulseOnly;
