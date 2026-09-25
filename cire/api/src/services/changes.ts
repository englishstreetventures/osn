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
 *     "Concurrency guard"): a digest of every committed change. The editor
 *     reads it BEFORE loading the rows it seeds a draft from and sends it with
 *     the preview; preview refuses a draft whose token is no longer the head,
 *     stamps the head on the change row, and apply 409s if it moved since.
 *     The check is not part of apply's write: two applies that both read the
 *     head before either commits can both land, so the window between apply's
 *     head read and its final batch is still open.
 *  3. {@link clearedHalves} — whether an editor save empties a half of the
 *     wedding, which apply refuses unless the request confirms the count.
 */
import { events, imports } from "@cire/db";
import { and, asc, eq, or } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { DbService, dbQuery } from "../db";
import { ChangeScope, DesiredState } from "../schemas/import";
import type { ImportPlan, ParsedEvent, ParsedFamily } from "../schemas/import";
import { decodePalette, safeHttpUrl } from "./claim";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";
import type { SpreadsheetParseError } from "./spreadsheet";

// ── Request body shapes ─────────────────────────────────────────────────────

/**
 * The sheet slots a spreadsheet upload can carry.
 *
 * Named once because three separate places have to agree on the list: the
 * struct's own fields, the "at least one sheet" refinement, and the
 * {@link ExclusiveFrontDoor} pre-pass that refuses a body carrying both front
 * doors. The struct still has to spell each field out — Effect Schema needs
 * literal keys — but the two checks derive from this, so adding a third slot
 * cannot leave a door quietly unguarded.
 */
const CSV_SLOTS = ["eventsCsv", "guestsCsv"] as const;

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
}).check(
  Schema.makeFilter((body) =>
    CSV_SLOTS.some((slot) => body[slot] !== undefined)
      ? undefined
      : "at least one of eventsCsv / guestsCsv is required",
  ),
);
export type CsvChangeBody = Schema.Schema.Type<typeof CsvChangeBody>;

/**
 * An editor draft-save: the whole DesiredState (ids present for existing rows,
 * absent for new ones) for the half of the wedding named by `scope`.
 *
 * Two fields state the contract the draft is built on rather than leaving the
 * server to assume it:
 *  - `removeManual: true` — the draft is the whole truth for its scope, so an
 *    existing row it does not carry is a removal whatever its provenance. The
 *    only legal value; a body without it is refused.
 *  - `baseRevision` — the {@link headRevision} the editor read BEFORE loading the
 *    rows it seeded the draft from. Preview refuses the draft when the head has
 *    moved since, because a row a co-host added after that load is absent from
 *    the draft for no reason the organiser chose, and would read as a removal.
 */
export const DesiredStateChangeBody = Schema.Struct({
  desiredState: DesiredState,
  // Which half of the wedding this save is authoritative over. Both editors
  // send it (`"guests"`, `"events"`); omitted, it defaults to `"both"`.
  scope: Schema.optional(ChangeScope),
  removeManual: Schema.Literal(true),
  baseRevision: Schema.String,
});
export type DesiredStateChangeBody = Schema.Schema.Type<typeof DesiredStateChangeBody>;

/**
 * Either front door. `Schema.Union` tries each member in order; the two shapes
 * are disjoint (`desiredState` vs `eventsCsv`/`guestsCsv`), so a body decodes to
 * exactly one. A malformed body fails both and surfaces as the shared 400.
 */
export const ChangeBody = Schema.Union([DesiredStateChangeBody, CsvChangeBody]);
export type ChangeBody = Schema.Schema.Type<typeof ChangeBody>;

/**
 * Rejects a body that carries BOTH front doors' fields, before the union above
 * gets to choose between them.
 *
 * A union member that fails falls through to the next one, and the two members
 * differ in far more than shape: the editor door applies `removeManual: true`
 * and `matchByName: false`, the spreadsheet door the opposite pair. So a body
 * holding a `desiredState` AND a CSV slot is decided by whether its
 * `desiredState` happens to parse — a draft with one bad field silently becomes
 * a spreadsheet import of whatever CSV rode along, under diff options the
 * caller never asked for. There is no reading of such a body that is more
 * likely right than the other, so it is refused rather than guessed at.
 *
 * A separate pre-pass rather than a `Schema.filter` on either member, because a
 * `Schema.Struct` strips the other door's keys before a filter can see them.
 */
const ExclusiveFrontDoor = Schema.Unknown.check(
  Schema.makeFilter((raw) =>
    typeof raw === "object" &&
    raw !== null &&
    "desiredState" in raw &&
    CSV_SLOTS.some((slot) => slot in raw)
      ? "a change is either an editor draft (desiredState) or a spreadsheet upload (eventsCsv/guestsCsv), never both"
      : undefined,
  ),
);

