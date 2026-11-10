/**
 * Profile / account lookups shared by every other auth module. Pure reads —
 * no ceremony state, no token material.
 */

import { accounts, users } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { and, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DatabaseError } from "./errors";
import { identifierAsTyped, looksLikeEmail, normaliseIdentifier } from "./helpers";
import type { ProfileWithEmail } from "./types";

/**
 * The query `findProfileById` runs, unrun: the profile, with its account's
 * email and last recovery, for an account not deleted or scheduled for
 * deletion. A statement, so a caller can send it in a batch with others.
 *
 * Flat, and no column name appears twice. D1 answers a batched select keyed
 * by column name, so a select of both tables whole would fold `accounts.id`
 * into the profile's `id` and the account's other columns over the profile's.
 */
export const selectProfileById = (db: DbService["db"], profileId: string) =>
  db
    .select({
      ...getTableColumns(users),
      email: accounts.email,
      lastRecoveredAt: accounts.lastRecoveredAt,
    })
    .from(users)
    .innerJoin(accounts, eq(users.accountId, accounts.id))
    .where(and(eq(users.id, profileId), isNull(accounts.deletedAt)))
    .limit(1);

export function createProfilesModule() {
  const findProfileByEmail = (
    email: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(accounts.email, email))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return {
        ...row.profile,
        email: row.account.email,
        lastRecoveredAt: row.account.lastRecoveredAt,
      };
    });

  /**
   * The profile a sign-in or recovery email names: of the account stored with
   * the address exactly as typed, else of the one stored with it lower-cased,
   * and of that account its default profile. Every email is now written
   * lower-cased, and the database refuses a capital; the typed match keeps an
   * account stored with capitals before that rule signing in by the address
   * as stored, and tells it apart from one whose address differs only in case.
   *
   * The choice is made in the statement's ORDER BY, not from the first rows it
   * returns: the join yields a row per profile, so a LIMIT over unordered rows
   * could hold only the other account's.
   *
   * One statement on every call. Whether it looks up one address or two
   * depends only on whether the typed address has capitals, never on whether
   * an account exists.
   */
  const findProfileBySignInEmail = (
    normalised: string,
    asTyped: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const candidates = asTyped === normalised ? [normalised] : [asTyped, normalised];
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(inArray(accounts.email, candidates))
            .orderBy(desc(sql`${accounts.email} = ${asTyped}`), desc(users.isDefault))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = rows[0];
      if (!row) return null;
      return {
        ...row.profile,
        email: row.account.email,
        lastRecoveredAt: row.account.lastRecoveredAt,
      };
    });

  const findProfileByHandle = (
    handle: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(users.handle, handle))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return {
        ...row.profile,
        email: row.account.email,
        lastRecoveredAt: row.account.lastRecoveredAt,
      };
    });

  /**
   * Tombstoned accounts (`accounts.deleted_at IS NOT NULL`) return
   * `null` so all authenticated routes that gate on this lookup refuse to
   * mutate state during the 7-day grace window. The cancellation /
   * deletion-status routes use {@link findProfileByIdIncludingTombstoned}
   * to read the same row without the gate, so the user can still cancel.
   */
  const findProfileById = (
    profileId: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => selectProfileById(db, profileId),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return result[0] ?? null;
    });

  /**
   * Variant of `findProfileById` that ignores the soft-delete tombstone.
   * Only the cancellation + deletion-status routes should use this; every
   * other route should use `findProfileById` so tombstoned accounts cannot
   * mutate state during the grace window.
   */
  const findProfileByIdIncludingTombstoned = (
    profileId: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(users.id, profileId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return {
        ...row.profile,
        email: row.account.email,
        lastRecoveredAt: row.account.lastRecoveredAt,
      };
    });

  /**
   * Looks up an account row by id. Used by the tombstone gate
   * (`isAccountTombstoned`) to refuse mutating routes when
   * `deletedAt` is set.
   */
  const findAccountById = (
    accountId: string,
  ): Effect.Effect<
    { id: string; deletedAt: number | null; processingRestrictedAt: number | null } | null,
    DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: accounts.id,
              deletedAt: accounts.deletedAt,
              processingRestrictedAt: accounts.processingRestrictedAt,
            })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows[0] ?? null;
    });

  /**
   * Resolves an identifier, as the caller submitted it, to a profile. One
   * containing "@" once normalised is an email address; any other is a handle.
   * Normalises it here, with the same {@link normaliseIdentifier} every caller
   * derives its store keys from.
   */
  const resolveIdentifier = (
    identifier: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> => {
    const normalised = normaliseIdentifier(identifier);
    return looksLikeEmail(normalised)
      ? findProfileBySignInEmail(normalised, identifierAsTyped(identifier))
      : findProfileByHandle(normalised);
  };

  /**
   * Finds the default profile for an account. Uses DESC ordering on isDefault
   * so the default profile sorts first (true=1 before false=0), then takes
   * limit(1). Falls back to the first profile if none has isDefault=true.
   */
  const findDefaultProfile = (
    accountId: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(users.accountId, accountId))
            .orderBy(desc(users.isDefault))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return {
        ...row.profile,
        email: row.account.email,
        lastRecoveredAt: row.account.lastRecoveredAt,
      };
    });

  return {
    findProfileByEmail,
    findProfileByHandle,
    findProfileById,
    findProfileByIdIncludingTombstoned,
    findAccountById,
    resolveIdentifier,
    findDefaultProfile,
  };
}

export type ProfilesModule = ReturnType<typeof createProfilesModule>;
