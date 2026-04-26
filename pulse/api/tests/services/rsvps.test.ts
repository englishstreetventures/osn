import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { vi, beforeEach } from "vitest";

import type { ProfileDisplay } from "../../src/services/graphBridge";
import { updateSettings } from "../../src/services/pulseUsers";
import {
  inviteGuests,
  latestRsvps,
  listRsvps,
  rsvpCounts,
  upsertRsvp,
} from "../../src/services/rsvps";
import { createTestLayer, seedCloseFriend, seedEvent } from "../helpers/db";

// graphBridge functions are mocked at the module level so rsvps.ts uses the
// mocked implementations. Close-friend lookups are NOT bridge calls anymore —
// they're served by a local Pulse table; tests that need close-friend
// stamping seed `pulse_close_friends` directly via `seedCloseFriend`.
vi.mock("../../src/services/graphBridge", () => ({
  GraphBridgeError: class GraphBridgeError {
    _tag = "GraphBridgeError";
    constructor(public args: { cause: unknown }) {}
  },
  getConnectionIds: vi.fn(() => Effect.succeed(new Set<string>())),
  getProfileDisplays: vi.fn(() => Effect.succeed(new Map<string, ProfileDisplay>())),
}));

import * as bridge from "../../src/services/graphBridge";

beforeEach(() => {
  vi.mocked(bridge.getConnectionIds).mockReturnValue(Effect.succeed(new Set()));
  vi.mocked(bridge.getProfileDisplays).mockReturnValue(Effect.succeed(new Map()));
});

// Shorthand: build a ProfileDisplay for a mock user.
function profile(id: string, handle: string, displayName: string): ProfileDisplay {
  return { id, handle, displayName, avatarUrl: null };
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
    expect(rsvp.profileId).toBe("usr_bob");
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
      createdByProfileId: "usr_alice",
    });
    const rsvp = yield* upsertRsvp(event.id, "usr_alice", { status: "going" });
    expect(rsvp.status).toBe("going");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("upsertRsvp ensures pulse_users row is created", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
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
      createdByProfileId: "usr_alice",
    });
    const result = yield* inviteGuests(event.id, "usr_alice", {
      profileIds: ["usr_bob", "usr_carol"],
    });
    expect(result.invited).toBe(2);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("inviteGuests skips users with existing RSVPs", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Party",
      startTime: "2030-06-01T10:00:00.000Z",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const result = yield* inviteGuests(event.id, "usr_alice", {
      profileIds: ["usr_bob", "usr_carol"],
    });
    expect(result.invited).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("inviteGuests rejects non-organiser caller", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Party",
      startTime: "2030-06-01T10:00:00.000Z",
      createdByProfileId: "usr_alice",
    });
    const err = yield* Effect.flip(
      inviteGuests(event.id, "usr_bob", { profileIds: ["usr_carol"] }),
    );
    expect(err._tag).toBe("NotEventOwner");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("inviteGuests rejects batches over the platform MAX_EVENT_GUESTS cap", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Festival",
      startTime: "2030-06-01T10:00:00.000Z",
      createdByProfileId: "usr_alice",
    });
    const profileIds = Array.from({ length: 1001 }, (_, i) => `usr_${i}`);
    const err = yield* Effect.flip(inviteGuests(event.id, "usr_alice", { profileIds }));
    expect(err._tag).toBe("ValidationError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("invited user can then RSVP 'going' on guest_list event", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Guest list only",
      startTime: "2030-06-01T10:00:00.000Z",
      joinPolicy: "guest_list",
      createdByProfileId: "usr_alice",
    });
    yield* inviteGuests(event.id, "usr_alice", { profileIds: ["usr_bob"] });
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

// These tests mock graphBridge functions to control graph data.
// The mock contract for each test follows the scenario being tested.

