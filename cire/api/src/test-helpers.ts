import { Effect, Layer } from "effect";

/** Default `cf-connecting-ip` injected for tests — simulates the Cloudflare edge
 *  so the fail-closed rate limiter (C4) resolves a real IP instead of denying. */
export const TEST_CF_IP = "203.0.113.7";

/** Default `Origin` injected for tests — matches `createApp`'s default
 *  `webOrigin` allowlist so the CSRF origin guard (C5) lets state-changing
 *  requests through unless a test deliberately overrides it. */
export const TEST_ORIGIN = "http://localhost:4321";

/**
 * Sends a request to an Elysia app by path (Hono's `app.request` equivalent —
 * Elysia's fetch wants an absolute URL).
 *
 * Injects, unless the caller already set them:
 *  - `cf-connecting-ip` — the fail-closed limiter (C4) denies requests with no
 *    resolvable Cloudflare IP, so tests must present one.
 *  - `Origin` — the CSRF origin guard (C5) 403s state-changing requests whose
 *    Origin isn't allowlisted; the default matches `createApp`'s default origin.
 * Centralising both here keeps individual tests clean.
 */
export function appRequest(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", TEST_CF_IP);
  if (!headers.has("origin")) headers.set("origin", TEST_ORIGIN);
  return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { ...init, headers })));
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
