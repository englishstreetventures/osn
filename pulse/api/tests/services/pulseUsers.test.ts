import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import {
  DEFAULT_ATTENDANCE_VISIBILITY,
  ensurePulseUser,
  getAttendanceVisibility,
  getAttendanceVisibilityBatch,
  getPulseUser,
  updateSettings,
} from "../../src/services/pulseUsers";
import { createTestLayer } from "../helpers/db";

const provide = <A, E>(effect: Effect.Effect<A, E, never>) => effect;

it.effect("getPulseUser returns null when no row exists", () =>
  Effect.gen(function* () {
    const row = yield* getPulseUser("usr_nobody");
    expect(row).toBeNull();
  }).pipe(Effect.provide(createTestLayer()), provide),
);

it.effect("getAttendanceVisibility falls back to the default when no row exists", () =>
  Effect.gen(function* () {
    const v = yield* getAttendanceVisibility("usr_nobody");
    expect(v).toBe(DEFAULT_ATTENDANCE_VISIBILITY);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("ensurePulseUser is idempotent", () =>
  Effect.gen(function* () {
    yield* ensurePulseUser("usr_alice");
    yield* ensurePulseUser("usr_alice");
    const row = yield* getPulseUser("usr_alice");
    expect(row).not.toBeNull();
    expect(row!.userId).toBe("usr_alice");
    expect(row!.attendanceVisibility).toBe("connections");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("updateSettings creates a row on first update", () =>
  Effect.gen(function* () {
    const row = yield* updateSettings("usr_alice", { attendanceVisibility: "no_one" });
    expect(row.attendanceVisibility).toBe("no_one");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("updateSettings changes an existing row", () =>
  Effect.gen(function* () {
    yield* updateSettings("usr_alice", { attendanceVisibility: "no_one" });
    const updated = yield* updateSettings("usr_alice", { attendanceVisibility: "connections" });
    expect(updated.attendanceVisibility).toBe("connections");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("updateSettings rejects invalid enum values", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(
      updateSettings("usr_alice", { attendanceVisibility: "everyone" }),
    );
    expect(err._tag).toBe("ValidationError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("getAttendanceVisibility reads the stored value after update", () =>
  Effect.gen(function* () {
    yield* updateSettings("usr_alice", { attendanceVisibility: "no_one" });
    const v = yield* getAttendanceVisibility("usr_alice");
    expect(v).toBe("no_one");
  }).pipe(Effect.provide(createTestLayer())),
);

// ── getAttendanceVisibilityBatch ─────────────────────────────────────────────
//
// Pinning the batched lookup contract: missing rows fall back to the
// default; one query handles many ids; result Map contains an entry for
// every requested id.

it.effect("getAttendanceVisibilityBatch returns empty Map on empty input", () =>
  Effect.gen(function* () {
    const map = yield* getAttendanceVisibilityBatch([]);
    expect(map.size).toBe(0);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect(
  "getAttendanceVisibilityBatch returns one entry per requested id, defaulting missing ones",
  () =>
    Effect.gen(function* () {
      yield* updateSettings("usr_alice", { attendanceVisibility: "no_one" });
      yield* updateSettings("usr_bob", { attendanceVisibility: "connections" });
      // usr_carol has no row at all → should default to "connections".
      const map = yield* getAttendanceVisibilityBatch(["usr_alice", "usr_bob", "usr_carol"]);
      expect(map.size).toBe(3);
      expect(map.get("usr_alice")).toBe("no_one");
      expect(map.get("usr_bob")).toBe("connections");
      expect(map.get("usr_carol")).toBe(DEFAULT_ATTENDANCE_VISIBILITY);
    }).pipe(Effect.provide(createTestLayer())),
);
