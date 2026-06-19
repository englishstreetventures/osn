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
 *  - Events: by `Event Name` (case-insensitive). Existing not in sheet → remove.
 *    New → create.
 *  - Families: by `family_name` (case-insensitive trim). Different name = remove
 *    + create (no rename detection).
 *  - Guests within matched family: by `(family, firstName)`. Last-name change OK
 *    (→ guestUpdate); first-name change = remove + create.
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
    const parsedEventByNorm = new Map(parsedEvents.map((e) => [normaliseName(e.name), e]));

    const eventCreates: EventCreate[] = [];
    const eventUpdates: EventUpdate[] = [];
    const eventRemoves: EventRemove[] = [];
    /** Map normalised event name → resolved event id (for guest-event links). */
    const eventIdByNorm = new Map<string, string>();

    for (const parsed of parsedEvents) {
      const norm = normaliseName(parsed.name);
      const existing = existingEventByNorm.get(norm);
      if (existing) {
        eventUpdates.push({ id: existing.id, event: parsed });
        eventIdByNorm.set(norm, existing.id);
      } else {
        const id = crypto.randomUUID();
        eventCreates.push({ id, event: parsed });
        eventIdByNorm.set(norm, id);
      }
    }
    for (const existing of existingEvents) {
      if (!parsedEventByNorm.has(normaliseName(existing.name))) {
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
    const parsedFamilyByNorm = new Map(parsedFamilies.map((f) => [normaliseName(f.familyName), f]));

    const familyCreates: FamilyCreate[] = [];
    const familyRemoves: FamilyRemove[] = [];

    /** norm-family-name → resolved family id (existing or newly minted). */
    const familyIdByNorm = new Map<string, string>();

    for (const parsed of parsedFamilies) {
      const norm = normaliseName(parsed.familyName);
      const existing = existingFamilyByNorm.get(norm);
      if (existing) {
        familyIdByNorm.set(norm, existing.id);
      } else {
        const id = crypto.randomUUID();
        familyCreates.push({
          id,
          publicId: generateFamilyCode(parsed.familyName, codeStyle),
          familyName: parsed.familyName,
        });
        familyIdByNorm.set(norm, id);
      }
    }
    for (const existing of existingFamilies) {
      if (!parsedFamilyByNorm.has(normaliseName(existing.familyName))) {
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
          sortOrder: guests.sortOrder,
        })
        .from(guests)
        .innerJoin(families, eq(guests.familyId, families.id))
        .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
        .all(),
    );

    /** Per-family map: normFirstName → existing guest row. */
    const guestsByFamily = new Map<string, Map<string, (typeof existingGuests)[number]>>();
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
    for (const parsedFamily of parsedFamilies) {
      const familyNorm = normaliseName(parsedFamily.familyName);
      const familyId = familyIdByNorm.get(familyNorm)!;
      const isNewFamily = !existingFamilyByNorm.has(familyNorm);
      const existingGuestMap = isNewFamily
        ? new Map<string, (typeof existingGuests)[number]>()
        : (guestsByFamily.get(familyId) ?? new Map());

      const seenFirstNames = new Set<string>();
      parsedFamily.guests.forEach((parsedGuest, sortOrder) => {
        const norm = normaliseName(parsedGuest.firstName);
        seenFirstNames.add(norm);
        const existing = existingGuestMap.get(norm);
        if (existing) {
          guestIdByKey.set(keyOf(familyId, parsedGuest.firstName), existing.id);
          // last-name change is an update; first-name match means same row
          if (existing.lastName !== parsedGuest.lastName || existing.sortOrder !== sortOrder) {
            guestUpdates.push({
              id: existing.id,
              lastName: parsedGuest.lastName,
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
            sortOrder,
          });
          guestIdByKey.set(keyOf(familyId, parsedGuest.firstName), id);
        }
      });

      // Existing guests in this family not in sheet → remove (first-name change
      // is a remove + create at this layer).
      if (!isNewFamily) {
        for (const [norm, existing] of existingGuestMap) {
          if (!seenFirstNames.has(norm)) {
            guestRemoves.push({ id: existing.id, firstName: existing.firstName });
          }
        }
      }
    }

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

    for (const parsedFamily of parsedFamilies) {
      const familyNorm = normaliseName(parsedFamily.familyName);
      const familyId = familyIdByNorm.get(familyNorm)!;
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
 * Commit the import write set, which is built in FK-dependency order.
 *  - D1 (production): a single atomic `db.batch([...])` — one Workers↔D1
 *    round-trip, all-or-nothing. D1 has no interactive transaction, but a
 *    batch IS a transaction, so this also closes the partial-apply gap.
 *  - bun:sqlite (tests/local): awaited sequentially in the same order
 *    (bun:sqlite exposes no `.batch()`; awaiting a Drizzle builder executes it).
 *
 * `batch` exists only on the D1 driver, so feature-detection picks the path.
 */
async function commitWriteSet(db: Db, statements: BatchItem<"sqlite">[]): Promise<void> {
  if (statements.length === 0) return;
  const batchable = db as {
    batch?: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown>;
  };
  if (typeof batchable.batch === "function") {
    await batchable.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
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

    // Build the write set in FK-dependency order, then commit it as one atomic
    // D1 batch (prod) or a sequential bun:sqlite run (tests) — see commitWriteSet.
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
          date: ec.event.startAt.slice(0, 10),
          location: ec.event.location ?? "",
          description: "",
          startAt: ec.event.startAt,
          endAt: ec.event.endAt,
          timezone: ec.event.timezone,
          address: ec.event.address,
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
            date: eu.event.startAt.slice(0, 10),
            location: eu.event.location ?? "",
            startAt: eu.event.startAt,
            endAt: eu.event.endAt,
            timezone: eu.event.timezone,
            address: eu.event.address,
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
          sortOrder: gc.sortOrder,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    // 8. guest updates
    for (const gu of plan.guestUpdates) {
      statements.push(
        db
          .update(guests)
          .set({
            lastName: gu.lastName,
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
