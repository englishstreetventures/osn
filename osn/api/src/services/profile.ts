import {
  accounts,
  blocks,
  closeFriends,
  connections,
  organisations,
  organisationMembers,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import { withProfileCrud } from "../metrics";
import type { AuthService, PublicProfile } from "./auth";

// ---------------------------------------------------------------------------
// Errors (re-exported from auth for convenience)
// ---------------------------------------------------------------------------

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function now(): Date {
  return new Date();
}

const HandleSchema = Schema.String.pipe(
  Schema.filter((s) => /^[a-z0-9_]{1,30}$/.test(s), {
    message: () => "Handle must be 1–30 characters: lowercase letters, numbers, underscores only",
  }),
);

const RESERVED_HANDLES = new Set([
  "me",
  "admin",
  "api",
  "support",
  "help",
  "osn",
  "pulse",
  "messaging",
  "auth",
  "login",
  "logout",
  "register",
  "signup",
  "signin",
  "about",
  "terms",
  "privacy",
  "status",
  "null",
  "undefined",
]);

// ---------------------------------------------------------------------------
// Profile service factory
// ---------------------------------------------------------------------------

export function createProfileService(authService: AuthService) {
  /**
   * Creates a new profile under the account identified by the refresh token.
   * Enforces `maxProfiles` limit (S-L1) and validates handle availability
   * against both user and organisation handles (shared namespace).
   */
  const createProfile = (
    refreshToken: string,
    handle: string,
    displayName?: string,
  ): Effect.Effect<PublicProfile, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      if (RESERVED_HANDLES.has(handle)) {
        return yield* Effect.fail(new AuthError({ message: "Handle is reserved" }));
      }

      const { accountId } = yield* authService.verifyRefreshToken(refreshToken);
      const { db } = yield* Db;

      // Pre-check: account exists + get email/maxProfiles (needed outside txn for return value)
      const accountRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ maxProfiles: accounts.maxProfiles, email: accounts.email })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = accountRows[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }

      const id = genId("usr_");
      const ts = now();
      const dn = displayName ?? null;

      // Atomic check-and-insert inside a transaction (S-H1, S-M2):
      // - maxProfiles count and handle availability are re-checked inside the txn
      // - UNIQUE constraint on users.handle is the final safety net
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            const [profileCount, existingHandle, existingOrgHandle] = await Promise.all([
              tx
                .select({ count: sql<number>`COUNT(*)` })
                .from(users)
                .where(eq(users.accountId, accountId)),
              tx.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1),
              tx
                .select({ id: organisations.id })
                .from(organisations)
                .where(eq(organisations.handle, handle))
                .limit(1),
            ]);

            if (profileCount[0]!.count >= account.maxProfiles) {
              throw new AuthError({ message: "Maximum profiles reached" });
            }
            if (existingHandle.length > 0 || existingOrgHandle.length > 0) {
              throw new AuthError({ message: "Handle already taken" });
            }

            await tx.insert(users).values({
              id,
              accountId,
              handle,
              displayName: dn,
              isDefault: false,
              createdAt: ts,
              updatedAt: ts,
            });
          }),
        catch: (cause) => {
          // Re-throw tagged errors (AuthError thrown inside the txn)
          if (cause instanceof AuthError) return cause;
          // Map UNIQUE constraint violations to a friendly error
          const msg = cause instanceof Error ? cause.message : String(cause);
          if (msg.includes("UNIQUE constraint failed")) {
            return new AuthError({ message: "Handle already taken" });
          }
          return new DatabaseError({ cause });
        },
      });

      return { id, handle, email: account.email, displayName: dn, avatarUrl: null };
    }).pipe(withProfileCrud("create"));

  /**
   * Deletes a profile and cascade-deletes all owned social graph data.
   * Cannot delete the last profile on an account or a profile that owns
   * an organisation (ownership must be transferred first).
   *
   * Cross-DB data (Pulse RSVPs, Zap chat members) is not cleaned up here —
   * orphaned rows are inert. A `profile.deleted` domain event will handle
   * cross-service cleanup in a later phase.
   */
  const deleteProfile = (
    refreshToken: string,
    targetProfileId: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { accountId } = yield* authService.verifyRefreshToken(refreshToken);

      const profile = yield* authService.findProfileById(targetProfileId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }
      if (profile.accountId !== accountId) {
        return yield* Effect.fail(
          new AuthError({ message: "Profile does not belong to this account" }),
        );
      }

      const { db } = yield* Db;

      // Parallel pre-checks: profile count + org ownership
      const [countResult, ownedOrgs] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            db
              .select({ count: sql<number>`COUNT(*)` })
              .from(users)
              .where(eq(users.accountId, accountId)),
            db
              .select({ id: organisations.id })
              .from(organisations)
              .where(eq(organisations.ownerId, targetProfileId))
              .limit(1),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (countResult[0]!.count <= 1) {
        return yield* Effect.fail(new AuthError({ message: "Cannot delete the last profile" }));
      }
      if (ownedOrgs.length > 0) {
        return yield* Effect.fail(
          new AuthError({
            message: "Transfer organisation ownership before deleting this profile",
          }),
        );
      }

      const wasDefault = profile.isDefault;

      // Atomic cascade delete + default-promotion in a single transaction (S-H2, P-W1, P-W2).
      // Independent deletes are parallelised; the profile row delete runs last (FK safety).
      // Default-promotion is inside the txn to prevent an account with no default.
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await Promise.all([
              tx
                .delete(closeFriends)
                .where(
                  or(
                    eq(closeFriends.profileId, targetProfileId),
                    eq(closeFriends.friendId, targetProfileId),
                  ),
                ),
              tx
                .delete(connections)
                .where(
                  or(
                    eq(connections.requesterId, targetProfileId),
                    eq(connections.addresseeId, targetProfileId),
                  ),
                ),
              tx
                .delete(blocks)
                .where(
                  or(eq(blocks.blockerId, targetProfileId), eq(blocks.blockedId, targetProfileId)),
                ),
              tx
                .delete(organisationMembers)
                .where(eq(organisationMembers.profileId, targetProfileId)),
            ]);
            await tx.delete(users).where(eq(users.id, targetProfileId));

            // Promote another profile to default if the deleted one was default
            if (wasDefault) {
              const remaining = await tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.accountId, accountId))
                .orderBy(asc(users.createdAt))
                .limit(1);
              if (remaining.length > 0) {
                await tx
                  .update(users)
                  .set({ isDefault: true, updatedAt: now() })
                  .where(eq(users.id, remaining[0]!.id));
              }
            }
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withProfileCrud("delete"));

  /**
   * Changes which profile is the default for an account. The default profile
   * is used when issuing tokens via `refreshTokens()`.
   */
  const setDefaultProfile = (
    refreshToken: string,
    targetProfileId: string,
  ): Effect.Effect<PublicProfile, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { accountId } = yield* authService.verifyRefreshToken(refreshToken);

      const profile = yield* authService.findProfileById(targetProfileId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }
      if (profile.accountId !== accountId) {
        return yield* Effect.fail(
          new AuthError({ message: "Profile does not belong to this account" }),
        );
      }

      const { db } = yield* Db;
      const ts = now();

      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx
              .update(users)
              .set({ isDefault: false, updatedAt: ts })
              .where(and(eq(users.accountId, accountId), eq(users.isDefault, true)));
            await tx
              .update(users)
              .set({ isDefault: true, updatedAt: ts })
              .where(eq(users.id, targetProfileId));
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return {
        id: profile.id,
        handle: profile.handle,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      };
    }).pipe(withProfileCrud("set_default"));

  return { createProfile, deleteProfile, setDefaultProfile };
}

export type ProfileService = ReturnType<typeof createProfileService>;
