import { families, guests, imports } from "@cire/db";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect, Data, Option, Schema } from "effect";

import { DbService, dbQuery } from "../db";
import { EVENT_ID_HEADER } from "../lib/sheet-headers";
import { metricImportReverted } from "../metrics";
import { ChangeScope } from "../schemas/import";
import type {
  EventLink,
  ImportPlan,
  ImportSummary,
  ParsedEvent,
  ParsedFamily,
} from "../schemas/import";
import { currentEventsAsParsed } from "./changes";
import { CapacityExceeded } from "./entitlements";
import { normaliseName, nullableString } from "./guest-event-validation";
import { applyImport, diffAgainstDb, ImportError } from "./import";
import { R2Service, fetchUpload, R2Error } from "./r2-imports";
import { parseCsv, parseEventsCsv, parseGuestsCsv } from "./spreadsheet";
import type { SheetKind, SpreadsheetParseError } from "./spreadsheet";

export class NoPriorImport extends Data.TaggedError("NoPriorImport")<{
  readonly currentImportId: string;
}> {}

export class RevertParseError extends Data.TaggedError("RevertParseError")<{
  readonly reason: string;
}> {}

/**
 * The change is not `applied`: a `preview` changed nothing and a `reverted`
 * change has already been undone, so neither has anything to undo.
 */
export class ChangeNotApplied extends Data.TaggedError("ChangeNotApplied")<{
  readonly status: string;
}> {}

export type RevertError =
  | ChangeNotApplied
  | NoPriorImport
  | R2Error
  | RevertParseError
  | ImportError
  | CapacityExceeded;

const StoredScope = Schema.Struct({ scope: ChangeScope });

/**
 * The halves a revert of this change restores: the `scope` the preview stored on
 * the change row's summary (`ChangeSummary` in `routes/organiser-changes.ts`).
 *
 * A row with no readable scope — written before scopes existed, or a summary
 * that does not parse — restores both halves. That is the right default here
 * even though apply refuses an editor row without a scope: at apply, `both`
 * would read an events draft's empty household list as "remove every household",
 * but a before-image always captures both halves, so `both` is the complete
 * pre-change state and cannot become a mass delete.
 */
export function storedRevertScope(summary: string): ChangeScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(summary);
  } catch {
    return "both";
  }
  return revertScopeOf(parsed);
}

/** {@link storedRevertScope} for a summary the caller has already parsed. */
export function revertScopeOf(parsedSummary: unknown): ChangeScope {
  return Option.match(Schema.decodeUnknownOption(StoredScope)(parsedSummary), {
    onNone: (): ChangeScope => "both",
    onSome: (stored) => stored.scope,
  });
}

const parseFailed = (sheet: SheetKind) => (e: SpreadsheetParseError) =>
  new RevertParseError({ reason: `${sheet} parse failed: ${e._tag}` });

/**
 * Reconcile the wedding to a stored UPLOAD — the legacy path, which replays the
 * previous import's sheets: parse → diff against the CURRENT DB → apply.
 *
 * BLANK HALF ⇒ UNMANAGED HALF. A single-sheet upload stores `""` in the slot it
 * didn't carry. An empty sheet is therefore read as "this half was not
 * captured", scoping it out of the diff — never as "the wedding had no events /
 * no households", which would reconcile by deleting everything. Both halves
 * blank is not a reconcilable snapshot and fails.
 */
function reconcileToSnapshot(
  targetImportId: string,
  weddingId: string,
  eventsCsv: string,
  guestsCsv: string,
  finalize: BatchItem<"sqlite">[] = [],
): Effect.Effect<ImportSummary, RevertParseError | ImportError | CapacityExceeded, DbService> {
  return Effect.gen(function* () {
    const hasEvents = eventsCsv.trim().length > 0;
    const hasGuests = guestsCsv.trim().length > 0;
    if (!hasEvents && !hasGuests) {
      return yield* Effect.fail(new RevertParseError({ reason: "snapshot carries neither sheet" }));
    }
    const scope: ChangeScope = !hasEvents ? "guests" : !hasGuests ? "events" : "both";

    // A guests-only snapshot still needs an event list to resolve its attendance
    // columns; take it from live state, as the guests-only apply path does.
    // `currentEventsAsParsed` reads DB rows directly and cannot fail, so only the
    // parse branch needs the error mapping.
    const events = hasEvents
      ? yield* parseEventsCsv(eventsCsv).pipe(Effect.mapError(parseFailed("events")))
      : yield* currentEventsAsParsed(weddingId);
    const desiredFamilies = hasGuests
      ? yield* parseGuestsCsv(guestsCsv, events).pipe(Effect.mapError(parseFailed("guests")))
      : [];

    // Revert always reconciles by NAME (`matchByName` defaults on), so the diff's
    // id-authoritative refusal is unreachable here — a snapshot's dangling id
    // falls back to name matching by design, which is exactly how a restore
    // re-attaches rows that were removed and re-created since. `orDie` states
    // that: if it ever fires it is a bug in the diff, not a revert the caller
    // could handle.
    const plan = yield* diffAgainstDb(events, desiredFamilies as ParsedFamily[], weddingId, {
      scope,
    }).pipe(Effect.orDie);
    return yield* applyImport(targetImportId, plan, weddingId, finalize);
  });
}

