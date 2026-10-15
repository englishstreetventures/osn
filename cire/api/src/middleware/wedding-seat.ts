import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";
import { readOsnProfileId } from "./upstream-context";
import type { WeddingRole } from "./wedding-role";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingIsOwner: false,
  weddingRole: undefined as WeddingRole | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (weddingId: string, role: WeddingRole) => ({
  weddingId: weddingId as string | undefined,
  weddingIsOwner: role === "owner",
  weddingRole: role as WeddingRole | undefined,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for acts on the caller's OWN seat under
 * /api/organiser/weddings/:weddingId/* — admits anyone holding a
 * `wedding_hosts` row, whatever its role, owners included. It asks no
 * capability: holding a seat is the whole test, so a role added later can
 * always give its seat up. Whether an owner may go is the route's guarded
 * write, which refuses the last one.
 *
 * Only for routes that act on nothing but the caller's own rows (leaving a
 * wedding). It hands out no read or write over the wedding, which is why it
 * may admit a `helper` the member gate refuses. Standalone — mount it instead
 * of another gate, never after one, or that gate's refusal wins.
 *
 * Runs as a `resolve`, in `.use` order after `osnAuth()`: osnAuth's 401
 * answers before this reads anything, and a per-IP limiter mounted ahead of
 * both refuses a request before either runs. With no profile on the context
 * (no `osnAuth()` upstream) it refuses 401 without a query.
 * 404 for an unknown wedding, 403 `forbidden` for a caller with no seat.
 */
export function weddingSeat(db: Db) {
  return new Elysia()
    .resolve({ as: "scoped" }, async (ctx) => {
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
      return pass(weddingId, result.role);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
