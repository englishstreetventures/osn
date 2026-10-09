import { describe, expect, it } from "bun:test";

import { imports } from "@cire/db";
import { sql } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { PREVIEW_STALE_AFTER_MS } from "../../src/services/maintenance-sweeps";
import {
  createR2Stub,
  R2Service,
  storeBeforeImage,
  storeUpload,
} from "../../src/services/r2-imports";
import {
  RECONCILE_GRACE_MS,
  RECONCILE_HOLD_RUNS,
  RECONCILE_STOP_KEY,
  type ReconcileAlert,
} from "../../src/services/r2-reconcile";
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
    head(key) {
      const uploaded = store.get(key);
      return Promise.resolve(uploaded ? { key, uploaded } : null);
    },
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

  it("lets no preview outlive the grace window", () => {
    // An apply retried on a preview puts its before-image again under the same
    // key. Previews are swept once this old, so the earlier put of a key a
    // retry can rewrite is never older than the grace window.
    expect(PREVIEW_STALE_AFTER_MS).toBeLessThanOrEqual(RECONCILE_GRACE_MS);
  });

  it("sends a full page of the longest key the writers build in under 100 KB", async () => {
    // Every key shape `r2-imports.ts` writes, for a change id of the length the
    // route mints (`crypto.randomUUID()`).
    const written = await Effect.runPromise(
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const upload = yield* storeUpload("e", "g", id);
        const before = yield* storeBeforeImage("e", "g", id);
        return [...Object.values(upload), ...Object.values(before)];
      }).pipe(Effect.provideService(R2Service, createR2Stub())),
    );
    expect(written.every((key) => key.startsWith(SHEETS_PREFIX))).toBe(true);
    const longest = written.toSorted((a, b) => b.length - a.length)[0]!;
    const keys = Array.from({ length: SHEET_LIST_LIMITS.maxObjects + 1 }, () => longest);
    const { params } = new SQLiteSyncDialect().sqlToQuery(namedSheetKeysQuery(keys));
    expect(params).toHaveLength(1);
    expect(new TextEncoder().encode(params[0] as string).length).toBeLessThan(100_000);
  });

  it(
    "answers a full page of the longest keys in one value well under D1's 2 MB row limit",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const weddingId = seedWedding(db);
        const asked: string[] = [];
        // One more row than a run can ask about: each matches on its before-image.
        for (let i = 0; i <= SHEET_LIST_LIMITS.maxObjects; i++) {
          asked.push(insertChange(db, weddingId, crypto.randomUUID()).beforeEvents);
        }
        const [row] = yield* Effect.promise(() =>
          Promise.resolve(db.all<{ n: number; hits: string }>(namedSheetKeysQuery(asked))),
        );

        expect(row!.n).toBe(SHEET_LIST_LIMITS.maxObjects + 1);
        expect(JSON.parse(row!.hits)).toHaveLength(SHEET_LIST_LIMITS.maxObjects + 1);
        expect(new TextEncoder().encode(row!.hits).length).toBeLessThan(500_000);
      }),
    ),
  );

  it("counts and matches imports in one scan, never per row", () => {
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

  it("reads and matches every key column imports has, and no other", () => {
    // A key column added to `imports` but not to the lookup would make its
    // objects look orphaned. This fails until the lookup names it.
    const keyColumns = getTableConfig(imports)
      .columns.map((c) => c.name)
      .filter((name) => name.endsWith("r2_key"))
      .toSorted();
    const { sql: text } = new SQLiteSyncDialect().sqlToQuery(namedSheetKeysQuery([]));
    const matched = [...text.matchAll(/"imports"\."(\w+)" IN listed/g)].map((m) => m[1]).toSorted();
    const array = /json_array\(([^)]*)\)/.exec(text)?.[1] ?? "";
    const selected = [...array.matchAll(/"imports"\."(\w+)"/g)].map((m) => m[1]).toSorted();
    expect(keyColumns).toHaveLength(4);
    expect(matched).toEqual(keyColumns);
    expect(selected).toEqual(keyColumns);
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
          other.events.toUpperCase(),
          `${other.guests}.bak`,
          ` ${other.beforeEvents}`,
        ]);

        expect([...named.named].toSorted()).toEqual(Object.values(asked).toSorted());
        expect(named.named.has(other.events)).toBe(false);
        expect(named.named.has(pruned.beforeEvents)).toBe(false);
        // Every row counts, whether or not it was asked about.
        expect(named.referencingRows).toBe(3);
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

        expect(named.named.size).toBe(16);
        expect(named.referencingRows).toBe(4);
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
    "reaps orphans when no row names any of them, as long as the live sample is in the bucket",
    withDb(
      Effect.gen(function* () {
        // The live row's sheet is too new to judge, so the lookup matches
        // nothing but the live sample, which passes the control.
        const live = yield* seedChange({});
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub([
          { key: live.events, uploaded: FRESH },
          ...old(orphan.events, orphan.guests),
        ]);

        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW)).toBe(2);
        expect(bucket.remaining()).toEqual([live.events]);
      }),
    ),
  );

  it(
    "fails and deletes nothing when the database's rows name no object in this bucket",
    withDb(
      Effect.gen(function* () {
        // A database paired with another environment's bucket: it has rows,
        // so the live sample exists, but the bucket holds none of their sheets.
        yield* seedChange({});
        const strangers = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub(old(strangers.events, strangers.guests));

        const error = yield* Effect.flip(sheetReconcileService.reconcileOrphans(bucket, NOW));

        expect(error.reason).toBe("the live sample is not an object in this bucket");
        expect(bucket.deleted.size).toBe(0);
      }),
    ),
  );

  it(
    "fails and deletes nothing when the imports read itself fails",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub(old(orphan.events, orphan.guests));
        yield* Effect.promise(async () => {
          await db.run(sql`DROP TABLE imports`);
        });

        const error = yield* Effect.flip(sheetReconcileService.reconcileOrphans(bucket, NOW));

        expect(error._tag).toBe("R2ReconcileError");
        expect(bucket.deleted.size).toBe(0);
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

        // The second run reaches the orphan and the end of the bucket.
        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW)).toBe(1);
        expect(bucket.deleted).toEqual(new Set([orphan]));
        // Between laps the object keeps only the row count.
        expect(JSON.parse(bucket.stored(SHEET_POSITION_KEY)!)).toEqual({ referenced: 505 });
        expect(bucket.remaining()).toEqual(live.toSorted());
      }),
    ),
  );

  it(
    "holds while imports has fewer than half the rows counted before, alerting, and reaps once they recover",
    withDb(
      Effect.gen(function* () {
        const live = yield* seedChange({ before: false });
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub(old(live.events, live.guests, orphan.events));
        const alerts: ReconcileAlert[] = [];
        const alertOperator = (alert: ReconcileAlert) => Effect.sync(() => void alerts.push(alert));
        // The last run counted three rows; one is left.
        yield* Effect.promise(() =>
          bucket.put(SHEET_POSITION_KEY, JSON.stringify({ referenced: 3 })),
        );

        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW, { alertOperator })).toBe(
          0,
        );
        expect(bucket.remaining()).toContain(orphan.events);
        expect(JSON.parse(bucket.stored(SHEET_POSITION_KEY)!)).toEqual({
          referenced: 3,
          heldRuns: 1,
        });
        expect(alerts).toEqual([
          {
            kind: "held",
            bucket: "sheets",
            referencingRows: 1,
            previousRows: 3,
            heldRuns: 1,
            runsLeft: RECONCILE_HOLD_RUNS - 1,
          },
        ]);

        // Two rows is not more than half gone.
        yield* seedChange({ before: false });
        expect(yield* sheetReconcileService.reconcileOrphans(bucket, NOW, { alertOperator })).toBe(
          1,
        );
        expect(bucket.deleted).toEqual(new Set([orphan.events]));
        expect(JSON.parse(bucket.stored(SHEET_POSITION_KEY)!)).toEqual({ referenced: 2 });
      }),
    ),
  );

  it(
    "deletes nothing and alerts while reconcile/stop is in the bucket",
    withDb(
      Effect.gen(function* () {
        const live = yield* seedChange({ before: false });
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub([
          ...old(live.events, live.guests, orphan.events),
          { key: RECONCILE_STOP_KEY, uploaded: OLD },
        ]);
        const alerts: ReconcileAlert[] = [];

        expect(
          yield* sheetReconcileService.reconcileOrphans(bucket, NOW, {
            alertOperator: (alert) => Effect.sync(() => void alerts.push(alert)),
          }),
        ).toBe(0);
        expect(bucket.deleted.size).toBe(0);
        expect(alerts).toEqual([{ kind: "stopped", bucket: "sheets", stoppedDays: 7 }]);
        expect(RECONCILE_STOP_KEY.startsWith(SHEETS_PREFIX)).toBe(false);
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
        const live = yield* seedChange({});
        const orphan = keysFor(crypto.randomUUID());
        const bucket = createSheetsStub([
          { key: live.events, uploaded: FRESH },
          ...old(orphan.events, orphan.guests, orphan.beforeEvents),
        ]);
        const attrs = { bucket: "sheets", result: "ok" };
        const before = yield* Effect.promise(() => counterValue("cire.r2.objects.swept", attrs));

        yield* sheetReconcileService.reconcileOrphans(bucket, NOW);

        const after = yield* Effect.promise(() => counterValue("cire.r2.objects.swept", attrs));
        expect(after).toBe(before + 3);
      }),
    ),
  );
});
