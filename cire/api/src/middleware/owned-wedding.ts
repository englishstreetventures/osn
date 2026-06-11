import { weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import type { Db } from "../db";

type Vars = { db: Db; osnProfileId?: string; weddingId?: string };

/**
 * Authz gate for organiser routes that carry no :weddingId param — requires
 * osnAuth() upstream (osnProfileId set). Derives the wedding from the caller:
 * exactly one owned wedding scopes the request; zero is a 404; more than one
 * is ambiguous (400) and the caller must use the explicit wedding-scoped
 * routes. Sets c.var.weddingId on success.
 *
 * The `.all()` is awaited defensively: bun-sqlite drizzle (tests) resolves
 * synchronously while D1 drizzle (production) returns a Promise — `await`
 * handles both.
 */
export function ownedWedding(): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const osnProfileId = c.var.osnProfileId;
    if (!osnProfileId) return c.json({ error: "unauthorised" }, 401);

    const owned = await c.var.db
      .select({ id: weddings.id })
      .from(weddings)
      .where(eq(weddings.ownerOsnProfileId, osnProfileId))
      .orderBy(asc(weddings.createdAt))
      .all();

    if (owned.length === 0) return c.json({ error: "no_weddings" }, 404);
    if (owned.length > 1) {
      return c.json(
        { error: "multiple_weddings", hint: "use /api/organiser/weddings/:weddingId/..." },
        400,
      );
    }

    c.set("weddingId", owned[0].id);
    return next();
  };
}
