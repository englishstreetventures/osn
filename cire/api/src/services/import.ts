import {
  events,
  families,
  guests,
  guestEvents,
  rsvps,
  seatingAssignments,
  seatingPlans,
  seatingTables,
  taskTemplateDismissals,
  tasks,
  weddings,
} from "@cire/db";
import { formatDietaryCell, parsePresets } from "@cire/dietary";
import { isValidGuestEmail, normaliseGuestEmail } from "@cire/guest-email";
import { jsonEachIn } from "@shared/db-utils";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data, type Types } from "effect";

import {
  bound,
  commitGroupedBatches,
  DbService,
  dbQuery,
  driverErrorText,
  startsNewChunk,
  MAX_STATEMENTS_PER_BATCH,
} from "../db";
import type { Db } from "../db";
import { anchoredRunAt } from "../lib/run-time";
import { metricGuestEmailChanged, metricImportApplied } from "../metrics";
import type {
  ChangeScope,
  EventCreate,
  EventLink,
  EventRemove,
  EventUpdate,
  FamilyCreate,
  FamilyRemove,
  FamilyUpdate,
  GuestCreate,
  GuestRemove,
  GuestUpdate,
  ImportPlan,
  DesiredFamily,
  DesiredGuest,
  GuestEmailWrite,
  ImportSummary,
  LinkedTask,
  ParsedEvent,
  Provenance,
  RunOfShowItem,
} from "../schemas/import";
import { hashGuestEmail, suppressedHashes } from "./email-suppression";
import { generateFamilyCode } from "./family-code";
import type { CodeStyle } from "./family-code";
import { sameRunOfShow } from "./guest-event-validation";
import { resolvePinUrl } from "./pinterest-resolve";
import { runOfShowColumn, runOfShowFrom, runOfShowStatements } from "./run-of-show";
import { seatingLoss, seatingLossWarning } from "./seating";
import {
  BASE_GUEST_CAP,
  CapacityExceeded,
  capForTier,
  normaliseTier,
  roomForOneMoreGuest,
  tierService,
} from "./tiers";

// ── Tagged errors ─────────────────────────────────────────────────────────────

/**
 * The write set did not commit in full. Batches before the failed one may have
 * committed (see {@link commitWriteSet}), so a caller treats this as a change
 * that may have written part of its data.
 */
export class ImportError extends Data.TaggedError("ImportError")<{
  readonly reason: string;
  readonly cause?: unknown;
  /**
   * Set when the guest cap refused a batch while it was being written: the
   * check before the write passed, and another writer took the place between
   * it and the batch. Carries the numbers for the same answer as a refusal
   * before the write.
   */
  readonly capacity?: CapacityExceeded;
}> {}

/**
 * An id-authoritative desired state (the editor front door — see
 * {@link DiffOptions.matchByName}) named a row that no longer exists, or an
 * event it can no longer resolve.
 *
 * Only the editor can raise this, and when it does the draft is provably stale:
 * it carries ids it can only have got from a load, so an id that resolves to
 * nothing means someone else deleted that row since. Refusing is the whole point
 * — with name fallback off, a dangling row is not "unmatched", it is a REMOVE
 * plus a CREATE: the RSVPs attached to it are deleted, and a household comes back
 * with a fresh row carrying the claim code the draft still remembers, resurrecting
 * an invite a co-host may have deliberately revoked. The editor's base revision
 * refuses a draft once ANY change has committed since its load; this is the
 * row-level check behind it, for a write that did not move the revision.
 */
export class StaleDesiredState extends Data.TaggedError("StaleDesiredState")<{
  /** How many desired rows or attendance names failed to resolve (never the values). */
  readonly unresolved: number;
}> {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function mintEventSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // A name with no slug-safe characters must not mint "" — two such events
  // would collide on the (wedding_id, slug) unique index before the de-dupe
  // suffix could tell them apart.
  return base || "event";
}

/**
 * Mint a slug for `name` that is unused within the wedding (`used` holds the
 * wedding's surviving slugs + ones minted earlier in this apply), suffixing
 * `-2`, `-3`, … on a clash. Slugs are unique per wedding, not globally
 * (migration 0051), so only intra-wedding collisions need breaking — e.g. a
 * sheet with both "Ceremony" and "Ceremony!" rows.
 */
