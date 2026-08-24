import { events, imports } from "@cire/db";
import { and, asc, eq, or } from "drizzle-orm";
import { Effect, ParseResult, Schema } from "effect";

import { DbService, dbQuery } from "../db";
import { DesiredState } from "../schemas/import";
import type { ChangeScope, ParsedEvent, ParsedFamily } from "../schemas/import";
import { decodePalette, safeHttpUrl } from "./claim";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";
import type { SpreadsheetParseError } from "./spreadsheet";

/**
 * The general change pipeline (guest+event editor E4, [[guest-event-editor]]
 * §3/§7). Both front doors — a spreadsheet upload (`{eventsCsv, guestsCsv}`) and
 * the editor's draft-save (a DesiredState JSON) — funnel into the SAME
 * reconcile: body → {@link DesiredState} → `diffAgainstDb` → checkpoint → apply.
 * This module owns the two concerns that are shared across both shapes:
 *
 *  1. {@link decodeChangeBody} — normalise either request shape into a
 *     DesiredState (with a flag recording which shape it was, so the CSV path can
 *     persist the uploaded sheets for legacy revert + re-diff on apply, and a
 *     {@link ChangeScope} recording which sheets a partial upload carried).
 *  2. {@link headRevision} — the wedding's optimistic-concurrency token (§6
 *     "Concurrency guard"): the id of the most-recently-applied-or-reverted
 *     change. Preview captures it into `baseRevision`; apply re-reads it and
 *     409s if it moved, so two co-hosts editing at once get a clean conflict
 *     instead of a silent last-writer-wins.
 */

// ── Request body shapes ─────────────────────────────────────────────────────

/**
 * A spreadsheet upload: the CSV texts. Kept distinct from the DesiredState shape
 * so the CSV path can persist the uploaded sheets in R2 (legacy revert +
 * apply-time re-diff read them back), exactly as the import always has.
 *
 * EITHER SHEET MAY BE OMITTED — an organiser who only re-worked the seating can
 * upload guests.csv alone, and one who only moved a ceremony can upload
 * events.csv alone. The omitted sheet is not "an empty sheet": it drops out of
 * the change's {@link ChangeScope} so the diff leaves that half of the wedding
 * untouched. At least one sheet is required; a body carrying neither fails the
 * refinement below (and, being the last union member, surfaces as the shared
 * 400 rather than a confusing empty-sheet parse error).
 */
export const CsvChangeBody = Schema.Struct({
  eventsCsv: Schema.optional(Schema.String),
  guestsCsv: Schema.optional(Schema.String),
  /** Provenance toggle (§6): widen the diff to also remove manually-added rows. */
  removeManual: Schema.optional(Schema.Boolean),
}).pipe(
  Schema.filter((body) => body.eventsCsv !== undefined || body.guestsCsv !== undefined, {
    message: () => "at least one of eventsCsv / guestsCsv is required",
  }),
);
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
   * Whether an id-less desired row may match an existing row by NAME. `true` for
   * a spreadsheet upload (a sheet without the fidelity columns has no ids at
   * all); `false` for the editor front door, whose draft carries an id for every
   * row that exists — so an id-less row there means "newly added", and adopting
   * a same-named existing row would silently undo the organiser's deletion of
   * it. See {@link import.DiffOptions.matchByName}.
   */
  readonly matchByName: boolean;
  /**
   * The CSV texts to persist when the change came in as a spreadsheet upload,
   * so the change row keeps the uploaded sheets (legacy revert + apply re-diff).
   * A sheet the organiser did not upload is `null` — the row stores `""` in that
   * slot and {@link DecodedChange.scope} is what tells apply/revert to skip it.
   * The whole field is `null` for a DesiredState-JSON editor save — the
   * before-image (E3) is the revert source for those.
   */
  readonly uploadedCsv: {
    readonly eventsCsv: string | null;
    readonly guestsCsv: string | null;
  } | null;
  /** `'import'` (spreadsheet) or `'editor'` (draft-save) — the change kind (E3). */
  readonly kind: "import" | "editor";
  /**
   * Which halves of the wedding this change is authoritative over. `"both"` for
   * every editor save and for a two-sheet upload; `"events"` / `"guests"` for a
   * single-sheet upload. Persisted on the change row's summary so apply (which
   * re-diffs against live state) and revert honour the same scope the preview
   * was computed under.
   */
  readonly scope: ChangeScope;
}

