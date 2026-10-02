import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";
import { Miniflare } from "miniflare";

import {
  RECONCILE_DELETE_CAP,
  RECONCILE_GRACE_MS,
  reconcileOrphanObjects,
  type ReconcilableBucket,
  type ReconcilePlan,
} from "../../src/services/r2-reconcile";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";

const NOW = new Date("2026-06-20T04:00:00.000Z");
const OLD = new Date(NOW.getTime() - RECONCILE_GRACE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);

const PREFIX = "imports/";

/**
 * In-memory listable bucket. Keys are listed in code-unit order (`.toSorted()`),
 * which is the byte order R2 lists ASCII keys in. `limit` is honoured; `shortPages`
 * makes every page return at most that many objects while still reporting
 * `truncated`, which R2 is allowed to do. Records every `list` call.
 */
function createBucket(
  initial: ReadonlyArray<{ key: string; uploaded: Date }>,
  opts: { shortPages?: number; listThrowsOnCall?: number } = {},
): ReconcilableBucket & {
  deleted: Set<string>;
  listCalls: Array<{ prefix?: string; limit?: number }>;
} {
  const store = new Map(initial.map((o) => [o.key, o.uploaded]));
  const deleted = new Set<string>();
  const listCalls: Array<{ prefix?: string; limit?: number }> = [];
  return {
    deleted,
    listCalls,
    list(options) {
      listCalls.push({ prefix: options?.prefix, limit: options?.limit });
      if (opts.listThrowsOnCall === listCalls.length) {
        return Promise.reject(new Error("list boom"));
      }
      const prefix = options?.prefix ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).toSorted();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const take = Math.min(options?.limit ?? 1000, opts.shortPages ?? 1000);
      const slice = keys.slice(start, start + take);
      const end = start + slice.length;
      const truncated = end < keys.length;
      return Promise.resolve({
        objects: slice.map((key) => ({ key, uploaded: store.get(key)! })),
        truncated,
        cursor: truncated ? String(end) : undefined,
      });
    },
    delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (store.delete(k)) deleted.add(k);
      }
      return Promise.resolve();
    },
  };
}

const plan = (
  referenced: ReadonlyArray<string>,
  extra: Partial<ReconcilePlan<never>> = {},
): ReconcilePlan<never> => ({
  label: "sheets",
  prefix: PREFIX,
  referencedKeys: Effect.succeed(new Set(referenced)),
  ...extra,
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("reconcileOrphanObjects", () => {
  it("reaps an unreferenced object past the grace window and keeps everything else", async () => {
    const bucket = createBucket([
      { key: "imports/a/events.csv", uploaded: OLD },
      { key: "imports/b/events.csv", uploaded: OLD },
      { key: "imports/c/events.csv", uploaded: FRESH },
      { key: "assets/x/hero", uploaded: OLD },
    ]);

    const deleted = await run(reconcileOrphanObjects(bucket, plan(["imports/a/events.csv"]), NOW));

    expect(deleted).toBe(1);
    expect([...bucket.deleted]).toEqual(["imports/b/events.csv"]);
  });

  it("deletes nothing when the referenced set is empty but the prefix holds objects", async () => {
    const bucket = createBucket([{ key: "imports/a/events.csv", uploaded: OLD }]);
    const deleted = await run(reconcileOrphanObjects(bucket, plan([]), NOW));
    expect(deleted).toBe(0);
    expect(bucket.deleted.size).toBe(0);
  });

  it("deletes nothing and fails when the referenced-key read dies", async () => {
    const bucket = createBucket([{ key: "imports/a/events.csv", uploaded: OLD }]);
    const result = await run(
      reconcileOrphanObjects(
        bucket,
        plan([], { referencedKeys: Effect.die("read failed") }),
        NOW,
      ).pipe(Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "ok" })),
    );
    expect(result).toBe("R2ReconcileError");
    expect(bucket.listCalls).toHaveLength(0);
    expect(bucket.deleted.size).toBe(0);
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

    const result = await run(
      reconcileOrphanObjects(bucket, plan(["imports/live/events.csv"]), NOW).pipe(
        Effect.match({ onFailure: () => "failed", onSuccess: () => "ok" }),
      ),
    );

    expect(result).toBe("failed");
    expect(bucket.deleted.size).toBe(0);
    expect(await counterValue("cire.r2.objects.swept", { bucket: "sheets", result: "error" })).toBe(
      errorsBefore + 1,
    );
  });

  it("is a no-op when the binding is absent", async () => {
    expect(await run(reconcileOrphanObjects(undefined, plan(["k"]), NOW))).toBe(0);
  });

  it("stops at the delete cap", async () => {
    const objects = Array.from({ length: RECONCILE_DELETE_CAP + 25 }, (_, i) => ({
      key: `imports/${String(i).padStart(4, "0")}/events.csv`,
      uploaded: OLD,
    }));
    const bucket = createBucket(objects, { shortPages: 100 });

    const deleted = await run(reconcileOrphanObjects(bucket, plan(["imports/live"]), NOW));

    expect(deleted).toBe(RECONCILE_DELETE_CAP);
    expect(bucket.deleted.size).toBe(RECONCILE_DELETE_CAP);
  });

  describe("with a listing budget", () => {
    it("never lists more objects than the budget, and says so", async () => {
      const objects = Array.from({ length: 30 }, (_, i) => ({
        key: `imports/${String(i).padStart(2, "0")}/events.csv`,
        uploaded: OLD,
      }));
      const bucket = createBucket(objects);
      let deleted = 0;

      const logs = await captureLogs(async () => {
        deleted = await run(
          reconcileOrphanObjects(
            bucket,
            plan(["imports/live"], { budget: { maxObjects: 12, maxListCalls: 10 } }),
            NOW,
          ),
        );
      });

      // One page, its limit cut to the budget; the first twelve keys reaped.
      expect(bucket.listCalls).toEqual([{ prefix: PREFIX, limit: 12 }]);
      expect(deleted).toBe(12);
      expect([...bucket.deleted].toSorted()).toEqual(objects.slice(0, 12).map((o) => o.key));
      expect(logs).toContain("stopped at its per-run listing budget");
    });

    it("lowers the last page's limit to what the budget has left", async () => {
      const objects = Array.from({ length: 30 }, (_, i) => ({
        key: `imports/${String(i).padStart(2, "0")}/events.csv`,
        uploaded: OLD,
      }));
      const bucket = createBucket(objects, { shortPages: 5 });

      await run(
        reconcileOrphanObjects(
          bucket,
          plan(["imports/live"], { budget: { maxObjects: 12, maxListCalls: 10 } }),
          NOW,
        ),
      );

      expect(bucket.listCalls.map((c) => c.limit)).toEqual([12, 7, 2]);
      expect(bucket.deleted.size).toBe(12);
    });

    it("stops after its list calls even when R2 returns short pages", async () => {
      const objects = Array.from({ length: 30 }, (_, i) => ({
        key: `imports/${String(i).padStart(2, "0")}/events.csv`,
        uploaded: OLD,
      }));
      const bucket = createBucket(objects, { shortPages: 1 });

      const deleted = await run(
        reconcileOrphanObjects(
          bucket,
          plan(["imports/live"], { budget: { maxObjects: 1000, maxListCalls: 3 } }),
          NOW,
        ),
      );

      expect(bucket.listCalls).toHaveLength(3);
      expect(deleted).toBe(3);
    });

    it("walks the whole prefix without a warning when it fits", async () => {
      const objects = Array.from({ length: 10 }, (_, i) => ({
        key: `imports/${i}/events.csv`,
        uploaded: OLD,
      }));
      const bucket = createBucket(objects, { shortPages: 4 });
      let deleted = 0;

      const logs = await captureLogs(async () => {
        deleted = await run(
          reconcileOrphanObjects(
            bucket,
            plan(["imports/live"], { budget: { maxObjects: 10, maxListCalls: 3 } }),
            NOW,
          ),
        );
      });

      expect(deleted).toBe(10);
      expect(logs).not.toContain("listing budget");
    });
  });
});

