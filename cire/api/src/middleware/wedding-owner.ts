import { weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { dbQuery } from "../db";
import type { Db } from "../db";
import { runCire } from "../observability";
import { entitlementPresent } from "../services/entitlements";
import type { EntitlementKey } from "../services/entitlements";
import { readOsnProfileId } from "./upstream-context";
import type { WeddingEntitlementFold } from "./wedding-member";

interface GateError {
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

/** The owner lookup with no entitlement column — the query this gate runs when
 *  no route asks it to fold one. */
function readOwner(db: Db, weddingId: string) {
  return db
    .select({ owner: weddings.ownerOsnProfileId })
    .from(weddings)
    .where(eq(weddings.id, weddingId))
    .get();
}

/**
 * The owner lookup with an `entitled` column for `key` added to the same
 * SELECT, so a `weddingEntitlement(db, key)` after this gate has its answer
 * without a second query.
 *
 * A defect in that one SELECT falls back to {@link readOwner} and returns no
 * `entitled`, for the reason `hostsService.authorize()` does the same: a fault
 * confined to `wedding_entitlements` must cost only the entitlement half. The
 * entitlement gate then runs its own check, which fails closed to a 402 with
 * its own log line, and the owner check still answers. If the owner half is
 * what broke, the fallback throws as well and the request 500s.
 */
function readOwnerWithEntitlement(
  db: Db,
  weddingId: string,
  key: EntitlementKey,
): Promise<{ owner: string; entitled?: boolean } | undefined> {
  return runCire(
    dbQuery(() =>
      db
        .select({ owner: weddings.ownerOsnProfileId, entitled: entitlementPresent(weddingId, key) })
        .from(weddings)
        .where(eq(weddings.id, weddingId))
        .get(),
    ).pipe(
      Effect.map((row) => row && { owner: row.owner, entitled: Boolean(row.entitled) }),
      Effect.catchDefect(() =>
        Effect.logWarning(
          "cire.wedding_owner entitlement fold failed — falling back to the plain owner query",
        ).pipe(
          Effect.annotateLogs({ weddingId, entitlement: key }),
          Effect.andThen(dbQuery(() => readOwner(db, weddingId))),
        ),
      ),
    ),
  );
}

/**
 * Authz gate for /api/organiser/weddings/:weddingId/* — requires osnAuth()
 * upstream (osnProfileId derived). 404 for unknown weddings, 403 for callers
 * who aren't the owner. Derives `weddingId` on success.
 *
 * The derive runs before osnAuth's onBeforeHandle fires, so it must tolerate
 * an unauthenticated request: it records the gate failure and the earliest
 * registered onBeforeHandle (osnAuth's 401) wins.
 *
 * The `.get()` is awaited defensively: bun-sqlite drizzle (tests) resolves
 * synchronously while D1 drizzle (production) returns a Promise — `await`
 * handles both.
 *
 * `entitlementKey` works as it does on `weddingMember()` and `weddingEditor()`:
 * it adds a presence check for that entitlement to this gate's own query and
 * exposes the answer as `weddingEntitlementFold`, for the
 * `weddingEntitlement(db, key)` mounted directly after it. Pass it only there.
 * On a route with no entitlement gate it would add the check's cost for
 * nothing; `tests/routes/entitlement-gate-pairing.test.ts` holds both rules.
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

      const row: { owner: string; entitled?: boolean } | undefined = entitlementKey
        ? await readOwnerWithEntitlement(db, weddingId, entitlementKey)
        : await readOwner(db, weddingId);

      if (!row) return fail(404, "wedding_not_found");
      if (row.owner !== osnProfileId) return fail(403, "forbidden");
      return pass(
        weddingId,
        entitlementKey && row.entitled !== undefined
          ? { key: entitlementKey, entitled: row.entitled }
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