export function mintUniqueEventSlug(name: string, used: Set<string>): string {
  const base = mintEventSlug(name);
  let slug = base;
  for (let n = 2; used.has(slug); n += 1) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/**
 * Compute a fully-deterministic plan to reconcile parsed CSV data against the
 * current DB, scoped to a single `weddingId`. Match rules:
 *  - Events: by stable `id` when the parsed event carries one (from the
 *    `Event ID` fidelity column), else by `Event Name` (case-insensitive).
 *    Existing not in sheet → remove. New → create.
 *  - Families: by stable `id` when present (full-fidelity `Family ID`), else by
 *    `family_name` (case-insensitive trim). A name-only sheet keeps the "different
 *    name = remove + create" behaviour; an id-carrying sheet turns a rename into
 *    an in-place UPDATE (`familyUpdates` — the row + its claim code survive and
 *    the new name is written through).
 *  - Guests within matched family: by stable `id` when present (`Guest ID`), else
 *    by `(family, firstName)`. Last-name / nickname change OK (→ guestUpdate);
 *    an id-less first-name change is remove + create, an id-carrying one is an
 *    update (rename-safe).
 *
 * ID-AWARE MATCHING (E2): ids are OPTIONAL and per-record. When present, they
 * are matched first (a rename ⇒ update); an id that resolves to no existing row
 * falls back to name matching, then to create. When ABSENT the code paths below
 * are byte-identical to the pre-E2 name-only diff — the existing import and its
 * tests are not perturbed. A stable id only ever RESOLVES a match; it never
 * changes which write ops are emitted for an already-name-matched record.
 *
 * Tenant scoping: every read is constrained to `weddingId`. `events` and
 * `families` carry the column directly; `guests` and `guest_events` do not, so
 * they're reached by an inner join through `families`. This join is load-bearing
 * — `guest_events` has no `wedding_id` at all, so a naive per-table
 * `WHERE wedding_id = ?` couldn't scope the link table and would read a second
 * wedding's links as removals. applyImport then deletes only by id within this
 * scoped set, so the two halves stay tenant-consistent.
 *
 * PROVENANCE (E4, [[guest-event-editor]] §6 "Provenance default"): a family/
 * guest carries a `source` of `'import'` (spreadsheet-created) or `'manual'`
 * (editor-created). By default a CSV import manages ONLY `source = 'import'`
 * rows — a manually-added household/guest that is absent from the sheet is left
 * INTACT, never removed. `options.removeManual = true` widens the diff to manage
 * everything (restoring "the sheet is the whole truth"), which is what the
 * editor's DesiredState front door and the toggle both pass. The filter only
 * affects the REMOVAL decision for an UNMATCHED existing row: a manual row that
 * IS present in the desired state still matches (by id or name) and updates
 * normally. Events carry no provenance (the sheet is authoritative for the
 * schedule), so `removeManual` never touches event removals.
 */
export interface DiffOptions {
  /**
   * When `false` (default — a CSV import), an unmatched existing family/guest is
   * removed ONLY if its `source = 'import'`; a `'manual'` (editor-created) row is
   * preserved. When `true` (the "also remove manually-added rows" toggle, and
   * every editor save via the DesiredState front door), unmatched rows are
   * removed regardless of source — the desired state is the whole truth.
   */
  readonly removeManual?: boolean;
  /**
   * SCOPE (partial uploads): which halves of the desired state are authoritative
   * — see {@link ChangeScope}. Defaults to `"both"` (the historical two-sheet
   * import and every editor save), so an omitted option is byte-identical to the
   * pre-partial diff.
   *
   * `"events"` and `"guests"` exist so an organiser can upload ONE sheet. The
   * unmanaged half is not merely "left unchanged by coincidence" — it is never
   * read into the diff at all, so an absent household can't be mistaken for a
   * deleted one. The scope only ever SUPPRESSES ops for the unmanaged half; the
   * managed half diffs exactly as it would in a two-sheet import.
   *
   * Cross-half fallout is still correct: an events-only upload that REMOVES an
   * event drops that event's `guest_events` links + RSVPs (applyImport deletes
   * them by `event_id`), because the event genuinely no longer exists. What it
   * does not do is touch a household or a guest row.
   */
  readonly scope?: ChangeScope;
  /**
   * Whether an id-less desired row may match an existing row BY NAME.
   *
   * `true` (default — a CSV upload): a sheet without the fidelity id columns has
   * no other way to say "this is the same household/guest", so name matching is
   * the whole matching story. Unchanged from the historical import.
   *
   * `false` (the editor's DesiredState front door): the draft is built from
   * server rows, so it carries an id for EVERY row that exists and omits it only
   * for a row the organiser just added. Honouring that literally is what makes a
   * deletion stick: with name matching on, deleting "Sam" and adding a different
   * "Sam" in one save resolved the new row to the deleted row — no `guestRemove`
   * was emitted, the old row (and its RSVPs) survived under the new name, and
   * the organiser saw the guest they deleted come back on reload.
   */
  readonly matchByName?: boolean;
  /**
   * The wedding's events as `{id, name}`, when the caller has already read
   * them for this change. The diff then skips its own read of `events`. It
   * must be the complete, current list for `weddingId`: every match and every
   * event removal is decided against it. It carries no {@link ExistingEvent}
   * flags, so a diff given it never warns that an update clears a venue name
   * or a description; its one caller, a guests revert, updates no event.
   */
  readonly existingEvents?: readonly { readonly id: string; readonly name: string }[];
  /**
   * The `source` every household and guest this plan creates is stamped with,
   * overriding any the desired row carries. The editor front door passes
   * `'manual'`. Omitted, a create takes the desired row's own `source` (only
   * a before-image carries one) and otherwise `'import'`.
   */
  readonly createSource?: Provenance;
  /**
   * Whether to read what only the preview shows: the RSVPs a removed guest
   * would lose and the seats and tables the change clears. `true` (default)
   * for the preview, which reads the two together. The apply and every revert
   * pass `false`: they never read `plan.warnings`, so those reads would be
   * thrown away.
   */
  readonly warnings?: boolean;
  /**
   * How the desired rows' email addresses are reconciled — see
   * {@link EmailMode}. Omitted, `"upload"`.
   */
  readonly emails?: EmailMode;
}

/**
 * Which door a change's addresses come through, and so what it may do to them.
 *
 *  - `"editor"` — the guest editor. Sends an address only for a row the
 *    organiser edited, with the address it loaded (`emailExpected`); a row
 *    whose stored address has moved since is left as it is. It may remove an
 *    address a guest gave themselves, never replace one.
 *  - `"upload"` — a spreadsheet. Sets and clears the hosts' addresses; never
 *    touches one a guest gave themselves.
 *  - `"restore"` — a before-image revert. Restores an address with the consent
 *    record the before-image holds, never one without a record, never one the
 *    guest has withdrawn (on the wedding's suppression list), and never changes
 *    an address a guest gave themselves.
 *  - `"ignore"` — the legacy replay of an earlier upload, which carries no
 *    attestation: addresses are left as they are.
 */
export type EmailMode = "editor" | "upload" | "restore" | "ignore";

/** One desired guest's address, beside what is stored for the row it lands on. */
interface EmailCandidate {
  readonly guestId: string;
  readonly stored: string | null;
  readonly storedSource: "guest" | "organiser_attested" | null;
  readonly desired: DesiredGuest;
}

/** A desired or expected address in its stored form; null for none or blank. */
function storedForm(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalised = normaliseGuestEmail(value);
  return normalised.length === 0 ? null : normalised;
}

/** `n` with its noun, singular or plural. */
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The address writes a plan makes, and the preview warnings for the changes it
 * declined, under the rules of {@link EmailMode}. No warning names an address.
 */
function planEmailWrites(
  candidates: readonly EmailCandidate[],
  mode: EmailMode,
  weddingId: string,
): Effect.Effect<{ writes: GuestEmailWrite[]; warnings: string[] }, never, DbService> {
  return Effect.gen(function* () {
    const writes: GuestEmailWrite[] = [];
    const warnings: string[] = [];
    if (mode === "ignore") return { writes, warnings };
    let keptForGuests = 0;
    let stale = 0;
    let withdrawn = 0;
    let unrecorded = 0;
    const toRestore: { candidate: EmailCandidate; email: string }[] = [];
    for (const candidate of candidates) {
      const { desired } = candidate;
      if (desired.email === undefined) continue;
      const email = storedForm(desired.email);
      // Both doors refuse an invalid address before this point; a before-image
      // is read leniently, so this is the restore's guard.
      if (email !== null && !isValidGuestEmail(email)) continue;
      if (email === candidate.stored) continue;
      if (
        mode === "editor" &&
        desired.emailExpected !== undefined &&
        storedForm(desired.emailExpected) !== candidate.stored
      ) {
        stale += 1;
        continue;
      }
      if (candidate.storedSource === "guest" && !(mode === "editor" && email === null)) {
        keptForGuests += 1;
        continue;
      }
      if (mode === "restore" && email !== null) {
        if (desired.emailRecord === undefined) {
          unrecorded += 1;
          continue;
        }
        toRestore.push({ candidate, email });
        continue;
      }
      writes.push({ guestId: candidate.guestId, email, emailWas: candidate.stored });
    }
    if (toRestore.length > 0) {
      const suppressed = yield* suppressedHashes(weddingId);
      for (const { candidate, email } of toRestore) {
        const hash = yield* Effect.promise(() => hashGuestEmail(weddingId, email));
        if (suppressed.has(hash)) {
          withdrawn += 1;
          continue;
        }
        writes.push({
          guestId: candidate.guestId,
          email,
          emailWas: candidate.stored,
          record: candidate.desired.emailRecord,
        });
      }
    }
    if (keptForGuests > 0) {
      warnings.push(
        `${count(keptForGuests, "email address a guest gave themselves was", "email addresses guests gave themselves were")} left as they are: only the guest can change one.`,
      );
    }
    if (stale > 0) {
      warnings.push(
        `${count(stale, "email address has", "email addresses have")} changed since you opened the editor and ${stale === 1 ? "was" : "were"} left as ${stale === 1 ? "it is" : "they are"}.`,
      );
    }
    if (withdrawn > 0) {
      warnings.push(
        `${count(withdrawn, "email address was", "email addresses were")} not restored: the guest removed ${withdrawn === 1 ? "it" : "them"}.`,
      );
    }
    if (unrecorded > 0) {
      warnings.push(
        `${count(unrecorded, "email address was", "email addresses were")} not restored: the change history holds no consent record for ${unrecorded === 1 ? "it" : "them"}.`,
      );
    }
    return { writes, warnings };
  });
}

/**
 * How many addresses a plan sets on the organiser's word: every write that
 * sets an address without carrying a consent record. Apply refuses such a
 * plan without the organiser's attestation, and the preview reports this
 * count so the portal shows the attestation box.
 */
export function emailsNeedingAttestation(plan: Pick<ImportPlan, "emailWrites">): number {
  return (plan.emailWrites ?? []).filter((w) => w.email !== null && w.record === undefined).length;
}

/** The organiser whose attestation stands behind the addresses an apply sets. */
export interface EmailStamp {
  readonly osnProfileId: string;
  /** `ORGANISER_EMAIL_ATTESTATION.version`. */
  readonly version: string;
}

/**
 * A stored event as the diff reads it: `id` for matching and the op lists,
 * `name` for the normalised-name map, and whether the row has each of the
 * texts an update can clear, so the preview can warn when one would go. Flags
 * rather than the text: a description can run to `MAX_CELL_LENGTH`.
 */
interface ExistingEvent {
  readonly id: string;
  readonly name: string;
  readonly hasVenueName?: boolean;
  readonly hasDescription?: boolean;
  readonly hasGettingThere?: boolean;
  readonly hasChildrenPolicy?: boolean;
  readonly hasPlusOnePolicy?: boolean;
  readonly hasGuestPolicyNote?: boolean;
  /** The stored run of show as {@link runOfShowColumn} reads it, or null when
   *  the diff did not read it. */
  readonly runOfShow?: string | null;
  /** When it starts and on which clock, so a task linked to it can keep the
   *  time it last had if the change removes it. */
  readonly startAt?: string;
  readonly timezone?: string;
}

/** "a", "a and b", "a, b and c". */
function listed(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The warning for an update that clears what the stored event has, or null.
 * A sheet whose Location or Description cell is blank clears on purpose
 * (`sheetText` in `services/spreadsheet.ts`), but a download made before the
 * venue name existed has a Location column that is always blank, and
 * re-uploading one would otherwise clear every venue name set since unseen.
 * The run of show, getting-there notes and guest policy follow the same rule,
 * so a clear of any of them is named too. `storedRunOfShow` is the event's
 * list as stored (empty when it has none).
 */
function clearWarning(
  existing: ExistingEvent,
  parsed: ParsedEvent,
  storedRunOfShow: readonly RunOfShowItem[],
): string | null {
  const lost = [
    existing.hasVenueName === true && parsed.venueName === null ? "venue name" : null,
    existing.hasDescription === true && parsed.description === "" ? "description" : null,
    storedRunOfShow.length > 0 && parsed.runOfShow?.length === 0 ? "run of show" : null,
    existing.hasGettingThere === true && parsed.gettingThere === null
      ? "getting-there notes"
      : null,
    existing.hasChildrenPolicy === true && parsed.childrenPolicy === null
      ? "children policy"
      : null,
    existing.hasPlusOnePolicy === true && parsed.plusOnePolicy === null ? "plus-one policy" : null,
    existing.hasGuestPolicyNote === true && parsed.guestPolicyNote === null
      ? "guest policy note"
      : null,
  ].filter((field) => field !== null);
  return lost.length === 0 ? null : `Event "${parsed.name}" would lose its ${listed(lost)}.`;
}

/**
 * The event as an update writes it: without `runOfShow` when the list it
 * states is the one stored, so apply leaves that list alone. Every events
 * editor save states every event's list, and rewriting each unchanged one
 * would cost a delete and an insert per event on every save.
 */
function withoutUnchangedRunOfShow(
  parsed: ParsedEvent,
  stored: readonly RunOfShowItem[],
): ParsedEvent {
  if (parsed.runOfShow === undefined || !sameRunOfShow(parsed.runOfShow, stored)) return parsed;
  const { runOfShow: _unchanged, ...rest } = parsed;
  return rest;
}

export function diffAgainstDb(
  parsedEvents: readonly ParsedEvent[],
  parsedFamilies: readonly DesiredFamily[],
  weddingId: string,
  options: DiffOptions = {},
): Effect.Effect<ImportPlan, StaleDesiredState, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    // Default: manage only import-created rows (leave hand-added rows intact).
    const removeManual = options.removeManual ?? false;
    // Default: both halves authoritative (the two-sheet import / editor save).
    const scope = options.scope ?? "both";
    // Default: an id-less row may still match by name (the CSV import's only
    // matching rule). The editor front door turns this off — see DiffOptions.
    const matchByName = options.matchByName ?? true;
    /**
     * Desired rows that named an id resolving to nothing. Only meaningful on the
     * id-authoritative path: a CSV's dangling id is expected (it falls through to
     * name matching by design), but the editor's is proof the draft is stale, and
     * with no name fallback the row would reconcile as a destructive remove+create
     * rather than an update. Counted here, refused below — see {@link StaleDesiredState}.
     */
    let unresolvedIds = 0;
    const manageEvents = scope !== "guests";
    const manageGuests = scope !== "events";

    // The wedding's claim-code style drives every NEW family code minted by
    // this import, and its plan tier sets the guest cap the preview warns
    // against — both on the one row, read once. Default to `secure` if the row
    // is somehow absent (defensive — `weddingId` is always a real, owned
    // wedding here). Skipped entirely when the guest half isn't managed: its
    // consumers are `generateFamilyCode` in the familyCreates loop and the cap
    // check on `guestCreates`, and both are provably empty under
    // `scope: "events"` (`desiredFamilies` is `[]` by construction).
    const [weddingRow] = manageGuests
      ? yield* dbQuery(() =>
          db
            .select({ codeStyle: weddings.codeStyle, tier: weddings.tier })
            .from(weddings)
            .where(eq(weddings.id, weddingId))
            .all(),
        )
      : [];
    const codeStyle: CodeStyle = weddingRow?.codeStyle ?? "secure";

    // ── Events ──────────────────────────────────────────────────────────────
    // Projected to what the diff reads ({@link ExistingEvent}). The guests-only
    // branch below exists purely to build the name → id map, so dragging full
    // event rows — descriptions, palettes, URLs — across the D1 wire to do it is
    // pure waste.
    // Each event's stored run of show rides the same read, and only when the
    // change states a run of show for some event: an update's list is compared
    // with its event's, so an unchanged one is not rewritten, and an emptied
    // one is warned about.
    const statesRunOfShow = manageEvents && parsedEvents.some((e) => e.runOfShow !== undefined);
    const existingEvents: readonly ExistingEvent[] = options.existingEvents
      ? options.existingEvents
      : yield* dbQuery(() =>
          db
            .select({
              id: events.id,
              name: events.name,
              hasVenueName: sql<boolean>`${events.venueName} IS NOT NULL`.mapWith(Boolean),
              hasDescription: sql<boolean>`${events.description} <> ''`.mapWith(Boolean),
              hasGettingThere: sql<boolean>`${events.gettingThere} IS NOT NULL`.mapWith(Boolean),
              hasChildrenPolicy: sql<boolean>`${events.childrenPolicy} IS NOT NULL`.mapWith(
                Boolean,
              ),
              hasPlusOnePolicy: sql<boolean>`${events.plusOnePolicy} IS NOT NULL`.mapWith(Boolean),
              hasGuestPolicyNote: sql<boolean>`${events.guestPolicyNote} IS NOT NULL`.mapWith(
                Boolean,
              ),
              runOfShow: statesRunOfShow ? runOfShowColumn : sql<string | null>`NULL`,
              startAt: events.startAt,
              timezone: events.timezone,
            })
            .from(events)
            .where(eq(events.weddingId, weddingId))
            .all(),
        );
    const existingEventByNorm = new Map(existingEvents.map((e) => [normaliseName(e.name), e]));
    const existingEventById = new Map(existingEvents.map((e) => [e.id, e]));

    const eventCreates: EventCreate[] = [];
    const eventUpdates: EventUpdate[] = [];
    const eventRemoves: EventRemove[] = [];
    /** Map normalised event name → resolved event id (for guest-event links). */
    const eventIdByNorm = new Map<string, string>();
    /** Existing event ids consumed by a match (by id or name) — everything else
     *  is a removal. Replaces the name-only "is it in the parsed set?" scan so
     *  an id-matched RENAME doesn't also read as a remove of the old name. When
     *  no parsed event carries an id this set holds exactly the name-matched ids,
     *  so the removal list is identical to the pre-E2 name-only diff. */
    const matchedEventIds = new Set<string>();
    /** One line per updated event that would lose its venue name or description. */
    const clearWarnings: string[] = [];

    if (manageEvents) {
      for (const parsed of parsedEvents) {
        const norm = normaliseName(parsed.name);
        // Prefer id match (rename-safe); fall back to name; else create. An
        // existing row is claimed at most once — two desired events resolving to
        // the same row would emit two updates for it and, worse, leave the second
        // one's identity unrepresented.
        const byId = parsed.id !== undefined ? existingEventById.get(parsed.id) : undefined;
        if (parsed.id !== undefined && !byId) unresolvedIds += 1;
        const candidate = byId ?? (matchByName ? existingEventByNorm.get(norm) : undefined);
        const existing = candidate && !matchedEventIds.has(candidate.id) ? candidate : undefined;
        if (existing) {
          const stored = runOfShowFrom(existing.runOfShow);
          eventUpdates.push({ id: existing.id, event: withoutUnchangedRunOfShow(parsed, stored) });
          eventIdByNorm.set(norm, existing.id);
          matchedEventIds.add(existing.id);
          const cleared = clearWarning(existing, parsed, stored);
          if (cleared) clearWarnings.push(cleared);
        } else {
          const id = crypto.randomUUID();
          eventCreates.push({ id, event: parsed });
          eventIdByNorm.set(norm, id);
        }
      }
      for (const existing of existingEvents) {
        // No-id path: `matchedEventIds` == the set whose normalised name is in the
        // parsed sheet, so this is byte-identical to the old `parsedEventByNorm`
        // check. Id path: a renamed event is matched by id, so it is NOT removed.
        if (!matchedEventIds.has(existing.id)) {
          eventRemoves.push({ id: existing.id, name: existing.name });
        }
      }
    } else {
      // GUESTS-ONLY upload: the schedule is not part of this change, so emit no
      // event create/update/remove at all — not even a no-op update (which would
      // bump `updated_at` and re-resolve every Pinterest link at apply time).
      // The name → id map is still needed: the guest sheet's attendance columns
      // resolve through it against the events that already exist.
      for (const existing of existingEvents) {
        eventIdByNorm.set(normaliseName(existing.name), existing.id);
        matchedEventIds.add(existing.id);
      }
      // On the id-authoritative door the desired events are the ones the draft
      // was loaded with, and its attendance names them by the names they had
      // then. An event since deleted, or renamed, would leave those names
      // resolving to nothing (or to another event) below — dropping or moving
      // invitations the organiser never touched — so it marks the draft stale.
      if (!matchByName) {
        for (const parsed of parsedEvents) {
          if (parsed.id === undefined) continue;
          const live = existingEventById.get(parsed.id);
          if (!live || normaliseName(live.name) !== normaliseName(parsed.name)) unresolvedIds += 1;
        }
      }
    }

    // ── Tasks linked to a removed event ────────────────────────────────────
    // A checklist task linked to an event this change removes is listed, with
    // the time it would keep: the event's start moved by its offset, on the
    // event's clock. Read at preview (the organiser chooses which to remove
    // with the event) and again at apply, where the times are what the freeze
    // writes. Only when the change removes an event.
    const linkedTasks: LinkedTask[] = [];
    if (eventRemoves.length > 0) {
      const linkedRows = yield* dbQuery(() =>
        db
          .select({
            id: tasks.id,
            title: tasks.title,
            eventId: tasks.eventId,
            offsetMinutes: tasks.runOffsetMinutes,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.weddingId, weddingId),
              inArray(tasks.eventId, jsonEachIn(eventRemoves.map((e) => e.id))),
            ),
          )
          .orderBy(asc(tasks.eventId), asc(tasks.sortOrder), asc(tasks.id))
          .all(),
      );
      for (const linked of linkedRows) {
        const eventId = linked.eventId!;
        const event = existingEventById.get(eventId);
        const frozenRunAt =
          event?.startAt !== undefined &&
          event.timezone !== undefined &&
          linked.offsetMinutes !== null
            ? anchoredRunAt(event.startAt, event.timezone, linked.offsetMinutes)
            : null;
        linkedTasks.push({
          id: linked.id,
          title: linked.title,
          eventId,
          offsetMinutes: linked.offsetMinutes,
          frozenRunAt,
          frozenTimezone: frozenRunAt === null ? null : event!.timezone!,
        });
      }
    }

    // ── Families ────────────────────────────────────────────────────────────
    // EVENTS-ONLY upload: households, guests and attendance links are not part
    // of this change. Both sides of the guest diff are emptied — the desired
    // side here, the existing side by skipping the three reads below — so every
    // guest-shaped op list falls out empty by construction rather than by a
    // scattering of `if (manageGuests)` guards. Skipping the reads is also three
    // fewer D1 round-trips on a schedule-only upload.
    const desiredFamilies = manageGuests ? parsedFamilies : [];

    // Host preview families (kind = 'host') are synthetic and CSV-invisible:
    // they are never in the parsed sheet, so a naive scan would mark them — and
    // their event links — for removal on every re-import. Excluding them here
    // (and from the guest + link scans below) makes imports leave them intact.
    const existingFamilies = manageGuests
      ? yield* dbQuery(() =>
          db
            .select()
            .from(families)
            .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
            .all(),
        )
      : [];
    const existingFamilyByNorm = new Map(
      existingFamilies.map((f) => [normaliseName(f.familyName), f]),
    );
    const existingFamilyById = new Map(existingFamilies.map((f) => [f.id, f]));

    const familyCreates: FamilyCreate[] = [];
    const familyUpdates: FamilyUpdate[] = [];
    const familyRemoves: FamilyRemove[] = [];

    /** Resolved family id per parsed family, in parsedFamilies order — the guest
     *  + link passes below re-resolve the same family, and an id-matched RENAME
     *  changes the family's normalised name so a name-keyed lookup would miss.
     *  Keying by array index is rename-stable. */
    const familyIdByParsedIndex: string[] = [];
    /** Existing family ids consumed by a match (by id or name). Same role as
     *  `matchedEventIds`: with no ids present it equals the name-matched set, so
     *  the removal list stays byte-identical to the pre-E2 diff. */
    const matchedFamilyIds = new Set<string>();

    desiredFamilies.forEach((parsed, i) => {
      const norm = normaliseName(parsed.familyName);
      // Same claim-once rule as events: without it, two desired households that
      // resolve to ONE existing row both reconcile against that row's guest list
      // in turn, and the second pass removes every guest the first pass matched.
      const byId = parsed.id !== undefined ? existingFamilyById.get(parsed.id) : undefined;
      if (parsed.id !== undefined && !byId) unresolvedIds += 1;
      const candidate = byId ?? (matchByName ? existingFamilyByNorm.get(norm) : undefined);
      const existing = candidate && !matchedFamilyIds.has(candidate.id) ? candidate : undefined;
      if (existing) {
        familyIdByParsedIndex[i] = existing.id;
        matchedFamilyIds.add(existing.id);
        // A name change is only meaningful on the id-matched path — a name
        // match means the name is unchanged by definition (modulo the case/
        // whitespace folding the norm applies), and never writing it keeps the
        // no-id plan byte-identical to the historical diff. On the id-matched
        // path a genuine household rename becomes an in-place update; without
        // this op the rename was silently dropped (the match consumed the row
        // and nothing wrote the new name — the editor's "household name won't
        // save" bug).
        if (existing === byId && existing.familyName !== parsed.familyName) {
          familyUpdates.push({ id: existing.id, familyName: parsed.familyName });
        }
      } else {
        const id = crypto.randomUUID();
        familyCreates.push({
          id,
          // Preserve the sheet's claim code when a full-fidelity round trip
          // carries one; else mint per the wedding's code style (unchanged).
          publicId: parsed.publicId ?? generateFamilyCode(parsed.familyName, codeStyle),
          familyName: parsed.familyName,
          source: options.createSource ?? parsed.source ?? "import",
        });
        familyIdByParsedIndex[i] = id;
      }
    });
    for (const existing of existingFamilies) {
      if (matchedFamilyIds.has(existing.id)) continue;
      // Provenance default: an unmatched MANUAL household is preserved unless the
      // caller opted to manage manual rows too (the toggle / editor front door).
      if (!removeManual && existing.source === "manual") continue;
      familyRemoves.push({ id: existing.id, familyName: existing.familyName });
    }

    // ── Guests ──────────────────────────────────────────────────────────────
    const removedFamilyIds = new Set(familyRemoves.map((f) => f.id));
    // Wedding-scoped via the families join — guests carry no wedding_id.
    const existingGuestRows = manageGuests
      ? yield* dbQuery(() =>
          db
            .select({
              id: guests.id,
              familyId: guests.familyId,
              firstName: guests.firstName,
              lastName: guests.lastName,
              nickname: guests.nickname,
              sortOrder: guests.sortOrder,
              source: guests.source,
              plusOneOf: guests.plusOneOfGuestId,
              email: guests.email,
              emailSource: guests.emailSource,
            })
            .from(guests)
            .innerJoin(families, eq(guests.familyId, families.id))
            .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
            .all(),
        )
      : [];
    // PLUS-ONES ([[cire-plus-ones]]) are the household's data, not the
    // organiser's sheet: this diff never matches, updates or removes one on
    // its own account. They follow their inviter instead — removed with them,
    // and invited to whatever the inviter ends up invited to (below). So the
    // matching passes see only the organiser's guests.
    const existingGuests = existingGuestRows.filter((g) => g.plusOneOf === null);
    const existingPlusOnes = existingGuestRows.filter(
      (g): g is typeof g & { plusOneOf: string } => g.plusOneOf !== null,
    );
    // A desired row that names a plus-one's id is dropped before matching. The
    // organiser editor leaves plus-ones out of its drafts, so this is the
    // backstop for a client that does not: without it the id would resolve to
    // no organiser guest, and the save would be refused as stale.
    const plusOneIds = new Set(existingPlusOnes.map((p) => p.id));
    const guestFamilies =
      plusOneIds.size === 0
        ? desiredFamilies
        : desiredFamilies.map((family) =>
            family.guests.some((g) => g.id !== undefined && plusOneIds.has(g.id))
              ? {
                  ...family,
                  guests: family.guests.filter((g) => g.id === undefined || !plusOneIds.has(g.id)),
                }
              : family,
          );

    type ExistingGuest = (typeof existingGuests)[number];
    /**
     * Per-family LIST of existing guests, in DB order.
     *
     * Deliberately a list and not a `normFirstName → guest` map: two guests in
     * one household can share a normalised first name (a sheet with "Sam" and
     * "sam ", a household of two Guests). A map collapses them, and the removal
     * scan below reads this collection — so a shadowed guest was invisible to
     * the scan and could NEVER be deleted: the editor dropped the row, the diff
     * emitted no `guestRemove`, and the guest reappeared on the next load.
     */
    const guestsByFamily = new Map<string, ExistingGuest[]>();
    /** Global id → existing guest row, for `Guest ID`-keyed matching. */
    const existingGuestById = new Map(existingGuests.map((g) => [g.id, g]));
    for (const g of existingGuests) {
      const list = guestsByFamily.get(g.familyId);
      if (list) list.push(g);
      else guestsByFamily.set(g.familyId, [g]);
    }

    const guestCreates: GuestCreate[] = [];
    const guestUpdates: GuestUpdate[] = [];
    /** Every desired guest beside the row it lands on, for the address pass. */
    const emailCandidates: EmailCandidate[] = [];
    const guestRemoves: GuestRemove[] = [];
    const eventLinkCreates: EventLink[] = [];
    const eventLinkRemoves: EventLink[] = [];

    /**
     * Resolved guest id per parsed (familyIndex, guestIndex) — what the event-link
     * pass below reads. Keyed by POSITION, not by `(familyId, normFirstName)`: two
     * guests in one household can normalise to the same first name, and a
     * name-keyed map gave both of them the same id, so one guest collected both
     * link sets and the other's invitations were diffed away on every save.
     */
    const guestIdByParsedIndex: string[][] = [];

    // Matched + new families
    guestFamilies.forEach((parsedFamily, familyIndex) => {
      const familyId = familyIdByParsedIndex[familyIndex]!;
      // A family is "new" iff it was NOT matched to an existing row. With no ids
      // this equals `!existingFamilyByNorm.has(norm)` (byte-identical); with ids
      // a renamed family stays existing so its guests reconcile in place.
      const isNewFamily = !matchedFamilyIds.has(familyId);
      const existingList = isNewFamily ? [] : (guestsByFamily.get(familyId) ?? []);
      const resolvedIds: string[] = [];
      guestIdByParsedIndex[familyIndex] = resolvedIds;

      /** Existing guest ids in THIS family consumed by a match — unmatched ones
       *  are removals. Replaces the `seenFirstNames` scan so an id-matched guest
       *  RENAME (old first name absent) isn't also flagged for removal. On the
       *  no-id path with distinct first names (the ordinary sheet) this set is
       *  exactly the name-matched set, so removals are what they always were. */
      const matchedGuestIds = new Set<string>();

      /** normFirstName → the household's existing guests with that name, in DB
       *  order. A QUEUE, not a single row: duplicates within a household are
       *  legal, and each parsed row must consume a DIFFERENT existing guest so a
       *  re-import of a duplicate roster reconciles in place instead of matching
       *  both rows to one row and orphaning the other. */
      const byFirstName = new Map<string, ExistingGuest[]>();
      for (const g of existingList) {
        const key = normaliseName(g.firstName);
        const queue = byFirstName.get(key);
        if (queue) queue.push(g);
        else byFirstName.set(key, [g]);
      }
      const takeByName = (firstName: string): ExistingGuest | undefined => {
        const queue = byFirstName.get(normaliseName(firstName)) ?? [];
        while (queue.length > 0) {
          const candidate = queue.shift()!;
          // Skip one already consumed by an id match in pass 1.
          if (!matchedGuestIds.has(candidate.id)) return candidate;
        }
        return undefined;
      };

      const matched: (ExistingGuest | undefined)[] = [];
      const matchedById: boolean[] = [];

      // Pass 1 — stable ids. Resolved FIRST across the whole household, so a
      // name match can never consume a row that a later parsed guest owns by id.
      // The id must belong to THIS family (a stray cross-family id falls through
      // to the name pass), and each existing row is claimed at most once.
      parsedFamily.guests.forEach((parsedGuest, i) => {
        if (parsedGuest.id === undefined) return;
        const candidate = existingGuestById.get(parsedGuest.id);
        // Gone, or in someone else's household (the editor has no move-guest
        // affordance, so a cross-family id is as stale as a missing one).
        if (!candidate || candidate.familyId !== familyId) {
          unresolvedIds += 1;
          return;
        }
        if (matchedGuestIds.has(candidate.id)) return;
        matched[i] = candidate;
        matchedById[i] = true;
        matchedGuestIds.add(candidate.id);
      });

      // Pass 2 — name fallback for whatever is left. SKIPPED for an
      // id-authoritative front door (the editor): there an absent id means "this
      // row is new", so adopting a same-named existing row would silently cancel
      // the deletion of the row the organiser dropped — and hand the new guest
      // the old one's RSVPs.
      if (matchByName) {
        parsedFamily.guests.forEach((parsedGuest, i) => {
          if (matched[i]) return;
          const existing = takeByName(parsedGuest.firstName);
          if (!existing) return;
          matched[i] = existing;
          matchedGuestIds.add(existing.id);
        });
      }

      // Pass 3 — emit ops in parsed order (parsed index ⇒ `sortOrder`).
      parsedFamily.guests.forEach((parsedGuest, sortOrder) => {
        const existing = matched[sortOrder];
        if (existing) {
          resolvedIds[sortOrder] = existing.id;
          // A first-name change is only meaningful on the id-matched path — a
          // name match means the first name is unchanged by definition, so we
          // never write `firstName` through there (keeps the no-id plan
          // byte-identical, incl. case-only differences that name matching
          // already folds together). On the id-matched path a genuine rename
          // becomes an update carrying the new firstName.
          const firstNameChanged =
            matchedById[sortOrder] === true && existing.firstName !== parsedGuest.firstName;
          if (
            firstNameChanged ||
            existing.lastName !== parsedGuest.lastName ||
            existing.nickname !== parsedGuest.nickname ||
            existing.sortOrder !== sortOrder
          ) {
            const update: Types.Mutable<GuestUpdate> = {
              id: existing.id,
              lastName: parsedGuest.lastName,
              nickname: parsedGuest.nickname,
              sortOrder,
            };
            if (firstNameChanged) update.firstName = parsedGuest.firstName;
            guestUpdates.push(update);
          }
          emailCandidates.push({
            guestId: existing.id,
            stored: existing.email,
            storedSource: existing.emailSource,
            desired: parsedGuest,
          });
        } else {
          const id = crypto.randomUUID();
          guestCreates.push({
            id,
            familyId,
            firstName: parsedGuest.firstName,
            lastName: parsedGuest.lastName,
            nickname: parsedGuest.nickname,
            sortOrder,
            source: options.createSource ?? parsedGuest.source ?? "import",
          });
          resolvedIds[sortOrder] = id;
          emailCandidates.push({
            guestId: id,
            stored: null,
            storedSource: null,
            desired: parsedGuest,
          });
        }
      });

      // Existing guests in this family not matched → remove (an id-less
      // first-name change is a remove + create at this layer, as before). Scans
      // the household's full guest LIST, so a guest whose first name collides
      // with a sibling's is a removal candidate like any other.
      if (!isNewFamily) {
        for (const existing of existingList) {
          if (matchedGuestIds.has(existing.id)) continue;
          // Provenance default: a manually-added guest absent from the sheet is
          // preserved (unless the toggle / editor front door manages manual too).
          if (!removeManual && existing.source === "manual") continue;
          guestRemoves.push({ id: existing.id, firstName: existing.firstName });
        }
      }
    });

    // Guests in removed families → also removed.
    for (const g of existingGuests) {
      if (removedFamilyIds.has(g.familyId)) {
        guestRemoves.push({ id: g.id, firstName: g.firstName });
      }
    }

    // A removed guest's plus-one goes with them. The foreign key would cascade
    // it anyway; naming it here puts it in the preview's counts and RSVP-loss
    // warnings, and in the capacity arithmetic below. Only this loop adds
    // plus-ones, once each.
    const plusOneWarnings: string[] = [];
    const removingGuestIds = new Set(guestRemoves.map((g) => g.id));
    const inviterFirstName = new Map(existingGuests.map((g) => [g.id, g.firstName]));
    for (const plusOne of existingPlusOnes) {
      if (!removingGuestIds.has(plusOne.plusOneOf) || removingGuestIds.has(plusOne.id)) continue;
      guestRemoves.push({ id: plusOne.id, firstName: plusOne.firstName, cascaded: true });
      removingGuestIds.add(plusOne.id);
      plusOneWarnings.push(
        `Removing guest ${inviterFirstName.get(plusOne.plusOneOf) ?? "(unknown)"} also removes their plus-one ${plusOne.firstName}.`,
      );
    }

    // ── Stale-draft refusal (id-authoritative front doors only) ──────────────
    // Every id in the desired state has now been looked up. On the editor path a
    // miss means the draft was built against state that no longer exists, and
    // because that path has no name fallback the miss would reconcile as a
    // destructive remove+create rather than an update — see StaleDesiredState.
    // Refused BEFORE the link/RSVP/tier reads below: nothing downstream
    // can make the plan safe, so they would be work spent on a plan we discard.
    //
    // Attendance names count too. The link pass skips a name that resolves to
    // no event and then removes the guest's existing invitation to it; on this
    // door every name comes from the draft's own event list, so one that
    // resolves to nothing is stale, not a column to ignore.
    if (!matchByName) {
      for (const family of guestFamilies) {
        for (const guest of family.guests) {
          for (const name of guest.eventNames) {
            if (!eventIdByNorm.has(normaliseName(name))) unresolvedIds += 1;
          }
        }
      }
    }
    if (!matchByName && unresolvedIds > 0) {
      return yield* Effect.fail(new StaleDesiredState({ unresolved: unresolvedIds }));
    }

    // ── Event links ─────────────────────────────────────────────────────────
    // Wedding-scoped via guests → families — guest_events carries no wedding_id,
    // so without this join a second wedding's links read as removals.
    const existingLinks = manageGuests
      ? yield* dbQuery(() =>
          db
            .select({ guestId: guestEvents.guestId, eventId: guestEvents.eventId })
            .from(guestEvents)
            .innerJoin(guests, eq(guestEvents.guestId, guests.id))
            .innerJoin(families, eq(guests.familyId, families.id))
            .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
            .all(),
        )
      : [];
    const existingLinkSet = new Set(existingLinks.map((l) => `${l.guestId}::${l.eventId}`));
    /** Track desired (guestId, eventId) pairs after import. */
    const desiredLinks = new Set<string>();
    /** Desired event ids per guest — what each plus-one mirrors below. */
    const desiredEventsByGuest = new Map<string, string[]>();

    guestFamilies.forEach((parsedFamily, familyIndex) => {
      const resolvedIds = guestIdByParsedIndex[familyIndex]!;
      parsedFamily.guests.forEach((parsedGuest, guestIndex) => {
        const guestId = resolvedIds[guestIndex]!;
        for (const eventName of parsedGuest.eventNames) {
          const eventId = eventIdByNorm.get(normaliseName(eventName));
          if (!eventId) continue; // already validated upstream
          const key = `${guestId}::${eventId}`;
          desiredLinks.add(key);
          if (!existingLinkSet.has(key)) {
            eventLinkCreates.push({ guestId, eventId });
          }
          const list = desiredEventsByGuest.get(guestId);
          if (list) list.push(eventId);
          else desiredEventsByGuest.set(guestId, [eventId]);
        }
      });
    });

    // A plus-one is invited to exactly what their inviter is invited to after
    // this change: their inviter's desired events are theirs, and any other
    // invitation they hold falls to the removal scan below. An inviter this
    // change does not describe (kept by the provenance rule) has no desired
    // events here, and loses its invitations in the same scan, so the plus-one
    // still mirrors it.
    for (const plusOne of existingPlusOnes) {
      if (removingGuestIds.has(plusOne.id)) continue;
      for (const eventId of desiredEventsByGuest.get(plusOne.plusOneOf) ?? []) {
        const key = `${plusOne.id}::${eventId}`;
        if (desiredLinks.has(key)) continue;
        desiredLinks.add(key);
        if (!existingLinkSet.has(key)) {
          eventLinkCreates.push({ guestId: plusOne.id, eventId });
        }
      }
    }

    // Existing links whose guest is being removed (or whose event is being
    // removed) are implicitly handled by the cascade DELETE on guests + the
    // explicit event remove. We still emit explicit link-removes for guests
    // whose set of events shrunk between the sheet and DB.
    const removedGuestIds = new Set(guestRemoves.map((g) => g.id));
    const removedEventIds = new Set(eventRemoves.map((e) => e.id));
    for (const link of existingLinks) {
      if (removedGuestIds.has(link.guestId)) continue;
      if (removedEventIds.has(link.eventId)) continue;
      const key = `${link.guestId}::${link.eventId}`;
      if (!desiredLinks.has(key)) {
        eventLinkRemoves.push({ guestId: link.guestId, eventId: link.eventId });
      }
    }

    const { writes: emailWrites, warnings: emailWarnings } = yield* planEmailWrites(
      emailCandidates,
      options.emails ?? "upload",
      weddingId,
    );
    const warnings: string[] = [...clearWarnings, ...plusOneWarnings, ...emailWarnings];

    // ── Claim-code collisions on a CARRIED publicId ──────────────────────────
    // A create may carry its own code (the full-fidelity `Family Code` column, so
    // an export→re-import keeps invites working). Nothing checked that the code
    // was still free, and `families.public_id` is globally unique — so a code
    // belonging to a live household made the INSERT fail mid-apply. That failure
    // is the worst-placed one in the pipeline: applyImport commits in ≤50-statement
    // chunks and stamps the before-image keys in the LAST batch, so a middle-chunk
    // constraint violation leaves the wedding half-written, the change row still
    // `preview`, and no before-image to revert to. Resolved here instead, where
    // the organiser sees it in the preview: a taken code is dropped for a freshly
    // minted one (a household with no working code is not an option — the code IS
    // the invite), and the swap is called out as a warning. Codes freed by this
    // same plan's removals stay reusable, which is what makes an export→delete→
    // re-import round trip keep its codes.
    const carriedCodes = familyCreates
      .map((f, i) => ({ i, publicId: f.publicId }))
      .filter((f) => desiredFamilies.some((d) => d.publicId === f.publicId));
    if (carriedCodes.length > 0) {
      const taken = yield* dbQuery(() =>
        db
          .select({ id: families.id, publicId: families.publicId })
          .from(families)
          .where(inArray(families.publicId, jsonEachIn(carriedCodes.map((c) => c.publicId))))
          .all(),
      );
      // Wedding-scope is deliberately NOT applied: the unique index is global, so
      // another wedding's live code collides just as hard as this one's.
      const liveCodes = new Set(
        taken.filter((t) => !removedFamilyIds.has(t.id)).map((t) => t.publicId),
      );
      for (const c of carriedCodes) {
        if (!liveCodes.has(c.publicId)) continue;
        const create = familyCreates[c.i]!;
        familyCreates[c.i] = {
          ...create,
          publicId: generateFamilyCode(create.familyName, codeStyle),
        };
        warnings.push(
          `Household "${create.familyName}" asked for an invite code that is already in use, so a new code was minted for it.`,
        );
      }
    }

    // ── Warnings: RSVPs and seats this change loses ─────────────────────────
    // A removed or renamed guest loses their RSVPs. A removed guest,
    // invitation or event takes its seats with it (and an event its tables),
    // and the before-image a revert restores holds no seating. Neither read
    // depends on the other, so they run together; only the preview asks.
    if (options.warnings ?? true) {
      const guestsBeingLost = guestRemoves.map((g) => ({ id: g.id, firstName: g.firstName }));
      const [rsvpRows, loss] = yield* Effect.all(
        [
          guestsBeingLost.length > 0
            ? // The ids ride as ONE bound parameter (`json_each`): D1 allows
              // 100 per statement, and a change that removes households with
              // plus-ones lists two guests for each inviter.
              dbQuery(() =>
                db
                  .select()
                  .from(rsvps)
                  .where(inArray(rsvps.guestId, jsonEachIn(guestsBeingLost.map((g) => g.id))))
                  .all(),
              )
            : Effect.succeed([]),
          seatingLoss(weddingId, {
            guestIds: guestRemoves.map((g) => g.id),
            eventIds: eventRemoves.map((e) => e.id),
            links: eventLinkRemoves,
          }),
        ],
        { concurrency: "unbounded" },
      );
      const lostFirst = new Map(guestsBeingLost.map((g) => [g.id, g.firstName]));
      // Every row here is an explicit response — `rsvps.status` is a required
      // enum of attending/declined/maybe; "no response yet" is the absence of a
      // row, never a stored "pending" status. So every fetched row is meaningful
      // by definition (the previous `status !== "pending"` check was always true).
      for (const r of rsvpRows) {
        const firstName = lostFirst.get(r.guestId) ?? "(unknown)";
        warnings.push(
          `Removing guest ${firstName} would lose their RSVP: status=${r.status}, dietary=${formatDietaryCell(parsePresets(r.dietaryPresets ?? ""), r.dietary ?? "")}`,
        );
      }
      const seatingWarning = seatingLossWarning(loss);
      if (seatingWarning) warnings.push(seatingWarning);
    }

    // ── Capacity preview warning (non-blocking) ──────────────────────────────
    // Warn early when this plan would breach the tier's cap. applyImport
    // enforces it, before the write and inside it — this warning lets the
    // preview UI surface the issue before the organiser commits. Host-preview
    // families are excluded from the current-guest count (same join +
    // ne(kind,'host') as tierService).
    //
    // `derivedCap` rides on the returned plan so `applyImport` doesn't read the
    // SAME tier a second time in the SAME request — see `applyImport`'s call to
    // `assertGuestCapacity`. It's set ONLY when the plan can pass the floor; the
    // pre-check branch proves the cap can't matter, so it leaves `derivedCap`
    // unset and `applyImport` falls back to its own read — correct either way,
    // per `assertGuestCapacity`'s "never a way to skip the check" contract.
    let derivedCap: number | undefined;
    if (guestCreates.length > 0) {
      // `existingGuestRows` was already fetched above with ne(families.kind,
      // 'host'), so it already excludes host-preview guests — and it includes
      // plus-ones, which hold places under the cap like any guest (the apply's
      // `countGuests` counts them too). The resulting headcount after this
      // plan: current real guests minus removals plus new creates.
      const currentRealGuests = existingGuestRows.length;
      const resulting = currentRealGuests - guestRemoves.length + guestCreates.length;
      // `resulting` can only rise as far as `currentRealGuests +
      // guestCreates.length` (removes only ever bring it DOWN), and the cap can
      // never fall below `BASE_GUEST_CAP` — so once that upper bound sits at or
      // under the floor, no tier could make this breach, and the cap is left
      // for `applyImport` to settle rather than computed for nothing.
      if (currentRealGuests + guestCreates.length > BASE_GUEST_CAP) {
        derivedCap = capForTier(normaliseTier(weddingRow?.tier));
        if (resulting > derivedCap) {
          warnings.push(
            `This import brings you to ${resulting} guests; your plan is capped at ${derivedCap}. Upgrade to add more.`,
          );
        }
      }
    }

    return {
      eventCreates,
      eventUpdates,
      eventRemoves,
      familyCreates,
      familyUpdates,
      familyRemoves,
      guestCreates,
      guestUpdates,
      guestRemoves,
      eventLinkCreates,
      eventLinkRemoves,
      emailWrites,
      warnings,
      linkedTasks: linkedTasks.length > 0 ? linkedTasks : undefined,
      derivedCap,
    };
  }).pipe(Effect.withSpan("cire.import.diff"));
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Commit the import write set, built in FK-dependency order as GROUPS of
 * statements that must commit together.
 *  - D1 (production): `commitGroupedBatches` — atomic `db.batch([...])` calls
 *    of at most `MAX_STATEMENTS_PER_BATCH` (50: D1 Free counts every statement
 *    of a batch as one of the invocation's 50 queries) — one Workers↔D1
 *    round-trip per chunk, all-or-nothing *within* a chunk, and a group never
 *    split across two. Every statement is its own group but these: the removed
 *    events' checklist-task writes and their deletes (at most six statements
 *    for any number of events), so a task is never unlinked from an event that
 *    survives, nor its event gone while it still names it; and the caller's
 *    `finalize` statements.
 *  - bun:sqlite (tests/local): awaited sequentially in the same order
 *    (bun:sqlite exposes no `.batch()`; awaiting a Drizzle builder executes it).
 *
 * INVARIANT (dependency ordering): splitting the one ordered list into
 * in-order, sequentially-awaited chunks preserves that order — a later chunk is
 * dispatched only after the earlier one has committed — so a chunk boundary can
 * never make a child run before its parent.
 *
 * ATOMICITY TRADEOFF: D1 `batch()` is atomic per call but NOT across calls, and
 * D1 has no multi-batch transaction primitive. So a failure mid-import (after
 * chunk k commits, before chunk k+1) can leave a PARTIAL apply. This is the
 * accepted design: `services/revert.ts` re-diffs the prior import's CSVs
 * against current DB state and re-applies, which reconciles a partial apply
 * just as it reconciles a fully-applied one. Chunks stay small and the whole
 * import is well under the 30s wall-clock, so the window is narrow.
 */
