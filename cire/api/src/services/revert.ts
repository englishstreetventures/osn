import { imports } from "@cire/db";
import { and, desc, eq } from "drizzle-orm";
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
 * Revert the most-recently-applied import by re-fetching its predecessor's CSVs
 * from R2, re-parsing, re-diffing against current DB state, and re-applying.
 * The current import row is then marked `reverted` (with `revertedAt` set).
 *
 * Failure modes:
 *  - `NoPriorImport` — there is no earlier `applied` import to revert to.
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

    // Find the most-recent `applied` import (same wedding) strictly before
    // `current`.
    const candidates = yield* dbQuery(() =>
      db
        .select()
        .from(imports)
        .where(and(eq(imports.status, "applied"), eq(imports.weddingId, weddingId)))
        .orderBy(desc(imports.uploadedAt))
        .all(),
    );
    const prior = candidates.find((c) => c.id !== current.id && c.uploadedAt < current.uploadedAt);
    if (!prior) {
      return yield* Effect.fail(new NoPriorImport({ currentImportId: importId }));
    }

    const eventsCsv = yield* fetchUpload(prior.eventsR2Key);
    const guestsCsv = yield* fetchUpload(prior.guestsR2Key);

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
    const summary = yield* applyImport(prior.id, plan, weddingId);

    // Mark the current row as reverted; bump prior back to applied (it already
    // is) — no change needed there.
    yield* dbQuery(() =>
      db
        .update(imports)
        .set({ status: "reverted", revertedAt: Date.now() })
        .where(eq(imports.id, current.id))
        .run(),
    );

    return summary;
  }).pipe(
    Effect.tap(() => Effect.sync(() => metricImportReverted("ok"))),
    Effect.tapError(() => Effect.sync(() => metricImportReverted("error"))),
    Effect.withSpan("cire.import.revert"),
  );
}
