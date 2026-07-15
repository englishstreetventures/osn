import { imports } from "@cire/db";
import { and, eq, or } from "drizzle-orm";
import { Effect, ParseResult, Schema } from "effect";

import { DbService, dbQuery } from "../db";
import { DesiredState } from "../schemas/import";
import type { ParsedEvent, ParsedFamily } from "../schemas/import";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";
import type { SpreadsheetParseError } from "./spreadsheet";

/**
 * The general change pipeline (guest+event editor E4, [[guest-event-editor]]
 * §3/§7). Both front doors — a spreadsheet upload (`{eventsCsv, guestsCsv}`) and
 * the editor's draft-save (a DesiredState JSON) — funnel into the SAME
 * reconcile: body → {@link DesiredState} → `diffAgainstDb` → checkpoint → apply.
 * This module owns the two concerns that are shared across both shapes and both
 * route prefixes (`changes/*` and the one-release `import/*` alias):
 *
 *  1. {@link decodeChangeBody} — normalise either request shape into a
 *     DesiredState (with a flag recording which shape it was, so the CSV path can
 *     persist the uploaded sheets for legacy revert + re-diff on apply).
 *  2. {@link headRevision} — the wedding's optimistic-concurrency token (§6
 *     "Concurrency guard"): the id of the most-recently-applied-or-reverted
 *     change. Preview captures it into `baseRevision`; apply re-reads it and
 *     409s if it moved, so two co-hosts editing at once get a clean conflict
 *     instead of a silent last-writer-wins.
 */

// ── Request body shapes ─────────────────────────────────────────────────────

/**
 * A spreadsheet upload: the two CSV texts. Kept distinct from the DesiredState
 * shape so the CSV path can persist the uploaded sheets in R2 (legacy revert +
 * apply-time re-diff read them back), exactly as the import always has.
 */
export const CsvChangeBody = Schema.Struct({
  eventsCsv: Schema.String,
  guestsCsv: Schema.String,
  /** Provenance toggle (§6): widen the diff to also remove manually-added rows. */
  removeManual: Schema.optional(Schema.Boolean),
});
export type CsvChangeBody = Schema.Schema.Type<typeof CsvChangeBody>;

/**
 * An editor draft-save: the whole DesiredState (ids present for existing rows,
 * absent for new ones). The editor manages EVERYTHING it was shown — the draft
 * is the whole truth — so this path always diffs with `removeManual: true`
 * (never leaves an unmatched row behind because of provenance).
 */
export const DesiredStateChangeBody = Schema.Struct({
  desiredState: DesiredState,
});
export type DesiredStateChangeBody = Schema.Schema.Type<typeof DesiredStateChangeBody>;

/**
 * Either front door. `Schema.Union` tries each member in order; the two shapes
 * are disjoint (`desiredState` vs `eventsCsv`/`guestsCsv`), so a body decodes to
 * exactly one. A malformed body fails both and surfaces as the shared 400.
 */
export const ChangeBody = Schema.Union(DesiredStateChangeBody, CsvChangeBody);
export type ChangeBody = Schema.Schema.Type<typeof ChangeBody>;

// ── Normalised decode ───────────────────────────────────────────────────────

export interface DecodedChange {
  /** The desired state both shapes reduce to — the input `diffAgainstDb` reads. */
  readonly desiredState: DesiredState;
  /**
   * True for the editor front door: the draft is the whole truth, so the diff
   * manages every row it was shown (`removeManual: true`). For a CSV upload this
   * is the caller's `removeManual` toggle (default false — provenance default).
   */
  readonly removeManual: boolean;
  /**
   * The CSV texts to persist when the change came in as a spreadsheet upload,
   * so the change row keeps the uploaded sheets (legacy revert + apply re-diff).
   * `null` for a DesiredState-JSON editor save — the before-image (E3) is the
   * revert source for those.
   */
  readonly uploadedCsv: { readonly eventsCsv: string; readonly guestsCsv: string } | null;
  /** `'import'` (spreadsheet) or `'editor'` (draft-save) — the change kind (E3). */
  readonly kind: "import" | "editor";
}

/**
 * Decode either request shape into a normalised {@link DecodedChange}. The CSV
 * shape runs the same parser the import always has (`parseEventsCsv` /
 * `parseGuestsCsv`), so both front doors produce an identical DesiredState the
 * one pipeline consumes.
 */
export function decodeChangeBody(
  raw: unknown,
): Effect.Effect<DecodedChange, SpreadsheetParseError | ParseResult.ParseError> {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknown(ChangeBody)(raw);

    if ("desiredState" in body) {
      // Editor front door: the draft is the whole truth (manage all shown rows).
      return {
        desiredState: body.desiredState,
        removeManual: true,
        uploadedCsv: null,
        kind: "editor",
      } satisfies DecodedChange;
    }

    // Spreadsheet front door: parse the two CSVs into the same DesiredState.
    const events = yield* parseEventsCsv(body.eventsCsv);
    const families = yield* parseGuestsCsv(body.guestsCsv, events);
    return {
      desiredState: {
        events: events as readonly ParsedEvent[],
        families: families as readonly ParsedFamily[],
      },
      // Provenance default unless the organiser flipped the toggle.
      removeManual: body.removeManual ?? false,
      uploadedCsv: { eventsCsv: body.eventsCsv, guestsCsv: body.guestsCsv },
      kind: "import",
    } satisfies DecodedChange;
  });
}

// ── Optimistic-concurrency head revision ────────────────────────────────────

/**
 * Sentinel `baseRevision` for a wedding that has never had a change applied or
 * reverted — distinct from any real change id, so a preview taken at genesis
 * still detects a concurrent first apply.
 */
export const GENESIS_REVISION = "genesis";

/**
 * The wedding's current head revision: the id of the most-recently
 * applied-or-reverted change, or {@link GENESIS_REVISION} if none. Preview
 * records this as `baseRevision`; apply re-reads it and 409s on a mismatch
 * (§6 "Concurrency guard"). A `preview`-status row is NOT a head — only an
 * applied or reverted change mutated the wedding — so opening a second preview
 * never trips the guard; a concurrent APPLY does. Ordered by the change's mutate
 * time (`appliedAt`/`revertedAt`), newest first, so the token tracks the real
 * last write regardless of upload order.
 */
export function headRevision(weddingId: string): Effect.Effect<string, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({
          id: imports.id,
          appliedAt: imports.appliedAt,
          revertedAt: imports.revertedAt,
        })
        .from(imports)
        .where(
          and(
            eq(imports.weddingId, weddingId),
            or(eq(imports.status, "applied"), eq(imports.status, "reverted")),
          ),
        )
        .all(),
    );
    if (rows.length === 0) return GENESIS_REVISION;
    // The mutate time is appliedAt for an applied row, revertedAt for a reverted
    // one — both are set when the row last changed the wedding. Newest wins.
    const mutateAt = (r: (typeof rows)[number]) => Math.max(r.appliedAt ?? 0, r.revertedAt ?? 0);
    let head = rows[0]!;
    for (const r of rows) if (mutateAt(r) > mutateAt(head)) head = r;
    return head.id;
  }).pipe(Effect.withSpan("cire.changes.headRevision"));
}
