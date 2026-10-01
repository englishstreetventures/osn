import { weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";

import type { Db } from "../db";
import { normaliseTier } from "../services/tiers";
import type { Tier } from "../services/tiers";
import { readOsnProfileId } from "./upstream-context";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingTier: undefined as Tier | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (weddingId: string, tier: Tier) => ({
  weddingId: weddingId as string | undefined,
  // Read in the same query as the owner, for a `weddingTier(db, min)` mounted
  // after this gate.
  weddingTier: tier as Tier | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — requires osnAuth()
 * upstream (osnProfileId derived). 404 for unknown weddings, 403 for callers
 * who aren't the owner. Derives `weddingId` on success, and `weddingTier` from
 * the same row, so a `weddingTier(db, min)` mounted directly after this gate
 * costs no query of its own.
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
      // params come from the enclosing /weddings/:weddingId group; osnProfileId
      // from the upstream osnAuth() derive, which this standalone plugin
      // instance can't see the type of — see `upstream-context.ts`.
      const { params } = ctx;
      const osnProfileId = readOsnProfileId(ctx);

      const weddingId = params?.weddingId;
      if (!weddingId) return fail(400, "wedding_id_missing");
      if (!osnProfileId) return fail(401, "unauthorised");

      const row = await db
        .select({ owner: weddings.ownerOsnProfileId, tier: weddings.tier })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .get();

      if (!row) return fail(404, "wedding_not_found");
      if (row.owner !== osnProfileId) return fail(403, "forbidden");
      return pass(weddingId, normaliseTier(row.tier));
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
