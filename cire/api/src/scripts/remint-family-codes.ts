/**
 * One-time, tenant-scoped re-mint of a wedding's family claim codes onto the
 * new tiered `SURNAME-WORD-HASH` generator (C1, migration option (a)).
 *
 * Why a script (not a SQL migration): the new code format needs the EFF
 * wordlist + a CSPRNG + the wedding's `code_style` tier — none of which a pure
 * D1 `.sql` migration can express. So the column add ships as migration
 * `0011_wedding_code_style.sql`, and this operator function performs the data
 * re-mint against a live D1 binding.
 *
 * Safety properties:
 *  - **Tenant-scoped** — operates only on `families WHERE wedding_id = ?`.
 *  - **Idempotent / safe to re-run** — only re-mints families whose existing
 *    `public_id` is NOT already in the new format (legacy `NAME-XXXXXXXX`
 *    single-hyphen codes). A family already on a `SURNAME-WORD-HASH` code is
 *    skipped, so a second run is a no-op. (Deliberate rotation of an
 *    already-migrated code is the per-family regenerate-code endpoint's job.)
 *  - **Atomic** — all updates commit as one D1 batch (same path as importer).
 *  - **Collision-safe** — freshly-drawn codes are checked against codes already
 *    taken in this wedding (incl. ones minted earlier in the same run); on the
 *    astronomically rare clash it re-draws.
 *
 * Exported (not auto-executed) so it is unit-testable and never runs on import.
 * An operator drives it from a one-off Worker/CLI harness that builds the
 * Drizzle handle from the D1 binding and calls {@link remintFamilyCodes}.
 */

import { families, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { generateFamilyCode } from "../services/family-code";
import type { CodeStyle } from "../services/family-code";

export class RemintError extends Data.TaggedError("RemintError")<{
  reason: string;
}> {}

/**
 * A `public_id` is "legacy" iff it is NOT in the new `SURNAME-WORD-HASH` shape.
 * The new format always has ≥2 `-` separators (surname, word, hash[, hash]);
 * the old `NAME-XXXXXXXX` format has exactly one.
 */
export function isLegacyCode(publicId: string): boolean {
  return (publicId.match(/-/g) ?? []).length < 2;
}

export interface RemintResult {
  /** Families whose code was rotated to the new format. */
  reminted: number;
  /** Families skipped because they were already on the new format. */
  skipped: number;
}

/**
 * Re-mint every legacy-format family code in `weddingId` onto the wedding's
 * `code_style` tier, atomically. Already-new codes are left untouched.
 */
export function remintFamilyCodes(
  weddingId: string,
): Effect.Effect<RemintResult, RemintError, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    const [wedding] = yield* dbQuery(() =>
      db
        .select({ codeStyle: weddings.codeStyle })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    if (!wedding) {
      return yield* Effect.fail(new RemintError({ reason: "wedding_not_found" }));
    }
    const style: CodeStyle = wedding.codeStyle;

    const rows = yield* dbQuery(() =>
      db
        .select({ id: families.id, publicId: families.publicId, familyName: families.familyName })
        .from(families)
        .where(eq(families.weddingId, weddingId))
        .all(),
    );

    const legacy = rows.filter((r) => isLegacyCode(r.publicId));
    const skipped = rows.length - legacy.length;

    // Codes already taken in this tenant (incl. ones minted earlier this run) so
    // two re-mints can't collide on a fresh draw and abort the batch.
    const used = new Set(rows.map((r) => r.publicId));
    const updates = legacy.map((r) => {
      let code = generateFamilyCode(r.familyName, style);
      while (used.has(code)) code = generateFamilyCode(r.familyName, style);
      used.add(code);
      return db.update(families).set({ publicId: code }).where(eq(families.id, r.id));
    });

    if (updates.length > 0) {
      yield* Effect.tryPromise({
        try: () => commitBatch(db, updates),
        catch: (cause) => new RemintError({ reason: String(cause) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("family-code re-mint failed", { reason: err.reason }),
        ),
      );
    }

    yield* Effect.logInfo("family-code re-mint complete", {
      weddingId,
      reminted: updates.length,
      skipped,
    });

    return { reminted: updates.length, skipped };
  }).pipe(Effect.withSpan("cire.familyCode.remint"));
}

/**
 * Commit the update set as one atomic D1 batch (prod) or sequentially on
 * bun:sqlite (tests/local) — the same feature-detected path the importer uses.
 */
async function commitBatch(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (statements.length === 0) return;
  const batchable = db as {
    batch?: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown>;
  };
  if (typeof batchable.batch === "function") {
    await batchable.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    return;
  }
  // eslint-disable-next-line no-await-in-loop
  for (const stmt of statements) await stmt;
}