function commitWriteSet(db: Db, groups: BatchItem<"sqlite">[][]): Promise<void> {
  return commitGroupedBatches(db, groups);
}

/** What the apply does with the tasks linked to the events it removes. */
export interface ApplyImportOptions {
  /**
   * The ids of the preview's `linkedTasks` the organiser chose to remove with
   * their events. Only an id still linked to an event this apply removes is
   * removed; absent keeps every linked task.
   */
  readonly removeLinkedTasks?: readonly string[];
  /**
   * The organiser's attestation for the addresses this plan sets on their
   * word (`emailsNeedingAttestation`). A plan that sets one without it fails
   * before any write: the route refuses such an apply first, so this is the
   * service's own guard.
   */
  readonly emailStamp?: EmailStamp;
}

/**
 * The one write group for every removed event: the checklist tasks linked to
 * them first, then their RSVPs, invitations and the event rows — at most six
 * statements however many events the change removes, each binding the ids as
 * one JSON parameter.
 *
 *  1. The tasks the organiser chose to remove, still linked to an event this
 *     change removes — a removed seeded task leaves its dismissal, as a delete
 *     from the checklist does, so the starter does not bring it back.
 *  2. Every other task still linked to one is FROZEN: unlinked, at the time
 *     the diff read for its offset (`linkedTasks`), on its event's clock and in
 *     its event's zone, and marked removed. The times ride as one bound JSON
 *     parameter keyed by event and offset. A task linked since the diff read,
 *     at an offset it did not see, keeps no time rather than an offset with no
 *     event.
 *  3. The events' RSVPs, invitations and rows: after the tasks, so no task is
 *     ever left naming an event that is gone.
 */
