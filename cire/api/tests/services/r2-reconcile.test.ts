import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";
import { Miniflare } from "miniflare";

import {
  LAP_WARNING_MS,
  R2ReconcileError,
  RECONCILE_DELETE_CAP,
  RECONCILE_GRACE_MS,
  r2PositionStore,
  reconcileDisabled,
  reconcileOrphanObjects,
  type ListLimits,
  type PositionBucket,
  type PositionStore,
  type ReconcilableBucket,
  type ReconcilePlan,
} from "../../src/services/r2-reconcile";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue, histogramPoint } from "../test-helpers/metrics-harness";

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

/** What a reconciler keeps in its position object, as the tests read it back. */
type StoredPosition = { after?: string | null; lapStartedAt?: number; referenced?: number };

/** A position held in memory, recording every write. */
function memoryPosition(
  initial?: StoredPosition | string,
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
    current: () => (stored === undefined ? undefined : (JSON.parse(stored) as StoredPosition)),
  };
}

/**
 * A plan whose live rows name exactly `live`, one key a row, so the lookup
 * reports `live.length` referencing rows unless `rows` says otherwise. Records
 * each `named` lookup and how often the sample was read.
 */
function plan(
  live: ReadonlyArray<string>,
  extra: Partial<ReconcilePlan<never>> = {},
  rows: number = live.length,
) {
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
        return { named: new Set(keys.filter((k) => liveSet.has(k))), referencingRows: rows };
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
      const p = plan([live], {
        named: () => Effect.succeed({ named: new Set<string>(), referencingRows: 1 }),
      });

      expect(await outcome(reconcileOrphanObjects(b, p.plan, NOW))).toBe(
        "failed: the reference check did not name its live sample",
      );
      expect(b.deleted.size).toBe(0);
    });

    it("fails and deletes nothing when the lookup loses the tail of its input", async () => {
      const b = bucket();
      const names = new Set([live]);
      const p = plan([live], {
        named: (keys) =>
          Effect.succeed({
            named: new Set(keys.slice(0, -1).filter((k) => names.has(k))),
            referencingRows: 1,
          }),
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

    it("resumes after the last key it walked, and keeps only the count when the lap completes", async () => {
      const objects = objectsAt(30);
      const bucket = createBucket(objects);
      const position = memoryPosition();
      const p = plan(
        objects.map((o) => o.key),
        { budget: budget({ maxObjects: 12, maxListCalls: 10 }, position.store) },
      );

      await run(reconcileOrphanObjects(bucket, p.plan, NOW));
      expect(position.current()).toEqual({
        after: keyAt(11),
        lapStartedAt: NOW.getTime(),
        referenced: 30,
      });

      const later = new Date(NOW.getTime() + DAY_MS);
      await run(reconcileOrphanObjects(bucket, p.plan, later));
      expect(bucket.listCalls[1]).toEqual({ prefix: PREFIX, startAfter: keyAt(11), limit: 12 });
      // The lap began with the first run, not this one.
      expect(position.current()).toEqual({
        after: keyAt(23),
        lapStartedAt: NOW.getTime(),
        referenced: 30,
      });

      await run(reconcileOrphanObjects(bucket, p.plan, later));
      expect(position.current()).toEqual({ referenced: 30 });
      expect(bucket.deleted.size).toBe(0);

      // Between laps the next run starts again from the first key.
      await run(reconcileOrphanObjects(bucket, p.plan, later));
      expect(bucket.listCalls[3]).toEqual({ prefix: PREFIX, limit: 12 });
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
      } while (position.current()?.after !== undefined && runs < 20);

      expect(runs).toBeLessThan(20);
      expect(position.current()).toEqual({ referenced: live.length });
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
      expect(position.current()).toEqual({ after: keyAt(19), lapStartedAt, referenced: 29 });
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
      expect(position.current()).toEqual({
        after: null,
        lapStartedAt: NOW.getTime(),
        referenced: 1,
      });

      // The rest of the stretch is reached on the next run, which then ends the lap.
      expect(await run(reconcileOrphanObjects(bucket, p.plan, NOW))).toBe(19);
      expect(position.current()).toEqual({ referenced: 1 });
    });

    it("writes nothing when a lap fits in one run, nothing is deleted and the count is unchanged", async () => {
      const bucket = createBucket(objectsAt(5));
      const position = memoryPosition({ referenced: 5 });
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
      ["a position with no lap start", JSON.stringify({ after: keyAt(5) })],
      ["a lap start with no position", JSON.stringify({ lapStartedAt: 0 })],
      ["a count that is a string", JSON.stringify({ referenced: "7" })],
      ["a negative count", JSON.stringify({ after: null, lapStartedAt: 0, referenced: -1 })],
      ["a fractional count", JSON.stringify({ referenced: 1.5 })],
      ["an empty object", "{}"],
    ])(
      "starts a new lap from the first key, with a warning, on %s, and replaces it with the count",
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
        // The lap fitted in this run, so the unreadable text is replaced by the
        // count alone rather than left to warn again tomorrow.
        expect(position.writes.map((w) => w && JSON.parse(w))).toEqual([{ referenced: 5 }]);
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

      expect(position.current()).toEqual({
        after: keyAt(9),
        lapStartedAt: NOW.getTime(),
        referenced: 30,
      });
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
      // The walk stays where it was; only the count is new.
      expect(position.current()).toEqual({ ...stored, referenced: 29 });
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

      expect(position.current()).toEqual({
        after: "imports/live",
        lapStartedAt: NOW.getTime(),
        referenced: 1,
      });
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
      expect(position.current()).toEqual({
        after: keyAt(3),
        lapStartedAt: NOW.getTime(),
        referenced: 30,
      });
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

    it("stores the count when a lap fits in one run, and updates it when it changes", async () => {
      const bucket = createBucket(objectsAt(5));
      const position = memoryPosition();
      const keys = objectsAt(5).map((o) => o.key);
      const limits = { maxObjects: 10, maxListCalls: 10 };

      await run(
        reconcileOrphanObjects(
          bucket,
          plan(keys, { budget: budget(limits, position.store) }).plan,
          NOW,
        ),
      );
      expect(position.writes.map((w) => w && JSON.parse(w))).toEqual([{ referenced: 5 }]);

      await run(
        reconcileOrphanObjects(
          bucket,
          plan(keys, { budget: budget(limits, position.store) }, 4).plan,
          NOW,
        ),
      );
      expect(position.writes.map((w) => w && JSON.parse(w))).toEqual([
        { referenced: 5 },
        { referenced: 4 },
      ]);
    });

    it("keeps the stored count through a run that reads none", async () => {
      // Nothing is old enough to judge, so no lookup runs and no count is read.
      const bucket = createBucket(objectsAt(5, FRESH));
      const position = memoryPosition({ referenced: 40 });
      const p = plan([], { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) });

      await run(reconcileOrphanObjects(bucket, p.plan, NOW));

      expect(p.lookups).toHaveLength(0);
      expect(position.current()).toEqual({ referenced: 40 });
    });

    describe("the referencing-row guard", () => {
      // Thirty old objects, every one live but keyAt(12): one orphan a run.
      const objects = () => objectsAt(30);
      const live = objectsAt(30)
        .map((o) => o.key)
        .filter((k) => k !== keyAt(12));
      const limits = { maxObjects: 100, maxListCalls: 10 };
      const guarded = (position: ReturnType<typeof memoryPosition>, rows: number) =>
        plan(live, { budget: budget(limits, position.store) }, rows);

      it.each([
        [51, 1],
        [50, 1],
        [49, 0],
      ])("against 100 rows last run, with %i now deletes %i", async (rows, expected) => {
        const bucket = createBucket(objects());
        const position = memoryPosition({ referenced: 100 });

        const deleted = await run(
          reconcileOrphanObjects(bucket, guarded(position, rows).plan, NOW),
        );

        expect(deleted).toBe(expected);
        expect(bucket.deleted.size).toBe(expected);
        expect(position.current()).toEqual({ referenced: rows });
      });

      it("holds a run whose rows fell by more than half, keeping its place, and stores the new count", async () => {
        const bucket = createBucket(objects());
        const stored = { after: keyAt(9), lapStartedAt: NOW.getTime() - DAY_MS, referenced: 100 };
        const position = memoryPosition(stored);
        let deleted = -1;

        const logs = await captureLogs(async () => {
          deleted = await run(
            reconcileOrphanObjects(
              bucket,
              plan(
                live,
                { budget: budget({ maxObjects: 10, maxListCalls: 10 }, position.store) },
                40,
              ).plan,
              NOW,
            ),
          );
        });

        expect(deleted).toBe(0);
        expect(bucket.deleted.size).toBe(0);
        expect(logs).toContain("referencing rows fell by more than half since the last run");
        expect(logs).toContain("previousRows");
        // Same stretch next run; the comparison is now with this run's count.
        expect(position.current()).toEqual({ ...stored, referenced: 40 });
      });

      it("compares with the last run only, so a hold lasts one run", async () => {
        const bucket = createBucket(objects());
        const position = memoryPosition({ referenced: 100 });

        expect(await run(reconcileOrphanObjects(bucket, guarded(position, 40).plan, NOW))).toBe(0);
        expect(await run(reconcileOrphanObjects(bucket, guarded(position, 40).plan, NOW))).toBe(1);
        expect([...bucket.deleted]).toEqual([keyAt(12)]);
      });

      it("deletes, and stores the count, when no count is stored", async () => {
        const fresh = memoryPosition();
        const freshBucket = createBucket(objects());
        expect(await run(reconcileOrphanObjects(freshBucket, guarded(fresh, 1).plan, NOW))).toBe(1);
        expect(fresh.current()).toEqual({ referenced: 1 });

        // A position written before the count was kept: a walk with no count.
        const lapStartedAt = NOW.getTime() - DAY_MS;
        const older = memoryPosition({ after: keyAt(9), lapStartedAt });
        const olderBucket = createBucket(objects());
        expect(await run(reconcileOrphanObjects(olderBucket, guarded(older, 1).plan, NOW))).toBe(1);
        expect(older.current()).toEqual({ referenced: 1 });
      });

      it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])(
        "fails and deletes nothing when the lookup's row count is %p",
        async (rows) => {
          const bucket = createBucket(objects());
          const position = memoryPosition({ referenced: 10 });

          expect(
            await outcome(reconcileOrphanObjects(bucket, guarded(position, rows).plan, NOW)),
          ).toBe("failed: referencing-row count is not a count");
          expect(bucket.deleted.size).toBe(0);
          expect(position.writes).toEqual([]);
        },
      );

      it("compares nothing without a budget, which has nowhere to keep a count", async () => {
        const bucket = createBucket(objects());

        expect(await run(reconcileOrphanObjects(bucket, plan(live, {}, 1).plan, NOW))).toBe(1);
      });
    });

    describe("a warning and a batch-size record on every delete batch", () => {
      const batches = () => histogramPoint("cire.r2.reconcile.batch.size", { bucket: "sheets" });
      const live = objectsAt(10)
        .map((o) => o.key)
        .filter((k) => k !== keyAt(3) && k !== keyAt(7));

      it("records one batch of the objects it sends to delete, and warns", async () => {
        const before = await batches();
        const logs = await captureLogs(() =>
          run(reconcileOrphanObjects(createBucket(objectsAt(10)), plan(live).plan, NOW)),
        );

        expect(await batches()).toEqual({ count: before.count + 1, sum: before.sum + 2 });
        expect(logs).toContain("r2 reconcile deleting orphan objects");
      });

      it("records nothing and does not warn when there is nothing to delete", async () => {
        const before = await batches();
        const all = objectsAt(10).map((o) => o.key);
        const logs = await captureLogs(() =>
          run(reconcileOrphanObjects(createBucket(objectsAt(10)), plan(all).plan, NOW)),
        );

        expect(await batches()).toEqual(before);
        expect(logs).not.toContain("deleting orphan objects");
      });

      it("records nothing and does not warn when the run is held", async () => {
        const before = await batches();
        const position = memoryPosition({ referenced: 100 });
        const p = plan(
          live,
          { budget: budget({ maxObjects: 100, maxListCalls: 10 }, position.store) },
          8,
        );
        const logs = await captureLogs(() =>
          run(reconcileOrphanObjects(createBucket(objectsAt(10)), p.plan, NOW)),
        );

        expect(await batches()).toEqual(before);
        expect(logs).not.toContain("deleting orphan objects");
      });
    });
  });
});

