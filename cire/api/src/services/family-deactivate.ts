/**
 * Deactivate / reactivate a single family — the organiser's "cut off a
 * withdrawn invite" control. Deactivating sets `families.deactivated_at = now`
 * (and, atomically, revokes every live guest session for the family, so a guest
 * already holding a cookie is logged out in the same commit a withdrawn code
 * stops claiming). Reactivating clears it back to NULL. NOTHING is deleted: the
 * family, its guests, and its RSVPs survive, so a re-activated code claims again
 * with all its data intact.
 *
 * The guest claim path (`claimService.lookup`) rejects a deactivated family's
 * code with the SAME generic invalid-credentials failure an unknown code gets,
 * so the withdrawn code stops working without revealing it ever existed.
 *
 * Tenant safety is enforced one layer up by the route gate; this service
 * additionally verifies `familyId` belongs to `weddingId` before writing, so a
 * member of wedding A can't toggle a family that lives under wedding B. Host
 * preview families (`kind === "host"`) are refused — they're the organiser's own
 * preview, never a withdrawable guest invite.
 */

import { families, sessions } from "@cire/db";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { metricFamilyDeactivated } from "../metrics";

/** The family isn't a `kind='guest'` family under `weddingId` (missing, in a
 *  different wedding, or the synthetic host-preview family). 404-class. */
export class FamilyNotInWedding extends Data.TaggedError("FamilyNotInWedding") {}

export class DeactivateWriteError extends Data.TaggedError("DeactivateWriteError")<{
  reason: string;
}> {}

export interface DeactivateResult {
  familyId: string;
  /** Epoch-ms timestamp the family was deactivated, or `null` after a reactivate. */
  deactivatedAt: number | null;
}

export const familyDeactivateService = {
  /**
   * Toggle `familyId`'s deactivation. `deactivate === true` cuts the code off
   * (and revokes the family's sessions); `false` restores it. Idempotent: a
   * second deactivate just refreshes the timestamp, a second reactivate is a
   * no-op write. Fails `FamilyNotInWedding` if the family isn't a guest family
   * under `weddingId`.
   */
  setDeactivated(
    weddingId: string,
    familyId: string,
    deactivate: boolean,
  ): Effect.Effect<DeactivateResult, FamilyNotInWedding | DeactivateWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // Scope + kind check in one query: a row only comes back when the family
      // lives under this exact wedding AND is a real guest family. Host-preview
      // families (kind='host') are excluded, so the route can never deactivate
      // the organiser's own preview.
      const [row] = yield* dbQuery(() =>
        db
          .select({ id: families.id })
          .from(families)
          .where(
            and(
              eq(families.id, familyId),
              eq(families.weddingId, weddingId),
              eq(families.kind, "guest"),
            ),
          )
          .all(),
      );
      if (!row) {
        return yield* Effect.fail(new FamilyNotInWedding());
      }

      const now = new Date();
      const deactivatedAt = deactivate ? now : null;

      // Deactivating also revokes the family's live sessions in the same commit
      // (a withdrawn invite shouldn't keep a guest signed in). Reactivating only
      // clears the marker — no sessions exist to restore.
      const statements: BatchItem<"sqlite">[] = [
        db.update(families).set({ deactivatedAt, updatedAt: now }).where(eq(families.id, familyId)),
      ];
      if (deactivate) {
        statements.push(db.delete(sessions).where(eq(sessions.familyId, familyId)));
      }

      yield* Effect.tryPromise({
        try: () => commitBatch(db, statements),
        catch: (cause) => new DeactivateWriteError({ reason: String(cause) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("family deactivate write failed", { reason: err.reason }),
        ),
      );

      return { familyId, deactivatedAt: deactivatedAt === null ? null : deactivatedAt.getTime() };
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => metricFamilyDeactivated(deactivate ? "deactivate" : "reactivate", "ok")),
      ),
      Effect.tapError((e) =>
        e._tag === "DeactivateWriteError"
          ? Effect.sync(() =>
              metricFamilyDeactivated(deactivate ? "deactivate" : "reactivate", "error"),
            )
          : Effect.void,
      ),
      Effect.withSpan("cire.family.deactivate"),
    );
  },
};

/** Atomic D1 batch (prod) / sequential bun:sqlite (tests). Mirrors regenerate-code. */
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
