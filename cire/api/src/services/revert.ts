import { imports } from "@cire/db";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";
import { metricImportReverted } from "../metrics";
import type { ImportSummary, ParsedFamily } from "../schemas/import";
import { applyImport, diffAgainstDb, ImportError } from "./import";
import { R2Service, fetchUpload, R2Error } from "./r2-imports";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";

export class NoPriorImport extends Data.TaggedError("NoPriorImport")<{
  readonly currentImportId: string;
}> {}

export class RevertParseError extends Data.TaggedError("RevertParseError")<{
  readonly reason: string;
}> {}

export type RevertError = NoPriorImport | R2Error | RevertParseError | ImportError;

/**
 * Reconcile the wedding to the state described by a pair of snapshot CSVs:
 * parse → diff against the CURRENT DB → apply. Shared by both revert paths.
 *
 * The before-image is written at FULL fidelity (`Family Code`, `Family ID`,
 * `Guest ID`, `Event ID`), so the parser honours those columns and the diff
 * matches existing rows BY ID — a household/guest/event that was renamed since
 * the checkpoint is UPDATED back in place rather than removed+recreated, so its
 * claim code and stable ids survive (rename-proof, no re-mint). A legacy prior-
 * import sheet carries no fidelity columns, so it reconciles by name exactly as
 * before.
 */
function reconcileToSnapshot(
  targetImportId: string,
  weddingId: string,
  eventsCsv: string,
  guestsCsv: string,
  finalize: BatchItem<"sqlite">[] = [],
): Effect.Effect<ImportSummary, RevertParseError | ImportError, DbService> {
  return Effect.gen(function* () {
    const events = yield* parseEventsCsv(eventsCsv).pipe(
      Effect.mapError(
        (e) =>
          new RevertParseError({ reason: `events parse failed: ${(e as { _tag: string })._tag}` }),
      ),
    );
    const families = yield* parseGuestsCsv(guestsCsv, events).pipe(
      Effect.mapError(
        (e) =>
          new RevertParseError({ reason: `guests parse failed: ${(e as { _tag: string })._tag}` }),
      ),
    );

    const plan = yield* diffAgainstDb(events, families as ParsedFamily[], weddingId);
    return yield* applyImport(targetImportId, plan, weddingId, finalize);
  });
}

/**
 * Revert a change (import or editor save) to the exact state that preceded it.
 *
 * BEFORE-IMAGE PATH (E3, [[guest-event-editor]] §4): when the change row carries
 * a before-image (`beforeEventsR2Key`/`beforeGuestsR2Key`, captured at apply
 * time), reconcile the wedding to those snapshot CSVs. This restores the precise
 * pre-change state REGARDLESS of what interleaved between changes (other imports,
 * editor saves) — it is not the "re-apply the previous import's sheets"
 * heuristic, which silently wipes anything applied since that predecessor. Codes
 * + ids are preserved because the before-image is full-fidelity and the diff
 * matches by id (rename-proof).
 *
 * LEGACY FALLBACK: a row with NO before-image (NULL keys — an import applied
 * before E3) keeps the old behaviour: re-fetch the most-recent-earlier applied
 * import's uploaded sheets and re-apply them.
 *
 * Non-goals ([[guest-event-editor]] §4), true of BOTH paths and not claimed
 * otherwise: a revert does not restore cascade-deleted RSVPs, nor the
 * image/crop/location of a re-created event — an id-matched update leaves those
 * columns untouched, and a name-matched recreate cannot recover them. The revert
 * plan therefore never asserts it restores them.
 *
 * Failure modes:
 *  - `NoPriorImport` — legacy path only: there is no earlier `applied` import.
 */
export function revertImport(
  importId: string,
  weddingId: string,
): Effect.Effect<ImportSummary, RevertError, DbService | R2Service> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    const [current] = yield* dbQuery(() =>
      db
        .select()
        .from(imports)
        .where(and(eq(imports.id, importId), eq(imports.weddingId, weddingId)))
        .all(),
    );
    if (!current) {
      return yield* Effect.fail(new NoPriorImport({ currentImportId: importId }));
    }

    // The status flip rides in the reconcile's FINAL batch (applyImport
    // `finalize`), mirroring the apply route: a crash can't leave the wedding
    // reconciled while the row still reads `applied` (which would invite a
    // second, now-wrong revert against the already-restored state).
    const markReverted = [
      db
        .update(imports)
        .set({ status: "reverted", revertedAt: Date.now() })
        .where(eq(imports.id, current.id)),
    ];

    let summary: ImportSummary;

    if (current.beforeEventsR2Key && current.beforeGuestsR2Key) {
      // ── Before-image path ──────────────────────────────────────────────────
      // Restore the exact pre-change state captured at apply time. Rename-proof
      // (full-fidelity snapshot → id-matched updates preserve codes + ids).
      const eventsCsv = yield* fetchUpload(current.beforeEventsR2Key);
      const guestsCsv = yield* fetchUpload(current.beforeGuestsR2Key);
      summary = yield* reconcileToSnapshot(
        current.id,
        weddingId,
        eventsCsv,
        guestsCsv,
        markReverted,
      );
    } else {
      // ── Legacy fallback ────────────────────────────────────────────────────
      // No before-image (pre-E3 row): re-apply the most-recent-earlier applied
      // import's uploaded sheets against current DB state. The predicate +
      // ORDER BY + LIMIT 1 replace the old select-all-then-JS-find, which
      // dragged every applied row (incl. the `summary` JSON) out of D1;
      // `imports_wedding_uploaded_at_idx` serves scope + order, status/id as
      // residual filters.
      const [prior] = yield* dbQuery(() =>
        db
          .select({
            id: imports.id,
            eventsR2Key: imports.eventsR2Key,
            guestsR2Key: imports.guestsR2Key,
          })
          .from(imports)
          .where(
            and(
              eq(imports.weddingId, weddingId),
              eq(imports.status, "applied"),
              ne(imports.id, current.id),
              lt(imports.uploadedAt, current.uploadedAt),
            ),
          )
          .orderBy(desc(imports.uploadedAt))
          .limit(1)
          .all(),
      );
      if (!prior) {
        return yield* Effect.fail(new NoPriorImport({ currentImportId: importId }));
      }

      const eventsCsv = yield* fetchUpload(prior.eventsR2Key);
      const guestsCsv = yield* fetchUpload(prior.guestsR2Key);
      summary = yield* reconcileToSnapshot(prior.id, weddingId, eventsCsv, guestsCsv, markReverted);
    }

    return summary;
  }).pipe(
    Effect.tap(() => Effect.sync(() => metricImportReverted("ok"))),
    Effect.tapError(() => Effect.sync(() => metricImportReverted("error"))),
    Effect.withSpan("cire.import.revert"),
  );
}
