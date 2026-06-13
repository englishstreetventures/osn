import { weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Elysia } from "elysia";

import type { Db } from "../db";

interface GateError {
  status: number;
  body: { error: string; hint?: string };
}

const fail = (status: number, body: GateError["body"]) => ({
  weddingId: undefined as string | undefined,
  weddingGateError: { status, body } as GateError | undefined,
});

const pass = (weddingId: string) => ({
  weddingId: weddingId as string | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for organiser routes that carry no :weddingId param — requires
 * osnAuth() upstream (osnProfileId derived). Derives the wedding from the
 * caller: exactly one owned wedding scopes the request; zero is a 404; more
 * than one is ambiguous (400) and the caller must use the explicit
 * wedding-scoped routes. Derives `weddingId` on success.
 *
 * The derive runs before osnAuth's onBeforeHandle fires, so it must tolerate
 * an unauthenticated request: it records the gate failure and the earliest
 * registered onBeforeHandle (osnAuth's 401) wins.
 *
 * The `.all()` is awaited defensively: bun-sqlite drizzle (tests) resolves
 * synchronously while D1 drizzle (production) returns a Promise — `await`
 * handles both.
 */
export function ownedWedding(db: Db) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      // osnProfileId comes from the upstream osnAuth() derive — a standalone
      // plugin instance can't see that type, hence the cast.
      const { osnProfileId } = ctx as unknown as { osnProfileId?: string };
      if (!osnProfileId) return fail(401, { error: "unauthorised" });

      const owned = await db
        .select({ id: weddings.id })
        .from(weddings)
        .where(eq(weddings.ownerOsnProfileId, osnProfileId))
        .orderBy(asc(weddings.createdAt))
        .all();

      if (owned.length === 0) return fail(404, { error: "no_weddings" });
      if (owned.length > 1) {
        return fail(400, {
          error: "multiple_weddings",
          hint: "use /api/organiser/weddings/:weddingId/...",
        });
      }

      return pass(owned[0].id);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
