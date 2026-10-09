import { describe, expect, it, spyOn } from "bun:test";

import * as cireSchema from "@cire/db";
import { events, registryItems, weddingInviteCustomisations } from "@cire/db";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import {
  ASSET_LIST_LIMITS,
  ASSET_POSITION_KEY,
  assetReconcileService,
  ASSETS_PREFIX,
  type AssetsBucket,
} from "../../src/services/asset-reconcile";
import {
  RECONCILE_DELETE_CAP,
  RECONCILE_GRACE_MS,
  RECONCILE_HOLD_RUNS,
  RECONCILE_STOP_KEY,
  type ReconcileAlert,
} from "../../src/services/r2-reconcile";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

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
): AssetsBucket & {
  deleted: Set<string>;
  remaining: () => string[];
  stored: (key: string) => string | undefined;
} {
  const store = new Map<string, Date>(initial.map((o) => [o.key, o.uploaded]));
  const texts = new Map<string, string>();
  const deleted = new Set<string>();
  const pageSize = opts.pageSize ?? 1000;
  const removeOne = (key: string) => {
    if (store.delete(key)) deleted.add(key);
  };
  return {
    deleted,
    remaining: () => [...store.keys()],
    stored: (key) => texts.get(key),
    head(key) {
      const uploaded = store.get(key);
      return Promise.resolve(uploaded ? { key, uploaded } : null);
    },
    // The walk's position, kept beside the images as the real bucket keeps it.
    // `list` pages by its own cursor and ignores `startAfter`, so a test that
    // runs twice must fit its walk in one run.
    get(key) {
      const text = texts.get(key);
      return Promise.resolve(text === undefined ? null : { text: () => Promise.resolve(text) });
    },
    put(key, value) {
      texts.set(key, value);
      return Promise.resolve();
    },
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

/** Insert a wedding with a customisation row carrying per-slot image keys + an
 *  event with an event-image key. Returns the keys it referenced ("live"). */
function seedReferenced(opts: {
  hero?: string;
  story?: string;
  footer?: string;
  eventKey?: string;
  registryKey?: string;
}): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const now = new Date();
    const weddingId = `wed_${crypto.randomUUID()}`;
    insertWedding(db, {
      id: weddingId,
      slug: `slug-${weddingId}`,
      displayName: "Live Wedding",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_test"],
    });
    if (opts.hero || opts.story || opts.footer) {
      db.insert(weddingInviteCustomisations)
        .values({
          weddingId,
          heroImageKey: opts.hero ?? null,
          storyImageKey: opts.story ?? null,
          footerImageKey: opts.footer ?? null,
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
    if (opts.registryKey) {
      db.insert(registryItems)
        .values({
          id: `reg_${crypto.randomUUID()}`,
          weddingId,
          title: "Copper pan",
          imageKey: opts.registryKey,
          createdAt: now,
          updatedAt: now,
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

  // The cases below seed every image-key column `loadReferencedKeys` reads.
  // An image-key column added to the schema and not to that read would make
  // its images look orphaned; this fails until both lists are updated.
  it("knows every image-key column in the schema", () => {
    const tables = (Object.values(cireSchema) as unknown[]).flatMap((v) =>
      is(v, SQLiteTable) ? [v] : [],
    );
    const columns = tables
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.columns
          .filter((c) => c.name.endsWith("image_key"))
          .map((c) => `${config.name}.${c.name}`);
      })
      .toSorted();
    expect(columns).toEqual([
      "events.event_image_key",
      "registry_items.image_key",
      "wedding_invite_customisations.footer_image_key",
      "wedding_invite_customisations.hero_image_key",
      "wedding_invite_customisations.story_image_key",
    ]);
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

  // Every wedding-level image slot must be in `loadReferencedKeys`' select — a
  // slot omitted there reads as unreferenced, so its images get swept once past
  // the grace window. This is the regression guard for that.
  it(
    "NEVER deletes a referenced key (hero, story, footer, or event image)",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({
          hero: "assets/wedB/hero-x",
          story: "assets/wedB/story-y",
          footer: "assets/wedB/footer-w",
          eventKey: "assets/wedB/event-z",
        });
        const bucket = createAssetsStub([
          { key: "assets/wedB/hero-x", uploaded: OLD },
          { key: "assets/wedB/story-y", uploaded: OLD },
          { key: "assets/wedB/footer-w", uploaded: OLD },
          { key: "assets/wedB/event-z", uploaded: OLD },
        ]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.deleted.size).toBe(0);
        expect(bucket.remaining().length).toBe(4);
      }),
    ),
  );

  // A footer image on a wedding with NO hero/story must still count as live.
  it(
    "NEVER deletes a footer image that is the wedding's only invite asset",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ footer: "assets/wedB2/footer-only" });
        const bucket = createAssetsStub([{ key: "assets/wedB2/footer-only", uploaded: OLD }]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.remaining().length).toBe(1);
      }),
    ),
  );

  // Registry images share the `assets/` prefix with the invite images, so the
  // sweep sees them. They are referenced from a DIFFERENT table, and a table
  // missing from `loadReferencedKeys` reads as "nobody owns this" — the sweep
  // would then delete every registry picture older than the grace window while
  // the items still point at them.
  it(
    "NEVER deletes a key referenced by a registry item",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ registryKey: "assets/wedR/registry-live" });
        const bucket = createAssetsStub([
          { key: "assets/wedR/registry-live", uploaded: OLD },
          { key: "assets/wedR/registry-orphan", uploaded: OLD },
        ]);

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        // The orphan still goes — the registry row is a reference, not a blanket
        // exemption for the prefix.
        expect(deleted).toBe(1);
        expect(bucket.deleted.has("assets/wedR/registry-orphan")).toBe(true);
        expect(bucket.remaining()).toEqual(["assets/wedR/registry-live"]);
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
        // One live key + (cap + 50) old orphans, served 250 per page so the
        // cursor-pagination path is exercised within one run's three list calls.
        const objects = [{ key: "assets/wedF/hero-live", uploaded: OLD }];
        const orphanCount = RECONCILE_DELETE_CAP + 50;
        for (let i = 0; i < orphanCount; i++) {
          objects.push({
            key: `assets/wedF/orphan-${String(i).padStart(4, "0")}`,
            uploaded: OLD,
          });
        }
        const bucket = createAssetsStub(objects, { pageSize: 250 });

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
    "reads the live keys once a run, for both the sample and the lookup",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ hero: "assets/wedH/hero-live" });
        const bucket = createAssetsStub([
          { key: "assets/wedH/hero-live", uploaded: OLD },
          { key: "assets/wedH/orphan", uploaded: OLD },
        ]);
        const db = yield* DbService;
        const client = (db as unknown as { $client: { prepare: (sql: string) => unknown } })
          .$client;
        const prepare = spyOn(client, "prepare");

        const deleted = yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        const selects = prepare.mock.calls.filter(([sql]) =>
          sql.trim().toLowerCase().startsWith("select"),
        );
        prepare.mockRestore();
        expect(deleted).toBe(1);
        // Customisations, event images and registry images, in one statement.
        expect(selects).toHaveLength(1);
      }),
    ),
  );

  it(
    "lists a bounded page a run and keeps its place outside assets/",
    withDb(
      Effect.gen(function* () {
        expect(ASSET_LIST_LIMITS).toEqual({ maxObjects: 1_000, maxListCalls: 3 });
        expect(ASSET_POSITION_KEY.startsWith(ASSETS_PREFIX)).toBe(false);
        const objects = Array.from({ length: 1_005 }, (_, i) => ({
          key: `assets/wedP/fresh-${String(i).padStart(4, "0")}`,
          uploaded: FRESH,
        }));
        const bucket = createAssetsStub(objects);
        const puts: Array<[string, string]> = [];
        bucket.put = (key, value) => {
          puts.push([key, value]);
          return Promise.resolve();
        };

        yield* assetReconcileService.reconcileOrphans(bucket, NOW);

        expect(puts).toHaveLength(1);
        expect(puts[0]![0]).toBe(ASSET_POSITION_KEY);
        expect(JSON.parse(puts[0]![1])).toEqual({
          after: "assets/wedP/fresh-0999",
          lapStartedAt: NOW.getTime(),
        });
      }),
    ),
  );

  it(
    "counts each row that names an image once, and no row that names none",
    withDb(
      Effect.gen(function* () {
        // One customisation row with two images, one event, one registry item.
        yield* seedReferenced({
          hero: "assets/wedK/hero-live",
          story: "assets/wedK/story-live",
          eventKey: "assets/wedK/event-live",
          registryKey: "assets/wedK/registry-live",
        });
        // A wedding whose customisation row names no image.
        const db = yield* DbService;
        const bare = `wed_${crypto.randomUUID()}`;
        const now = new Date();
        insertWedding(db, {
          id: bare,
          slug: `slug-${bare}`,
          displayName: "Bare Wedding",
          createdAt: now,
          updatedAt: now,
          owners: ["usr_test"],
        });
        db.insert(weddingInviteCustomisations).values({ weddingId: bare, updatedAt: now }).run();
        const bucket = createAssetsStub([
          { key: "assets/wedK/hero-live", uploaded: OLD },
          { key: "assets/wedK/orphan", uploaded: OLD },
        ]);

        expect(yield* assetReconcileService.reconcileOrphans(bucket, NOW)).toBe(1);
        expect(JSON.parse(bucket.stored(ASSET_POSITION_KEY)!)).toEqual({ referenced: 3 });
      }),
    ),
  );

  it(
    "holds while the rows naming images number fewer than half of those counted before, alerting, and reaps once they recover",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ hero: "assets/wedL/hero-live" });
        const bucket = createAssetsStub([
          { key: "assets/wedL/hero-live", uploaded: OLD },
          { key: "assets/wedL/orphan", uploaded: OLD },
        ]);
        const alerts: ReconcileAlert[] = [];
        const alertOperator = (alert: ReconcileAlert) => Effect.sync(() => void alerts.push(alert));
        // The last run counted three rows; one is left.
        yield* Effect.promise(() =>
          bucket.put(ASSET_POSITION_KEY, JSON.stringify({ referenced: 3 })),
        );

        expect(yield* assetReconcileService.reconcileOrphans(bucket, NOW, { alertOperator })).toBe(
          0,
        );
        expect(bucket.remaining()).toContain("assets/wedL/orphan");
        expect(JSON.parse(bucket.stored(ASSET_POSITION_KEY)!)).toEqual({
          referenced: 3,
          heldRuns: 1,
        });
        expect(alerts).toEqual([
          {
            kind: "held",
            bucket: "assets",
            referencingRows: 1,
            previousRows: 3,
            heldRuns: 1,
            runsLeft: RECONCILE_HOLD_RUNS - 1,
          },
        ]);

        // Two rows is not more than half gone.
        yield* seedReferenced({ eventKey: "assets/wedM/event-live" });
        expect(yield* assetReconcileService.reconcileOrphans(bucket, NOW, { alertOperator })).toBe(
          1,
        );
        expect(bucket.deleted).toEqual(new Set(["assets/wedL/orphan"]));
      }),
    ),
  );

  it(
    "deletes nothing and alerts while reconcile/stop is in the bucket",
    withDb(
      Effect.gen(function* () {
        yield* seedReferenced({ hero: "assets/wedS/hero-live" });
        const bucket = createAssetsStub([
          { key: "assets/wedS/hero-live", uploaded: OLD },
          { key: "assets/wedS/orphan", uploaded: OLD },
          { key: RECONCILE_STOP_KEY, uploaded: FRESH },
        ]);
        const alerts: ReconcileAlert[] = [];

        expect(
          yield* assetReconcileService.reconcileOrphans(bucket, NOW, {
            alertOperator: (alert) => Effect.sync(() => void alerts.push(alert)),
          }),
        ).toBe(0);
        expect(bucket.deleted.size).toBe(0);
        expect(alerts).toEqual([{ kind: "stopped", bucket: "assets", stoppedDays: 0 }]);
        expect(RECONCILE_STOP_KEY.startsWith(ASSETS_PREFIX)).toBe(false);
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
