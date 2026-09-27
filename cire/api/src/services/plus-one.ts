/**
 * Plus-ones ([[wiki/cire/cire-plus-ones]]). A plus-one is an ordinary `guests`
 * row whose `plus_one_of_guest_id` names the guest who brought them: same
 * household, invited to that guest's events, one per guest. Nothing else can
 * carry an RSVP, a dietary answer or an invitation, so nothing else would do.
 *
 * Two principals write here, and each owns one half:
 *
 *  - **An editor co-host owns the permission** (`guests.plus_one_allowed`), per
 *    guest or for a whole household. Turning it off where a plus-one is named
 *    is refused unless the caller also asks for that plus-one to be removed, so
 *    deleting a guest's data is never a side effect of a switch.
 *  - **The household owns the plus-one**: it names, renames and removes them
 *    through the invite, until the RSVP deadline, and only for a member who has
 *    permission. An editor may also correct the name, at any time — after the
 *    deadline it is the only way to (Art. 16 rectification).
 *
 * The change pipeline (spreadsheet upload, editor save, revert) never matches,
 * edits or removes a plus-one directly; see `diffAgainstDb`.
 *
 * TENANCY: the guest half is keyed on the session's `familyId` — the inviter
 * must be a member of that household, and every write is scoped by it. The
 * organiser half re-checks, in wedding scope, that the guest or household
 * belongs to `weddingId` and is not the host-preview family.
 */
import { families, guestEvents, guests, weddingEntitlements, weddings } from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import type { Db, ReturningTail } from "../db";
import { DbService, commitBatch, commitGroupedBatchesReturning, dbQuery } from "../db";
import { isRsvpClosed } from "../lib/rsvp-deadline";
import { metricPlusOneBlocked, metricPlusOneChanged, metricPlusOnePermissionSet } from "../metrics";
import type { CapacityExceeded } from "./entitlements";
import { CAPACITY_ENTITLEMENT_KEYS, entitlementService } from "./entitlements";

// ── Errors ──────────────────────────────────────────────────────────────────

/** The session's household no longer exists. 403-class, like the RSVP write. */
export class PlusOneHouseholdGone extends Data.TaggedError("PlusOneHouseholdGone") {}
/** The session is the organiser's host preview, which never writes. 403-class. */
export class PlusOnePreview extends Data.TaggedError("PlusOnePreview") {}
/** The wedding's RSVP-by date has passed. 403-class, `rsvp_closed`. */
export class PlusOneRsvpClosed extends Data.TaggedError("PlusOneRsvpClosed") {}
/** The guest is not in this household (guest path) or not in this wedding's
 *  guest households (organiser path). 404-class. */
export class PlusOneGuestNotFound extends Data.TaggedError("PlusOneGuestNotFound") {}
/** The household is not one of this wedding's guest households. 404-class. */
export class PlusOneFamilyNotFound extends Data.TaggedError("PlusOneFamilyNotFound") {}
/** The guest is themselves a plus-one, who cannot bring one. 409-class. */
export class PlusOneCannotInvite extends Data.TaggedError("PlusOneCannotInvite") {}
/** The guest has no permission to bring a plus-one. 403-class. */
export class PlusOneNotAllowed extends Data.TaggedError("PlusOneNotAllowed") {}
/** The guest has no plus-one named. 404-class. */
export class PlusOneNotFound extends Data.TaggedError("PlusOneNotFound") {}
/** Permission off was asked for where a plus-one is named, without asking for
 *  them to be removed. 409-class. */
export class PlusOneNamed extends Data.TaggedError("PlusOneNamed")<{ named: number }> {}

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A plus-one as the household reads it back. */
export interface PlusOneRecord {
  guestId: string;
  firstName: string;
  lastName: string;
  /** The guest who brought them. */
  plusOneOf: string;
  /** The events they are invited to — their inviter's. */
  eventIds: string[];
}

