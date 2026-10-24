import type { D1Database } from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";
import { makeWithDefaults } from "drizzle-orm/effect-d1";
import { type Context, type Effect, Layer } from "effect";

/**
 * The part of a D1 binding that the driver calls: `prepare` and `batch`. In
 * production this is cire's session-routing shim (`cire/api/src/db/d1-session.ts`),
 * which picks its D1 session when `prepare` runs.
 */
export type D1QueryClient = Pick<D1Database, "prepare" | "batch">;

/** The drizzle handle the D1 layer provides. */
export type EffectD1Db = Effect.Success<ReturnType<typeof makeWithDefaults>>;

/**
 * An Effect-native drizzle handle over a D1 binding, provided as the service of
 * `tag`. Built once per runtime (`ManagedRuntime`), never per request.
 *
 * The prepared-statement cache is off: `@effect/sql-d1` would otherwise reuse a
 * statement prepared under an earlier session, and the session shim routes at
 * `prepare` time. Writes already prepare on every call, so the cost is reads only.
 */
export function makeEffectD1Layer<I>(tag: Context.Service<I, EffectD1Db>, shim: D1QueryClient) {
  const client = D1Client.layer({
    // Safety: the driver calls only `prepare` and `batch`, the two members the
    // shim provides; `D1Database` is the wider type the driver's config names.
    db: shim as D1Database,
    prepareCacheSize: 0,
  });
  return Layer.effect(tag, makeWithDefaults({})).pipe(Layer.provideMerge(client));
}
