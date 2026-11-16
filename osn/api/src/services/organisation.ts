import { accounts, organisations, organisationMembers, users } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { commitBatch, driverErrorText, rowsChanged } from "@shared/db-utils";
import { and, eq, exists, gt, isNotNull, sql } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";

import { canBatch } from "../lib/batch";
import { bound } from "../lib/bound";
import { handleArms, type HeldHandleDigest } from "../lib/handle-hold";
import { withOrgMemberOp, withOrgOp } from "../metrics";
import { isReservedHandle } from "./auth/constants";
import { OWNERSHIP_DECLINE_WINDOW_SECONDS, successorRow } from "./organisation-succession";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `message` reaches clients verbatim via the routes' `safeError` allowlist —
// construct with static string literals only, never interpolated
// causes or user input. Pinned by tests/lib/safe-error-static-messages.test.ts.
class OrgError extends Data.TaggedError("OrgError")<{
  readonly message: string;
}> {}

class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {}

class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListOptions {
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function now(): Date {
  return new Date();
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 100);
}

// ---------------------------------------------------------------------------
// Organisation service factory
// ---------------------------------------------------------------------------

/** A second name for `organisation_members`, for a statement that reads the caller's own row. */
const callerMembership = alias(organisationMembers, "caller_membership");

/**
 * True while `profileId` is an admin of `orgId`: a condition a write carries,
 * so the write holds only while the caller's admin row does.
 */
const adminOf = (db: DbService["db"], orgId: string, profileId: string) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(callerMembership)
      .where(
        and(
          eq(callerMembership.organisationId, orgId),
          eq(callerMembership.profileId, profileId),
          eq(callerMembership.role, "admin"),
        ),
      ),
  );

/** A second name for `organisations`, for a statement on another table that reads the owner. */
const ownedOrganisation = alias(organisations, "owned_organisation");

/**
 * True while `profileId` still owns `orgId`: a condition a write carries, so
 * the write holds only while the caller is the owner it read. An owner can
 * change between a read and a write: the hard delete of the owner's account,
 * and a decline by a member who received it by succession, each hand it on.
 */
const ownerOf = (db: DbService["db"], orgId: string, profileId: string) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(ownedOrganisation)
      .where(and(eq(ownedOrganisation.id, orgId), eq(ownedOrganisation.ownerId, profileId))),
  );

/** What a decline did, or why it did nothing. */
export type DeclineOwnershipResult =
  /** Passed to the next owner, whose address the notice goes to (null when none is on file). */
  | {
      readonly outcome: "passed";
      readonly handle: string;
      readonly newOwnerEmail: string | null;
      readonly declineUntil: number;
    }
  /** No other member from another account: the organisation and its memberships are gone. */
  | { readonly outcome: "deleted" }
  /** The caller does not own it. */
  | { readonly outcome: "not_owner" }
  /** The caller owns it, but not by succession inside the last 30 days. */
  | { readonly outcome: "not_declinable" }
  /** No organisation has the handle. */
  | { readonly outcome: "not_found" };

/** Whether the caller may decline an organisation now; see `declineOwnershipStatus`. */
export type DeclineOwnershipStatus =
  /** The caller owns it by succession; a decline is open until `declineUntil` (seconds). */
  | { readonly outcome: "declinable"; readonly declineUntil: number }
  | { readonly outcome: "not_owner" }
  | { readonly outcome: "not_declinable" }
  | { readonly outcome: "not_found" };

export interface OrganisationServiceOptions {
  /**
   * The `handle_holds` digest (`auth.heldHandleDigest`). `createOrganisation`
   * needs it and dies without it; a service that never creates, such as the
   * internal organisation routes', is built without it.
   */
  readonly heldHandleDigest?: HeldHandleDigest;
}

