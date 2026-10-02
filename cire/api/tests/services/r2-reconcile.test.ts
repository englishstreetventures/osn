import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";
import { Miniflare } from "miniflare";

import {
  LAP_WARNING_MS,
  R2ReconcileError,
  RECONCILE_DELETE_CAP,
  RECONCILE_GRACE_MS,
  r2PositionStore,
  reconcileOrphanObjects,
  type ListLimits,
  type PositionBucket,
  type PositionStore,
  type ReconcilableBucket,
  type ReconcilePlan,
} from "../../src/services/r2-reconcile";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";

const NOW = new Date("2026-06-20T04:00:00.000Z");
const OLD = new Date(NOW.getTime() - RECONCILE_GRACE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);
const DAY_MS = 24 * 60 * 60 * 1000;

const PREFIX = "imports/";

type ListOptions = { prefix?: string; cursor?: string; startAfter?: string; limit?: number };

/**
 * In-memory listable bucket. Keys are listed in code-unit order (`.toSorted()`),
 * the byte order R2 lists ASCII keys in. A cursor is the last key a page
 * returned, and a listing resumes after the later of the cursor and
 * `startAfter`, as Miniflare's R2 does. `limit` is honoured; `shortPages` caps
 * every page while still reporting `truncated`, which R2 may do. Every `list`
 * call is recorded. The other options make the bucket misbehave in one way
 * each: ignore the prefix or `startAfter`, include the `startAfter` key, drop
 * the cursor, fail a list call, or reject deletes while `deletes.reject` is set.
 */
function createBucket(
  initial: ReadonlyArray<{ key: string; uploaded: Date }>,
  opts: {
    shortPages?: number;
    listThrowsOnCall?: number;
    ignoreStartAfter?: boolean;
    inclusiveStartAfter?: boolean;
    ignorePrefix?: boolean;
    dropCursor?: boolean;
    headThrows?: boolean;
  } = {},
): ReconcilableBucket & {
  deleted: Set<string>;
  keys: () => string[];
  listCalls: ListOptions[];
  deletes: { reject: boolean };
} {
  const store = new Map(initial.map((o) => [o.key, o.uploaded]));
  const deleted = new Set<string>();
  const listCalls: ListOptions[] = [];
  const deletes = { reject: false };
  return {
    deleted,
    listCalls,
    deletes,
    keys: () => [...store.keys()].toSorted(),
    head(key) {
      if (opts.headThrows) return Promise.reject(new Error("head boom"));
      return Promise.resolve(store.has(key) ? { key } : null);
    },
    list(options) {
      listCalls.push({ ...options });
      if (opts.listThrowsOnCall === listCalls.length) {
        return Promise.reject(new Error("list boom"));
      }
      const prefix = opts.ignorePrefix ? "" : (options?.prefix ?? "");
      const startAfter = opts.ignoreStartAfter ? undefined : options?.startAfter;
      const after = (k: string) =>
        (options?.cursor === undefined || k > options.cursor) &&
        (startAfter === undefined ||
          k > startAfter ||
          (opts.inclusiveStartAfter && k === startAfter));
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && after(k)).toSorted();
      const slice = keys.slice(0, Math.min(options?.limit ?? 1000, opts.shortPages ?? 1000));
      const truncated = slice.length < keys.length;
      return Promise.resolve({
        objects: slice.map((key) => ({ key, uploaded: store.get(key)! })),
        truncated,
        cursor:
          truncated && !opts.dropCursor
            ? (slice.at(-1) ?? options?.cursor ?? startAfter ?? prefix)
            : undefined,
      });
    },
    delete(keys) {
      if (deletes.reject) return Promise.reject(new Error("delete boom"));
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (store.delete(k)) deleted.add(k);
      }
      return Promise.resolve();
    },
  };
}

/** A position held in memory, recording every write. */
function memoryPosition(
  initial?: { after: string | null; lapStartedAt: number } | string,
  opts: { readThrows?: boolean; writeThrows?: boolean } = {},
) {
  let stored = typeof initial === "string" ? initial : initial && JSON.stringify(initial);
  const writes: Array<string | undefined> = [];
  const boom = (reason: string) => Effect.fail(new R2ReconcileError({ bucket: "sheets", reason }));
  const store: PositionStore = {
    read: opts.readThrows ? boom("get boom") : Effect.sync(() => stored),
    write: (text) =>
      opts.writeThrows
        ? boom("put boom")
        : Effect.sync(() => {
            writes.push(text);
            stored = text;
          }),
  };
  return {
    store,
    writes,
    current: () =>
      stored === undefined
        ? undefined
        : (JSON.parse(stored) as { after: string | null; lapStartedAt: number }),
  };
}

