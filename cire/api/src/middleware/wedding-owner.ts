import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";
import type { Tier } from "../services/tiers";
import { readOsnProfileId } from "./upstream-context";
import { decideCapability } from "./wedding-role";

export interface GateError {
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
  // Read in the same query as the caller's seat, for a `weddingTier(db, min)`
  // mounted after this gate.
  weddingTier: tier as Tier | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — admits any OWNER of the
 * wedding, which is a caller whose seat carries the `manage` capability
 * (`policyFor()` in `wedding-role.ts`). A wedding may have several owners and
 * each passes alike. Requires osnAuth() upstream (osnProfileId derived). 404
 * for unknown or soft-deleted weddings, 403 `forbidden` for everyone else —
 * always `forbidden`, never a role's own refusal string: a viewer's
 * `read_only_role` tells the portal to ask for editor access, which would not
 * open an owner-only route. Derives `weddingId` on success, and `weddingTier`
 * from the same query, so a `weddingTier(db, min)` mounted directly after this
 * gate costs no query of its own.
 *
 * The derive runs before osnAuth's onBeforeHandle fires, so it must tolerate
 * an unauthenticated request: it records the gate failure and the earliest
 * registered onBeforeHandle (osnAuth's 401) wins.
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

      const result = await runCire(
        hostsService.authorize(weddingId, osnProfileId).pipe(Effect.provideService(DbService, db)),
      );

      if (!result) return fail(404, "wedding_not_found");
      if (!result.role || !decideCapability(result.role, "manage").allowed) {
        return fail(403, "forbidden");
      }
      return pass(weddingId, result.weddingTier);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}

/**
 * {@link weddingOwner} for the one route that must reach a soft-deleted
 * wedding: its owners' restore. The same capability check, over
 * `hostsService.authorizeIncludingDeleted()`, so a deleted wedding's owner
 * passes while every other organiser route answers it 404. Live or deleted is
 * the route's own question: its guarded write refuses a live wedding.
 */
export function weddingOwnerIncludingDeleted(db: Db) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      const { params } = ctx;
      const osnProfileId = readOsnProfileId(ctx);

      const weddingId = params?.weddingId;
      if (!weddingId) return fail(400, "wedding_id_missing");
      if (!osnProfileId) return fail(401, "unauthorised");

      const result = await runCire(
        hostsService
          .authorizeIncludingDeleted(weddingId, osnProfileId)
          .pipe(Effect.provideService(DbService, db)),
      );

      if (!result) return fail(404, "wedding_not_found");
      if (!result.role || !decideCapability(result.role, "manage").allowed) {
        return fail(403, "forbidden");
      }
      return pass(weddingId, result.weddingTier);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