function removedEventsGroup(
  db: Db,
  weddingId: string,
  eventIds: readonly string[],
  linked: readonly LinkedTask[],
  removing: ReadonlySet<string>,
  now: Date,
): BatchItem<"sqlite">[] {
  const group: BatchItem<"sqlite">[] = [];
  const removed = jsonEachIn(eventIds);
  const chosen = linked.filter((t) => removing.has(t.id)).map((t) => t.id);
  if (chosen.length > 0) {
    const doomed = and(
      eq(tasks.weddingId, weddingId),
      inArray(tasks.eventId, removed),
      inArray(tasks.id, jsonEachIn(chosen)),
    );
    group.push(
      db
        .insert(taskTemplateDismissals)
        .select(
          db
            .select({
              weddingId: tasks.weddingId,
              templateId: sql<string>`${tasks.templateId}`.as("template_id"),
              templateItem: sql<string>`${tasks.templateItem}`.as("template_item"),
              dismissedAt: bound(now, taskTemplateDismissals.dismissedAt),
            })
            .from(tasks)
            .where(and(doomed, isNotNull(tasks.templateId), isNotNull(tasks.templateItem))),
        )
        .onConflictDoNothing(),
      db.delete(tasks).where(doomed),
    );
  }
  const times = JSON.stringify(
    linked
      .filter((t) => t.offsetMinutes !== null && t.frozenRunAt !== null)
      .map((t) => ({ e: t.eventId, o: t.offsetMinutes, r: t.frozenRunAt, z: t.frozenTimezone })),
  );
  // Every SET reads the row as it was, so the lookup sees the old link.
  const frozen = (field: "r" | "z") =>
    sql`(SELECT json_extract(value, ${`$.${field}`}) FROM json_each(${times}) WHERE json_extract(value, '$.e') = ${tasks.eventId} AND json_extract(value, '$.o') = ${tasks.runOffsetMinutes})`;
  group.push(
    db
      .update(tasks)
      .set({
        runAt: frozen("r"),
        runTimezone: frozen("z"),
        eventId: null,
        runOffsetMinutes: null,
        eventRemovedAt: now,
      })
      .where(and(eq(tasks.weddingId, weddingId), inArray(tasks.eventId, removed))),
    db.delete(rsvps).where(inArray(rsvps.eventId, removed)),
    db.delete(guestEvents).where(inArray(guestEvents.eventId, removed)),
    db.delete(events).where(and(inArray(events.id, removed), eq(events.weddingId, weddingId))),
  );
  return group;
}

