import { it, expect, describe } from "@effect/vitest";
import {
  events,
  eventComms,
  eventLineup,
  eventRsvps,
  pulseAccountOnboarding,
  pulseCloseFriends,
  pulseDeletionJobs,
  pulseProfileAccounts,
  pulseUsers,
} from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import * as accountErasure from "../../src/services/accountErasure";
import { createTestLayer, seedEvent } from "../helpers/db";

const ACCOUNT_ID = "acc_pulse_test_account";
const PROFILE_ID = "usr_pulse_test_profile";

const seedPulseData = (): Effect.Effect<{ eventId: string }, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const event = yield* seedEvent({
      title: "Hosted",
      startTime: new Date(Date.now() + 86_400_000),
      createdByProfileId: PROFILE_ID,
    });
    yield* Effect.promise(() =>
      db.insert(eventRsvps).values({
        id: "rsvp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        eventId: event.id,
        profileId: PROFILE_ID,
        status: "going",
      }),
    );
    yield* Effect.promise(() =>
      db.insert(pulseCloseFriends).values({
        id: "pcf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        profileId: PROFILE_ID,
        friendId: "usr_friend_one",
      }),
    );
    yield* Effect.promise(() =>
      db.insert(eventComms).values({
        id: "evtcomm_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        eventId: event.id,
        channel: "email",
        body: "hello",
        sentByProfileId: PROFILE_ID,
        sentAt: new Date(),
      }),
    );
    yield* Effect.promise(() =>
      db.insert(pulseUsers).values({ profileId: PROFILE_ID, attendanceVisibility: "connections" }),
    );
    return { eventId: event.id };
  });

