import { emailSuppressions, families, guests } from "@cire/db";
import { GUEST_EMAIL_CONSENT } from "@cire/guest-email";
import { and, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitBatch, DbService, dbQuery } from "../db";
import { metricGuestEmailChanged } from "../metrics";
import type { MemberEmail } from "../schemas/claim";
import {
  hashGuestEmail,
  holdsOwnOptOut,
  suppressCurrentStatement,
  suppressReplacedStatement,
  unsuppressOwnStatement,
} from "./email-suppression";

// A guest's own address, given or removed on the invite
// (`PUT` / `DELETE /api/claim/member/email`).
//
// The seat is the member the household session chose ("Who are you?"): a
// household gives an address only for the member it says is at the keyboard,
// never for another, and the address rests on that word, as every reply does.
// A plus-one is never a chosen member, so never has an address.

/**
 * The most opt-outs one seat may hold before it may give no new address.
 * Each removal of a different address adds a row, as does replacing an address
 * the hosts added, so without a cap one household session could grow the
 * wedding's suppression list without end. A guest reaches it only by
 * withdrawing this many different addresses, and at it may still give back one
 * they withdrew, which removes a row.
 */
export const MAX_OPT_OUTS_PER_SEAT = 10;

/** Why the seat cannot take an address. Each maps to one refusal. */
export type SeatRefusal =
  /** A host preview household: not a guest seat. */
  | "not_a_guest"
  /** The wedding is kept out of the member step while account linking is off. */
  | "member_step_off"
  /** The session has not said who is answering. */
  | "member_required"
  /** The body names a member the session no longer holds. */
  | "member_changed";

export class GuestEmailSeatRefused extends Data.TaggedError("GuestEmailSeatRefused")<{
  readonly reason: SeatRefusal;
}> {}

/** The seat holds {@link MAX_OPT_OUTS_PER_SEAT} opt-outs and the address is not one it withdrew. */
export class GuestEmailTooManyChanges extends Data.TaggedError("GuestEmailTooManyChanges") {}

export class GuestEmailWriteError extends Data.TaggedError("GuestEmailWriteError")<{
  readonly cause: unknown;
}> {}

export interface SeatRequest {
  /** The session's household. */
  readonly familyId: string;
  /** The member the session chose, or null. */
  readonly sessionMember: string | null;
  /** The member the page showed, from the body. */
  readonly bodyMember: string;
  /**
   * The weddings kept out of the member step right now (empty while linking
   * is on). A promise, so the flag read overlaps the seat read.
   */
  readonly memberStepOff: Promise<ReadonlySet<string>>;
  /**
   * Whether to count the seat's opt-outs, which only a save reads
   * ({@link CountedSeat}). A removal leaves it out and reads no count.
   */
  readonly countOptOuts?: boolean;
}

/** The chosen member's seat, resolved once per request. */
export interface Seat {
  readonly guestId: string;
  readonly weddingId: string;
  readonly email: string | null;
}

/** A seat about to take an address: its opt-outs counted up to the cap. */
export interface CountedSeat extends Seat {
  /**
   * How many opt-outs this seat has made, counted no further than
   * {@link MAX_OPT_OUTS_PER_SEAT}: the save asks only whether it is there.
   */
  readonly optOuts: number;
}

/**
 * The chosen member's seat, after every check the routes refuse on, in order.
 * One read: the household, and the member's row when the session has one and
 * it is a choosable member of this household, with its opt-outs counted when
 * the request asks.
 */
function resolveSeat(
  request: SeatRequest & { readonly countOptOuts: true },
): Effect.Effect<CountedSeat, GuestEmailSeatRefused, DbService>;
function resolveSeat(request: SeatRequest): Effect.Effect<Seat, GuestEmailSeatRefused, DbService>;
function resolveSeat(
  request: SeatRequest,
): Effect.Effect<Seat | CountedSeat, GuestEmailSeatRefused, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const refuse = (reason: SeatRefusal) => Effect.fail(new GuestEmailSeatRefused({ reason }));
    const member = request.sessionMember ?? "";
    const [row] = yield* dbQuery(() =>
      db
        .select({
          kind: families.kind,
          weddingId: families.weddingId,
          guestId: guests.id,
          email: guests.email,
          // Bounded: the count stops at the cap, the one value the save
          // compares it with. Keyed by the session's member, the only seat
          // this read can answer for.
          optOuts:
            request.countOptOuts === true
              ? sql<number>`(select count(*) from (select 1 from ${emailSuppressions} where ${emailSuppressions.guestId} = ${member} limit ${MAX_OPT_OUTS_PER_SEAT}))`
              : sql<null>`null`,
        })
        .from(families)
        .leftJoin(
          guests,
          and(
            eq(guests.familyId, families.id),
            eq(guests.id, member),
            sql`${guests.plusOneOfGuestId} IS NULL`,
          ),
        )
        .where(eq(families.id, request.familyId))
        .all(),
    );
    const memberStepOff = yield* Effect.promise(() => request.memberStepOff);
    if (!row || row.kind !== "guest") return yield* refuse("not_a_guest");
    if (memberStepOff.has(row.weddingId)) return yield* refuse("member_step_off");
    if (request.sessionMember === null || row.guestId === null) {
      return yield* refuse("member_required");
    }
    if (request.bodyMember !== request.sessionMember) return yield* refuse("member_changed");
    const seat: Seat = { guestId: row.guestId, weddingId: row.weddingId, email: row.email };
    return request.countOptOuts === true ? { ...seat, optOuts: Number(row.optOuts ?? 0) } : seat;
  });
}

