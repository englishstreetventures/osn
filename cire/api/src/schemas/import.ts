import { isValidGuestEmail, normaliseGuestEmail } from "@cire/guest-email";
import { isSafeCssColor } from "@cire/theme";
import { Schema } from "effect";

// ── Size limits ───────────────────────────────────────────────────────────────

/**
 * The most rows one uploaded sheet may carry, and so the most households an
 * editor draft may carry: the two front doors admit the same wedding.
 */
export const MAX_ROWS = 5000;

/**
 * The most events a wedding's schedule may hold, at either front door. Every
 * guest row of a checkpoint's before-image carries one attendance cell per
 * event, so the event count multiplies the size of every before-image, and of
 * every revert that parses one; this cap keeps that product small.
 */
export const MAX_EVENTS = 200;

/**
 * The longest any one value may be, in characters: the sheet parser's cap on
 * every cell once its formula guard is off (`services/spreadsheet.ts`), and the
 * editor door's cap on every value it can store, so the two doors admit the
 * same text.
 */
export const MAX_CELL_LENGTH = 10_000;

/**
 * The most items one event's run of show may hold, at either front door. With
 * {@link MAX_RUN_OF_SHOW_LABEL} it keeps a full run of show's sheet cell
 * (`HH:MM label` per line) under {@link MAX_CELL_LENGTH}, so a download of one
 * re-imports.
 */
export const MAX_RUN_OF_SHOW_ITEMS = 40;

/** The longest one run-of-show item's label may be, in characters. */
export const MAX_RUN_OF_SHOW_LABEL = 200;

/** A 24-hour wall clock, `HH:MM`: hours 00–23, minutes 00–59. */
export const CLOCK_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** A check that a string is at most {@link MAX_CELL_LENGTH} characters. */
const withinCell = (field: string) =>
  Schema.makeFilter((s: string) =>
    s.length <= MAX_CELL_LENGTH
      ? undefined
      : `${field} must be at most ${MAX_CELL_LENGTH} characters`,
  );

/** A string of at most {@link MAX_CELL_LENGTH} characters. */
const BoundedText = (field: string) => Schema.String.check(withinCell(field));

// ── Parsed sheet shapes ───────────────────────────────────────────────────────

/**
 * One dress-code swatch. The colour must pass the same allow-list the guest
 * site checks before it paints one (`isSafeCssColor`), so neither front door
 * can store a value such as `url(...)` that a renderer using the `background`
 * shorthand would fetch.
 */
export const PaletteSwatch = Schema.Struct({
  name: BoundedText("swatch name"),
  color: Schema.String.check(
    withinCell("swatch colour"),
    Schema.makeFilter((s) =>
      isSafeCssColor(s) ? undefined : "Invalid colour (use hex, rgb(a), hsl(a) or oklch)",
    ),
  ),
});
export type PaletteSwatch = Schema.Schema.Type<typeof PaletteSwatch>;

/**
 * One item of an event's run of show. `time` is the event's own wall clock, so
 * it carries no date and no offset. The label is one line: the sheet writes one
 * item per line, so a line break inside a label would come back as an item with
 * no time. Validation only, no trim, so the diff compares what was sent.
 */
export const RunOfShowItem = Schema.Struct({
  time: Schema.String.check(
    Schema.makeFilter((s: string) =>
      CLOCK_TIME_RE.test(s) ? undefined : "run of show time must be a 24-hour time (HH:MM)",
    ),
  ),
  label: Schema.String.check(
    Schema.makeFilter((s: string) =>
      s.trim().length > 0 && s.length <= MAX_RUN_OF_SHOW_LABEL && !/[\r\n]/.test(s)
        ? undefined
        : `run of show label must be one non-blank line of at most ${MAX_RUN_OF_SHOW_LABEL} characters`,
    ),
  ),
});
export type RunOfShowItem = Schema.Schema.Type<typeof RunOfShowItem>;

/** Whether children are welcome at an event. Absent or null ⇒ not stated. */
export const ChildrenPolicy = Schema.Literals(["adults_only", "children_welcome"]);
export type ChildrenPolicy = Schema.Schema.Type<typeof ChildrenPolicy>;

/**
 * How plus-ones work at an event. Wording only: each guest's own
 * `plus_one_allowed` decides who may bring one. Absent or null ⇒ not stated.
 */
export const PlusOnePolicy = Schema.Literals(["by_invitation", "welcome"]);
export type PlusOnePolicy = Schema.Schema.Type<typeof PlusOnePolicy>;

