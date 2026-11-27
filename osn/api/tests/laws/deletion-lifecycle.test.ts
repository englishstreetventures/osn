import { accounts, deletionJobs, handleHolds, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it, vi } from "vitest";

import { handleArms, makeHeldHandleDigest } from "../../src/lib/handle-hold";
import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import {
  cancelErasure,
  requestErasure,
  runFanOutRetrySweep,
  runHardDeleteSweep,
} from "../../src/services/account-erasure";
import type { DeletionApp } from "../../src/services/deletion-apps";
import { createTestLayerWithSqlite } from "../helpers/db";
import { appStandIns, type AppCall } from "../helpers/deletion-apps";
import {
  type Acct,
  type AcctEv,
  type H,
  type Hold,
  type HoldEv,
  type Mark,
  type Reply,
  type Req,
  list,
  model,
  seeded,
} from "./model";

/**
 * The account-deletion model (laws/account-deletion/account.bend, holds.bend)
 * against osn-api's services. Each trace is a list of events: a request, a
 * cancel, a fan-out pass with each app's reply, a hard-delete pass, and
 * another account trying the deleted account's handle. Every event goes
 * through the model and through requestErasure, cancelErasure,
 * runFanOutRetrySweep, runHardDeleteSweep and the handle check every
 * registration path runs (handleArms) on bun:sqlite, with the apps answered by
 * stand-ins, and the two must agree after every event: the account, its job
 * and every app's mark, the erasure calls each app received, the handle's hold
 * and who holds the handle.
 *
 * Every request here passes the route's checks: requestErasure applies no
 * verdict, so the verdict is compared through the route in
 * deletion-request.test.ts.
 */

const digest = makeHeldHandleDigest(undefined);
const HANDLE = "keepme";
const ERASED = 1;
const CLAIMANT = 2;
const DAY = 86_400;
const START = 1_900_000_000;
const APPS = ["pulse", "zap", "cire"] as const satisfies ReadonlyArray<DeletionApp>;

/** What the apps answer the next fan-out pass. */
let replies: Record<DeletionApp, Reply["$"]> = {
  pulse: "Answers",
  zap: "Answers",
  cire: "Answers",
};
const apps = appStandIns((call) =>
  call.path === "/internal/account-deleted" && replies[call.app] === "Fails"
    ? { status: 503, body: { error: "not_finished" } }
    : undefined,
);
afterAll(() => apps.stop());

const reply = (r: Reply["$"]): Reply => ({ $: r }) as Reply;
const accept = (everything: boolean): Req => ({
  $: "Req",
  orgs: list([]),
  apps: list([]),
  picks: list([]),
  everything,
  unchecked: false,
});

/** The event, and the time it happens at, in a form a failure message can print. */
type Event =
  | { kind: "ask"; now: number; everything: boolean }
  | { kind: "keep"; now: number }
  | { kind: "fanout"; now: number; replies: Record<DeletionApp, Reply["$"]> }
  | { kind: "sweep"; now: number }
  | { kind: "claim"; now: number };

interface World {
  readonly layer: Layer.Layer<Db>;
  readonly accountId: string;
  readonly claimantId: string;
  acct: Acct;
  hold: H;
  /** The code's `job_id` for each model job, by the model's job number. */
  readonly jobIds: Map<number, string>;
}

const run = <A, E>(w: World, effect: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(w.layer)));

const atTime = (now: number) => vi.setSystemTime(now * 1_000);