describe("reconcileDisabled", () => {
  it.each([undefined, false, "false", " FALSE ", "False"])(
    "leaves the reconcilers on for %p",
    (value) => {
      expect(reconcileDisabled(value)).toBe(false);
    },
  );

  it.each(["true", "TRUE", "1", "yes", "", "no", true, 0, {}])(
    "turns the reconcilers off for %p, since only false keeps them on",
    (value) => {
      expect(reconcileDisabled(value)).toBe(true);
    },
  );
});

describe("wrangler.toml", () => {
  // Named environments inherit no vars, so each tier declares the flag; the
  // string "false" is the value that keeps both reconcilers running.
  it('declares CIRE_R2_RECONCILE_DISABLED as the string "false" in every tier', async () => {
    const toml = Bun.TOML.parse(
      await Bun.file(new URL("../../wrangler.toml", import.meta.url)).text(),
    ) as {
      vars: Record<string, unknown>;
      env: Record<string, { vars?: Record<string, unknown> }>;
    };
    const tiers = {
      top: toml.vars,
      ...Object.fromEntries(Object.entries(toml.env).map(([n, e]) => [n, e.vars])),
    };

    expect(Object.keys(tiers).toSorted()).toEqual(["dev", "production", "top"]);
    for (const vars of Object.values(tiers)) {
      expect(vars?.CIRE_R2_RECONCILE_DISABLED).toBe("false");
    }
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

/**
 * A Worker that runs one R2 call per request against its own binding and
 * answers with plain JSON. `{ bucket, op, args }` names the binding, the call
 * and its arguments; `seed` writes every key it is given, in one request.
 */
const R2_WORKER = `
export default {
  async fetch(request, env) {
    const { bucket, op, args } = await request.json();
    const r2 = env[bucket];
    try {
      switch (op) {
        case "seed":
          for (const key of args[0]) await r2.put(key, "x");
          return Response.json(null);
        case "list": {
          const page = await r2.list(args[0]);
          return Response.json({
            objects: page.objects.map((o) => ({ key: o.key, uploaded: o.uploaded.toISOString() })),
            truncated: page.truncated,
            cursor: page.cursor,
          });
        }
        case "head": {
          const object = await r2.head(args[0]);
          return Response.json(object && { key: object.key });
        }
        case "get": {
          const object = await r2.get(args[0]);
          return Response.json(object && { text: await object.text() });
        }
        case "put":
          await r2.put(args[0], args[1]);
          return Response.json(null);
        case "delete":
          await r2.delete(args[0]);
          return Response.json(null);
        default:
          return new Response("unknown op " + op, { status: 400 });
      }
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
`;

// The walk's safety rests on how R2 answers `list`: prefix filtering, cursor
// paging, `startAfter`, `limit`, and the `uploaded` time it reports. The stub
// above encodes one reading of that; this runs the same walk against workerd's
// own R2, with the position kept in the same bucket.
//
// Each bucket call goes through `R2_WORKER` as one request, and the walk reads
// plain values. `mf.getR2Bucket` would hand back proxies instead, and every
// `key` or `uploaded` read on a listed object is then a blocking round trip to
// workerd (`Atomics.wait` on the main thread). A thousand-object walk makes
// thousands of them, which outlasts the test's budget on a loaded runner. A
// timeout there is worse than a failure: bun kills workerd, and the next
// blocking read waits on it forever, so `bun test` never exits.
describe("reconcileOrphanObjects against workerd's R2", () => {
  type WorkerdBucket = ReconcilableBucket &
    PositionBucket & {
      list(o: { prefix?: string; cursor?: string }): Promise<{
        objects: Array<{ key: string; uploaded: Date }>;
        truncated: boolean;
        cursor?: string;
      }>;
    };
  type ListedPage = {
    objects: Array<{ key: string; uploaded: string }>;
    truncated: boolean;
    cursor?: string;
  };
  let mf: Miniflare;
  // One bucket per test, so no test has to empty a bucket for the next.
  let paged: WorkerdBucket;
  let resumed: WorkerdBucket;
  let halved: WorkerdBucket;

  const call = async <T>(bucket: string, op: string, ...args: unknown[]): Promise<T> => {
    const res = await mf.dispatchFetch("http://r2.test/", {
      method: "POST",
      body: JSON.stringify({ bucket, op, args }),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as T;
  };

  const workerdBucket = (bucket: string): WorkerdBucket => ({
    list: async (options) => {
      const page = await call<ListedPage>(bucket, "list", options ?? {});
      return {
        ...page,
        objects: page.objects.map((o) => ({ key: o.key, uploaded: new Date(o.uploaded) })),
      };
    },
    head: (key) => call<{ key: string } | null>(bucket, "head", key),
    get: async (key) => {
      const object = await call<{ text: string } | null>(bucket, "get", key);
      return object && { text: async () => object.text };
    },
    put: async (key, value) => {
      await call(bucket, "put", key, value);
    },
    delete: async (keys) => {
      await call(bucket, "delete", keys);
    },
  });

  const seed = (bucket: string, keys: ReadonlyArray<string>) => call(bucket, "seed", keys);

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: R2_WORKER,
      r2Buckets: ["PAGED", "RESUMED", "GUARDED"],
    });
    await mf.ready;
    paged = workerdBucket("PAGED");
    resumed = workerdBucket("RESUMED");
    halved = workerdBucket("GUARDED");
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  const allKeys = async (r2: WorkerdBucket) => {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await r2.list({ cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys.toSorted();
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
    await seed("PAGED", [...live, ...orphans, ...outside]);

    const deleted = await run(reconcileOrphanObjects(paged, plan(live).plan, later()));

    expect(deleted).toBe(orphans.length);
    expect(await allKeys(paged)).toEqual([...live, ...outside].toSorted());
  }, 30_000);

  it("resumes with startAfter across runs, keeping its position in the bucket, until every orphan is gone", async () => {
    const live = Array.from({ length: 25 }, (_, i) => `imports/r-${String(i).padStart(2, "0")}/e`);
    const orphans = ["imports/r-03/x", "imports/r-11/x", "imports/r-19/x", "imports/r-24/x"];
    await seed("RESUMED", [...live, ...orphans]);
    const positionKey = "reconcile/test-position.json";
    const p = plan(live, {
      budget: budget(
        { maxObjects: 6, maxListCalls: 5 },
        r2PositionStore(resumed, positionKey, "sheets"),
      ),
    });

    const stored = async () => {
      const object = await resumed.get(positionKey);
      return object && (JSON.parse(await object.text()) as StoredPosition);
    };
    let runs = 0;
    let midLap = false;
    let lapOpen = true;
    while (lapOpen && runs < 20) {
      await run(reconcileOrphanObjects(resumed, p.plan, later()));
      runs += 1;
      lapOpen = (await stored())?.after !== undefined;
      if (lapOpen) midLap = true;
    }

    expect(midLap).toBe(true);
    expect(runs).toBeLessThan(20);
    // Between laps the object keeps only the count.
    expect(await stored()).toEqual({ referenced: live.length });
    expect(await allKeys(resumed)).toEqual([...live, positionKey].toSorted());
  }, 30_000);

  it("keeps the referencing-row count in the bucket's position object and holds one run when it halves", async () => {
    const live = Array.from({ length: 6 }, (_, i) => `imports/g-${i}/e`);
    const orphan = "imports/g-9/x";
    await seed("GUARDED", [...live, orphan]);
    const positionKey = "reconcile/guarded-position.json";
    const halvedPlan = (rows: number) =>
      plan(
        live,
        {
          budget: budget(
            { maxObjects: 100, maxListCalls: 5 },
            r2PositionStore(halved, positionKey, "sheets"),
          ),
        },
        rows,
      ).plan;
    const stored = async () => {
      const object = await halved.get(positionKey);
      return object && (JSON.parse(await object.text()) as StoredPosition);
    };

    // The last run counted 100 rows and this one 49: it holds and keeps 49.
    // The next run compares with 49 and reaps the orphan.
    await call("GUARDED", "put", positionKey, JSON.stringify({ referenced: 100 }));
    expect(await run(reconcileOrphanObjects(halved, halvedPlan(49), later()))).toBe(0);
    expect(await stored()).toEqual({ referenced: 49 });
    expect(await allKeys(halved)).toContain(orphan);

    expect(await run(reconcileOrphanObjects(halved, halvedPlan(49), later()))).toBe(1);
    expect(await stored()).toEqual({ referenced: 49 });
    expect(await allKeys(halved)).not.toContain(orphan);
  }, 30_000);
});