export const ParsedEvent = Schema.Struct({
  /**
   * Optional stable id, honoured from the `Event ID` fidelity column when a
   * `?fidelity=full` export is re-imported (E2). Absent (the default for a
   * hand-authored or standard-export sheet) ⇒ the diff matches by name, exactly
   * today's behaviour. Present ⇒ the diff matches by id, so a rename is an
   * update rather than remove+create.
   */
  id: Schema.optional(Schema.String),
  name: BoundedText("name"),
  startAt: BoundedText("startAt"),
  /** Optional in the sheet; "" ⇒ no stated end (matches the DB's "" sentinel). */
  endAt: BoundedText("endAt"),
  timezone: BoundedText("timezone"),
  /**
   * The event's description, shown under About on the invite and in calendar
   * entries. Optional, and ABSENT is not empty: a sheet with no Description
   * column, and an editor too old to send one, leave the stored description as
   * it is; `""` clears it. A create with none stores `""`.
   */
  description: Schema.optional(BoundedText("description")),
  /**
   * The venue's name — the sheet's Location column, the editor's Venue name.
   * Same absent-is-not-empty rule as `description`; `null` clears it. A create
   * with none stores NULL.
   */
  venueName: Schema.optional(Schema.NullOr(BoundedText("venueName"))),
  /**
   * Always null when present, and read by nothing. The host still sends it,
   * and the decoded value is what a preview stores for its apply, so keeping
   * the key keeps a change previewed here applicable by a cire-api older than
   * the venue name, which requires it, after a rollback.
   */
  location: Schema.optional(Schema.Null),
  /**
   * The event's run of show, in the organiser's order. Same absent-is-not-empty
   * rule as `description`: absent leaves the stored list as it is; present is
   * the whole list, so `[]` clears it.
   */
  runOfShow: Schema.optional(
    Schema.Array(RunOfShowItem).check(Schema.isMaxLength(MAX_RUN_OF_SHOW_ITEMS)),
  ),
  /** Parking, transport and accessibility notes. Absent keeps; `null` clears. */
  gettingThere: Schema.optional(Schema.NullOr(BoundedText("gettingThere"))),
  /** The guest policy's two presets and its note. Absent keeps; `null` clears. */
  childrenPolicy: Schema.optional(Schema.NullOr(ChildrenPolicy)),
  plusOnePolicy: Schema.optional(Schema.NullOr(PlusOnePolicy)),
  guestPolicyNote: Schema.optional(Schema.NullOr(BoundedText("guestPolicyNote"))),
  address: Schema.NullOr(BoundedText("address")),
  dressCodeDescription: Schema.NullOr(BoundedText("dressCodeDescription")),
  dressCodePalette: Schema.Array(PaletteSwatch),
  pinterestUrl: Schema.NullOr(BoundedText("pinterestUrl")),
  mapsUrl: Schema.NullOr(BoundedText("mapsUrl")),
  sortOrder: Schema.Number,
});
export type ParsedEvent = Schema.Schema.Type<typeof ParsedEvent>;

/** The longest raw `email` / `emailExpected` the editor door accepts. */
const MAX_RAW_EMAIL_LENGTH = 1024;

/**
 * A guest's address as the editor sends it: `""` (none) or a string that is
 * one address once normalised. Validation only; the diff normalises.
 */
const DraftEmail = Schema.String.check(
  Schema.makeFilter((s) =>
    s.length <= MAX_RAW_EMAIL_LENGTH &&
    (s.trim().length === 0 || isValidGuestEmail(normaliseGuestEmail(s)))
      ? undefined
      : "email must be blank or one email address",
  ),
);

export const ParsedGuest = Schema.Struct({
  /** Optional stable id from the `Guest ID` fidelity column (E2). Absent ⇒
   *  match by `(family, firstName)` as today; present ⇒ match by id, so a
   *  first-name fix is an update, not remove+create. */
  id: Schema.optional(Schema.String),
  firstName: BoundedText("firstName"),
  lastName: BoundedText("lastName"),
  /** Optional informal name for the single-guest greeting; null ⇒ use firstName. */
  nickname: Schema.NullOr(BoundedText("nickname")),
  /** Names of events the guest is invited to. */
  eventNames: Schema.Array(Schema.String),
  /**
   * The guest's address. ABSENT leaves the stored address as it is (a sheet
   * without the `Guest Email` column, an editor row the organiser did not
   * touch); `null` or `""` clears it; a string sets it. Who supplied an
   * address is never on the wire: an address set here is the organiser's,
   * under their attestation at apply.
   */
  email: Schema.optional(Schema.NullOr(DraftEmail)),
  /**
   * The address the editor loaded for this guest, sent with `email`. The
   * write happens only while the stored address still equals it, so an
   * address a guest saved since the editor loaded is never overwritten.
   */
  emailExpected: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_RAW_EMAIL_LENGTH))),
  ),
});
export type ParsedGuest = Schema.Schema.Type<typeof ParsedGuest>;