export interface PlusOneName {
  firstName: string;
  lastName: string;
}

/** One row of {@link buildPlusOneReadBack}: the plus-one, once per invitation. */
interface PlusOneRow {
  guestId: string;
  firstName: string;
  lastName: string;
  plusOneOf: string | null;
  eventId: string | null;
}

/**
 * The plus-one of `inviterGuestId`, one row per invitation (a LEFT JOIN, so a
 * plus-one of an inviter with no events still comes back). Unexecuted, so it
 * can ride as the trailing read of a write batch.
 */
function buildPlusOneReadBack(db: Db, inviterGuestId: string) {
  return db
    .select({
      guestId: guests.id,
      firstName: guests.firstName,
      lastName: guests.lastName,
      plusOneOf: guests.plusOneOfGuestId,
      eventId: guestEvents.eventId,
    })
    .from(guests)
    .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
    .where(eq(guests.plusOneOfGuestId, inviterGuestId));
}

function toRecord(rows: readonly PlusOneRow[], inviterGuestId: string): PlusOneRecord | null {
  const [first] = rows;
  if (!first) return null;
  return {
    guestId: first.guestId,
    firstName: first.firstName,
    lastName: first.lastName,
    plusOneOf: first.plusOneOf ?? inviterGuestId,
    eventIds: rows.flatMap((r) => (r.eventId === null ? [] : [r.eventId])),
  };
}

/**
 * The statements that name a new plus-one, as ONE group so they commit in one
 * D1 batch:
 *
 *  1. The guest row, skipped (`ON CONFLICT DO NOTHING`) when a plus-one of this
 *     inviter already exists — a double submit that raced past the caller's
 *     read. The id is a fresh UUID, so the one-per-guest index is the only
 *     constraint it can meet; the conflict takes no target because a target
 *     cannot name a partial index.
 *  2. The inviter's invitations, copied by reading them in the same batch. The
 *     select reaches the new id only through a JOIN on the row statement 1 just
 *     wrote, so when statement 1 was skipped this copies nothing, rather than
 *     pointing links at a guest that does not exist.
 *
 * Exported for the test that drives the skipped path directly: bun:sqlite runs
 * statements one at a time, so a real race cannot be staged there.
 */