describe("pulse account-erasure: requestErasure", () => {
  it.effect(
    "preserves personal Pulse data during grace + flips hosted events into cancellation window",
    () =>
      Effect.gen(function* () {
        yield* seedPulseData();
        const result = yield* accountErasure.requestErasure({
          profileId: PROFILE_ID,
          accountId: ACCOUNT_ID,
        });
        expect(result.newlyScheduled).toBe(true);

        const { db } = yield* Db;
        // S-M5/C-M1: RSVPs, close-friends, comms, and pulse_users are NOT
        // deleted at soft-delete time — they survive the grace window so
        // cancellation is fully reversible. Hard-delete sweeper purges
        // them after 7 days.
        const rsvps = yield* Effect.promise(() =>
          db.select().from(eventRsvps).where(eq(eventRsvps.profileId, PROFILE_ID)),
        );
        expect(rsvps).toHaveLength(1);
        const cf = yield* Effect.promise(() =>
          db.select().from(pulseCloseFriends).where(eq(pulseCloseFriends.profileId, PROFILE_ID)),
        );
        expect(cf).toHaveLength(1);
        const cm = yield* Effect.promise(() =>
          db.select().from(eventComms).where(eq(eventComms.sentByProfileId, PROFILE_ID)),
        );
        expect(cm).toHaveLength(1);
        const pu = yield* Effect.promise(() =>
          db.select().from(pulseUsers).where(eq(pulseUsers.profileId, PROFILE_ID)),
        );
        expect(pu).toHaveLength(1);

        // Hosted events flipped to cancelled with a 14-day public window.
        const ev = yield* Effect.promise(() =>
          db.select().from(events).where(eq(events.createdByProfileId, PROFILE_ID)),
        );
        expect(ev).toHaveLength(1);
        expect(ev[0].status).toBe("cancelled");
        expect(ev[0].cancelledAt).not.toBeNull();
        expect(ev[0].cancellationReason).toBe("host_left");
        expect(ev[0].hardDeleteAt).not.toBeNull();

        const jobs = yield* Effect.promise(() =>
          db.select().from(pulseDeletionJobs).where(eq(pulseDeletionJobs.profileId, PROFILE_ID)),
        );
        expect(jobs).toHaveLength(1);
        expect(jobs[0].accountId).toBe(ACCOUNT_ID);
        expect(jobs[0].enrollmentNotifyDoneAt).toBeNull();
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("hard-delete sweeper purges personal data after the 7-day grace window", () =>
    Effect.gen(function* () {
      const { eventId } = yield* seedPulseData();
      const { db } = yield* Db;
      // Onboarding state for the leaving account (C-H1 re-review surface).
      yield* Effect.promise(() =>
        db.insert(pulseAccountOnboarding).values({
          accountId: ACCOUNT_ID,
          interests: '["music"]',
        }),
      );
      yield* Effect.promise(() =>
        db.insert(pulseProfileAccounts).values({
          profileId: PROFILE_ID,
          accountId: ACCOUNT_ID,
        }),
      );
      // Manually insert a deletion-jobs row with hard_delete_at in the past.
      yield* Effect.promise(() =>
        db.insert(pulseDeletionJobs).values({
          profileId: PROFILE_ID,
          accountId: ACCOUNT_ID,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          enrollmentNotifyDoneAt: 1_500,
          reason: "user_request",
        }),
      );
      const r = yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });
      expect(r.purged).toBe(1);
      // Personal data is now gone.
      const rsvps = yield* Effect.promise(() =>
        db.select().from(eventRsvps).where(eq(eventRsvps.profileId, PROFILE_ID)),
      );
      expect(rsvps).toHaveLength(0);
      const cf = yield* Effect.promise(() =>
        db.select().from(pulseCloseFriends).where(eq(pulseCloseFriends.profileId, PROFILE_ID)),
      );
      expect(cf).toHaveLength(0);
      const pu = yield* Effect.promise(() =>
        db.select().from(pulseUsers).where(eq(pulseUsers.profileId, PROFILE_ID)),
      );
      expect(pu).toHaveLength(0);
      // Onboarding + profileId→accountId cache rows purged (C-H1).
      const ob = yield* Effect.promise(() =>
        db
          .select()
          .from(pulseAccountOnboarding)
          .where(eq(pulseAccountOnboarding.accountId, ACCOUNT_ID)),
      );
      expect(ob).toHaveLength(0);
      const pa = yield* Effect.promise(() =>
        db
          .select()
          .from(pulseProfileAccounts)
          .where(eq(pulseProfileAccounts.profileId, PROFILE_ID)),
      );
      expect(pa).toHaveLength(0);
      // Hosted event is still there (governed by its own 14-day window).
      const ev = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.id, eventId)),
      );
      expect(ev).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("idempotent — second call returns the original schedule", () =>
    Effect.gen(function* () {
      yield* seedPulseData();
      const a = yield* accountErasure.requestErasure({
        profileId: PROFILE_ID,
        accountId: ACCOUNT_ID,
      });
      const b = yield* accountErasure.requestErasure({
        profileId: PROFILE_ID,
        accountId: ACCOUNT_ID,
      });
      expect(b.newlyScheduled).toBe(false);
      expect(b.scheduledFor).toBe(a.scheduledFor);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("pulse account-erasure: purgeAccount (full-account fan-out)", () => {
  it.effect("hard-deletes hosted events + all personal data with no grace window", () =>
    Effect.gen(function* () {
      const { eventId } = yield* seedPulseData();
      const { db } = yield* Db;
      // Lineup + onboarding rows for the merge-introduced tables — these
      // must be purged too (S-M2 / C-H1 from the post-merge re-review).
      yield* Effect.promise(() =>
        db.insert(eventLineup).values({
          id: "lnp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          eventId,
          artistName: "DJ Test",
          role: "headliner",
          slotStart: new Date(),
          slotEnd: new Date(Date.now() + 3_600_000),
        }),
      );
      yield* Effect.promise(() =>
        db.insert(pulseAccountOnboarding).values({
          accountId: ACCOUNT_ID,
          interests: '["music"]',
        }),
      );
      yield* Effect.promise(() =>
        db.insert(pulseProfileAccounts).values({
          profileId: PROFILE_ID,
          accountId: ACCOUNT_ID,
        }),
      );

      const result = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(result.purged).toBe(1);

      const remaining = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.createdByProfileId, PROFILE_ID)),
      );
      expect(remaining).toHaveLength(0);
      const lineup = yield* Effect.promise(() =>
        db.select().from(eventLineup).where(eq(eventLineup.eventId, eventId)),
      );
      expect(lineup).toHaveLength(0);
      const ob = yield* Effect.promise(() =>
        db
          .select()
          .from(pulseAccountOnboarding)
          .where(eq(pulseAccountOnboarding.accountId, ACCOUNT_ID)),
      );
      expect(ob).toHaveLength(0);
      const pa = yield* Effect.promise(() =>
        db
          .select()
          .from(pulseProfileAccounts)
          .where(eq(pulseProfileAccounts.profileId, PROFILE_ID)),
      );
      expect(pa).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("replay-protected — second call for the same account is a no-op (S-H1)", () =>
    Effect.gen(function* () {
      yield* seedPulseData();
      const first = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(first.alreadyProcessed).toBe(false);
      const second = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(second.alreadyProcessed).toBe(true);
      expect(second.purged).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("idempotent on empty profileIds", () =>
    Effect.gen(function* () {
      const r = yield* accountErasure.purgeAccount(ACCOUNT_ID, []);
      expect(r.purged).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("pulse account-erasure: cancellation + sweepers", () => {
  it.effect("cancelErasure restores cancelled events still inside their window", () =>
    Effect.gen(function* () {
      yield* seedPulseData();
      yield* accountErasure.requestErasure({ profileId: PROFILE_ID, accountId: ACCOUNT_ID });
      const cancelled = yield* accountErasure.cancelErasure(PROFILE_ID);
      expect(cancelled.cancelled).toBe(true);
      const { db } = yield* Db;
      const ev = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.createdByProfileId, PROFILE_ID)),
      );
      expect(ev[0].cancelledAt).toBeNull();
      expect(ev[0].status).toBe("upcoming");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("hard-delete sweeper removes deletion-jobs past the grace window", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(pulseDeletionJobs).values({
          profileId: PROFILE_ID,
          accountId: ACCOUNT_ID,
          softDeletedAt: 1_000,
          hardDeleteAt: 2_000,
          enrollmentNotifyDoneAt: 1_500,
          reason: "user_request",
        }),
      );
      const r = yield* accountErasure.runHardDeleteSweep({ nowMs: 5_000_000 });
      expect(r.purged).toBe(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("event-cancellation sweeper hard-deletes events past hardDeleteAt", () =>
    Effect.gen(function* () {
      yield* seedPulseData();
      const { db } = yield* Db;
      // Manually flip the event into cancelled state with a hard-delete in the past.
      yield* Effect.promise(() =>
        db
          .update(events)
          .set({ cancelledAt: 1_000, hardDeleteAt: 2_000, cancellationReason: "host_left" })
          .where(eq(events.createdByProfileId, PROFILE_ID)),
      );
      const r = yield* accountErasure.runEventCancellationSweep({ nowMs: 5_000_000 });
      expect(r.purged).toBe(1);
      const remaining = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.createdByProfileId, PROFILE_ID)),
      );
      expect(remaining).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
