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
import type { WeddingRole } from "./wedding-role";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingIsOwner: false,
  weddingRole: undefined as WeddingRole | undefined,
  weddingSlug: undefined as string | undefined,
  weddingEntitlementFold: undefined as WeddingEntitlementFold | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (
  weddingId: string,
  role: WeddingRole,
  slug: string,
  entitlementFold: WeddingEntitlementFold | undefined,
) => ({
  weddingId: weddingId as string | undefined,
  weddingIsOwner: role === "owner",
  weddingRole: role as WeddingRole | undefined,
  // Read in the same query that found the caller's seat. The invite writes and
  // image uploads build their public URLs from it, so they need not read the
  // wedding row a second time.
  weddingSlug: slug as string | undefined,
  weddingEntitlementFold: entitlementFold,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* WRITE routes — sits
 * between `weddingMember()` (the read surface) and `weddingOwner()` (owner-only
 * destructive/management actions). Admits every OWNER, or a co-host whose role
 * carries the `editor` capability; `policyFor()` in `wedding-role.ts` is what
 * says which those are. A refused role gets its own policy's error string: a
 * `viewer` gets 403 `read_only_role` (distinct, so the portal can say "ask the
 * owner for editor access"), every other refused role the generic `forbidden`.
 * 404 for unknown weddings, 403 `forbidden` for non-members — the same contract
 * as the member gate.
 *
 * Derives `weddingRole` so a route can ask what the caller may grant
 * (`assignableRolesFor()`), and `weddingSlug` from the same read.
 *
 * Mirrors `weddingMember()`'s lifecycle: the derive runs before osnAuth's
 * onBeforeHandle fires, so it tolerates an unauthenticated request (records the
 * gate failure; osnAuth's 401 wins).
 *
 * `entitlementKey`, when given, folds a presence check for that entitlement
 * into this gate's own authorize() query (P-W1) and exposes the answer as
 * `weddingEntitlementFold` for a downstream `weddingEntitlement(db, key)` to
 * pick up — same total query count as today, not a new one. Routes that never
 * mount an entitlement gate must NOT pass this: an unconditional fold here
 * would add the entitlement check's cost to every route, gated or not, which
 * is the regression this parameter exists to avoid, not introduce.
 */
export function weddingEditor(db: Db, entitlementKey?: EntitlementKey) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
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
      if (!result.role) return fail(403, "forbidden");
      const decision = decideCapability(result.role, "editor");
      if (!decision.allowed) return fail(403, decision.error);
      return pass(
        weddingId,
        result.role,
        result.weddingSlug,
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
