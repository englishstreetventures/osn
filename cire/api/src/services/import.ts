import {
  events,
  families,
  guests,
  guestEvents,
  rsvps,
  weddings,
  weddingEntitlements,
} from "@cire/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { metricImportApplied } from "../metrics";
import type {
  ChangeScope,
  EventCreate,
  EventLink,
  EventRemove,
  EventUpdate,
  FamilyCreate,
  FamilyRemove,
  GuestCreate,
  GuestRemove,
  GuestUpdate,
  ImportPlan,
  ImportSummary,
  ParsedEvent,
  ParsedFamily,
} from "../schemas/import";
import { entitlementService, CapacityExceeded } from "./entitlements";
import { generateFamilyCode } from "./family-code";
import type { CodeStyle } from "./family-code";
import { resolvePinUrl } from "./pinterest-resolve";

// ── Tagged errors ─────────────────────────────────────────────────────────────

export class ImportError extends Data.TaggedError("ImportError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * An id-authoritative desired state (the editor front door — see
 * {@link DiffOptions.matchByName}) named a row that no longer exists.
 *
 * Only the editor can raise this, and when it does the draft is provably stale:
 * it carries ids it can only have got from a load, so an id that resolves to
 * nothing means someone else deleted that row since. Refusing is the whole point
 * — with name fallback off, a dangling row is not "unmatched", it is a REMOVE
 * plus a CREATE: the RSVPs attached to it are deleted, and a household comes back
 * with a fresh row carrying the claim code the draft still remembers, resurrecting
 * an invite a co-host may have deliberately revoked. `baseRevision` catches the
 * same race between preview and apply; this catches it between load and preview,
 * which nothing else does.
 */
export class StaleDesiredState extends Data.TaggedError("StaleDesiredState")<{
  /** How many desired rows named a row that is gone (never the ids themselves). */
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
 *    an in-place keep (the row + its claim code survive).
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
}

