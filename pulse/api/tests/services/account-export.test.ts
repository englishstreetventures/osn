import { describe, expect, it } from "@effect/vitest";
import { eventRsvps, pulseCloseFriends, pulseUsers } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { Effect } from "effect";

import { resolveDbHandle, streamAccountExport } from "../../src/services/accountExport";
import { createTestLayer, seedEvent } from "../helpers/db";

const drain = async (
  iter: AsyncIterable<{ section: string; row: Record<string, unknown> }>,
): Promise<Array<{ section: string; row: Record<string, unknown> }>> => {
  const out: Array<{ section: string; row: Record<string, unknown> }> = [];
  for await (const l of iter) out.push(l);
  return out;
};

describe("Pulse streamAccountExport", () => {
  it.effect("returns empty stream for an account with no profile IDs", () =>
    Effect.gen(function* () {
      const db = yield* resolveDbHandle();
      const lines = yield* Effect.promise(() => drain(streamAccountExport(db, [])));
      expect(lines).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("emits hosted events + RSVPs + close_friends + pulse_users for the profile", () =>
    Effect.gen(function* () {
      const profileId = "usr_alice";

      // Hosted event by alice.
      yield* seedEvent({
        title: "Alice's Birthday",
        startTime: new Date(Date.now() + 86_400_000).toISOString(),
        createdByProfileId: profileId,
      });

      // RSVP from alice to some other event.
      const otherEvent = yield* seedEvent({
        title: "Other event",
        startTime: new Date(Date.now() + 172_800_000).toISOString(),
        createdByProfileId: "usr_bob",
      });
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(eventRsvps).values({
          id: "rsvp_a",
          eventId: otherEvent.id,
          profileId,
          status: "going",
          invitedByProfileId: null,
          createdAt: new Date(),
        }),
      );

      // Close friend.
      yield* Effect.promise(() =>
        db.insert(pulseCloseFriends).values({
          id: "pcf_a",
          profileId,
          friendId: "usr_carol",
          createdAt: new Date(),
        }),
      );

      // Pulse settings.
      yield* Effect.promise(() =>
        db.insert(pulseUsers).values({
          profileId,
          attendanceVisibility: "no_one",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      const lines = yield* Effect.promise(() => drain(streamAccountExport(db, [profileId])));

      const sections = new Set(lines.map((l) => l.section));
      expect(sections.has("pulse.events_hosted")).toBe(true);
      expect(sections.has("pulse.rsvps")).toBe(true);
      expect(sections.has("pulse.close_friends")).toBe(true);
      expect(sections.has("pulse.pulse_users")).toBe(true);

      const settingsRow = lines.find((l) => l.section === "pulse.pulse_users");
      expect(settingsRow?.row.attendance_visibility).toBe("no_one");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