export function buildCreatePlusOne(
  db: Db,
  input: {
    newId: string;
    inviterGuestId: string;
    familyId: string;
    sortOrder: number;
    name: PlusOneName;
    now: Date;
  },
): BatchItem<"sqlite">[] {
  const plusOne = alias(guests, "plus_one");
  return [
    db
      .insert(guests)
      .values({
        id: input.newId,
        familyId: input.familyId,
        firstName: input.name.firstName,
        lastName: input.name.lastName,
        // Beside their inviter; the claim payload places them right after.
        sortOrder: input.sortOrder,
        source: "manual",
        plusOneAllowed: false,
        plusOneOfGuestId: input.inviterGuestId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing(),
    db.insert(guestEvents).select(
      db
        .select({ guestId: plusOne.id, eventId: guestEvents.eventId })
        .from(guestEvents)
        .innerJoin(
          plusOne,
          and(eq(plusOne.id, input.newId), eq(plusOne.plusOneOfGuestId, guestEvents.guestId)),
        )
        .where(eq(guestEvents.guestId, input.inviterGuestId)),
    ),
  ];
}

/** Trim both halves of a guest-typed name — the schema has already bounded
 *  and checked them. */
function cleanName(name: PlusOneName): PlusOneName {
  return { firstName: name.firstName.trim(), lastName: name.lastName.trim() };
}

/**
 * Everything a guest write needs, in ONE statement keyed on the session's
 * `familyId`: the household, its wedding's deadline, the inviter (only when
 * they are IN that household — the path's guest id is trusted no further), the
 * inviter's current plus-one with their invitations (one row per invitation),
 * and whether the wedding holds either capacity entitlement. Every join is by
 * primary key or a unique index, so folding them costs nothing, and a
 * guest-facing write pays one round trip for its context instead of four.
 */
function readGuestContext(familyId: string, inviterGuestId: string) {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const inviter = alias(guests, "inviter");
    const plusOneRow = alias(guests, "plus_one");
    const holds = (key: (typeof CAPACITY_ENTITLEMENT_KEYS)[number]) =>
      sql<number>`EXISTS (SELECT 1 FROM ${weddingEntitlements} WHERE ${weddingEntitlements.weddingId} = ${families.weddingId} AND ${weddingEntitlements.entitlement} = ${key})`;
    const rows = yield* dbQuery(() =>
      db
        .select({
          kind: families.kind,
          weddingId: families.weddingId,
          rsvpDeadline: weddings.rsvpDeadline,
          rsvpDeadlineTimezone: weddings.rsvpDeadlineTimezone,
          inviterId: inviter.id,
          inviterSortOrder: inviter.sortOrder,
          inviterAllowed: inviter.plusOneAllowed,
          inviterPlusOneOf: inviter.plusOneOfGuestId,
          plusOneId: plusOneRow.id,
          plusOneFirstName: plusOneRow.firstName,
          plusOneLastName: plusOneRow.lastName,
          plusOneEventId: guestEvents.eventId,
          capacity500: holds("capacity_500"),
          capacity1000: holds("capacity_1000"),
        })
        .from(families)
        .innerJoin(weddings, eq(weddings.id, families.weddingId))
        .leftJoin(inviter, and(eq(inviter.id, inviterGuestId), eq(inviter.familyId, families.id)))
        .leftJoin(plusOneRow, eq(plusOneRow.plusOneOfGuestId, inviter.id))
        .leftJoin(guestEvents, eq(guestEvents.guestId, plusOneRow.id))
        .where(eq(families.id, familyId))
        .all(),
    );
    const [household] = rows;

    // Fail closed on a missing household, as the RSVP write does: both gates
    // below read it, and a missing row must not answer "allow" to either.
    if (!household) return yield* Effect.fail(new PlusOneHouseholdGone());
    if (household.kind === "host") {
      yield* Effect.sync(() => metricPlusOneBlocked("preview"));
      return yield* Effect.fail(new PlusOnePreview());
    }
    // Same predicate and same instant as the RSVP write, so the invite locks
    // the plus-one prompt exactly when it locks the replies.
    if (isRsvpClosed(household.rsvpDeadline, household.rsvpDeadlineTimezone, new Date())) {
      yield* Effect.sync(() => metricPlusOneBlocked("deadline"));
      return yield* Effect.fail(new PlusOneRsvpClosed());
    }
    if (household.inviterId === null) return yield* Effect.fail(new PlusOneGuestNotFound());
    if (household.inviterPlusOneOf !== null) return yield* Effect.fail(new PlusOneCannotInvite());

    const plusOne: PlusOneRecord | null =
      household.plusOneId === null
        ? null
        : {
            guestId: household.plusOneId,
            firstName: household.plusOneFirstName ?? "",
            lastName: household.plusOneLastName ?? "",
            plusOneOf: inviterGuestId,
            eventIds: rows.flatMap((r) => (r.plusOneEventId === null ? [] : [r.plusOneEventId])),
          };
    const capKeys = [
      ...(household.capacity500 ? ["capacity_500"] : []),
      ...(household.capacity1000 ? ["capacity_1000"] : []),
    ];
    return {
      weddingId: household.weddingId,
      inviter: {
        sortOrder: household.inviterSortOrder ?? 0,
        plusOneAllowed: household.inviterAllowed === true,
      },
      plusOne,
      cap: entitlementService.deriveCap(capKeys),
    };
  });
}

/**
 * Write a new name onto an existing plus-one, and answer with the record as
 * the caller already read it. The UPDATE is scoped by the plus-one's own id and
 * checked by its change count: a plus-one removed since the read changes no row,
 * and answers {@link PlusOneNotFound}.
 */