/**
 * A plan whose live rows name exactly `live`. Records each `named` lookup and
 * how often the sample was read.
 */
function plan(live: ReadonlyArray<string>, extra: Partial<ReconcilePlan<never>> = {}) {
  const liveSet = new Set(live);
  const lookups: Array<ReadonlyArray<string>> = [];
  let samplesRead = 0;
  const p: ReconcilePlan<never> = {
    label: "sheets",
    prefix: PREFIX,
    liveSample: Effect.sync(() => {
      samplesRead += 1;
      return live[0];
    }),
    named: (keys) =>
      Effect.sync(() => {
        lookups.push(keys);
        return new Set(keys.filter((k) => liveSet.has(k)));
      }),
    ...extra,
  };
  return { plan: p, lookups, samplesRead: () => samplesRead };
}

const budget = (limits: ListLimits, position: PositionStore) => ({ ...limits, position });

const keyAt = (i: number) => `imports/${String(i).padStart(2, "0")}/events.csv`;
const objectsAt = (n: number, uploaded = OLD) =>
  Array.from({ length: n }, (_, i) => ({ key: keyAt(i), uploaded }));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const outcome = <A>(effect: Effect.Effect<A, R2ReconcileError>) =>
  run(
    effect.pipe(
      Effect.match({ onFailure: (e) => `failed: ${e.reason}`, onSuccess: () => "ok" as const }),
    ),
  );

