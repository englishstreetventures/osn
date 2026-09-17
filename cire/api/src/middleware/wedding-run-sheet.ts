import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";
import type { RunSheetScope } from "../services/hosts";
import { readOsnProfileId } from "./upstream-context";
import type { WeddingEntitlementFold } from "./wedding-member";
import { decideCapability, runSheetScopeFor } from "./wedding-role";
import type { WeddingRole } from "./wedding-role";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingIsOwner: false,
  weddingRole: undefined as WeddingRole | undefined,
  weddingHostId: undefined as string | undefined,
  weddingRunSheetScope: undefined as RunSheetScope | undefined,
  weddingEntitlementFold: undefined as WeddingEntitlementFold | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (
  weddingId: string,
  role: WeddingRole,
  hostId: string | null,
  scope: RunSheetScope,
) => ({
  weddingId: weddingId as string | undefined,
  weddingIsOwner: role === "owner",
  weddingRole: role as WeddingRole | undefined,
  // The caller's own seat id, `undefined` for the owner (never rowed into
  // wedding_hosts). A route filtering to `own` compares assignments against it.
  weddingHostId: (hostId ?? undefined) as string | undefined,
  weddingRunSheetScope: scope as RunSheetScope | undefined,
  // Always absent: this gate takes no entitlement key, and the entitlement gate
  // reads this off upstream context. Present and undefined means "no fold",
  // which makes `weddingEntitlement()` run its own query rather than trust a
  // missing answer.
  weddingEntitlementFold: undefined as WeddingEntitlementFold | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for the day-of run sheet under
 * /api/organiser/weddings/:weddingId/*. Admits the OWNER, or a co-host whose
 * role carries the `runSheet` capability — which, unlike the other two gates,
 * includes a `helper`.
 *
 * **Standalone, and mounted INSTEAD OF `weddingMember()`, never after it.**
 * Stacked behind the member gate a helper is refused there and never reaches
 * this one, which would leave the run sheet the one thing a helper cannot read.
 * It runs its own `hostsService.authorize()` for that reason.
 *
 * Derives, beyond the usual `weddingId` / `weddingIsOwner` / `weddingRole`:
 *
 * - `weddingHostId` — the caller's own `wedding_hosts.id`, `undefined` for the
 *   owner.
 * - `weddingRunSheetScope` — `own` or `full`, from `runSheetScopeFor()`. A
 *   route MUST narrow its response to this: `runSheetVisibleTo()` in
 *   `wedding-role.ts` is the filter, and returning the whole run sheet to a
 *   helper scoped `own` hands it over whatever the page then renders.
 *
 * Mirrors the other gates' lifecycle: the derive runs before osnAuth's
 * onBeforeHandle fires, so it tolerates an unauthenticated request (records the
 * gate failure; osnAuth's 401 wins). 404 for unknown weddings, 403 `forbidden`
 * for non-members.
 */
export function weddingRunSheet(db: Db) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      const { params } = ctx;
      const osnProfileId = readOsnProfileId(ctx);

      const weddingId = params?.weddingId;
      if (!weddingId) return fail(400, "wedding_id_missing");
      if (!osnProfileId) return fail(401, "unauthorised");

      const result = await runCire(
        hostsService.authorize(weddingId, osnProfileId).pipe(Effect.provideService(DbService, db)),
      );

      if (!result) return fail(404, "wedding_not_found");
      if (!result.role) return fail(403, "forbidden");
      const decision = decideCapability(result.role, "runSheet");
      if (!decision.allowed) return fail(403, decision.error);
      return pass(
        weddingId,
        result.role,
        result.hostId,
        runSheetScopeFor(result.role, result.runSheetScope),
      );
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
