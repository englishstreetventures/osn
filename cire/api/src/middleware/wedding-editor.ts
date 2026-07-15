import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";
import type { WeddingRole } from "./wedding-member";

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
 * Authz gate for /api/organiser/weddings/:weddingId/* WRITE routes — sits
 * between `weddingMember()` (any role, reads) and `weddingOwner()` (owner-only
 * destructive/management actions). Admits the OWNER or an `editor` co-host;
 * a `viewer` co-host is rejected with 403 `read_only_role` (a distinct error
 * string so the portal can say "ask the owner for editor access" instead of a
 * generic forbidden). 404 for unknown weddings, 403 `forbidden` for
 * non-members — the same contract as the member gate.
 *
 * Mirrors `weddingMember()`'s lifecycle: the derive runs before osnAuth's
 * onBeforeHandle fires, so it tolerates an unauthenticated request (records the
 * gate failure; osnAuth's 401 wins).
 */
export function weddingEditor(db: Db) {
  return new Elysia()
    .derive({ as: "scoped" }, async (ctx) => {
      const { params, osnProfileId } = ctx as unknown as {
        params?: Record<string, string | undefined>;
        osnProfileId?: string;
      };

      const weddingId = params?.weddingId;
      if (!weddingId) return fail(400, "wedding_id_missing");
      if (!osnProfileId) return fail(401, "unauthorised");

      const result = await runCire(
        hostsService.authorize(weddingId, osnProfileId).pipe(Effect.provideService(DbService, db)),
      );

      if (!result) return fail(404, "wedding_not_found");
      if (!result.role) return fail(403, "forbidden");
      if (result.role === "viewer") return fail(403, "read_only_role");
      return pass(weddingId, result.role);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
