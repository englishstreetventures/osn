/**
 * Profile / account lookups shared by every other auth module. Pure reads —
 * no ceremony state, no token material.
 */

import { accounts, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import { DatabaseError } from "./errors";
import { looksLikeEmail } from "./helpers";
import type { ProfileWithEmail } from "./types";

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
      return { ...row.profile, email: row.account.email };
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
      return { ...row.profile, email: row.account.email };
    });

  /**
   * S-H4: tombstoned accounts (`accounts.deleted_at IS NOT NULL`) return
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
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(and(eq(users.id, profileId), isNull(accounts.deletedAt)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return { ...row.profile, email: row.account.email };
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
      return { ...row.profile, email: row.account.email };
    });

  /**
   * Looks up an account row by id. Used by the tombstone gate
   * (S-H4 — `isAccountTombstoned`) to refuse mutating routes when
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
   * Resolves a (normalised) identifier to a profile.
   * Identifiers containing "@" are treated as email addresses; all others as handles.
   */
  const resolveIdentifier = (
    identifier: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    looksLikeEmail(identifier) ? findProfileByEmail(identifier) : findProfileByHandle(identifier);

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
      return { ...row.profile, email: row.account.email };
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