async function world(): Promise<World> {
  _resetOutboundKeyForTests();
  const { layer } = createTestLayerWithSqlite();
  const accountId = `acc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const claimantId = `acc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const w: World = {
    layer,
    accountId,
    claimantId,
    acct: model["account:init"](),
    hold: model["holds:start"](ERASED),
    jobIds: new Map(),
  };
  await run(
    w,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = new Date(START * 1_000);
      for (const [id, email] of [
        [accountId, "erased@example.com"],
        [claimantId, "claimant@example.com"],
      ] as const) {
        yield* Effect.promise(() =>
          db.insert(accounts).values({
            id,
            email,
            passkeyUserId: crypto.randomUUID(),
            maxProfiles: 5,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      yield* Effect.promise(() =>
        db.insert(users).values({
          id: `usr_${accountId.slice(4)}`,
          accountId,
          handle: HANDLE,
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }),
  );
  return w;
}

/** The hold event an account transition implies, if any. */
const holdEventOf = (before: Acct, after: Acct, now: number): HoldEv | null => {
  if (before.$ === "Live" && after.$ === "Scheduled") return { $: "Delete", acct: ERASED, now };
  if (before.$ === "Scheduled" && after.$ === "Live") return { $: "Restore", acct: ERASED, now };
  if (before.$ === "Scheduled" && after.$ === "Erased") return { $: "Erase", acct: ERASED, now };
  return null;
};

const markOf = (done: number | null, outcome: unknown): Mark["$"] => {
  if (done === null || done <= 0) return "Pending";
  return (outcome as { status?: string } | undefined)?.status === "skipped"
    ? "Skipped"
    : "Confirmed";
};

/** The account as the database holds it, in the model's terms. */
async function codeAccount(w: World): Promise<Record<string, unknown>> {
  return run(
    w,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [account] = yield* Effect.promise(() =>
        db.select().from(accounts).where(eq(accounts.id, w.accountId)),
      );
      const [job] = yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, w.accountId)),
      );
      if (!account) return { $: job ? "erased with a job left" : "Erased" };
      if (!job) return { $: account.deletedAt === null ? "Live" : "tombstone with no job" };
      if (account.deletedAt === null) return { $: "job with no tombstone" };
      const outcomes = JSON.parse(job.appOutcomes ?? "{}") as Record<string, unknown>;
      return {
        $: "Scheduled",
        due: job.hardDeleteAt,
        claimed: job.purgeStartedAt !== null,
        pulse: markOf(job.pulseDoneAt, outcomes.pulse),
        zap: markOf(job.zapDoneAt, outcomes.zap),
        cire: markOf(job.cireDoneAt, outcomes.cire),
        everything: job.deleteEverything,
        jobId: job.jobId,
      };
    }),
  );
}

const modelAccount = (s: Acct): Record<string, unknown> =>
  s.$ === "Scheduled"
    ? {
        $: "Scheduled",
        due: s.due,
        claimed: s.claimed,
        pulse: s.pulse.$,
        zap: s.zap.$,
        cire: s.cire.$,
        everything: s.everything,
      }
    : { $: s.$ };

/** The hold and the handle's holder as the database has them, in the model's terms. */
async function codeHold(w: World): Promise<{ hold: Hold; owner: number | null }> {
  return run(
    w,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [row] = yield* Effect.promise(() =>
        db
          .select()
          .from(handleHolds)
          .where(eq(handleHolds.handle, digest(HANDLE))),
      );
      const [holder] = yield* Effect.promise(() =>
        db.select({ accountId: users.accountId }).from(users).where(eq(users.handle, HANDLE)),
      );
      const hold: Hold = !row
        ? { $: "Free" }
        : row.releaseAt === null
          ? { $: "Held", acct: row.accountId === w.accountId ? ERASED : -1 }
          : { $: "Until", release: row.releaseAt };
      const owner = !holder
        ? null
        : holder.accountId === w.accountId
          ? ERASED
          : holder.accountId === w.claimantId
            ? CLAIMANT
            : -1;
      return { hold, owner };
    }),
  );
}

const modelOwner = (s: H): number | null => (s.owner.$ === "Some" ? s.owner.value : null);

/** Applies one event to the code; answers the tag of the error requestErasure failed with, if it did. */
async function applyToCode(w: World, e: Event): Promise<string | null> {
  atTime(e.now);
  switch (e.kind) {
    case "ask": {
      const result = await run(
        w,
        Effect.result(
          requestErasure({
            accountId: w.accountId,
            cancel: null,
            heldHandleDigest: digest,
            deleteEverything: e.everything,
          }),
        ),
      );
      return result._tag === "Failure" ? result.failure._tag : null;
    }
    case "keep":
      await run(w, cancelErasure(w.accountId));
      return null;
    case "fanout": {
      replies = e.replies;
      const absent = APPS.filter((app) => e.replies[app] === "Absent");
      const base = apps.config();
      await run(
        w,
        runFanOutRetrySweep({
          config: {
            ...base,
            urls: Object.fromEntries(
              APPS.filter((app) => !absent.includes(app)).map((app) => [app, base.urls[app]]),
            ),
            absent: new Set(absent),
          },
          nowMs: e.now * 1_000,
        }),
      );
      return null;
    }
    case "sweep":
      await run(w, runHardDeleteSweep({ nowMs: e.now * 1_000 }));
      return null;
    case "claim":
      return run(
        w,
        Effect.gen(function* () {
          const { db } = yield* Db;
          const taken = yield* Effect.promise(() =>
            unionAll(...handleArms(db, digest, HANDLE, e.now)),
          );
          if (taken.length > 0) return null;
          // What profile creation writes once the handle check finds it free.
          yield* Effect.promise(() =>
            db.insert(users).values({
              id: `usr_${w.claimantId.slice(4)}`,
              accountId: w.claimantId,
              handle: HANDLE,
              isDefault: true,
              createdAt: new Date(e.now * 1_000),
              updatedAt: new Date(e.now * 1_000),
            }),
          );
          return null;
        }),
      );
  }
}

