import { it } from "@effect/vitest";
import { accounts, deletionJobs, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect, Logger } from "effect";
import { afterAll, afterEach, describe, expect, vi } from "vitest";

import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import * as metrics from "../../src/metrics";
import {
  DELETION_SWEEP_DEFAULT_MAX_JOBS,
  deletionSweepMaxJobs,
  runFanOutRetrySweep,
  runHardDeleteSweep,
} from "../../src/services/account-erasure";
import {
  createCapturingTestLayer,
  createTestLayer,
  createTestLayerWithSqlite,
} from "../helpers/db";
import { appStandIns, type AppAnswer, type AppCall } from "../helpers/deletion-apps";

/**
 * The fan-out at the end of the window: every app, for every account, with the
 * person's answers to that app's actions, their email address and whether they
 * chose to delete everything; what each app kept is stored on the job in the
 * statement that marks it done. An app that does not finish leaves its mark
 * pending and its job behind the ones that never failed.
 */

const NOW = 2_000_000_000;
const nowMs = NOW * 1_000;

afterEach(() => {
  _resetOutboundKeyForTests();
  vi.restoreAllMocks();
});

let answer: (call: AppCall) => AppAnswer | undefined = () => undefined;
const apps = appStandIns((call) => answer(call));
afterAll(() => apps.stop());

/** Every structured log line written while `effect` runs. */
const logLines = () => {
  const lines: { level: string; message: unknown }[] = [];
  const layer = Logger.layer([
    Logger.map(Logger.formatStructured, (line) => void lines.push(line)),
  ]);
  return { lines, layer };
};

const erasures = (accountId: string) =>
  apps.calls.filter(
    (call) => call.path === "/internal/account-deleted" && call.body.accountId === accountId,
  );

/** An account with one profile and a job past its window, with `job` on top. */
const dueAccount = (
  name: string,
  job: Partial<typeof deletionJobs.$inferInsert> = {},
): Effect.Effect<{ accountId: string; profileId: string }, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const accountId = `acc_${name}`;
    const profileId = `usr_${name}`;
    const now = new Date();
    yield* Effect.promise(() =>
      db.insert(accounts).values({
        id: accountId,
        email: `${name}@example.com`,
        passkeyUserId: crypto.randomUUID(),
        maxProfiles: 5,
        createdAt: now,
        updatedAt: now,
        deletedAt: NOW - 8 * 86_400,
      }),
    );
    yield* Effect.promise(() =>
      db.insert(users).values({
        id: profileId,
        accountId,
        handle: `deleted_${name}`,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
    yield* Effect.promise(() =>
      db.insert(deletionJobs).values({
        accountId,
        softDeletedAt: NOW - 8 * 86_400,
        hardDeleteAt: NOW - 86_400,
        reason: "user_request",
        ...job,
      }),
    );
    return { accountId, profileId };
  });

const jobOf = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* Effect.promise(() =>
      db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)),
    );
    return row!;
  });

