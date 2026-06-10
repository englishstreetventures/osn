import { weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import type { Db } from "../db";

type Vars = { db: Db; osnProfileId?: string; weddingId?: string };

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — requires osnAuth()
 * upstream (osnProfileId set). 404 for unknown weddings, 403 for callers
 * who aren't the owner. Sets c.var.weddingId on success.
 *
 * The `.get()` is awaited defensively: bun-sqlite drizzle (tests) resolves
 * synchronously while D1 drizzle (production) returns a Promise — `await`
 * handles both.
 */
export function weddingOwner(): MiddlewareHandler<{ Variables: Vars }> {
  return async (c, next) => {
    const weddingId = c.req.param("weddingId");
    if (!weddingId) return c.json({ error: "wedding_id_missing" }, 400);
    const osnProfileId = c.var.osnProfileId;
    if (!osnProfileId) return c.json({ error: "unauthorised" }, 401);

    const row = await c.var.db
      .select({ owner: weddings.ownerOsnProfileId })
      .from(weddings)
      .where(eq(weddings.id, weddingId))
      .get();

    if (!row) return c.json({ error: "wedding_not_found" }, 404);
    if (row.owner !== osnProfileId) return c.json({ error: "forbidden" }, 403);

    c.set("weddingId", weddingId);
    return next();
  };
}
