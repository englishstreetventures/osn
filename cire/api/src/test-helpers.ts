import { Effect, Layer } from "effect";

import type { Db } from "./db";

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
 * A parsed JSON value. Response bodies in tests are asserted with
 * `expect(await jsonBody(res)).toEqual(...)` — `expect(x)` is overloaded, and
 * bun-types' `Response.json(): Promise<any>` resolves the first overload,
 * `(actual?: never) => Matchers<undefined>`, instead of the generic one, so
 * that assertion fails to typecheck against anything but `undefined`.
 * `JsonValue` isn't assignable to `never`, so it skips straight to the
 * generic overload.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function jsonBody(res: Response): Promise<JsonValue> {
  return res.json();
}

/**
 * Builds a `globalThis.fetch`-assignable mock. A plain async-function literal
 * isn't structurally `typeof fetch` — the real `fetch` carries a `preconnect`
 * method the literal lacks — so `Object.assign` attaches a no-op one instead
 * of casting through `unknown`.
 */
export function mockFetch(
  impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} });
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

/**
 * Wraps a real `Db` so every call to `.select()` is counted — the entry
 * point of every read query this codebase issues (`dbQuery(() =>
 * db.select()...all())`). Nothing in the test suite mocks the driver (real
 * bun:sqlite backs every test `Db`), so this is the mechanism for proving a
 * "this many D1 round trips" claim: count `.select()` invocations rather than
 * assert on a call log no service exposes. Built via prototype delegation
 * (`Object.create(db)` plus one overridden own property) rather than a
 * `Proxy` + `Reflect.get`, so every other method (`.insert`/`.update`/
 * `.delete`/`.$client`/…) keeps its real, typed behaviour untouched.
 */
export function countingDb(db: Db) {
  let n = 0;
  const counted: Db = Object.create(db);
  Object.defineProperty(counted, "select", {
    enumerable: true,
    value: (fields?: Parameters<typeof db.select>[0]) => {
      n++;
      return fields === undefined ? db.select() : db.select(fields);
    },
  });
  return { db: counted, selectCount: () => n };
}
