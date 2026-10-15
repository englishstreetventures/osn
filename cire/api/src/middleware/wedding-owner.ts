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
  weddingSlug: undefined as string | undefined,
  weddingTier: undefined as Tier | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (weddingId: string, slug: string, tier: Tier) => ({
  weddingId: weddingId as string | undefined,
  // Both read in the same query as the caller's seat: the slug names an
  // export's download, and the tier is for a `weddingTier(db, min)` mounted
  // after this gate.
  weddingSlug: slug as string | undefined,
  weddingTier: tier as Tier | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — admits any OWNER of the
 * wedding, which is a caller whose seat carries the `manage` capability
 * (`policyFor()` in `wedding-role.ts`). A wedding may have several owners and
 * each passes alike. Requires osnAuth() upstream (osnProfileId resolved). 404
 * for unknown or soft-deleted weddings, 403 `forbidden` for everyone else —
 * always `forbidden`, never a role's own refusal string: a viewer's
 * `read_only_role` tells the portal to ask for editor access, which would not
 * open an owner-only route. Provides `weddingId` on success, and `weddingSlug`
 * and `weddingTier` from the same query, so neither the exports' filenames nor
 * a `weddingTier(db, min)` mounted directly after this gate costs a query of
 * its own.
 *
 * Runs as a `resolve`, in `.use` order after `osnAuth()`: osnAuth's 401
 * answers before this reads anything, and a per-IP limiter mounted ahead of
 * both refuses a request before either runs. With no profile on the context
 * (no `osnAuth()` upstream) it refuses 401 without a query.
 */
export function weddingOwner(db: Db) {
  return new Elysia()
    .resolve({ as: "scoped" }, async (ctx) => {
      // params come from the enclosing /weddings/:weddingId group; osnProfileId
      // from the upstream osnAuth() resolve, which this standalone plugin
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
      return pass(weddingId, result.weddingSlug, result.weddingTier);
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
    .resolve({ as: "scoped" }, async (ctx) => {
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
      return pass(weddingId, result.weddingSlug, result.weddingTier);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