/**
 * The consent record behind a stored address, as a before-image carries it:
 * who supplied it, when (epoch ms), under which wording, and the attesting
 * organiser, if any.
 */
export const EmailRecord = Schema.Struct({
  source: Schema.Literals(["guest", "organiser_attested"]),
  consentAt: Schema.Number,
  version: Schema.String,
  attestedBy: Schema.NullOr(Schema.String),
});
export type EmailRecord = Schema.Schema.Type<typeof EmailRecord>;

export const ParsedFamily = Schema.Struct({
  /** Optional stable id — the internal family id from the full-fidelity
   *  `Family ID` column (E2). Absent ⇒ match by name; present ⇒ match by id so
   *  a household rename preserves the row (and its claim code). */
  id: Schema.optional(Schema.String),
  /** Optional claim code / `publicId` from the `Family Code` fidelity column.
   *  Carried through so a full-fidelity round trip preserves invite codes; the
   *  households-always-coded model means every household has one. */
  publicId: Schema.optional(BoundedText("publicId")),
  /** Non-blank, bounded (same 10k cell cap the CSV parser enforces). The CSV
   *  front door already guarantees both; this closes the DesiredState JSON
   *  front door, which previously accepted a blank or multi-hundred-KB name
   *  straight onto rows the guest invite renders. Validation only — no
   *  trim transform, so the diff still compares the exact submitted value. */
  familyName: Schema.String.check(
    Schema.makeFilter((s) =>
      s.trim().length > 0 && s.length <= MAX_CELL_LENGTH
        ? undefined
        : `familyName must be non-blank and at most ${MAX_CELL_LENGTH} characters`,
    ),
  ),
  guests: Schema.Array(ParsedGuest),
});
export type ParsedFamily = Schema.Schema.Type<typeof ParsedFamily>;

/**
 * Where a household or guest row came from: `'import'` (a spreadsheet upload)
 * or `'manual'` (the in-app editor). A CSV upload without the "also remove
 * manually-added rows" toggle removes only `'import'` rows.
 */
export type Provenance = "import" | "manual";

/**
 * A desired guest as the diff reads it: the wire shape plus the provenance a
 * row it creates takes. `source` is deliberately not on {@link ParsedGuest}:
 * the editor door decodes that schema, which drops the key, so a client cannot
 * choose it. Only the revert's snapshot parser sets it.
 */
export interface DesiredGuest extends ParsedGuest {
  readonly source?: Provenance;
  /**
   * The consent record behind `email`, set only by the revert's snapshot
   * parser. Like `source` it is not on {@link ParsedGuest}, so an editor body
   * cannot claim one: a client can never present an address as the guest's
   * own, or skip the organiser's attestation.
   */
  readonly emailRecord?: EmailRecord;
}

/** A desired household as the diff reads it — see {@link DesiredGuest}. */
export interface DesiredFamily extends Omit<ParsedFamily, "guests"> {
  readonly guests: readonly DesiredGuest[];
  readonly source?: Provenance;
}

// ── Desired state ─────────────────────────────────────────────────────────────

/**
 * The canonical desired-state both front doors of the reconcile pipeline funnel
 * into (see [[guest-event-editor]] §3). The CSV parser produces it (ids absent
 * ⇒ name matching, exactly today's import); the editor's draft-save (E5/E6) will
 * produce it directly (ids present for existing rows, absent for new ones).
 * `diffAgainstDb` consumes exactly `{ events, families }`, so this is just the
 * named tuple of the two parser outputs — the type the diff reconciles TO.
 *
 * Model note: households ALWAYS carry a `publicId` (the "households ≠ codes"
 * work was reversed), so a full-fidelity DesiredState carries a code per
 * household; there is no code-less household path.
 */
export const DesiredState = Schema.Struct({
  events: Schema.Array(ParsedEvent).check(Schema.isMaxLength(MAX_EVENTS)),
  families: Schema.Array(ParsedFamily).check(Schema.isMaxLength(MAX_ROWS)),
});
export type DesiredState = Schema.Schema.Type<typeof DesiredState>;

