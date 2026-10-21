import { families, guests } from "@cire/db";
import { GUEST_EMAIL_CONSENT } from "@cire/guest-email";
import { and, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitBatch, DbService, dbQuery } from "../db";
import { metricGuestEmailChanged } from "../metrics";
import type { MemberEmail } from "../schemas/claim";
import { hashGuestEmail, suppressStatement, unsuppressOwnStatement } from "./email-suppression";

// A guest's own address, given or removed on the invite
// (`PUT` / `DELETE /api/claim/member/email`).
//
// The seat is the member the household session chose ("Who are you?"): a
// household gives an address only for the member it says is at the keyboard,
// never for another, and the address rests on that word, as every reply does.
// A plus-one is never a chosen member, so never has an address.

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
  /** Weddings kept out of the member step right now (empty while linking is on). */
  readonly memberStepOff: ReadonlySet<string>;
}

interface Seat {
  readonly guestId: string;
  readonly weddingId: string;
  readonly email: string | null;
}

/** The chosen member's seat, after every check the routes refuse on, in order. */
function resolveSeat(request: SeatRequest): Effect.Effect<Seat, GuestEmailSeatRefused, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const refuse = (reason: SeatRefusal) => Effect.fail(new GuestEmailSeatRefused({ reason }));
    // One read: the household, and the member's row when the session has one
    // and it is a choosable member of this household.
    const [row] = yield* dbQuery(() =>
      db
        .select({
          kind: families.kind,
          weddingId: families.weddingId,
          guestId: guests.id,
          email: guests.email,
        })
        .from(families)
        .leftJoin(
          guests,
          and(
            eq(guests.familyId, families.id),
            eq(guests.id, request.sessionMember ?? ""),
            sql`${guests.plusOneOfGuestId} IS NULL`,
          ),
        )
        .where(eq(families.id, request.familyId))
        .all(),
    );
    if (!row || row.kind !== "guest") return yield* refuse("not_a_guest");
    if (request.memberStepOff.has(row.weddingId)) return yield* refuse("member_step_off");
    if (request.sessionMember === null || row.guestId === null) {
      return yield* refuse("member_required");
    }
    if (request.bodyMember !== request.sessionMember) return yield* refuse("member_changed");
    return { guestId: row.guestId, weddingId: row.weddingId, email: row.email };
  });
}

export const guestEmailService = {
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

  /** Refuse as the writes would, without writing: the route checks the seat
   *  before it says anything about the address. */
  checkSeat(request: SeatRequest): Effect.Effect<void, GuestEmailSeatRefused, DbService> {
    return resolveSeat(request).pipe(Effect.asVoid);
  },

  /**
   * Store `address` (already normalised and valid) as the chosen member's
   * own, under the guest's consent. Replaces any address on the seat, an
   * organiser's included, and clears the opt-out this seat made for the same
   * address, in one batch. Another seat's opt-out stays.
   */
  setOwn(
    request: SeatRequest,
    address: string,
  ): Effect.Effect<MemberEmail, GuestEmailSeatRefused | GuestEmailWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const seat = yield* resolveSeat(request);
      const emailHash = yield* Effect.promise(() => hashGuestEmail(seat.weddingId, address));
      const now = new Date();
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db
              .update(guests)
              .set({
                email: address,
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
   * Remove the chosen member's address and record their opt-out for it, in
   * one batch: whoever supplied the address, the guest's removal stops mail
   * to it for the wedding. Removing a seat with no address changes nothing.
   */
  removeOwn(
    request: SeatRequest,
  ): Effect.Effect<void, GuestEmailSeatRefused | GuestEmailWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const seat = yield* resolveSeat(request);
      if (seat.email === null) return;
      const email = seat.email;
      const emailHash = yield* Effect.promise(() => hashGuestEmail(seat.weddingId, email));
      const now = new Date();
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db
              .update(guests)
              .set({
                email: null,
                emailSource: null,
                emailConsentAt: null,
                emailConsentVersion: null,
                emailAttestedByOsnProfileId: null,
                updatedAt: now,
              })
              .where(eq(guests.id, seat.guestId)),
            suppressStatement(db, {
              weddingId: seat.weddingId,
              emailHash,
              guestId: seat.guestId,
              now,
            }),
          ]),
        catch: (cause) => new GuestEmailWriteError({ cause }),
      });
      metricGuestEmailChanged("guest", "cleared");
    }).pipe(Effect.withSpan("cire.guest_email.clear"));
  },
};
