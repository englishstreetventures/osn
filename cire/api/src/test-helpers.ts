import { Effect, Layer } from "effect";

/**
 * Sends a request to an Elysia app by path (Hono's `app.request` equivalent —
 * Elysia's fetch wants an absolute URL).
 */
export function appRequest(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, init)));
}

/**
 * Wraps an Effect as a bun:test-compatible callback.
 * Usage: it('name', eff(Effect.gen(function*() { ... })))
 */
export function eff<A>(effect: Effect.Effect<A, unknown, never>): () => Promise<A> {
  return () => Effect.runPromise(effect);
}

/**
 * Same as eff but provides a Layer before running.
 * Usage: it('name', effWith(TestDbLayer)(Effect.gen(function*() { ... })))
 */
export function effWith<R>(layer: Layer.Layer<R>) {
  return <A>(effect: Effect.Effect<A, unknown, R>): (() => Promise<A>) =>
    () =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)));
}
