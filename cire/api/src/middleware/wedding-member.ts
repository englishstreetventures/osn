import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import type { EntitlementKey } from "../services/entitlements";
import { hostsService } from "../services/hosts";
import type { HostRole } from "../services/hosts";
import { readOsnProfileId } from "./upstream-context";

interface GateError {
  status: number;
  body: { error: string };
}

/** The caller's effective role on the wedding, derived by the member gate. */
export type WeddingRole = "owner" | HostRole;

/**
 * The result of folding an entitlement presence check into THIS gate's own
 * authorize() query (P-W1) — carries the key it answers so a downstream
 * `weddingEntitlement(db, key)` can tell a fold for its OWN key apart from a
 * fold for a different one and fall back to its own query rather than trust a
 * mismatched answer.
 */
export type WeddingEntitlementFold = { key: EntitlementKey; entitled: boolean };

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
  // The wedding's OWNER — needed even on the read gate, since a read (unlike
  // the write gates) is the one place the co-host list has to name the owner
  // to show them alongside the hosts they don't stand among.
  weddingOwnerOsnProfileId: ownerOsnProfileId as string | undefined,
  weddingEntitlementFold: entitlementFold,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — admits the wedding's
 * OWNER **or** a CO-HOST (editor or viewer). Requires osnAuth() upstream
 * (osnProfileId derived). 404 for unknown weddings, 403 for callers who are
 * neither owner nor host. Derives `weddingId` (on success), `weddingIsOwner`,
 * and `weddingRole` so a route can keep an owner-only action (e.g. host
 * management) gated even though co-hosts reach the shared dashboard reads.
 * Viewers pass this gate — routes that WRITE must sit behind `weddingEditor()`
 * (see `wedding-editor.ts`) or `weddingOwner()` instead.
 *
 * Mirrors `weddingOwner()`'s lifecycle: the derive runs before osnAuth's
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
export function weddingMember(db: Db, entitlementKey?: EntitlementKey) {
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
