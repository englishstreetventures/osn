import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import type { EntitlementKey } from "../services/entitlements";
import { hostsService } from "../services/hosts";
import { readOsnProfileId } from "./upstream-context";
import type { WeddingEntitlementFold, WeddingRole } from "./wedding-member";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingIsOwner: false,
  weddingRole: undefined as WeddingRole | undefined,
  weddingOwnerOsnProfileId: undefined as string | undefined,
  weddingEntitlementFold: undefined as WeddingEntitlementFold | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (
  weddingId: string,
  role: WeddingRole,
  ownerOsnProfileId: string,
  entitlementFold: WeddingEntitlementFold | undefined,
) => ({
  weddingId: weddingId as string | undefined,
  weddingIsOwner: role === "owner",
  weddingRole: role as WeddingRole | undefined,
  // The wedding's OWNER, not the caller. Only this gate derives it, because it
  // is the only one whose caller may not be the owner while still needing to
  // know who is: co-host add (`organiser-hosts.ts`) has to reject re-adding the
  // owner as a host, and under `weddingOwner()` that check could lean on the
  // caller's own id. `authorize()` already reads the column, so it is free.
  weddingOwnerOsnProfileId: ownerOsnProfileId as string | undefined,
  weddingEntitlementFold: entitlementFold,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* WRITE routes — sits
 * between `weddingMember()` (any role, reads) and `weddingOwner()` (owner-only
 * destructive/management actions). Admits the OWNER or an `editor` co-host;
 * a `viewer` co-host is rejected with 403 `read_only_role` (a distinct error
 * string so the portal can say "ask the owner for editor access" instead of a
 * generic forbidden). 404 for unknown weddings, 403 `forbidden` for
 * non-members — the same contract as the member gate.
 *
 * Derives `weddingOwnerOsnProfileId` alongside the role, which the other two
 * gates do not: this is the gate whose caller is not necessarily the owner but
 * may still need to name them.
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
      if (result.role === "viewer") return fail(403, "read_only_role");
      return pass(
        weddingId,
        result.role,
        result.ownerOsnProfileId,
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
