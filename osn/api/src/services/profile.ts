import {
  accounts,
  blocks,
  connections,
  organisations,
  organisationMembers,
  users,
} from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { commitBatch, driverErrorText, rowsChanged } from "@shared/db-utils";
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Data, Effect, Schema } from "effect";

import { bound } from "../lib/bound";
import { handleArms } from "../lib/handle-hold";
import { withProfileCrud } from "../metrics";
import type { AuthService, PublicProfile } from "./auth";
import { DELETED_HANDLE_PREFIX } from "./auth/constants";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

class ValidationError extends Data.TaggedError("ValidationError")<{
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

const HandleSchema = Schema.String.check(
  Schema.makeFilter((s) =>
    /^[a-z0-9_]{1,30}$/.test(s)
      ? undefined
      : "Handle must be 1–30 characters: lowercase letters, numbers, underscores only",
  ),
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
  // The dev sign-in principal — see `routes/auth/dev-login.ts` and the copy of
  // this set in `services/auth/constants.ts`.
  "dev_bootstrap",
  // Its organisation. Org creation consults this same set, so neither name can
  // be squatted before provisioning runs.
  "dev_bootstrap_org",
]);

// ---------------------------------------------------------------------------
// Profile service factory
// ---------------------------------------------------------------------------

export function createProfileService(authService: AuthService) {
  /**
   * Creates a new profile under the given account.
   * Enforces `maxProfiles` limit and validates handle availability
   * against both user and organisation handles (shared namespace).
   */
  const createProfile = (
    accountId: string,
    handle: string,
    displayName?: string,
  ): Effect.Effect<PublicProfile, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      // The prefix is the form the soft delete gives a profile (`isReservedHandle`).
      if (RESERVED_HANDLES.has(handle) || handle.startsWith(DELETED_HANDLE_PREFIX)) {
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
      // race-safe guard — a concurrent create racing the same handle
      // hits the constraint and is mapped to "Handle already taken" below. The
      // maxProfiles count check is best-effort: a rare simultaneous double-create
      // could exceed the cap by one, which is not security-sensitive. A handle
      // a deleted account holds answers as a taken one.
      const [profileCount, spokenFor] = yield* Effect.tryPromise({
        try: () => {
          const [profile, organisation, hold] = handleArms(
            db,
            authService.heldHandleDigest,
            handle,
          );
          return Promise.all([
            db
              .select({ count: sql<number>`COUNT(*)` })
              .from(users)
              .where(eq(users.accountId, accountId)),
            unionAll(profile, organisation, hold),
          ]);
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (profileCount[0]!.count >= account.maxProfiles) {
        return yield* Effect.fail(new AuthError({ message: "Maximum profiles reached" }));
      }
      if (spokenFor.length > 0) {
        return yield* Effect.fail(new AuthError({ message: "Handle already taken" }));
      }

      // Selected from the account row while its deletion is not pending: a
      // soft delete that commits after the reads above, whose redaction and
      // holds cannot see this profile, leaves nothing for this insert to write.
      const inserted = yield* Effect.tryPromise({
        try: () =>
          db.insert(users).select(
            db
              .select({
                id: bound(id, users.id),
                accountId: bound(accountId, users.accountId),
                handle: bound(handle, users.handle),
                displayName: bound(dn, users.displayName),
                isDefault: bound(false, users.isDefault),
                createdAt: bound(ts, users.createdAt),
                updatedAt: bound(ts, users.updatedAt),
              })
              .from(accounts)
              .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt))),
          ),
        catch: (cause) => {
          // UNIQUE constraint is the final safety net against a handle race.
          const msg = driverErrorText(cause);
          if (msg.includes("UNIQUE constraint failed")) {
            return new AuthError({ message: "Handle already taken" });
          }
          return new DatabaseError({ cause });
        },
      });
      if (rowsChanged(inserted) === 0) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }

      return { id, handle, email: account.email, displayName: dn, avatarUrl: null };
    }).pipe(withProfileCrud("create"));

  /**
   * Deletes a profile and cascade-deletes all owned social graph data.
   * Cannot delete the last profile on an account or a profile that owns
   * an organisation (the organisation must be deleted first).
   *
   * Returns the account's default profile once this one is gone: the default
   * as it was, or, when the deleted profile was the default or the account
   * had none, the oldest remaining profile, made the default here. A client
   * that deleted the profile it was acting as names this one in its next
   * grant.
   *
   * Cross-DB data (Pulse RSVPs, Zap chat members) is not cleaned up here —
   * orphaned rows are inert. A `profile.deleted` domain event will handle
   * cross-service cleanup in a later phase.
   */
  const deleteProfile = (
    accountId: string,
    targetProfileId: string,
  ): Effect.Effect<{ defaultProfileId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      // Parallel pre-checks: the target, the account's default once the
      // target is gone, and org ownership. The second read is the account's
      // other default profile, else its oldest other profile; none means the
      // target is the last. All three are keyed on what the caller sent, so
      // they run together and the refusals below apply in order afterwards.
      // They run BEFORE the write batch — D1 has no interactive transaction,
      // so the read-then-write is split, and a delete or default change
      // landing in between can make them stale.
      const [profile, [successors, ownedOrgs]] = yield* Effect.all(
        [
          authService.findProfileById(targetProfileId),
          Effect.tryPromise({
            try: () =>
              Promise.all([
                db
                  .select({ id: users.id, isDefault: users.isDefault })
                  .from(users)
                  .where(and(eq(users.accountId, accountId), ne(users.id, targetProfileId)))
                  .orderBy(desc(users.isDefault), asc(users.createdAt))
                  .limit(1),
                db
                  .select({ id: organisations.id })
                  .from(organisations)
                  .where(eq(organisations.ownerId, targetProfileId))
                  .limit(1),
              ]),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: "unbounded" },
      );

      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }
      if (profile.accountId !== accountId) {
        return yield* Effect.fail(
          new AuthError({ message: "Profile does not belong to this account" }),
        );
      }
      const successor = successors[0];
      if (!successor) {
        return yield* Effect.fail(new AuthError({ message: "Cannot delete the last profile" }));
      }
      if (ownedOrgs.length > 0) {
        return yield* Effect.fail(
          new AuthError({
            message: "Delete the organisations this profile owns before deleting it",
          }),
        );
      }

      // Not the default yet only when the target was the default, or the
      // account had none: promoted in the same batch as the delete, which
      // keeps "account always has a default" atomic on D1 (the batch is
      // all-or-nothing).
      const promoteId = successor.isDefault ? undefined : successor.id;

      // Atomic cascade delete + default-promotion. Child rows
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
      return { defaultProfileId: successor.id };
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
