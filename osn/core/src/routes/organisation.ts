import type { Organisation, User } from "@osn/db/schema";
import { DbLive, type Db } from "@osn/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { createRateLimiter, type RateLimiterBackend } from "../lib/rate-limit";
import { createAuthService, type AuthConfig } from "../services/auth";
import { createOrganisationService } from "../services/organisation";

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const ORG_RATE_LIMIT_MAX = 60;
const ORG_RATE_LIMIT_WINDOW_MS = 60_000;

export function createDefaultOrgRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: ORG_RATE_LIMIT_MAX,
    windowMs: ORG_RATE_LIMIT_WINDOW_MS,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function safeError(e: unknown): string {
  if (e instanceof Error) {
    if ("_tag" in e && (e._tag === "OrgError" || e._tag === "NotFoundError")) {
      return (e as { message: string }).message;
    }
  }
  return "Request failed";
}

// TypeBox schemas
const HandleParam = t.Object({
  handle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
});

const MemberHandleParams = t.Object({
  handle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
  userHandle: t.String({ minLength: 1, maxLength: 30, pattern: "^[a-z0-9_]+$" }),
});

const PaginationQuery = t.Object({
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
});

function userProjection(u: User) {
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
  dbLayer: Layer.Layer<Db> = DbLive,
  loggerLayer: Layer.Layer<never> = Layer.empty,
  rateLimiter: RateLimiterBackend = createDefaultOrgRateLimiter(),
) {
  if (typeof rateLimiter?.check !== "function") {
    throw new Error("Org rateLimiter must have a check() method");
  }

  const auth = createAuthService(authConfig);
  const org = createOrganisationService();

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)) as Effect.Effect<
        A,
        never,
        never
      >,
    );

  async function requireAuth(
    authorization: string | undefined,
    set: { status?: number | string },
  ): Promise<{ userId: string; handle: string } | null> {
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
    userId: string,
    set: { status?: number | string },
  ): Promise<boolean> {
    let allowed: boolean;
    try {
      allowed = await rateLimiter.check(userId);
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
  ): Promise<User | null> {
    try {
      const user = await run(auth.findUserByHandle(handle));
      if (!user) {
        set.status = 404;
        return null;
      }
      return user;
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
          if (!(await requireRateLimit(caller.userId, set))) return { error: "Too many requests" };

          try {
            const organisation = await run(
              org.createOrganisation(caller.userId, body.handle, body.name, body.description),
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
        },
      )
      .get(
        "/",
        async ({ query, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };

          try {
            const list = await run(
              org.listUserOrganisations(caller.userId, parsePagination(query)),
            );
            return { organisations: list.map(orgProjection) };
          } catch (e) {
            set.status = 500;
            return { error: safeError(e) };
          }
        },
        { query: PaginationQuery },
      )
      .get(
        "/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          return { organisation: orgProjection(organisation) };
        },
        { params: HandleParam },
      )
      .patch(
        "/:handle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.userId, set))) return { error: "Too many requests" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          try {
            const updated = await run(org.updateOrganisation(organisation.id, caller.userId, body));
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
        },
      )
      .delete(
        "/:handle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.userId, set))) return { error: "Too many requests" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          try {
            await run(org.deleteOrganisation(organisation.id, caller.userId));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: HandleParam },
      )
      // -----------------------------------------------------------------------
      // Member management
      // -----------------------------------------------------------------------
      .post(
        "/:handle/members/:userHandle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.userId, set))) return { error: "Too many requests" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          const target = await resolveHandle(params.userHandle, set);
          if (!target) return { error: "User not found" };

          try {
            await run(org.addMember(organisation.id, caller.userId, target.id, body.role));
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
        },
      )
      .delete(
        "/:handle/members/:userHandle",
        async ({ params, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.userId, set))) return { error: "Too many requests" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          const target = await resolveHandle(params.userHandle, set);
          if (!target) return { error: "User not found" };

          try {
            await run(org.removeMember(organisation.id, caller.userId, target.id));
            return { ok: true };
          } catch (e) {
            set.status = 400;
            return { error: safeError(e) };
          }
        },
        { params: MemberHandleParams },
      )
      .patch(
        "/:handle/members/:userHandle",
        async ({ params, body, headers, set }) => {
          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(caller.userId, set))) return { error: "Too many requests" };

          const organisation = await resolveOrg(params.handle, set);
          if (!organisation) return { error: "Organisation not found" };

          const target = await resolveHandle(params.userHandle, set);
          if (!target) return { error: "User not found" };

          try {
            await run(org.updateMemberRole(organisation.id, caller.userId, target.id, body.role));
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
            const list = await run(org.listMembers(organisation.id, parsePagination(query)));
            return {
              members: list.map((m) =>
                Object.assign({}, userProjection(m.user), {
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
        { params: HandleParam, query: PaginationQuery },
      )
  );
}