/**
 * Which halves of the wedding a change is AUTHORITATIVE over.
 *
 * A spreadsheet upload need not carry both sheets: an organiser can post just
 * the events CSV, just the guests CSV, or both. The desired state is only "the
 * whole truth" for the halves that were actually uploaded — the other half is
 * untouched, NOT read as "everything is absent, remove it all".
 *
 *  - `"both"` — events + guests reconcile (a two-sheet import).
 *  - `"events"` — only the schedule reconciles; households, guests and their
 *    attendance links are left exactly as they are. The events editor's save.
 *  - `"guests"` — only households/guests/attendance reconcile; the schedule is
 *    left as it is, and attendance is matched against the events that already
 *    exist. The guests editor's save.
 */
export const ChangeScope = Schema.Literals(["both", "events", "guests"]);
export type ChangeScope = Schema.Schema.Type<typeof ChangeScope>;

// ── Diff plan ─────────────────────────────────────────────────────────────────

export const EventCreate = Schema.Struct({
  id: Schema.String,
  event: ParsedEvent,
});
export type EventCreate = Schema.Schema.Type<typeof EventCreate>;

export const EventUpdate = Schema.Struct({
  id: Schema.String,
  event: ParsedEvent,
});
export type EventUpdate = Schema.Schema.Type<typeof EventUpdate>;

export const EventRemove = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type EventRemove = Schema.Schema.Type<typeof EventRemove>;

const ProvenanceSchema = Schema.Literals(["import", "manual"]);

export const FamilyCreate = Schema.Struct({
  id: Schema.String,
  publicId: Schema.String,
  familyName: Schema.String,
  /** The `source` the insert writes; absent ⇒ `'import'`, the column default. */
  source: Schema.optional(ProvenanceSchema),
});
export type FamilyCreate = Schema.Schema.Type<typeof FamilyCreate>;

/**
 * An id-matched household RENAME. Only the name can change in place — the row,
 * its claim code (`publicId`) and its guests all survive by construction of the
 * id match, so the op carries just the id and the new name. Emitted only on the
 * id-matched path (the editor front door, a full-fidelity re-import, a
 * before-image revert): a name-matched household's name is unchanged by
 * definition modulo case/whitespace, and the no-id plan stays byte-identical to
 * the historical diff by never writing it.
 */
export const FamilyUpdate = Schema.Struct({
  id: Schema.String,
  familyName: Schema.String,
});
export type FamilyUpdate = Schema.Schema.Type<typeof FamilyUpdate>;

export const FamilyRemove = Schema.Struct({
  id: Schema.String,
  familyName: Schema.String,
});
export type FamilyRemove = Schema.Schema.Type<typeof FamilyRemove>;

export const GuestCreate = Schema.Struct({
  id: Schema.String,
  familyId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  nickname: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
  /** The `source` the insert writes; absent ⇒ `'import'`, the column default. */
  source: Schema.optional(ProvenanceSchema),
});
export type GuestCreate = Schema.Schema.Type<typeof GuestCreate>;

export const GuestUpdate = Schema.Struct({
  id: Schema.String,
  /**
   * Present ONLY for an id-matched first-name RENAME (E2) — the write set then
   * updates `first_name`. Omitted on the name-matched path (a name match means
   * the first name is unchanged by definition), so a no-id import emits exactly
   * today's shape and stays byte-identical.
   */
  firstName: Schema.optional(Schema.String),
  lastName: Schema.String,
  nickname: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
});
export type GuestUpdate = Schema.Schema.Type<typeof GuestUpdate>;

export const GuestRemove = Schema.Struct({
  id: Schema.String,
  firstName: Schema.String,
  /** A plus-one removed because their inviter is: counted and warned about
   *  like any removal, but deleted by the inviter's cascade, not by a
   *  statement of their own. */
  cascaded: Schema.optional(Schema.Boolean),
});
export type GuestRemove = Schema.Schema.Type<typeof GuestRemove>;

/**
 * One guest's address the plan sets or clears. `email` null clears it.
 * `emailWas` is the stored address the diff decided against: the write applies
 * only while it still is, so an address that changed between the diff and the
 * commit (a guest's save on the invite) is never overwritten. `record` is the
 * consent record a revert restores; without one the address is the applying
 * organiser's, stamped from their attestation.
 */
export const GuestEmailWrite = Schema.Struct({
  guestId: Schema.String,
  email: Schema.NullOr(Schema.String),
  emailWas: Schema.NullOr(Schema.String),
  record: Schema.optional(EmailRecord),
});
export type GuestEmailWrite = Schema.Schema.Type<typeof GuestEmailWrite>;

export const EventLink = Schema.Struct({
  guestId: Schema.String,
  eventId: Schema.String,
});
export type EventLink = Schema.Schema.Type<typeof EventLink>;