// ── Before-image restore ────────────────────────────────────────────────────

/** One row of a before-image's events sheet: its name and its stored id. */
interface SnapshotEventKey {
  readonly name: string;
  readonly id: string | undefined;
}

/**
 * The events a before-image's events sheet names — name and `Event ID`, nothing
 * else — for a guests-scoped revert, which restores no event and only needs to
 * know which event each attendance column meant.
 *
 * Deliberately not `parseEventsCsv`. Those guards exist to vet an untrusted
 * upload (the cell cap, the IANA-timezone and timestamp checks), and the app's
 * own rows need not pass them: the events editor stores values an upload may
 * not carry. A guests revert failing on an events cell it is not restoring is
 * exactly the failure this avoids.
 */
function readSnapshotEventKeys(
  eventsCsv: string,
): Effect.Effect<SnapshotEventKey[], RevertParseError> {
  return Effect.gen(function* () {
    const [header = [], ...rows] = parseCsv(eventsCsv);
    const headerNorm = header.map(normaliseName);
    const idxName = headerNorm.indexOf(normaliseName("Event Name"));
    if (idxName === -1) {
      return yield* Effect.fail(
        new RevertParseError({ reason: "events snapshot has no Event Name column" }),
      );
    }
    const idxId = headerNorm.indexOf(normaliseName(EVENT_ID_HEADER));
    return rows
      .filter((row) => row.some((cell) => cell.trim().length > 0))
      .map((row) => ({
        name: (row[idxName] ?? "").trim(),
        id: idxId === -1 ? undefined : (nullableString(row[idxId] ?? "") ?? undefined),
      }));
  });
}

/** A before-image's households with attendance renamed to the live schedule. */
interface TranslatedAttendance {
  readonly families: ParsedFamily[];
  /** Every live event some snapshot event resolved to. */
  readonly knownEventIds: ReadonlySet<string>;
}

/**
 * Rewrite a before-image's attendance, which names events as they were called
 * at the checkpoint, to the names the same events carry NOW — for a
 * guests-scoped revert, which reconciles attendance against the live schedule.
 *
 * Each snapshot event resolves to a live event by `Event ID` first, so a rename
 * since the checkpoint is followed. Only when the id is gone does it fall back
 * to the name, as the rest of the revert does — the event was deleted and
 * re-created under the same name since. Each live event is claimed at most once,
 * so a name fallback can never take an event another snapshot event holds by id.
 * An invitation to an event that resolves to nothing is dropped: the event no
 * longer exists, and a guests revert does not bring events back.
 *
 * `knownEventIds` is every live event some snapshot event resolved to. The
 * snapshot is silent about the others — they were created after the checkpoint
 * — so the caller keeps their invitations rather than reading the silence as
 * "nobody was invited".
 */
