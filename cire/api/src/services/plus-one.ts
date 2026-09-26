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
 *    permission.
 *
 * The change pipeline (spreadsheet upload, editor save, revert) never matches,
 * edits or removes a plus-one directly; see `diffAgainstDb`.
 *
 * TENANCY: the guest half is keyed on the session's `familyId` — the inviter
 * must be a member of that household, and every write is scoped by it. The
 * organiser half re-checks, in wedding scope, that the guest or household
 * belongs to `weddingId` and is not the host-preview family.
 */
import { families, guestEvents, guests, weddings } from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import type { Db, ReturningTail } from "../db";
import { DbService, commitBatch, commitGroupedBatchesReturning, dbQuery } from "../db";
import { isRsvpClosed } from "../lib/rsvp-deadline";
import { metricPlusOneBlocked, metricPlusOneChanged, metricPlusOnePermissionSet } from "../metrics";
import type { CapacityExceeded } from "./entitlements";
import { entitlementService } from "./entitlements";

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
 *  1. The guest row, skipped (`ON CONFLICT DO NOTHING` on the one-per-guest
 *     index) when a plus-one of this inviter already exists — a double submit
 *     that raced past the caller's read.
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
      .onConflictDoNothing({ target: guests.plusOneOfGuestId }),
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
 * The household's own row plus its wedding's deadline, and the inviter with
 * their current plus-one — the two reads every guest write needs, run
 * together. Both are keyed on the session's `familyId`; the inviter read also
 * on the path's guest id, which is only trusted once it is found IN that
 * household.
 */
function readGuestContext(familyId: string, inviterGuestId: string) {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const plusOne = alias(guests, "plus_one");
    const [[household], [inviter]] = yield* Effect.all(
      [
        dbQuery(() =>
          db
            .select({
              kind: families.kind,
              weddingId: families.weddingId,
              rsvpDeadline: weddings.rsvpDeadline,
              rsvpDeadlineTimezone: weddings.rsvpDeadlineTimezone,
            })
            .from(families)
            .innerJoin(weddings, eq(weddings.id, families.weddingId))
            .where(eq(families.id, familyId))
            .all(),
        ),
        dbQuery(() =>
          db
            .select({
              id: guests.id,
              sortOrder: guests.sortOrder,
              plusOneAllowed: guests.plusOneAllowed,
              plusOneOf: guests.plusOneOfGuestId,
              plusOneId: plusOne.id,
              plusOneFirstName: plusOne.firstName,
              plusOneLastName: plusOne.lastName,
            })
            .from(guests)
            .leftJoin(plusOne, eq(plusOne.plusOneOfGuestId, guests.id))
            .where(and(eq(guests.id, inviterGuestId), eq(guests.familyId, familyId)))
            .all(),
        ),
      ],
      { concurrency: "unbounded" },
    );

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
    if (!inviter) return yield* Effect.fail(new PlusOneGuestNotFound());
    if (inviter.plusOneOf !== null) return yield* Effect.fail(new PlusOneCannotInvite());
    return { weddingId: household.weddingId, inviter };
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
      const { weddingId, inviter } = yield* readGuestContext(familyId, inviterGuestId);
      if (!inviter.plusOneAllowed) {
        yield* Effect.sync(() => metricPlusOneBlocked("not_allowed"));
        return yield* Effect.fail(new PlusOneNotAllowed());
      }
      const clean = cleanName(name);
      const now = new Date();
      const tail = buildPlusOneReadBack(db, inviterGuestId) as ReturningTail<PlusOneRow>;

      if (inviter.plusOneId !== null) {
        // Rename. An unchanged name writes nothing.
        const unchanged =
          inviter.plusOneFirstName === clean.firstName &&
          inviter.plusOneLastName === clean.lastName;
        const rows = yield* dbQuery(() =>
          commitGroupedBatchesReturning<PlusOneRow>(
            db,
            unchanged
              ? []
              : [
                  [
                    db
                      .update(guests)
                      .set({ firstName: clean.firstName, lastName: clean.lastName, updatedAt: now })
                      .where(
                        and(
                          eq(guests.plusOneOfGuestId, inviterGuestId),
                          eq(guests.familyId, familyId),
                        ),
                      ),
                  ],
                ],
            tail,
          ),
        );
        const plusOne = toRecord(rows, inviterGuestId);
        // Removed between the read and the write: nothing to rename.
        if (!plusOne) return yield* Effect.fail(new PlusOneGuestNotFound());
        if (!unchanged) yield* Effect.sync(() => metricPlusOneChanged("renamed", "guest"));
        return { plusOne, created: false };
      }

      // A new guest row: it counts against the wedding's cap like any other.
      yield* entitlementService
        .assertGuestCapacity(weddingId, 1)
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
              sortOrder: inviter.sortOrder,
              name: clean,
              now,
            }),
          ],
          tail,
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
      yield* readGuestContext(familyId, inviterGuestId);
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
      const [[household], members] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({ id: families.id })
              .from(families)
              .where(
                and(
                  eq(families.id, familyId),
                  eq(families.weddingId, weddingId),
                  ne(families.kind, "host"),
                ),
              )
              .all(),
          ),
          dbQuery(() =>
            db
              .select({ id: guests.id, plusOneOf: guests.plusOneOfGuestId })
              .from(guests)
              .where(eq(guests.familyId, familyId))
              .all(),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (!household) return yield* Effect.fail(new PlusOneFamilyNotFound());

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