describe("the deletion fan-out", () => {
  it.effect(
    "sends each app its own answers and the delete-everything flag, no email, and stores what it kept",
    () =>
      Effect.gen(function* () {
        const kept = [
          {
            what: "1 event you hosted, shown as cancelled",
            erasedOn: NOW + 86_400,
            requestUrl: null,
          },
        ];
        answer = (call) =>
          call.app === "pulse" && call.path === "/internal/account-deleted"
            ? { body: { kept } }
            : undefined;
        const { accountId, profileId } = yield* dueAccount("sent", {
          choices: JSON.stringify({
            "pulse:event:evt_1": { choice: "delete" },
            "osn:organisation:org_1": { choice: "transfer" },
          }),
        });

        yield* runFanOutRetrySweep({ config: apps.config(), nowMs });

        const calls = erasures(accountId);
        expect(calls.map((call) => call.app).toSorted()).toEqual(["pulse", "zap"]);
        const pulse = calls.find((call) => call.app === "pulse")!;
        // Neither app keeps data a person may ask about by email, so neither
        // is sent the address.
        expect(pulse.body).toEqual({
          accountId,
          profileIds: [profileId],
          choices: { "pulse:event:evt_1": { choice: "delete" } },
          deleteEverything: false,
        });
        expect(pulse.authorization).toMatch(/^ARC /);
        const zap = calls.find((call) => call.app === "zap")!;
        expect(zap.body.choices).toEqual({});
        expect(zap.body).not.toHaveProperty("email");

        const job = yield* jobOf(accountId);
        expect(job.pulseDoneAt).toBeGreaterThan(0);
        expect(job.zapDoneAt).toBeGreaterThan(0);
        expect(JSON.parse(job.appOutcomes!)).toEqual({
          pulse: { status: "done", kept },
          zap: { status: "done", kept: [] },
        });
        expect(job.fanoutFailedAt).toBeNull();
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("sends delete everything to every app", () =>
    Effect.gen(function* () {
      answer = () => undefined;
      const { accountId } = yield* dueAccount("everything", { deleteEverything: true });
      yield* runFanOutRetrySweep({ config: apps.config(), nowMs });
      expect(erasures(accountId).map((call) => call.body.deleteEverything)).toEqual([true, true]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "sends a job written before every account went to every app (`-1` marks) to both apps",
    () =>
      Effect.gen(function* () {
        answer = () => undefined;
        const { accountId } = yield* dueAccount("old", { pulseDoneAt: -1, zapDoneAt: -1 });
        yield* runFanOutRetrySweep({ config: apps.config(), nowMs });
        expect(erasures(accountId)).toHaveLength(2);
        const job = yield* jobOf(accountId);
        expect(job.pulseDoneAt).toBeGreaterThan(0);
        expect(job.zapDoneAt).toBeGreaterThan(0);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("calls no app already done, and keeps its mark and its outcome", () =>
    Effect.gen(function* () {
      answer = () => undefined;
      const { accountId } = yield* dueAccount("half", {
        pulseDoneAt: 1_700_000_000,
        appOutcomes: JSON.stringify({ pulse: { status: "done", kept: [] } }),
      });
      yield* runFanOutRetrySweep({ config: apps.config(), nowMs });
      expect(erasures(accountId).map((call) => call.app)).toEqual(["zap"]);
      const job = yield* jobOf(accountId);
      expect(job.pulseDoneAt).toBe(1_700_000_000);
      expect(Object.keys(JSON.parse(job.appOutcomes!)).toSorted()).toEqual(["pulse", "zap"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("marks an app the tier does not run as skipped, logs it, and never calls it", () => {
    const lines: { level: string; message: unknown }[] = [];
    const log = Logger.layer([
      Logger.map(Logger.formatStructured, (line) => void lines.push(line)),
    ]);
    return Effect.gen(function* () {
      answer = () => undefined;
      const config = apps.config();
      const { accountId } = yield* dueAccount("skip");
      yield* runFanOutRetrySweep({
        config: {
          ...config,
          local: false,
          urls: { zap: config.urls.zap! },
          absent: new Set(["pulse"]),
        },
        nowMs,
      });
      expect(erasures(accountId).map((call) => call.app)).toEqual(["zap"]);
      const job = yield* jobOf(accountId);
      expect(job.pulseDoneAt).toBeGreaterThan(0);
      expect(JSON.parse(job.appOutcomes!).pulse).toEqual({ status: "skipped" });
      expect(
        lines.some((line) =>
          JSON.stringify(line.message).includes("skipped an app this tier does not run"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(createTestLayer()), Effect.provide(log));
  });

  it.effect(
    "on a deployed tier, leaves an app with no URL and no declaration pending, and stamps the failure",
    () =>
      Effect.gen(function* () {
        answer = () => undefined;
        const config = apps.config();
        const { accountId } = yield* dueAccount("unset");
        yield* runFanOutRetrySweep({
          config: { ...config, local: false, urls: { zap: config.urls.zap! } },
          nowMs,
        });
        const job = yield* jobOf(accountId);
        expect(job.pulseDoneAt).toBeNull();
        expect(job.zapDoneAt).toBeGreaterThan(0);
        expect(job.fanoutFailedAt).toBe(NOW);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "leaves the mark pending and stamps the job when an app answers outside the contract, logging no address",
    () => {
      const log = logLines();
      return Effect.gen(function* () {
        const cases: ReadonlyArray<readonly [string, AppAnswer]> = [
          ["error", { status: 500, body: {} }],
          ["shape", { body: { ok: true } }],
          [
            "long",
            {
              body: {
                kept: Array.from({ length: 101 }, () => ({
                  what: "x",
                  erasedOn: null,
                  requestUrl: null,
                })),
              },
            },
          ],
          ["http", { body: { kept: [{ what: "x", erasedOn: null, requestUrl: "http://x" }] } }],
        ];
        for (const [name, given] of cases) {
          answer = (call) => (call.app === "zap" ? given : undefined);
          const { accountId } = yield* dueAccount(`bad${name}`);
          yield* runFanOutRetrySweep({ config: apps.config(), nowMs });
          const job = yield* jobOf(accountId);
          expect({ name, zap: job.zapDoneAt, failedAt: job.fanoutFailedAt }).toEqual({
            name,
            zap: null,
            failedAt: NOW,
          });
          expect(job.pulseDoneAt).toBeGreaterThan(0);
        }
        expect(
          log.lines.some((line) => JSON.stringify(line).includes("fan-out to an app failed")),
        ).toBe(true);
        expect(JSON.stringify(log.lines)).not.toContain("@example.com");
        expect(JSON.stringify(log.lines)).not.toContain("acc_bad");
      }).pipe(Effect.provide(createTestLayer()), Effect.provide(log.layer));
    },
  );

  it.effect("reaches at most `maxJobs` jobs, never-failed ones before failed ones", () =>
    Effect.gen(function* () {
      answer = () => undefined;
      const failed = yield* dueAccount("failedfirst", {
        hardDeleteAt: NOW - 10 * 86_400,
        fanoutFailedAt: NOW - 3_600,
      });
      const fresh = yield* dueAccount("fresh", { hardDeleteAt: NOW - 86_400 });
      expect(yield* runFanOutRetrySweep({ config: apps.config(), nowMs, maxJobs: 1 })).toEqual({
        retried: 1,
      });
      expect(erasures(fresh.accountId)).toHaveLength(2);
      expect(erasures(failed.accountId)).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("reaches no job still inside its window", () =>
    Effect.gen(function* () {
      answer = () => undefined;
      const { accountId } = yield* dueAccount("inside", { hardDeleteAt: NOW + 60 });
      expect(yield* runFanOutRetrySweep({ config: apps.config(), nowMs })).toEqual({ retried: 0 });
      expect(erasures(accountId)).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "records each app's oldest unfinished job, 0 with none, never below 0, and logs one past a day",
    () => {
      const lines: { level: string; message: unknown }[] = [];
      const log = Logger.layer([
        Logger.map(Logger.formatStructured, (line) => void lines.push(line)),
      ]);
      return Effect.gen(function* () {
        const age = vi.spyOn(metrics, "metricAccountDeletionFanoutOldestAge");
        answer = (call) => (call.app === "zap" ? { status: 500, body: {} } : undefined);
        yield* dueAccount("stuck", { hardDeleteAt: NOW - 3 * 86_400 });
        yield* dueAccount("window", { hardDeleteAt: NOW + 86_400 });

        yield* runFanOutRetrySweep({ config: apps.config(), nowMs });

        // Read before the pass: both apps are 3 days behind on "stuck"; the job
        // still inside its window does not count.
        expect(age.mock.calls.toSorted()).toEqual([
          ["pulse", 3 * 86_400],
          ["zap", 3 * 86_400],
        ]);
        expect(
          lines.filter((line) => JSON.stringify(line.message).includes("overdue")),
        ).toHaveLength(2);

        age.mockClear();
        answer = () => undefined;
        yield* runFanOutRetrySweep({ config: apps.config(), nowMs });
        yield* runFanOutRetrySweep({ config: apps.config(), nowMs });
        expect(age.mock.calls.slice(-2).toSorted()).toEqual([
          ["pulse", 0],
          ["zap", 0],
        ]);
      }).pipe(Effect.provide(createTestLayer()), Effect.provide(log));
    },
  );
  it("never writes over a mark another pass wrote while the app answered, and counts no erasure for it", async () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    const counted = vi.spyOn(metrics, "metricAccountDeletionFanout");
    const { accountId } = await Effect.runPromise(
      dueAccount("overlap").pipe(Effect.provide(layer)),
    );
    const marker = {
      status: "done",
      kept: [{ what: "first pass", erasedOn: null, requestUrl: null }],
    };
    answer = (call) => {
      if (call.app === "zap" && call.path === "/internal/account-deleted") {
        // Another pass finishes with Zap while this one waits on its answer.
        sqlite.run(
          `UPDATE deletion_jobs SET zap_done_at = 1700000000,
             app_outcomes = json_set(coalesce(app_outcomes, '{}'), '$.zap', json(?))
           WHERE account_id = ?`,
          [JSON.stringify(marker), accountId],
        );
      }
      return undefined;
    };
    await Effect.runPromise(
      runFanOutRetrySweep({ config: apps.config(), nowMs }).pipe(Effect.provide(layer)),
    );
    const job = await Effect.runPromise(jobOf(accountId).pipe(Effect.provide(layer)));
    expect(job.zapDoneAt).toBe(1_700_000_000);
    expect(JSON.parse(job.appOutcomes!).zap).toEqual(marker);
    expect(job.pulseDoneAt).toBeGreaterThan(0);
    expect(counted.mock.calls.filter(([, result]) => result === "ok")).toEqual([["pulse", "ok"]]);
  });

  it.effect(
    "leaves the mark pending, stamps the job and counts a timeout when an app does not answer in time",
    () =>
      Effect.gen(function* () {
        const counted = vi.spyOn(metrics, "metricAccountDeletionFanout");
        answer = (call) => (call.app === "zap" ? { delayMs: 500 } : undefined);
        const { accountId } = yield* dueAccount("slow");
        yield* runFanOutRetrySweep({ config: apps.config({ fanoutTimeoutMs: 50 }), nowMs });
        const job = yield* jobOf(accountId);
        expect(job.zapDoneAt).toBeNull();
        expect(job.fanoutFailedAt).toBe(NOW);
        expect(job.pulseDoneAt).toBeGreaterThan(0);
        expect(counted).toHaveBeenCalledWith("zap", "timeout");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "stamps a job whose stored answers cannot be read, so the next pass reaches the rest",
    () =>
      Effect.gen(function* () {
        answer = () => undefined;
        const broken = yield* dueAccount("unreadable", {
          hardDeleteAt: NOW - 3 * 86_400,
          choices: "[",
        });
        const sound = yield* dueAccount("sound", { hardDeleteAt: NOW - 86_400 });

        yield* runFanOutRetrySweep({ config: apps.config(), nowMs, maxJobs: 1 });
        expect(erasures(broken.accountId)).toHaveLength(0);
        expect((yield* jobOf(broken.accountId)).fanoutFailedAt).toBe(NOW);

        yield* runFanOutRetrySweep({ config: apps.config(), nowMs, maxJobs: 1 });
        expect(erasures(sound.accountId)).toHaveLength(2);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "keeps the account while an app the fan-out claimed for is still pending, and stamps no hard-delete failure",
    () =>
      Effect.gen(function* () {
        answer = (call) => (call.app === "zap" ? { status: 500, body: {} } : undefined);
        const { accountId } = yield* dueAccount("claimed");
        yield* runFanOutRetrySweep({ config: apps.config(), nowMs });
        const claimed = yield* jobOf(accountId);
        expect(claimed.purgeStartedAt).toBe(NOW);
        expect(claimed.zapDoneAt).toBeNull();

        expect(yield* runHardDeleteSweep({ nowMs })).toEqual({ purged: 0 });
        const job = yield* jobOf(accountId);
        expect(job.hardDeleteFailedAt).toBeNull();
        const { db } = yield* Db;
        const account = yield* Effect.promise(() =>
          db.select().from(accounts).where(eq(accounts.id, accountId)),
        );
        expect(account).toHaveLength(1);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.each([
    [undefined, DELETION_SWEEP_DEFAULT_MAX_JOBS],
    ["", 4],
    ["50", 50],
    ["1", 1],
    ["200", 200],
    ["0", "invalid"],
    ["201", "invalid"],
    ["1.5", "invalid"],
    ["abc", "invalid"],
  ] as const)("reads OSN_DELETION_FANOUT_MAX_JOBS %j as %j", (raw, expected) => {
    expect(DELETION_SWEEP_DEFAULT_MAX_JOBS).toBe(4);
    expect(deletionSweepMaxJobs(raw)).toBe(expected);
  });

  it.effect("reaches four jobs a pass when no cap is given", () =>
    Effect.gen(function* () {
      answer = () => undefined;
      for (const n of [1, 2, 3, 4, 5]) yield* dueAccount(`cap${n}`);
      expect(yield* runFanOutRetrySweep({ config: apps.config(), nowMs })).toEqual({ retried: 4 });
    }).pipe(Effect.provide(createTestLayer())),
  );

  it("reads each job once, and marks a skipped app in the claim: two writes a job on a deployed tier", async () => {
    answer = () => undefined;
    const { layer, captured } = createCapturingTestLayer();
    const config = apps.config();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* dueAccount("countone");
        yield* dueAccount("counttwo");
        captured.length = 0;
        yield* runFanOutRetrySweep({
          config: {
            ...config,
            local: false,
            urls: { zap: config.urls.zap! },
            absent: new Set(["pulse"]),
          },
          nowMs,
        });
      }).pipe(Effect.provide(layer)),
    );
    const onJobs = (verb: string) =>
      captured.filter(
        (statement) => statement.sql.startsWith(verb) && statement.sql.includes(`"deletion_jobs"`),
      );
    // The job read and the oldest-pending aggregate, whatever the job count.
    expect(onJobs("select")).toHaveLength(2);
    // Per job: the claim, which marks Pulse skipped, then Zap's mark.
    expect(onJobs("update")).toHaveLength(4);
  });
});