function writeName(
  plusOne: PlusOneRecord,
  scope: SQL | undefined,
  clean: PlusOneName,
): Effect.Effect<{ plusOne: PlusOneRecord; changed: boolean }, PlusOneNotFound, DbService> {
  return Effect.gen(function* () {
    if (plusOne.firstName === clean.firstName && plusOne.lastName === clean.lastName) {
      return { plusOne, changed: false };
    }
    const db = yield* DbService;
    const result = yield* dbQuery(() =>
      db
        .update(guests)
        .set({ firstName: clean.firstName, lastName: clean.lastName, updatedAt: new Date() })
        .where(and(eq(guests.id, plusOne.guestId), scope))
        .run(),
    );
    if (rowsChanged(result) === 0) return yield* Effect.fail(new PlusOneNotFound());
    return { plusOne: { ...plusOne, ...clean }, changed: true };
  });
}

export const plusOneService = {
  /**
   * Name the plus-one of `inviterGuestId`, or rename the one already named.
   * `created` says which. A new plus-one takes a place under the wedding's
   * guest cap, and is invited to the inviter's events.
   */
  save(
    familyId: string,
    inviterGuestId: string,
    name: PlusOneName,
  ): Effect.Effect<
    { plusOne: PlusOneRecord; created: boolean },
    | PlusOneHouseholdGone
    | PlusOnePreview
    | PlusOneRsvpClosed
    | PlusOneGuestNotFound
    | PlusOneCannotInvite
    | PlusOneNotAllowed
    | CapacityExceeded,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const context = yield* readGuestContext(familyId, inviterGuestId);
      if (!context.inviter.plusOneAllowed) {
        yield* Effect.sync(() => metricPlusOneBlocked("not_allowed"));
        return yield* Effect.fail(new PlusOneNotAllowed());
      }
      const clean = cleanName(name);

      if (context.plusOne !== null) {
        // Rename. An unchanged name writes nothing. Removed since the read:
        // nothing left to rename.
        const renamed = yield* writeName(
          context.plusOne,
          eq(guests.familyId, familyId),
          clean,
        ).pipe(Effect.catchTag("PlusOneNotFound", () => Effect.fail(new PlusOneGuestNotFound())));
        if (renamed.changed) yield* Effect.sync(() => metricPlusOneChanged("renamed", "guest"));
        return { plusOne: renamed.plusOne, created: false };
      }

      // A new guest row: it counts against the wedding's cap like any other.
      // The cap comes from the context read, so only the count is a new query.
      yield* entitlementService
        .assertGuestCapacity(context.weddingId, 1, context.cap)
        .pipe(Effect.tapError(() => Effect.sync(() => metricPlusOneBlocked("capacity"))));

      const newId = crypto.randomUUID();
      const rows = yield* dbQuery(() =>
        commitGroupedBatchesReturning<PlusOneRow>(
          db,
          [
            buildCreatePlusOne(db, {
              newId,
              inviterGuestId,
              familyId,
              sortOrder: context.inviter.sortOrder,
              name: clean,
              now: new Date(),
            }),
          ],
          buildPlusOneReadBack(db, inviterGuestId) as ReturningTail<PlusOneRow>,
        ),
      );
      const plusOne = toRecord(rows, inviterGuestId);
      if (!plusOne) return yield* Effect.die(new Error("plus-one read-back returned no row"));
      // Another submit named one first: theirs stands, and this reads as a
      // rename that did not happen rather than a second plus-one.
      const created = plusOne.guestId === newId;
      if (created) yield* Effect.sync(() => metricPlusOneChanged("added", "guest"));
      return { plusOne, created };
    }).pipe(Effect.withSpan("cire.plus_one.save"));
  },

  /**
   * Remove the plus-one of `inviterGuestId`, with their replies and invitations
   * (the FK cascade). `removed: false` when there was none — the call is
   * idempotent. Needs no permission: a guest may always take a plus-one back.
   */
  remove(
    familyId: string,
    inviterGuestId: string,
  ): Effect.Effect<
    { removed: boolean },
    | PlusOneHouseholdGone
    | PlusOnePreview
    | PlusOneRsvpClosed
    | PlusOneGuestNotFound
    | PlusOneCannotInvite,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const context = yield* readGuestContext(familyId, inviterGuestId);
      // Nothing named: the read already says so, and the DELETE would match
      // nothing.
      if (context.plusOne === null) return { removed: false };
      const result = yield* dbQuery(() =>
        db
          .delete(guests)
          .where(and(eq(guests.plusOneOfGuestId, inviterGuestId), eq(guests.familyId, familyId)))
          .run(),
      );
      const removed = rowsChanged(result) > 0;
      if (removed) yield* Effect.sync(() => metricPlusOneChanged("removed", "guest"));
      return { removed };
    }).pipe(Effect.withSpan("cire.plus_one.remove"));
  },

  /**
   * Correct the name of the plus-one `inviterGuestId` brought, as an editor.
   * Not gated by the RSVP deadline or the permission: after the deadline the
   * household can no longer rename them, and a controller must still be able
   * to correct a name (Art. 16).
   */
  renameAsOrganiser(input: {
    weddingId: string;
    inviterGuestId: string;
    name: PlusOneName;
  }): Effect.Effect<{ plusOne: PlusOneRecord }, PlusOneNotFound, DbService> {
    const { weddingId, inviterGuestId } = input;
    return Effect.gen(function* () {
      const db = yield* DbService;
      const clean = cleanName(input.name);
      // The plus-one of this guest, with their invitations, in one of this
      // wedding's guest households.
      const rows: PlusOneRow[] = yield* dbQuery(() =>
        db
          .select({
            guestId: guests.id,
            firstName: guests.firstName,
            lastName: guests.lastName,
            plusOneOf: guests.plusOneOfGuestId,
            eventId: guestEvents.eventId,
          })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .leftJoin(guestEvents, eq(guestEvents.guestId, guests.id))
          .where(
            and(
              eq(guests.plusOneOfGuestId, inviterGuestId),
              eq(families.weddingId, weddingId),
              eq(families.kind, "guest"),
            ),
          )
          .all(),
      );
      const current = toRecord(rows, inviterGuestId);
      if (!current) return yield* Effect.fail(new PlusOneNotFound());
      const renamed = yield* writeName(current, undefined, clean);
      if (renamed.changed) yield* Effect.sync(() => metricPlusOneChanged("renamed", "organiser"));
      return { plusOne: renamed.plusOne };
    }).pipe(Effect.withSpan("cire.plus_one.renameAsOrganiser"));
  },

  /**
   * Set one guest's permission. Turning it off where their plus-one is named
   * fails {@link PlusOneNamed} unless `removePlusOne` is set, in which case the
   * plus-one goes in the same batch as the switch.
   */
  setGuestPermission(input: {
    weddingId: string;
    guestId: string;
    allowed: boolean;
    removePlusOne: boolean;
  }): Effect.Effect<
    { guestId: string; plusOneAllowed: boolean; plusOneRemoved: boolean },
    PlusOneGuestNotFound | PlusOneCannotInvite | PlusOneNamed,
    DbService
  > {
    const { weddingId, guestId, allowed, removePlusOne } = input;
    return Effect.gen(function* () {
      const db = yield* DbService;
      const plusOne = alias(guests, "plus_one");
      // Guest ∈ this wedding's guest households: the join to `families` scopes
      // the lookup and excludes the host-preview family.
      const [row] = yield* dbQuery(() =>
        db
          .select({ plusOneOf: guests.plusOneOfGuestId, plusOneId: plusOne.id })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .leftJoin(plusOne, eq(plusOne.plusOneOfGuestId, guests.id))
          .where(
            and(
              eq(guests.id, guestId),
              eq(families.weddingId, weddingId),
              eq(families.kind, "guest"),
            ),
          )
          .all(),
      );
      if (!row) return yield* Effect.fail(new PlusOneGuestNotFound());
      if (row.plusOneOf !== null) return yield* Effect.fail(new PlusOneCannotInvite());

      const removing = !allowed && row.plusOneId !== null;
      if (removing && !removePlusOne) return yield* Effect.fail(new PlusOneNamed({ named: 1 }));

      const statements: BatchItem<"sqlite">[] = [
        db
          .update(guests)
          .set({ plusOneAllowed: allowed, updatedAt: new Date() })
          .where(eq(guests.id, guestId)),
      ];
      if (removing) statements.push(db.delete(guests).where(eq(guests.plusOneOfGuestId, guestId)));
      yield* dbQuery(() => commitBatch(db, statements));

      yield* Effect.sync(() => {
        metricPlusOnePermissionSet("guest", allowed);
        if (removing) metricPlusOneChanged("removed", "organiser");
      });
      return { guestId, plusOneAllowed: allowed, plusOneRemoved: removing };
    }).pipe(Effect.withSpan("cire.plus_one.setGuestPermission"));
  },

  /**
   * Set the permission for every member of a household (its plus-ones, who
   * cannot bring one, are skipped). The same removal rule as
   * {@link setGuestPermission}, household-wide: turning it off where any
   * plus-one is named needs `removePlusOnes`.
   */
  setHouseholdPermission(input: {
    weddingId: string;
    familyId: string;
    allowed: boolean;
    removePlusOnes: boolean;
  }): Effect.Effect<
    { familyId: string; plusOneAllowed: boolean; guestsUpdated: number; plusOnesRemoved: number },
    PlusOneFamilyNotFound | PlusOneNamed,
    DbService
  > {
    const { weddingId, familyId, allowed, removePlusOnes } = input;
    return Effect.gen(function* () {
      const db = yield* DbService;
      // The household, in wedding scope and not the host preview, with its
      // members — one statement. A household with no members still answers
      // once, with a NULL member.
      const rows = yield* dbQuery(() =>
        db
          .select({ memberId: guests.id, plusOneOf: guests.plusOneOfGuestId })
          .from(families)
          .leftJoin(guests, eq(guests.familyId, families.id))
          .where(
            and(
              eq(families.id, familyId),
              eq(families.weddingId, weddingId),
              ne(families.kind, "host"),
            ),
          )
          .all(),
      );
      if (rows.length === 0) return yield* Effect.fail(new PlusOneFamilyNotFound());
      const members = rows.filter((r) => r.memberId !== null);

      const guestsUpdated = members.filter((m) => m.plusOneOf === null).length;
      const named = members.length - guestsUpdated;
      const removing = !allowed && named > 0;
      if (removing && !removePlusOnes) return yield* Effect.fail(new PlusOneNamed({ named }));

      const statements: BatchItem<"sqlite">[] = [
        db
          .update(guests)
          .set({ plusOneAllowed: allowed, updatedAt: new Date() })
          .where(and(eq(guests.familyId, familyId), isNull(guests.plusOneOfGuestId))),
      ];
      if (removing) {
        statements.push(
          db
            .delete(guests)
            .where(and(eq(guests.familyId, familyId), isNotNull(guests.plusOneOfGuestId))),
        );
      }
      yield* dbQuery(() => commitBatch(db, statements));

      yield* Effect.sync(() => {
        metricPlusOnePermissionSet("household", allowed);
        if (removing) metricPlusOneChanged("removed", "organiser", named);
      });
      return {
        familyId,
        plusOneAllowed: allowed,
        guestsUpdated,
        plusOnesRemoved: removing ? named : 0,
      };
    }).pipe(Effect.withSpan("cire.plus_one.setHouseholdPermission"));
  },
};