export function diffAgainstDb(
  parsedEvents: readonly ParsedEvent[],
  parsedFamilies: readonly ParsedFamily[],
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

    // C1: the wedding's claim-code tier drives every NEW family code minted by
    // this import. Read once; default to `secure` if the row is somehow absent
    // (defensive — `weddingId` is always a real, owned wedding here). Skipped
    // entirely when the guest half isn't managed: its only consumer is
    // `generateFamilyCode` in the familyCreates loop, and that loop is provably
    // empty under `scope: "events"` (`desiredFamilies` is `[]` by construction).
    const [weddingRow] = manageGuests
      ? yield* dbQuery(() =>
          db
            .select({ codeStyle: weddings.codeStyle })
            .from(weddings)
            .where(eq(weddings.id, weddingId))
            .all(),
        )
      : [];
    const codeStyle: CodeStyle = weddingRow?.codeStyle ?? "secure";

    // ── Events ──────────────────────────────────────────────────────────────
    // Projected to the two columns the diff reads (`id` for matching + the op
    // lists, `name` for the normalised-name map). The guests-only branch below
    // exists purely to build that name → id map, so dragging full event rows —
    // descriptions, palettes, URLs — across the D1 wire to do it is pure waste.
    const existingEvents = yield* dbQuery(() =>
      db
        .select({ id: events.id, name: events.name })
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
          eventUpdates.push({ id: existing.id, event: parsed });
          eventIdByNorm.set(norm, existing.id);
          matchedEventIds.add(existing.id);
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
      } else {
        const id = crypto.randomUUID();
        familyCreates.push({
          id,
          // Preserve the sheet's claim code when a full-fidelity round trip
          // carries one; else mint per the wedding's code style (unchanged).
          publicId: parsed.publicId ?? generateFamilyCode(parsed.familyName, codeStyle),
          familyName: parsed.familyName,
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
    const existingGuests = manageGuests
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
            })
            .from(guests)
            .innerJoin(families, eq(guests.familyId, families.id))
            .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
            .all(),
        )
      : [];

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
    desiredFamilies.forEach((parsedFamily, familyIndex) => {
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
            guestUpdates.push({
              id: existing.id,
              ...(firstNameChanged ? { firstName: parsedGuest.firstName } : {}),
              lastName: parsedGuest.lastName,
              nickname: parsedGuest.nickname,
              sortOrder,
            });
          }
        } else {
          const id = crypto.randomUUID();
          guestCreates.push({
            id,
            familyId,
            firstName: parsedGuest.firstName,
            lastName: parsedGuest.lastName,
            nickname: parsedGuest.nickname,
            sortOrder,
          });
          resolvedIds[sortOrder] = id;
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

    // ── Stale-draft refusal (id-authoritative front doors only) ──────────────
    // Every id in the desired state has now been looked up. On the editor path a
    // miss means the draft was built against state that no longer exists, and
    // because that path has no name fallback the miss would reconcile as a
    // destructive remove+create rather than an update — see StaleDesiredState.
    // Refused BEFORE the link/RSVP/entitlement reads below: nothing downstream
    // can make the plan safe, so they would be work spent on a plan we discard.
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

    desiredFamilies.forEach((parsedFamily, familyIndex) => {
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
        }
      });
    });

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

    const warnings: string[] = [];

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
          .where(
            inArray(
              families.publicId,
              carriedCodes.map((c) => c.publicId),
            ),
          )
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

    // ── Warnings: removed/renamed guests with non-pending RSVPs ─────────────
    const guestsBeingLost = guestRemoves.map((g) => ({ id: g.id, firstName: g.firstName }));

    if (guestsBeingLost.length > 0) {
      const ids = guestsBeingLost.map((g) => g.id);
      const rsvpRows = yield* dbQuery(() =>
        db.select().from(rsvps).where(inArray(rsvps.guestId, ids)).all(),
      );
      const lostFirst = new Map(guestsBeingLost.map((g) => [g.id, g.firstName]));
      for (const r of rsvpRows) {
        const isMeaningful = r.status !== "pending" || (r.dietary && r.dietary.length > 0);
        if (!isMeaningful) continue;
        const firstName = lostFirst.get(r.guestId) ?? "(unknown)";
        warnings.push(
          `Removing guest ${firstName} would lose their RSVP: status=${r.status}, dietary=${r.dietary ?? ""}`,
        );
      }
    }

    // ── Capacity preview warning (non-blocking) ──────────────────────────────
    // Warn early when this plan would breach the derived cap. The hard atomic
    // block lives in applyImport — this warning lets the preview UI surface the
    // issue before the organiser commits. Host-preview families are excluded from
    // the current-guest count (same join + ne(kind,'host') as entitlementService).
    if (guestCreates.length > 0) {
      const entRows = yield* dbQuery(() =>
        db
          .select({ e: weddingEntitlements.entitlement })
          .from(weddingEntitlements)
          .where(eq(weddingEntitlements.weddingId, weddingId))
          .all(),
      );
      const cap = entitlementService.deriveCap((entRows as { e: string }[]).map((r) => r.e));
      // `existingGuests` was already fetched above with ne(families.kind, 'host'),
      // so it already excludes host-preview guests. The resulting headcount after
      // this plan: current real guests minus removals plus new creates.
      const currentRealGuests = existingGuests.length;
      const resulting = currentRealGuests - guestRemoves.length + guestCreates.length;
      if (resulting > cap) {
        warnings.push(
          `This import brings you to ${resulting} guests; your plan is capped at ${cap}. Upgrade to add more.`,
        );
      }
    }

    return {
      eventCreates,
      eventUpdates,
      eventRemoves,
      familyCreates,
      familyRemoves,
      guestCreates,
      guestUpdates,
      guestRemoves,
      eventLinkCreates,
      eventLinkRemoves,
      warnings,
    };
  }).pipe(Effect.withSpan("cire.import.diff"));
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Maximum Drizzle statements committed in a single `db.batch([...])`.
 *
 * D1 bounds a Worker invocation to 50 queries on the Free tier (1000 on Paid),
 * and every statement in a `batch()` counts as one query against that cap — so
 * an unchunked batch of a few-hundred-row guest list would blow straight past
 * 50 and fail on the tier cire runs on. 50 is the documented Free-tier ceiling;
 * we sit one notch below the SAFE limit by capping each *batch* at 50 so no
 * single batch can exceed the per-invocation cap, while still amortising the
 * Workers↔D1 round-trip over many statements. (The separate per-query limit —
 * ≤100 bound parameters — is unaffected: chunking groups whole statements, never
 * splits one, and our widest insert binds well under 100 params.)
 *
 * See https://developers.cloudflare.com/d1/platform/limits/.
 */
