/**
 * Bridge the Cloudflare Workers `ExecutionContext` into Elysia route handlers.
 *
 * Elysia's `app.fetch(request)` signature only takes the `Request` — it does not
 * forward the Workers `fetch(request, env, ctx)` third argument — so a handler
 * has no first-class way to reach `ctx.waitUntil`. We bridge it per-request: the
 * top-level Worker `fetch` calls {@link setExecutionCtx} before dispatching into
 * Elysia, keyed by the exact `Request` instance Elysia hands back to the handler
 * (Elysia does not clone the request). The handler then calls {@link getWaitUntil}
 * to schedule background work (e.g. a Cache API write) without blocking the
 * response.
 *
 * The map is a `WeakMap`, so an entry is collected as soon as the request object
 * is — no manual cleanup, no leak. In unit tests / non-Workers contexts the Worker
 * `fetch` never runs, so `getWaitUntil` returns `undefined` and callers fall back
 * to awaiting the work inline.
 */

/** The slice of the Workers `ExecutionContext` we depend on. */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

const ctxByRequest = new WeakMap<Request, WaitUntilCtx>();

/** Associate a Workers execution context with the in-flight request. Called by
 *  the top-level Worker `fetch` before dispatching into Elysia. */
export function setExecutionCtx(request: Request, ctx: WaitUntilCtx): void {
  ctxByRequest.set(request, ctx);
}

/**
 * Return a `waitUntil` bound to the request's execution context, or `undefined`
 * when none was registered (unit tests / non-Workers runtimes). Callers that get
 * `undefined` must do the background work inline (e.g. `await`) instead.
 */
export function getWaitUntil(request: Request): ((promise: Promise<unknown>) => void) | undefined {
  const ctx = ctxByRequest.get(request);
  return ctx ? (promise) => ctx.waitUntil(promise) : undefined;
}
