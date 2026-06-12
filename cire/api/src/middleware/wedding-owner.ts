import { weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";

import type { Db } from "../db";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (weddingId: string) => ({
  weddingId: weddingId as string | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — requires osnAuth()
 * upstream (osnProfileId derived). 404 for unknown weddings, 403 for callers
 * who aren't the owner. Derives `weddingId` on success.
 *
 * The derive runs before osnAuth's onBeforeHandle fires, so it must tolerate
 * an unauthenticated request: it records the gate failure and the earliest
 * registered onBeforeHandle (osnAuth's 401) wins.
 *
 * The `.get()` is awaited defensively: bun-sqlite drizzle (tests) resolves
 * synchronously while D1 drizzle (production) returns a Promise — `await`
 * handles both.
 */
export function weddingOwner(db: Db) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      // params come from the enclosing /weddings/:weddingId group and
      // osnProfileId from the upstream osnAuth() derive — a standalone plugin
      // instance can't see either type, hence the cast.
      const { params, osnProfileId } = ctx as unknown as {
        params?: Record<string, string | undefined>;
        osnProfileId?: string;
      };

      const weddingId = params?.weddingId;
      if (!weddingId) return fail(400, "wedding_id_missing");
      if (!osnProfileId) return fail(401, "unauthorised");

      const row = await db
        .select({ owner: weddings.ownerOsnProfileId })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .get();

      if (!row) return fail(404, "wedding_not_found");
      if (row.owner !== osnProfileId) return fail(403, "forbidden");
      return pass(weddingId);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