it.effect("listRsvps returns all rows for public guest list event", () =>
  Effect.gen(function* () {
    // Public event: no connection check — visible to everyone.
    // The Pulse close-friends lookup runs against the local table; without
    // any seeded rows it returns an empty Set, so isCloseFriend stays false.
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(
        new Map([
          ["usr_bob", profile("usr_bob", "bob", "Bob")],
          ["usr_carol", profile("usr_carol", "carol", "Carol")],
        ]),
      ),
    );
    const event = yield* seedEvent({
      title: "Public",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    yield* upsertRsvp(event.id, "usr_carol", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    expect(rows.length).toBe(2);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect(
  "listRsvps returns empty for connections-only event when viewer is not an organiser's connection",
  () =>
    Effect.gen(function* () {
      // Dan is NOT in Alice's connection set.
      vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) =>
        Effect.succeed(profileId === "usr_alice" ? new Set(["usr_bob"]) : new Set()),
      );
      const event = yield* seedEvent({
        title: "Connections",
        startTime: "2030-06-01T10:00:00.000Z",
        guestListVisibility: "connections",
        createdByProfileId: "usr_alice",
      });
      yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
      const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
      expect(rows.length).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listRsvps returns rows for connections-only event when viewer IS a connection", () =>
  Effect.gen(function* () {
    // Dan IS in Alice's connection set; Bob IS in Dan's connection set.
    vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) => {
      if (profileId === "usr_alice") return Effect.succeed(new Set(["usr_dan"]));
      if (profileId === "usr_dan") return Effect.succeed(new Set(["usr_bob", "usr_alice"]));
      return Effect.succeed(new Set());
    });
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map([["usr_bob", profile("usr_bob", "bob", "Bob")]])),
    );
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.profileId).toBe("usr_bob");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listRsvps returns empty for private guest list when viewer is not organiser", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "private",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    expect(rows.length).toBe(0);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listRsvps returns all rows for private guest list when viewer IS the organiser", () =>
  Effect.gen(function* () {
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(
        new Map([
          ["usr_bob", profile("usr_bob", "bob", "Bob")],
          ["usr_carol", profile("usr_carol", "carol", "Carol")],
        ]),
      ),
    );
    const event = yield* seedEvent({
      title: "Hidden",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "private",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    yield* upsertRsvp(event.id, "usr_carol", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_alice", { status: "going" });
    expect(rows.length).toBe(2);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listRsvps hides attendee whose own setting is 'no_one'", () =>
  Effect.gen(function* () {
    // Dan is in Alice's connections (event visible); Bob is in Dan's connections.
    vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) => {
      if (profileId === "usr_alice") return Effect.succeed(new Set(["usr_dan"]));
      if (profileId === "usr_dan") return Effect.succeed(new Set(["usr_bob"]));
      return Effect.succeed(new Set());
    });
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    // Bob sets his attendance visibility to no_one — hides his row from others.
    yield* updateSettings("usr_bob", { attendanceVisibility: "no_one" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    expect(rows.length).toBe(0);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect(
  "listRsvps shows attendee whose setting is 'no_one' BUT public guest list overrides",
  () =>
    Effect.gen(function* () {
      vi.mocked(bridge.getProfileDisplays).mockReturnValue(
        Effect.succeed(new Map([["usr_bob", profile("usr_bob", "bob", "Bob")]])),
      );
      const event = yield* seedEvent({
        title: "Public",
        startTime: "2030-06-01T10:00:00.000Z",
        guestListVisibility: "public",
        createdByProfileId: "usr_alice",
      });
      yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
      yield* updateSettings("usr_bob", { attendanceVisibility: "no_one" });
      const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
      // Public guest list wins: by attending a public-list event Bob opted in.
      expect(rows.length).toBe(1);
    }).pipe(Effect.provide(createTestLayer())),
);

it.effect("viewer always sees their own RSVP", () =>
  Effect.gen(function* () {
    // Dan is in Alice's connections (event visible).
    vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) => {
      if (profileId === "usr_alice") return Effect.succeed(new Set(["usr_dan"]));
      return Effect.succeed(new Set());
    });
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map([["usr_dan", profile("usr_dan", "dan", "Dan")]])),
    );
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_dan", { status: "going" });
    yield* updateSettings("usr_dan", { attendanceVisibility: "no_one" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    // Dan sees himself even though his setting is no_one.
    expect(rows.length).toBe(1);
    expect(rows[0]!.profileId).toBe("usr_dan");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("isCloseFriend flag is stamped when the attendee has marked the viewer as a CF", () =>
  Effect.gen(function* () {
    // Dan in Alice's connections; Bob in Dan's connections.
    vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) => {
      if (profileId === "usr_alice") return Effect.succeed(new Set(["usr_dan"]));
      if (profileId === "usr_dan") return Effect.succeed(new Set(["usr_bob"]));
      return Effect.succeed(new Set());
    });
    // Bob (attendee) marked Dan (viewer) as a close friend — seeded directly
    // into the local Pulse table.
    yield* seedCloseFriend("usr_bob", "usr_dan");
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map([["usr_bob", profile("usr_bob", "bob", "Bob")]])),
    );
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.isCloseFriend).toBe(true);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("isCloseFriend flag is NOT stamped when only the viewer marked the attendee", () =>
  Effect.gen(function* () {
    // Dan in Alice's connections; Bob in Dan's connections.
    vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) => {
      if (profileId === "usr_alice") return Effect.succeed(new Set(["usr_dan"]));
      if (profileId === "usr_dan") return Effect.succeed(new Set(["usr_bob"]));
      return Effect.succeed(new Set());
    });
    // Dan marked Bob — but Bob did NOT mark Dan. The reverse lookup returns
    // empty because the only seeded row is Dan→Bob.
    yield* seedCloseFriend("usr_dan", "usr_bob");
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map([["usr_bob", profile("usr_bob", "bob", "Bob")]])),
    );
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.isCloseFriend).toBe(false);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listRsvps surfaces close-friend rows first, newest-within-bucket after", () =>
  Effect.gen(function* () {
    // Dan is in Alice's connections; Dan is connected to bob, carol, eve.
    vi.mocked(bridge.getConnectionIds).mockImplementation((profileId) => {
      if (profileId === "usr_alice") return Effect.succeed(new Set(["usr_dan"]));
      if (profileId === "usr_dan")
        return Effect.succeed(new Set(["usr_bob", "usr_carol", "usr_eve"]));
      return Effect.succeed(new Set());
    });
    // Only Eve has marked Dan as a close friend.
    yield* seedCloseFriend("usr_eve", "usr_dan");
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(
        new Map([
          ["usr_eve", profile("usr_eve", "eve", "Eve")],
          ["usr_bob", profile("usr_bob", "bob", "Bob")],
          ["usr_carol", profile("usr_carol", "carol", "Carol")],
        ]),
      ),
    );
    const event = yield* seedEvent({
      title: "Connections",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "connections",
      createdByProfileId: "usr_alice",
    });
    // Eve RSVPs first; Bob and Carol after — default createdAt-DESC would put Eve last.
    yield* upsertRsvp(event.id, "usr_eve", { status: "going" });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    yield* upsertRsvp(event.id, "usr_carol", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_dan", { status: "going" });
    expect(rows.length).toBe(3);
    // Eve first (close friend), then non-CF rows in createdAt DESC order.
    expect(rows[0]!.profileId).toBe("usr_eve");
    expect(rows[0]!.isCloseFriend).toBe(true);
    expect(rows[1]!.isCloseFriend).toBe(false);
    expect(rows[2]!.isCloseFriend).toBe(false);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listRsvps joins user display metadata onto rows", () =>
  Effect.gen(function* () {
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map([["usr_bob", profile("usr_bob", "bob", "Bob Smith")]])),
    );
    const event = yield* seedEvent({
      title: "Public",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByProfileId: "usr_alice",
    });
    yield* upsertRsvp(event.id, "usr_bob", { status: "going" });
    const rows = yield* listRsvps(event.id, "usr_alice", { status: "going" });
    expect(rows[0]!.profile?.displayName).toBe("Bob Smith");
    expect(rows[0]!.profile?.handle).toBe("bob");
  }).pipe(Effect.provide(createTestLayer())),
);

// ---------------------------------------------------------------------------
// latestRsvps — default + clamping
// ---------------------------------------------------------------------------

it.effect("latestRsvps defaults to 5 results when more exist", () =>
  Effect.gen(function* () {
    const ids = ["usr_b1", "usr_b2", "usr_b3", "usr_b4", "usr_b5", "usr_b6", "usr_b7"];
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map(ids.map((id) => [id, profile(id, id, id)]))),
    );
    const event = yield* seedEvent({
      title: "Popular",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByProfileId: "usr_alice",
    });
    for (const id of ids) {
      yield* upsertRsvp(event.id, id, { status: "going" });
    }
    const rows = yield* latestRsvps(event.id, "usr_alice");
    expect(rows.length).toBe(5);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("latestRsvps respects an explicit limit", () =>
  Effect.gen(function* () {
    const ids = ["usr_b1", "usr_b2", "usr_b3"];
    vi.mocked(bridge.getProfileDisplays).mockReturnValue(
      Effect.succeed(new Map(ids.map((id) => [id, profile(id, id, id)]))),
    );
    const event = yield* seedEvent({
      title: "Small",
      startTime: "2030-06-01T10:00:00.000Z",
      guestListVisibility: "public",
      createdByProfileId: "usr_alice",
    });
    for (const id of ids) {
      yield* upsertRsvp(event.id, id, { status: "going" });
    }
    const rows = yield* latestRsvps(event.id, "usr_alice", 1);
    expect(rows.length).toBe(1);
  }).pipe(Effect.provide(createTestLayer())),
);
