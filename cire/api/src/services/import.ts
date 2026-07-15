import { events, families, guests, guestEvents, rsvps, weddings } from "@cire/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data } from "effect";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { metricImportApplied } from "../metrics";
import type {
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
import { generateFamilyCode } from "./family-code";
import type { CodeStyle } from "./family-code";
import { resolvePinUrl } from "./pinterest-resolve";

// ── Tagged errors ─────────────────────────────────────────────────────────────

export class ImportError extends Data.TaggedError("ImportError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function mintEventSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
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
 */
export function diffAgainstDb(
  parsedEvents: readonly ParsedEvent[],
  parsedFamilies: readonly ParsedFamily[],
  weddingId: string,
): Effect.Effect<ImportPlan, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    // C1: the wedding's claim-code tier drives every NEW family code minted by
    // this import. Read once; default to `secure` if the row is somehow absent
    // (defensive — `weddingId` is always a real, owned wedding here).
    const [weddingRow] = yield* dbQuery(() =>
      db
        .select({ codeStyle: weddings.codeStyle })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .all(),
    );
    const codeStyle: CodeStyle = weddingRow?.codeStyle ?? "secure";

    // ── Events ──────────────────────────────────────────────────────────────
    const existingEvents = yield* dbQuery(() =>
      db.select().from(events).where(eq(events.weddingId, weddingId)).all(),
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

    for (const parsed of parsedEvents) {
      const norm = normaliseName(parsed.name);
      // Prefer id match (rename-safe); fall back to name; else create.
      const existing =
        (parsed.id !== undefined ? existingEventById.get(parsed.id) : undefined) ??
        existingEventByNorm.get(norm);
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

    // ── Families ────────────────────────────────────────────────────────────
    // Host preview families (kind = 'host') are synthetic and CSV-invisible:
    // they are never in the parsed sheet, so a naive scan would mark them — and
    // their event links — for removal on every re-import. Excluding them here
    // (and from the guest + link scans below) makes imports leave them intact.
    const existingFamilies = yield* dbQuery(() =>
      db
        .select()
        .from(families)
        .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
        .all(),
    );
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

    parsedFamilies.forEach((parsed, i) => {
      const norm = normaliseName(parsed.familyName);
      const existing =
        (parsed.id !== undefined ? existingFamilyById.get(parsed.id) : undefined) ??
        existingFamilyByNorm.get(norm);
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
      if (!matchedFamilyIds.has(existing.id)) {
        familyRemoves.push({ id: existing.id, familyName: existing.familyName });
      }
    }

    // ── Guests ──────────────────────────────────────────────────────────────
    const removedFamilyIds = new Set(familyRemoves.map((f) => f.id));
    // Wedding-scoped via the families join — guests carry no wedding_id.
    const existingGuests = yield* dbQuery(() =>
      db
        .select({
          id: guests.id,
          familyId: guests.familyId,
          firstName: guests.firstName,
          lastName: guests.lastName,
          nickname: guests.nickname,
          sortOrder: guests.sortOrder,
        })
        .from(guests)
        .innerJoin(families, eq(guests.familyId, families.id))
        .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
        .all(),
    );

    /** Per-family map: normFirstName → existing guest row. */
    const guestsByFamily = new Map<string, Map<string, (typeof existingGuests)[number]>>();
    /** Global id → existing guest row, for `Guest ID`-keyed matching. */
    const existingGuestById = new Map(existingGuests.map((g) => [g.id, g]));
    for (const g of existingGuests) {
      let m = guestsByFamily.get(g.familyId);
      if (!m) {
        m = new Map();
        guestsByFamily.set(g.familyId, m);
      }
      m.set(normaliseName(g.firstName), g);
    }

    const guestCreates: GuestCreate[] = [];
    const guestUpdates: GuestUpdate[] = [];
    const guestRemoves: GuestRemove[] = [];
    const eventLinkCreates: EventLink[] = [];
    const eventLinkRemoves: EventLink[] = [];

    /** Track resolved guestId per (familyId, normFirstName) for link diff. */
    const guestIdByKey = new Map<string, string>();
    const keyOf = (familyId: string, firstName: string) =>
      `${familyId}::${normaliseName(firstName)}`;

    // Matched + new families
    parsedFamilies.forEach((parsedFamily, familyIndex) => {
      const familyId = familyIdByParsedIndex[familyIndex]!;
      // A family is "new" iff it was NOT matched to an existing row. With no ids
      // this equals `!existingFamilyByNorm.has(norm)` (byte-identical); with ids
      // a renamed family stays existing so its guests reconcile in place.
      const isNewFamily = !matchedFamilyIds.has(familyId);
      const existingGuestMap = isNewFamily
        ? new Map<string, (typeof existingGuests)[number]>()
        : (guestsByFamily.get(familyId) ?? new Map());

      /** Existing guest ids in THIS family consumed by a match — unmatched ones
       *  are removals. Replaces the `seenFirstNames` scan so an id-matched guest
       *  RENAME (old first name absent) isn't also flagged for removal. With no
       *  ids present, a guest is matched by first name exactly as before, so this
       *  set == the old "seen first names" set and removals are byte-identical. */
      const matchedGuestIds = new Set<string>();

      parsedFamily.guests.forEach((parsedGuest, sortOrder) => {
        // Prefer `Guest ID` (rename-safe); the id must belong to THIS family, so
        // a stray cross-family id falls back to name matching. Then match by
        // first name within the family (today's behaviour).
        const candidateById =
          parsedGuest.id !== undefined ? existingGuestById.get(parsedGuest.id) : undefined;
        const matchedById = candidateById !== undefined && candidateById.familyId === familyId;
        const existing = matchedById
          ? candidateById
          : existingGuestMap.get(normaliseName(parsedGuest.firstName));
        if (existing) {
          matchedGuestIds.add(existing.id);
          guestIdByKey.set(keyOf(familyId, parsedGuest.firstName), existing.id);
          // A first-name change is only meaningful on the id-matched path — a
          // name match means the first name is unchanged by definition, so we
          // never write `firstName` through there (keeps the no-id plan
          // byte-identical, incl. case-only differences that name matching
          // already folds together). On the id-matched path a genuine rename
          // becomes an update carrying the new firstName.
          const firstNameChanged = matchedById && existing.firstName !== parsedGuest.firstName;
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
          guestIdByKey.set(keyOf(familyId, parsedGuest.firstName), id);
        }
      });

      // Existing guests in this family not matched → remove (an id-less
      // first-name change is a remove + create at this layer, as before).
      if (!isNewFamily) {
        for (const existing of existingGuestMap.values()) {
          if (!matchedGuestIds.has(existing.id)) {
            guestRemoves.push({ id: existing.id, firstName: existing.firstName });
          }
        }
      }
    });

    // Guests in removed families → also removed.
    for (const g of existingGuests) {
      if (removedFamilyIds.has(g.familyId)) {
        guestRemoves.push({ id: g.id, firstName: g.firstName });
      }
    }

    // ── Event links ─────────────────────────────────────────────────────────
    // Wedding-scoped via guests → families — guest_events carries no wedding_id,
    // so without this join a second wedding's links read as removals.
    const existingLinks = yield* dbQuery(() =>
      db
        .select({ guestId: guestEvents.guestId, eventId: guestEvents.eventId })
        .from(guestEvents)
        .innerJoin(guests, eq(guestEvents.guestId, guests.id))
        .innerJoin(families, eq(guests.familyId, families.id))
        .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
        .all(),
    );
    const existingLinkSet = new Set(existingLinks.map((l) => `${l.guestId}::${l.eventId}`));
    /** Track desired (guestId, eventId) pairs after import. */
    const desiredLinks = new Set<string>();

    parsedFamilies.forEach((parsedFamily, familyIndex) => {
      const familyId = familyIdByParsedIndex[familyIndex]!;
      for (const parsedGuest of parsedFamily.guests) {
        const guestId = guestIdByKey.get(keyOf(familyId, parsedGuest.firstName))!;
        for (const eventName of parsedGuest.eventNames) {
          const eventId = eventIdByNorm.get(normaliseName(eventName));
          if (!eventId) continue; // already validated upstream
          const key = `${guestId}::${eventId}`;
          desiredLinks.add(key);
          if (!existingLinkSet.has(key)) {
            eventLinkCreates.push({ guestId, eventId });
          }
        }
      }
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

    // ── Warnings: removed/renamed guests with non-pending RSVPs ─────────────
    const warnings: string[] = [];
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
): Effect.Effect<ImportSummary, ImportError, DbService> {
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

    // 1. event removes (cascade rsvps + guest_events on those events)
    for (const er of plan.eventRemoves) {
      statements.push(
        db.delete(rsvps).where(eq(rsvps.eventId, er.id)),
        db.delete(guestEvents).where(eq(guestEvents.eventId, er.id)),
        db.delete(events).where(eq(events.id, er.id)),
      );
    }

    // 2. event creates
    for (const ec of plan.eventCreates) {
      statements.push(
        db.insert(events).values({
          id: ec.id,
          weddingId,
          slug: mintEventSlug(ec.event.name),
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
