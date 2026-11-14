import { it, expect, describe } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { afterEach, vi } from "vitest";

import * as metrics from "../../src/metrics";
import {
  EMAIL_CHANGE_RETENTION_SECONDS,
  RETENTION_SWEEP_CHUNK,
  RETENTION_SWEEP_MAX_CHUNKS,
  runEmailChangeSweep,
  runHandleHoldSweep,
  runSecurityEventSweep,
  SECURITY_EVENT_RETENTION_SECONDS,
} from "../../src/services/retention";
import { createTestLayerWithSqlite } from "../helpers/db";

/**
 * The retention sweeps of `security_events` (12 months from `created_at`),
 * `email_changes` (90 days from `completed_at`) and `handle_holds` (from
 * `release_at`): what each deletes and keeps, its per-pass cap, the warning a
 * capped pass logs, and the metric every pass records.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

type Sqlite = ReturnType<typeof createTestLayerWithSqlite>["sqlite"];

/** The test's clock: a whole second, so the cutoffs below are exact. */
const NOW_MS = 1_900_000_000_000;
const NOW_SEC = NOW_MS / 1000;

/** Rows numbered 1..n, `prefix || i` as key. */
const numbered = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)`;

const SWEEPS = [
  {
    table: "security_events",
    sweep: runSecurityEventSweep,
    // A row is past the window once it is 365 days old.
    cutoff: NOW_SEC - SECURITY_EVENT_RETENTION_SECONDS,
    seed: (sqlite: Sqlite, prefix: string, count: number, at: number) =>
      sqlite.run(
        `${numbered}
         INSERT INTO security_events (id, account_id, kind, created_at)
         SELECT ? || i, 'acc_gone', 'email_changed', ? FROM n`,
        [count, prefix, at],
      ),
    keys: (sqlite: Sqlite) =>
      (sqlite.query("SELECT id AS k FROM security_events").all() as { k: string }[]).map(
        (r) => r.k,
      ),
  },
  {
    table: "email_changes",
    sweep: runEmailChangeSweep,
    cutoff: NOW_SEC - EMAIL_CHANGE_RETENTION_SECONDS,
    seed: (sqlite: Sqlite, prefix: string, count: number, at: number) =>
      sqlite.run(
        `${numbered}
         INSERT INTO email_changes (id, account_id, previous_email, new_email, completed_at)
         SELECT ? || i, 'acc_gone', 'a@example.com', 'b@example.com', ? FROM n`,
        [count, prefix, at],
      ),
    keys: (sqlite: Sqlite) =>
      (sqlite.query("SELECT id AS k FROM email_changes").all() as { k: string }[]).map((r) => r.k),
  },
  {
    table: "handle_holds",
    sweep: runHandleHoldSweep,
    // A hold ends at its `release_at`.
    cutoff: NOW_SEC,
    seed: (sqlite: Sqlite, prefix: string, count: number, at: number) =>
      sqlite.run(
        `${numbered}
         INSERT INTO handle_holds (handle, account_id, release_at, created_at)
         SELECT ? || i, NULL, ?, 0 FROM n`,
        [count, prefix, at],
      ),
    keys: (sqlite: Sqlite) =>
      (sqlite.query("SELECT handle AS k FROM handle_holds").all() as { k: string }[]).map(
        (r) => r.k,
      ),
  },
] as const;

/** Captures the log, and the warnings a capped pass of `table` writes. */
const capture = (table: string) => {
  const lines: { level: string; message: unknown; annotations: Record<string, unknown> }[] = [];
  const layer = Logger.layer([
    Logger.map(Logger.formatStructured, (line) => {
      lines.push(line);
    }),
  ]);
  const warnings = () =>
    lines.filter(
      (line) =>
        line.level === "WARN" &&
        String(line.message).includes(`retention.sweep.${table} ended on a full chunk`),
    );
  return { layer, warnings };
};

describe.each(SWEEPS)("the $table sweep", ({ table, sweep, cutoff, seed, keys }) => {
  it.effect("deletes rows past the window, from its first second, and keeps rows inside", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      seed(sqlite, "old_", 2, cutoff - 1);
      seed(sqlite, "edge_", 1, cutoff);
      seed(sqlite, "new_", 2, cutoff + 1);

      const result = yield* sweep({ nowMs: NOW_MS });

      expect(result.deleted).toBe(3);
      expect(keys(sqlite).toSorted()).toEqual(["new_1", "new_2"]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "deletes at most its cap a pass, warns when it ends on a full chunk, and the next pass goes on",
    () => {
      const { layer, sqlite } = createTestLayerWithSqlite();
      const log = capture(table);
      const recorded = vi.spyOn(metrics, "metricRetentionSweep");
      const cap = RETENTION_SWEEP_CHUNK * RETENTION_SWEEP_MAX_CHUNKS;
      return Effect.gen(function* () {
        seed(sqlite, "old_", cap + 10, cutoff - 1);
        seed(sqlite, "new_", 1, cutoff + 1);

        const first = yield* sweep({ nowMs: NOW_MS });
        expect(first.deleted).toBe(cap);
        expect(keys(sqlite)).toHaveLength(11);
        expect(log.warnings()).toHaveLength(1);
        expect(log.warnings()[0]!.annotations).toEqual({
          chunks: RETENTION_SWEEP_MAX_CHUNKS,
          deleted: cap,
        });

        // The rest is a short chunk: nothing left past the window, nothing said.
        const second = yield* sweep({ nowMs: NOW_MS });
        expect(second.deleted).toBe(10);
        expect(keys(sqlite)).toEqual(["new_1"]);
        expect(log.warnings()).toHaveLength(1);

        // Every pass is counted under its table, the empty one too.
        const third = yield* sweep({ nowMs: NOW_MS });
        expect(third.deleted).toBe(0);
        expect(recorded.mock.calls).toEqual([
          [table, cap, expect.any(Number)],
          [table, 10, expect.any(Number)],
          [table, 0, expect.any(Number)],
        ]);
      }).pipe(Effect.provide(layer), Effect.provide(log.layer));
    },
  );

  it.effect("counts the pass when its delete fails", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    const recorded = vi.spyOn(metrics, "metricRetentionSweep");
    return Effect.gen(function* () {
      sqlite.run(`DROP TABLE ${table}`);

      const exit = yield* Effect.exit(sweep({ nowMs: NOW_MS }));

      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("DatabaseError");
      expect(recorded.mock.calls).toEqual([[table, 0, expect.any(Number)]]);
    }).pipe(Effect.provide(layer));
  });
});

describe("the handle_holds sweep", () => {
  // A NULL `release_at` is a hold whose deletion is still pending: it ends at
  // the hard delete, which sets the release, never before.
  it.effect("never deletes a hold whose deletion is pending", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      sqlite.run(
        `INSERT INTO accounts (id, email, passkey_user_id, created_at, updated_at)
         VALUES ('acc_pending', 'pending@example.com', 'pk-user-pending', 0, 0)`,
      );
      sqlite.run(
        `INSERT INTO handle_holds (handle, account_id, release_at, created_at)
         VALUES ('pending_hold', 'acc_pending', NULL, 0)`,
      );
      SWEEPS[2].seed(sqlite, "released_", 1, NOW_SEC - 1);

      const result = yield* runHandleHoldSweep({ nowMs: NOW_MS });

      expect(result.deleted).toBe(1);
      expect(SWEEPS[2].keys(sqlite)).toEqual(["pending_hold"]);
    }).pipe(Effect.provide(layer));
  });
});
