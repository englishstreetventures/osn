import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";
import type { HostRole } from "../services/hosts";
import { readOsnProfileId } from "./upstream-context";

interface GateError {
  status: number;
  body: { error: string };
}

/** The caller's effective role on the wedding, derived by the member gate. */
export type WeddingRole = "owner" | HostRole;

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingIsOwner: false,
  weddingRole: undefined as WeddingRole | undefined,
  weddingOwnerOsnProfileId: undefined as string | undefined,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (weddingId: string, role: WeddingRole, ownerOsnProfileId: string) => ({
  weddingId: weddingId as string | undefined,
  weddingIsOwner: role === "owner",
  weddingRole: role as WeddingRole | undefined,
  // The wedding's OWNER — needed even on the read gate, since a read (unlike
  // the write gates) is the one place the co-host list has to name the owner
  // to show them alongside the hosts they don't stand among.
  weddingOwnerOsnProfileId: ownerOsnProfileId as string | undefined,
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
      return pass(weddingId, result.role, result.ownerOsnProfileId);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
