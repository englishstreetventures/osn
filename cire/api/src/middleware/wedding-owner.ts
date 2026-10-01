import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import type { EntitlementKey } from "../services/entitlements";
import { hostsService } from "../services/hosts";
import { readOsnProfileId } from "./upstream-context";
import type { WeddingEntitlementFold } from "./wedding-member";
import { decideCapability } from "./wedding-role";

export interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingEntitlementFold: undefined as WeddingEntitlementFold | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (weddingId: string, entitlementFold: WeddingEntitlementFold | undefined) => ({
  weddingId: weddingId as string | undefined,
  weddingEntitlementFold: entitlementFold,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — admits any OWNER of the
 * wedding, which is a caller whose seat carries the `manage` capability
 * (`policyFor()` in `wedding-role.ts`). A wedding may have several owners and
 * each passes alike. Requires osnAuth() upstream (osnProfileId derived). 404
 * for unknown weddings, 403 `forbidden` for everyone else — always `forbidden`,
 * never a role's own refusal string: a viewer's `read_only_role` tells the
 * portal to ask for editor access, which would not open an owner-only route.
 * Derives `weddingId` on success.
 *
 * The derive runs before osnAuth's onBeforeHandle fires, so it must tolerate
 * an unauthenticated request: it records the gate failure and the earliest
 * registered onBeforeHandle (osnAuth's 401) wins.
 *
 * `entitlementKey` works as it does on `weddingMember()` and `weddingEditor()`:
 * it adds a presence check for that entitlement to this gate's own query and
 * exposes the answer as `weddingEntitlementFold`, for the
 * `weddingEntitlement(db, key)` mounted directly after it. Pass it only there.
 * On a route with no entitlement gate it would add the check's cost for
 * nothing; `tests/routes/entitlement-gate-pairing.test.ts` holds both rules.
 * A defect confined to the entitlement half falls back to the plain role
 * query inside `hostsService.authorize()`, so it costs only the fold.
 */
export function weddingOwner(db: Db, entitlementKey?: EntitlementKey) {
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
        hostsService
          .authorize(weddingId, osnProfileId, entitlementKey)
          .pipe(Effect.provideService(DbService, db)),
      );

      if (!result) return fail(404, "wedding_not_found");
      if (!result.role || !decideCapability(result.role, "manage").allowed) {
        return fail(403, "forbidden");
      }
      return pass(
        weddingId,
        entitlementKey && result.entitled !== undefined
          ? { key: entitlementKey, entitled: result.entitled }
          : undefined,
      );
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
      return pass(weddingId, undefined);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