const MAX_STATEMENTS_PER_BATCH = 50;

/**
 * Commit the import write set, which is built in FK-dependency order.
 *  - D1 (production): atomic `db.batch([...])` calls — one Workers↔D1 round-trip
 *    per chunk, all-or-nothing *within* a chunk. D1 has no interactive
 *    transaction, but a single batch IS a transaction.
 *  - bun:sqlite (tests/local): awaited sequentially in the same order
 *    (bun:sqlite exposes no `.batch()`; awaiting a Drizzle builder executes it).
 *
 * Chunking (D1 path): the statement list is split into sequential chunks of
 * ≤`MAX_STATEMENTS_PER_BATCH`, awaited IN ORDER (never in parallel) — see the
 * dependency-ordering + atomicity invariants documented on the chunk loop below.
 *
 * `batch` exists only on the D1 driver, so feature-detection picks the path.
 */
async function commitWriteSet(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (statements.length === 0) return;
  const batchable = db as {
    batch?: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown>;
  };
  if (typeof batchable.batch === "function") {
    // INVARIANT (dependency ordering): `statements` is built in strict
    // FK-dependency order by applyImport (removes → event creates →
    // family creates → guest creates → link creates, etc.). Splitting that
    // single ordered list into in-order, sequentially-awaited chunks PRESERVES
    // that order: every parent insert still precedes its child insert, even
    // across a chunk boundary, because a later chunk is only dispatched after
    // the earlier chunk has fully committed. A chunk boundary can never make a
    // child run before its parent.
    //
    // ATOMICITY TRADEOFF: D1 `batch()` is atomic per call but NOT across calls,
    // and D1 has no multi-batch transaction primitive. So a failure mid-import
    // (after chunk k commits, before chunk k+1) can leave a PARTIAL apply. This
    // is the accepted design: `services/revert.ts` re-diffs the prior import's
    // CSVs against current DB state and re-applies, which reconciles a partial
    // apply just as it reconciles a fully-applied one. We deliberately do NOT
    // add cross-batch transaction machinery (it doesn't exist on D1); chunking
    // + revert is the tradeoff. Chunks stay small + the whole import is well
    // under the 30s wall-clock, so the partial-apply window is narrow.
    for (let i = 0; i < statements.length; i += MAX_STATEMENTS_PER_BATCH) {
      const chunk = statements.slice(i, i + MAX_STATEMENTS_PER_BATCH) as [
        BatchItem<"sqlite">,
        ...BatchItem<"sqlite">[],
      ];
      // eslint-disable-next-line no-await-in-loop -- chunks are dependency-ordered; they MUST run serially
      await batchable.batch(chunk);
    }
    return;
  }
  // Sequential FK order is required and bun:sqlite has no batch; these run
  // in-process (no network round-trip) so awaiting each in turn is fine.
  // eslint-disable-next-line no-await-in-loop
  for (const stmt of statements) await stmt;
}