export function translateAttendance(
  snapshotFamilies: readonly ParsedFamily[],
  snapshotEvents: readonly SnapshotEventKey[],
  liveEvents: readonly { readonly id: string; readonly name: string }[],
): TranslatedAttendance {
  const liveById = new Map(liveEvents.map((e) => [e.id, e]));
  const claimed = new Set<string>();
  const resolved: ({ readonly id: string; readonly name: string } | undefined)[] = [];

  snapshotEvents.forEach((snap, i) => {
    const live = snap.id === undefined ? undefined : liveById.get(snap.id);
    if (live && !claimed.has(live.id)) {
      resolved[i] = live;
      claimed.add(live.id);
    }
  });
  snapshotEvents.forEach((snap, i) => {
    if (resolved[i]) return;
    const norm = normaliseName(snap.name);
    const live = liveEvents.find((e) => !claimed.has(e.id) && normaliseName(e.name) === norm);
    if (live) {
      resolved[i] = live;
      claimed.add(live.id);
    }
  });

  // `parseGuestsCsv` hands back each attendance column as the snapshot event's
  // own name, so the lookup is by that name.
  const liveNameBySnapshotName = new Map<string, string>();
  snapshotEvents.forEach((snap, i) => {
    const live = resolved[i];
    const norm = normaliseName(snap.name);
    if (live && !liveNameBySnapshotName.has(norm)) liveNameBySnapshotName.set(norm, live.name);
  });

  const translated = snapshotFamilies.map((family) => ({
    ...family,
    guests: family.guests.map((guest) => ({
      ...guest,
      eventNames: [
        ...new Set(
          guest.eventNames.flatMap((name) => {
            const live = liveNameBySnapshotName.get(normaliseName(name));
            return live === undefined ? [] : [live];
          }),
        ),
      ],
    })),
  }));
  return { families: translated, knownEventIds: claimed };
}

/**
 * The invitations an events-scoped revert restores: for each event the plan
 * RE-CREATES (it was deleted since the checkpoint), every guest the before-image
 * invited to it who still exists.
 *
 * An events-scoped diff leaves `guest_events` alone, and deleting an event
 * deleted its invitations, so without this an event would come back with nobody
 * invited. Guests are matched by id: a guest deleted and re-added since is a
 * different guest, and one deleted outright stays deleted. An event the diff
 * matched to a live event instead (by id, or by name after being re-created by
 * hand) keeps the invitations it has.
 *
 * Built beside the diff rather than as a diff option, so the diff every preview
 * and apply runs is unchanged. Nothing the diff checks applies to these rows:
 * they add no guest (no capacity check), lose no RSVP (no warning), and are
 * written after the event creates they point at.
 */
function reinviteToRecreatedEvents(
  plan: ImportPlan,
  snapshotEvents: readonly ParsedEvent[],
  guestsCsv: Effect.Effect<string, R2Error, R2Service>,
  weddingId: string,
): Effect.Effect<EventLink[], RevertParseError | R2Error, DbService | R2Service> {
  return Effect.gen(function* () {
    if (plan.eventCreates.length === 0) return [];
    const recreatedIdByName = new Map(
      plan.eventCreates.map((ec) => [normaliseName(ec.event.name), ec.id]),
    );

    const snapshotFamilies = yield* parseGuestsCsv(yield* guestsCsv, snapshotEvents, {
      snapshot: true,
    }).pipe(Effect.mapError(parseFailed("guests")));
    const wanted: EventLink[] = [];
    for (const family of snapshotFamilies) {
      for (const guest of family.guests) {
        if (guest.id === undefined) continue;
        for (const name of guest.eventNames) {
          const eventId = recreatedIdByName.get(normaliseName(name));
          if (eventId !== undefined) wanted.push({ guestId: guest.id, eventId });
        }
      }
    }
    if (wanted.length === 0) return [];

    // The wedding's guests, read wedding-wide through `families` (guests carry
    // no wedding_id) rather than `inArray` over the snapshot's ids, which would
    // run past D1's bound-parameter limit on a large guest list.
    const db = yield* DbService;
    const live = yield* dbQuery(() =>
      db
        .select({ id: guests.id, plusOneOf: guests.plusOneOfGuestId })
        .from(guests)
        .innerJoin(families, eq(guests.familyId, families.id))
        .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
        .all(),
    );
    const liveIds = new Set(live.map((g) => g.id));
    // Plus-ones are not in the snapshot (it holds the organiser's sheet), but
    // one is invited wherever their inviter is, so each re-invitation of an
    // inviter re-invites their live plus-one too.
    const plusOneOf = new Map(
      live.flatMap((g) => (g.plusOneOf === null ? [] : [[g.plusOneOf, g.id] as const])),
    );
    return wanted
      .filter((link) => liveIds.has(link.guestId))
      .flatMap((link) => {
        const plusOneId = plusOneOf.get(link.guestId);
        return plusOneId === undefined
          ? [link]
          : [link, { guestId: plusOneId, eventId: link.eventId }];
      });
  });
}

