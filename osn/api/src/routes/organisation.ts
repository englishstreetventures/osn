import type { Organisation, Profile } from "@osn/db/schema";
import { DbLive, type Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { forkBackground } from "../lib/background";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { makeSafeError } from "../lib/safe-error";
import { createAuthService, type AuthConfig } from "../services/auth";
import { frontendOrigin } from "../services/auth/helpers";
import { createOrganisationService } from "../services/organisation";
import { memoryLimiter, OSN_RATE_LIMITS } from "./auth/limiters";
import {
  errorResponse,
  okResponse,
  organisationCaller,
  organisationMemberSummary,
  organisationSummary,
} from "./response-schemas";

// ---------------------------------------------------------------------------
// Rate limiter — per-user fixed window. The budget is `OSN_RATE_LIMITS.orgWrite`.
// ---------------------------------------------------------------------------

export function createDefaultOrgRateLimiter(): RateLimiterBackend {
  return memoryLimiter(OSN_RATE_LIMITS.orgWrite);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Expose only tagged OrgError / NotFoundError messages; swallow DB internals.
// FiberFailure-aware — see `makeSafeError` for why a plain `_tag` check fails.
const safeError = makeSafeError(["OrgError", "NotFoundError"]);

// TypeBox schemas
const HandleParam = t.Object({
  handle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
});

const MemberHandleParams = t.Object({
  handle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
  profileHandle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
});

const PaginationQuery = t.Object({
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
});

function profileProjection(u: { handle: string; displayName: string | null }) {
  return {
    handle: u.handle,
    displayName: u.displayName ?? null,
  };
}

function orgProjection(o: Organisation) {
  return {
    handle: o.handle,
    name: o.name,
    description: o.description ?? null,
    avatarUrl: o.avatarUrl ?? null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function parsePagination(query: { limit?: string; offset?: string }) {
  const limit = query.limit !== undefined ? parseInt(query.limit, 10) : undefined;
  const offset = query.offset !== undefined ? parseInt(query.offset, 10) : undefined;
  return {
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createOrganisationRoutes(
  authConfig: AuthConfig,
  /** The decline mails the organisation's next owner, so the layer carries the email transport. */
  dbLayer: Layer.Layer<Db | EmailService> = Layer.merge(DbLive, makeLogEmailLive().layer),
  loggerLayer: Layer.Layer<never> = Layer.empty,
  rateLimiter: RateLimiterBackend = createDefaultOrgRateLimiter(),
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
) {
  if (typeof rateLimiter?.check !== "function") {
    throw new Error("Org rateLimiter must have a check() method");
  }

  const auth = createAuthService(authConfig);
  const org = createOrganisationService({ heldHandleDigest: auth.heldHandleDigest });

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));
  const appUrl = frontendOrigin(authConfig);

  async function requireAuth(
    authorization: string | undefined,
    set: { status?: number | string },
  ): Promise<{ profileId: string; handle: string } | null> {
    const token = extractToken(authorization);
    if (!token) {
      set.status = 401;
      return null;
    }
    try {
      return await Effect.runPromise(Effect.orDie(auth.verifyAccessToken(token)));
    } catch {
      set.status = 401;
      return null;
    }
  }

  async function requireRateLimit(
    profileId: string,
    set: { status?: number | string },
  ): Promise<boolean> {
    let allowed: boolean;
    try {
      allowed = await rateLimiter.check(profileId);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      set.status = 429;
      return false;
    }
    return true;
  }

  async function resolveHandle(
    handle: string,
    set: { status?: number | string },
  ): Promise<Profile | null> {
    try {
      const profile = await run(auth.findProfileByHandle(handle));
      if (!profile) {
        set.status = 404;
        return null;
      }
      return profile;
    } catch {
      set.status = 500;
      return null;
    }
  }

  async function resolveOrg(
    handle: string,
    set: { status?: number | string },
  ): Promise<Organisation | null> {
    try {
      const organisation = await run(org.getOrganisationByHandle(handle));
      if (!organisation) {
        set.status = 404;
        return null;
      }
      return organisation;
    } catch {
      set.status = 500;
      return null;
    }
  }

  return (
    new Elysia({ prefix: "/organisations" })
      // -----------------------------------------------------------------------
      // Organisation CRUD
      // -----------------------------------------------------------------------
      .post(
        "/",
        async ({ body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          try {
            const organisation = await run(
              org.createOrganisation(caller.profileId, body.handle, body.name, body.description),
            );
            set.status = 201;
            return { ok: true, organisation: orgProjection(organisation) };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          body: t.Object({
            handle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
            name: t.String({ minLength: 1, maxLength: 100 }),
            description: t.Optional(t.String({ maxLength: 500 })),
          }),
          response: {
            // 201 with the created organisation, so a client can route to it
            // without a follow-up GET.
            201: t.Object({ ok: t.Boolean(), organisation: organisationSummary }),
            // A taken handle and a DB failure both land here: the catch maps
            // every service failure to 400, and nothing in this handler sets
            // 500. That is the existing behaviour, faithfully described.
            400: errorResponse,
            401: errorResponse,
            429: errorResponse,
          },
          detail: { operationId: "createOrganisation", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };

          try {
            const list = await run(
              org.listProfileOrganisations(caller.profileId, parsePagination(query)),
            );
            return { organisations: list.map(orgProjection) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          query: PaginationQuery,
          response: {
            // The caller's own organisations, not a directory — there is no
            // handle to resolve and no rate limiter on a read, so 404 and 429
            // can't happen.
            200: t.Object({ organisations: t.Array(organisationSummary) }),
            401: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "listMyOrganisations", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          // The caller's own standing, so a client offers only what the write
          // routes would allow. A failed read of it costs the caller those
          // actions, never the organisation: it answers `null`, as for a
          // non-member, and is logged.
          const role = await run(
            org
              .getMemberRole(organisation.id, caller.profileId)
              .pipe(
                Effect.catch(() =>
                  Effect.logError("organisation caller standing not read").pipe(Effect.as(null)),
                ),
              ),
          ).catch(() => null);
          return {
            organisation: orgProjection(organisation),
            caller: role ? { role, owner: organisation.ownerId === caller.profileId } : null,
          };
        },
        {
          params: HandleParam,
          response: {
            // Readable by any authenticated caller, member or not. Only the
            // roster below is member-only. `caller` is null for a non-member.
            200: t.Object({
              organisation: organisationSummary,
              caller: t.Union([organisationCaller, t.Null()]),
            }),
            401: errorResponse,
            // `resolveOrg` owns both: 404 on a miss, 500 when the lookup
            // itself throws. It returns null either way, so the body is the
            // same "Organisation not found" string at both statuses.
            404: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "getOrganisation", security: [{ bearerAuth: [] }] },
        },
      )
      .patch(
        "/:handle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          try {
            const updated = await run(
              org.updateOrganisation(organisation.id, caller.profileId, body),
            );
            return { ok: true, organisation: orgProjection(updated) };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          body: t.Object({
            name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            description: t.Optional(t.String({ maxLength: 500 })),
          }),
          response: {
            // Returns the organisation after the update, so a client never has
            // to guess what the server made of a partial body.
            200: t.Object({ ok: t.Boolean(), organisation: organisationSummary }),
            // Not an admin is a 400 here, not a 403: the authorisation check
            // lives in the service and surfaces as an OrgError like any other.
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "updateOrganisation", security: [{ bearerAuth: [] }] },
        },
      )
      .delete(
        "/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          try {
            await run(org.deleteOrganisation(organisation.id, caller.profileId));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            200: okResponse,
            // Owner-only, and "only the owner can delete the organisation"
            // arrives as an OrgError — so an admin who is not the owner gets a
            // 400, same as any other refusal in this group.
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "deleteOrganisation", security: [{ bearerAuth: [] }] },
        },
      )
      // -----------------------------------------------------------------------
      // GET /organisations/:handle/decline-ownership — whether the caller may
      // decline it now, and until when. Writes nothing; the page shows its
      // decline card only on a 200, so a link cannot make the card appear
      // for anyone the decline would refuse.
      // -----------------------------------------------------------------------
      .get(
        "/:handle/decline-ownership",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };

          try {
            // The service reads the organisation by handle itself.
            const status = await run(org.declineOwnershipStatus(params.handle, caller.profileId));
            if (status.outcome === "not_found") {
              set.status = 404;
              return { error: "Organisation not found" };
            }
            if (status.outcome === "not_owner") {
              set.status = 403;
              return { error: "not_owner" };
            }
            if (status.outcome === "not_declinable") {
              set.status = 409;
              return { error: "not_declinable" };
            }
            return { declineUntil: new Date(status.declineUntil * 1_000).toISOString() };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            200: t.Object({ declineUntil: t.String({ format: "date-time" }) }),
            401: errorResponse,
            // `not_owner`: the caller does not own it.
            403: errorResponse,
            404: errorResponse,
            // `not_declinable`: the caller created it, or received it more
            // than 30 days ago.
            409: errorResponse,
            500: errorResponse,
          },
          detail: {
            operationId: "getOrganisationDeclineOwnership",
            security: [{ bearerAuth: [] }],
          },
        },
      )
      // -----------------------------------------------------------------------
      // POST /organisations/:handle/decline-ownership — a member who received
      // the organisation by succession hands it back within 30 days: it
      // passes to the next admin or member from another account, who is
      // emailed and may decline in turn, or is deleted when there is none.
      // The caller leaves it either way.
      // -----------------------------------------------------------------------
      .post(
        "/:handle/decline-ownership",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          try {
            // The service reads the organisation by handle itself.
            const result = await run(org.declineOwnership(params.handle, caller.profileId));
            if (result.outcome === "not_found") {
              set.status = 404;
              return { error: "Organisation not found" };
            }
            if (result.outcome === "not_owner") {
              set.status = 403;
              return { error: "not_owner" };
            }
            if (result.outcome === "not_declinable") {
              set.status = 409;
              return { error: "not_declinable" };
            }
            if (result.outcome === "passed" && result.newOwnerEmail !== null) {
              const to = result.newOwnerEmail;
              await run(
                forkBackground(
                  Effect.gen(function* () {
                    const email = yield* EmailService;
                    yield* email.send({
                      template: "organisation-ownership-received",
                      to,
                      data: {
                        instanceName: authConfig.instanceName,
                        organisationHandle: result.handle,
                        declineUrl: `${appUrl}/organisations/${encodeURIComponent(result.handle)}?decline=1`,
                        declineUntil: result.declineUntil,
                        cause: "owner_declined",
                      },
                    });
                  }).pipe(
                    Effect.catch(() =>
                      Effect.logWarning("organisation ownership notice not sent", {
                        template: "organisation-ownership-received",
                      }),
                    ),
                  ),
                ),
              );
            }
            return { outcome: result.outcome };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          response: {
            // `passed`: the next owner has it; `deleted`: no one else could
            // take it, and it is gone. The caller is no longer a member.
            200: t.Object({ outcome: t.Union([t.Literal("passed"), t.Literal("deleted")]) }),
            401: errorResponse,
            // `not_owner`: the caller does not own it.
            403: errorResponse,
            404: errorResponse,
            // `not_declinable`: the caller created it, or received it more
            // than 30 days ago; it can still be deleted.
            409: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "declineOrganisationOwnership", security: [{ bearerAuth: [] }] },
        },
      )
      // -----------------------------------------------------------------------
      // Member management
      // -----------------------------------------------------------------------
      .post(
        "/:handle/members/:profileHandle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          // Resolve org and target profile in parallel (independent DB lookups).
          const [organisation, target] = await Promise.all([
            resolveOrg(params.handle, set),
            resolveHandle(params.profileHandle, set),
          ]);
          if (!organisation) return { error: "Organisation not found" };
          if (!target) return { error: "Profile not found" };

          try {
            await run(org.addMember(organisation.id, caller.profileId, target.id, body.role));
            set.status = 201;
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: MemberHandleParams,
          body: t.Object({
            role: t.Union([t.Literal("admin"), t.Literal("member")]),
          }),
          response: {
            // 201: a membership row now exists. The body is bare — a client
            // that wants the new roster refetches it.
            201: okResponse,
            // Already a member, not an admin, and granting admin without being
            // the owner all arrive here.
            400: errorResponse,
            401: errorResponse,
            // Two different misses share this status: no such organisation and
            // no such profile. They are told apart by the message, since both
            // handles live in the path.
            404: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "addOrganisationMember", security: [{ bearerAuth: [] }] },
        },
      )
      .delete(
        "/:handle/members/:profileHandle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          // Resolve org and target profile in parallel (independent DB lookups).
          const [organisation, target] = await Promise.all([
            resolveOrg(params.handle, set),
            resolveHandle(params.profileHandle, set),
          ]);
          if (!organisation) return { error: "Organisation not found" };
          if (!target) return { error: "Profile not found" };

          try {
            await run(org.removeMember(organisation.id, caller.profileId, target.id));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: MemberHandleParams,
          response: {
            200: okResponse,
            // Removing the owner is refused outright; removing an admin is
            // owner-only. Both are OrgErrors, so both are 400.
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "removeOrganisationMember", security: [{ bearerAuth: [] }] },
        },
      )
      .patch(
        "/:handle/members/:profileHandle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.profileId, set)))
            return { error: "Too many requests" };

          // Resolve org and target profile in parallel (independent DB lookups).
          const [organisation, target] = await Promise.all([
            resolveOrg(params.handle, set),
            resolveHandle(params.profileHandle, set),
          ]);
          if (!organisation) return { error: "Organisation not found" };
          if (!target) return { error: "Profile not found" };

          try {
            await run(
              org.updateMemberRole(organisation.id, caller.profileId, target.id, body.role),
            );
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        {
          params: MemberHandleParams,
          body: t.Object({
            role: t.Union([t.Literal("admin"), t.Literal("member")]),
          }),
          response: {
            200: okResponse,
            // Owner-only, and the owner's own role can't be changed at all —
            // there is no way to hand the organisation over through this route.
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "updateOrganisationMemberRole", security: [{ bearerAuth: [] }] },
        },
      )
      .get(
        "/:handle/members",
        async ({ params, query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          try {
            // Least-privilege: the full roster (handles, display names, roles)
            // is visible only to members of the org, not to any authenticated
            // user. If public org pages are ever wanted, gate this on an
            // explicit `organisations.visibility` flag rather than dropping the
            // check.
            const callerRole = await run(org.getMemberRole(organisation.id, caller.profileId));
            if (!callerRole) {
              set.status = 403;
              return { error: "Forbidden" };
            }

            const list = await run(org.listMembers(organisation.id, parsePagination(query)));
            return {
              members: list.map((m) =>
                Object.assign({}, profileProjection(m.profile), {
                  role: m.role,
                  joinedAt: m.joinedAt.toISOString(),
                }),
              ),
            };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        {
          params: HandleParam,
          query: PaginationQuery,
          response: {
            200: t.Object({ members: t.Array(organisationMemberSummary) }),
            401: errorResponse,
            // The only 403 in the group. Membership, not admin, is what it
            // asks for — and it is a real 403 rather than the 400 the write
            // routes use, because the check runs in the route, not the service.
            403: errorResponse,
            404: errorResponse,
            // A read: no rate limiter, so no 429.
            500: errorResponse,
          },
          detail: { operationId: "listOrganisationMembers", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