const toModel = (w: World, e: Event): AcctEv | HoldEv => {
  switch (e.kind) {
    case "ask":
      return { $: "Ask", now: e.now, req: accept(e.everything) };
    case "keep":
      // The cancel reads the job that stands; a cancel that read a replaced
      // job is a race inside one call, which this test does not drive.
      return { $: "Keep", now: e.now, read: w.acct.$ === "Scheduled" ? w.acct.job : 0 };
    case "fanout":
      return {
        $: "FanOut",
        now: e.now,
        pulse: reply(e.replies.pulse),
        zap: reply(e.replies.zap),
        cire: reply(e.replies.cire),
      };
    case "sweep":
      return { $: "Sweep", now: e.now };
    case "claim":
      return { $: "Claim", acct: CLAIMANT, now: e.now };
  }
};

/** Runs `trace` through both and checks them against each other after every event. */
async function expectModelAgrees(trace: ReadonlyArray<Event>): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const w = await world();
    for (const [i, e] of trace.entries()) {
      const at = `event ${i} of ${JSON.stringify(trace)}`;
      const before = w.acct;
      const calls = apps.calls.length;
      const refusal = await applyToCode(w, e);
      const step = toModel(w, e);
      if (step.$ === "Claim") {
        w.hold = model["holds:step"](w.hold, step);
      } else {
        w.acct = model["account:step"](w.acct, step as AcctEv);
        const held = holdEventOf(before, w.acct, e.now);
        if (held) w.hold = model["holds:step"](w.hold, held);
      }

      const { jobId, ...account } = await codeAccount(w);
      // A new job in the model is a job_id the code never used before; a
      // job the model keeps keeps its job_id.
      const job = w.acct.$ === "Scheduled" ? w.acct.job : null;
      const known = job === null ? undefined : w.jobIds.get(job);
      const jobIdHolds =
        job === null ||
        (known === undefined ? ![...w.jobIds.values()].includes(jobId as string) : jobId === known);
      if (job !== null && known === undefined) w.jobIds.set(job, jobId as string);

      // The erasure call reaches exactly the apps whose marks the model moved
      // from pending this event, with the request's own "delete everything".
      const erasures = apps.calls
        .slice(calls)
        .filter((call: AppCall) => call.path === "/internal/account-deleted");
      const sent =
        before.$ === "Scheduled" &&
        e.kind === "fanout" &&
        w.acct.$ === "Scheduled" &&
        w.acct.claimed
          ? APPS.filter((app) => before[app].$ === "Pending" && e.replies[app] !== "Absent")
          : [];
      const everything = before.$ === "Scheduled" && before.everything;

      const { hold, owner } = await codeHold(w);
      expect({
        at,
        refusal,
        account,
        jobIdHolds,
        erasures: erasures.map((call) => call.app).toSorted(),
        everything: erasures.map((call) => call.body.deleteEverything),
        hold,
        owner,
      }).toEqual({
        at,
        // requestErasure refuses only an account already gone.
        refusal: e.kind === "ask" && before.$ === "Erased" ? "AccountNotFoundError" : null,
        account: modelAccount(w.acct),
        jobIdHolds: true,
        erasures: sent.toSorted(),
        everything: sent.map(() => everything),
        hold: w.hold.hold,
        owner: modelOwner(w.hold),
      });
    }
  } finally {
    vi.useRealTimers();
  }
}

const all = (r: Reply["$"]): Record<DeletionApp, Reply["$"]> => ({ pulse: r, zap: r, cire: r });
const due = START + 7 * DAY;

