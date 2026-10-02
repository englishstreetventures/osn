import { describe, expect, it } from "bun:test";

import { imports } from "@cire/db";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { RECONCILE_GRACE_MS, type ReconcilableBucket } from "../../src/services/r2-reconcile";
import {
  SHEET_LIST_BUDGET,
  SHEETS_PREFIX,
  sheetReconcileService,
} from "../../src/services/sheet-reconcile";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

const withDb = effWith(TestDbLayer);

const NOW = new Date("2026-06-20T04:00:00.000Z");
const OLD = new Date(NOW.getTime() - RECONCILE_GRACE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);

/** In-memory `cire-sheets`: code-unit-ordered, cursor-paged, recording deletes. */
function createSheetsStub(
  initial: ReadonlyArray<{ key: string; uploaded: Date }>,
): ReconcilableBucket & { deleted: Set<string>; remaining: () => string[] } {
  const store = new Map(initial.map((o) => [o.key, o.uploaded]));
  const deleted = new Set<string>();
  return {
    deleted,
    remaining: () => [...store.keys()].toSorted(),
    list(options) {
      const prefix = options?.prefix ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).toSorted();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const slice = keys.slice(start, start + (options?.limit ?? 1000));
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

const keysFor = (importId: string) => ({
  events: `imports/${importId}/events.csv`,
  guests: `imports/${importId}/guests.csv`,
  beforeEvents: `imports/${importId}/before/events.csv`,
  beforeGuests: `imports/${importId}/before/guests.csv`,
});

/**
 * One wedding with one change row. `before: false` leaves the before-image
 * keys NULL, as a preview row has them and as the before-image prune leaves
 * them once it has taken a change's snapshot away.
 */
function seedChange(opts: {
  status?: "preview" | "applied" | "reverted";
  before?: boolean;
}): Effect.Effect<ReturnType<typeof keysFor>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const now = new Date();
    const weddingId = `wed_${crypto.randomUUID()}`;
    insertWedding(db, {
      id: weddingId,
      slug: `slug-${weddingId}`,
      displayName: "Sheet Wedding",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_test"],
    });
    const importId = crypto.randomUUID();
    const keys = keysFor(importId);
    db.insert(imports)
      .values({
        id: importId,
        weddingId,
        uploadedAt: now.getTime(),
        format: "csv",
        eventsR2Key: keys.events,
        guestsR2Key: keys.guests,
        beforeEventsR2Key: opts.before === false ? null : keys.beforeEvents,
        beforeGuestsR2Key: opts.before === false ? null : keys.beforeGuests,
        summary: "{}",
        status: opts.status ?? "applied",
      })
      .run();
    return keys;
  });
}

const old = (...keys: string[]) => keys.map((key) => ({ key, uploaded: OLD }));

describe("sheet reconciliation settings", () => {
  it("walks only imports/ and bounds the listing per run", () => {
    expect(SHEETS_PREFIX).toBe("imports/");
    expect(SHEET_LIST_BUDGET).toEqual({ maxObjects: 10_000, maxListCalls: 12 });
  });
});

describe("sheetReconcileService.reconcileOrphans", () => {
  it(
    "keeps a sheet an imports row references and reaps an orphan",
    withDb(
      Effect.gen(function* () {
        const live = yield* seedChange({ before: false });
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub(
          old(live.events, live.guests, orphan.events, orphan.guests),
        );

        const deleted = yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(2);
        expect([...bucket.deleted].toSorted()).toEqual([orphan.events, orphan.guests].toSorted());
        expect(bucket.remaining()).toEqual([live.events, live.guests].toSorted());
      }),
    ),
  );

  it(
    "keeps the objects of all four key columns, whatever the row's status",
    withDb(
      Effect.gen(function* () {
        const applied = yield* seedChange({ status: "applied" });
        const reverted = yield* seedChange({ status: "reverted" });
        const preview = yield* seedChange({ status: "preview", before: false });
        const all = [
          ...Object.values(applied),
          ...Object.values(reverted),
          preview.events,
          preview.guests,
        ];
        const bucket = createSheetsStub(old(...all));

        const deleted = yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.remaining()).toEqual([...all].toSorted());
      }),
    ),
  );

  it(
    "reaps a before-image whose row no longer names it, and keeps that row's uploads",
    withDb(
      Effect.gen(function* () {
        // The row exists, but its before keys are NULL: a prune that cleared
        // them after its R2 delete failed. Per-key, not per-import, decides.
        const pruned = yield* seedChange({ before: false });
        const bucket = createSheetsStub(
          old(pruned.events, pruned.guests, pruned.beforeEvents, pruned.beforeGuests),
        );

        const deleted = yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(2);
        expect(bucket.remaining()).toEqual([pruned.events, pruned.guests].toSorted());
      }),
    ),
  );

  it(
    "keeps an unreferenced object inside the grace window",
    withDb(
      Effect.gen(function* () {
        // Uploaded, row not yet written: the preview route stores the sheets
        // before it inserts the row.
        const live = yield* seedChange({});
        const pending = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub([
          ...old(live.events),
          { key: pending.events, uploaded: FRESH },
          { key: pending.guests, uploaded: FRESH },
        ]);

        const deleted = yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.deleted.size).toBe(0);
      }),
    ),
  );

  it(
    "deletes nothing when no imports row exists but the bucket holds sheets",
    withDb(
      Effect.gen(function* () {
        const bucket = createSheetsStub(old(...Object.values(keysFor(crypto.randomUUID()))));

        const deleted = yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.deleted.size).toBe(0);
      }),
    ),
  );

  it(
    "never touches a key outside imports/",
    withDb(
      Effect.gen(function* () {
        yield* seedChange({});
        const bucket = createSheetsStub(old("assets/w/hero", "exports/x.csv", "importsX/odd"));

        const deleted = yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        expect(deleted).toBe(0);
        expect(bucket.remaining()).toHaveLength(3);
      }),
    ),
  );

  it(
    "is a no-op when the SHEETS binding is absent",
    withDb(
      Effect.gen(function* () {
        expect(yield* sheetReconcileService.reconcileOrphans(undefined, NOW)).toBe(0);
      }),
    ),
  );

  it(
    "counts what it reaps on cire.r2.objects.swept with bucket=sheets",
    withDb(
      Effect.gen(function* () {
        yield* seedChange({});
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub(old(orphan.events, orphan.guests, orphan.beforeEvents));
        const attrs = { bucket: "sheets", result: "ok" };
        const before = yield* Effect.promise(() => counterValue("cire.r2.objects.swept", attrs));

        yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        const after = yield* Effect.promise(() => counterValue("cire.r2.objects.swept", attrs));
        expect(after).toBe(before + 3);
      }),
    ),
  );
});