export function createOrganisationService({ heldHandleDigest }: OrganisationServiceOptions = {}) {
  // -------------------------------------------------------------------------
  // Reads a refused write uses to answer as its checks would now
  // -------------------------------------------------------------------------

  const readOrganisation = (orgId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      return yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: organisations.id, ownerId: organisations.ownerId })
            .from(organisations)
            .where(eq(organisations.id, orgId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  const readAdmin = (orgId: string, profileId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      return yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: organisationMembers.id })
            .from(organisationMembers)
            .where(
              and(
                eq(organisationMembers.organisationId, orgId),
                eq(organisationMembers.profileId, profileId),
                eq(organisationMembers.role, "admin"),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  const readMembership = (orgId: string, profileId: string) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      return yield* Effect.tryPromise({
        try: () =>
          db
            .select({ role: organisationMembers.role })
            .from(organisationMembers)
            .where(
              and(
                eq(organisationMembers.organisationId, orgId),
                eq(organisationMembers.profileId, profileId),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  // -------------------------------------------------------------------------
  // Organisation CRUD
  // -------------------------------------------------------------------------

  const createOrganisation = (
    ownerId: string,
    handle: string,
    name: string,
    description?: string,
  ): Effect.Effect<typeof organisations.$inferSelect, OrgError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // A service built without the digest cannot see holds, so it creates
      // nothing rather than skip the check.
      if (!heldHandleDigest) {
        return yield* Effect.die(new Error("createOrganisation needs the heldHandleDigest option"));
      }
      const { db } = yield* Db;

      // Org handles live in the same namespace as profile handles — creation
      // cross-checks both tables below — so the reserved list applies here too.
      // Without this, `admin`, `api` or the dev-login principal's handles are
      // takeable as an organisation. Same generic message as a collision:
      // don't confirm which names exist.
      if (isReservedHandle(handle)) {
        return yield* Effect.fail(new OrgError({ message: "Handle unavailable" }));
      }

      // Both pre-insert checks at once: whether the handle is spoken for (a
      // profile, an organisation, or a hold left by a deleted account, in one
      // statement) and whether the owner exists.
      const [spokenFor, ownerRows] = yield* Effect.tryPromise({
        try: () => {
          const [profile, organisation, hold] = handleArms(db, heldHandleDigest, handle);
          return Promise.all([
            unionAll(profile, organisation, hold),
            db.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).limit(1),
          ]);
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      // Use generic message to avoid confirming handle existence
      if (spokenFor.length > 0) {
        return yield* Effect.fail(new OrgError({ message: "Handle unavailable" }));
      }

      if (ownerRows.length === 0) {
        return yield* Effect.fail(new OrgError({ message: "Owner not found" }));
      }

      const ts = now();
      const orgId = genId("org_");
      const desc = description ?? null;

      // Insert org + owner-as-admin atomically. The handle pre-checks above are
      // best-effort (D1 has no interactive transaction); the UNIQUE constraint on
      // organisations.handle is the race-safe guard, mapped to a generic message
      // (don't confirm handle existence). Atomic batch on D1, sequential
      // on bun:sqlite.
      yield* Effect.tryPromise({
        try: () =>
          commitBatch(db, [
            db.insert(organisations).values({
              id: orgId,
              handle,
              name,
              description: desc,
              avatarUrl: null,
              ownerId,
              createdAt: ts,
              updatedAt: ts,
            }),
            db.insert(organisationMembers).values({
              id: genId("orgm_"),
              organisationId: orgId,
              profileId: ownerId,
              role: "admin",
              createdAt: ts,
            }),
          ]),
        catch: (cause) => {
          const msg = driverErrorText(cause);
          if (msg.includes("UNIQUE constraint failed")) {
            return new OrgError({ message: "Handle unavailable" });
          }
          return new DatabaseError({ cause });
        },
      });

      // Construct return value from known inputs instead of re-fetching
      return {
        id: orgId,
        handle,
        name,
        description: desc,
        avatarUrl: null,
        ownerId,
        ownerInheritedAt: null,
        createdAt: ts,
        updatedAt: ts,
      };
    }).pipe(withOrgOp("create"));

  const getOrganisation = (
    orgId: string,
  ): Effect.Effect<typeof organisations.$inferSelect, NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(organisations).where(eq(organisations.id, orgId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
      }

      return rows[0];
    }).pipe(Effect.withSpan("org.get"));

  const getOrganisationByHandle = (
    handle: string,
  ): Effect.Effect<typeof organisations.$inferSelect | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(organisations).where(eq(organisations.handle, handle)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return rows.length > 0 ? rows[0] : null;
    }).pipe(Effect.withSpan("org.get_by_handle"));

  const updateOrganisation = (
    orgId: string,
    callerId: string,
    updates: { name?: string; description?: string },
  ): Effect.Effect<
    typeof organisations.$inferSelect,
    OrgError | NotFoundError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      // Org-exists and admin-check are independent queries — run in parallel.
      const [orgRows, memberRows] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => db.select().from(organisations).where(eq(organisations.id, orgId)).limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () =>
              db
                .select()
                .from(organisationMembers)
                .where(
                  and(
                    eq(organisationMembers.organisationId, orgId),
                    eq(organisationMembers.profileId, callerId),
                    eq(organisationMembers.role, "admin"),
                  ),
                )
                .limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: 2 },
      );

      if (orgRows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
      }

      if (memberRows.length === 0) {
        return yield* Effect.fail(
          new OrgError({ message: "Only admins can update the organisation" }),
        );
      }

      const ts = now();
      // The columns an update may touch, taken from the table's own insert
      // model: a renamed or retyped column breaks here rather than silently
      // writing a no-op set clause.
      const setClause: Partial<typeof organisations.$inferInsert> = { updatedAt: ts };
      if (updates.name !== undefined) setClause.name = updates.name;
      if (updates.description !== undefined) setClause.description = updates.description;

      // Writes only while the caller is still an admin of the organisation.
      const updated = yield* Effect.tryPromise({
        try: () =>
          db
            .update(organisations)
            .set(setClause)
            .where(and(eq(organisations.id, orgId), adminOf(db, orgId, callerId))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(updated) === 0) {
        // The organisation or the caller's admin row is gone since the checks
        // read them: refused as the checks would refuse now.
        if ((yield* readOrganisation(orgId)).length === 0) {
          return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
        }
        return yield* Effect.fail(
          new OrgError({ message: "Only admins can update the organisation" }),
        );
      }

      // Construct return from known state instead of re-fetching
      const org = orgRows[0];
      return {
        ...org,
        name: updates.name ?? org.name,
        description: updates.description ?? org.description,
        updatedAt: ts,
      };
    }).pipe(withOrgOp("update"));

  const deleteOrganisation = (
    orgId: string,
    callerId: string,
  ): Effect.Effect<void, OrgError | NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      const orgRows = yield* Effect.tryPromise({
        try: () => db.select().from(organisations).where(eq(organisations.id, orgId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (orgRows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
      }

      if (orgRows[0].ownerId !== callerId) {
        return yield* Effect.fail(
          new OrgError({ message: "Only the owner can delete the organisation" }),
        );
      }

      // Members then the org row (FK order), each only while the caller still
      // owns it: an owner can change since the read above (a decline, or the
      // hard delete of the owner's account), and the new owner's organisation
      // is not this caller's to delete. Atomic batch on D1, sequential on
      // bun:sqlite.
      const dropMembers = db
        .delete(organisationMembers)
        .where(and(eq(organisationMembers.organisationId, orgId), ownerOf(db, orgId, callerId)));
      const dropOrganisation = db
        .delete(organisations)
        .where(and(eq(organisations.id, orgId), eq(organisations.ownerId, callerId)))
        .returning({ id: organisations.id });
      const gone = yield* Effect.tryPromise({
        try: async () => {
          if (canBatch(db)) {
            const [, dropped] = await db.batch([dropMembers, dropOrganisation]);
            return dropped;
          }
          await dropMembers;
          return await dropOrganisation;
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (gone.length === 0) {
        // Refused as the checks would refuse now.
        const [orgNow] = yield* readOrganisation(orgId);
        if (!orgNow) {
          return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
        }
        return yield* Effect.fail(
          new OrgError({ message: "Only the owner can delete the organisation" }),
        );
      }
    }).pipe(withOrgOp("delete"));

  /**
   * Whether the caller may decline the organisation `handle` names at
   * `nowSec`: the one read the decline and {@link declineOwnershipStatus}
   * share, so the page that offers a decline and the decline itself cannot
   * disagree. By handle, as the routes have it, so they read nothing first.
   */
  const readDeclineStanding = (handle: string, callerId: string, nowSec: number) =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const [found] = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              orgId: organisations.id,
              ownerId: organisations.ownerId,
              ownerInheritedAt: organisations.ownerInheritedAt,
              handle: organisations.handle,
              callerAccountId: users.accountId,
            })
            .from(organisations)
            .leftJoin(users, eq(users.id, callerId))
            .where(eq(organisations.handle, handle))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (!found) return { outcome: "not_found" } as const;
      if (found.ownerId !== callerId || found.callerAccountId === null) {
        return { outcome: "not_owner" } as const;
      }
      const cutoff = nowSec - OWNERSHIP_DECLINE_WINDOW_SECONDS;
      if (found.ownerInheritedAt === null || found.ownerInheritedAt <= cutoff) {
        return { outcome: "not_declinable" } as const;
      }
      return {
        outcome: "declinable",
        orgId: found.orgId,
        handle: found.handle,
        accountId: found.callerAccountId,
        declineUntil: found.ownerInheritedAt + OWNERSHIP_DECLINE_WINDOW_SECONDS,
      } as const;
    });

  /**
   * Whether the caller may decline the organisation now, and until when; it
   * writes nothing. The same refusals as {@link declineOwnership}: anyone but
   * the owner is `not_owner`; an owner who created it, or received it more
   * than {@link OWNERSHIP_DECLINE_WINDOW_SECONDS} ago, is `not_declinable`.
   */
  const declineOwnershipStatus = (
    handle: string,
    callerId: string,
  ): Effect.Effect<DeclineOwnershipStatus, DatabaseError, Db> =>
    readDeclineStanding(handle, callerId, Math.floor(Date.now() / 1_000)).pipe(
      Effect.map((standing) =>
        standing.outcome === "declinable"
          ? ({ outcome: "declinable", declineUntil: standing.declineUntil } as const)
          : standing,
      ),
    );

  /**
   * The caller hands back an organisation it received by succession — the
   * hard delete of the previous owner's account, or a decline by the member
   * before it — inside {@link OWNERSHIP_DECLINE_WINDOW_SECONDS} of receiving
   * it. One batch, each statement only while the caller still owns it within
   * that window: the caller's own membership goes first; then the next owner,
   * by the hard delete's order (the longest-standing admin from another
   * account, else the longest-standing member from another account, made
   * admin), receives it and may decline it in turn; with no such member, its
   * memberships and the organisation go. The caller's other profiles are never
   * chosen. A refusal writes nothing.
   *
   * The caller's membership goes in the same batch as the change of owner, as
   * at the hard delete, so a stale read of the owner can grant or change
   * nothing afterwards (`addMember`, `updateMemberRole`); `removeMember` and
   * `deleteOrganisation` carry the owner in their writes.
   *
   * Two round trips: the read of the caller's standing, then the batch, whose
   * last statement reads who owns it now and their address.
   */
  const declineOwnership = (
    handle: string,
    callerId: string,
  ): Effect.Effect<DeclineOwnershipResult, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1_000);
      const cutoff = nowSec - OWNERSHIP_DECLINE_WINDOW_SECONDS;

      const standing = yield* readDeclineStanding(handle, callerId, nowSec);
      if (standing.outcome !== "declinable") return standing;
      const { orgId, accountId } = standing;

      // Still the caller's, received inside the window: every statement below
      // writes only while this holds.
      const held = and(
        eq(ownedOrganisation.id, orgId),
        eq(ownedOrganisation.ownerId, callerId),
        gt(ownedOrganisation.ownerInheritedAt, cutoff),
      );
      const stillHeld = exists(
        db
          .select({ one: sql`1` })
          .from(ownedOrganisation)
          .where(held),
      );
      const next = successorRow("profile_id", organisations.id, accountId);

      const statements = [
        // 1. The caller leaves. First: once the owner moves, nothing below
        //    may name the caller as owner any more.
        db
          .delete(organisationMembers)
          .where(
            and(
              eq(organisationMembers.organisationId, orgId),
              eq(organisationMembers.profileId, callerId),
              stillHeld,
            ),
          ),
        // 2. The next owner becomes an admin, if a plain member.
        db
          .update(organisationMembers)
          .set({ role: "admin" })
          .where(
            and(
              eq(organisationMembers.organisationId, orgId),
              eq(organisationMembers.role, "member"),
              eq(organisationMembers.id, successorRow("id", sql`${orgId}`, accountId)),
              stillHeld,
            ),
          ),
        // 3. It passes to them, and is theirs to decline in turn.
        db
          .update(organisations)
          .set({ ownerId: next, ownerInheritedAt: nowSec, updatedAt: new Date(nowSec * 1_000) })
          .where(
            and(
              eq(organisations.id, orgId),
              eq(organisations.ownerId, callerId),
              gt(organisations.ownerInheritedAt, cutoff),
              isNotNull(next),
            ),
          )
          .returning({ ownerId: organisations.ownerId }),
        // 4. No one to pass it to: its memberships, then it.
        db
          .delete(organisationMembers)
          .where(and(eq(organisationMembers.organisationId, orgId), stillHeld)),
        db
          .delete(organisations)
          .where(
            and(
              eq(organisations.id, orgId),
              eq(organisations.ownerId, callerId),
              gt(organisations.ownerInheritedAt, cutoff),
            ),
          )
          .returning({ id: organisations.id }),
        // 5. Who owns it now, and their address: the next owner's when it
        //    passed, for the notice; the reason for a refusal when nothing
        //    above wrote; no row when it is gone.
        db
          .select({ ownerId: organisations.ownerId, email: accounts.email })
          .from(organisations)
          .leftJoin(users, eq(users.id, organisations.ownerId))
          .leftJoin(accounts, eq(accounts.id, users.accountId))
          .where(eq(organisations.id, orgId))
          .limit(1),
      ] as const;

      const [leave, promote, transfer, dropMemberships, dropOrganisation, ownerNow] = statements;
      const { passed, deleted, after } = yield* Effect.tryPromise({
        // One batch on D1; one statement at a time on bun:sqlite, each guarded
        // on its own. Either way the transfer's and the delete's RETURNING
        // rows come back.
        try: async () => {
          if (canBatch(db)) {
            const [, , moved, , gone, owner] = await db.batch([
              leave,
              promote,
              transfer,
              dropMemberships,
              dropOrganisation,
              ownerNow,
            ]);
            return { passed: moved, deleted: gone, after: owner };
          }
          await leave;
          await promote;
          const moved = await transfer;
          await dropMemberships;
          const gone = await dropOrganisation;
          const owner = await ownerNow;
          return { passed: moved, deleted: gone, after: owner };
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      const [ownerAfter] = after;
      if (passed.length > 0) {
        return {
          outcome: "passed",
          handle: standing.handle,
          newOwnerEmail: ownerAfter?.email || null,
          declineUntil: nowSec + OWNERSHIP_DECLINE_WINDOW_SECONDS,
        } as const;
      }
      if (deleted.length > 0) return { outcome: "deleted" } as const;
      // Neither: the owner or the window changed since the read. Refused as a
      // fresh request would be.
      if (!ownerAfter) return { outcome: "not_found" } as const;
      if (ownerAfter.ownerId !== callerId) return { outcome: "not_owner" } as const;
      return { outcome: "not_declinable" } as const;
    }).pipe(withOrgOp("decline_ownership"));

  const listProfileOrganisations = (
    profileId: string,
    options: ListOptions = {},
  ): Effect.Effect<(typeof organisations.$inferSelect)[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      // Single JOIN query instead of two-step lookup
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: organisations.id,
              handle: organisations.handle,
              name: organisations.name,
              description: organisations.description,
              avatarUrl: organisations.avatarUrl,
              ownerId: organisations.ownerId,
              ownerInheritedAt: organisations.ownerInheritedAt,
              createdAt: organisations.createdAt,
              updatedAt: organisations.updatedAt,
            })
            .from(organisationMembers)
            .innerJoin(organisations, eq(organisationMembers.organisationId, organisations.id))
            .where(eq(organisationMembers.profileId, profileId))
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return rows;
    }).pipe(Effect.withSpan("org.list_by_profile"));

  // -------------------------------------------------------------------------
  // Membership management
  // -------------------------------------------------------------------------

  const addMember = (
    orgId: string,
    callerId: string,
    targetProfileId: string,
    role: "admin" | "member",
  ): Effect.Effect<void, OrgError | NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      // Parallelise all pre-insert checks
      const [orgRows, callerMember, targetRows, existing] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            db.select().from(organisations).where(eq(organisations.id, orgId)).limit(1),
            db
              .select()
              .from(organisationMembers)
              .where(
                and(
                  eq(organisationMembers.organisationId, orgId),
                  eq(organisationMembers.profileId, callerId),
                  eq(organisationMembers.role, "admin"),
                ),
              )
              .limit(1),
            db.select({ id: users.id }).from(users).where(eq(users.id, targetProfileId)).limit(1),
            db
              .select()
              .from(organisationMembers)
              .where(
                and(
                  eq(organisationMembers.organisationId, orgId),
                  eq(organisationMembers.profileId, targetProfileId),
                ),
              )
              .limit(1),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (orgRows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
      }
      if (callerMember.length === 0) {
        return yield* Effect.fail(new OrgError({ message: "Only admins can add members" }));
      }
      // Only the owner may grant admin. Without this, any admin could mint new
      // admins (or promote a colluding account) via add — the same privilege
      // change `updateMemberRole` restricts to the owner, so the two paths must
      // agree or the owner-only gate is bypassable through remove+add.
      if (role === "admin" && orgRows[0].ownerId !== callerId) {
        return yield* Effect.fail(new OrgError({ message: "Only the owner can grant admin" }));
      }
      if (targetRows.length === 0) {
        return yield* Effect.fail(new OrgError({ message: "Target profile not found" }));
      }
      if (existing.length > 0) {
        return yield* Effect.fail(new OrgError({ message: "Profile is already a member" }));
      }

      // Inserts from the caller's own admin row, so the member is added only
      // while the caller is still an admin; a profile added since is left as
      // it is. The owner-only grant needs no guard of its own: the owner
      // changes only by succession — the hard delete of the owner's account,
      // or a decline (`declineOwnership`) — and each does it in a batch that
      // also deletes the old owner's membership rows, so an insert after a
      // stale read of the owner finds no admin row and grants nothing. A new
      // writer of `owner_id` must do the same, or this grant needs a guard.
      const inserted = yield* Effect.tryPromise({
        try: () =>
          db
            .insert(organisationMembers)
            .select(
              db
                .select({
                  id: bound(genId("orgm_"), organisationMembers.id),
                  organisationId: bound(orgId, organisationMembers.organisationId),
                  profileId: bound(targetProfileId, organisationMembers.profileId),
                  role: bound(role, organisationMembers.role),
                  createdAt: bound(now(), organisationMembers.createdAt),
                })
                .from(callerMembership)
                .where(
                  and(
                    eq(callerMembership.organisationId, orgId),
                    eq(callerMembership.profileId, callerId),
                    eq(callerMembership.role, "admin"),
                  ),
                ),
            )
            .onConflictDoNothing({
              target: [organisationMembers.organisationId, organisationMembers.profileId],
            }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(inserted) === 0) {
        // Refused as the checks would refuse now.
        const [orgNow, adminNow] = yield* Effect.all(
          [readOrganisation(orgId), readAdmin(orgId, callerId)],
          { concurrency: 2 },
        );
        if (orgNow.length === 0) {
          return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
        }
        if (adminNow.length === 0) {
          return yield* Effect.fail(new OrgError({ message: "Only admins can add members" }));
        }
        return yield* Effect.fail(new OrgError({ message: "Profile is already a member" }));
      }
    }).pipe(withOrgMemberOp("add"));

  const removeMember = (
    orgId: string,
    callerId: string,
    targetProfileId: string,
  ): Effect.Effect<void, OrgError | NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      // Check org exists
      const orgRows = yield* Effect.tryPromise({
        try: () => db.select().from(organisations).where(eq(organisations.id, orgId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (orgRows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
      }

      // Cannot remove the owner
      if (orgRows[0].ownerId === targetProfileId) {
        return yield* Effect.fail(new OrgError({ message: "Cannot remove the owner" }));
      }

      // Caller-is-admin and target-is-member checks are independent — run in parallel.
      const [callerMember, targetMember] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () =>
              db
                .select()
                .from(organisationMembers)
                .where(
                  and(
                    eq(organisationMembers.organisationId, orgId),
                    eq(organisationMembers.profileId, callerId),
                    eq(organisationMembers.role, "admin"),
                  ),
                )
                .limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () =>
              db
                .select()
                .from(organisationMembers)
                .where(
                  and(
                    eq(organisationMembers.organisationId, orgId),
                    eq(organisationMembers.profileId, targetProfileId),
                  ),
                )
                .limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: 2 },
      );

      if (callerMember.length === 0) {
        return yield* Effect.fail(new OrgError({ message: "Only admins can remove members" }));
      }

      if (targetMember.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Member not found" }));
      }

      // Only the owner may remove an admin. Without this, any admin could strip
      // rival admins (or, paired with add, demote them) — again bypassing the
      // owner-only role gate. Admins may still remove plain members.
      if (targetMember[0].role === "admin" && orgRows[0].ownerId !== callerId) {
        return yield* Effect.fail(new OrgError({ message: "Only the owner can remove an admin" }));
      }

      // Deletes the membership only while what the checks read still holds:
      // the member's row, and, for a caller that is not the owner, its
      // plain-member role and the caller's own admin row. A member promoted,
      // or a caller demoted, since the checks is not removed.
      const isOwner = orgRows[0].ownerId === callerId;
      const removed = yield* Effect.tryPromise({
        try: () =>
          db.delete(organisationMembers).where(
            and(
              eq(organisationMembers.id, targetMember[0].id),
              eq(organisationMembers.organisationId, orgId),
              eq(organisationMembers.profileId, targetProfileId),
              // An owner removes only while it still owns the organisation:
              // a decline or a hard delete can hand it on in between.
              isOwner ? ownerOf(db, orgId, callerId) : eq(organisationMembers.role, "member"),
              isOwner ? undefined : adminOf(db, orgId, callerId),
            ),
          ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(removed) === 0) {
        // Refused as the checks would refuse now, in their order.
        const [orgNow, adminNow, memberNow] = yield* Effect.all(
          [
            readOrganisation(orgId),
            readAdmin(orgId, callerId),
            readMembership(orgId, targetProfileId),
          ],
          { concurrency: 3 },
        );
        if (orgNow.length === 0) {
          return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
        }
        if (adminNow.length === 0) {
          return yield* Effect.fail(new OrgError({ message: "Only admins can remove members" }));
        }
        if (memberNow[0]?.role === "admin" && !isOwner) {
          return yield* Effect.fail(
            new OrgError({ message: "Only the owner can remove an admin" }),
          );
        }
        return yield* Effect.fail(new NotFoundError({ message: "Member not found" }));
      }
    }).pipe(withOrgMemberOp("remove"));

  const updateMemberRole = (
    orgId: string,
    callerId: string,
    targetProfileId: string,
    newRole: "admin" | "member",
  ): Effect.Effect<void, OrgError | NotFoundError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;

      // Check org exists
      const orgRows = yield* Effect.tryPromise({
        try: () => db.select().from(organisations).where(eq(organisations.id, orgId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (orgRows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
      }

      // Cannot change the owner's role
      if (orgRows[0].ownerId === targetProfileId) {
        return yield* Effect.fail(new OrgError({ message: "Cannot change the owner's role" }));
      }

      // Only the owner can promote/demote
      if (orgRows[0].ownerId !== callerId) {
        return yield* Effect.fail(new OrgError({ message: "Only the owner can change roles" }));
      }

      // Check target is a member
      const targetMember = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(organisationMembers)
            .where(
              and(
                eq(organisationMembers.organisationId, orgId),
                eq(organisationMembers.profileId, targetProfileId),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (targetMember.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Member not found" }));
      }

      // Changes the membership only while it is the one read and the caller
      // still owns the organisation. The owner changes by succession — the
      // hard delete of the owner's account, or a decline — which can pass the
      // organisation on between the check above and this write.
      const changed = yield* Effect.tryPromise({
        try: () =>
          db
            .update(organisationMembers)
            .set({ role: newRole })
            .where(
              and(
                eq(organisationMembers.id, targetMember[0].id),
                eq(organisationMembers.organisationId, orgId),
                eq(organisationMembers.profileId, targetProfileId),
                exists(
                  db
                    .select({ one: sql`1` })
                    .from(organisations)
                    .where(and(eq(organisations.id, orgId), eq(organisations.ownerId, callerId))),
                ),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rowsChanged(changed) === 0) {
        // Refused as the checks would refuse now, in their order.
        const [orgNow] = yield* readOrganisation(orgId);
        if (!orgNow) {
          return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
        }
        if (orgNow.ownerId === targetProfileId) {
          return yield* Effect.fail(new OrgError({ message: "Cannot change the owner's role" }));
        }
        if (orgNow.ownerId !== callerId) {
          return yield* Effect.fail(new OrgError({ message: "Only the owner can change roles" }));
        }
        return yield* Effect.fail(new NotFoundError({ message: "Member not found" }));
      }
    }).pipe(withOrgMemberOp("update_role"));

  const listMembers = (
    orgId: string,
    options: ListOptions = {},
  ): Effect.Effect<
    {
      profile: {
        id: string;
        handle: string;
        displayName: string | null;
      };
      // The column's own enum, not a bare string: the roster is what a client
      // reads before PATCHing a role back, and both request bodies accept
      // exactly these two values.
      role: "admin" | "member";
      joinedAt: Date;
    }[],
    NotFoundError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      // Check org exists
      const orgRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: organisations.id })
            .from(organisations)
            .where(eq(organisations.id, orgId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (orgRows.length === 0) {
        return yield* Effect.fail(new NotFoundError({ message: "Organisation not found" }));
      }

      // Single JOIN query instead of two-step lookup
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: users.id,
              handle: users.handle,
              displayName: users.displayName,
              role: organisationMembers.role,
              joinedAt: organisationMembers.createdAt,
            })
            .from(organisationMembers)
            .innerJoin(users, eq(organisationMembers.profileId, users.id))
            .where(eq(organisationMembers.organisationId, orgId))
            .limit(limit)
            .offset(offset),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return rows.map((r) => ({
        profile: {
          id: r.id,
          handle: r.handle,
          displayName: r.displayName,
        },
        role: r.role,
        joinedAt: r.joinedAt,
      }));
    }).pipe(Effect.withSpan("org.member.list"));

  const getMemberRole = (
    orgId: string,
    profileId: string,
  ): Effect.Effect<"admin" | "member" | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ role: organisationMembers.role })
            .from(organisationMembers)
            .where(
              and(
                eq(organisationMembers.organisationId, orgId),
                eq(organisationMembers.profileId, profileId),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (rows.length === 0) return null;
      return rows[0].role as "admin" | "member";
    }).pipe(Effect.withSpan("org.member.role_check"));

  return {
    createOrganisation,
    getOrganisation,
    getOrganisationByHandle,
    updateOrganisation,
    deleteOrganisation,
    declineOwnership,
    declineOwnershipStatus,
    listProfileOrganisations,
    addMember,
    removeMember,
    updateMemberRole,
    listMembers,
    getMemberRole,
  };
}
