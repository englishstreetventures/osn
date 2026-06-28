import { describe, it, expect } from "bun:test";

import { events, weddings, weddingInviteCustomisations } from "@cire/db";
import { Effect } from "effect";

import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import {
  assetReconcileService,
  ASSETS_PREFIX,
  RECONCILE_GRACE_MS,
  RECONCILE_DELETE_CAP,
  type ReconcilableBucket,
} from "./asset-reconcile";

const withDb = effWith(TestDbLayer);

const NOW = new Date("2026-06-20T04:00:00.000Z");
const OLD = new Date(NOW.getTime() - RECONCILE_GRACE_MS - 60_000); // past grace
const FRESH = new Date(NOW.getTime() - 60_000); // within grace

/**
 * In-memory `cire-assets` stub: a map of key → uploaded-Date, with cursor
 * pagination over `list()` and a recording `delete()` that supports both the
 * single-key and array (multi-key) forms (so the reaper's array-first path is
 * exercised). `listThrows` forces `list()` to throw (bucket-list-failure abort).
 */
function createAssetsStub(
  initial: Array<{ key: string; uploaded: Date }>,
  opts: { pageSize?: number; listThrows?: boolean } = {},
): ReconcilableBucket & { deleted: Set<string>; remaining: () => string[] } {
  const store = new Map<string, Date>(initial.map((o) => [o.key, o.uploaded]));
  const deleted = new Set<string>();
  const pageSize = opts.pageSize ?? 1000;
  const removeOne = (key: string) => {
    if (store.delete(key)) deleted.add(key);
  };
  return {
    deleted,
    remaining: () => [...store.keys()],
    list(options) {
      if (opts.listThrows) throw new Error("list boom");
      const prefix = options?.prefix ?? "";
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, uploaded]) => ({ key, uploaded }))
        .toSorted((a, b) => a.key.localeCompare(b.key));
      const start = options?.cursor ? Number(options.cursor) : 0;
      const slice = all.slice(start, start + pageSize);
      const end = start + slice.length;
      const truncated = end < all.length;
      return Promise.resolve({
        objects: slice,
        truncated,
        cursor: truncated ? String(end) : undefined,
      });
    },
    delete(keys) {
      if (Array.isArray(keys)) {
        for (const k of keys) removeOne(k);
      } else {
        removeOne(keys);
      }
      return Promise.resolve();
    },
  };
}

/** Insert a wedding with a customisation row carrying hero/story keys + an event
 *  with an event-image key. Returns the keys it referenced (the "live" set). */
function seedReferenced(opts: {
  hero?: string;
  story?: string;
  eventKey?: string;
}): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const now = new Date();
    const weddingId = `wed_${crypto.randomUUID()}`;
    db.insert(weddings)
      .values({
        id: weddingId,
        slug: `slug-${weddingId}`,
        displayName: "Live Wedding",
        ownerOsnProfileId: "usr_test",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (opts.hero || opts.story) {
      db.insert(weddingInviteCustomisations)
        .values({
          weddingId,
          heroImageKey: opts.hero ?? null,
          storyImageKey: opts.story ?? null,
          updatedAt: now,
        })
        .run();
    }
    if (opts.eventKey) {
      db.insert(events)
        .values({
          id: `${weddingId}-ev-0`,
          weddingId,
          slug: `${weddingId}-ev-0`,
          name: "Ceremony",
          startAt: "2025-01-01T10:00:00+11:00",
          endAt: "2025-01-01T12:00:00+11:00",
          timezone: "Australia/Sydney",
          eventImageKey: opts.eventKey,
        })
        .run();
    }
  });
}

