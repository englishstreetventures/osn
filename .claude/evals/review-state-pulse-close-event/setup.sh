#!/usr/bin/env bash
# Make a new Pulse service function, an organiser closing an ongoing event
# early, a reviewable branch diff.
#
# The base is the pinned commit as it stands. The branch appends one function
# to `pulse/api/src/services/events.ts`, adds a test file for it and a
# changeset. Every other writer of the same rows stays on the base, out of the
# diff, where a reviewer has to go and find them. The function is appended
# with `cat >>`, not patched in with `sed -i`, which differs between GNU and
# BSD.
#
# The ground truth is in `graders/` and is not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 47bfe10ac1a15cf318d037ef6c00b9fd1f7e329c
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/pulse-close-event

cat >> pulse/api/src/services/events.ts <<'SERVICE'

/**
 * Closes an ongoing event early: the organiser ends it now. Its end time
 * becomes now and its status `finished`, which `deriveStatus` treats as
 * terminal, so the event stays closed on every later read.
 */
export const closeEvent = (
  id: string,
  requestingProfileId: string,
): Effect.Effect<Event, EventNotFound | NotEventOwner | ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const rows = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db.select().from(events).where(eq(events.id, id)).limit(1) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    const existing = rows[0];
    if (!existing) return yield* Effect.fail(new EventNotFound({ id }));
    if (existing.createdByProfileId !== requestingProfileId) {
      metricEventUpdated("forbidden");
      return yield* Effect.fail(new NotEventOwner({ id }));
    }

    // The stored status can lag the clock, so the decision is taken on the
    // derived one: an event past its start can be closed before any read has
    // persisted `ongoing`.
    const now = new Date();
    const current = deriveStatus(existing, now);
    if (current !== "ongoing" && current !== "maybe_finished") {
      metricEventUpdated("conflict");
      return yield* Effect.fail(
        new ValidationError({ cause: `only an ongoing event can be closed, not ${current}` }),
      );
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(events)
          .set({ status: "finished", endTime: now, updatedAt: now })
          .where(eq(events.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricEventUpdated("ok");
    return { ...existing, status: "finished" as const, endTime: now, updatedAt: now };
  }).pipe(Effect.withSpan("events.close"));
SERVICE

cat > pulse/api/tests/services/closeEvent.test.ts <<'TEST'
import { expect, it } from "@effect/vitest";
import { events } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { closeEvent } from "../../src/services/events";
import { createTestLayer, seedEvent } from "../helpers/db";

const STARTED = new Date(Date.now() - 60_000).toISOString();
const FUTURE = "2030-06-01T10:00:00.000Z";

const storedStatus = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* Effect.promise(() => db.select().from(events).where(eq(events.id, id)));
    return row?.status;
  });

it.effect("closeEvent finishes an ongoing event now", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Gig", startTime: STARTED, status: "ongoing" });
    const closed = yield* closeEvent(event.id, event.createdByProfileId);
    expect(closed.status).toBe("finished");
    expect(closed.endTime).not.toBeNull();
    expect(yield* storedStatus(event.id)).toBe("finished");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("closeEvent closes a started event whose stored status still reads upcoming", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Gig", startTime: STARTED });
    yield* closeEvent(event.id, event.createdByProfileId);
    expect(yield* storedStatus(event.id)).toBe("finished");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("closeEvent refuses an event that has not started", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Gig", startTime: FUTURE });
    const err = yield* Effect.flip(closeEvent(event.id, event.createdByProfileId));
    expect(err._tag).toBe("ValidationError");
    expect(yield* storedStatus(event.id)).toBe("upcoming");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("closeEvent refuses a cancelled event", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Gig", startTime: STARTED, status: "cancelled" });
    const err = yield* Effect.flip(closeEvent(event.id, event.createdByProfileId));
    expect(err._tag).toBe("ValidationError");
    expect(yield* storedStatus(event.id)).toBe("cancelled");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("closeEvent refuses anyone but the organiser", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Gig", startTime: STARTED, status: "ongoing" });
    const err = yield* Effect.flip(closeEvent(event.id, "usr_mallory"));
    expect(err._tag).toBe("NotEventOwner");
    expect(yield* storedStatus(event.id)).toBe("ongoing");
  }).pipe(Effect.provide(createTestLayer())),
);
TEST

cat > .changeset/pulse-close-event.md <<'CHANGESET'
---
"@pulse/api": minor
---

Add `closeEvent`, which lets an event's organiser end an ongoing event early:
its end time becomes now and it reads as finished from then on.
CHANGESET

git add -A
git commit -qm "feat(pulse-api): let an organiser close an ongoing event early"

git config branch.feat/pulse-close-event.gh-merge-base main
