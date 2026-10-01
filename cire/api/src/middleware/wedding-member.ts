import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";
import type { Tier } from "../services/tiers";
import { readOsnProfileId } from "./upstream-context";
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
  weddingOwnerOsnProfileId: undefined as string | undefined,
  weddingSlug: undefined as string | undefined,
  weddingTier: undefined as Tier | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (
  weddingId: string,
  role: WeddingRole,
  ownerOsnProfileId: string,
  slug: string,
  tier: Tier,
) => ({
  weddingId: weddingId as string | undefined,
  weddingIsOwner: role === "owner",
  weddingRole: role as WeddingRole | undefined,
  // The wedding's OWNER — needed even on the read gate, since a read (unlike
  // the write gates) is the one place the co-host list has to name the owner
  // to show them alongside the hosts they don't stand among.
  weddingOwnerOsnProfileId: ownerOsnProfileId as string | undefined,
  // Read in the same query that found the owner. The CSV exports name their
  // download after it, so they need not read the wedding row a second time.
  weddingSlug: slug as string | undefined,
  // Read in the same query too, for a `weddingTier(db, min)` mounted after
  // this gate.
  weddingTier: tier as Tier | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — admits the wedding's
 * OWNER, or a co-host whose role carries the `member` capability. Requires
 * osnAuth() upstream (osnProfileId derived). 404 for unknown weddings, 403 for
 * callers who are neither owner nor host. Derives `weddingId` (on success),
 * `weddingIsOwner`, and `weddingRole` so a route can keep an owner-only action
 * (e.g. host management) gated even though co-hosts reach the shared dashboard
 * reads, plus `weddingSlug` from the same read.
 *
 * Which roles those are is `policyFor()`'s to say, not this file's — see
 * `wedding-role.ts`. This gate does not enumerate the roles it excludes,
 * because a gate written that way admits every role added after it. Routes
 * that WRITE must sit behind `weddingEditor()` (see `wedding-editor.ts`) or
 * `weddingOwner()` instead.
 *
 * Mirrors `weddingOwner()`'s lifecycle: the derive runs before osnAuth's
 * onBeforeHandle fires, so it tolerates an unauthenticated request (records the
 * gate failure; osnAuth's 401 wins).
 *
 * Also derives `weddingTier`, read from the wedding row this gate already
 * selects, so a `weddingTier(db, min)` mounted directly after it costs no
 * query of its own.
 */
export function weddingMember(db: Db) {
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
      const decision = decideCapability(result.role, "member");
      if (!decision.allowed) return fail(403, decision.error);
      return pass(
        weddingId,
        result.role,
        result.ownerOsnProfileId,
        result.weddingSlug,
        result.weddingTier,
      );
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