/**
 * Reconcile the halves of the wedding a change saved back to its before-image.
 *
 *  - `both` — events, households, guests and invitations, all from the snapshot.
 *  - `events` — the schedule only: events added since are removed (with their
 *    invitations and RSVPs), changed ones are changed back, deleted ones are
 *    re-created and their invitations restored for guests who still exist.
 *    No household or guest row is touched.
 *  - `guests` — households, guests and invitations only, against the live
 *    schedule: attendance is translated to today's event names by `Event ID`,
 *    invitations to events deleted since are dropped, and invitations to events
 *    created since are kept.
 *
 * Each restored half is reset to the snapshot, so a row created in that half
 * since the checkpoint is removed. A row that has to be re-created gets a new
 * id; a household keeps its claim code when the code is still free.
 *
 * The two sheets are fetched only where they are read: an events revert that
 * re-creates no event never reads the guests sheet.
 */
function restoreBeforeImage(
  changeId: string,
  weddingId: string,
  scope: ChangeScope,
  keys: { readonly events: string; readonly guests: string },
  finalize: BatchItem<"sqlite">[],
): Effect.Effect<
  ImportSummary,
  RevertParseError | ImportError | CapacityExceeded | R2Error,
  DbService | R2Service
> {
  return Effect.gen(function* () {
    let plan: ImportPlan;
    if (scope === "guests") {
      const [eventsCsv, guestsCsv] = yield* Effect.all(
        [fetchUpload(keys.events), fetchUpload(keys.guests)],
        { concurrency: 2 },
      );
      const snapshotEvents = yield* readSnapshotEventKeys(eventsCsv);
      const snapshotFamilies = yield* parseGuestsCsv(guestsCsv, snapshotEvents, {
        snapshot: true,
      }).pipe(Effect.mapError(parseFailed("guests")));
      const liveEvents = yield* currentEventsAsParsed(weddingId);
      const { families: desired, knownEventIds } = translateAttendance(
        snapshotFamilies,
        snapshotEvents,
        liveEvents.flatMap((e) => (e.id === undefined ? [] : [{ id: e.id, name: e.name }])),
      );
      // See `diffAgainstDb` in reconcileToSnapshot for why `orDie` is right.
      const diffed = yield* diffAgainstDb(liveEvents, desired, weddingId, { scope }).pipe(
        Effect.orDie,
      );
      plan = {
        ...diffed,
        eventLinkRemoves: diffed.eventLinkRemoves.filter((link) => knownEventIds.has(link.eventId)),
      };
    } else if (scope === "events") {
      const snapshotEvents = yield* parseEventsCsv(yield* fetchUpload(keys.events)).pipe(
        Effect.mapError(parseFailed("events")),
      );
      const diffed = yield* diffAgainstDb(snapshotEvents, [], weddingId, { scope }).pipe(
        Effect.orDie,
      );
      const reinvites = yield* reinviteToRecreatedEvents(
        diffed,
        snapshotEvents,
        fetchUpload(keys.guests),
        weddingId,
      );
      plan = { ...diffed, eventLinkCreates: [...diffed.eventLinkCreates, ...reinvites] };
    } else {
      const [eventsCsv, guestsCsv] = yield* Effect.all(
        [fetchUpload(keys.events), fetchUpload(keys.guests)],
        { concurrency: 2 },
      );
      const snapshotEvents = yield* parseEventsCsv(eventsCsv).pipe(
        Effect.mapError(parseFailed("events")),
      );
      const snapshotFamilies = yield* parseGuestsCsv(guestsCsv, snapshotEvents, {
        snapshot: true,
      }).pipe(Effect.mapError(parseFailed("guests")));
      plan = yield* diffAgainstDb(snapshotEvents, snapshotFamilies, weddingId, { scope }).pipe(
        Effect.orDie,
      );
    }
    return yield* applyImport(changeId, plan, weddingId, finalize);
  });
}

