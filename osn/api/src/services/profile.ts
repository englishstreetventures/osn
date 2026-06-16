import {
  accounts,
  blocks,
  connections,
  organisations,
  organisationMembers,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch } from "@shared/db-utils";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
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
   * Creates a new profile under the given account.
   * Enforces `maxProfiles` limit (S-L1) and validates handle availability
   * against both user and organisation handles (shared namespace).
   */
  const createProfile = (
    accountId: string,
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

      // Check-and-insert. D1 has no interactive transaction, so the pre-checks
      // run as one read and the create as one write. The UNIQUE constraint on
      // users.handle (mirrored against organisations.handle) is the authoritative,
      // race-safe guard (S-H1, S-M2) — a concurrent create racing the same handle
      // hits the constraint and is mapped to "Handle already taken" below. The
      // maxProfiles count check is best-effort: a rare simultaneous double-create
      // could exceed the cap by one, which is not security-sensitive.
      const [profileCount, existingHandle, existingOrgHandle] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            db
              .select({ count: sql<number>`COUNT(*)` })
              .from(users)
              .where(eq(users.accountId, accountId)),
            db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1),
            db
              .select({ id: organisations.id })
              .from(organisations)
              .where(eq(organisations.handle, handle))
              .limit(1),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (profileCount[0]!.count >= account.maxProfiles) {
        return yield* Effect.fail(new AuthError({ message: "Maximum profiles reached" }));
      }
      if (existingHandle.length > 0 || existingOrgHandle.length > 0) {
        return yield* Effect.fail(new AuthError({ message: "Handle already taken" }));
      }

      yield* Effect.tryPromise({
        try: () =>
          db.insert(users).values({
            id,
            accountId,
            handle,
            displayName: dn,
            isDefault: false,
            createdAt: ts,
            updatedAt: ts,
          }),
        catch: (cause) => {
          // UNIQUE constraint is the final safety net against a handle race.
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
    accountId: string,
    targetProfileId: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
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

      // When the deleted profile was the default, pick its successor (oldest
      // remaining profile) BEFORE the write batch — D1 has no interactive
      // transaction, so the read-then-write is split. Including the promotion
      // update in the same batch keeps "account always has a default" atomic on
      // D1 (the batch is all-or-nothing).
      let promoteId: string | undefined;
      if (wasDefault) {
        const remaining = yield* Effect.tryPromise({
          try: () =>
            db
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.accountId, accountId), ne(users.id, targetProfileId)))
              .orderBy(asc(users.createdAt))
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        promoteId = remaining[0]?.id;
      }

      // Atomic cascade delete + default-promotion (S-H2, P-W1, P-W2). Child rows
      // are deleted before the profile row (FK safety); the promotion update (if
      // any) runs last. Atomic batch on D1, sequential on bun:sqlite.
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db
              .delete(connections)
              .where(
                or(
                  eq(connections.requesterId, targetProfileId),
                  eq(connections.addresseeId, targetProfileId),
                ),
              ),
            db
              .delete(blocks)
              .where(
                or(eq(blocks.blockerId, targetProfileId), eq(blocks.blockedId, targetProfileId)),
              ),
            db
              .delete(organisationMembers)
              .where(eq(organisationMembers.profileId, targetProfileId)),
            db.delete(users).where(eq(users.id, targetProfileId)),
            ...(promoteId
              ? [
                  db
                    .update(users)
                    .set({ isDefault: true, updatedAt: now() })
                    .where(eq(users.id, promoteId)),
                ]
              : []),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withProfileCrud("delete"));

  /**
   * Changes which profile is the default for an account. The default profile
   * is used when issuing tokens via `refreshTokens()`.
   */
  const setDefaultProfile = (
    accountId: string,
    targetProfileId: string,
  ): Effect.Effect<PublicProfile, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
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
        // Clear the current default then set the new one — pure writes, no read.
        // Atomic batch on D1, sequential on bun:sqlite.
        try: () =>
          commitBatch(db, [
            db
              .update(users)
              .set({ isDefault: false, updatedAt: ts })
              .where(and(eq(users.accountId, accountId), eq(users.isDefault, true))),
            db
              .update(users)
              .set({ isDefault: true, updatedAt: ts })
              .where(eq(users.id, targetProfileId)),
          ]),
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
