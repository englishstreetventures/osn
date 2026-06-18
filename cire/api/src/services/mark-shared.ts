/**
 * Mark a family's invite code as "shared" — the per-family "Copy message" button
 * fires this best-effort when the organiser copies the family's invite message.
 *
 * Sets `families.code_shared_at = now`. It exists to power the remint "already
 * sent out" warning (reminting invalidates a shared code → guests' links break),
 * NOT as a security boundary: a missed write only under-counts the warning, so
 * the client treats the POST as fire-and-forget and never blocks the clipboard
 * copy on it.
 *
 * Tenant safety is enforced one layer up by `weddingOwner()`; this service
 * additionally verifies `familyId` belongs to `weddingId` before writing, so an
 * owner of wedding A can't flip a family that lives under wedding B.
 */

import { families } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricFamilyCodeShared } from "../metrics";

export class FamilyNotInWedding extends Data.TaggedError("FamilyNotInWedding") {}

export class MarkSharedWriteError extends Data.TaggedError("MarkSharedWriteError")<{
  reason: string;
}> {}

export interface MarkSharedResult {
  familyId: string;
  /** Epoch-ms timestamp the family was marked shared. */
  codeSharedAt: number;
}

export const markSharedService = {
  markShared(
    weddingId: string,
    familyId: string,
  ): Effect.Effect<MarkSharedResult, FamilyNotInWedding | MarkSharedWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // Scope check: a row only comes back when the family lives under this exact
      // wedding — cross-tenant marking is impossible.
      const [row] = yield* dbQuery(() =>
        db
          .select({ id: families.id })
          .from(families)
          .where(and(eq(families.id, familyId), eq(families.weddingId, weddingId)))
          .all(),
      );
      if (!row) {
        return yield* Effect.fail(new FamilyNotInWedding());
      }

      const sharedAt = new Date();
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .update(families)
              .set({ codeSharedAt: sharedAt, updatedAt: sharedAt })
              .where(eq(families.id, familyId))
              .run(),
          ),
        catch: (cause) => new MarkSharedWriteError({ reason: String(cause) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("mark-shared write failed", { reason: err.reason }),
        ),
      );

      return { familyId, codeSharedAt: sharedAt.getTime() };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricFamilyCodeShared("ok"))),
      Effect.tapError((e) =>
        e._tag === "MarkSharedWriteError"
          ? Effect.sync(() => metricFamilyCodeShared("error"))
          : Effect.void,
      ),
      Effect.withSpan("cire.familyCode.markShared"),
    );
  },
};
