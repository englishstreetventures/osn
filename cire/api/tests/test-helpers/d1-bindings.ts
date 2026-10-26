import { BOOTSTRAP_WEDDING_ID } from "@cire/db";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Cause, Effect, Exit } from "effect";

import { EffectDbService, effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb, seedDb } from "../../src/db/setup";

// Prototype chains, not spreads: the D1 types are abstract classes, and a spread
// drops their methods. Each wrapper keeps every method of the binding it wraps
// and overrides only `prepare`.

/** `base`, with every statement it prepares reported to `onPrepare` first. */
export const loggingBinding = (base: D1Database, onPrepare: (query: string) => void): D1Database =>
  Object.assign(Object.create(base), {
    prepare: (query: string): D1PreparedStatement => {
      onPrepare(query);
      return base.prepare(query);
    },
  });

/**
 * `base`, with every statement whose SQL `matches` rejecting when it runs, as a
 * failed read would. Other statements run on `base` unchanged.
 */
export const failingReadOf = (base: D1Database, matches: (query: string) => boolean): D1Database =>
  Object.assign(Object.create(base), {
    prepare: (query: string): D1PreparedStatement => {
      const real = base.prepare(query);
      if (!matches(query)) return real;
      const failing: D1PreparedStatement = Object.assign(Object.create(real.bind()), {
        raw: () => Promise.reject(new Error("injected read failure")),
      });
      return Object.assign(Object.create(real), { bind: () => failing });
    },
  });

/**
 * Runs `read` for the seeded wedding with every statement whose SQL `matches`
 * failing, and reports how the run ended: whether it died, whether it failed
 * typed, and how many statements matched, so a case can check that its
 * predicate picks out exactly one query.
 */
export async function runWithFailingRead(
  read: (weddingId: string) => Effect.Effect<unknown, unknown, EffectDbService>,
  matches: (query: string) => boolean,
) {
  const db = createDb(":memory:");
  seedDb(db);
  let matched = 0;
  const binding = failingReadOf(
    loggingBinding(localD1Binding(db.$client), (query) => {
      if (matches(query)) matched += 1;
    }),
    matches,
  );
  const exit = await Effect.runPromiseExit(
    read(BOOTSTRAP_WEDDING_ID).pipe(
      Effect.provideService(EffectDbService, effectDbFor(binding, "fetch")),
    ),
  );
  return {
    matched,
    died: Exit.isFailure(exit) && Cause.hasDies(exit.cause),
    failedTyped: Exit.isFailure(exit) && Cause.hasFails(exit.cause),
  };
}
