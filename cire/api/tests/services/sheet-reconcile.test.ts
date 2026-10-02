import { describe, expect, it } from "bun:test";

import { imports } from "@cire/db";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { RECONCILE_GRACE_MS } from "../../src/services/r2-reconcile";
import {
  namedSheetKeys,
  namedSheetKeysQuery,
  SHEET_LIST_LIMITS,
  SHEET_POSITION_KEY,
  SHEETS_PREFIX,
  sheetReconcileService,
  type SheetsBucket,
} from "../../src/services/sheet-reconcile";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

const withDb = effWith(TestDbLayer);

const NOW = new Date("2026-06-20T04:00:00.000Z");
const OLD = new Date(NOW.getTime() - RECONCILE_GRACE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);

/**
 * In-memory `cire-sheets`: code-unit-ordered, a cursor that is the last key a
 * page returned, `startAfter` honoured as R2 does, recording deletes. `get` and
 * `put` hold the walk's position next to the sheets, as the real bucket does.
 */
function createSheetsStub(initial: ReadonlyArray<{ key: string; uploaded: Date }>): SheetsBucket & {
  deleted: Set<string>;
  remaining: () => string[];
  stored: (key: string) => string | undefined;
} {
  const store = new Map(initial.map((o) => [o.key, o.uploaded]));
  const texts = new Map<string, string>();
  const deleted = new Set<string>();
  return {
    deleted,
    remaining: () => [...store.keys()].toSorted(),
    stored: (key) => texts.get(key),
    list(options) {
      const prefix = options?.prefix ?? "";
      const bounds = [options?.cursor, options?.startAfter];
      const from = bounds
        .filter((b): b is string => b !== undefined)
        .toSorted()
        .at(-1);
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix) && (from === undefined || k > from))
        .toSorted();
      const slice = keys.slice(0, options?.limit ?? 1000);
      const truncated = slice.length < keys.length;
      return Promise.resolve({
        objects: slice.map((key) => ({ key, uploaded: store.get(key)! })),
        truncated,
        cursor: truncated ? slice.at(-1) : undefined,
      });
    },
    delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (store.delete(k)) deleted.add(k);
        texts.delete(k);
      }
      return Promise.resolve();
    },
    get(key) {
      const text = texts.get(key);
      return Promise.resolve(text === undefined ? null : { text: () => Promise.resolve(text) });
    },
    put(key, value) {
      texts.set(key, value);
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

function seedWedding(db: DbService["Service"]): string {
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
  return weddingId;
}

function insertChange(
  db: DbService["Service"],
  weddingId: string,
  importId: string,
  opts: { status?: "preview" | "applied" | "reverted"; before?: boolean } = {},
) {
  const keys = keysFor(importId);
  db.insert(imports)
    .values({
      id: importId,
      weddingId,
      uploadedAt: Date.now(),
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
}

/**
 * One wedding with one change row. `before: false` leaves the before-image
 * keys NULL, as a preview row has them and as the before-image prune leaves
 * them once it has taken a change's snapshot away.
 */
function seedChange(
  opts: { status?: "preview" | "applied" | "reverted"; before?: boolean } = {},
): Effect.Effect<ReturnType<typeof keysFor>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    return insertChange(db, seedWedding(db), crypto.randomUUID(), opts);
  });
}

const old = (...keys: string[]) => keys.map((key) => ({ key, uploaded: OLD }));

describe("sheet reconciliation settings", () => {
  it("walks only imports/, a page a run, and keeps its place outside imports/", () => {
    expect(SHEETS_PREFIX).toBe("imports/");
    expect(SHEET_LIST_LIMITS).toEqual({ maxObjects: 1_000, maxListCalls: 3 });
    expect(SHEET_POSITION_KEY.startsWith(SHEETS_PREFIX)).toBe(false);
  });

  it("sends a full page of today's longest keys in under 100 KB", () => {
    // The before-image key is the longest shape `r2-imports.ts` builds.
    const longest = keysFor(crypto.randomUUID()).beforeEvents;
    const keys = Array.from({ length: SHEET_LIST_LIMITS.maxObjects + 1 }, () => longest);
    const { params } = new SQLiteSyncDialect().sqlToQuery(namedSheetKeysQuery(keys));
    expect(params).toHaveLength(1);
    expect(new TextEncoder().encode(params[0] as string).length).toBeLessThan(100_000);
  });

  it("reads imports once, with the list unpacked once and never per row", () => {
    const db = createDb(":memory:");
    const { sql: text, params } = new SQLiteSyncDialect().sqlToQuery(
      namedSheetKeysQuery(["imports/a/events.csv", "imports/b/guests.csv"]),
    );
    const plan = db.$client
      .query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${text}`)
      .all(...(params as never[]))
      .map((r) => r.detail);
    expect(plan.filter((d) => /\bimports\b/.test(d))).toEqual(["SCAN imports"]);
    expect(plan.join("\n")).not.toMatch(/CORRELATED/);
  });
});

describe("namedSheetKeys", () => {
  it(
    "names every key of a row that matches, and returns no other row",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const weddingId = seedWedding(db);
        const asked = insertChange(db, weddingId, crypto.randomUUID());
        const other = insertChange(db, weddingId, crypto.randomUUID());
        const pruned = insertChange(db, weddingId, crypto.randomUUID(), { before: false });

        const named = yield* namedSheetKeys([
          asked.guests,
          pruned.beforeEvents,
          "imports/nobody/events.csv",
        ]);

        expect([...named].toSorted()).toEqual(Object.values(asked).toSorted());
        expect(named.has(other.events)).toBe(false);
        expect(named.has(pruned.beforeEvents)).toBe(false);
      }),
    ),
  );

  it(
    "matches each of the four key columns",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const weddingId = seedWedding(db);
        const rows = Array.from({ length: 4 }, () =>
          insertChange(db, weddingId, crypto.randomUUID()),
        );

        const named = yield* namedSheetKeys([
          rows[0]!.events,
          rows[1]!.guests,
          rows[2]!.beforeEvents,
          rows[3]!.beforeGuests,
        ]);

        expect(named.size).toBe(16);
      }),
    ),
  );
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
    "reaps orphans when no row names any of them, as long as some row exists",
    withDb(
      Effect.gen(function* () {
        // The live row's objects are not in the bucket at all, so the lookup
        // matches nothing but the live sample, which passes the control.
        yield* seedChange({});
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub(old(orphan.events, orphan.guests));

        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW)).toBe(2);
        expect(bucket.remaining()).toEqual([]);
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
    "covers a bucket larger than one run's budget over successive runs, keeping its place in the bucket",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const weddingId = seedWedding(db);
        // 505 live changes are 1,010 objects: more than one run lists. The
        // orphan sorts after all of them.
        const live: string[] = [];
        for (let i = 0; i < 505; i++) {
          const keys = insertChange(db, weddingId, `c${String(i).padStart(4, "0")}`, {
            before: false,
          });
          live.push(keys.events, keys.guests);
        }
        const orphan = keysFor("zz-orphan").events;
        const bucket = createSheetsStub(old(...live, orphan));

        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW)).toBe(0);
        const stored = JSON.parse(bucket.stored(SHEET_POSITION_KEY)!) as { after: string };
        expect(stored.after).toBe(live.toSorted()[999]);

        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW)).toBe(1);
        expect(bucket.deleted).toEqual(new Set([orphan]));

        // The stretch with a delete is walked once more, then the lap ends.
        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW)).toBe(0);
        expect(bucket.stored(SHEET_POSITION_KEY)).toBeUndefined();
        expect(bucket.remaining()).toEqual(live.toSorted());
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
