import { accounts, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";

/**
 * Profile → account-address lookup, for the internal ARC route only.
 *
 * The caller is cire-api's retention sweep: when a wedding's guest data reaches
 * the end of its retained year, cire deletes the per-gift detail and mails the
 * couple the aggregate it kept. cire stores the owning OSN PROFILE id
 * (`weddings.owner_osn_profile_id`, `usr_*`) and no address of its own, so the
 * address has to come from here.
 *
 * The lookup takes profile ids and does the users→accounts join internally, so
 * no `acc_*` id ever crosses the boundary (`wiki/compliance/gdpr.md`: the
 * account id never leaves the auth boundary). It answers with a bare array of
 * the pairs it CAN answer for, and says nothing at all about the rest:
 *
 *   - profile id unknown            → omitted
 *   - account soft-deleted   → omitted
 *   - joined row has no address     → omitted
 *
 * All three look identical to the caller, so the route is not an enumeration
 * oracle for "does this profile exist". That indistinguishability is the whole
 * reason this is an omit-list rather than a per-id `{ found: false }`.
 */

export class AccountEmailDbError extends Data.TaggedError("AccountEmailDbError")<{
  readonly cause: unknown;
}> {}

/**
 * Hard ceiling on ids per call. Two jobs: it keeps the query well under
 * SQLite's 999-variable limit (same reasoning as MAX_BATCH_PROFILE_IDS in
 * graph-internal.ts), and it bounds how much address material one token can
 * pull per request. The route enforces it in TypeBox so an over-cap body is
 * rejected before any row is read; this slice is the belt to that braces.
 */
export const MAX_EMAIL_LOOKUP_IDS = 100;

/** One answered pair. Only ever built for a live account with an address. */
export interface ProfileEmail {
  readonly profileId: string;
  readonly email: string;
}

/**
 * Resolves profile ids to the address of the account that owns each.
 *
 * Deduplicates and caps before touching the database — a caller repeating one
 * id 100 times gets one row back, and pays for one.
 */
export const lookupProfileEmails = (
  profileIds: readonly string[],
): Effect.Effect<readonly ProfileEmail[], AccountEmailDbError, Db> =>
  Effect.gen(function* () {
    const ids = [...new Set(profileIds)].slice(0, MAX_EMAIL_LOOKUP_IDS);
    if (ids.length === 0) return [];

    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ profileId: users.id, email: accounts.email })
          .from(users)
          .innerJoin(accounts, eq(users.accountId, accounts.id))
          .where(
            and(
              inArray(users.id, ids),
              // A tombstoned account is mid-erasure. Mailing it would be
              // the erasure undone, and answering for it would leak that it
              // once existed.
              isNull(accounts.deletedAt),
            ),
          ),
      catch: (cause) => new AccountEmailDbError({ cause }),
    });

    return rows.filter((r) => r.email.length > 0);
  });
