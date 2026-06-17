/**
 * Organiser-triggered per-family claim-code regeneration (C2).
 *
 * Mints a fresh `SURNAME-WORD-HASH` code on the wedding's `code_style` tier and,
 * **atomically in one D1 batch**, rotates `families.public_id` AND revokes every
 * guest session for that family. The atomicity is the security property: the old
 * code and every session minted from it stop working in the same commit, so a
 * leaked code can't be used during a regenerate race. Wires the previously-dead
 * `sessionService.revokeAllForFamily`.
 *
 * Tenant safety is enforced one layer up by `weddingOwner()` (the caller owns
 * `weddingId`); this service additionally verifies `familyId` belongs to
 * `weddingId` before mutating, so a valid owner of wedding A can't rotate a
 * family that lives under wedding B.
 */

import { families, sessions, weddings as weddingsTable } from "@cire/db";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { metricFamilyCodeRegenerated } from "../metrics";
import { generateFamilyCode } from "./family-code";
import type { CodeStyle } from "./family-code";

export class FamilyNotInWedding extends Data.TaggedError("FamilyNotInWedding") {}

export class RegenerateWriteError extends Data.TaggedError("RegenerateWriteError")<{
  reason: string;
}> {}

export interface RegeneratedCode {
  familyId: string;
  publicId: string;
}

export const regenerateCodeService = {
  /**
   * Rotate `familyId`'s claim code and revoke its sessions, atomically. Fails
   * `FamilyNotInWedding` if the family doesn't exist under `weddingId`.
   */
  regenerate(
    weddingId: string,
    familyId: string,
  ): Effect.Effect<RegeneratedCode, FamilyNotInWedding | RegenerateWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // Verify family ∈ wedding AND read the tier in one scoped query (join to
      // weddings for code_style). A row only comes back when the family lives
      // under this exact wedding — cross-tenant rotation is impossible.
      const [row] = yield* dbQuery(() =>
        db
          .select({ codeStyle: weddingsTable.codeStyle, familyName: families.familyName })
          .from(families)
          .innerJoin(weddingsTable, eq(families.weddingId, weddingsTable.id))
          .where(and(eq(families.id, familyId), eq(families.weddingId, weddingId)))
          .all(),
      );
      if (!row) {
        return yield* Effect.fail(new FamilyNotInWedding());
      }
      const style: CodeStyle = row.codeStyle;
      const newCode = generateFamilyCode(row.familyName, style);

      // One atomic batch: rotate the code + revoke every session for the family.
      const statements: BatchItem<"sqlite">[] = [
        db.update(families).set({ publicId: newCode }).where(eq(families.id, familyId)),
        db.delete(sessions).where(eq(sessions.familyId, familyId)),
      ];

      yield* Effect.tryPromise({
        try: () => commitBatch(db, statements),
        catch: (cause) => new RegenerateWriteError({ reason: String(cause) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("family-code regenerate failed", { reason: err.reason }),
        ),
      );

      return { familyId, publicId: newCode };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricFamilyCodeRegenerated("ok"))),
      Effect.tapError((e) =>
        // Only the write failure is an "error" outcome; FamilyNotInWedding is a
        // 404-class caller mistake, not a regeneration error.
        e._tag === "RegenerateWriteError"
          ? Effect.sync(() => metricFamilyCodeRegenerated("error"))
          : Effect.void,
      ),
      Effect.withSpan("cire.familyCode.regenerate"),
    );
  },
};

/** Atomic D1 batch (prod) / sequential bun:sqlite (tests) — the importer's path. */
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