export function applyImport(
  importId: string,
  plan: ImportPlan,
  weddingId: string,
  // Statements appended to the END of the write set, committing in the same
  // final batch as the tail of the data writes. The apply route passes its
  // `imports` status flip here so "data mutated" and "row marked applied"
  // can't be split by a crash — the window that used to allow a second apply
  // to overwrite the before-image with a post-change snapshot.
  finalize: BatchItem<"sqlite">[] = [],
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
    // ≤MAX_STATEMENTS_PER_BATCH atomic D1 batches (prod) or a sequential
    // bun:sqlite run (tests) — see commitWriteSet. The build order below IS the
    // dependency order the chunker relies on (removes → event/family/guest
    // creates → updates → link removes → link creates).
    const statements: BatchItem<"sqlite">[] = [];

    // 1. event removes. The event_id FKs cascade since migration 0052, but the
    // child deletes stay explicit so this write set does not depend on cascade
    // being enabled on every driver (same stance as the retention sweep).
    for (const er of plan.eventRemoves) {
      statements.push(
        db.delete(rsvps).where(eq(rsvps.eventId, er.id)),
        db.delete(guestEvents).where(eq(guestEvents.eventId, er.id)),
        db.delete(events).where(eq(events.id, er.id)),
      );
    }

    // Slugs already taken by this wedding's surviving events, so fresh mints
    // can't collide on the (wedding_id, slug) unique index — within the sheet
    // ("Ceremony" + "Ceremony!") or against events this plan keeps. Skipped
    // when the plan creates no events (P-I2) — the set is only consulted by
    // mintUniqueEventSlug.
    const removedEventIds = new Set(plan.eventRemoves.map((er) => er.id));
    const existingSlugRows =
      plan.eventCreates.length > 0
        ? yield* dbQuery(() =>
            db
              .select({ id: events.id, slug: events.slug })
              .from(events)
              .where(eq(events.weddingId, weddingId))
              .all(),
          )
        : [];
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
          description: "",
          startAt: ec.event.startAt,
          endAt: ec.event.endAt,
          timezone: ec.event.timezone,
          // The sheet's venue-name Location has no column of its own — it fills
          // in for a blank Address so the value still reaches the invite's
          // "Where" instead of being silently dropped.
          address: ec.event.address ?? ec.event.location,
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
      statements.push(
        db
          .update(events)
          .set({
            name: eu.event.name,
            startAt: eu.event.startAt,
            endAt: eu.event.endAt,
            timezone: eu.event.timezone,
            // Same Location → Address fallback as the create path above.
            address: eu.event.address ?? eu.event.location,
            dressCodeDescription: eu.event.dressCodeDescription,
            dressCodePalette: JSON.stringify(eu.event.dressCodePalette),
            pinterestUrl: pinFor(eu.id, eu.event.pinterestUrl),
            mapsUrl: eu.event.mapsUrl,
            sortOrder: eu.event.sortOrder,
            updatedAt: now,
          })
          .where(eq(events.id, eu.id)),
      );
    }

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
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    // 6. guest removes (cascade rsvps + guest_events for that guest)
    for (const gr of plan.guestRemoves) {
      statements.push(db.delete(guests).where(eq(guests.id, gr.id)));
    }

    // 7. guest creates
    for (const gc of plan.guestCreates) {
      statements.push(
        db.insert(guests).values({
          id: gc.id,
          familyId: gc.familyId,
          firstName: gc.firstName,
          lastName: gc.lastName,
          nickname: gc.nickname,
          sortOrder: gc.sortOrder,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    // 8. guest updates. `firstName` is set through only on an id-matched rename
    // (the field is absent otherwise), so a no-id import writes exactly the same
    // columns as before.
    for (const gu of plan.guestUpdates) {
      statements.push(
        db
          .update(guests)
          .set({
            ...(gu.firstName === undefined ? {} : { firstName: gu.firstName }),
            lastName: gu.lastName,
            nickname: gu.nickname,
            sortOrder: gu.sortOrder,
            updatedAt: now,
          })
          .where(eq(guests.id, gu.id)),
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

    // Capacity gate — enforce the wedding's derived guest ceiling on the NET new
    // guests this plan introduces, before any write. Atomic: a breach fails the
    // whole apply, nothing is committed. We pass the NET delta (creates minus
    // removals) so a churn import that removes K guests and adds K guests at cap
    // is correctly allowed: assertGuestCapacity does `current + incoming > cap`,
    // and a negative or zero incoming can never exceed.
    const netGuestDelta = plan.guestCreates.length - plan.guestRemoves.length;
    if (netGuestDelta > 0) {
      yield* entitlementService.assertGuestCapacity(weddingId, netGuestDelta);
    }

    statements.push(...finalize);

    yield* Effect.tryPromise({
      try: () => commitWriteSet(db, statements),
      catch: (cause) => new ImportError({ reason: "apply failed", cause }),
    });

    yield* Effect.logInfo(
      `import applied: families=${plan.familyCreates.length} guests=${plan.guestCreates.length} events=${plan.eventCreates.length}`,
      { importId },
    );

    return {
      importId,
      eventsCreated: plan.eventCreates.length,
      eventsUpdated: plan.eventUpdates.length,
      eventsRemoved: plan.eventRemoves.length,
      familiesCreated: plan.familyCreates.length,
      familiesRemoved: plan.familyRemoves.length,
      guestsCreated: plan.guestCreates.length,
      guestsUpdated: plan.guestUpdates.length,
      guestsRemoved: plan.guestRemoves.length,
      warnings: plan.warnings,
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
