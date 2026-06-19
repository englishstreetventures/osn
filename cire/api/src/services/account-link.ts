import { families, guestAccountLinks, guests } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";

/** The requested guest does not belong to the session's family (or is unknown). */
export class GuestNotInFamily extends Data.TaggedError("GuestNotInFamily")<{
  reason: "unknown_guest";
}> {}

/**
 * The link would violate a uniqueness invariant.
 *
 * AL-S-L2: the conflicting index is deliberately NOT distinguished. Two
 * distinct UNIQUE constraints can fail here — `guest_id` (this invitee already
 * linked an account) and `(family_id, osn_account_id)` (some OSN account is
 * already seated elsewhere in this household). Surfacing them separately let a
 * caller probe sibling-seat membership of their own household (a membership
 * oracle). Both collapse to a single opaque `already_linked` reason so the two
 * cases are indistinguishable end-to-end (same tag → same 409 → same body).
 */
export class AccountLinkConflict extends Data.TaggedError("AccountLinkConflict")<{
  reason: "already_linked";
}> {}

export class AccountLinkWriteError extends Data.TaggedError("AccountLinkWriteError")<{
  op: "insert" | "delete";
  reason: string;
}> {}

export interface CreatedAccountLink {
  guestId: string;
  linkedAt: Date;
}

/** Per-guest link status surfaced to the owning household (no account id). */
export interface FamilyAccountLink {
  guestId: string;
  osnProfileId: string;
  linkedAt: Date;
}

/** Reverse-lookup row for the Pulse feed integration (account → invitations). */
export interface AccountLinkByAccount {
  guestId: string;
  familyId: string;
  weddingId: string;
  linkedAt: Date;
}

/**
 * Detects a SQLite UNIQUE-constraint failure on either account-link index.
 * Exported so the brittle string-matching is pinned by a direct unit test,
 * independent of the SQLite driver's exact error wording (T-S2).
 *
 * AL-S-L2: returns a single opaque `"already_linked"` for BOTH conflicting
 * indexes — `guest_id` (this invitee already linked) and
 * `(family_id, osn_account_id)` (some account already seated in this household).
 * The two are intentionally not distinguished so the caller can't probe
 * sibling-seat membership of their own household.
 */
export function conflictReason(message: string): AccountLinkConflict["reason"] | null {
  if (!message.includes("UNIQUE constraint failed")) return null;
  // Either the `guest_id` UNIQUE or the `(family_id, osn_account_id)` UNIQUE —
  // both collapse to the same opaque reason (membership-oracle defence).
  if (message.includes("osn_account_id") || message.includes("guest_id")) {
    return "already_linked";
  }
  return null;
}

export const accountLinkService = {
  /**
   * Links an invitee (`guestId`, validated to belong to `familyId`) to an OSN
   * account. The `weddingId` is derived from the guest's family — never trusted
   * from the caller — so the denormalised tenant column can't be spoofed.
   *
   * Conflicts (a UNIQUE index violation) are caught from the insert rather than
   * pre-checked, so concurrent links can't race past a check-then-insert gap.
   */
  link(input: {
    familyId: string;
    guestId: string;
    osnAccountId: string;
    osnProfileId: string;
  }): Effect.Effect<
    CreatedAccountLink,
    GuestNotInFamily | AccountLinkConflict | AccountLinkWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;

      // Guest must exist AND belong to the session's family. The join yields the
      // wedding id for the tenant-scope column in one query.
      const [scope] = yield* dbQuery(() =>
        db
          .select({ weddingId: families.weddingId })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .where(and(eq(guests.id, input.guestId), eq(guests.familyId, input.familyId)))
          .all(),
      );
      if (!scope) {
        return yield* Effect.fail(new GuestNotInFamily({ reason: "unknown_guest" }));
      }

      const now = new Date();
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(guestAccountLinks)
              .values({
                id: `gal_${crypto.randomUUID()}`,
                guestId: input.guestId,
                familyId: input.familyId,
                weddingId: scope.weddingId,
                osnAccountId: input.osnAccountId,
                osnProfileId: input.osnProfileId,
                linkedAt: now,
                updatedAt: now,
              })
              .run(),
          ),
        catch: (e) => {
          const message = String(e);
          const reason = conflictReason(message);
          return reason
            ? new AccountLinkConflict({ reason })
            : new AccountLinkWriteError({ op: "insert", reason: message });
        },
      }).pipe(
        Effect.tapError((err) =>
          err._tag === "AccountLinkConflict"
            ? Effect.logWarning("account link conflict", { reason: err.reason })
            : Effect.logError("account link insert failed", { reason: err.reason }),
        ),
      );

      return { guestId: input.guestId, linkedAt: now };
    }).pipe(Effect.withSpan("cire.accountLink.link"));
  },

  /** Lists the account links for every invitee in a household. */
  listByFamily(familyId: string): Effect.Effect<FamilyAccountLink[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            guestId: guestAccountLinks.guestId,
            osnProfileId: guestAccountLinks.osnProfileId,
            linkedAt: guestAccountLinks.linkedAt,
          })
          .from(guestAccountLinks)
          .where(eq(guestAccountLinks.familyId, familyId))
          .all(),
      );
      return rows;
    }).pipe(Effect.withSpan("cire.accountLink.listByFamily"));
  },

  /**
   * Removes an invitee's account link. Scoped to `(familyId, guestId)` so a
   * session can only unlink invitees in its own household. Idempotent: removing
   * a link that isn't there succeeds.
   */
  unlink(input: {
    familyId: string;
    guestId: string;
  }): Effect.Effect<void, AccountLinkWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .delete(guestAccountLinks)
              .where(
                and(
                  eq(guestAccountLinks.familyId, input.familyId),
                  eq(guestAccountLinks.guestId, input.guestId),
                ),
              )
              .run(),
          ),
        catch: (e) => new AccountLinkWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("account link delete failed", { reason: err.reason }),
        ),
      );
    }).pipe(Effect.withSpan("cire.accountLink.unlink"));
  },

  /**
   * Reverse lookup: every invitee linked to an OSN account, across all
   * households/weddings. Feeds the (future) Pulse integration that surfaces a
   * user's invitations. account id is the S2S correlation key and never leaves
   * the server, so this is keyed by it but does not echo it back.
   */
  listByAccount(osnAccountId: string): Effect.Effect<AccountLinkByAccount[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            guestId: guestAccountLinks.guestId,
            familyId: guestAccountLinks.familyId,
            weddingId: guestAccountLinks.weddingId,
            linkedAt: guestAccountLinks.linkedAt,
          })
          .from(guestAccountLinks)
          .where(eq(guestAccountLinks.osnAccountId, osnAccountId))
          .all(),
      );
      return rows;
    }).pipe(Effect.withSpan("cire.accountLink.listByAccount"));
  },
};