describe("the deletion model and osn-api agree", () => {
  it("erases on the window's last second and not the second before", async () => {
    await expectModelAgrees([
      { kind: "ask", now: START, everything: false },
      { kind: "fanout", now: due - 1, replies: all("Answers") },
      { kind: "sweep", now: due - 1 },
      { kind: "fanout", now: due, replies: all("Answers") },
      { kind: "sweep", now: due },
    ]);
  });

  it("holds the erasure while an app fails, and erases once it answers", async () => {
    await expectModelAgrees([
      { kind: "ask", now: START, everything: true },
      { kind: "fanout", now: due, replies: { pulse: "Answers", zap: "Fails", cire: "Absent" } },
      { kind: "sweep", now: due + 1 },
      { kind: "fanout", now: due + 2, replies: all("Fails") },
      { kind: "fanout", now: due + 3, replies: all("Answers") },
      { kind: "sweep", now: due + 4 },
    ]);
  });

  it("restores the second before the window ends, and not after a pass has claimed the job", async () => {
    await expectModelAgrees([
      { kind: "ask", now: START, everything: false },
      { kind: "keep", now: due - 1 },
      { kind: "ask", now: due, everything: false },
      { kind: "keep", now: due + 7 * DAY },
      { kind: "fanout", now: due + 7 * DAY, replies: all("Fails") },
      { kind: "keep", now: due + 7 * DAY + 1 },
    ]);
  });

  it("refuses the handle to another account while held and for thirty days after the erasure", async () => {
    const erasedAt = due + 10;
    await expectModelAgrees([
      { kind: "claim", now: START },
      { kind: "ask", now: START + 1, everything: false },
      { kind: "claim", now: START + 2 },
      { kind: "fanout", now: due, replies: all("Answers") },
      { kind: "sweep", now: erasedAt },
      { kind: "claim", now: erasedAt + 30 * DAY - 1 },
      { kind: "claim", now: erasedAt + 30 * DAY },
    ]);
  });

  it("gives a restored account its handle back and its hold up", async () => {
    await expectModelAgrees([
      { kind: "ask", now: START, everything: false },
      { kind: "claim", now: START + 5 },
      { kind: "keep", now: START + 6 },
      { kind: "claim", now: START + 7 },
      { kind: "ask", now: START + 8, everything: true },
      { kind: "fanout", now: START + 8 + 7 * DAY, replies: all("Absent") },
      { kind: "sweep", now: START + 8 + 7 * DAY },
    ]);
  });

  // Seeded traces. Each event's time is drawn around the edges the model is
  // at: the pending job's window end, the hold's release, or a little after
  // the last event; every reply mix. The model runs alongside the draw only
  // to know where those edges are.
  const traceFrom = (seed: number): Event[] => {
    const rand = seeded(seed);
    const events: Event[] = [];
    let acct = model["account:init"]();
    let hold = model["holds:start"](ERASED);
    let now = START;
    const length = 8 + rand.int(12);
    for (let i = 0; i < length; i++) {
      const edges = [now, now + 1, now + DAY];
      if (acct.$ === "Scheduled") edges.push(acct.due - DAY, acct.due - 1, acct.due, acct.due + 1);
      if (hold.hold.$ === "Until")
        edges.push(hold.hold.release - 1, hold.hold.release, hold.hold.release + DAY);
      now = Math.max(now, rand.pick(edges));
      // Once the account is gone, only another account's claim can still
      // change anything.
      const kind =
        acct.$ === "Erased"
          ? rand.pick(["claim", "claim", "claim", "ask"] as const)
          : rand.pick([
              "ask",
              "ask",
              "keep",
              "keep",
              "fanout",
              "fanout",
              "sweep",
              "claim",
            ] as const);
      const e: Event =
        kind === "ask"
          ? { kind, now, everything: rand.chance(0.5) }
          : kind === "fanout"
            ? {
                kind,
                now,
                replies: {
                  pulse: rand.pick(["Answers", "Fails", "Absent"] as const),
                  zap: rand.pick(["Answers", "Fails", "Absent"] as const),
                  cire: rand.pick(["Answers", "Fails", "Absent"] as const),
                },
              }
            : { kind, now };
      events.push(e);
      const before = acct;
      const step = toModel({ acct } as World, e);
      if (step.$ === "Claim") {
        hold = model["holds:step"](hold, step);
      } else {
        acct = model["account:step"](acct, step as AcctEv);
        const held = holdEventOf(before, acct, now);
        if (held) hold = model["holds:step"](hold, held);
      }
    }
    return events;
  };

  // The draw must keep reaching every transition, or a trace that would have
  // caught a change to it never runs.
  it("the seeded traces reach every account transition, and a claim both refused and granted", () => {
    const reached = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      let acct = model["account:init"]();
      let hold = model["holds:start"](ERASED);
      for (const e of traceFrom(seed)) {
        const step = toModel({ acct } as World, e);
        if (step.$ === "Claim") {
          const after = model["holds:step"](hold, step);
          reached.add(after.owner.$ === hold.owner.$ ? "claim refused" : "claim granted");
          hold = after;
        } else {
          const before = acct;
          acct = model["account:step"](acct, step as AcctEv);
          if (before.$ !== acct.$) reached.add(`${before.$} to ${acct.$}`);
          if (
            before.$ === "Scheduled" &&
            acct.$ === "Scheduled" &&
            !before.claimed &&
            acct.claimed
          ) {
            reached.add("claimed");
          }
          const held = holdEventOf(before, acct, e.now);
          if (held) hold = model["holds:step"](hold, held);
        }
      }
    }
    expect([...reached].toSorted()).toEqual(
      [
        "Live to Scheduled",
        "Scheduled to Live",
        "Scheduled to Erased",
        "claimed",
        "claim refused",
        "claim granted",
      ].toSorted(),
    );
  });

  for (let seed = 1; seed <= 40; seed++) {
    it(`agrees on seeded trace ${seed}`, async () => {
      await expectModelAgrees(traceFrom(seed));
    });
  }
});