/**
 * Revert a change (import or editor save): put back the halves of the wedding
 * it saved — its stored `scope` ({@link storedRevertScope}) — as they were
 * before it was applied.
 *
 * BEFORE-IMAGE PATH (E3, [[guest-event-editor]] §4): when the change row carries
 * a before-image (`beforeEventsR2Key`/`beforeGuestsR2Key`, captured at apply
 * time), reconcile the change's halves to those snapshot CSVs
 * ({@link restoreBeforeImage}). This restores the pre-change state of those
 * halves REGARDLESS of what interleaved between changes (other imports, editor
 * saves) — it is not the "re-apply the previous import's sheets" heuristic.
 * Rows that still exist match by id, so a rename since is undone in place.
 *
 * LEGACY FALLBACK: a row with NO before-image (NULL keys — an import applied
 * before E3, or one whose before-image was pruned) keeps the old behaviour:
 * re-fetch the most-recent-earlier applied import's uploaded sheets and re-apply
 * them — only the sheet for the change's half when its scope names one.
 *
 * Non-goals ([[guest-event-editor]] §4), true of BOTH paths and not claimed
 * otherwise: a revert does not restore cascade-deleted RSVPs, nor the
 * image/crop/location of a re-created event — an id-matched update leaves those
 * columns untouched, and a recreate cannot recover them. The revert plan
 * therefore never asserts it restores them.
 *
 * Failure modes:
 *  - `ChangeNotApplied` — the change is a `preview` or already `reverted`.
 *  - `NoPriorImport` — legacy path only: there is no earlier `applied` import,
 *    or it did not carry the sheet for the change's half.
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
    // Only an applied change has anything to undo. A preview row has no
    // before-image, so it would fall through to the legacy path and reset the
    // wedding to an older import; a reverted row would be restored twice.
    if (current.status !== "applied") {
      return yield* Effect.fail(new ChangeNotApplied({ status: current.status }));
    }
    const scope = storedRevertScope(current.summary);

    // The status flip rides in the reconcile's FINAL batch (applyImport
    // `finalize`), mirroring the apply route: a crash can't leave the wedding
    // reconciled while the row still reads `applied` (which would invite a
    // second, now-wrong revert against the already-restored state).
    const markReverted = [
      db
        .update(imports)
        .set({ status: "reverted", revertedAt: Date.now() })
        .where(and(eq(imports.id, current.id), eq(imports.status, "applied"))),
    ];

    let summary: ImportSummary;
    const hasBeforeImage = Boolean(current.beforeEventsR2Key && current.beforeGuestsR2Key);

    if (current.beforeEventsR2Key && current.beforeGuestsR2Key) {
      // ── Before-image path ──────────────────────────────────────────────────
      summary = yield* restoreBeforeImage(
        current.id,
        weddingId,
        scope,
        { events: current.beforeEventsR2Key, guests: current.beforeGuestsR2Key },
        markReverted,
      );
    } else {
      // ── Legacy fallback ────────────────────────────────────────────────────
      // No before-image: re-apply the most-recent-earlier applied import's
      // uploaded sheets against current DB state. The predicate + ORDER BY +
      // LIMIT 1 replace the old select-all-then-JS-find, which dragged every
      // applied row (incl. the `summary` JSON) out of D1;
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
              // Only a SPREADSHEET row's slots hold CSV. An `editor` row stores a
              // DesiredState JSON blob in the events slot and `""` in the guests
              // slot, which the blank-half inference below would read as a
              // schedule-only snapshot and feed to `parseEventsCsv`. It happens
              // to 422 rather than reconcile (no cell normalises to `Event Name`)
              // — but that is luck, not a type check, and a JSON blob that DID
              // parse would wipe the schedule. This branch is reachable because
              // `pruneBeforeImages` NULLs the before-image keys beyond the most
              // recent 10 changes, pushing ordinary rows onto the legacy path.
              eq(imports.kind, "import"),
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

      // A scoped change replays only its own half. The other slot is passed
      // blank, which the replay reads as "not captured"; a predecessor that did
      // not carry the change's half has nothing to put back.
      const eventsCsv = scope === "guests" ? "" : yield* fetchUpload(prior.eventsR2Key);
      const guestsCsv = scope === "events" ? "" : yield* fetchUpload(prior.guestsR2Key);
      const scopedHalf = scope === "events" ? eventsCsv : scope === "guests" ? guestsCsv : null;
      if (scopedHalf !== null && scopedHalf.trim().length === 0) {
        return yield* Effect.fail(new NoPriorImport({ currentImportId: importId }));
      }
      summary = yield* reconcileToSnapshot(prior.id, weddingId, eventsCsv, guestsCsv, markReverted);
    }

    yield* Effect.logInfo("change reverted", {
      scope,
      path: hasBeforeImage ? "before-image" : "legacy",
    });
    return summary;
  }).pipe(
    Effect.tap(() => Effect.sync(() => metricImportReverted("ok"))),
    Effect.tapError(() => Effect.sync(() => metricImportReverted("error"))),
    Effect.withSpan("cire.import.revert"),
  );
}