// ── Normalised decode ───────────────────────────────────────────────────────

export interface DecodedChange {
  /** The desired state both shapes reduce to — the input `diffAgainstDb` reads. */
  readonly desiredState: DesiredState;
  /**
   * True for the editor front door, which states it in its body: the draft is
   * the whole truth, so the diff manages every row it was shown. For a CSV
   * upload this is the caller's `removeManual` toggle (default false —
   * provenance default).
   */
  readonly removeManual: boolean;
  /**
   * The head revision the editor read before loading its draft's rows, or
   * `null` for a spreadsheet upload (a sheet is not built from loaded rows).
   */
  readonly baseRevision: string | null;
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
   * a two-sheet upload and for an editor save that sends no scope; a
   * single-sheet upload is `"events"` / `"guests"`, and each editor sends its
   * own half. Persisted on the change row's summary so apply (which re-diffs
   * against live state) manages the same halves the preview was computed under.
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
): Effect.Effect<DecodedChange, SpreadsheetParseError | Schema.SchemaError, DbService> {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(ChangeBody)(
      yield* Schema.decodeUnknownEffect(ExclusiveFrontDoor)(raw),
    );

    if ("desiredState" in body) {
      // Editor front door: the draft is the whole truth (manage all shown rows).
      return {
        desiredState: body.desiredState,
        removeManual: body.removeManual,
        baseRevision: body.baseRevision,
        // The draft is id-authoritative: every existing row carries its id, so an
        // id-less row is a genuinely new one, never a same-named existing row.
        matchByName: false,
        uploadedCsv: null,
        kind: "editor",
        scope: body.scope ?? "both",
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
      baseRevision: null,
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
 * Sentinel revision for a wedding with no committed change — distinct from any
 * digest, so a draft or preview taken at genesis still detects a concurrent
 * first apply.
 */
export const GENESIS_REVISION = "genesis";

/**
 * The wedding's current head revision: a SHA-256 digest (hex) of every
 * committed change — each `applied` or `reverted` row's id, status and
 * `appliedAt`/`revertedAt` — or {@link GENESIS_REVISION} when there is none
 * (§6 "Concurrency guard").
 *
 * A digest of the whole set rather than "the newest row", because the newest
 * row cannot be told apart reliably: `appliedAt` and `revertedAt` are stamped
 * before their write set commits, so a revert that started first can commit
 * last and still carry the older time, two changes can share a millisecond, and
 * reverting the newest change leaves its id where it was. Every committed apply
 * adds a row to the set and every committed revert changes one, in the same
 * final batch as its data writes, so the digest moves exactly when the wedding
 * does — in whatever order the writes land.
 *
 * A `preview` row is not part of the set, so a second preview never moves the
 * head; an apply or a revert does.
 */
export function headRevision(weddingId: string): Effect.Effect<string, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({
          id: imports.id,
          status: imports.status,
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
    const canonical = JSON.stringify(
      rows
        .map((r) => [r.id, r.status, r.appliedAt, r.revertedAt] as const)
        .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    );
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
    );
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }).pipe(Effect.withSpan("cire.changes.headRevision"));
}

// ── Emptied halves ──────────────────────────────────────────────────────────

/**
 * How many rows an editor save removes from each half of the wedding it leaves
 * EMPTY. Both counts are 0 for a half the save still populates, does not
 * manage, or that was already empty.
 */
export interface ClearedHalves {
  readonly events: number;
  readonly households: number;
}

/**
 * Whether a change empties a managed half of the wedding — every event, or
 * every household — and by how many rows. `null` when it empties neither.
 *
 * An empty half of a draft is a legitimate "remove them all", but it is also
 * exactly what an editor bug that seeds a slice from nothing produces, so
 * apply refuses it unless the request echoes these counts back from the
 * preview that showed them.
 */
export function clearedHalves(
  desired: DesiredState,
  plan: Pick<ImportPlan, "eventRemoves" | "familyRemoves">,
  scope: ChangeScope,
): ClearedHalves | null {
  // Not `events`: that name is the table this module imports.
  const eventsRemoved =
    scope !== "guests" && desired.events.length === 0 ? plan.eventRemoves.length : 0;
  const householdsRemoved =
    scope !== "events" && desired.families.length === 0 ? plan.familyRemoves.length : 0;
  return eventsRemoved > 0 || householdsRemoved > 0
    ? { events: eventsRemoved, households: householdsRemoved }
    : null;
}