/**
 * A checklist task linked to an event the plan removes. The preview lists them
 * so the organiser can choose to remove some with the event; every one not
 * chosen is kept, unlinked, at `frozenRunAt` — the time it last had, on the
 * removed event's clock (`frozenTimezone`) — and marked "event removed".
 * `frozenRunAt` is null when the event's start could not be read.
 */
export const LinkedTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  eventId: Schema.String,
  offsetMinutes: Schema.NullOr(Schema.Number),
  frozenRunAt: Schema.NullOr(Schema.String),
  frozenTimezone: Schema.NullOr(Schema.String),
});
export type LinkedTask = Schema.Schema.Type<typeof LinkedTask>;

export const ImportPlan = Schema.Struct({
  eventCreates: Schema.Array(EventCreate),
  eventUpdates: Schema.Array(EventUpdate),
  eventRemoves: Schema.Array(EventRemove),
  familyCreates: Schema.Array(FamilyCreate),
  familyUpdates: Schema.Array(FamilyUpdate),
  familyRemoves: Schema.Array(FamilyRemove),
  guestCreates: Schema.Array(GuestCreate),
  guestUpdates: Schema.Array(GuestUpdate),
  guestRemoves: Schema.Array(GuestRemove),
  eventLinkCreates: Schema.Array(EventLink),
  eventLinkRemoves: Schema.Array(EventLink),
  /** Addresses set or cleared, after the guest creates and updates. Absent
   *  on a plan from a caller that changes none. */
  emailWrites: Schema.optional(Schema.Array(GuestEmailWrite)),
  warnings: Schema.Array(Schema.String),
  /** The tasks linked to the events in `eventRemoves`; absent when it removes
   *  none, or none has a task linked to it. */
  linkedTasks: Schema.optional(Schema.Array(LinkedTask)),
  /**
   * The wedding's guest-capacity ceiling, when `diffAgainstDb`'s preview
   * warning already read it from the wedding's tier — lets `applyImport`'s
   * check before the write skip reading the same row again in the SAME
   * request. Absent whenever the preview never needed the real cap (the
   * base-cap pre-check proved the import couldn't breach it, or `guestCreates`
   * was empty); `applyImport` MUST keep enforcing the cap itself in that case,
   * never treat absence as "no cap". The guest inserts check the cap the tier
   * gives as they write, whatever this says.
   */
  derivedCap: Schema.optional(Schema.Number),
});
export type ImportPlan = Schema.Schema.Type<typeof ImportPlan>;

export const ImportSummary = Schema.Struct({
  changeId: Schema.String,
  eventsCreated: Schema.Number,
  eventsUpdated: Schema.Number,
  eventsRemoved: Schema.Number,
  familiesCreated: Schema.Number,
  familiesUpdated: Schema.Number,
  familiesRemoved: Schema.Number,
  guestsCreated: Schema.Number,
  guestsUpdated: Schema.Number,
  guestsRemoved: Schema.Number,
});
export type ImportSummary = Schema.Schema.Type<typeof ImportSummary>;

// ── Request bodies ────────────────────────────────────────────────────────────

export const PreviewBody = Schema.Struct({
  eventsCsv: Schema.String,
  guestsCsv: Schema.String,
});
export type PreviewBody = Schema.Schema.Type<typeof PreviewBody>;

/**
 * `confirmClears` echoes the preview's `clears` for an editor save that empties
 * a half of the wedding (see `clearedHalves` in `services/changes.ts`). Apply
 * refuses such a save without it, so a whole-list removal only happens from a
 * client that showed the organiser the count.
 */
export const ApplyBody = Schema.Struct({
  changeId: Schema.String,
  /**
   * `ORGANISER_EMAIL_ATTESTATION.version`, sent when the preview set any
   * address (`emailAttestations > 0`): the organiser ticked the attestation.
   * Apply refuses such a change without it.
   */
  emailAttestation: Schema.optional(Schema.String),
  confirmClears: Schema.optional(
    Schema.Struct({
      events: Schema.Number,
      households: Schema.Number,
    }),
  ),
  /**
   * The ids of the preview's `linkedTasks` the organiser chose to remove with
   * their events. Absent — an older portal, or nothing chosen — keeps every
   * one. Only an id still linked to an event the apply removes is removed;
   * any other is ignored.
   */
  removeLinkedTasks: Schema.optional(
    Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(64))).check(
      Schema.isMaxLength(500),
    ),
  ),
});
export type ApplyBody = Schema.Schema.Type<typeof ApplyBody>;

export const RevertBody = Schema.Struct({
  changeId: Schema.String,
});
export type RevertBody = Schema.Schema.Type<typeof RevertBody>;
