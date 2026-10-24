import type { D1Database } from "@cloudflare/workers-types";
import { makeEffectD1Layer, type EffectD1Db } from "@shared/db-utils/effect/d1";
import { Context, Effect, Layer, Scope } from "effect";

import { createSessionRoutedClient } from "./d1-session";

/**
 * The D1 Effect handle, provided as a context service so the layer can be built
 * against the same tag the drizzle driver reads.
 */
export class EffectDbService extends Context.Service<EffectDbService, EffectD1Db>()(
  "EffectDbService",
) {}

type Entry = "fetch" | "scheduled";

// One built handle per binding and entry, kept for the life of the isolate. The
// map is module-private: callers reach it only through `effectDbFor`.
const handles = new WeakMap<D1Database, Partial<Record<Entry, EffectD1Db>>>();

/**
 * The Effect handle for `binding`, built on first use and returned thereafter.
 *
 * The build is synchronous: the layer is built into a fresh scope with
 * `Effect.runSync`, so two callers in one tick cannot race on a shared build.
 * Each (binding, entry) pair gets its own session shim, so a session-missing
 * query is counted under the entry that issued it.
 */
export function effectDbFor(binding: D1Database, entry: Entry): EffectD1Db {
  const known = handles.get(binding)?.[entry];
  if (known) return known;

  const scope = Effect.runSync(Scope.make());
  const layer = makeEffectD1Layer(EffectDbService, createSessionRoutedClient(binding, entry));
  const context = Effect.runSync(Layer.buildWithScope(layer, scope));
  const handle = Context.get(context, EffectDbService);

  handles.set(binding, { ...handles.get(binding), [entry]: handle });
  return handle;
}