/**
 * The write set as it is built: its groups in order, and how many statements
 * the D1 batch they are filling holds, packed exactly as
 * {@link commitWriteSet} packs them ({@link startsNewChunk}). So a builder can
 * ask, before it adds a one-statement group, whether that statement will be
 * the last its batch holds.
 */
function writeSet() {
  const groups: BatchItem<"sqlite">[][] = [];
  let fill = 0;
  const add = (group: BatchItem<"sqlite">[]): void => {
    fill = startsNewChunk(fill, group.length) ? group.length : fill + group.length;
    groups.push(group);
  };
  return {
    groups,
    add,
    /** Each statement as a group of its own. */
    push: (...stmts: BatchItem<"sqlite">[]): void => {
      for (const stmt of stmts) add([stmt]);
    },
    /** Whether a one-statement group added now fills its batch, so the group
     *  after it starts the next. */
    nextFillsBatch: (): boolean =>
      (startsNewChunk(fill, 1) ? 1 : fill + 1) === MAX_STATEMENTS_PER_BATCH,
  };
}

/**
 * The database's own words when a guest insert built by {@link insertGuest}
 * found no room under the cap. No other write in the set puts NULL in
 * `guests.family_id`: every planned guest names its household.
 */
const NO_ROOM_FOR_GUEST = "NOT NULL constraint failed: guests.family_id";