describe("reconcileOrphanObjects", () => {
  it("reaps an unreferenced object past the grace window and keeps everything else", async () => {
    const bucket = createBucket([
      { key: "imports/a/events.csv", uploaded: OLD },
      { key: "imports/b/events.csv", uploaded: OLD },
      { key: "imports/c/events.csv", uploaded: FRESH },
      { key: "assets/x/hero", uploaded: OLD },
    ]);

    const deleted = await run(
      reconcileOrphanObjects(bucket, plan(["imports/a/events.csv"]).plan, NOW),
    );

    expect(deleted).toBe(1);
    expect([...bucket.deleted]).toEqual(["imports/b/events.csv"]);
  });

  it("asks once, after the walk, about exactly the old in-prefix keys, with the live sample last", async () => {
    const bucket = createBucket([
      { key: "imports/a/events.csv", uploaded: OLD },
      { key: "imports/b/events.csv", uploaded: OLD },
      { key: "imports/c/events.csv", uploaded: FRESH },
      { key: "imports/live/events.csv", uploaded: FRESH },
      { key: "assets/x/hero", uploaded: OLD },
    ]);
    const p = plan(["imports/live/events.csv"]);

    await run(reconcileOrphanObjects(bucket, p.plan, NOW));

    expect(p.samplesRead()).toBe(1);
    expect(p.lookups).toEqual([
      ["imports/a/events.csv", "imports/b/events.csv", "imports/live/events.csv"],
    ]);
  });

  it("reads nothing about references when nothing is old enough to delete", async () => {
    const bucket = createBucket([{ key: "imports/a/events.csv", uploaded: FRESH }]);
    const p = plan(["imports/live/events.csv"]);

    expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(0);
    expect(p.samplesRead()).toBe(0);
    expect(p.lookups).toHaveLength(0);
  });

  it("deletes nothing when no live row names any key but the prefix holds objects", async () => {
    const bucket = createBucket([{ key: "imports/a/events.csv", uploaded: OLD }]);
    const p = plan([]);
    let deleted = -1;

    const logs = await captureLogs(async () => {
      deleted = await run(reconcileOrphanObjects(bucket, p.plan, NOW));
    });

    expect(deleted).toBe(0);
    expect(bucket.deleted.size).toBe(0);
    expect(p.lookups).toHaveLength(0);
    expect(logs).toContain("delete-nothing safeguard");
  });

  it("deletes nothing and fails when the live-sample read dies", async () => {
    const bucket = createBucket([{ key: "imports/a/events.csv", uploaded: OLD }]);
    const p = plan(["imports/live"], { liveSample: Effect.die("read failed") });

    expect(await outcome(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe("failed: read failed");
    expect(bucket.deleted.size).toBe(0);
  });

  it("deletes nothing and fails when the lookup dies", async () => {
    const bucket = createBucket([
      { key: "imports/a/events.csv", uploaded: OLD },
      { key: "imports/live", uploaded: FRESH },
    ]);
    const p = plan(["imports/live"], { named: () => Effect.die("lookup failed") });

    expect(await outcome(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(
      "failed: lookup failed",
    );
    expect(bucket.deleted.size).toBe(0);
  });

  it("fails and deletes nothing when the live sample is not an object in this bucket", async () => {
    // The database names `imports/elsewhere`, which this bucket does not hold:
    // a database paired with another environment's bucket looks like this.
    const bucket = createBucket([{ key: "imports/a/events.csv", uploaded: OLD }]);
    const p = plan(["imports/elsewhere"]);

    expect(await outcome(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(
      "failed: the live sample is not an object in this bucket",
    );
    expect(p.lookups).toHaveLength(0);
    expect(bucket.deleted.size).toBe(0);
  });

  it("fails and deletes nothing when the bucket cannot be asked about the live sample", async () => {
    const bucket = createBucket(
      [
        { key: "imports/a/events.csv", uploaded: OLD },
        { key: "imports/live", uploaded: OLD },
      ],
      { headThrows: true },
    );

    expect(await outcome(reconcileOrphanObjects(bucket, plan(["imports/live"]).plan, NOW))).toBe(
      "failed: head failed: Error: head boom",
    );
    expect(bucket.deleted.size).toBe(0);
  });

  it("keeps an object uploaded exactly at the grace cutoff", async () => {
    const bucket = createBucket([
      { key: "imports/live", uploaded: OLD },
      { key: "imports/edge", uploaded: new Date(NOW.getTime() - RECONCILE_GRACE_MS) },
    ]);

    expect(await run(reconcileOrphanObjects(bucket, plan(["imports/live"]).plan, NOW))).toBe(0);
  });

  it("never judges or deletes a key outside the prefix, even when the listing returns one", async () => {
    const bucket = createBucket(
      [
        { key: "assets/x/hero", uploaded: OLD },
        { key: "imports/live", uploaded: OLD },
        { key: "imports/orphan", uploaded: OLD },
        { key: "reconcile/imports-position.json", uploaded: OLD },
      ],
      { ignorePrefix: true },
    );
    const p = plan(["imports/live"]);

    expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(1);
    expect([...bucket.deleted]).toEqual(["imports/orphan"]);
    expect(p.lookups.flat().every((k) => k.startsWith(PREFIX))).toBe(true);
  });

  describe("the live sample is the lookup's control", () => {
    const live = "imports/live/events.csv";
    const bucket = () =>
      createBucket([
        { key: live, uploaded: OLD },
        { key: "imports/orphan/events.csv", uploaded: OLD },
      ]);

    it("fails and deletes nothing when the lookup matches nothing at all", async () => {
      const b = bucket();
      const p = plan([live], { named: () => Effect.succeed(new Set<string>()) });

      expect(await outcome(reconcileOrphanObjects(b, p.plan, NOW))).toBe(
        "failed: the reference check did not name its live sample",
      );
      expect(b.deleted.size).toBe(0);
    });

    it("fails and deletes nothing when the lookup loses the tail of its input", async () => {
      const b = bucket();
      const names = new Set([live]);
      const p = plan([live], {
        named: (keys) => Effect.succeed(new Set(keys.slice(0, -1).filter((k) => names.has(k)))),
      });

      expect(await outcome(reconcileOrphanObjects(b, p.plan, NOW))).toBe(
        "failed: the reference check did not name its live sample",
      );
      expect(b.deleted.size).toBe(0);
    });
  });

  it("deletes nothing when a list call fails part-way through the walk, and counts the error", async () => {
    const objects = Array.from({ length: 5 }, (_, i) => ({
      key: `imports/orphan-${i}/events.csv`,
      uploaded: OLD,
    }));
    const bucket = createBucket([{ key: "imports/live/events.csv", uploaded: OLD }, ...objects], {
      shortPages: 2,
      listThrowsOnCall: 2,
    });
    const errorsBefore = await counterValue("cire.r2.objects.swept", {
      bucket: "sheets",
      result: "error",
    });

    const result = await outcome(
      reconcileOrphanObjects(bucket, plan(["imports/live/events.csv"]).plan, NOW),
    );

    expect(result).toBe("failed: list failed: Error: list boom");
    expect(bucket.deleted.size).toBe(0);
    expect(await counterValue("cire.r2.objects.swept", { bucket: "sheets", result: "error" })).toBe(
      errorsBefore + 1,
    );
  });

  it("is a no-op when the binding is absent", async () => {
    expect(await run(reconcileOrphanObjects(undefined, plan(["k"]).plan, NOW))).toBe(0);
  });

  it("stops at the delete cap", async () => {
    const objects = Array.from({ length: RECONCILE_DELETE_CAP + 25 }, (_, i) => ({
      key: `imports/${String(i).padStart(4, "0")}/events.csv`,
      uploaded: OLD,
    }));
    const bucket = createBucket([{ key: "imports/live", uploaded: OLD }, ...objects], {
      shortPages: 100,
    });

    let deleted = 0;
    const logs = await captureLogs(async () => {
      deleted = await run(reconcileOrphanObjects(bucket, plan(["imports/live"]).plan, NOW));
    });

    expect(deleted).toBe(RECONCILE_DELETE_CAP);
    expect(bucket.deleted.size).toBe(RECONCILE_DELETE_CAP);
    expect(bucket.deleted.has("imports/live")).toBe(false);
    expect(logs).toContain("hit its per-run delete cap");
  });

  it("deletes exactly a cap's worth of orphans without calling it capped", async () => {
    const objects = Array.from({ length: RECONCILE_DELETE_CAP }, (_, i) => ({
      key: `imports/${String(i).padStart(4, "0")}/events.csv`,
      uploaded: OLD,
    }));
    const bucket = createBucket([{ key: "imports/live", uploaded: OLD }, ...objects]);
    let deleted = 0;

    const logs = await captureLogs(async () => {
      deleted = await run(reconcileOrphanObjects(bucket, plan(["imports/live"]).plan, NOW));
    });

    expect(deleted).toBe(RECONCILE_DELETE_CAP);
    expect(logs).not.toContain("hit its per-run delete cap");
  });

  describe("with a listing budget", () => {
    it("never lists more objects than the budget", async () => {
      const bucket = createBucket(objectsAt(30));
      const position = memoryPosition();

      await run(
        reconcileOrphanObjects(
          bucket,
          plan(
            objectsAt(30).map((o) => o.key),
            {
              budget: budget({ maxObjects: 12, maxListCalls: 10 }, position.store),
            },
          ).plan,
          NOW,
        ),
      );

      expect(bucket.listCalls).toEqual([{ prefix: PREFIX, limit: 12 }]);
    });

    it("lowers the last page's limit to what the budget has left", async () => {
      const bucket = createBucket(objectsAt(30), { shortPages: 5 });

      await run(
        reconcileOrphanObjects(
          bucket,
          plan([keyAt(0)], {
            budget: budget({ maxObjects: 12, maxListCalls: 10 }, memoryPosition().store),
          }).plan,
          NOW,
        ),
      );

      expect(bucket.listCalls.map((c) => c.limit)).toEqual([12, 7, 2]);
    });

    it("stops after its list calls even when R2 returns short pages", async () => {
      const bucket = createBucket(objectsAt(30), { shortPages: 1 });

      await run(
        reconcileOrphanObjects(
          bucket,
          plan([keyAt(0)], {
            budget: budget({ maxObjects: 1000, maxListCalls: 3 }, memoryPosition().store),
          }).plan,
          NOW,
        ),
      );

      expect(bucket.listCalls).toHaveLength(3);
    });

    it("resumes after the last key it walked, and clears the position when the lap completes", async () => {
      const objects = objectsAt(30);
      const bucket = createBucket(objects);
      const position = memoryPosition();
      const p = plan(
        objects.map((o) => o.key),
        { budget: budget({ maxObjects: 12, maxListCalls: 10 }, position.store) },
      );

      await run(reconcileOrphanObjects(bucket, p.plan, NOW));
      expect(position.current()).toEqual({ after: keyAt(11), lapStartedAt: NOW.getTime() });

      const later = new Date(NOW.getTime() + DAY_MS);
      await run(reconcileOrphanObjects(bucket, p.plan, later));
      expect(bucket.listCalls[1]).toEqual({ prefix: PREFIX, startAfter: keyAt(11), limit: 12 });
      // The lap began with the first run, not this one.
      expect(position.current()).toEqual({ after: keyAt(23), lapStartedAt: NOW.getTime() });

      await run(reconcileOrphanObjects(bucket, p.plan, later));
      expect(position.current()).toBeUndefined();
      expect(position.writes.at(-1)).toBeUndefined();
      expect(bucket.deleted.size).toBe(0);
    });

    it("reaches every orphan past the budget within a few runs, and keeps every live key", async () => {
      const objects = objectsAt(40);
      const orphans = [3, 17, 18, 29, 30, 31, 39].map(keyAt);
      const live = objects.map((o) => o.key).filter((k) => !orphans.includes(k));
      const bucket = createBucket(objects);
      const position = memoryPosition();
      const p = plan(live, {
        budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store),
      });

      let runs = 0;
      do {
        await run(reconcileOrphanObjects(bucket, p.plan, NOW));
        runs += 1;
      } while (position.current() !== undefined && runs < 20);

      expect(position.current()).toBeUndefined();
      expect([...bucket.deleted].toSorted()).toEqual(orphans);
      expect(bucket.keys()).toEqual(live);
    });

    it("moves on past a stretch whose deletes all succeeded", async () => {
      const objects = objectsAt(30);
      const bucket = createBucket(objects);
      const lapStartedAt = NOW.getTime() - DAY_MS;
      const position = memoryPosition({ after: keyAt(9), lapStartedAt });
      const p = plan(
        objects.map((o) => o.key).filter((k) => k !== keyAt(12)),
        { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) },
      );

      expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(1);
      expect(position.current()).toEqual({ after: keyAt(19), lapStartedAt });
    });

    it("holds its place, recording a fresh lap's start, when the delete cap stops it", async () => {
      const objects = Array.from({ length: RECONCILE_DELETE_CAP + 20 }, (_, i) => ({
        key: `imports/${String(i).padStart(4, "0")}/events.csv`,
        uploaded: OLD,
      }));
      const bucket = createBucket(objects);
      const position = memoryPosition();
      const p = plan([objects[0]!.key], {
        budget: budget({ maxObjects: 1000, maxListCalls: 10 }, position.store),
      });

      expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(RECONCILE_DELETE_CAP);
      expect(position.current()).toEqual({ after: null, lapStartedAt: NOW.getTime() });

      // The rest of the stretch is reached on the next run, which then ends the lap.
      expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(19);
      expect(position.current()).toBeUndefined();
    });

    it("writes nothing when a lap fits in one run with nothing to delete", async () => {
      const bucket = createBucket(objectsAt(5));
      const position = memoryPosition();
      const p = plan(
        objectsAt(5).map((o) => o.key),
        { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) },
      );

      await run(reconcileOrphanObjects(bucket, p.plan, NOW));

      expect(position.writes).toEqual([]);
    });

    it("leaves the position alone when the run aborts", async () => {
      const stored = { after: keyAt(4), lapStartedAt: NOW.getTime() - DAY_MS };

      const empty = memoryPosition(stored);
      await run(
        reconcileOrphanObjects(
          createBucket(objectsAt(30)),
          plan([], { budget: budget({ maxObjects: 10, maxListCalls: 10 }, empty.store) }).plan,
          NOW,
        ),
      );
      expect(empty.writes).toEqual([]);

      const listing = memoryPosition(stored);
      await outcome(
        reconcileOrphanObjects(
          createBucket(objectsAt(30), { listThrowsOnCall: 1 }),
          plan([keyAt(0)], { budget: budget({ maxObjects: 10, maxListCalls: 10 }, listing.store) })
            .plan,
          NOW,
        ),
      );
      expect(listing.writes).toEqual([]);
    });

    it.each([
      ["text that is not JSON", "not json"],
      ["a position outside the prefix", JSON.stringify({ after: "zzz", lapStartedAt: 0 })],
      [
        "a lap that starts in the future",
        JSON.stringify({ after: keyAt(5), lapStartedAt: NOW.getTime() + DAY_MS }),
      ],
      ["the wrong shape", JSON.stringify({ after: 7 })],
      ["a lap that starts at minus infinity", '{"after":null,"lapStartedAt":-1e999}'],
    ])(
      "starts a new lap from the first key, with a warning, on %s, and clears it",
      async (_, stored) => {
        const bucket = createBucket(objectsAt(5));
        const position = memoryPosition(stored);
        const p = plan(
          objectsAt(5).map((o) => o.key),
          { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) },
        );

        const logs = await captureLogs(() => run(reconcileOrphanObjects(bucket, p.plan, NOW)));

        expect(bucket.listCalls[0]).toEqual({ prefix: PREFIX, limit: 10 });
        expect(logs).toContain("position unreadable");
        // The lap fitted in this run, so the unreadable text is removed rather
        // than left to warn again tomorrow.
        expect(position.writes).toEqual([undefined]);
        const again = await captureLogs(() => run(reconcileOrphanObjects(bucket, p.plan, NOW)));
        expect(again).not.toContain("position unreadable");
      },
    );

    it("replaces an unreadable position with a readable one when the lap does not fit", async () => {
      const bucket = createBucket(objectsAt(30));
      const position = memoryPosition("not json");
      const p = plan(
        objectsAt(30).map((o) => o.key),
        { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) },
      );

      await run(reconcileOrphanObjects(bucket, p.plan, NOW));

      expect(position.current()).toEqual({ after: keyAt(9), lapStartedAt: NOW.getTime() });
    });

    it("starts a new lap silently when no position is stored", async () => {
      const bucket = createBucket(objectsAt(5));
      const p = plan(
        objectsAt(5).map((o) => o.key),
        { budget: budget({ maxObjects: 10, maxListCalls: 10 }, memoryPosition().store) },
      );

      const logs = await captureLogs(() => run(reconcileOrphanObjects(bucket, p.plan, NOW)));

      expect(logs).not.toContain("position unreadable");
    });

    it("fails, listing and deleting nothing, when the position cannot be read", async () => {
      const bucket = createBucket(objectsAt(5));
      const p = plan([keyAt(0)], {
        budget: budget(
          { maxObjects: 10, maxListCalls: 10 },
          memoryPosition(undefined, { readThrows: true }).store,
        ),
      });

      expect(await outcome(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe("failed: get boom");
      expect(bucket.listCalls).toHaveLength(0);
      expect(bucket.deleted.size).toBe(0);
    });

    it("fails when the position cannot be saved", async () => {
      const bucket = createBucket(objectsAt(30));
      const p = plan(
        objectsAt(30).map((o) => o.key),
        {
          budget: budget(
            { maxObjects: 10, maxListCalls: 10 },
            memoryPosition(undefined, { writeThrows: true }).store,
          ),
        },
      );

      expect(await outcome(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe("failed: put boom");
    });

    it("warns on every run once a lap has gone on longer than the warning window", async () => {
      const objects = objectsAt(30);
      const lapped = (lapStartedAt: number) =>
        plan(
          objects.map((o) => o.key),
          {
            budget: budget(
              { maxObjects: 10, maxListCalls: 10 },
              memoryPosition({ after: keyAt(4), lapStartedAt }).store,
            ),
          },
        ).plan;

      const old = await captureLogs(() =>
        run(
          reconcileOrphanObjects(
            createBucket(objects),
            lapped(NOW.getTime() - LAP_WARNING_MS - DAY_MS),
            NOW,
          ),
        ),
      );
      const recent = await captureLogs(() =>
        run(
          reconcileOrphanObjects(
            createBucket(objects),
            lapped(NOW.getTime() - LAP_WARNING_MS + DAY_MS),
            NOW,
          ),
        ),
      );

      expect(old).toContain("past its warning window");
      expect(recent).not.toContain("past its warning window");
    });

    it("fails when the listing ignores startAfter", async () => {
      const bucket = createBucket(objectsAt(30), { ignoreStartAfter: true });
      const p = plan(
        objectsAt(30).map((o) => o.key),
        {
          budget: budget(
            { maxObjects: 10, maxListCalls: 10 },
            memoryPosition({ after: keyAt(14), lapStartedAt: NOW.getTime() }).store,
          ),
        },
      );

      expect(await outcome(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(
        "failed: list returned a key at or before the resume position",
      );
      expect(bucket.deleted.size).toBe(0);
    });

    it("fails when the listing returns the startAfter key itself", async () => {
      const bucket = createBucket(objectsAt(30), { inclusiveStartAfter: true });
      const p = plan(
        objectsAt(30).map((o) => o.key),
        {
          budget: budget(
            { maxObjects: 10, maxListCalls: 10 },
            memoryPosition({ after: keyAt(14), lapStartedAt: NOW.getTime() }).store,
          ),
        },
      );

      expect(await outcome(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(
        "failed: list returned a key at or before the resume position",
      );
    });

    it("keeps its place after a failed delete, counts it, and deletes on the next run", async () => {
      const objects = objectsAt(30);
      const bucket = createBucket(objects);
      const stored = { after: keyAt(9), lapStartedAt: NOW.getTime() - DAY_MS };
      const position = memoryPosition(stored);
      const p = plan(
        objects.map((o) => o.key).filter((k) => k !== keyAt(12)),
        { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) },
      );
      const errors = () =>
        counterValue("cire.r2.objects.swept", { bucket: "sheets", result: "error" });
      const errorsBefore = await errors();

      bucket.deletes.reject = true;
      expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(1);
      expect(await errors()).toBe(errorsBefore + 1);
      expect(position.writes).toEqual([]);
      expect(bucket.keys()).toContain(keyAt(12));

      bucket.deletes.reject = false;
      expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(1);
      expect([...bucket.deleted]).toEqual([keyAt(12)]);
      expect(position.current()?.after).toBe(keyAt(19));
    });

    it("stores only a key under the prefix as its position, even when the listing returns others", async () => {
      const bucket = createBucket(
        [
          { key: "assets/x/hero", uploaded: OLD },
          { key: "imports/live", uploaded: OLD },
          { key: "reconcile/imports-position.json", uploaded: OLD },
          { key: "zz/other", uploaded: OLD },
        ],
        { ignorePrefix: true, shortPages: 3 },
      );
      const position = memoryPosition();
      const p = plan(["imports/live"], {
        budget: budget({ maxObjects: 10, maxListCalls: 1 }, position.store),
      });

      await run(reconcileOrphanObjects(bucket, p.plan, NOW));

      expect(position.current()).toEqual({ after: "imports/live", lapStartedAt: NOW.getTime() });
    });

    it("does not end the lap on a truncated page that carries no cursor", async () => {
      const bucket = createBucket(objectsAt(30), { shortPages: 4, dropCursor: true });
      const position = memoryPosition();
      const p = plan(
        objectsAt(30).map((o) => o.key),
        { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) },
      );

      await run(reconcileOrphanObjects(bucket, p.plan, NOW));

      expect(bucket.listCalls).toHaveLength(1);
      expect(position.current()).toEqual({ after: keyAt(3), lapStartedAt: NOW.getTime() });
    });

    it("keeps the position, with a warning, when the budget is spent without reaching an object", async () => {
      const bucket = createBucket(objectsAt(30), { shortPages: 0 });
      const stored = { after: keyAt(4), lapStartedAt: NOW.getTime() - DAY_MS };
      const position = memoryPosition(stored);
      const p = plan([keyAt(0)], {
        budget: budget({ maxObjects: 10, maxListCalls: 3 }, position.store),
      });

      const logs = await captureLogs(() => run(reconcileOrphanObjects(bucket, p.plan, NOW)));

      expect(bucket.listCalls).toHaveLength(3);
      expect(position.writes).toEqual([]);
      expect(logs).toContain("without reaching an object");
    });
  });
});

describe("r2PositionStore", () => {
  const bucketWith = (overrides: Partial<PositionBucket> = {}) => {
    const objects = new Map<string, string>();
    const bucket: PositionBucket = {
      get: (key) =>
        Promise.resolve(
          objects.has(key) ? { text: () => Promise.resolve(objects.get(key)!) } : null,
        ),
      put: (key, value) => Promise.resolve(void objects.set(key, value)),
      delete: (key) => Promise.resolve(void objects.delete(key as string)),
      ...overrides,
    };
    return { bucket, objects };
  };

  it("stores, reads back and removes one object at its key", async () => {
    const { bucket, objects } = bucketWith();
    const store = r2PositionStore(bucket, "reconcile/p.json", "sheets");

    expect(await run(store.read)).toBeUndefined();
    await run(store.write("{}"));
    expect([...objects.keys()]).toEqual(["reconcile/p.json"]);
    expect(await run(store.read)).toBe("{}");
    await run(store.write(undefined));
    expect(objects.size).toBe(0);
  });

  it("turns a failed get, put or delete into R2ReconcileError", async () => {
    const boom = () => Promise.reject(new Error("r2 down"));
    const { bucket } = bucketWith({ get: boom, put: boom, delete: boom });
    const store = r2PositionStore(bucket, "reconcile/p.json", "sheets");

    expect(await outcome(store.read)).toBe("failed: position read failed: Error: r2 down");
    expect(await outcome(store.write("{}"))).toBe("failed: position write failed: Error: r2 down");
    expect(await outcome(store.write(undefined))).toBe(
      "failed: position write failed: Error: r2 down",
    );
  });
});

// The walk's safety rests on how R2 answers `list`: prefix filtering, cursor
// paging, `startAfter`, `limit`, and the `uploaded` time it reports. The stub
// above encodes one reading of that; this runs the same walk against workerd's
// own R2, with the position kept in the same bucket.
describe("reconcileOrphanObjects against workerd's R2", () => {
  let mf: Miniflare;
  let r2: ReconcilableBucket &
    PositionBucket & {
      list(o: { prefix?: string; cursor?: string }): Promise<{
        objects: Array<{ key: string; uploaded: Date }>;
        truncated: boolean;
        cursor?: string;
      }>;
    };

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      r2Buckets: ["SHEETS"],
    });
    r2 = (await mf.getR2Bucket("SHEETS")) as unknown as typeof r2;
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  const allKeys = async () => {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await r2.list({ cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys.toSorted();
  };

  // Written a few at a time: a thousand concurrent puts can exhaust Miniflare's
  // local proxy when the whole suite runs at once.
  const putAll = async (keys: ReadonlyArray<string>) => {
    for (let i = 0; i < keys.length; i += 25) {
      await Promise.all(keys.slice(i, i + 25).map((key) => r2.put(key, "x")));
    }
  };

  // Every object is written during the test; judge them from eight days ahead
  // so all are past the grace window and only the reference decides.
  const later = () => new Date(Date.now() + RECONCILE_GRACE_MS + DAY_MS);

  it("follows workerd's cursor past the first page and reaps only unreferenced objects", async () => {
    // A thousand live objects fill the first page; orphans sit on both sides
    // of them, so reaching the later ones takes the cursor workerd returns.
    const live = Array.from(
      { length: 1000 },
      (_, i) => `imports/live-${String(i).padStart(4, "0")}/events.csv`,
    );
    const orphans = [
      "imports/aa-0/events.csv",
      "imports/zz-0/guests.csv",
      "imports/zz-1/before/events.csv",
    ];
    const outside = ["assets/w/hero", "importsX/odd"];
    await putAll([...live, ...orphans, ...outside]);

    const deleted = await run(reconcileOrphanObjects(r2, plan(live).plan, later()));

    expect(deleted).toBe(orphans.length);
    expect(await allKeys()).toEqual([...live, ...outside].toSorted());
    for (const key of [...live, ...outside]) await r2.delete(key);
  }, 30_000);

  it("resumes with startAfter across runs, keeping its position in the bucket, until every orphan is gone", async () => {
    const live = Array.from({ length: 25 }, (_, i) => `imports/r-${String(i).padStart(2, "0")}/e`);
    const orphans = ["imports/r-03/x", "imports/r-11/x", "imports/r-19/x", "imports/r-24/x"];
    await putAll([...live, ...orphans]);
    const positionKey = "reconcile/test-position.json";
    const p = plan(live, {
      budget: budget(
        { maxObjects: 6, maxListCalls: 5 },
        r2PositionStore(r2, positionKey, "sheets"),
      ),
    });

    let runs = 0;
    let midLap = false;
    do {
      await run(reconcileOrphanObjects(r2, p.plan, later()));
      runs += 1;
      if ((await r2.get(positionKey)) !== null) midLap = true;
    } while ((await r2.get(positionKey)) !== null && runs < 20);

    expect(midLap).toBe(true);
    expect(runs).toBeLessThan(20);
    expect(await allKeys()).toEqual(live);
  }, 30_000);
});