/**
 * The wedding's CURRENT events, in the parser's shape.
 *
 * A guests-only upload still needs the event list: the guest sheet's attendance
 * columns are matched by name against it, and the diff resolves those names to
 * event ids.
 *
 * This maps DB rows STRAIGHT to `ParsedEvent`. The obvious-looking alternative —
 * serialise through `state-export.ts` and re-parse with `parseEventsCsv`, reusing
 * E1's tested export→import fixpoint — is wrong here, in two ways:
 *
 *  1. **Correctness.** `parseEventsCsv` applies the guards that exist to sanitise
 *     an UNTRUSTED UPLOAD: the formula-injection scan (rejecting any cell
 *     starting `=`, `+`, `-`, `@`) and the ISO-timestamp shape check. Our own
 *     rows have never had to satisfy those — an event created in the editor can
 *     legitimately have an address of `-12 Smith Street` or a dress code of
 *     `- black tie`. Round-tripping through the parser would fail on that live
 *     data and, because the error is stamped `sheet: "events"`, would blame a
 *     file the organiser never uploaded and cannot fix from the upload form.
 *  2. **Cost.** It spent a second D1 read of `events` plus an O(events × cells)
 *     serialise / re-parse / re-validate pass, on a path whose consumers read
 *     only `name` (`parseGuestsCsv`'s column matching) and `id`.
 *
 * The projection below is the full `ParsedEvent` shape rather than the two fields
 * today's consumers touch, so the value stays an honest desired-state event and a
 * future reader of `desiredState.events` isn't handed a half-built record.
 */
export function currentEventsAsParsed(
  weddingId: string,
): Effect.Effect<ParsedEvent[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({
          id: events.id,
          name: events.name,
          startAt: events.startAt,
          endAt: events.endAt,
          timezone: events.timezone,
          address: events.address,
          dressCodeDescription: events.dressCodeDescription,
          dressCodePalette: events.dressCodePalette,
          pinterestUrl: events.pinterestUrl,
          mapsUrl: events.mapsUrl,
        })
        .from(events)
        .where(eq(events.weddingId, weddingId))
        // Same ordering as the round-trip export, so `sortOrder` below is the
        // wedding's real schedule order.
        .orderBy(asc(events.sortOrder), asc(events.name))
        .all(),
    );

    return rows.map((e, i) => ({
      id: e.id,
      name: e.name,
      startAt: e.startAt,
      endAt: e.endAt,
      timezone: e.timezone,
      // No `location` column exists — the venue text lives in `address`.
      location: null,
      address: e.address,
      dressCodeDescription: e.dressCodeDescription,
      dressCodePalette: decodePalette(e.dressCodePalette).palette ?? [],
      // Same http(s) guard the export applies, so a legacy bad URL degrades to
      // null instead of travelling on in a desired state.
      pinterestUrl: safeHttpUrl(e.pinterestUrl),
      mapsUrl: safeHttpUrl(e.mapsUrl),
      sortOrder: i,
    }));
  }).pipe(Effect.withSpan("cire.changes.currentEventsAsParsed"));
}

/**
 * Decode either request shape into a normalised {@link DecodedChange}. The CSV
 * shape runs the same parser the import always has (`parseEventsCsv` /
 * `parseGuestsCsv`), so both front doors produce an identical DesiredState the
 * one pipeline consumes.
 */
export function decodeChangeBody(
  raw: unknown,
  weddingId: string,
): Effect.Effect<DecodedChange, SpreadsheetParseError | ParseResult.ParseError, DbService> {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknown(ChangeBody)(raw);

    if ("desiredState" in body) {
      // Editor front door: the draft is the whole truth (manage all shown rows).
      return {
        desiredState: body.desiredState,
        removeManual: true,
        // The draft is id-authoritative: every existing row carries its id, so an
        // id-less row is a genuinely new one, never a same-named existing row.
        matchByName: false,
        uploadedCsv: null,
        kind: "editor",
        scope: "both",
      } satisfies DecodedChange;
    }

    // Spreadsheet front door: parse whichever sheets were uploaded into the same
    // DesiredState. The refinement on CsvChangeBody guarantees at least one.
    const scope: ChangeScope =
      body.eventsCsv === undefined ? "guests" : body.guestsCsv === undefined ? "events" : "both";

    // A guests-only upload matches its attendance columns against the events
    // that already exist, so hydrate them; an events-only upload carries no
    // households at all.
    // Named `desiredEvents`, not `events` — the `events` TABLE is imported at
    // module scope for the hydration read above, and shadowing it here would be
    // a trap for the next edit.
    const desiredEvents =
      body.eventsCsv === undefined
        ? yield* currentEventsAsParsed(weddingId)
        : yield* parseEventsCsv(body.eventsCsv);
    const families =
      body.guestsCsv === undefined ? [] : yield* parseGuestsCsv(body.guestsCsv, desiredEvents);

    return {
      desiredState: {
        events: desiredEvents as readonly ParsedEvent[],
        families: families as readonly ParsedFamily[],
      },
      // Provenance default unless the organiser flipped the toggle.
      removeManual: body.removeManual ?? false,
      // A sheet's rows are matched by name unless they carry the fidelity ids.
      matchByName: true,
      uploadedCsv: { eventsCsv: body.eventsCsv ?? null, guestsCsv: body.guestsCsv ?? null },
      kind: "import",
      scope,
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