// The walk's safety rests on how R2 answers `list`: prefix filtering, cursor
// paging, `limit`, and the `uploaded` time it reports. The stub above encodes
// one reading of that; this runs the same walk against workerd's own R2.
describe("reconcileOrphanObjects against workerd's R2", () => {
  let mf: Miniflare;
  let bucket: ReconcilableBucket;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      r2Buckets: ["SHEETS"],
    });
    bucket = (await mf.getR2Bucket("SHEETS")) as unknown as ReconcilableBucket;
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("follows workerd's cursor past the first page and reaps only unreferenced objects", async () => {
    const r2 = bucket as unknown as {
      put(key: string, value: string): Promise<unknown>;
      list(o: { prefix?: string; cursor?: string }): Promise<{
        objects: Array<{ key: string }>;
        truncated: boolean;
        cursor?: string;
      }>;
    };
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
    // Written a few at a time: a thousand concurrent puts can exhaust
    // Miniflare's local proxy when the whole suite runs at once.
    const all = [...live, ...orphans, ...outside];
    for (let i = 0; i < all.length; i += 25) {
      await Promise.all(all.slice(i, i + 25).map((key) => r2.put(key, "x")));
    }
    // Every object was written just now; judge them from eight days ahead so
    // all of them are past the grace window and only the reference decides.
    const later = new Date(Date.now() + RECONCILE_GRACE_MS + 24 * 60 * 60 * 1000);

    const deleted = await run(reconcileOrphanObjects(bucket, plan(live), later));

    expect(deleted).toBe(orphans.length);
    const left: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await r2.list({ cursor });
      left.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    expect(left.toSorted()).toEqual([...live, ...outside].toSorted());
  }, 30_000);

  it("stops at the budget against real pages", async () => {
    const r2 = bucket as unknown as { put(key: string, value: string): Promise<unknown> };
    // These sort before the live objects left by the test above, so a budget
    // of four reaches exactly these and nothing else.
    for (let i = 0; i < 6; i++) await r2.put(`imports/budget-${i}/events.csv`, "x");
    const later = new Date(Date.now() + RECONCILE_GRACE_MS + 24 * 60 * 60 * 1000);

    const deleted = await run(
      reconcileOrphanObjects(
        bucket,
        plan(["imports/0aa/events.csv"], { budget: { maxObjects: 4, maxListCalls: 20 } }),
        later,
      ),
    );

    expect(deleted).toBe(4);
  });
});
