import { organisations, organisationMembers, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { withOrgMemberOp, withOrgOp } from "../metrics";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OrgError extends Data.TaggedError("OrgError")<{
  readonly message: string;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListOptions {
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

export function createOrganisationService() {
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
      const { db } = yield* Db;

      // P-W1: parallelise all pre-insert checks (handle profile, handle org, owner exists)
      const [existingProfile, existingOrg, ownerRows] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1),
            db
              .select({ id: organisations.id })
              .from(organisations)
              .where(eq(organisations.handle, handle))
              .limit(1),
            db.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).limit(1),
          ]),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // S-H2: use generic message to avoid confirming handle existence
      if (existingProfile.length > 0 || existingOrg.length > 0) {
        return yield* Effect.fail(new OrgError({ message: "Handle unavailable" }));
      }

      if (ownerRows.length === 0) {
        return yield* Effect.fail(new OrgError({ message: "Owner not found" }));
      }

      const ts = now();
      const orgId = genId("org_");
      const desc = description ?? null;

      // Insert org + owner as admin in a single transaction
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx.insert(organisations).values({
              id: orgId,
              handle,
              name,
              description: desc,
              avatarUrl: null,
              ownerId,
              createdAt: ts,
              updatedAt: ts,
            });
            await tx.insert(organisationMembers).values({
              id: genId("orgm_"),
              organisationId: orgId,
              profileId: ownerId,
              role: "admin",
              createdAt: ts,
            });
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // P-I1: construct return value from known inputs instead of re-fetching
      return {
        id: orgId,
        handle,
        name,
        description: desc,
        avatarUrl: null,
        ownerId,
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

      // P-I1: org-exists and admin-check are independent queries — run in parallel.
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
      const setClause: Record<string, unknown> = { updatedAt: ts };
      if (updates.name !== undefined) setClause.name = updates.name;
      if (updates.description !== undefined) setClause.description = updates.description;

      yield* Effect.tryPromise({
        try: () => db.update(organisations).set(setClause).where(eq(organisations.id, orgId)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // P-W6: construct return from known state instead of re-fetching
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

      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx
              .delete(organisationMembers)
              .where(eq(organisationMembers.organisationId, orgId));
            await tx.delete(organisations).where(eq(organisations.id, orgId));
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
    }).pipe(withOrgOp("delete"));

  const listProfileOrganisations = (
    profileId: string,
    options: ListOptions = {},
  ): Effect.Effect<(typeof organisations.$inferSelect)[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const limit = clampLimit(options.limit);
      const offset = options.offset ?? 0;

      // P-W4: single JOIN query instead of two-step lookup
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

      // P-W2: parallelise all pre-insert checks
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
      if (targetRows.length === 0) {
        return yield* Effect.fail(new OrgError({ message: "Target profile not found" }));
      }
      if (existing.length > 0) {
        return yield* Effect.fail(new OrgError({ message: "Profile is already a member" }));
      }

      yield* Effect.tryPromise({
        try: () =>
          db.insert(organisationMembers).values({
            id: genId("orgm_"),
            organisationId: orgId,
            profileId: targetProfileId,
            role,
            createdAt: now(),
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
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

      // P-W1: caller-is-admin and target-is-member checks are independent — run in parallel.
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

      yield* Effect.tryPromise({
        try: () =>
          db.delete(organisationMembers).where(eq(organisationMembers.id, targetMember[0].id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
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

      yield* Effect.tryPromise({
        try: () =>
          db
            .update(organisationMembers)
            .set({ role: newRole })
            .where(eq(organisationMembers.id, targetMember[0].id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
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
        avatarUrl: string | null;
        createdAt: Date;
        updatedAt: Date;
      };
      role: string;
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

      // P-W5: single JOIN query instead of two-step lookup
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: users.id,
              handle: users.handle,
              displayName: users.displayName,
              avatarUrl: users.avatarUrl,
              createdAt: users.createdAt,
              updatedAt: users.updatedAt,
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
          avatarUrl: r.avatarUrl,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
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
    listProfileOrganisations,
    addMember,
    removeMember,
    updateMemberRole,
    listMembers,
    getMemberRole,
  };
}

export type OrganisationService = ReturnType<typeof createOrganisationService>;