describe("asset-reconcile constants", () => {
  it("grace window is 7 days and the cap is 500", () => {
    expect(RECONCILE_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(RECONCILE_DELETE_CAP).toBe(500);
    expect(ASSETS_PREFIX).toBe("assets/");
  });
});

describe("assetReconcileService.reconcileOrphans", () => {
  it(
    "deletes an unreferenced + old object",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ hero: "assets/wedA/hero-live" });
        const bucket = createAssetsStub([
          { key: "assets/wedA/hero-live", uploaded: OLD },
          { key: "assets/wedA/hero-orphan", uploaded: OLD },
        ]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(1);
        expect(bucket.deleted.has("assets/wedA/hero-orphan")).toBe(true);
        // The live key is never deleted.
        expect(bucket.deleted.has("assets/wedA/hero-live")).toBe(false);
      }),
    ),
  );

  it(
    "NEVER deletes a referenced key (hero, story, or event image)",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({
          hero: "assets/wedB/hero-x",
          story: "assets/wedB/story-y",
          eventKey: "assets/wedB/event-z",
        });
        const bucket = createAssetsStub([
          { key: "assets/wedB/hero-x", uploaded: OLD },
          { key: "assets/wedB/story-y", uploaded: OLD },
          { key: "assets/wedB/event-z", uploaded: OLD },
        ]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.deleted.size).toBe(0);
        expect(bucket.remaining().length).toBe(3);
      }),
    ),
  );

  it(
    "does NOT delete an unreferenced but too-new object (grace period)",
    withDb(
      Effect.gen(function* () {
        // A live reference exists so the empty-set abort guard doesn't fire.
        yield* seedReferenced({ hero: "assets/wedC/hero-live" });
        const bucket = createAssetsStub([
          { key: "assets/wedC/hero-live", uploaded: OLD },
          { key: "assets/wedC/fresh-orphan", uploaded: FRESH },
        ]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.deleted.has("assets/wedC/fresh-orphan")).toBe(false);
      }),
    ),
  );

  it(
    "ABORTS (deletes nothing) when the referenced set is empty but the bucket is non-empty",
    withDb(
      Effect.gen(function* () {
        // No customisation/event rows seeded ⇒ referenced set is empty. The
        // bucket has objects ⇒ a strong signal the DB read is wrong. Abort.
        const bucket = createAssetsStub([
          { key: "assets/wedD/hero-1", uploaded: OLD },
          { key: "assets/wedD/hero-2", uploaded: OLD },
        ]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.deleted.size).toBe(0);
        expect(bucket.remaining().length).toBe(2);
      }),
    ),
  );

  it(
    "an empty referenced set against an EMPTY bucket is a clean no-op (not an abort signal)",
    withDb(
      Effect.gen(function* () {
        const bucket = createAssetsStub([]);
        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);
        expect(deleted).toBe(0);
      }),
    ),
  );

  it(
    "ignores keys NOT under the assets/ prefix",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ hero: "assets/wedE/hero-live" });
        const bucket = createAssetsStub([
          { key: "assets/wedE/hero-live", uploaded: OLD },
          { key: "assets/wedE/orphan", uploaded: OLD },
          // Non-assets keys must never be touched — not even listed against.
          { key: "imports/wedE/guests.csv", uploaded: OLD },
          { key: "random/object", uploaded: OLD },
        ]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(1);
        expect(bucket.deleted.has("assets/wedE/orphan")).toBe(true);
        expect(bucket.deleted.has("imports/wedE/guests.csv")).toBe(false);
        expect(bucket.deleted.has("random/object")).toBe(false);
      }),
    ),
  );

  it(
    "respects the per-run delete cap and continues across cursor pages",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ hero: "assets/wedF/hero-live" });
        // One live key + (cap + 50) old orphans, served 100 per page so the
        // cursor-pagination path is exercised.
        const objects = [{ key: "assets/wedF/hero-live", uploaded: OLD }];
        const orphanCount = RECONCILE_DELETE_CAP + 50;
        for (let i = 0; i < orphanCount; i++) {
          objects.push({
            key: `assets/wedF/orphan-${String(i).padStart(4, "0")}`,
            uploaded: OLD,
          });
        }
        const bucket = createAssetsStub(objects, { pageSize: 100 });

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        // Capped at exactly RECONCILE_DELETE_CAP this run; the live key untouched.
        expect(deleted).toBe(RECONCILE_DELETE_CAP);
        expect(bucket.deleted.size).toBe(RECONCILE_DELETE_CAP);
        expect(bucket.deleted.has("assets/wedF/hero-live")).toBe(false);
      }),
    ),
  );

  it(
    "ABORTS (deletes nothing) when the bucket list() throws",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ hero: "assets/wedG/hero-live" });
        const bucket = createAssetsStub([{ key: "assets/wedG/orphan", uploaded: OLD }], {
          listThrows: true,
        });

        const result = yield* assetReconcileService
          .reconcileOrphans(bucket, NOW)
          .pipe(
            Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "ok" as const }),
          );

        expect(result).toBe("failed");
        expect(bucket.deleted.size).toBe(0);
      }),
    ),
  );

  it(
    "is a no-op when the ASSETS binding is absent",
    withDb(
      Effect.gen(function* () {
        const deleted = yield* assetReconcileService.reconcileOrphans(undefined, NOW);
        expect(deleted).toBe(0);
      }),
    ),
  );
});
