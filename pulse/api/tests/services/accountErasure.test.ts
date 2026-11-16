import { it, expect, describe } from "@effect/vitest";
import {
  events,
  eventComms,
  eventLineup,
  eventRsvps,
  eventSeries,
  pulseAccountOnboarding,
  pulseCloseFriends,
  pulseDeletionJobs,
  pulseProfileAccounts,
  pulseUsers,
  pulseWebSessions,
} from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import * as accountErasure from "../../src/services/accountErasure";
import { updateEvent } from "../../src/services/events";
import {
  createCapturingTestLayer,
  createTestLayer,
  createTestLayerWithDb,
  seedEvent,
  statementKinds,
} from "../helpers/db";
import { holdQueries } from "../helpers/held-query";

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
  const DAY = 86_400;
  const soon = () => new Date(Date.now() + DAY * 1_000);

  const eventRow = (id: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [row] = yield* Effect.promise(() => db.select().from(events).where(eq(events.id, id)));
      return row;
    });

  const seedSeries = (id: string, createdByProfileId = PROFILE_ID) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = new Date();
      yield* Effect.promise(() =>
        db.insert(eventSeries).values({
          id,
          title: "Weekly run",
          rrule: "FREQ=WEEKLY",
          dtstart: now,
          materializedThrough: now,
          createdByProfileId,
          createdAt: now,
          updatedAt: now,
        }),
      );
    });

  it.effect(
    "keeps an upcoming hosted event for its guests by default, and erases the person's own data",
    () =>
      Effect.gen(function* () {
        const { eventId } = yield* seedPulseData();
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .insert(pulseAccountOnboarding)
            .values({ accountId: ACCOUNT_ID, interests: '["music"]' }),
        );
        yield* Effect.promise(() =>
          db.insert(pulseProfileAccounts).values({ profileId: PROFILE_ID, accountId: ACCOUNT_ID }),
        );
        const before = Math.floor(Date.now() / 1_000);

        const result = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);

        const kept = yield* eventRow(eventId);
        expect(kept).toMatchObject({ status: "cancelled", cancellationReason: "host_left" });
        expect(kept!.hardDeleteAt).toBeGreaterThanOrEqual(before + 14 * DAY);
        expect(result.kept).toEqual([
          {
            what: "1 event you hosted, shown to its guests as cancelled",
            erasedOn: kept!.hardDeleteAt,
            requestUrl: null,
          },
        ]);
        // The person's own data is gone, the kept event's included: their RSVP
        // and the message they sent on it.
        for (const table of [eventRsvps, eventComms, pulseUsers, pulseCloseFriends]) {
          expect(yield* Effect.promise(() => db.select().from(table))).toEqual([]);
        }
        expect(
          yield* Effect.promise(() =>
            db
              .select()
              .from(pulseAccountOnboarding)
              .where(eq(pulseAccountOnboarding.accountId, ACCOUNT_ID)),
          ),
        ).toEqual([]);
        expect(
          yield* Effect.promise(() =>
            db
              .select()
              .from(pulseProfileAccounts)
              .where(eq(pulseProfileAccounts.profileId, PROFILE_ID)),
          ),
        ).toEqual([]);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("deletes an event answered delete: on itself, on its series, or for all events", () =>
    Effect.gen(function* () {
      yield* seedSeries("srs_1");
      const own = yield* seedEvent({
        title: "Own",
        startTime: soon(),
        createdByProfileId: PROFILE_ID,
      });
      const inSeries = yield* seedEvent({
        title: "In series",
        startTime: soon(),
        createdByProfileId: PROFILE_ID,
        seriesId: "srs_1",
      });
      const overridden = yield* seedEvent({
        title: "Overridden",
        startTime: soon(),
        createdByProfileId: PROFILE_ID,
        seriesId: "srs_1",
      });
      const byAll = yield* seedEvent({
        title: "By all",
        startTime: soon(),
        createdByProfileId: PROFILE_ID,
      });

      const result = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID], {
        answers: {
          [`pulse:event:${own.id}`]: { choice: "delete" },
          "pulse:series:srs_1": { choice: "delete" },
          // Its own answer wins over its series'.
          [`pulse:event:${overridden.id}`]: { choice: "cancel" },
          // The rest: only "By all" has no answer of its own or its series'.
          "pulse:events:all": { choice: "delete" },
        },
      });

      expect(yield* eventRow(own.id)).toBeUndefined();
      expect(yield* eventRow(inSeries.id)).toBeUndefined();
      expect(yield* eventRow(byAll.id)).toBeUndefined();
      expect(yield* eventRow(overridden.id)).toMatchObject({ status: "cancelled", seriesId: null });
      expect(result.kept).toHaveLength(1);
      // The series goes; its kept instance is out of it.
      const { db } = yield* Db;
      expect(yield* Effect.promise(() => db.select().from(eventSeries))).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("an event's series answer comes before the answer for all events", () =>
    Effect.gen(function* () {
      yield* seedSeries("srs_kept");
      const inSeries = yield* seedEvent({
        title: "Weekly",
        startTime: soon(),
        createdByProfileId: PROFILE_ID,
        seriesId: "srs_kept",
      });
      const alone = yield* seedEvent({
        title: "Alone",
        startTime: soon(),
        createdByProfileId: PROFILE_ID,
      });

      yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID], {
        answers: {
          "pulse:series:srs_kept": { choice: "cancel" },
          "pulse:events:all": { choice: "delete" },
        },
      });

      expect(yield* eventRow(inSeries.id)).toMatchObject({ status: "cancelled" });
      expect(yield* eventRow(alone.id)).toBeUndefined();
    }).pipe(Effect.provide(createTestLayer())),
  );

  /** A test database whose statements can be held, with a layer over the held handle. */
  const held = () => {
    const { db } = createTestLayerWithDb();
    const queries = holdQueries(db);
    return { ...queries, layer: Layer.succeed(Db, { db: queries.db }) };
  };

  it("deletes, and does not report, a kept event a guest's visit marked finished after the read", async () => {
    const h = held();
    const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
      Effect.runPromise(effect.pipe(Effect.provide(h.layer)));
    const event = await run(
      seedEvent({ title: "Ends", startTime: soon(), createdByProfileId: PROFILE_ID }),
    );

    // The batch's first statement: the read is done, nothing written yet.
    const batch = h.hold(/^delete from "event_rsvps"/);
    const purge = run(accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]));
    await batch.reached;
    await run(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db.update(events).set({ status: "finished" }).where(eq(events.id, event.id)),
        );
      }),
    );
    batch.release();

    expect((await purge).kept).toEqual([]);
    expect(await run(eventRow(event.id))).toBeUndefined();
  });

  it("keeps, and reports, a cancellation made after the read as it was made", async () => {
    const h = held();
    const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
      Effect.runPromise(effect.pipe(Effect.provide(h.layer)));
    const event = await run(
      seedEvent({ title: "Left", startTime: soon(), createdByProfileId: PROFILE_ID }),
    );
    const leftUntil = Math.floor(Date.now() / 1_000) + 3 * DAY;

    const batch = h.hold(/^delete from "event_rsvps"/);
    const purge = run(accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]));
    await batch.reached;
    await run(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .update(events)
            .set({
              status: "cancelled",
              cancelledAt: 1_000,
              cancellationReason: "host_left",
              hardDeleteAt: leftUntil,
            })
            .where(eq(events.id, event.id)),
        );
      }),
    );
    batch.release();

    expect((await purge).kept).toEqual([
      {
        what: "1 event you hosted, shown to its guests as cancelled",
        erasedOn: leftUntil,
        requestUrl: null,
      },
    ]);
    expect(await run(eventRow(event.id))).toMatchObject({
      status: "cancelled",
      cancelledAt: 1_000,
      hardDeleteAt: leftUntil,
    });
  });

  it("two overlapping erasures of one account both answer the same kept list", async () => {
    const h = held();
    const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
      Effect.runPromise(effect.pipe(Effect.provide(h.layer)));
    const event = await run(
      seedEvent({ title: "Kept", startTime: soon(), createdByProfileId: PROFILE_ID }),
    );

    // The first call has read the ledger and the events; the second runs
    // whole before the first writes anything.
    const batch = h.hold(/^delete from "event_rsvps"/);
    const first = run(accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]));
    await batch.reached;
    const second = await run(accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]));
    const cancelledAt = (await run(eventRow(event.id)))!.cancelledAt;
    batch.release();

    const answered = await first;
    expect(second.kept).toHaveLength(1);
    expect(answered.kept).toEqual(second.kept);
    // The first call's late writes leave the second's cancellation as it was.
    expect(await run(eventRow(event.id))).toMatchObject({ status: "cancelled", cancelledAt });
  });

  it.effect("under delete everything deletes every hosted event and keeps nothing", () =>
    Effect.gen(function* () {
      const { eventId } = yield* seedPulseData();
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(eventLineup).values({
          id: "lnp_1",
          eventId,
          artistName: "DJ Test",
          role: "headliner",
          slotStart: new Date(),
          slotEnd: new Date(Date.now() + 3_600_000),
        }),
      );
      const result = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID], {
        answers: { [`pulse:event:${eventId}`]: { choice: "cancel" } },
        deleteEverything: true,
      });
      expect(yield* eventRow(eventId)).toBeUndefined();
      expect(yield* Effect.promise(() => db.select().from(eventLineup))).toEqual([]);
      expect(result.kept).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("deletes finished and cancelled hosted events whatever the answers", () =>
    Effect.gen(function* () {
      const finished = yield* seedEvent({
        title: "Done",
        startTime: new Date(Date.now() - DAY * 1_000),
        status: "finished",
        createdByProfileId: PROFILE_ID,
      });
      const cancelled = yield* seedEvent({
        title: "Off",
        startTime: soon(),
        status: "cancelled",
        createdByProfileId: PROFILE_ID,
      });
      const result = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(yield* eventRow(finished.id)).toBeUndefined();
      expect(yield* eventRow(cancelled.id)).toBeUndefined();
      expect(result.kept).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("leaves another host's events and series alone", () =>
    Effect.gen(function* () {
      yield* seedSeries("srs_other", "usr_other");
      const theirs = yield* seedEvent({
        title: "Theirs",
        startTime: soon(),
        createdByProfileId: "usr_other",
        seriesId: "srs_other",
      });
      yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID], { deleteEverything: true });
      expect(yield* eventRow(theirs.id)).toMatchObject({
        status: "upcoming",
        seriesId: "srs_other",
      });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("ends the person's web sessions", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.promise(() =>
        db.insert(pulseWebSessions).values({
          id: "pws_1",
          token: "hash-1",
          osnProfileId: PROFILE_ID,
          osnSub: "sub",
          expiresAt: new Date(Date.now() + DAY * 1_000),
          createdAt: new Date(),
        }),
      );
      yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(yield* Effect.promise(() => db.select().from(pulseWebSessions))).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a repeat writes nothing and answers the same kept list", () =>
    Effect.gen(function* () {
      yield* seedPulseData();
      const first = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(first.alreadyProcessed).toBe(false);
      const second = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(second.alreadyProcessed).toBe(true);
      expect(second.purged).toBe(0);
      expect(second.kept).toEqual(first.kept);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("answers one kept item for a long series, within the contract's bound", () =>
    Effect.gen(function* () {
      yield* seedSeries("srs_long");
      for (let i = 0; i < 260; i += 1) {
        yield* seedEvent({
          title: `Week ${i}`,
          startTime: new Date(Date.now() + (i + 1) * 7 * DAY * 1_000),
          createdByProfileId: PROFILE_ID,
          seriesId: "srs_long",
        });
      }
      const result = yield* accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0]!.what).toBe(
        "260 events you hosted, shown to their guests as cancelled",
      );
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("idempotent on empty profileIds", () =>
    Effect.gen(function* () {
      const r = yield* accountErasure.purgeAccount(ACCOUNT_ID, []);
      expect(r.purged).toBe(0);
      expect(r.kept).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("pulse account-erasure: previewDeletion", () => {
  const DELETES_AT = 1_900_000_000;
  const soon = (days: number) => new Date(Date.now() + days * 86_400_000);

  it.effect(
    "lists one action per series and per other upcoming event, soonest first, cancel by default",
    () =>
      Effect.gen(function* () {
        const { db } = yield* Db;
        const now = new Date();
        yield* Effect.promise(() =>
          db.insert(eventSeries).values({
            id: "srs_1",
            title: "Weekly run",
            rrule: "FREQ=WEEKLY",
            dtstart: now,
            materializedThrough: now,
            createdByProfileId: PROFILE_ID,
            createdAt: now,
            updatedAt: now,
          }),
        );
        const picnic = yield* seedEvent({
          title: "Picnic",
          startTime: soon(1),
          createdByProfileId: PROFILE_ID,
        });
        yield* seedEvent({
          title: "Run 1",
          startTime: soon(2),
          createdByProfileId: PROFILE_ID,
          seriesId: "srs_1",
        });
        yield* seedEvent({
          title: "Run 2",
          startTime: soon(9),
          createdByProfileId: PROFILE_ID,
          seriesId: "srs_1",
        });
        yield* seedEvent({
          title: "Old",
          startTime: soon(-1),
          status: "finished",
          createdByProfileId: PROFILE_ID,
        });
        yield* seedEvent({
          title: "Off",
          startTime: soon(3),
          status: "cancelled",
          createdByProfileId: PROFILE_ID,
        });
        yield* seedEvent({
          title: "Not mine",
          startTime: soon(1),
          createdByProfileId: "usr_other",
        });

        const actions = yield* accountErasure.previewDeletion([PROFILE_ID], DELETES_AT);

        expect(actions.map((a) => [a.id, a.label])).toEqual([
          [
            `pulse:event:${picnic.id}`,
            `You host "Picnic", starting ${soon(1).toISOString().slice(0, 10)}.`,
          ],
          ["pulse:series:srs_1", 'You host 2 upcoming events of "Weekly run".'],
        ]);
        for (const action of actions) {
          expect(action.defaultChoice).toBe("cancel");
          expect(action.choices.map((c) => [c.choice, c.erasedOn])).toEqual([
            ["cancel", DELETES_AT + 14 * 86_400],
            ["delete", null],
          ]);
        }
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("lists nothing for a profile that hosts nothing", () =>
    Effect.gen(function* () {
      yield* seedEvent({ title: "Not mine", startTime: soon(1), createdByProfileId: "usr_other" });
      expect(yield* accountErasure.previewDeletion([PROFILE_ID], DELETES_AT)).toEqual([]);
      expect(yield* accountErasure.previewDeletion([], DELETES_AT)).toEqual([]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it("reads at most 101 rows, one per series or other event, however many events the host holds", async () => {
    const { layer, captured } = createCapturingTestLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let i = 0; i < 120; i += 1) {
          yield* seedEvent({
            title: `E${i}`,
            startTime: soon(i + 1),
            createdByProfileId: PROFILE_ID,
          });
        }
        captured.length = 0;
        const actions = yield* accountErasure.previewDeletion([PROFILE_ID], DELETES_AT);
        expect(actions.map((a) => a.label)).toEqual(["You host 120 upcoming events."]);
      }).pipe(Effect.provide(layer)),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toMatch(/group by .* limit \?$/);
    expect(captured[0]!.params.at(-1)).toBe(101);
  });

  it.effect("lists 100 events as 100 actions", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 100; i += 1) {
        yield* seedEvent({
          title: `E${i}`,
          startTime: soon(i + 1),
          createdByProfileId: PROFILE_ID,
        });
      }
      const actions = yield* accountErasure.previewDeletion([PROFILE_ID], DELETES_AT);
      expect(actions).toHaveLength(100);
      expect(actions.every((a) => a.id.startsWith("pulse:event:"))).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("past 100 actions, lists one action for every upcoming event", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 101; i += 1) {
        yield* seedEvent({
          title: `E${i}`,
          startTime: soon(i + 1),
          createdByProfileId: PROFILE_ID,
        });
      }
      const actions = yield* accountErasure.previewDeletion([PROFILE_ID], DELETES_AT);
      expect(actions.map((a) => [a.id, a.label])).toEqual([
        ["pulse:events:all", "You host 101 upcoming events."],
      ]);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("pulse account-erasure: revokeWebSessions", () => {
  it.effect("deletes the profiles' web sessions and nobody else's", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const session = (id: string, osnProfileId: string) => ({
        id,
        token: `hash-${id}`,
        osnProfileId,
        osnSub: "sub",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      });
      yield* Effect.promise(() =>
        db
          .insert(pulseWebSessions)
          .values([
            session("pws_1", PROFILE_ID),
            session("pws_2", PROFILE_ID),
            session("pws_3", "usr_other"),
          ]),
      );
      expect(yield* accountErasure.revokeWebSessions([PROFILE_ID])).toBe(2);
      const left = yield* Effect.promise(() =>
        db.select({ id: pulseWebSessions.id }).from(pulseWebSessions),
      );
      expect(left).toEqual([{ id: "pws_3" }]);
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

  it("a leave cancel that lands as the account erasure runs leaves the erasure's kept event cancelled", async () => {
    const { db } = createTestLayerWithDb();
    const h = holdQueries(db);
    const layer = Layer.succeed(Db, { db: h.db });
    const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)));
    const now = Math.floor(Date.now() / 1_000);
    const event = await run(
      seedEvent({
        title: "Kept",
        startTime: new Date(Date.now() + 86_400_000),
        createdByProfileId: PROFILE_ID,
      }),
    );
    await db.insert(pulseDeletionJobs).values({
      profileId: PROFILE_ID,
      accountId: ACCOUNT_ID,
      softDeletedAt: now,
      hardDeleteAt: now + 7 * 86_400,
      enrollmentNotifyDoneAt: null,
      reason: "user_request",
    });

    // The cancel has read its job and is about to write.
    const write = h.hold(/^update "events"/);
    const cancel = run(accountErasure.cancelErasure(PROFILE_ID));
    await write.reached;
    const purged = await run(accountErasure.purgeAccount(ACCOUNT_ID, [PROFILE_ID]));
    expect(purged.kept).toHaveLength(1);
    write.release();
    await cancel;

    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row).toMatchObject({ status: "cancelled", cancellationReason: "host_left" });
    expect(row!.hardDeleteAt).toBe(purged.kept[0]!.erasedOn);
  });

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