export const guestEmailService = {
  resolveSeat,

  /** A household member's own stored address, or undefined for none (or a
   *  guest outside `familyId`). One read. */
  memberEmail(
    familyId: string,
    guestId: string,
  ): Effect.Effect<MemberEmail | undefined, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select({ address: guests.email, source: guests.emailSource })
          .from(guests)
          .where(and(eq(guests.id, guestId), eq(guests.familyId, familyId)))
          .all(),
      );
      return row !== undefined && row.address !== null && row.source !== null
        ? { address: row.address, source: row.source }
        : undefined;
    });
  },

  /**
   * Store `address` (already normalised and valid) as the seat's own, under
   * the guest's consent, in one batch: record an address the hosts added that
   * this one replaces as the seat's opt-out (`guest_corrected`), write the
   * address, and clear the opt-out this seat made for the same address.
   * Another seat's opt-out stays. Once the seat holds
   * {@link MAX_OPT_OUTS_PER_SEAT} opt-outs it may give back only an address it
   * withdrew itself, which takes one away.
   */
  setOwn(
    seat: CountedSeat,
    address: string,
  ): Effect.Effect<MemberEmail, GuestEmailTooManyChanges | GuestEmailWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const emailHash = yield* Effect.promise(() => hashGuestEmail(seat.weddingId, address));
      if (seat.optOuts >= MAX_OPT_OUTS_PER_SEAT) {
        const givesOwnBack = yield* holdsOwnOptOut({
          weddingId: seat.weddingId,
          emailHash,
          guestId: seat.guestId,
        });
        if (!givesOwnBack) return yield* Effect.fail(new GuestEmailTooManyChanges());
      }
      const now = new Date();
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            // Before the address changes, so it reads the one being replaced.
            suppressReplacedStatement(db, {
              weddingId: seat.weddingId,
              guestId: seat.guestId,
              replacementHash: emailHash,
              now,
            }),
            db
              .update(guests)
              .set({
                email: address,
                emailHash,
                emailSource: "guest",
                emailConsentAt: now,
                emailConsentVersion: GUEST_EMAIL_CONSENT.version,
                emailAttestedByOsnProfileId: null,
                updatedAt: now,
              })
              .where(eq(guests.id, seat.guestId)),
            unsuppressOwnStatement(db, {
              weddingId: seat.weddingId,
              emailHash,
              guestId: seat.guestId,
            }),
          ]),
        catch: (cause) => new GuestEmailWriteError({ cause }),
      });
      metricGuestEmailChanged("guest", "set");
      return { address, source: "guest" as const };
    }).pipe(Effect.withSpan("cire.guest_email.set"));
  },

  /**
   * Remove the seat's address and record its opt-out, in one batch: whoever
   * supplied the address, the guest's removal stops mail to it for the
   * wedding. The opt-out takes the address the row holds when the batch runs,
   * so an organiser's change that lands between the seat read and the batch is
   * the one recorded and cleared. Removing a seat with no address changes
   * nothing.
   */
  removeOwn(seat: Seat): Effect.Effect<void, GuestEmailWriteError, DbService> {
    return Effect.gen(function* () {
      if (seat.email === null) return;
      const db = yield* DbService;
      const now = new Date();
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            suppressCurrentStatement(db, {
              weddingId: seat.weddingId,
              guestId: seat.guestId,
              now,
            }),
            db
              .update(guests)
              .set({
                email: null,
                emailHash: null,
                emailSource: null,
                emailConsentAt: null,
                emailConsentVersion: null,
                emailAttestedByOsnProfileId: null,
                updatedAt: now,
              })
              .where(eq(guests.id, seat.guestId)),
          ]),
        catch: (cause) => new GuestEmailWriteError({ cause }),
      });
      metricGuestEmailChanged("guest", "cleared");
    }).pipe(Effect.withSpan("cire.guest_email.clear"));
  },
};
