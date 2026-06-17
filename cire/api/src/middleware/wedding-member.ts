import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";

interface GateError {
  status: number;
  body: { error: string };
}

const fail = (status: number, error: string) => ({
  weddingId: undefined as string | undefined,
  weddingIsOwner: false,
  weddingGateError: { status, body: { error } } as GateError | undefined,
});

const pass = (weddingId: string, isOwner: boolean) => ({
  weddingId: weddingId as string | undefined,
  weddingIsOwner: isOwner,
  weddingGateError: undefined as GateError | undefined,
});

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — admits the wedding's
 * OWNER **or** a CO-HOST. Requires osnAuth() upstream (osnProfileId derived).
 * 404 for unknown weddings, 403 for callers who are neither owner nor host.
 * Derives `weddingId` (on success) and `weddingIsOwner` so a route can keep an
 * owner-only action (e.g. host management) gated even though co-hosts reach the
 * shared dashboard reads — co-hosts get read access, never management.
 *
 * Mirrors `weddingOwner()`'s lifecycle: the derive runs before osnAuth's
 * onBeforeHandle fires, so it tolerates an unauthenticated request (records the
 * gate failure; osnAuth's 401 wins).
 */
export function weddingMember(db: Db) {
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
      if (!result.isOwner && !result.isHost) return fail(403, "forbidden");
      return pass(weddingId, result.isOwner);
    })
    .onBeforeHandle({ as: "scoped" }, ({ weddingGateError, set }) => {
      if (weddingGateError) {
        set.status = weddingGateError.status;
        return weddingGateError.body;
      }
    });
}
