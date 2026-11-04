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
import { updateEvent } from "../../src/services/events";
import {
  createCapturingTestLayer,
  createTestLayer,
  seedEvent,
  statementKinds,
} from "../helpers/db";

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
        // RSVPs, close-friends, comms, and pulse_users are NOT
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
      // Onboarding state for the leaving account.
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
      // Onboarding + profileId→accountId cache rows purged.
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
      // must be purged too.
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

  it.effect("replay-protected — second call for the same account is a no-op", () =>
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
      expect(ev[0].cancellationReason).toBeNull();
      expect(ev[0].hardDeleteAt).toBeNull();
      // The host who came back can edit the event again.
      const edited = yield* updateEvent(ev[0].id, { title: "Back" }, PROFILE_ID);
      expect(edited.title).toBe("Back");
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

describe("pulse account-erasure: events the host had already cancelled", () => {
  const hostedCancelled = () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const event = yield* seedEvent({
        title: "Called off",
        startTime: new Date(Date.now() + 86_400_000),
        createdByProfileId: PROFILE_ID,
      });
      yield* Effect.promise(() =>
        db
          .update(events)
          .set({ status: "cancelled", cancelledAt: 1_000, cancellationReason: "organiser" })
          .where(eq(events.id, event.id)),
      );
      return event.id;
    });

  const row = (id: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [r] = yield* Effect.promise(() => db.select().from(events).where(eq(events.id, id)));
      return r;
    });

  it.effect(
    "requestErasure schedules the host's own cancelled events and cancelErasure unschedules them",
    () =>
      Effect.gen(function* () {
        const id = yield* hostedCancelled();
        const { eventId: liveId } = yield* seedPulseData();
        const before = Math.floor(Date.now() / 1_000);
        yield* accountErasure.requestErasure({ profileId: PROFILE_ID, accountId: ACCOUNT_ID });
        const after = Math.floor(Date.now() / 1_000);
        const scheduled = yield* row(id);
        const hostLeft = yield* row(liveId);
        // The same window the leave gives the events it cancels itself.
        expect(hostLeft.cancellationReason).toBe("host_left");
        expect(scheduled.hardDeleteAt).toBe(hostLeft.hardDeleteAt);
        expect(scheduled.hardDeleteAt).toBeGreaterThanOrEqual(
          before + accountErasure.EVENT_CANCELLATION_WINDOW_SECONDS,
        );
        expect(scheduled.hardDeleteAt).toBeLessThanOrEqual(
          after + accountErasure.EVENT_CANCELLATION_WINDOW_SECONDS,
        );
        expect(scheduled.cancellationReason).toBe("organiser");
        expect(scheduled.cancelledAt).toBe(1_000);

        yield* accountErasure.cancelErasure(PROFILE_ID);
        const kept = yield* row(id);
        expect(kept.hardDeleteAt).toBeNull();
        expect(kept.status).toBe("cancelled");
        expect(kept.cancellationReason).toBe("organiser");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "the event-cancellation sweeper deletes the host's own cancelled events after the window",
    () =>
      Effect.gen(function* () {
        const id = yield* hostedCancelled();
        yield* accountErasure.requestErasure({ profileId: PROFILE_ID, accountId: ACCOUNT_ID });
        const scheduled = yield* row(id);
        // Inside the window the row stays, so cancelErasure can still restore it.
        yield* accountErasure.runEventCancellationSweep({ nowMs: Date.now() });
        expect((yield* row(id))?.id).toBe(id);
        yield* accountErasure.runEventCancellationSweep({
          nowMs: (scheduled.hardDeleteAt! - 1) * 1_000,
        });
        expect((yield* row(id))?.id).toBe(id);
        yield* accountErasure.runEventCancellationSweep({
          nowMs: (scheduled.hardDeleteAt! + 1) * 1_000,
        });
        expect(yield* row(id)).toBeUndefined();
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("requestErasure and cancelErasure leave another host's cancelled events alone", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* seedPulseData();
      yield* hostedCancelled();
      const seedOther = (values: Partial<typeof events.$inferInsert>) =>
        Effect.gen(function* () {
          const event = yield* seedEvent({
            title: "Someone else's",
            startTime: new Date(Date.now() + 86_400_000),
            createdByProfileId: "usr_other",
          });
          yield* Effect.promise(() =>
            db
              .update(events)
              .set({ status: "cancelled", cancelledAt: 1_000, ...values })
              .where(eq(events.id, event.id)),
          );
          return event.id;
        });
      const otherOwn = yield* seedOther({ cancellationReason: "organiser", hardDeleteAt: null });
      const otherLeaving = yield* seedOther({
        cancellationReason: "host_left",
        hardDeleteAt: 9_999_999_999,
      });

      yield* accountErasure.requestErasure({ profileId: PROFILE_ID, accountId: ACCOUNT_ID });
      expect((yield* row(otherOwn)).hardDeleteAt).toBeNull();

      yield* accountErasure.cancelErasure(PROFILE_ID);
      const own = yield* row(otherOwn);
      expect(own.status).toBe("cancelled");
      expect(own.cancellationReason).toBe("organiser");
      expect(own.hardDeleteAt).toBeNull();
      const leaving = yield* row(otherLeaving);
      expect(leaving.status).toBe("cancelled");
      expect(leaving.cancelledAt).toBe(1_000);
      expect(leaving.cancellationReason).toBe("host_left");
      expect(leaving.hardDeleteAt).toBe(9_999_999_999);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("cancelErasure keeps a series-cancelled instance cancelled", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const { eventId } = yield* seedPulseData();
      yield* accountErasure.requestErasure({ profileId: PROFILE_ID, accountId: ACCOUNT_ID });
      // The organiser's series cancel takes the host-left row over (cancelSeries).
      yield* Effect.promise(() =>
        db.update(events).set({ cancellationReason: "organiser" }).where(eq(events.id, eventId)),
      );
      yield* accountErasure.cancelErasure(PROFILE_ID);
      const r = yield* row(eventId);
      expect(r.status).toBe("cancelled");
      expect(r.cancellationReason).toBe("organiser");
      expect(r.hardDeleteAt).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("pulse account-erasure: one pass over the host's events", () => {
  it.effect("requestErasure cancels and schedules the host's events in one UPDATE", () => {
    const { layer, captured } = createCapturingTestLayer();
    return Effect.gen(function* () {
      const { db } = yield* Db;
      const { eventId: liveId } = yield* seedPulseData();
      const ownCancel = yield* seedEvent({
        title: "Called off",
        startTime: new Date(Date.now() + 86_400_000),
        createdByProfileId: PROFILE_ID,
      });
      yield* Effect.promise(() =>
        db
          .update(events)
          .set({ status: "cancelled", cancelledAt: 1_000, cancellationReason: "organiser" })
          .where(eq(events.id, ownCancel.id)),
      );
      const finished = yield* seedEvent({
        title: "Done",
        startTime: new Date(Date.now() - 2 * 86_400_000),
        createdByProfileId: PROFILE_ID,
        status: "finished",
      });
      captured.length = 0;
      yield* accountErasure.requestErasure({ profileId: PROFILE_ID, accountId: ACCOUNT_ID });
      const eventWrites = captured.filter((c) => /^update "events"/i.test(c.sql.trimStart()));
      expect(eventWrites).toHaveLength(1);
      expect(statementKinds(captured)).toEqual(["select", "update", "insert"]);

      const read = (id: string) =>
        Effect.promise(() => db.select().from(events).where(eq(events.id, id))).pipe(
          Effect.map((rows) => rows[0]!),
        );
      const live = yield* read(liveId);
      expect(live.status).toBe("cancelled");
      expect(live.cancellationReason).toBe("host_left");
      expect(live.cancelledAt).toBeTypeOf("number");
      const own = yield* read(ownCancel.id);
      expect(own.status).toBe("cancelled");
      expect(own.cancellationReason).toBe("organiser");
      expect(own.cancelledAt).toBe(1_000);
      expect(own.hardDeleteAt).toBe(live.hardDeleteAt);
      const done = yield* read(finished.id);
      expect(done.status).toBe("finished");
      expect(done.hardDeleteAt).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("cancelErasure unschedules a host-left event whose status moved off cancelled", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const { eventId } = yield* seedPulseData();
      yield* accountErasure.requestErasure({ profileId: PROFILE_ID, accountId: ACCOUNT_ID });
      // A status write that left the leave's columns in place.
      yield* Effect.promise(() =>
        db.update(events).set({ status: "ongoing" }).where(eq(events.id, eventId)),
      );
      yield* accountErasure.cancelErasure(PROFILE_ID);
      const [r] = yield* Effect.promise(() =>
        db.select().from(events).where(eq(events.id, eventId)),
      );
      expect(r!.hardDeleteAt).toBeNull();
      expect(r!.cancellationReason).toBeNull();
      expect(r!.cancelledAt).toBeNull();
      expect(r!.status).toBe("upcoming");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