/**
 * One planned guest's insert. When `checkCap` is set, the row names its
 * household only while the wedding has room for one more guest under the cap
 * its tier gives it now, counting every guest written before it, the earlier
 * rows of its own batch included. Without room the household is NULL: the NOT
 * NULL column fails the statement and, on D1, rolls back the batch it rides in.
 */
function insertGuest(
  db: Db,
  gc: GuestCreate,
  weddingId: string,
  now: Date,
  checkCap: boolean,
): BatchItem<"sqlite"> {
  return db.insert(guests).values({
    id: gc.id,
    familyId: checkCap
      ? sql`CASE WHEN ${roomForOneMoreGuest(weddingId)} THEN ${gc.familyId} END`
      : gc.familyId,
    firstName: gc.firstName,
    lastName: gc.lastName,
    nickname: gc.nickname,
    sortOrder: gc.sortOrder,
    source: gc.source ?? "import",
    createdAt: now,
    updatedAt: now,
  });
}

export function applyImport(
  importId: string,
  plan: ImportPlan,
  weddingId: string,
  // Statements appended to the END of the write set as one group, so they
  // commit together in its last batch. The apply route passes its
  // `imports` status flip here so "data mutated" and "row marked applied"
  // can't be split by a crash — the window that used to allow a second apply
  // to overwrite the before-image with a post-change snapshot.
  finalize: BatchItem<"sqlite">[] = [],
  options: ApplyImportOptions = {},
): Effect.Effect<ImportSummary, ImportError | CapacityExceeded, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const now = new Date();

    // Resolve every created/updated event's pinterest URL ONCE, here at apply
    // time. `resolvePinUrl` only makes an outbound fetch for `pin.it` short
    // links (SSRF allowlist) and falls back to the original URL on any
    // failure/timeout/non-board result, so this never blocks the import. The
    // canonical `pinterest.com/<user>/<board>/` it yields is what the guest
    // board widget needs to embed (a `pin.it` short link can't be embedded).
    // Done per-event but concurrently-bounded so one slow link can't stall the
    // whole import. Built into a (id → resolved-url) map keyed off the event id
    // so the write-set builder below stays a pure read.
    const resolvedPinByEventId = new Map<string, string | null>();
    yield* Effect.forEach(
      [...plan.eventCreates, ...plan.eventUpdates],
      (e) =>
        Effect.gen(function* () {
          const original = e.event.pinterestUrl;
          if (!original) {
            resolvedPinByEventId.set(e.id, original);
            return;
          }
          const resolved = yield* Effect.promise(() => resolvePinUrl(original));
          resolvedPinByEventId.set(e.id, resolved);
        }),
      { concurrency: 4 },
    );
    const pinFor = (eventId: string, fallback: string | null): string | null =>
      resolvedPinByEventId.has(eventId) ? (resolvedPinByEventId.get(eventId) ?? null) : fallback;

    // Build the write set in FK-dependency order, then commit it as one or more
    // atomic D1 batches (prod) or a sequential bun:sqlite run (tests) — see
    // commitWriteSet. The build order below IS the dependency order the
    // chunker relies on (removes → event/family/guest creates → updates → link
    // removes → link creates). Each statement is its own group but a removed
    // event's, which commits with its tasks.
    const statements = writeSet();
    const { groups, add: addGroup } = statements;

    // 1. event removes. The event_id FKs cascade since migration 0052, but the
    // child deletes stay explicit so this write set does not depend on cascade
    // being enabled on every driver (same stance as the retention sweep). The
    // removed events' seats, then their tables, then their seating plans, go
    // first, once for all of them and across every plan.
    if (plan.eventRemoves.length > 0) {
      const removedEventIds = jsonEachIn(plan.eventRemoves.map((er) => er.id));
      statements.push(
        db.delete(seatingAssignments).where(
          inArray(
            seatingAssignments.eventId,
            db
              .select({ id: events.id })
              .from(events)
              .where(and(inArray(events.id, removedEventIds), eq(events.weddingId, weddingId))),
          ),
        ),
        db
          .delete(seatingTables)
          .where(
            and(
              inArray(seatingTables.eventId, removedEventIds),
              eq(seatingTables.weddingId, weddingId),
            ),
          ),
        // Their runs of show, by the same rule.
        ...runOfShowStatements(
          db,
          weddingId,
          [],
          plan.eventRemoves.map((er) => er.id),
        ),
        db
          .delete(seatingPlans)
          .where(
            and(
              inArray(seatingPlans.eventId, removedEventIds),
              eq(seatingPlans.weddingId, weddingId),
            ),
          ),
      );
    }
    // Then the removed events themselves, as one group with the checklist
    // tasks linked to them (see removedEventsGroup).
    const linkedTasks = plan.linkedTasks ?? [];
    const removing = new Set(options.removeLinkedTasks ?? []);
    if (plan.eventRemoves.length > 0) {
      addGroup(
        removedEventsGroup(
          db,
          weddingId,
          plan.eventRemoves.map((er) => er.id),
          linkedTasks,
          removing,
          now,
        ),
      );
    }

    // Two reads before any write, sent together: neither needs the other.
    //
    // Slugs already taken by this wedding's surviving events, so fresh mints
    // can't collide on the (wedding_id, slug) unique index — within the sheet
    // ("Ceremony" + "Ceremony!") or against events this plan keeps. Skipped
    // when the plan creates no events — the set is only consulted by
    // mintUniqueEventSlug.
    //
    // The capacity check, on the NET change in guests (creates minus
    // removals), for every plan that adds a guest. A refusal here writes
    // nothing. The net figure is what the guarded inserts in step 7 arrive at,
    // since every removal lands before them: a churn import that removes K and
    // adds K at the cap passes, and a wedding already over its cap passes only
    // an import that ends within it. So step 7 refuses only when another
    // writer took a place after this check. `plan.derivedCap` — set by
    // `diffAgainstDb` in the SAME request when its own preview warning already
    // read the tier — lets this skip a second read of the same row. Absent (the
    // pre-check branch that proved the cap couldn't matter without learning it,
    // or any other caller of `applyImport`), `assertGuestCapacity` runs its own
    // query — a missing cap is never a reason to skip the check. Step 7 reads
    // the tier itself.
    const removedEventIds = new Set(plan.eventRemoves.map((er) => er.id));
    const netGuestDelta = plan.guestCreates.length - plan.guestRemoves.length;
    const [existingSlugRows] = yield* Effect.all(
      [
        plan.eventCreates.length > 0
          ? dbQuery(() =>
              db
                .select({ id: events.id, slug: events.slug })
                .from(events)
                .where(eq(events.weddingId, weddingId))
                .all(),
            )
          : Effect.succeed([]),
        plan.guestCreates.length > 0
          ? tierService.assertGuestCapacity(weddingId, netGuestDelta, plan.derivedCap)
          : Effect.void,
      ],
      { concurrency: "unbounded" },
    );
    const usedSlugs = new Set(
      existingSlugRows.filter((r) => !removedEventIds.has(r.id)).map((r) => r.slug),
    );

    // 2. event creates
    for (const ec of plan.eventCreates) {
      statements.push(
        db.insert(events).values({
          id: ec.id,
          weddingId,
          slug: mintUniqueEventSlug(ec.event.name, usedSlugs),
          name: ec.event.name,
          // Absent (a sheet without the column, an older editor) creates the
          // event with neither, as the columns' defaults would.
          description: ec.event.description ?? "",
          startAt: ec.event.startAt,
          endAt: ec.event.endAt,
          timezone: ec.event.timezone,
          venueName: ec.event.venueName ?? null,
          address: ec.event.address,
          gettingThere: ec.event.gettingThere ?? null,
          childrenPolicy: ec.event.childrenPolicy ?? null,
          plusOnePolicy: ec.event.plusOnePolicy ?? null,
          guestPolicyNote: ec.event.guestPolicyNote ?? null,
          dressCodeDescription: ec.event.dressCodeDescription,
          dressCodePalette: JSON.stringify(ec.event.dressCodePalette),
          pinterestUrl: pinFor(ec.id, ec.event.pinterestUrl),
          mapsUrl: ec.event.mapsUrl,
          sortOrder: ec.event.sortOrder,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    // 3. event updates
    for (const eu of plan.eventUpdates) {
      const set: Partial<typeof events.$inferInsert> = {
        name: eu.event.name,
        startAt: eu.event.startAt,
        endAt: eu.event.endAt,
        timezone: eu.event.timezone,
        address: eu.event.address,
        dressCodeDescription: eu.event.dressCodeDescription,
        dressCodePalette: JSON.stringify(eu.event.dressCodePalette),
        pinterestUrl: pinFor(eu.id, eu.event.pinterestUrl),
        mapsUrl: eu.event.mapsUrl,
        sortOrder: eu.event.sortOrder,
        updatedAt: now,
      };
      // Written only when the desired event states them: absent means the
      // change says nothing about them (a sheet without the column, an older
      // editor), so the stored values stay.
      if (eu.event.description !== undefined) set.description = eu.event.description;
      if (eu.event.venueName !== undefined) set.venueName = eu.event.venueName;
      if (eu.event.gettingThere !== undefined) set.gettingThere = eu.event.gettingThere;
      if (eu.event.childrenPolicy !== undefined) set.childrenPolicy = eu.event.childrenPolicy;
      if (eu.event.plusOnePolicy !== undefined) set.plusOnePolicy = eu.event.plusOnePolicy;
      if (eu.event.guestPolicyNote !== undefined) set.guestPolicyNote = eu.event.guestPolicyNote;
      statements.push(db.update(events).set(set).where(eq(events.id, eu.id)));
    }

    // 3b. runs of show, after the events they belong to. A created event gets
    // the list it states; an updated one has its list replaced only when the
    // update states one, which the diff leaves out when it is unchanged.
    const restated = plan.eventUpdates.filter((eu) => eu.event.runOfShow !== undefined);
    statements.push(
      ...runOfShowStatements(
        db,
        weddingId,
        [
          ...plan.eventCreates.map((ec) => ({ eventId: ec.id, items: ec.event.runOfShow ?? [] })),
          ...restated.map((eu) => ({ eventId: eu.id, items: eu.event.runOfShow ?? [] })),
        ],
        restated.map((eu) => eu.id),
      ),
    );

    // 4. family removes (cascade guests, rsvps, sessions)
    for (const fr of plan.familyRemoves) {
      statements.push(db.delete(families).where(eq(families.id, fr.id)));
    }

    // 5. family creates
    for (const fc of plan.familyCreates) {
      statements.push(
        db.insert(families).values({
          id: fc.id,
          weddingId,
          publicId: fc.publicId,
          familyName: fc.familyName,
          source: fc.source ?? "import",
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    // 5b. family updates (id-matched renames — only the name changes in place).
    // The wedding conjunct is defence in depth: every plan reaching here today
    // is built from wedding-scoped reads, but that guarantee lives in
    // diffAgainstDb — this keeps the statement itself tenant-safe if a future
    // caller ever hands applyImport a plan from elsewhere.
    for (const fu of plan.familyUpdates) {
      statements.push(
        db
          .update(families)
          .set({ familyName: fu.familyName, updatedAt: now })
          .where(and(eq(families.id, fu.id), eq(families.weddingId, weddingId))),
      );
    }

    // 6. guest removes (cascade rsvps + guest_events for that guest). A
    // plus-one removed with their inviter needs no statement of its own: the
    // inviter's delete above it cascades them, so theirs would match nothing.
    for (const gr of plan.guestRemoves) {
      if (gr.cascaded === true) continue;
      statements.push(db.delete(guests).where(eq(guests.id, gr.id)));
    }

    // 7. guest creates. The last guest insert of each D1 batch checks the cap,
    // counting the batch's earlier guests (see insertGuest): nothing else
    // writes inside a batch, so a batch commits only when it ends within the
    // cap, whatever another writer committed after the check above. Every
    // removal sits in steps 1-6, so the places it frees are already counted.
    for (const [index, gc] of plan.guestCreates.entries()) {
      const checkCap = index === plan.guestCreates.length - 1 || statements.nextFillsBatch();
      statements.push(insertGuest(db, gc, weddingId, now, checkCap));
    }

    // 8. guest updates. `firstName` is set through only on an id-matched rename
    // (the field is absent otherwise), so a no-id import writes exactly the same
    // columns as before.
    for (const gu of plan.guestUpdates) {
      const set: Partial<typeof guests.$inferInsert> = {
        lastName: gu.lastName,
        nickname: gu.nickname,
        sortOrder: gu.sortOrder,
        updatedAt: now,
      };
      if (gu.firstName !== undefined) set.firstName = gu.firstName;
      statements.push(db.update(guests).set(set).where(eq(guests.id, gu.id)));
    }

    // 8b. guest addresses, after the creates they may name. Each write applies
    // only while the stored address is still the one the diff decided against
    // (`emailWas`), so a guest's own save that landed after the diff is never
    // overwritten. An address set without a carried consent record is the
    // applying organiser's, stamped from their attestation.
    const emailWrites = plan.emailWrites ?? [];
    const emailStamp = options.emailStamp;
    if (emailsNeedingAttestation(plan) > 0 && emailStamp === undefined) {
      return yield* Effect.fail(
        new ImportError({ reason: "an address is set without the organiser's attestation" }),
      );
    }
    for (const w of emailWrites) {
      const record: Partial<typeof guests.$inferInsert> =
        w.email === null
          ? {
              email: null,
              emailSource: null,
              emailConsentAt: null,
              emailConsentVersion: null,
              emailAttestedByOsnProfileId: null,
            }
          : w.record !== undefined
            ? {
                email: w.email,
                emailSource: w.record.source,
                emailConsentAt: new Date(w.record.consentAt),
                emailConsentVersion: w.record.version,
                emailAttestedByOsnProfileId: w.record.attestedBy,
              }
            : {
                email: w.email,
                emailSource: "organiser_attested",
                emailConsentAt: now,
                emailConsentVersion: emailStamp?.version ?? null,
                emailAttestedByOsnProfileId: emailStamp?.osnProfileId ?? null,
              };
      statements.push(
        db
          .update(guests)
          .set({ ...record, updatedAt: now })
          .where(
            and(
              eq(guests.id, w.guestId),
              w.emailWas === null ? isNull(guests.email) : eq(guests.email, w.emailWas),
            ),
          ),
      );
    }

    // 9. guest_events: per-pair removes then creates. The diff already emitted
    // only the (guestId, eventId) pairs that should disappear, so we delete each
    // pair individually rather than wiping a whole guest's link set.
    for (const link of plan.eventLinkRemoves) {
      statements.push(
        db
          .delete(guestEvents)
          .where(and(eq(guestEvents.guestId, link.guestId), eq(guestEvents.eventId, link.eventId))),
      );
    }
    for (const link of plan.eventLinkCreates) {
      statements.push(
        db
          .insert(guestEvents)
          .values({ guestId: link.guestId, eventId: link.eventId })
          .onConflictDoNothing(),
      );
    }

    // Together, last: the caller's status flip must not commit without the
    // claim check beside it.
    if (finalize.length > 0) addGroup(finalize);

    yield* Effect.tryPromise({
      try: () => commitWriteSet(db, groups),
      catch: (cause) => new ImportError({ reason: "apply failed", cause }),
    }).pipe(
      // A guest insert found no room: a batch would have ended past the cap,
      // and D1 rolled it back. Earlier batches stay committed.
      Effect.catchTag("ImportError", (failure) =>
        driverErrorText(failure.cause).includes(NO_ROOM_FOR_GUEST)
          ? tierService.capacityRefusal(weddingId).pipe(
              Effect.mapError(
                (capacity) =>
                  new ImportError({
                    reason: "no room under the guest cap",
                    cause: failure.cause,
                    capacity,
                  }),
              ),
            )
          : Effect.fail(failure),
      ),
    );

    // Counts only, never a task's title.
    const linkedRemoved = linkedTasks.filter((t) => removing.has(t.id)).length;
    yield* Effect.logInfo(
      `import applied: families=${plan.familyCreates.length} guests=${plan.guestCreates.length} events=${plan.eventCreates.length} linkedTasksKept=${linkedTasks.length - linkedRemoved} linkedTasksRemoved=${linkedRemoved}`,
      { importId },
    );
    const emailsSet = emailWrites.filter((w) => w.email !== null).length;
    const emailsCleared = emailWrites.length - emailsSet;
    if (emailsSet > 0) metricGuestEmailChanged("organiser", "set", emailsSet);
    if (emailsCleared > 0) metricGuestEmailChanged("organiser", "cleared", emailsCleared);

    return {
      changeId: importId,
      eventsCreated: plan.eventCreates.length,
      eventsUpdated: plan.eventUpdates.length,
      eventsRemoved: plan.eventRemoves.length,
      familiesCreated: plan.familyCreates.length,
      familiesUpdated: plan.familyUpdates.length,
      familiesRemoved: plan.familyRemoves.length,
      guestsCreated: plan.guestCreates.length,
      guestsUpdated: plan.guestUpdates.length,
      guestsRemoved: plan.guestRemoves.length,
    };
  }).pipe(
    Effect.tap((summary) =>
      Effect.sync(() =>
        metricImportApplied("ok", {
          events: summary.eventsCreated,
          families: summary.familiesCreated,
          guests: summary.guestsCreated,
        }),
      ),
    ),
    Effect.tapError(() => Effect.sync(() => metricImportApplied("error"))),
    Effect.withSpan("cire.import.apply"),
  );
}
